import { describe, expect, it, vi } from 'vitest';
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
} from '@earendil-works/pi-ai';
import {
  PiAiEvaluatorClient,
  type PiAiComplete,
  type PiAiModelLookup,
  withNativeJsonPayload,
} from '../../../src/evaluator/pi-ai-client';

const config = {
  provider: 'openai',
  model: 'gpt-4',
  baseUrl: 'https://provider.example.invalid/v1',
  apiKey: 'test-only-evaluator-key',
  timeoutMs: 4_321,
  maxRetries: 2,
  temperature: 0.1,
  promptVersion: 'governance-v1',
};

function createModel(api: Api = 'openai-completions'): Model<Api> {
  return {
    id: 'gpt-4',
    name: 'GPT-4 Test',
    api,
    provider: 'openai',
    baseUrl: 'https://default.example.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 2_048,
  };
}

function createResponse(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

describe('PiAiEvaluatorClient', () => {
  it('uses one isolated message, no tools, and explicit provider options', async () => {
    const modelLookup = vi.fn<PiAiModelLookup>().mockReturnValue(createModel());
    const complete = vi.fn<PiAiComplete>().mockResolvedValue(createResponse([
      { type: 'text', text: '{"domain":"tool"}' },
      { type: 'text', text: '\n' },
    ]));
    const client = new PiAiEvaluatorClient(config, { complete, modelLookup });
    const controller = new AbortController();

    const completion = await client.complete({
      systemPrompt: 'Evaluator system prompt',
      userPrompt: 'Evaluator user prompt',
      signal: controller.signal,
    });

    expect(completion).toEqual({
      text: '{"domain":"tool"}\n',
      tokens: { input: 1, output: 1, total: 2 },
    });
    expect(modelLookup).toHaveBeenCalledWith('openai', 'gpt-4');
    expect(complete).toHaveBeenCalledTimes(1);
    const [model, context, options] = complete.mock.calls[0] as [
      Model<Api>,
      Context,
      ProviderStreamOptions,
    ];
    expect(model.baseUrl).toBe(config.baseUrl);
    expect(context).toMatchObject({
      systemPrompt: 'Evaluator system prompt',
      messages: [
        {
          role: 'user',
          content: 'Evaluator user prompt',
        },
      ],
    });
    expect(context.tools).toBeUndefined();
    expect(options).toMatchObject({
      apiKey: config.apiKey,
      temperature: config.temperature,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      signal: controller.signal,
    });
  });

  it('requests native JSON for openai-completions without mutating the provider payload', async () => {
    const model = createModel();
    const complete = vi.fn<PiAiComplete>().mockResolvedValue(createResponse([
      { type: 'text', text: '{"domain":"social"}' },
    ]));
    const client = new PiAiEvaluatorClient(config, {
      complete,
      modelLookup: () => model,
    });

    await client.complete({
      systemPrompt: 'system',
      userPrompt: 'user',
      signal: new AbortController().signal,
    });

    const options = complete.mock.calls[0]?.[2];
    expect(options?.onPayload).toBeTypeOf('function');
    const payload = Object.freeze({
      model: 'gpt-4',
      messages: Object.freeze([{ role: 'user', content: 'bounded request' }]),
      stream: true,
      vendorFlag: 'preserved',
    });
    const transformed = await options?.onPayload?.(payload, model);

    expect(transformed).toEqual({
      ...payload,
      response_format: { type: 'json_object' },
    });
    expect(transformed).not.toBe(payload);
    expect(payload).not.toHaveProperty('response_format');
    expect(transformed).not.toHaveProperty('tools');
    expect(transformed).not.toHaveProperty('transcript');
  });

  it('does not install a payload transform for unsupported API families', async () => {
    const model = createModel('openai-responses');
    const complete = vi.fn<PiAiComplete>().mockResolvedValue(createResponse([
      { type: 'text', text: '{"domain":"social"}' },
    ]));
    const client = new PiAiEvaluatorClient(config, {
      complete,
      modelLookup: () => model,
    });

    await client.complete({
      systemPrompt: 'system',
      userPrompt: 'user',
      signal: new AbortController().signal,
    });

    expect(complete.mock.calls[0]?.[2]?.onPayload).toBeUndefined();

    const callerOnPayload = vi.fn<NonNullable<ProviderStreamOptions['onPayload']>>();
    const callerOptions: ProviderStreamOptions = { onPayload: callerOnPayload };
    expect(withNativeJsonPayload(model, callerOptions)).toBe(callerOptions);
    expect(callerOptions.onPayload).toBe(callerOnPayload);
  });

  it('preserves an existing asynchronous payload transform before requesting native JSON', async () => {
    const model = createModel();
    const payload = Object.freeze({
      model: 'gpt-4',
      messages: Object.freeze([{ role: 'user', content: 'bounded request' }]),
    });
    const callerPayload = {
      ...payload,
      callerField: 'preserved',
      response_format: { type: 'caller_format' },
    };
    const callerOnPayload = vi.fn<NonNullable<ProviderStreamOptions['onPayload']>>()
      .mockResolvedValue(callerPayload);
    const options = withNativeJsonPayload(model, { onPayload: callerOnPayload });

    const transformed = await options.onPayload?.(payload, model);

    expect(callerOnPayload).toHaveBeenCalledOnce();
    expect(callerOnPayload).toHaveBeenCalledWith(payload, model);
    expect(transformed).toEqual({
      ...callerPayload,
      response_format: { type: 'json_object' },
    });
    expect(transformed).not.toBe(payload);
    expect(transformed).not.toBe(callerPayload);
    expect(payload).not.toHaveProperty('response_format');
  });

  it('uses the original payload when an existing transform returns undefined', async () => {
    const model = createModel();
    const payload = Object.freeze({ model: 'gpt-4', stream: true });
    const callerOnPayload = vi.fn<NonNullable<ProviderStreamOptions['onPayload']>>()
      .mockResolvedValue(undefined);
    const options = withNativeJsonPayload(model, { onPayload: callerOnPayload });

    const transformed = await options.onPayload?.(payload, model);

    expect(callerOnPayload).toHaveBeenCalledWith(payload, model);
    expect(transformed).toEqual({
      ...payload,
      response_format: { type: 'json_object' },
    });
    expect(payload).not.toHaveProperty('response_format');
  });

  it('rejects an unknown configured model without invoking a provider', () => {
    const modelLookup = vi.fn<PiAiModelLookup>().mockReturnValue(undefined);
    const complete = vi.fn<PiAiComplete>();

    expect(() => new PiAiEvaluatorClient(config, { complete, modelLookup })).toThrow(
      'Failed to get evaluator model: openai/gpt-4',
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects provider error responses without exposing their diagnostic', async () => {
    const leakedSecret = 'sk-pi-ai-evaluator-error-secret';
    const complete = vi.fn<PiAiComplete>().mockResolvedValue({
      ...createResponse([]),
      stopReason: 'error',
      errorMessage: `provider failed api_key=${leakedSecret}`,
    });
    const client = new PiAiEvaluatorClient(config, {
      complete,
      modelLookup: () => createModel(),
    });

    const promise = client.complete({
      systemPrompt: 'system',
      userPrompt: 'user',
      signal: new AbortController().signal,
    });
    await expect(promise).rejects.toMatchObject({
      code: 'provider_failed',
      status: 'failed',
    });
    await expect(promise).rejects.not.toThrow(leakedSecret);
  });

  it('rejects a response without text content', async () => {
    const complete = vi.fn<PiAiComplete>().mockResolvedValue(createResponse([
      { type: 'thinking', thinking: 'private reasoning' },
    ]));
    const client = new PiAiEvaluatorClient(config, {
      complete,
      modelLookup: () => createModel(),
    });

    await expect(client.complete({
      systemPrompt: 'system',
      userPrompt: 'user',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'empty_response',
      status: 'failed',
    });
  });

  it('classifies an aborted provider response separately from provider failure', async () => {
    const complete = vi.fn<PiAiComplete>().mockResolvedValue({
      ...createResponse([]),
      stopReason: 'aborted',
    });
    const client = new PiAiEvaluatorClient(config, {
      complete,
      modelLookup: () => createModel(),
    });

    await expect(client.complete({
      systemPrompt: 'system',
      userPrompt: 'user',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'provider_aborted',
      status: 'aborted',
    });
  });
});
