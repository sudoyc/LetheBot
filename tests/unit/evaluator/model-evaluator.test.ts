import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MemoryEvaluationRequest,
  SocialEvaluationRequest,
  ToolEvaluationRequest,
} from '../../../src/types/evaluator';
import {
  EvaluatorCompletionError,
  ModelEvaluator,
  type EvaluatorCompletion,
  type EvaluatorCompletionClient,
  type EvaluatorCompletionRequest,
  type EvaluatorInvocationLedger,
} from '../../../src/evaluator/model-evaluator';

const evaluatorConfig = {
  provider: 'openai',
  model: 'gpt-4',
  apiKey: 'test-only-key',
  timeoutMs: 500,
  maxRetries: 1,
  temperature: 0,
  promptVersion: 'governance-v1',
};

function createClient(response: string): {
  client: EvaluatorCompletionClient;
  complete: ReturnType<typeof vi.fn<(request: EvaluatorCompletionRequest) => Promise<EvaluatorCompletion>>>;
} {
  const complete = vi.fn<(request: EvaluatorCompletionRequest) => Promise<EvaluatorCompletion>>()
    .mockResolvedValue({
      text: response,
      tokens: { input: 10, output: 5, total: 15 },
    });
  return { client: { complete }, complete };
}

function createLedger() {
  let invocationCount = 0;
  const startEvaluatorInvocation = vi.fn(() => `model-invocation-${++invocationCount}`);
  const completeInvocation = vi.fn();
  const failInvocation = vi.fn();
  const ledger: EvaluatorInvocationLedger = {
    startEvaluatorInvocation,
    completeInvocation,
    failInvocation,
  };
  return { ledger, startEvaluatorInvocation, completeInvocation, failInvocation };
}

function createToolRequest(): ToolEvaluationRequest {
  return {
    requestId: 'request-tool-1',
    domain: 'tool',
    turnId: 'turn-private-1',
    actor: {
      actorClass: 'user',
      canonicalUserId: 'canonical-private-1',
    },
    context: 'private_chat',
    sourceEventIds: ['raw-private-1'],
    contextSummary: 'message api_key=sk-evaluator-prompt-secret-qq-1234567890',
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    toolName: 'memory.propose',
    capabilities: ['modifies_memory'],
    toolInput: {
      title: 'Preference',
      content: 'api_key=sk-evaluator-tool-input-secret-qq-1234567890',
    },
    proposedReason: 'Pi requested governed memory proposal',
  };
}

function createMemoryRequest(): MemoryEvaluationRequest {
  return {
    requestId: 'request-memory-1',
    domain: 'memory',
    turnId: 'turn-memory-private-1',
    actor: {
      actorClass: 'system_worker',
      canonicalUserId: 'canonical-memory-private-1',
    },
    context: 'background_worker',
    sourceEventIds: ['raw-memory-private-1'],
    contextSummary: 'scope=user\nsource_context=private_chat',
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    memoryCandidate: {
      scope: 'user',
      canonicalUserId: 'canonical-memory-private-1',
      groupId: 'qq-group-1234567890',
      kind: 'preference',
      title: 'Concise replies',
      content: 'The user prefers concise replies',
      confidence: 0.9,
      sourceContext: 'private_chat',
    },
    initialRiskLevel: 'low',
  };
}

function createSocialRequest(): SocialEvaluationRequest {
  return {
    requestId: 'request-social-1',
    domain: 'social',
    turnId: 'turn-social-private-1',
    actor: {
      actorClass: 'admin',
      canonicalUserId: 'canonical-social-private-1',
    },
    context: 'group_chat',
    sourceEventIds: ['raw-social-private-1'],
    contextSummary: 'conversation_type=group\nmessage=Please update the rule',
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    proposedAction: {
      type: 'reply_short',
      priority: 100,
      target: {
        conversationId: 'group:qq-group-1234567890',
        conversationType: 'group',
        groupId: 'qq-group-1234567890',
      },
      payload: { text: 'I will update the rule.' },
      constraints: {
        evaluatorRequired: true,
        cooldownKey: 'group:qq-group-1234567890:reply_short',
        cooldownSeconds: 60,
        redactionLevel: 'strict',
      },
      reason: 'Admin instruction requires review',
    },
    attentionSignals: {
      classification: 'needs_evaluation',
      triggerScore: 0.9,
      triggerReasons: ['admin_instruction'],
      suppressors: [],
      recommendedPath: 'risk_path',
    },
    isProactive: false,
  };
}

