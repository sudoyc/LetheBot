import {
  complete as completePi,
  getModel,
} from '@earendil-works/pi-ai/compat';
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
} from '@earendil-works/pi-ai';
import { createDeepSeekModel } from '../pi/deepseek-provider.js';
import type { EvaluatorConfig } from '../types/evaluator.js';
import type {
  EvaluatorCompletion,
  EvaluatorCompletionClient,
  EvaluatorCompletionRequest,
} from './model-evaluator.js';
import { EvaluatorCompletionError } from './model-evaluator.js';

export type PiAiComplete = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export type PiAiModelLookup = (
  provider: string,
  model: string,
) => Model<Api> | undefined;

export function withNativeJsonPayload(
  model: Model<Api>,
  options: ProviderStreamOptions,
): ProviderStreamOptions {
  if (model.api !== 'openai-completions') {
    return options;
  }

  const callerOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const callerResult = callerOnPayload
        ? await callerOnPayload(payload, payloadModel)
        : undefined;
      const effectivePayload = callerResult ?? payload;
      return isRecord(effectivePayload)
        ? { ...effectivePayload, response_format: { type: 'json_object' } }
        : effectivePayload;
    },
  };
}

export class PiAiEvaluatorClient implements EvaluatorCompletionClient {
  private readonly model: Model<Api>;
  private readonly completePi: PiAiComplete;

  constructor(
    private readonly config: EvaluatorConfig,
    dependencies: {
      complete?: PiAiComplete;
      modelLookup?: PiAiModelLookup;
    } = {},
  ) {
    const modelLookup = dependencies.modelLookup
      ?? (getModel as PiAiModelLookup);
    this.completePi = dependencies.complete ?? (completePi as PiAiComplete);

    const baseModel = config.provider === 'openai' && config.model.startsWith('deepseek-')
      ? createDeepSeekModel(config.model)
      : modelLookup(config.provider, config.model);
    if (!baseModel) {
      throw new Error(`Failed to get evaluator model: ${config.provider}/${config.model}`);
    }

    this.model = {
      ...baseModel,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    };
  }

  async complete(request: EvaluatorCompletionRequest): Promise<EvaluatorCompletion> {
    let response: AssistantMessage;
    try {
      const providerOptions = withNativeJsonPayload(this.model, {
        apiKey: this.config.apiKey,
        temperature: this.config.temperature,
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
        maxTokens: 1_200,
        signal: request.signal,
      });
      response = await this.completePi(
        this.model,
        {
          systemPrompt: request.systemPrompt,
          messages: [
            {
              role: 'user',
              content: request.userPrompt,
              timestamp: Date.now(),
            },
          ],
        },
        providerOptions,
      );
    } catch {
      throw new EvaluatorCompletionError('provider_failed', 'failed');
    }

    if (response.stopReason === 'error') {
      throw new EvaluatorCompletionError('provider_failed', 'failed');
    }
    if (response.stopReason === 'aborted') {
      throw new EvaluatorCompletionError('provider_aborted', 'aborted');
    }

    const text = response.content
      .filter((block): block is Extract<AssistantMessage['content'][number], { type: 'text' }> =>
        block.type === 'text'
      )
      .map((block) => block.text)
      .join('');
    if (text.trim().length === 0) {
      throw new EvaluatorCompletionError('empty_response', 'failed');
    }

    return {
      text,
      tokens: {
        input: response.usage.input,
        output: response.usage.output,
        total: response.usage.totalTokens,
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
