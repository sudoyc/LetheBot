import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { ActionRepository } from '../../../src/actions/action-repository';

describe('ActionRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: ActionRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-action-repository-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
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
      .prepare('SELECT actions, reasons, suppressors FROM action_decisions WHERE id = ?')
      .get(decision.id) as { actions: string; reasons: string; suppressors: string };
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

    const storedActions = JSON.parse(decisionRow.actions) as Array<{
      target: { conversationId: string; userId: string };
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
});
