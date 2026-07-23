import { describe, expect, it, vi } from 'vitest';
import { EvaluatorStub } from '../../../src/evaluator/evaluator-stub';
import { ModelEvaluator } from '../../../src/evaluator/model-evaluator';
import {
  createRuntimeEvaluator,
  resolveEvaluatorConfig,
} from '../../../src/evaluator/runtime';

const baseConfig = {
  provider: 'openai',
  model: 'gpt-4',
  apiKey: 'test-only-key',
  timeoutMs: 30_000,
  maxRetries: 1,
  temperature: 0,
  promptVersion: 'governance-v1',
};

describe('createRuntimeEvaluator', () => {
  it('inherits the complete Pi provider identity only when evaluator identity is unset', () => {
    expect(resolveEvaluatorConfig({
      provider: 'openai',
      model: 'deepseek-chat',
      baseUrl: 'https://pi.example.invalid/v1',
      apiKey: 'pi-key',
    }, {
      timeoutMs: 30_000,
      maxRetries: 1,
      temperature: 0,
      promptVersion: 'governance-v1',
    })).toMatchObject({
      provider: 'openai',
      model: 'deepseek-chat',
      baseUrl: 'https://pi.example.invalid/v1',
      apiKey: 'pi-key',
    });
  });

  it('requires evaluator provider and model overrides together', () => {
    const pi = {
      provider: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://pi.example.invalid/v1',
      apiKey: 'pi-key',
    };
    const tuning = {
      timeoutMs: 30_000,
      maxRetries: 1,
      temperature: 0,
      promptVersion: 'governance-v1',
    };

    expect(() => resolveEvaluatorConfig(pi, {
      ...tuning,
      provider: 'anthropic',
    })).toThrow('EVALUATOR_PROVIDER and EVALUATOR_MODEL must be configured together');
    expect(() => resolveEvaluatorConfig(pi, {
      ...tuning,
      model: 'claude-test',
    })).toThrow('EVALUATOR_PROVIDER and EVALUATOR_MODEL must be configured together');
  });

  it('does not inherit Pi endpoint or credentials for an overridden evaluator identity', () => {
    expect(resolveEvaluatorConfig({
      provider: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://pi.example.invalid/v1',
      apiKey: 'pi-key',
    }, {
      provider: 'anthropic',
      model: 'claude-test',
      timeoutMs: 30_000,
      maxRetries: 1,
      temperature: 0,
      promptVersion: 'governance-v1',
    })).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test',
      baseUrl: undefined,
      apiKey: undefined,
    });
  });

  it('uses the rule-driven stub only in explicit test or mock operation', () => {
    expect(createRuntimeEvaluator(baseConfig, { test: true })).toBeInstanceOf(EvaluatorStub);
    expect(createRuntimeEvaluator({ ...baseConfig, provider: 'mock' })).toBeInstanceOf(EvaluatorStub);
  });

  it('requires an explicit credential for a non-mock evaluator', () => {
    expect(() => createRuntimeEvaluator({ ...baseConfig, apiKey: undefined })).toThrow(
      'EVALUATOR_API_KEY or PI_API_KEY is required for a non-mock evaluator provider',
    );
    expect(() => createRuntimeEvaluator({ ...baseConfig, apiKey: '   ' })).toThrow(
      'EVALUATOR_API_KEY or PI_API_KEY is required for a non-mock evaluator provider',
    );
  });

  it('requires a durable invocation ledger for a non-mock evaluator', () => {
    expect(() => createRuntimeEvaluator(baseConfig)).toThrow(
      'A durable evaluator invocation ledger is required for a non-mock evaluator',
    );
  });

  it('constructs the structured evaluator with an injected non-network client', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        domain: 'tool',
        decision: 'reject',
        reason: 'Denied by deterministic fake',
        confidence: 0.95,
        riskLevel: 'high',
      }),
      tokens: { input: 8, output: 4, total: 12 },
    });
    const invocationLedger = {
      startEvaluatorInvocation: vi.fn().mockReturnValue('runtime-model-invocation'),
      completeInvocation: vi.fn(),
      failInvocation: vi.fn(),
    };
    const evaluator = createRuntimeEvaluator(baseConfig, {
      client: { complete },
      invocationLedger,
    });

    expect(evaluator).toBeInstanceOf(ModelEvaluator);
    await expect(evaluator.evaluateTool({
      requestId: 'request-runtime-1',
      domain: 'tool',
      turnId: 'turn-runtime-1',
      actor: { actorClass: 'user' },
      context: 'private_chat',
      sourceEventIds: ['raw-runtime-1'],
      contextSummary: 'bounded context',
      createdAt: new Date(),
      toolName: 'test.tool',
      capabilities: ['read_context'],
      toolInput: {},
      proposedReason: 'test',
    })).resolves.toMatchObject({
      domain: 'tool',
      decision: 'reject',
      evaluatorVersion: 'openai/gpt-4/governance-v1',
      modelInvocationId: 'runtime-model-invocation',
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(invocationLedger.completeInvocation).toHaveBeenCalledOnce();
  });
});
