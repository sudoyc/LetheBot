import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigrations, closeDatabase } from '../../../src/storage/database';
import {
  ActionRepository,
  type CreateActionDecisionInput,
  type SocialEvaluatorEvidence,
} from '../../../src/actions/action-repository';

describe('ActionRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: ActionRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-action-repository-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigrations(db, join(__dirname, '../../../migrations'));
    repo = new ActionRepository(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-action-repo', 'message.private', now, 'gateway', 'qq', 'private:qq-10001', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-action-repo', 'private:qq-10001', 'evt-action-repo', 'mock', 'mock', 'running', now);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  function insertCompletedSocialInvocation(input: {
    id: string;
    requestId: string;
    sourceEventIds: string[];
    startedAt: number;
    completedAt: number;
  }): void {
    db.prepare(
      `INSERT INTO model_invocations (
        id, turn_id, job_attempt_id, context_id, purpose, evaluator_request_id,
        evaluator_domain, prompt_version, call_number, provider, model, status,
        started_at, completed_at, tokens_input, tokens_output, tokens_total,
        response_sha256, response_bytes
      ) VALUES (?, 'turn-action-repo', NULL, NULL, 'evaluator', ?, 'social',
                'social-prompt-v1', 1, 'openai', 'gpt-4', 'completed',
                ?, ?, 12, 6, 18, ?, 48)`
    ).run(input.id, input.requestId, input.startedAt, input.completedAt, 'b'.repeat(64));
    const insertSource = db.prepare(
      `INSERT INTO model_invocation_sources (
        model_invocation_id, raw_event_id, source_ordinal
      ) VALUES (?, ?, ?)`
    );
    input.sourceEventIds.forEach((sourceEventId, ordinal) => {
      insertSource.run(input.id, sourceEventId, ordinal);
    });
  }

  it('redacts sensitive action decision and execution narrative fields before durable persistence', async () => {
    const decision = await repo.createDecision({
      id: 'decision-sensitive',
      turnId: 'turn-action-repo',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: [
        'reason sk-action-repository-reason-secret-should-not-persist',
        'legacy_qq-1234567894',
      ],
      suppressors: [
        'cooldown:group:qq-group-1234567893:reply_short',
        'suppressor 1234567895',
      ],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:qq-10001',
            conversationType: 'private',
            userId: 'qq-10001',
            canonicalUserId: 'user-action-repo-legacy_qq-5566778899',
          },
          payload: {
            text: 'reply sk-action-repository-payload-secret-should-not-persist to qq-1234567890',
            metadata: {
              'key_sk-action-repository-key-secret-should-not-persist': 'api_key=sk-action-repository-nested-secret-should-not-persist',
              senderIds: [1234567891, 42],
              targetUserId: 2233445566,
              recipientGroupIds: [3344556677],
              ownerMessageId: 4455667788,
            },
          },
          constraints: {
            cooldownKey: 'group:qq-group-1234567892:reply_short',
          },
          reason: 'action reason token=sk-action-repository-action-secret-should-not-persist',
        },
      ],
    });

    const execution = await repo.createExecution({
      id: 'execution-sensitive',
      actionDecisionId: decision.id,
      actionType: 'reply_short',
      status: 'failed',
      executedMessageId: 'qq-10002',
      downgradedFrom: 'reply_full',
      downgradedReason: 'downgrade sk-action-repository-downgrade-secret-should-not-persist',
      error: {
        code: 'legacy_qq-1234567896',
        message: 'send failed sk-action-repository-error-secret-should-not-persist qq-1234567897',
        recoverable: true,
      },
      auditLevel: 'redacted_full',
      auditEntry: 'audit api_key=sk-action-repository-audit-secret-should-not-persist',
    });

    const decisionRow = db
      .prepare('SELECT actions, reasons, suppressors, execution_binding FROM action_decisions WHERE id = ?')
      .get(decision.id) as {
        actions: string;
        reasons: string;
        suppressors: string;
        execution_binding: string;
      };
    const executionRow = db
      .prepare(
        `SELECT executed_message_id, downgraded_reason, error_code, error_message, audit_entry
         FROM action_executions WHERE id = ?`
      )
      .get(execution.id) as {
        executed_message_id: string;
        downgraded_reason: string;
        error_code: string;
        error_message: string;
        audit_entry: string;
      };
    const serializedRows = JSON.stringify({ decisionRow, executionRow });
    const serializedExecutionResult = JSON.stringify(execution);

    expect(serializedRows).not.toContain('sk-action-repository-reason-secret-should-not-persist');
    expect(serializedRows).not.toContain('sk-action-repository-payload-secret-should-not-persist');
    expect(serializedRows).not.toContain('sk-action-repository-key-secret-should-not-persist');
    expect(serializedRows).not.toContain('sk-action-repository-nested-secret-should-not-persist');
    expect(serializedRows).not.toContain('sk-action-repository-action-secret-should-not-persist');
    expect(serializedRows).not.toContain('sk-action-repository-downgrade-secret-should-not-persist');
    expect(serializedRows).not.toContain('sk-action-repository-error-secret-should-not-persist');
    expect(serializedRows).not.toContain('sk-action-repository-audit-secret-should-not-persist');
    expect(serializedRows).not.toContain('1234567890');
    expect(serializedRows).not.toContain('1234567891');
    expect(serializedRows).not.toContain('1234567894');
    expect(serializedRows).not.toContain('1234567895');
    expect(serializedRows).not.toContain('1234567896');
    expect(serializedRows).not.toContain('1234567897');
    expect(serializedRows).not.toContain('2233445566');
    expect(serializedRows).not.toContain('3344556677');
    expect(serializedRows).not.toContain('4455667788');
    expect(serializedRows).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedRows).toContain('[REDACTED:api_key_assignment]');
    expect(serializedRows).toContain('[REDACTED:token_assignment]');
    expect(serializedRows).toContain('[REDACTED:platform_id]');
    expect(serializedExecutionResult).not.toContain('sk-action-repository-downgrade-secret-should-not-persist');
    expect(serializedExecutionResult).not.toContain('sk-action-repository-error-secret-should-not-persist');
    expect(serializedExecutionResult).not.toContain('sk-action-repository-audit-secret-should-not-persist');
    expect(serializedExecutionResult).not.toContain('1234567896');
    expect(serializedExecutionResult).not.toContain('1234567897');
    expect(execution.downgradedReason).toBe(executionRow.downgraded_reason);
    expect(execution.error?.code).toBe(executionRow.error_code);
    expect(execution.error?.message).toBe(executionRow.error_message);
    expect(execution.auditEntry).toBe(executionRow.audit_entry);
    expect(decisionRow.execution_binding).toMatch(/^v1:[a-f0-9]{64}$/);

    const storedActions = JSON.parse(decisionRow.actions) as Array<{
      target: { conversationId: string; userId: string; canonicalUserId: string };
      payload: {
        text: string;
        metadata: {
          senderIds: unknown[];
          targetUserId: unknown;
          recipientGroupIds: unknown[];
          ownerMessageId: unknown;
        };
      };
      constraints: { cooldownKey: string };
    }>;
    const storedSuppressors = JSON.parse(decisionRow.suppressors) as string[];
    expect(storedActions[0]?.target).toMatchObject({
      conversationId: 'private:qq-10001',
      userId: 'qq-10001',
      canonicalUserId: 'user-action-repo-legacy_qq-5566778899',
    });
    expect(storedActions[0]?.payload.text).toContain('[REDACTED:openai_like_api_key]');
    expect(storedActions[0]?.payload.metadata.senderIds).toEqual(['[REDACTED:platform_id]', 42]);
    expect(storedActions[0]?.payload.metadata.targetUserId).toBe('[REDACTED:platform_id]');
    expect(storedActions[0]?.payload.metadata.recipientGroupIds).toEqual(['[REDACTED:platform_id]']);
    expect(storedActions[0]?.payload.metadata.ownerMessageId).toBe('[REDACTED:platform_id]');
    expect(storedActions[0]?.constraints.cooldownKey).toBe('group:qq-group-1234567892:reply_short');
    expect(storedSuppressors).toContain('cooldown:group:qq-group-1234567893:reply_short');
    expect(storedSuppressors).toContain('suppressor [REDACTED:platform_id]');
    expect(executionRow.executed_message_id).toBe('qq-10002');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for adjacent secret/platform action narratives before durable persistence', async () => {
    const decision = await repo.createDecision({
      id: 'decision-adjacent',
      turnId: 'turn-action-repo',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: [
        'reason sk-action-adjacent-reason-secret-should-not-persist-qq-12345678901',
      ],
      suppressors: [
        'suppressor sk-action-adjacent-suppressor-secret-should-not-persist-qq-12345678902',
      ],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:qq-10001',
            conversationType: 'private',
            userId: 'qq-10001',
          },
          payload: {
            text: 'reply sk-action-adjacent-payload-secret-should-not-persist-qq-12345678903',
            metadata: {
              'key-sk-action-adjacent-key-secret-should-not-persist-qq-12345678904': 'value',
            },
          },
          reason: 'action reason sk-action-adjacent-action-reason-secret-should-not-persist-qq-12345678905',
        },
      ],
    });

    const execution = await repo.createExecution({
      id: 'execution-adjacent',
      actionDecisionId: decision.id,
      actionType: 'reply_short',
      status: 'failed',
      downgradedReason: 'downgrade sk-action-adjacent-downgrade-secret-should-not-persist-qq-12345678906',
      error: {
        code: 'code-sk-action-adjacent-code-secret-should-not-persist-qq-12345678907',
        message: 'error sk-action-adjacent-error-secret-should-not-persist-qq-12345678908',
        recoverable: true,
      },
      auditLevel: 'redacted_full',
      auditEntry: 'audit sk-action-adjacent-audit-secret-should-not-persist-qq-12345678909',
    });

    const decisionRow = db
      .prepare('SELECT actions, reasons, suppressors FROM action_decisions WHERE id = ?')
      .get(decision.id) as { actions: string; reasons: string; suppressors: string };
    const executionRow = db
      .prepare(
        `SELECT downgraded_reason, error_code, error_message, audit_entry
         FROM action_executions WHERE id = ?`
      )
      .get(execution.id) as {
        downgraded_reason: string;
        error_code: string;
        error_message: string;
        audit_entry: string;
      };
    const storedReasons = JSON.parse(decisionRow.reasons) as string[];
    const storedSuppressors = JSON.parse(decisionRow.suppressors) as string[];
    const storedActions = JSON.parse(decisionRow.actions) as Array<{
      payload: {
        text: string;
        metadata: Record<string, unknown>;
      };
      reason: string;
    }>;
    const metadataKey = Object.keys(storedActions[0]?.payload.metadata ?? {})[0] ?? '';
    const serializedRows = JSON.stringify({ decisionRow, executionRow });

    for (const value of [
      storedReasons[0] ?? '',
      storedSuppressors[0] ?? '',
      storedActions[0]?.payload.text ?? '',
      metadataKey,
      storedActions[0]?.reason ?? '',
      executionRow.downgraded_reason,
      executionRow.error_code,
      executionRow.error_message,
      executionRow.audit_entry,
    ]) {
      expect(value).toContain('[REDACTED:openai_like_api_key]');
      expect(value).toContain('[REDACTED:platform_id]');
    }

    expect(serializedRows).not.toContain('sk-action-adjacent');
    expect(serializedRows).not.toContain('qq-12345678901');
    expect(serializedRows).not.toContain('qq-12345678902');
    expect(serializedRows).not.toContain('qq-12345678903');
    expect(serializedRows).not.toContain('qq-12345678904');
    expect(serializedRows).not.toContain('qq-12345678905');
    expect(serializedRows).not.toContain('qq-12345678906');
    expect(serializedRows).not.toContain('qq-12345678907');
    expect(serializedRows).not.toContain('qq-12345678908');
    expect(serializedRows).not.toContain('qq-12345678909');
    expect(serializedRows).not.toContain('12345678901');
    expect(serializedRows).not.toContain('12345678902');
    expect(serializedRows).not.toContain('12345678903');
    expect(serializedRows).not.toContain('12345678904');
    expect(serializedRows).not.toContain('12345678905');
    expect(serializedRows).not.toContain('12345678906');
    expect(serializedRows).not.toContain('12345678907');
    expect(serializedRows).not.toContain('12345678908');
    expect(serializedRows).not.toContain('12345678909');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for assignment-shaped secret/platform action narratives before durable persistence', async () => {
    const decision = await repo.createDecision({
      id: 'decision-assignment-adjacent',
      turnId: 'turn-action-repo',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: [
        'reason api_key=sk-action-assignment-reason-secret-should-not-persist-qq-22334455667',
      ],
      suppressors: [
        'suppressor api_key=sk-action-assignment-suppressor-secret-should-not-persist-qq-22334455668',
      ],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:qq-10001',
            conversationType: 'private',
            userId: 'qq-10001',
          },
          payload: {
            text: 'reply api_key=sk-action-assignment-payload-secret-should-not-persist-qq-22334455669',
            metadata: {
              'key api_key=sk-action-assignment-key-secret-should-not-persist-qq-22334455670': 'value',
            },
          },
          constraints: {},
          reason: 'action reason api_key=sk-action-assignment-action-reason-secret-should-not-persist-qq-22334455671',
        },
      ],
    });

    const execution = await repo.createExecution({
      id: 'execution-assignment-adjacent',
      actionDecisionId: decision.id,
      actionType: 'reply_short',
      status: 'failed',
      downgradedReason: 'downgrade api_key=sk-action-assignment-downgrade-secret-should-not-persist-qq-22334455672',
      error: {
        code: 'code api_key=sk-action-assignment-code-secret-should-not-persist-qq-22334455673',
        message: 'error api_key=sk-action-assignment-error-secret-should-not-persist-qq-22334455674',
        recoverable: true,
      },
      auditLevel: 'redacted_full',
      auditEntry: 'audit api_key=sk-action-assignment-audit-secret-should-not-persist-qq-22334455675',
    });

    const decisionRow = db
      .prepare('SELECT actions, reasons, suppressors FROM action_decisions WHERE id = ?')
      .get(decision.id) as { actions: string; reasons: string; suppressors: string };
    const executionRow = db
      .prepare(
        `SELECT downgraded_reason, error_code, error_message, audit_entry
         FROM action_executions WHERE id = ?`
      )
      .get(execution.id) as {
        downgraded_reason: string;
        error_code: string;
        error_message: string;
        audit_entry: string;
      };
    const storedReasons = JSON.parse(decisionRow.reasons) as string[];
    const storedSuppressors = JSON.parse(decisionRow.suppressors) as string[];
    const storedActions = JSON.parse(decisionRow.actions) as Array<{
      payload: {
        text: string;
        metadata: Record<string, unknown>;
      };
      reason: string;
    }>;
    const metadataKey = Object.keys(storedActions[0]?.payload.metadata ?? {})[0] ?? '';
    const serializedRows = JSON.stringify({ decisionRow, executionRow });

    for (const value of [
      storedReasons[0] ?? '',
      storedSuppressors[0] ?? '',
      storedActions[0]?.payload.text ?? '',
      metadataKey,
      storedActions[0]?.reason ?? '',
      executionRow.downgraded_reason,
      executionRow.error_code,
      executionRow.error_message,
      executionRow.audit_entry,
    ]) {
      expect(value).toContain('[REDACTED:api_key_assignment]');
      expect(value).toContain('[REDACTED:platform_id]');
    }

    expect(serializedRows).not.toContain('sk-action-assignment');
    expect(serializedRows).not.toContain('qq-22334455667');
    expect(serializedRows).not.toContain('qq-22334455668');
    expect(serializedRows).not.toContain('qq-22334455669');
    expect(serializedRows).not.toContain('qq-22334455670');
    expect(serializedRows).not.toContain('qq-22334455671');
    expect(serializedRows).not.toContain('qq-22334455672');
    expect(serializedRows).not.toContain('qq-22334455673');
    expect(serializedRows).not.toContain('qq-22334455674');
    expect(serializedRows).not.toContain('qq-22334455675');
    expect(serializedRows).not.toContain('22334455667');
    expect(serializedRows).not.toContain('22334455668');
    expect(serializedRows).not.toContain('22334455669');
    expect(serializedRows).not.toContain('22334455670');
    expect(serializedRows).not.toContain('22334455671');
    expect(serializedRows).not.toContain('22334455672');
    expect(serializedRows).not.toContain('22334455673');
    expect(serializedRows).not.toContain('22334455674');
    expect(serializedRows).not.toContain('22334455675');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('keeps non-evaluated action decisions valid with a null evaluator link', async () => {
    const decision = await repo.createDecision({
      id: 'decision-without-evaluator',
      turnId: 'turn-action-repo',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: ['ordinary reply'],
      suppressors: [],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          constraints: {},
          reason: 'ordinary reply',
        },
      ],
    });

    expect(decision.evaluatorDecisionId).toBeUndefined();
    expect(
      db.prepare('SELECT evaluator_decision_id FROM action_decisions WHERE id = ?').get(decision.id)
    ).toEqual({ evaluator_decision_id: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('atomically links exact completed Provider evidence to a social action decision', async () => {
    const turnStartedAt = db.prepare(
      'SELECT started_at FROM agent_turns WHERE id = ?'
    ).pluck().get('turn-action-repo') as number;
    const requestCreatedAt = new Date(turnStartedAt + 1);
    const decidedAt = new Date(turnStartedAt + 4);
    const action = {
      type: 'reply_full' as const,
      priority: 100,
      constraints: { evaluatorRequired: true },
      reason: 'evaluated reply',
    };
    insertCompletedSocialInvocation({
      id: 'invocation-social-provider-link',
      requestId: 'request-social-provider-link',
      sourceEventIds: ['evt-action-repo'],
      startedAt: turnStartedAt + 2,
      completedAt: turnStartedAt + 3,
    });

    const decision = await repo.createDecision({
      id: 'decision-social-provider-link',
      turnId: 'turn-action-repo',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.86,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['evaluated reply'],
      suppressors: [],
      actions: [action],
      evaluatorEvidence: {
        request: {
          requestId: 'request-social-provider-link',
          domain: 'social',
          turnId: 'turn-action-repo',
          actor: { canonicalUserId: 'user-social-provider-link', actorClass: 'user' },
          context: 'private_chat',
          sourceEventIds: ['evt-action-repo'],
          contextSummary: 'bounded context',
          createdAt: requestCreatedAt,
          proposedAction: action,
          attentionSignals: {
            classification: 'needs_evaluation',
            triggerScore: 0.8,
            triggerReasons: ['direct_question'],
            suppressors: [],
            recommendedPath: 'risk_path',
          },
          isProactive: false,
        },
        result: {
          decisionId: 'evaluator-social-provider-link',
          requestId: 'request-social-provider-link',
          domain: 'social',
          decision: 'approve',
          reason: 'approved',
          confidence: 0.86,
          riskLevel: 'medium',
          decidedAt,
          evaluatorVersion: 'openai/gpt-4/social-prompt-v1',
          modelInvocationId: 'invocation-social-provider-link',
        },
      },
    });

    expect(db.prepare(
      'SELECT model_invocation_id FROM evaluator_decisions WHERE id = ?'
    ).get(decision.evaluatorDecisionId)).toEqual({
      model_invocation_id: 'invocation-social-provider-link',
    });
    expect(repo.assertExecutionBinding(decision)).toMatchObject({
      turnId: 'turn-action-repo',
      triggerEventId: 'evt-action-repo',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it.each([
    {
      label: 'evaluator decision source',
      input: { decidedBy: 'evaluator' },
    },
    {
      label: 'passing evaluator flag',
      input: { evaluatorPassed: true },
    },
    {
      label: 'complete bare approval state',
      input: {
        decidedBy: 'evaluator',
        evaluatorRequired: true,
        evaluatorPassed: true,
        actionEvaluatorRequired: true,
      },
    },
  ] as const)('rejects evidence-free $label before persistence', async ({ label, input }) => {
    const id = `decision-missing-evidence-${label.replaceAll(' ', '-')}`;
    const createInput: CreateActionDecisionInput = {
      id,
      turnId: 'turn-action-repo',
      decidedBy: input.decidedBy ?? 'pi',
      riskLevel: 'medium',
      confidence: 0.8,
      evaluatorRequired: input.evaluatorRequired ?? false,
      evaluatorPassed: input.evaluatorPassed,
      reasons: ['authority must be traceable'],
      suppressors: [],
      actions: [
        {
          type: 'reply_full',
          priority: 100,
          constraints: {
            evaluatorRequired: input.actionEvaluatorRequired,
          },
          reason: 'attempted evidence-free authority',
        },
      ],
    };

    await expect(repo.createDecision(createInput)).rejects.toThrow('evaluator evidence');

    expect(
      db.prepare('SELECT COUNT(*) AS count FROM action_decisions WHERE id = ?').get(id),
    ).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get()).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT action_decision_id FROM agent_turns WHERE id = ?').get('turn-action-repo'),
    ).toEqual({ action_decision_id: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rolls back evaluator evidence when the linked action decision insert fails', async () => {
    const requestCreatedAt = new Date('2026-07-10T02:03:04.000Z');
    const decidedAt = new Date('2026-07-10T02:03:05.000Z');
    const action = {
      type: 'reply_full' as const,
      priority: 100,
      constraints: { evaluatorRequired: true },
      reason: 'evaluated reply',
    };
    db.exec(`
      CREATE TRIGGER fail_evaluated_action_insert
      BEFORE INSERT ON action_decisions
      WHEN NEW.id = 'decision-evaluator-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'induced action decision failure');
      END;
    `);

    await expect(repo.createDecision({
      id: 'decision-evaluator-rollback',
      turnId: 'turn-action-repo',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.81,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['evaluated reply'],
      suppressors: [],
      actions: [action],
      evaluatorEvidence: {
        request: {
          requestId: 'request-evaluator-rollback',
          domain: 'social',
          turnId: 'turn-action-repo',
          actor: {
            canonicalUserId: 'user-evaluator-rollback',
            actorClass: 'user',
          },
          context: 'private_chat',
          sourceEventIds: ['evt-action-repo'],
          contextSummary: 'bounded context',
          createdAt: requestCreatedAt,
          proposedAction: action,
          attentionSignals: {
            classification: 'needs_evaluation',
            triggerScore: 0.8,
            triggerReasons: ['direct_question'],
            suppressors: [],
            recommendedPath: 'risk_path',
          },
          isProactive: false,
        },
        result: {
          decisionId: 'eval-evaluator-rollback',
          requestId: 'request-evaluator-rollback',
          domain: 'social',
          decision: 'approve',
          reason: 'approved',
          confidence: 0.81,
          riskLevel: 'medium',
          decidedAt,
          evaluatorVersion: 'test-evaluator-v1',
        },
      },
    })).rejects.toThrow('induced action decision failure');

    expect(
      db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id = ?')
        .get('eval-evaluator-rollback')
    ).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM action_decisions WHERE id = ?')
        .get('decision-evaluator-rollback')
    ).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT action_decision_id FROM agent_turns WHERE id = ?').get('turn-action-repo')
    ).toEqual({ action_decision_id: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects incoherent or untraceable evaluator evidence before persistence', async () => {
    const action = {
      type: 'reply_full' as const,
      priority: 100,
      constraints: { evaluatorRequired: true },
      reason: 'evaluated reply',
    };
    const makeEvidence = (suffix: string): SocialEvaluatorEvidence => ({
      request: {
        requestId: `request-invalid-evidence-${suffix}`,
        domain: 'social',
        turnId: 'turn-action-repo',
        actor: {
          canonicalUserId: 'user-invalid-evidence',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['evt-action-repo'],
        contextSummary: 'bounded context',
        createdAt: new Date('2026-07-10T02:04:05.000Z'),
        proposedAction: action,
        attentionSignals: {
          classification: 'needs_evaluation',
          triggerScore: 0.8,
          triggerReasons: ['direct_question'],
          suppressors: [],
          recommendedPath: 'risk_path',
        },
        isProactive: false,
      },
      result: {
        decisionId: `eval-invalid-evidence-${suffix}`,
        requestId: `request-invalid-evidence-${suffix}`,
        domain: 'social',
        decision: 'approve',
        reason: 'approved',
        confidence: 0.81,
        riskLevel: 'medium',
        decidedAt: new Date('2026-07-10T02:04:06.000Z'),
        evaluatorVersion: 'test-evaluator-v1',
      },
    });
    const cases: Array<{
      suffix: string;
      expected: string;
      changeEvidence?: (evidence: SocialEvaluatorEvidence) => SocialEvaluatorEvidence;
      input?: Partial<Parameters<ActionRepository['createDecision']>[0]>;
    }> = [
      {
        suffix: 'request-domain',
        expected: 'domain',
        changeEvidence: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            domain: 'tool',
          } as unknown as SocialEvaluatorEvidence['request'],
        }),
      },
      {
        suffix: 'result-domain',
        expected: 'domain',
        changeEvidence: (evidence) => ({
          ...evidence,
          result: {
            ...evidence.result,
            domain: 'memory',
          } as unknown as SocialEvaluatorEvidence['result'],
        }),
      },
      { suffix: 'decided-by', expected: 'decidedBy', input: { decidedBy: 'pi' } },
      { suffix: 'required', expected: 'evaluatorRequired', input: { evaluatorRequired: false } },
      { suffix: 'passed', expected: 'evaluatorPassed', input: { evaluatorPassed: false } },
      { suffix: 'risk', expected: 'riskLevel', input: { riskLevel: 'high' } },
      { suffix: 'confidence', expected: 'confidence', input: { confidence: 0.7 } },
      {
        suffix: 'action-substitution',
        expected: 'evaluator-authorized action',
        input: {
          actions: [
            {
              ...action,
              type: 'reply_short',
              reason: 'substituted after evaluator approval',
            },
          ],
        },
      },
      {
        suffix: 'passing-prohibited',
        expected: 'prohibited risk',
        changeEvidence: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, riskLevel: 'prohibited' },
        }),
        input: { riskLevel: 'prohibited' },
      },
      {
        suffix: 'fabricated-silent-store',
        expected: 'evaluator-authorized action',
        input: {
          actions: [
            {
              type: 'silent_store',
              priority: 0,
              constraints: {},
              reason: 'fabricated no-op evidence',
            },
          ],
        },
      },
      {
        suffix: 'retargeted-cooldown-suppression',
        expected: 'evaluator-authorized action',
        changeEvidence: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            proposedAction: {
              ...action,
              target: {
                conversationId: 'private:qq-10001',
                conversationType: 'private',
                userId: 'qq-10001',
              },
              constraints: {
                evaluatorRequired: true,
                cooldownKey: 'private:qq-10001:reply_full',
                cooldownSeconds: 60,
              },
            },
          },
        }),
        input: {
          suppressors: ['cooldown:private:qq-10001:reply_full'],
          actions: [
            {
              type: 'silent_store',
              priority: 100,
              target: {
                conversationId: 'private:qq-99999',
                conversationType: 'private',
                userId: 'qq-99999',
              },
              constraints: {
                evaluatorRequired: true,
                cooldownKey: 'private:qq-10001:reply_full',
                cooldownSeconds: 60,
              },
              reason: 'Downgraded from reply_full; cooldown active for reply_full',
            },
          ],
        },
      },
      {
        suffix: 'missing-downgrade-action',
        expected: 'requires a downgrade action',
        changeEvidence: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, decision: 'downgrade' },
        }),
        input: {
          actions: [{ type: 'silent_store', priority: 0, constraints: {}, reason: 'cooldown' }],
        },
      },
      {
        suffix: 'unmatched-downgrade-action',
        expected: 'does not match the proposed action',
        changeEvidence: (evidence) => ({
          ...evidence,
          result: {
            ...evidence.result,
            decision: 'downgrade',
            downgradeAction: {
              from: 'reply_short',
              to: 'silent_store',
              reason: 'mismatched downgrade',
            },
          },
        }),
        input: {
          actions: [{ type: 'silent_store', priority: 0, constraints: {}, reason: 'cooldown' }],
        },
      },
      {
        suffix: 'missing-trigger',
        expected: 'trigger event',
        changeEvidence: (evidence) => ({
          ...evidence,
          request: { ...evidence.request, sourceEventIds: [] },
        }),
      },
      {
        suffix: 'missing-source',
        expected: 'source event',
        changeEvidence: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            sourceEventIds: ['evt-action-repo', 'evt-does-not-exist'],
          },
        }),
      },
    ];

    for (const testCase of cases) {
      const initialEvidence = makeEvidence(testCase.suffix);
      const evaluatorEvidence = testCase.changeEvidence?.(initialEvidence) ?? initialEvidence;
      await expect(repo.createDecision({
        id: `decision-invalid-evidence-${testCase.suffix}`,
        turnId: 'turn-action-repo',
        decidedBy: 'evaluator',
        riskLevel: 'medium',
        confidence: 0.81,
        evaluatorRequired: true,
        evaluatorPassed: true,
        reasons: ['evaluated reply'],
        suppressors: [],
        actions: [action],
        evaluatorEvidence,
        ...testCase.input,
      })).rejects.toThrow(testCase.expected);

      expect(
        db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id = ?')
          .get(evaluatorEvidence.result.decisionId)
      ).toEqual({ count: 0 });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM action_decisions WHERE id = ?')
          .get(`decision-invalid-evidence-${testCase.suffix}`)
      ).toEqual({ count: 0 });
    }

    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('persists executed memory linkage in action execution rows and returned results', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO memory_records (
        id, scope, visibility, sensitivity, authority, kind, title, content,
        state, confidence, importance, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'mem-action-repo-link',
      'global',
      'owner_admin_only',
      'normal',
      'inferred',
      'fact',
      'Action memory link',
      'Action execution created a proposed memory',
      'proposed',
      0.8,
      0.5,
      now,
      now
    );

    const decision = await repo.createDecision({
      id: 'decision-memory-link',
      turnId: 'turn-action-repo',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: ['memory proposal'],
      suppressors: [],
      actions: [
        {
          type: 'propose_memory',
          priority: 100,
          payload: {
            memoryProposal: {
              scope: 'global',
              kind: 'fact',
              title: 'Action memory link',
              content: 'Action execution created a proposed memory',
              confidence: 0.8,
              sourceContext: 'action_repository_test',
            },
          },
          constraints: {},
          reason: 'Create proposed memory',
        },
      ],
    });

    const execution = await repo.createExecution({
      id: 'execution-memory-link',
      actionDecisionId: decision.id,
      actionType: 'propose_memory',
      status: 'success',
      executedMemoryId: 'mem-action-repo-link',
      auditLevel: 'summary',
      auditEntry: 'memory_proposal_created=true',
    });

    expect(execution.executed).toEqual({
      memoryId: 'mem-action-repo-link',
    });

    const row = db
      .prepare('SELECT executed_message_id, executed_memory_id, executed_job_id FROM action_executions WHERE id = ?')
      .get(execution.id) as {
        executed_message_id: string | null;
        executed_memory_id: string;
        executed_job_id: string | null;
      };
    expect(row).toMatchObject({
      executed_message_id: null,
      executed_memory_id: 'mem-action-repo-link',
      executed_job_id: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
