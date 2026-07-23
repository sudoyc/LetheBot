import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigrations, closeDatabase } from '../../../src/storage/database';
import { ActionRepository } from '../../../src/actions/action-repository';
import { SocialDecisionService } from '../../../src/actions/social-decision-service';
import { ActionCooldownManager } from '../../../src/actions/cooldown';
import { ModelEvaluator } from '../../../src/evaluator/model-evaluator';
import { ModelInvocationRepository } from '../../../src/storage/model-invocation-repository';
import type { AttentionSignals } from '../../../src/types/attention';
import type { ChatMessageReceived } from '../../../src/types/events';
import type {
  IEvaluator,
  SocialEvaluationRequest,
  SocialEvaluationResult,
} from '../../../src/types/evaluator';

describe('SocialDecisionService', () => {
  let testDir: string;
  let db: Database.Database;
  let actionRepo: ActionRepository;
  let service: SocialDecisionService;
  let evaluateSocial: ReturnType<typeof vi.fn>;
  let cooldowns: ActionCooldownManager;

  function insertRunningGroupTurn(rawEventId: string, turnId: string): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(rawEventId, 'message.group', now, 'gateway', 'qq', 'qq-group-20008', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(turnId, 'qq-group-20008', rawEventId, 'mock', 'mock', 'running', now);
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-social-decision-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigrations(db, join(__dirname, '../../../migrations'));
    actionRepo = new ActionRepository(db);
    evaluateSocial = vi.fn(async (request: SocialEvaluationRequest): Promise<SocialEvaluationResult> => ({
      domain: 'social',
      decisionId: 'eval-social-1',
      requestId: request.requestId,
      decision: 'approve',
      reason: 'approved for test',
      confidence: 0.9,
      riskLevel: 'low',
      decidedAt: new Date(),
      evaluatorVersion: 'test-evaluator',
    }));
    const evaluator: IEvaluator = {
      evaluateTool: async () => {
        throw new Error('unexpected tool evaluation');
      },
      evaluateMemory: async () => {
        throw new Error('unexpected memory evaluation');
      },
      evaluateSocial,
    };
    cooldowns = new ActionCooldownManager();
    service = new SocialDecisionService(actionRepo, evaluator, cooldowns);

    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('raw-social-private', 'message.private', now, 'gateway', 'qq', 'private:qq-10008', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-social-private', 'private:qq-10008', 'raw-social-private', 'mock', 'mock', 'running', now);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('persists private reply action targets with platform delivery and canonical governance identities', async () => {
    const decision = await service.createDecision({
      turnId: 'turn-social-private',
      rawEventId: 'raw-social-private',
      event: makePrivateEvent(),
      responseText: '收到，我会处理。',
      signals: makeReplySignals(),
      actor: {
        canonicalUserId: 'user-social-alice',
        actorClass: 'user',
      },
    });

    expect(evaluateSocial).not.toHaveBeenCalled();
    expect(decision.actions[0]?.target).toMatchObject({
      conversationId: 'private:qq-10008',
      conversationType: 'private',
      userId: 'qq-10008',
      canonicalUserId: 'user-social-alice',
    });

    const row = db
      .prepare('SELECT actions FROM action_decisions WHERE id = ?')
      .get(decision.id) as { actions: string };
    const storedActions = JSON.parse(row.actions) as Array<{
      target?: {
        conversationId?: string;
        conversationType?: string;
        userId?: string;
        canonicalUserId?: string;
      };
    }>;

    expect(storedActions[0]?.target).toMatchObject({
      conversationId: 'private:qq-10008',
      conversationType: 'private',
      userId: 'qq-10008',
      canonicalUserId: 'user-social-alice',
    });
    expect(storedActions[0]?.target?.userId).not.toBe('user-social-alice');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('REL-ADMIN-01 marks an unmentioned command intervention as proactive for evaluation', async () => {
    const rawEventId = 'raw-social-proactive-command';
    const turnId = 'turn-social-proactive-command';
    insertRunningGroupTurn(rawEventId, turnId);
    let capturedRequest: SocialEvaluationRequest | undefined;
    evaluateSocial.mockImplementationOnce(async (
      request: SocialEvaluationRequest,
    ): Promise<SocialEvaluationResult> => {
      capturedRequest = structuredClone(request);
      return {
        domain: 'social',
        decisionId: 'eval-social-proactive-command',
        requestId: request.requestId,
        decision: 'approve',
        reason: 'Synthetic command approved',
        confidence: 0.9,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'test-evaluator',
      };
    });
    const event = makeGroupEvent(
      'event-social-proactive-command',
      'qq-social-proactive-command',
      'command',
    );
    event.message.senderRole = 'admin';

    await service.createDecision({
      turnId,
      rawEventId,
      event,
      responseText: 'Synthetic governed command response',
      signals: {
        classification: 'needs_evaluation',
        triggerScore: 0.9,
        triggerReasons: ['command'],
        suppressors: [],
        recommendedPath: 'risk_path',
      },
      actor: {
        canonicalUserId: 'user-social-proactive-command',
        actorClass: 'group_admin',
      },
    });

    expect(event.message.mentionsBot).toBe(false);
    expect(event.message.replyToMessageId).toBeUndefined();
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.isProactive).toBe(true);
    expect(capturedRequest?.proposedAction.constraints.proactive).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('requires evaluation for an outward unmentioned group reply on the response path', async () => {
    const rawEventId = 'raw-social-proactive-response';
    const turnId = 'turn-social-proactive-response';
    insertRunningGroupTurn(rawEventId, turnId);
    let capturedRequest: SocialEvaluationRequest | undefined;
    evaluateSocial.mockImplementationOnce(async (
      request: SocialEvaluationRequest,
    ): Promise<SocialEvaluationResult> => {
      capturedRequest = structuredClone(request);
      return {
        domain: 'social',
        decisionId: 'eval-social-proactive-response',
        requestId: request.requestId,
        decision: 'approve',
        reason: 'Synthetic proactive response approved',
        confidence: 0.9,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'test-evaluator',
      };
    });

    const decision = await service.createDecision({
      turnId,
      rawEventId,
      event: makeGroupEvent(
        'event-social-proactive-response',
        'qq-social-proactive-response',
      ),
      responseText: 'Synthetic proactive group response',
      signals: {
        classification: 'needs_response',
        triggerScore: 0.3,
        triggerReasons: ['question'],
        suppressors: [],
        recommendedPath: 'reply_fast_path',
      },
      actor: {
        canonicalUserId: 'user-social-proactive-response',
        actorClass: 'user',
      },
    });

    expect(evaluateSocial).toHaveBeenCalledTimes(1);
    expect(capturedRequest).toMatchObject({
      isProactive: true,
      proposedAction: {
        type: 'reply_short',
        constraints: {
          evaluatorRequired: true,
          proactive: true,
        },
      },
    });
    expect(decision).toMatchObject({
      decidedBy: 'evaluator',
      evaluatorRequired: true,
      evaluatorPassed: true,
      actions: [{
        type: 'reply_short',
        constraints: {
          evaluatorRequired: true,
          proactive: true,
        },
      }],
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('keeps an unmentioned empty-response silent store non-proactive', async () => {
    const rawEventId = 'raw-social-silent-not-proactive';
    const turnId = 'turn-social-silent-not-proactive';
    insertRunningGroupTurn(rawEventId, turnId);

    const decision = await service.createDecision({
      turnId,
      rawEventId,
      event: makeGroupEvent(
        'event-social-silent-not-proactive',
        'qq-social-silent-not-proactive',
      ),
      responseText: '   ',
      signals: {
        classification: 'needs_response',
        triggerScore: 0.3,
        triggerReasons: ['question'],
        suppressors: [],
        recommendedPath: 'reply_fast_path',
      },
      actor: {
        canonicalUserId: 'user-social-silent-not-proactive',
        actorClass: 'user',
      },
    });

    expect(evaluateSocial).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      decidedBy: 'pi',
      evaluatorRequired: false,
      actions: [{
        type: 'silent_store',
        constraints: {
          evaluatorRequired: false,
          proactive: false,
        },
      }],
    });
    expect(decision.evaluatorPassed).toBeUndefined();

    const row = db.prepare(
      'SELECT evaluator_required, evaluator_passed, actions FROM action_decisions WHERE id = ?',
    ).get(decision.id) as {
      evaluator_required: number;
      evaluator_passed: number | null;
      actions: string;
    };
    expect(row.evaluator_required).toBe(0);
    expect(row.evaluator_passed).toBeNull();
    expect(JSON.parse(row.actions)).toMatchObject([{
      type: 'silent_store',
      constraints: {
        evaluatorRequired: false,
        proactive: false,
      },
    }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it.each([
    { label: 'direct mention', triggerReason: '@bot' as const },
    { label: 'verified reply to bot', triggerReason: 'reply_to_bot' as const },
  ])('marks a $label evaluator request as reactive', async ({ triggerReason }) => {
    const suffix = triggerReason === '@bot' ? 'mention' : 'reply';
    const rawEventId = `raw-social-reactive-${suffix}`;
    const turnId = `turn-social-reactive-${suffix}`;
    insertRunningGroupTurn(rawEventId, turnId);
    let capturedRequest: SocialEvaluationRequest | undefined;
    evaluateSocial.mockImplementationOnce(async (
      request: SocialEvaluationRequest,
    ): Promise<SocialEvaluationResult> => {
      capturedRequest = structuredClone(request);
      return {
        domain: 'social',
        decisionId: `eval-social-reactive-${suffix}`,
        requestId: request.requestId,
        decision: 'approve',
        reason: 'Synthetic reactive action approved',
        confidence: 0.9,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'test-evaluator',
      };
    });

    await service.createDecision({
      turnId,
      rawEventId,
      event: makeGroupEvent(
        `event-social-reactive-${suffix}`,
        `qq-social-reactive-${suffix}`,
        triggerReason,
      ),
      responseText: 'Synthetic reactive response',
      signals: {
        classification: 'needs_evaluation',
        triggerScore: 0.9,
        triggerReasons: [triggerReason],
        suppressors: [],
        recommendedPath: 'risk_path',
      },
      actor: {
        canonicalUserId: `user-social-reactive-${suffix}`,
        actorClass: 'user',
      },
    });

    expect(capturedRequest?.isProactive).toBe(false);
    expect(capturedRequest?.proposedAction.constraints.proactive).toBe(false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('REL-EVAL-01/02 persists bounded all-silent suppression when the social evaluator throws', async () => {
    const rawEventId = 'raw-social-invalid-evaluator-output';
    const turnId = 'turn-social-invalid-evaluator-output';
    const leakedDiagnostic = 'sk-synthetic-evaluator-diagnostic-must-not-persist';
    insertRunningGroupTurn(rawEventId, turnId);
    evaluateSocial.mockRejectedValueOnce(
      new Error(`Social evaluator returned invalid structured output: ${leakedDiagnostic}`),
    );

    const decision = await service.createDecision({
      turnId,
      rawEventId,
      event: makeGroupEvent(
        'event-social-invalid-evaluator-output',
        'qq-social-invalid-evaluator-output',
        'command',
      ),
      responseText: 'This governed response must not be delivered.',
      signals: {
        classification: 'needs_evaluation',
        triggerScore: 0.9,
        triggerReasons: ['command'],
        suppressors: [],
        recommendedPath: 'risk_path',
      },
      actor: {
        canonicalUserId: 'user-social-invalid-evaluator-output',
        actorClass: 'group_admin',
      },
    });

    expect(decision.actions.length).toBeGreaterThan(0);
    expect(decision.actions.every((action) => action.type === 'silent_store')).toBe(true);
    expect(decision.evaluatorRequired).toBe(true);
    expect(decision.evaluatorPassed).toBe(false);
    expect(decision.evaluatorDecisionId).toBeUndefined();
    const failureSuppressor = decision.suppressors.find((suppressor) =>
      /^evaluator_[a-z0-9_:.-]*(?:failure|failed|error)[a-z0-9_:.-]*$/i.test(suppressor)
    );
    expect(failureSuppressor).toBeDefined();
    expect(failureSuppressor?.length).toBeLessThanOrEqual(128);
    expect(failureSuppressor).not.toContain(leakedDiagnostic);

    const row = db.prepare(
      `SELECT evaluator_required, evaluator_passed, evaluator_decision_id, actions, suppressors
       FROM action_decisions WHERE id = ?`
    ).get(decision.id) as {
      evaluator_required: number;
      evaluator_passed: number | null;
      evaluator_decision_id: string | null;
      actions: string;
      suppressors: string;
    };
    const storedActions = JSON.parse(row.actions) as Array<{ type: string }>;
    const storedSuppressors = JSON.parse(row.suppressors) as string[];

    expect(row).toMatchObject({
      evaluator_required: 1,
      evaluator_passed: 0,
      evaluator_decision_id: null,
    });
    expect(storedActions.length).toBeGreaterThan(0);
    expect(storedActions.every((action) => action.type === 'silent_store')).toBe(true);
    expect(storedSuppressors).toContain(failureSuppressor);
    expect(JSON.stringify(row)).not.toContain(leakedDiagnostic);
    expect(db.prepare('SELECT action_decision_id FROM agent_turns WHERE id = ?').get(turnId))
      .toEqual({ action_decision_id: decision.id });
    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get())
      .toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it.each([
    { outcome: 'approve', expectedAction: 'reply_full', expectedPassed: 1 },
    { outcome: 'downgrade', expectedAction: 'reply_short', expectedPassed: 1 },
    { outcome: 'reject', expectedAction: 'silent_store', expectedPassed: 0 },
    { outcome: 'propose', expectedAction: 'silent_store', expectedPassed: 0 },
  ] as const)(
    'atomically persists exact evaluator evidence for $outcome decisions',
    async ({ outcome, expectedAction, expectedPassed }) => {
      const decidedAt = new Date('2026-07-10T03:04:05.678Z');
      let capturedRequest: SocialEvaluationRequest | undefined;
      evaluateSocial.mockImplementationOnce(async (request: SocialEvaluationRequest): Promise<SocialEvaluationResult> => {
        capturedRequest = request;
        return {
          domain: 'social',
          decisionId: `eval-social-ledger-${outcome}`,
          requestId: request.requestId,
          decision: outcome,
          reason: 'ledger reason api_key=sk-social-ledger-secret qq-12345678901',
          confidence: 0.83,
          riskLevel: 'medium',
          decidedAt,
          evaluatorVersion: 'test-evaluator-ledger-v1',
          ...(outcome === 'downgrade'
            ? {
                downgradeAction: {
                  from: 'reply_full' as const,
                  to: 'reply_short' as const,
                  reason: 'Use a shorter evaluated reply',
                },
              }
            : {}),
        };
      });

      const decision = await service.createDecision({
        turnId: 'turn-social-private',
        rawEventId: 'raw-social-private',
        event: makePrivateEvent(),
        responseText: '需要结构化评估。',
        signals: {
          ...makeReplySignals(),
          classification: 'needs_evaluation',
          recommendedPath: 'risk_path',
        },
        actor: {
          canonicalUserId: 'user-social-alice',
          actorClass: 'user',
        },
      });

      expect(capturedRequest).toBeDefined();
      expect(decision.evaluatorDecisionId).toBe(`eval-social-ledger-${outcome}`);
      expect(decision.actions[0]?.type).toBe(expectedAction);

      const evaluatorRow = db.prepare(
        `SELECT id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
                evaluator_version, actor_user_id, actor_class, invocation_context,
                source_event_ids, request_created_at, decided_at
         FROM evaluator_decisions WHERE id = ?`
      ).get(`eval-social-ledger-${outcome}`) as {
        id: string;
        request_id: string;
        domain: string;
        turn_id: string;
        decision: string;
        reason: string;
        confidence: number;
        risk_level: string;
        evaluator_version: string;
        actor_user_id: string;
        actor_class: string;
        invocation_context: string;
        source_event_ids: string;
        request_created_at: number;
        decided_at: number;
      };
      const actionRow = db.prepare(
        `SELECT evaluator_decision_id, evaluator_required, evaluator_passed, actions, reasons
         FROM action_decisions WHERE id = ?`
      ).get(decision.id) as {
        evaluator_decision_id: string;
        evaluator_required: number;
        evaluator_passed: number;
        actions: string;
        reasons: string;
      };

      expect(evaluatorRow).toMatchObject({
        id: `eval-social-ledger-${outcome}`,
        request_id: capturedRequest?.requestId,
        domain: 'social',
        turn_id: 'turn-social-private',
        decision: outcome,
        confidence: 0.83,
        risk_level: 'medium',
        evaluator_version: 'test-evaluator-ledger-v1',
        actor_user_id: 'user-social-alice',
        actor_class: 'user',
        invocation_context: 'private_chat',
        request_created_at: capturedRequest?.createdAt.getTime(),
        decided_at: decidedAt.getTime(),
      });
      expect(JSON.parse(evaluatorRow.source_event_ids)).toEqual(['raw-social-private']);
      expect(evaluatorRow.reason).toContain('[REDACTED:api_key_assignment]');
      expect(evaluatorRow.reason).toContain('[REDACTED:platform_id]');
      expect(evaluatorRow.reason).not.toContain('sk-social-ledger-secret');
      expect(evaluatorRow.reason).not.toContain('12345678901');
      expect(actionRow).toMatchObject({
        evaluator_decision_id: `eval-social-ledger-${outcome}`,
        evaluator_required: 1,
        evaluator_passed: expectedPassed,
      });
      expect((JSON.parse(actionRow.actions) as Array<{ type: string }>)[0]?.type).toBe(expectedAction);
      expect(actionRow.reasons).not.toContain('sk-social-ledger-secret');
      expect(db.prepare('SELECT action_decision_id FROM agent_turns WHERE id = ?').get('turn-social-private'))
        .toEqual({ action_decision_id: decision.id });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    },
  );

  it('persists a structured model evaluator decision from a fake completion client', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        domain: 'social',
        decision: 'approve',
        reason: 'Approved by deterministic model-client fixture',
        confidence: 0.87,
        riskLevel: 'medium',
      }),
      tokens: { input: 18, output: 9, total: 27 },
    });
    const modelEvaluator = new ModelEvaluator({
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'test-only-evaluator-key',
      timeoutMs: 1_000,
      maxRetries: 0,
      temperature: 0,
      promptVersion: 'social-ledger-test-v1',
    }, { complete }, new ModelInvocationRepository(db));
    service = new SocialDecisionService(
      actionRepo,
      modelEvaluator,
      new ActionCooldownManager(),
    );

    const decision = await service.createDecision({
      turnId: 'turn-social-private',
      rawEventId: 'raw-social-private',
      event: makePrivateEvent(),
      responseText: 'This response requires structured review.',
      signals: {
        ...makeReplySignals(),
        classification: 'needs_evaluation',
        recommendedPath: 'risk_path',
      },
      actor: {
        canonicalUserId: 'user-social-alice',
        actorClass: 'user',
      },
    });

    const row = db.prepare(
      `SELECT evaluator.domain, evaluator.evaluator_version, evaluator.decision,
              evaluator.model_invocation_id, invocation.status AS invocation_status,
              action.evaluator_decision_id, action.evaluator_passed
       FROM action_decisions action
       JOIN evaluator_decisions evaluator ON evaluator.id = action.evaluator_decision_id
       JOIN model_invocations invocation ON invocation.id = evaluator.model_invocation_id
       WHERE action.id = ?`
    ).get(decision.id) as {
      domain: string;
      evaluator_version: string;
      decision: string;
      evaluator_decision_id: string;
      model_invocation_id: string;
      invocation_status: string;
      evaluator_passed: number;
    };

    expect(row).toMatchObject({
      domain: 'social',
      evaluator_version: 'openai/gpt-4/social-ledger-test-v1',
      decision: 'approve',
      evaluator_decision_id: decision.evaluatorDecisionId,
      evaluator_passed: 1,
      invocation_status: 'completed',
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects an evaluator that mutates its detached request before returning', async () => {
    evaluateSocial.mockImplementationOnce(async (request: SocialEvaluationRequest): Promise<SocialEvaluationResult> => {
      request.proposedAction.payload = { text: 'mutated evaluator request payload' };
      request.attentionSignals.triggerReasons.push('mutated_evaluator_request');
      return {
        domain: 'social',
        decisionId: 'eval-social-mutated-request',
        requestId: request.requestId,
        decision: 'approve',
        reason: 'attempted approval after mutating the request',
        confidence: 0.9,
        riskLevel: 'medium',
        decidedAt: new Date('2026-07-11T08:30:00.000Z'),
        evaluatorVersion: 'test-mutating-evaluator-v1',
      };
    });

    await expect(service.createDecision({
      turnId: 'turn-social-private',
      rawEventId: 'raw-social-private',
      event: makePrivateEvent(),
      responseText: 'Original response text',
      signals: {
        ...makeReplySignals(),
        classification: 'needs_evaluation',
        recommendedPath: 'risk_path',
      },
      actor: {
        canonicalUserId: 'user-social-alice',
        actorClass: 'user',
      },
    })).rejects.toThrow('mutated');

    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_decisions').get()).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT action_decision_id FROM agent_turns WHERE id = ?').get('turn-social-private'),
    ).toEqual({ action_decision_id: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects an evaluator downgrade that does not match the proposed action', async () => {
    evaluateSocial.mockImplementationOnce(async (request: SocialEvaluationRequest): Promise<SocialEvaluationResult> => ({
      domain: 'social',
      decisionId: 'eval-social-unmatched-downgrade',
      requestId: request.requestId,
      decision: 'downgrade',
      reason: 'attempted downgrade of another action type',
      confidence: 0.9,
      riskLevel: 'medium',
      decidedAt: new Date('2026-07-11T08:31:00.000Z'),
      evaluatorVersion: 'test-unmatched-downgrade-v1',
      downgradeAction: {
        from: 'reply_short',
        to: 'silent_store',
        reason: 'This does not match the proposed private reply',
      },
    }));

    await expect(service.createDecision({
      turnId: 'turn-social-private',
      rawEventId: 'raw-social-private',
      event: makePrivateEvent(),
      responseText: 'Original private response',
      signals: {
        ...makeReplySignals(),
        classification: 'needs_evaluation',
        recommendedPath: 'risk_path',
      },
      actor: {
        canonicalUserId: 'user-social-alice',
        actorClass: 'user',
      },
    })).rejects.toThrow('does not match the proposed action');

    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT action_decision_id FROM agent_turns WHERE id = ?').get('turn-social-private'))
      .toEqual({ action_decision_id: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts and bounds every durable copy of an oversized evaluator reason', async () => {
    const oversizedReason = [
      'api_key=sk-evaluator-oversized-secret-should-not-persist',
      'qq-12345678901',
      'x'.repeat(5000),
    ].join(' ');
    evaluateSocial.mockImplementationOnce(async (request: SocialEvaluationRequest): Promise<SocialEvaluationResult> => ({
      domain: 'social',
      decisionId: 'eval-social-oversized-reason',
      requestId: request.requestId,
      decision: 'reject',
      reason: oversizedReason,
      confidence: 0.82,
      riskLevel: 'medium',
      decidedAt: new Date('2026-07-10T03:05:06.789Z'),
      evaluatorVersion: 'test-evaluator-oversized-v1',
    }));

    const decision = await service.createDecision({
      turnId: 'turn-social-private',
      rawEventId: 'raw-social-private',
      event: makePrivateEvent(),
      responseText: 'This response will be rejected.',
      signals: {
        ...makeReplySignals(),
        classification: 'needs_evaluation',
        recommendedPath: 'risk_path',
      },
      actor: {
        canonicalUserId: 'user-social-alice',
        actorClass: 'user',
      },
    });

    const evaluatorRow = db.prepare(
      'SELECT reason FROM evaluator_decisions WHERE id = ?'
    ).get('eval-social-oversized-reason') as { reason: string };
    const actionRow = db.prepare(
      'SELECT actions, reasons FROM action_decisions WHERE id = ?'
    ).get(decision.id) as { actions: string; reasons: string };
    const storedReasons = JSON.parse(actionRow.reasons) as string[];
    const storedActions = JSON.parse(actionRow.actions) as Array<{ reason: string }>;
    const evaluatorActionReason = storedActions[0]?.reason ?? '';
    const evaluatorDecisionReason = storedReasons.find((reason) => reason.startsWith('evaluator:')) ?? '';

    for (const value of [evaluatorRow.reason, evaluatorActionReason, evaluatorDecisionReason]) {
      expect(value.length).toBeLessThanOrEqual(2048);
      expect(value).toContain('[REDACTED:api_key_assignment]');
      expect(value).toContain('[REDACTED:platform_id]');
      expect(value).not.toContain('sk-evaluator-oversized');
      expect(value).not.toContain('12345678901');
    }
    expect(evaluatorRow.reason).toContain('[TRUNCATED]');
    expect(evaluatorActionReason).toContain('[TRUNCATED]');
    expect(evaluatorDecisionReason).toContain('[TRUNCATED]');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('anchors evaluator-modified private reply targets to the local platform and canonical identities', async () => {
    evaluateSocial.mockImplementationOnce(asyncModifiedActionWithSpoofedTarget());

    const decision = await service.createDecision({
      turnId: 'turn-social-private',
      rawEventId: 'raw-social-private',
      event: makePrivateEvent(),
      responseText: '需要评估器改写。',
      signals: {
        ...makeReplySignals(),
        classification: 'needs_evaluation',
      },
      actor: {
        canonicalUserId: 'user-social-alice',
        actorClass: 'user',
      },
    });

    expect(evaluateSocial).toHaveBeenCalledTimes(1);
    expect(decision.actions[0]).toMatchObject({
      type: 'reply_with_tool',
      payload: { text: '评估器只应修改文本和动作类型。' },
      target: {
        conversationId: 'private:qq-10008',
        conversationType: 'private',
        userId: 'qq-10008',
        canonicalUserId: 'user-social-alice',
      },
    });
    expect(decision.actions[0]?.target?.userId).not.toBe('qq-99999');
    expect(decision.actions[0]?.target?.canonicalUserId).not.toBe('user-social-evil');

    const row = db
      .prepare('SELECT actions FROM action_decisions WHERE id = ?')
      .get(decision.id) as { actions: string };
    const storedActions = JSON.parse(row.actions) as Array<{
      target?: {
        conversationId?: string;
        conversationType?: string;
        userId?: string;
        canonicalUserId?: string;
      };
      payload?: { text?: string };
    }>;

    expect(storedActions[0]).toMatchObject({
      payload: { text: '评估器只应修改文本和动作类型。' },
      target: {
        conversationId: 'private:qq-10008',
        conversationType: 'private',
        userId: 'qq-10008',
        canonicalUserId: 'user-social-alice',
      },
    });
    expect(storedActions[0]?.target?.userId).not.toBe('qq-99999');
    expect(storedActions[0]?.target?.canonicalUserId).not.toBe('user-social-evil');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves local group cooldown, token, and redaction constraints on evaluator-modified actions', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('raw-social-group-1', 'message.group', now, 'gateway', 'qq', 'qq-group-20008', '{}', now);
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('raw-social-group-2', 'message.group', now + 1, 'gateway', 'qq', 'qq-group-20008', '{}', now + 1);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-social-group-1', 'qq-group-20008', 'raw-social-group-1', 'mock', 'mock', 'running', now);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-social-group-2', 'qq-group-20008', 'raw-social-group-2', 'mock', 'mock', 'running', now + 1);

    evaluateSocial.mockImplementation(asyncModifiedActionWithWeakenedConstraints());
    const signals: AttentionSignals = {
      ...makeReplySignals(),
      classification: 'needs_evaluation',
      triggerReasons: ['question'],
    };

    const firstDecision = await service.createDecision({
      turnId: 'turn-social-group-1',
      rawEventId: 'raw-social-group-1',
      event: makeGroupEvent('event-social-group-1', 'qq-20051'),
      responseText: '群聊评估器改写。',
      signals,
      actor: {
        canonicalUserId: 'user-social-group-sender',
        actorClass: 'user',
      },
    });
    const secondDecision = await service.createDecision({
      turnId: 'turn-social-group-2',
      rawEventId: 'raw-social-group-2',
      event: makeGroupEvent('event-social-group-2', 'qq-20052'),
      responseText: '群聊评估器再次改写。',
      signals,
      actor: {
        canonicalUserId: 'user-social-group-sender-2',
        actorClass: 'user',
      },
    });

    expect(evaluateSocial).toHaveBeenCalledTimes(2);
    expect(firstDecision.actions[0]).toMatchObject({
      type: 'reply_with_tool',
      target: {
        conversationId: 'qq-group-20008',
        conversationType: 'group',
        groupId: 'qq-group-20008',
      },
      constraints: {
        evaluatorRequired: true,
        proactive: true,
        cooldownKey: 'group:qq-group-20008:reply_short',
        cooldownSeconds: 60,
        maxResponseTokens: 256,
        redactionLevel: 'strict',
        capabilities: ['tool:summary'],
      },
    });
    expect(firstDecision.actions[0]?.target?.canonicalUserId).toBeUndefined();
    expect(secondDecision.actions[0]).toMatchObject({
      type: 'silent_store',
      target: {
        conversationId: 'qq-group-20008',
        conversationType: 'group',
        groupId: 'qq-group-20008',
      },
    });
    expect(secondDecision.suppressors).toContain('cooldown:group:qq-group-20008:reply_short');

    const firstRow = db
      .prepare('SELECT actions FROM action_decisions WHERE id = ?')
      .get(firstDecision.id) as { actions: string };
    const secondRow = db
      .prepare('SELECT actions, suppressors FROM action_decisions WHERE id = ?')
      .get(secondDecision.id) as { actions: string; suppressors: string };
    const firstStoredActions = JSON.parse(firstRow.actions) as StoredAction[];
    const secondStoredActions = JSON.parse(secondRow.actions) as StoredAction[];
    const storedSuppressors = JSON.parse(secondRow.suppressors) as string[];

    expect(firstStoredActions[0]).toMatchObject({
      type: 'reply_with_tool',
      constraints: {
        evaluatorRequired: true,
        proactive: true,
        cooldownKey: 'group:qq-group-20008:reply_short',
        cooldownSeconds: 60,
        maxResponseTokens: 256,
        redactionLevel: 'strict',
        capabilities: ['tool:summary'],
      },
    });
    expect(secondStoredActions[0]).toMatchObject({
      type: 'silent_store',
      constraints: {
        evaluatorRequired: true,
        cooldownKey: 'group:qq-group-20008:reply_short',
        cooldownSeconds: 60,
        maxResponseTokens: 256,
        redactionLevel: 'strict',
      },
    });
    expect(storedSuppressors).toContain('cooldown:group:qq-group-20008:reply_short');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves local group cooldown when evaluator downgrade suggests a shorter cooldown', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('raw-social-group-downgrade-1', 'message.group', now, 'gateway', 'qq', 'qq-group-20008', '{}', now);
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('raw-social-group-downgrade-2', 'message.group', now + 1, 'gateway', 'qq', 'qq-group-20008', '{}', now + 1);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-social-group-downgrade-1', 'qq-group-20008', 'raw-social-group-downgrade-1', 'mock', 'mock', 'running', now);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-social-group-downgrade-2', 'qq-group-20008', 'raw-social-group-downgrade-2', 'mock', 'mock', 'running', now + 1);

    evaluateSocial.mockImplementation(asyncDowngradeActionWithZeroCooldown());
    const signals: AttentionSignals = {
      ...makeReplySignals(),
      classification: 'needs_evaluation',
      triggerReasons: ['question'],
    };

    const firstDecision = await service.createDecision({
      turnId: 'turn-social-group-downgrade-1',
      rawEventId: 'raw-social-group-downgrade-1',
      event: makeGroupEvent('event-social-group-downgrade-1', 'qq-20061'),
      responseText: '群聊评估器降级。',
      signals,
      actor: {
        canonicalUserId: 'user-social-group-downgrade-1',
        actorClass: 'user',
      },
    });
    const secondDecision = await service.createDecision({
      turnId: 'turn-social-group-downgrade-2',
      rawEventId: 'raw-social-group-downgrade-2',
      event: makeGroupEvent('event-social-group-downgrade-2', 'qq-20062'),
      responseText: '群聊评估器再次降级。',
      signals,
      actor: {
        canonicalUserId: 'user-social-group-downgrade-2',
        actorClass: 'user',
      },
    });

    expect(evaluateSocial).toHaveBeenCalledTimes(2);
    expect(firstDecision.actions[0]).toMatchObject({
      type: 'reply_with_tool',
      constraints: {
        evaluatorRequired: true,
        cooldownKey: 'group:qq-group-20008:reply_short',
        cooldownSeconds: 60,
        maxResponseTokens: 256,
        redactionLevel: 'strict',
      },
    });
    expect(firstDecision.suppressors).toContain('evaluator_downgrade:reply_short->reply_with_tool');
    expect(secondDecision.actions[0]).toMatchObject({
      type: 'silent_store',
      constraints: {
        evaluatorRequired: true,
        cooldownKey: 'group:qq-group-20008:reply_short',
        cooldownSeconds: 60,
        maxResponseTokens: 256,
        redactionLevel: 'strict',
      },
    });
    expect(secondDecision.suppressors).toContain('cooldown:group:qq-group-20008:reply_short');

    const firstRow = db
      .prepare('SELECT actions, suppressors FROM action_decisions WHERE id = ?')
      .get(firstDecision.id) as { actions: string; suppressors: string };
    const secondRow = db
      .prepare('SELECT actions, suppressors FROM action_decisions WHERE id = ?')
      .get(secondDecision.id) as { actions: string; suppressors: string };
    const firstStoredActions = JSON.parse(firstRow.actions) as StoredAction[];
    const secondStoredActions = JSON.parse(secondRow.actions) as StoredAction[];
    const firstStoredSuppressors = JSON.parse(firstRow.suppressors) as string[];
    const secondStoredSuppressors = JSON.parse(secondRow.suppressors) as string[];

    expect(firstStoredActions[0]?.constraints?.cooldownSeconds).toBe(60);
    expect(firstStoredSuppressors).toContain('evaluator_downgrade:reply_short->reply_with_tool');
    expect(secondStoredActions[0]?.type).toBe('silent_store');
    expect(secondStoredActions[0]?.constraints?.cooldownSeconds).toBe(60);
    expect(secondStoredSuppressors).toContain('cooldown:group:qq-group-20008:reply_short');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it.each([
    { label: 'exact @bot', triggerReason: '@bot' as const },
    { label: 'reply-to-bot', triggerReason: 'reply_to_bot' as const },
    { label: 'command', triggerReason: 'command' as const },
  ])('bypasses an active group cooldown for a $label trigger after evaluator modification', async ({
    triggerReason,
  }) => {
    const suffix = triggerReason.replace(/[^a-z]+/gi, '-');
    const now = Date.now();
    const firstRawEventId = `raw-social-strong-${suffix}-1`;
    const secondRawEventId = `raw-social-strong-${suffix}-2`;
    const firstTurnId = `turn-social-strong-${suffix}-1`;
    const secondTurnId = `turn-social-strong-${suffix}-2`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(firstRawEventId, 'message.group', now, 'gateway', 'qq', 'qq-group-20008', '{}', now);
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(secondRawEventId, 'message.group', now + 1, 'gateway', 'qq', 'qq-group-20008', '{}', now + 1);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(firstTurnId, 'qq-group-20008', firstRawEventId, 'mock', 'mock', 'running', now);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(secondTurnId, 'qq-group-20008', secondRawEventId, 'mock', 'mock', 'running', now + 1);

    evaluateSocial.mockImplementation(asyncModifiedActionWithWeakenedConstraints());
    const ordinaryDecision = await service.createDecision({
      turnId: firstTurnId,
      rawEventId: firstRawEventId,
      event: makeGroupEvent(`event-social-strong-${suffix}-1`, `qq-strong-${suffix}-1`),
      responseText: '普通群聊评估器改写。',
      signals: {
        ...makeReplySignals(),
        classification: 'needs_evaluation',
        triggerReasons: ['question'],
      },
      actor: {
        canonicalUserId: `user-social-strong-${suffix}-1`,
        actorClass: 'user',
      },
    });
    const strongDecision = await service.createDecision({
      turnId: secondTurnId,
      rawEventId: secondRawEventId,
      event: makeGroupEvent(
        `event-social-strong-${suffix}-2`,
        `qq-strong-${suffix}-2`,
        triggerReason,
      ),
      responseText: '强触发群聊评估器改写。',
      signals: {
        ...makeReplySignals(),
        classification: 'needs_evaluation',
        triggerReasons: [triggerReason],
      },
      actor: {
        canonicalUserId: `user-social-strong-${suffix}-2`,
        actorClass: 'user',
      },
    });

    expect(ordinaryDecision.actions[0]?.constraints.cooldownSeconds).toBe(60);
    expect(strongDecision.actions[0]).toMatchObject({
      type: 'reply_with_tool',
      constraints: {
        cooldownKey: 'group:qq-group-20008:reply_short',
        cooldownSeconds: 0,
      },
    });
    expect(strongDecision.suppressors).not.toContain(
      'cooldown:group:qq-group-20008:reply_short',
    );

    const stored = db.prepare(
      'SELECT actions, suppressors FROM action_decisions WHERE id = ?'
    ).get(strongDecision.id) as { actions: string; suppressors: string };
    const storedActions = JSON.parse(stored.actions) as StoredAction[];
    const storedSuppressors = JSON.parse(stored.suppressors) as string[];
    expect(storedActions[0]?.constraints?.cooldownSeconds).toBe(0);
    expect(storedSuppressors).not.toContain('cooldown:group:qq-group-20008:reply_short');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves an evaluator-added cooldown for a strong trigger when a cooldown is active', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-social-strong-evaluator-cooldown',
      'message.group',
      now,
      'gateway',
      'qq',
      'qq-group-20008',
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-social-strong-evaluator-cooldown',
      'qq-group-20008',
      'raw-social-strong-evaluator-cooldown',
      'mock',
      'mock',
      'running',
      now,
    );
    cooldowns.apply([{
      type: 'reply_short',
      priority: 100,
      target: {
        conversationId: 'qq-group-20008',
        conversationType: 'group',
        groupId: 'qq-group-20008',
      },
      payload: { text: 'seed active cooldown' },
      constraints: {
        cooldownKey: 'group:qq-group-20008:reply_short',
        cooldownSeconds: 60,
      },
      reason: 'Seed active cooldown for evaluator authority test',
    }]);
    evaluateSocial.mockImplementationOnce(asyncModifiedActionWithStricterCooldown());

    const decision = await service.createDecision({
      turnId: 'turn-social-strong-evaluator-cooldown',
      rawEventId: 'raw-social-strong-evaluator-cooldown',
      event: makeGroupEvent(
        'event-social-strong-evaluator-cooldown',
        'qq-strong-evaluator-cooldown',
        '@bot',
      ),
      responseText: '评估器要求更严格冷却。',
      signals: {
        ...makeReplySignals(),
        classification: 'needs_evaluation',
        triggerReasons: ['@bot'],
      },
      actor: {
        canonicalUserId: 'user-social-strong-evaluator-cooldown',
        actorClass: 'user',
      },
    });

    expect(decision.actions[0]).toMatchObject({
      type: 'silent_store',
      constraints: {
        cooldownKey: 'group:qq-group-20008:reply_short',
        cooldownSeconds: 120,
      },
    });
    expect(decision.suppressors).toContain('cooldown:group:qq-group-20008:reply_short');

    const stored = db.prepare(
      'SELECT actions, suppressors FROM action_decisions WHERE id = ?'
    ).get(decision.id) as { actions: string; suppressors: string };
    const storedActions = JSON.parse(stored.actions) as StoredAction[];
    const storedSuppressors = JSON.parse(stored.suppressors) as string[];
    expect(storedActions[0]?.constraints?.cooldownSeconds).toBe(120);
    expect(storedSuppressors).toContain('cooldown:group:qq-group-20008:reply_short');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});

interface StoredAction {
  type?: string;
  target?: {
    conversationId?: string;
    conversationType?: string;
    userId?: string;
    canonicalUserId?: string;
    groupId?: string;
  };
  constraints?: {
    evaluatorRequired?: boolean;
    cooldownKey?: string;
    cooldownSeconds?: number;
    maxResponseTokens?: number;
    redactionLevel?: string;
    capabilities?: string[];
  };
}

function asyncModifiedActionWithSpoofedTarget(): (request: SocialEvaluationRequest) => Promise<SocialEvaluationResult> {
  return async (request: SocialEvaluationRequest): Promise<SocialEvaluationResult> => ({
    domain: 'social',
    decisionId: 'eval-social-spoofed-target',
    requestId: request.requestId,
    decision: 'approve',
    reason: 'approved with modified text',
    confidence: 0.91,
    riskLevel: 'medium',
    decidedAt: new Date(),
    evaluatorVersion: 'test-evaluator',
    modifiedAction: {
      ...request.proposedAction,
      type: 'reply_with_tool',
      target: {
        conversationId: 'private:qq-99999',
        conversationType: 'private',
        userId: 'qq-99999',
        canonicalUserId: 'user-social-evil',
      },
      payload: { text: '评估器只应修改文本和动作类型。' },
      reason: 'Evaluator modified delivery text',
    },
  });
}

function asyncModifiedActionWithWeakenedConstraints(): (request: SocialEvaluationRequest) => Promise<SocialEvaluationResult> {
  return async (request: SocialEvaluationRequest): Promise<SocialEvaluationResult> => ({
    domain: 'social',
    decisionId: `eval-social-weakened-constraints-${request.requestId}`,
    requestId: request.requestId,
    decision: 'approve',
    reason: 'approved with weakened local constraints',
    confidence: 0.92,
    riskLevel: 'medium',
    decidedAt: new Date(),
    evaluatorVersion: 'test-evaluator',
    modifiedAction: {
      ...request.proposedAction,
      type: 'reply_with_tool',
      payload: { text: '评估器改写群聊回复。' },
      constraints: {
        evaluatorRequired: false,
        cooldownKey: undefined,
        cooldownSeconds: 0,
        maxResponseTokens: 4096,
        redactionLevel: 'none',
        capabilities: ['tool:summary'],
      },
      reason: 'Evaluator modified action while weakening constraints',
    },
  });
}

function asyncModifiedActionWithStricterCooldown(): (request: SocialEvaluationRequest) => Promise<SocialEvaluationResult> {
  return async (request: SocialEvaluationRequest): Promise<SocialEvaluationResult> => ({
    domain: 'social',
    decisionId: `eval-social-stricter-cooldown-${request.requestId}`,
    requestId: request.requestId,
    decision: 'approve',
    reason: 'approved with a stricter evaluator cooldown',
    confidence: 0.92,
    riskLevel: 'medium',
    decidedAt: new Date(),
    evaluatorVersion: 'test-evaluator',
    modifiedAction: {
      ...request.proposedAction,
      type: 'reply_with_tool',
      constraints: {
        ...request.proposedAction.constraints,
        cooldownSeconds: 120,
      },
      reason: 'Evaluator added a stricter cooldown',
    },
  });
}

function asyncDowngradeActionWithZeroCooldown(): (request: SocialEvaluationRequest) => Promise<SocialEvaluationResult> {
  return async (request: SocialEvaluationRequest): Promise<SocialEvaluationResult> => ({
    domain: 'social',
    decisionId: `eval-social-downgrade-zero-cooldown-${request.requestId}`,
    requestId: request.requestId,
    decision: 'downgrade',
    reason: 'downgrade with attempted cooldown removal',
    confidence: 0.9,
    riskLevel: 'medium',
    decidedAt: new Date(),
    evaluatorVersion: 'test-evaluator',
    downgradeAction: {
      from: 'reply_short',
      to: 'reply_with_tool',
      reason: 'Evaluator downgraded action but suggested no cooldown',
    },
    cooldownSeconds: 0,
  });
}

function makeReplySignals(): AttentionSignals {
  return {
    classification: 'needs_response',
    triggerScore: 0.9,
    triggerReasons: ['private_message'],
    suppressors: [],
    recommendedPath: 'reply_fast_path',
  };
}

function makePrivateEvent(): ChatMessageReceived {
  return {
    id: 'event-social-private',
    type: 'chat.message.received',
    timestamp: new Date(),
    source: 'gateway',
    platform: 'qq',
    conversationId: 'private:qq-10008',
    message: {
      messageId: 'qq-12352',
      conversationId: 'private:qq-10008',
      conversationType: 'private',
      senderId: 'qq-10008',
      content: {
        text: '请回复我',
      },
      mentions: [],
      mentionsBot: false,
    },
    gatewayCapabilities: {
      platform: 'qq',
      reactions: {
        emojiLike: false,
        faceMessage: true,
      },
      foldedForward: {
        groupForward: false,
        privateForward: false,
        customNode: false,
      },
      platformAdmin: {
        kick: false,
        mute: false,
        setGroupCard: false,
      },
    },
  };
}

function makeGroupEvent(
  id: string,
  messageId: string,
  strongTrigger?: '@bot' | 'reply_to_bot' | 'command',
): ChatMessageReceived {
  const replyToMessageId = strongTrigger === 'reply_to_bot' ? 'qq-bot-response' : undefined;
  return {
    id,
    type: 'chat.message.received',
    timestamp: new Date(),
    source: 'gateway',
    platform: 'qq',
    conversationId: 'qq-group-20008',
    message: {
      messageId,
      conversationId: 'qq-group-20008',
      conversationType: 'group',
      groupId: 'qq-group-20008',
      senderId: 'qq-30008',
      content: {
        text: strongTrigger === '@bot'
          ? '@bot 请回复群聊'
          : strongTrigger === 'command'
            ? '/memory list'
            : strongTrigger === 'reply_to_bot'
              ? '继续回复 bot'
              : '普通群聊问题？',
        ...(replyToMessageId
          ? {
              quote: {
                messageId: replyToMessageId,
                senderId: 'bot-self',
              },
            }
          : {}),
      },
      mentions: strongTrigger === '@bot' ? ['qq-3889000770'] : [],
      mentionsBot: strongTrigger === '@bot',
      replyToMessageId,
    },
    gatewayCapabilities: {
      platform: 'qq',
      reactions: {
        emojiLike: true,
        faceMessage: true,
      },
      foldedForward: {
        groupForward: false,
        privateForward: false,
        customNode: false,
      },
      platformAdmin: {
        kick: false,
        mute: false,
        setGroupCard: false,
      },
    },
  };
}