describe('ModelEvaluator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects non-canonical evaluator identity before any invocation can start', () => {
    const { client } = createClient('{}');
    const ledger = createLedger();
    expect(() => new ModelEvaluator({
      ...evaluatorConfig,
      promptVersion: ' governance-v1 ',
    }, client, ledger.ledger)).toThrow(
      'Evaluator provider, model, and promptVersion must use bounded canonical values',
    );
    expect(ledger.startEvaluatorInvocation).not.toHaveBeenCalled();
  });

  it('builds a redacted tool prompt and assigns trusted metadata locally', async () => {
    const leakedReason = 'approved api_key=sk-evaluator-result-secret-qq-1234567890';
    const { client, complete } = createClient(JSON.stringify({
      domain: 'tool',
      decision: 'approve',
      reason: leakedReason,
      confidence: 0.92,
      riskLevel: 'medium',
    }));
    const ledger = createLedger();
    const evaluator = new ModelEvaluator(evaluatorConfig, client, ledger.ledger);
    const request = createToolRequest();
    const originalRequest = structuredClone(request);

    const result = await evaluator.evaluateTool(request);

    expect(result).toMatchObject({
      domain: 'tool',
      requestId: request.requestId,
      decision: 'approve',
      confidence: 0.92,
      riskLevel: 'medium',
      evaluatorVersion: 'openai/gpt-4/governance-v1',
      modelInvocationId: 'model-invocation-1',
    });
    expect(result.decisionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.decidedAt).toBeInstanceOf(Date);
    expect(result.reason).toContain('[REDACTED:api_key_assignment]');
    expect(result.reason).toContain('[REDACTED:platform_id]');
    expect(result.reason).not.toContain('sk-evaluator-result-secret');
    expect(request).toEqual(originalRequest);

    const completionRequest = complete.mock.calls[0]?.[0];
    expect(completionRequest?.systemPrompt).toContain('For memory.propose only');
    expect(completionRequest?.systemPrompt).toContain('explicit first-party request');
    expect(completionRequest?.systemPrompt).toContain('stable, non-sensitive information');
    expect(completionRequest?.systemPrompt).toContain('reviewable proposal');
    expect(completionRequest?.systemPrompt).toContain('does not activate memory');
    expect(completionRequest?.systemPrompt).toContain(
      'omit modifiedToolInput, alternativeTool, and additionalConstraints',
    );
    expect(completionRequest?.userPrompt).toContain('memory.propose');
    expect(completionRequest?.userPrompt).toContain('[REDACTED:api_key_assignment]');
    expect(completionRequest?.userPrompt).toContain('[REDACTED:platform_id]');
    expect(completionRequest?.userPrompt).not.toContain('sk-evaluator-prompt-secret');
    expect(completionRequest?.userPrompt).not.toContain('sk-evaluator-tool-input-secret');
    expect(completionRequest?.userPrompt).not.toContain(request.turnId);
    expect(completionRequest?.userPrompt).not.toContain(request.actor.canonicalUserId);
    expect(completionRequest?.userPrompt).not.toContain(request.sourceEventIds[0]);
    expect(Buffer.byteLength(completionRequest?.userPrompt ?? '', 'utf8')).toBeLessThanOrEqual(16_384);
    expect(ledger.startEvaluatorInvocation).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId,
      domain: 'tool',
      turnId: request.turnId,
      provider: evaluatorConfig.provider,
      model: evaluatorConfig.model,
      promptVersion: evaluatorConfig.promptVersion,
      rawEventIds: request.sourceEventIds,
    }));
    expect(ledger.completeInvocation).toHaveBeenCalledWith(
      'model-invocation-1',
      { input: 10, output: 5, total: 15 },
      expect.any(String),
    );
    expect(ledger.startEvaluatorInvocation.mock.invocationCallOrder[0])
      .toBeLessThan(complete.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
    expect(complete.mock.invocationCallOrder[0])
      .toBeLessThan(ledger.completeInvocation.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
    expect(ledger.failInvocation).not.toHaveBeenCalled();
  });

  it('parses a strict memory decision without sending durable owner identifiers', async () => {
    const { client, complete } = createClient(JSON.stringify({
      domain: 'memory',
      decision: 'approve',
      reason: 'Low-risk private preference',
      confidence: 0.88,
      riskLevel: 'low',
      recommendedState: 'active',
      recommendedVisibility: 'private_only',
      recommendedSensitivity: 'personal',
    }));
    const evaluator = new ModelEvaluator(evaluatorConfig, client, createLedger().ledger);
    const request = createMemoryRequest();

    const result = await evaluator.evaluateMemory(request);

    expect(result).toMatchObject({
      domain: 'memory',
      requestId: request.requestId,
      recommendedState: 'active',
      recommendedVisibility: 'private_only',
      recommendedSensitivity: 'personal',
    });
    const prompt = complete.mock.calls[0]?.[0].userPrompt ?? '';
    expect(prompt).toContain('Concise replies');
    expect(prompt).not.toContain(request.turnId);
    expect(prompt).not.toContain(request.actor.canonicalUserId);
    expect(prompt).not.toContain(request.memoryCandidate.groupId);
    expect(prompt).not.toContain(request.sourceEventIds[0]);
  });

  it('parses a strict social downgrade while omitting local delivery targets', async () => {
    const { client, complete } = createClient(JSON.stringify({
      domain: 'social',
      decision: 'downgrade',
      reason: 'Keep the group response concise',
      confidence: 0.86,
      riskLevel: 'medium',
      downgradeAction: {
        from: 'reply_short',
        to: 'silent_store',
        reason: 'No outward reply is needed',
      },
      cooldownSeconds: 120,
    }));
    const evaluator = new ModelEvaluator(evaluatorConfig, client, createLedger().ledger);
    const request = createSocialRequest();

    const result = await evaluator.evaluateSocial(request);

    expect(result).toMatchObject({
      domain: 'social',
      requestId: request.requestId,
      decision: 'downgrade',
      downgradeAction: {
        from: 'reply_short',
        to: 'silent_store',
      },
      cooldownSeconds: 120,
    });
    const prompt = complete.mock.calls[0]?.[0].userPrompt ?? '';
    expect(prompt).toContain('reply_short');
    expect(prompt).not.toContain(request.turnId);
    expect(prompt).not.toContain(request.actor.canonicalUserId);
    expect(prompt).not.toContain(request.proposedAction.target?.conversationId);
    expect(prompt).not.toContain(request.proposedAction.constraints.cooldownKey);
    expect(prompt).not.toContain(request.sourceEventIds[0]);
  });

  it('ledgers one correction call after invalid structured output and links the valid result to call 2', async () => {
    const invalidOutput = '{"diagnostic":"malformed-output-must-not-be-replayed"';
    const validOutput = JSON.stringify({
      domain: 'tool',
      decision: 'reject',
      reason: 'The governed tool is not authorized',
      confidence: 0.93,
      riskLevel: 'high',
    });
    const complete = vi.fn<(request: EvaluatorCompletionRequest) => Promise<EvaluatorCompletion>>()
      .mockResolvedValueOnce({
        text: invalidOutput,
        tokens: { input: 10, output: 3, total: 13 },
      })
      .mockResolvedValueOnce({
        text: validOutput,
        tokens: { input: 12, output: 6, total: 18 },
      });
    const ledger = createLedger();
    const evaluator = new ModelEvaluator(evaluatorConfig, { complete }, ledger.ledger);
    const request = createToolRequest();

    const result = await evaluator.evaluateTool(request);

    expect(result).toMatchObject({
      requestId: request.requestId,
      decision: 'reject',
      modelInvocationId: 'model-invocation-2',
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(ledger.startEvaluatorInvocation).toHaveBeenCalledTimes(2);
    expect(ledger.startEvaluatorInvocation.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ requestId: request.requestId, callNumber: 1 }),
      expect.objectContaining({ requestId: request.requestId, callNumber: 2 }),
    ]);
    expect(ledger.failInvocation).toHaveBeenCalledOnce();
    expect(ledger.failInvocation).toHaveBeenCalledWith(
      'model-invocation-1',
      'invalid_structured_output',
      'failed',
    );
    expect(ledger.completeInvocation).toHaveBeenCalledOnce();
    expect(ledger.completeInvocation).toHaveBeenCalledWith(
      'model-invocation-2',
      { input: 12, output: 6, total: 18 },
      validOutput,
    );
    const correctionRequest = complete.mock.calls[1]?.[0];
    expect(correctionRequest?.systemPrompt).toContain('Correction attempt');
    expect(`${correctionRequest?.systemPrompt}\n${correctionRequest?.userPrompt}`)
      .not.toContain('malformed-output-must-not-be-replayed');
    expect(ledger.failInvocation.mock.invocationCallOrder[0])
      .toBeLessThan(ledger.startEvaluatorInvocation.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER);
  });

  it.each([
    {
      domain: 'memory',
      requestId: 'request-memory-1',
      validOutput: JSON.stringify({
        domain: 'memory',
        decision: 'approve',
        reason: 'Synthetic memory correction approved',
        confidence: 0.9,
        riskLevel: 'low',
        recommendedState: 'proposed',
        recommendedVisibility: 'private_only',
        recommendedSensitivity: 'personal',
      }),
      evaluate: (evaluator: ModelEvaluator) => evaluator.evaluateMemory(createMemoryRequest()),
    },
    {
      domain: 'social',
      requestId: 'request-social-1',
      validOutput: JSON.stringify({
        domain: 'social',
        decision: 'approve',
        reason: 'Synthetic social correction approved',
        confidence: 0.9,
        riskLevel: 'medium',
      }),
      evaluate: (evaluator: ModelEvaluator) => evaluator.evaluateSocial(createSocialRequest()),
    },
  ] as const)(
    'uses one separately ledgered strict correction for $domain output',
    async ({ domain, requestId, validOutput, evaluate }) => {
      const fencedOutput = `\`\`\`json\n${validOutput}\n\`\`\``;
      const complete = vi.fn<(request: EvaluatorCompletionRequest) => Promise<EvaluatorCompletion>>()
        .mockResolvedValueOnce({
          text: fencedOutput,
          tokens: { input: 10, output: 4, total: 14 },
        })
        .mockResolvedValueOnce({
          text: validOutput,
          tokens: { input: 12, output: 6, total: 18 },
        });
      const ledger = createLedger();
      const evaluator = new ModelEvaluator(evaluatorConfig, { complete }, ledger.ledger);

      const result = await evaluate(evaluator);

      expect(result).toMatchObject({
        domain,
        requestId,
        modelInvocationId: 'model-invocation-2',
      });
      expect(complete).toHaveBeenCalledTimes(2);
      expect(ledger.startEvaluatorInvocation.mock.calls.map(([input]) => ({
        domain: input.domain,
        callNumber: input.callNumber,
      }))).toEqual([
        { domain, callNumber: 1 },
        { domain, callNumber: 2 },
      ]);
      expect(ledger.failInvocation).toHaveBeenCalledWith(
        'model-invocation-1',
        'invalid_structured_output',
        'failed',
      );
      expect(ledger.completeInvocation).toHaveBeenCalledWith(
        'model-invocation-2',
        { input: 12, output: 6, total: 18 },
        validOutput,
      );
    },
  );

  it('stops after two invalid structured outputs and never starts call 3', async () => {
    const complete = vi.fn<(request: EvaluatorCompletionRequest) => Promise<EvaluatorCompletion>>()
      .mockResolvedValue({
        text: '{invalid-json',
        tokens: { input: 10, output: 3, total: 13 },
      });
    const ledger = createLedger();
    const evaluator = new ModelEvaluator(evaluatorConfig, { complete }, ledger.ledger);

    await expect(evaluator.evaluateTool(createToolRequest())).rejects.toThrow(
      'Tool evaluator returned invalid structured output',
    );

    expect(complete).toHaveBeenCalledTimes(2);
    expect(ledger.startEvaluatorInvocation).toHaveBeenCalledTimes(2);
    expect(ledger.startEvaluatorInvocation.mock.calls.map(([input]) => input.callNumber))
      .toEqual([1, 2]);
    expect(ledger.failInvocation).toHaveBeenCalledTimes(2);
    expect(ledger.failInvocation).toHaveBeenNthCalledWith(
      1,
      'model-invocation-1',
      'invalid_structured_output',
      'failed',
    );
    expect(ledger.failInvocation).toHaveBeenNthCalledWith(
      2,
      'model-invocation-2',
      'invalid_structured_output',
      'failed',
    );
    expect(ledger.completeInvocation).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['fenced JSON', `\`\`\`json
${JSON.stringify({
  domain: 'tool',
  decision: 'approve',
  reason: 'fenced output must not be parsed permissively',
  confidence: 0.9,
  riskLevel: 'low',
})}
\`\`\``],
    ['wrong domain', JSON.stringify({
      domain: 'memory',
      decision: 'approve',
      reason: 'wrong domain',
      confidence: 0.9,
      riskLevel: 'low',
    })],
    ['spoofed metadata', JSON.stringify({
      domain: 'tool',
      decision: 'approve',
      reason: 'spoofed',
      confidence: 0.9,
      riskLevel: 'low',
      decisionId: 'model-controlled-id',
    })],
    ['invalid confidence', JSON.stringify({
      domain: 'tool',
      decision: 'approve',
      reason: 'invalid confidence',
      confidence: 2,
      riskLevel: 'low',
    })],
  ])('fails closed on %s', async (_name, response) => {
    const { client } = createClient(response);
    const ledger = createLedger();
    const evaluator = new ModelEvaluator(evaluatorConfig, client, ledger.ledger);

    await expect(evaluator.evaluateTool(createToolRequest())).rejects.toThrow(
      'Tool evaluator returned invalid structured output',
    );
    expect(ledger.failInvocation).toHaveBeenCalledTimes(2);
    expect(ledger.failInvocation).toHaveBeenNthCalledWith(
      1, 'model-invocation-1', 'invalid_structured_output', 'failed',
    );
    expect(ledger.failInvocation).toHaveBeenNthCalledWith(
      2, 'model-invocation-2', 'invalid_structured_output', 'failed',
    );
    expect(ledger.completeInvocation).not.toHaveBeenCalled();
  });

  it('rejects oversized completion text before parsing', async () => {
    const { client } = createClient('x'.repeat(20_000));
    const ledger = createLedger();
    const evaluator = new ModelEvaluator(evaluatorConfig, client, ledger.ledger);

    await expect(evaluator.evaluateTool(createToolRequest())).rejects.toThrow(
      'Tool evaluator returned oversized output',
    );
    expect(ledger.failInvocation).toHaveBeenCalledWith(
      'model-invocation-1',
      'oversized_output',
      'failed',
    );
    expect(ledger.startEvaluatorInvocation).toHaveBeenCalledOnce();
  });

  it('bounds multibyte prompt data by UTF-8 bytes with a visible marker', async () => {
    const { client, complete } = createClient(JSON.stringify({
      domain: 'tool',
      decision: 'reject',
      reason: 'Oversized request rejected',
      confidence: 0.9,
      riskLevel: 'high',
    }));
    const evaluator = new ModelEvaluator(evaluatorConfig, client, createLedger().ledger);
    const request = createToolRequest();
    request.toolInput = { content: '界'.repeat(10_000) };

    await evaluator.evaluateTool(request);

    const prompt = complete.mock.calls[0]?.[0].userPrompt ?? '';
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(prompt).toContain('[TRUNCATED:evaluator_prompt]');
  });

  it('does not call the Provider when durable invocation start fails', async () => {
    const { client, complete } = createClient(JSON.stringify({
      domain: 'tool',
      decision: 'approve',
      reason: 'would otherwise approve',
      confidence: 0.9,
      riskLevel: 'low',
    }));
    const ledger = createLedger();
    ledger.startEvaluatorInvocation.mockImplementation(() => {
      throw new Error('synthetic ledger failure');
    });
    const evaluator = new ModelEvaluator(evaluatorConfig, client, ledger.ledger);

    await expect(evaluator.evaluateTool(createToolRequest())).rejects.toThrow(
      'Tool evaluator invocation could not be recorded',
    );
    expect(complete).not.toHaveBeenCalled();
    expect(ledger.completeInvocation).not.toHaveBeenCalled();
    expect(ledger.failInvocation).not.toHaveBeenCalled();
  });

  it('fails closed when a valid Provider response cannot be completed durably', async () => {
    const { client } = createClient(JSON.stringify({
      domain: 'tool',
      decision: 'approve',
      reason: 'valid response',
      confidence: 0.9,
      riskLevel: 'low',
    }));
    const ledger = createLedger();
    ledger.completeInvocation.mockImplementation(() => {
      throw new Error('synthetic completion persistence failure');
    });
    const evaluator = new ModelEvaluator(evaluatorConfig, client, ledger.ledger);

    await expect(evaluator.evaluateTool(createToolRequest())).rejects.toThrow(
      'Tool evaluator invocation could not be completed',
    );
    expect(ledger.failInvocation).toHaveBeenCalledWith(
      'model-invocation-1',
      'persistence_failed',
      'failed',
    );
  });

  it('replaces provider failures with a bounded diagnostic', async () => {
    const leakedSecret = 'sk-evaluator-provider-error-must-not-leak';
    const complete = vi.fn<(request: EvaluatorCompletionRequest) => Promise<EvaluatorCompletion>>()
      .mockRejectedValue(new Error(`provider failed api_key=${leakedSecret}`));
    const ledger = createLedger();
    const evaluator = new ModelEvaluator(evaluatorConfig, { complete }, ledger.ledger);

    const promise = evaluator.evaluateTool(createToolRequest());
    await expect(promise).rejects.toThrow('Tool evaluator request failed');
    await expect(promise).rejects.not.toThrow(leakedSecret);
    expect(ledger.failInvocation).toHaveBeenCalledWith(
      'model-invocation-1',
      'provider_failed',
      'failed',
    );
    expect(complete).toHaveBeenCalledOnce();
    expect(ledger.startEvaluatorInvocation).toHaveBeenCalledOnce();
  });

  it.each([
    ['empty_response', 'failed'],
    ['provider_aborted', 'aborted'],
  ] as const)('records %s completion failures as terminal invocation evidence', async (code, status) => {
    const complete = vi.fn<(request: EvaluatorCompletionRequest) => Promise<EvaluatorCompletion>>()
      .mockRejectedValue(new EvaluatorCompletionError(code, status));
    const ledger = createLedger();
    const evaluator = new ModelEvaluator(evaluatorConfig, { complete }, ledger.ledger);

    await expect(evaluator.evaluateTool(createToolRequest())).rejects.toThrow(
      'Tool evaluator request failed',
    );
    expect(ledger.failInvocation).toHaveBeenCalledWith(
      'model-invocation-1',
      code,
      status,
    );
    expect(ledger.completeInvocation).not.toHaveBeenCalled();
  });

  it('aborts and fails closed at the configured deadline', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const complete = vi.fn<(request: EvaluatorCompletionRequest) => Promise<EvaluatorCompletion>>()
      .mockImplementation((request) => {
        observedSignal = request.signal;
        return new Promise<EvaluatorCompletion>(() => undefined);
      });
    const ledger = createLedger();
    const evaluator = new ModelEvaluator(
      { ...evaluatorConfig, timeoutMs: 100 },
      { complete },
      ledger.ledger,
    );

    const result = evaluator.evaluateTool(createToolRequest());
    const rejection = expect(result).rejects.toThrow(
      'Tool evaluator request timed out after 100 ms',
    );
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(ledger.failInvocation).toHaveBeenCalledWith(
      'model-invocation-1',
      'deadline_exceeded',
      'aborted',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
