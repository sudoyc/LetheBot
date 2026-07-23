import type { IEvaluator, EvaluatorConfig } from '../types/evaluator.js';
import { EvaluatorStub } from './evaluator-stub.js';
import {
  ModelEvaluator,
  type EvaluatorCompletionClient,
  type EvaluatorInvocationLedger,
} from './model-evaluator.js';
import { PiAiEvaluatorClient } from './pi-ai-client.js';

export interface EvaluatorRuntimeOverrides {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
  promptVersion: string;
}

export function resolveEvaluatorConfig(
  pi: Pick<EvaluatorConfig, 'provider' | 'model' | 'baseUrl' | 'apiKey'>,
  evaluator: EvaluatorRuntimeOverrides,
): EvaluatorConfig {
  const hasProviderOverride = evaluator.provider !== undefined;
  const hasModelOverride = evaluator.model !== undefined;
  if (hasProviderOverride !== hasModelOverride) {
    throw new Error(
      'EVALUATOR_PROVIDER and EVALUATOR_MODEL must be configured together',
    );
  }

  const hasIdentityOverride = hasProviderOverride && hasModelOverride;
  return {
    provider: evaluator.provider ?? pi.provider,
    model: evaluator.model ?? pi.model,
    baseUrl: evaluator.baseUrl ?? (hasIdentityOverride ? undefined : pi.baseUrl),
    apiKey: evaluator.apiKey?.trim() || (hasIdentityOverride ? undefined : pi.apiKey),
    timeoutMs: evaluator.timeoutMs,
    maxRetries: evaluator.maxRetries,
    temperature: evaluator.temperature,
    promptVersion: evaluator.promptVersion,
  };
}

export function createRuntimeEvaluator(
  config: EvaluatorConfig,
  options: {
    test?: boolean;
    client?: EvaluatorCompletionClient;
    invocationLedger?: EvaluatorInvocationLedger;
  } = {},
): IEvaluator {
  if (options.test || config.provider === 'mock') {
    return new EvaluatorStub();
  }

  if (!config.apiKey?.trim()) {
    throw new Error(
      'EVALUATOR_API_KEY or PI_API_KEY is required for a non-mock evaluator provider',
    );
  }

  if (!options.invocationLedger) {
    throw new Error('A durable evaluator invocation ledger is required for a non-mock evaluator');
  }

  const client = options.client ?? new PiAiEvaluatorClient(config);
  return new ModelEvaluator(config, client, options.invocationLedger);
}
