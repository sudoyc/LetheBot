import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigrations, closeDatabase } from '../../../src/storage/database';
import { ModelInvocationRepository } from '../../../src/storage/model-invocation-repository';
import { TurnRepository } from '../../../src/storage/turn-repository';

describe('TurnRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: TurnRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-turn-repo-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigrations(db, join(__dirname, '../../../migrations'));
    repo = new TurnRepository(db);

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-turn-redaction',
      'message',
      1000,
      'gateway',
      'qq',
      'private:test',
      '{}',
      1000
    );
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('redacts embedded platform identifiers before persisting failed turn diagnostics', async () => {
    const embeddedPrefixedPlatformId = 'legacy_qq-1234567890';
    const embeddedNumericPlatformId = 'legacy_987654321';
    const turnId = await repo.createPending({
      id: 'turn-redaction',
      conversationId: 'private:test',
      triggerEventId: 'evt-turn-redaction',
      piModel: 'mock',
      piProvider: 'mock',
      startedAt: new Date(1000),
    });

    await repo.markFailed(
      turnId,
      `provider failed target=${embeddedPrefixedPlatformId} peer=${embeddedNumericPlatformId}`,
      new Date(2000)
    );

    const row = db
      .prepare('SELECT status, response_text, completed_at FROM agent_turns WHERE id = ?')
      .get(turnId) as {
      status: string;
      response_text: string;
      completed_at: number;
    };

    expect(row).toMatchObject({
      status: 'failed',
      completed_at: 2000,
    });
    expect(row.response_text).toContain('[REDACTED:platform_id]');
    expect(row.response_text).not.toContain(embeddedPrefixedPlatformId);
    expect(row.response_text).not.toContain(embeddedNumericPlatformId);
    expect(row.response_text).not.toContain('legacy_qq-');
    expect(row.response_text).not.toContain('1234567890');
    expect(row.response_text).not.toContain('987654321');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for adjacent secret/platform failed turn diagnostics', async () => {
    const adjacentSecretPlatform =
      'sk-turn-adjacent-secret-should-not-persist-qq-12345678911';
    const turnId = await repo.createPending({
      id: 'turn-adjacent-redaction',
      conversationId: 'private:test',
      triggerEventId: 'evt-turn-redaction',
      piModel: 'mock',
      piProvider: 'mock',
      startedAt: new Date(1000),
    });

    await repo.markFailed(
      turnId,
      `provider failed with ${adjacentSecretPlatform}`,
      new Date(2000)
    );

    const row = db
      .prepare('SELECT status, response_text, completed_at FROM agent_turns WHERE id = ?')
      .get(turnId) as {
      status: string;
      response_text: string;
      completed_at: number;
    };

    expect(row).toMatchObject({
      status: 'failed',
      completed_at: 2000,
    });
    expect(row.response_text).toContain('[REDACTED:openai_like_api_key]');
    expect(row.response_text).toContain('[REDACTED:platform_id]');
    expect(row.response_text).not.toContain('sk-turn-adjacent');
    expect(row.response_text).not.toContain('qq-12345678911');
    expect(row.response_text).not.toContain('12345678911');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for assignment-shaped adjacent failed turn diagnostics', async () => {
    const adjacentSecretPlatform =
      'sk-turn-assignment-adjacent-secret-qq-12345678911';
    const turnId = await repo.createPending({
      id: 'turn-assignment-adjacent-redaction',
      conversationId: 'private:test',
      triggerEventId: 'evt-turn-redaction',
      piModel: 'mock',
      piProvider: 'mock',
      startedAt: new Date(1000),
    });

    await repo.markFailed(
      turnId,
      `provider failed api_key=${adjacentSecretPlatform}`,
      new Date(2000)
    );

    const row = db
      .prepare('SELECT status, response_text, completed_at FROM agent_turns WHERE id = ?')
      .get(turnId) as {
      status: string;
      response_text: string;
      completed_at: number;
    };

    expect(row).toMatchObject({
      status: 'failed',
      completed_at: 2000,
    });
    expect(row.response_text).toContain('[REDACTED:api_key_assignment]');
    expect(row.response_text).toContain('[REDACTED:platform_id]');
    expect(row.response_text).not.toContain('sk-turn-assignment');
    expect(row.response_text).not.toContain('qq-12345678911');
    expect(row.response_text).not.toContain('12345678911');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('aborts only nonterminal turns linked to one trigger event and remains idempotent', async () => {
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-turn-other',
      'message',
      1000,
      'gateway',
      'qq',
      'private:other',
      '{}',
      1000,
    );

    const linkedTurnIds = [
      'turn-pending',
      'turn-running',
      'turn-completed',
      'turn-failed',
      'turn-aborted',
    ];
    for (const id of linkedTurnIds) {
      await repo.createPending({
        id,
        conversationId: 'private:test',
        triggerEventId: 'evt-turn-redaction',
        piModel: 'mock',
        piProvider: 'mock',
        startedAt: new Date(1000),
      });
    }
    await repo.createPending({
      id: 'turn-other-trigger',
      conversationId: 'private:other',
      triggerEventId: 'evt-turn-other',
      piModel: 'mock',
      piProvider: 'mock',
      startedAt: new Date(1000),
    });

    db.prepare('UPDATE agent_turns SET status = ? WHERE id = ?').run('running', 'turn-running');
    for (const status of ['completed', 'failed', 'aborted'] as const) {
      db.prepare(
        `UPDATE agent_turns
            SET status = ?, response_text = ?, completed_at = ?
          WHERE id = ?`,
      ).run(status, `preserve-${status}`, 1500, `turn-${status}`);
    }

    const reason = 'startup recovery api_key=sk-turn-abort-secret-qq-12345678911';
    expect(repo.markAbortedByTriggerEvent('evt-turn-redaction', reason, new Date(2000))).toBe(2);

    const rows = db.prepare(
      `SELECT id, status, response_text, completed_at
         FROM agent_turns
        ORDER BY id`,
    ).all() as Array<{
      id: string;
      status: string;
      response_text: string | null;
      completed_at: number | null;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const id of ['turn-pending', 'turn-running']) {
      expect(byId.get(id)).toMatchObject({ status: 'aborted', completed_at: 2000 });
      expect(byId.get(id)?.response_text).toContain('[REDACTED:api_key_assignment]');
      expect(byId.get(id)?.response_text).toContain('[REDACTED:platform_id]');
      expect(byId.get(id)?.response_text).not.toContain('sk-turn-abort-secret');
      expect(byId.get(id)?.response_text).not.toContain('12345678911');
    }
    for (const status of ['completed', 'failed', 'aborted'] as const) {
      expect(byId.get(`turn-${status}`)).toEqual({
        id: `turn-${status}`,
        status,
        response_text: `preserve-${status}`,
        completed_at: 1500,
      });
    }
    expect(byId.get('turn-other-trigger')).toEqual({
      id: 'turn-other-trigger',
      status: 'pending',
      response_text: null,
      completed_at: null,
    });

    expect(repo.markAbortedByTriggerEvent('evt-turn-redaction', 'second pass', new Date(3000))).toBe(0);
    expect(db.prepare(
      'SELECT completed_at FROM agent_turns WHERE id = ?'
    ).get('turn-running')).toEqual({ completed_at: 2000 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('aggregates known usage from every ordered Pi invocation round', async () => {
    const invocationRepo = new ModelInvocationRepository(db);
    const turnId = await repo.createPending({
      id: 'turn-ledger-known',
      conversationId: 'private:test',
      triggerEventId: 'evt-turn-redaction',
      piModel: 'ledger-model',
      piProvider: 'ledger-provider',
      startedAt: new Date(1000),
    });
    await repo.markRunning(turnId, 'context-ledger-known');

    const firstId = invocationRepo.startPiTurnInvocation({
      id: 'invocation-ledger-known-1',
      turnId,
      callNumber: 1,
      provider: 'ledger-provider',
      model: 'ledger-model',
      rawEventIds: ['evt-turn-redaction'],
      startedAt: 1100,
    });
    invocationRepo.completePiTurnInvocation(firstId, { input: 4, output: 6, total: 10 }, 'first');
    const secondId = invocationRepo.startPiTurnInvocation({
      id: 'invocation-ledger-known-2',
      turnId,
      callNumber: 2,
      provider: 'ledger-provider',
      model: 'ledger-model',
      rawEventIds: ['evt-turn-redaction'],
      startedAt: 1200,
    });
    invocationRepo.completePiTurnInvocation(secondId, { input: 2, output: 3, total: 5 }, 'second');

    repo.markCompletedFromPiInvocations(turnId, { responseText: 'final response', completedAt: new Date(2000) });

    expect(db.prepare(
      `SELECT status, response_text, tokens_input, tokens_output, tokens_total, completed_at
         FROM agent_turns WHERE id = ?`,
    ).get(turnId)).toEqual({
      status: 'completed',
      response_text: 'final response',
      tokens_input: 6,
      tokens_output: 9,
      tokens_total: 15,
      completed_at: 2000,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('persists unknown totals when any completed Pi round lacks usage', async () => {
    const invocationRepo = new ModelInvocationRepository(db);
    const turnId = await repo.createPending({
      id: 'turn-ledger-unknown',
      conversationId: 'private:test',
      triggerEventId: 'evt-turn-redaction',
      piModel: 'ledger-model',
      piProvider: 'ledger-provider',
      startedAt: new Date(1000),
    });
    await repo.markRunning(turnId, 'context-ledger-unknown');

    const firstId = invocationRepo.startPiTurnInvocation({
      id: 'invocation-ledger-unknown-1',
      turnId,
      callNumber: 1,
      provider: 'ledger-provider',
      model: 'ledger-model',
      rawEventIds: ['evt-turn-redaction'],
    });
    invocationRepo.completePiTurnInvocation(firstId, { input: 4, output: 6, total: 10 }, 'known');
    const secondId = invocationRepo.startPiTurnInvocation({
      id: 'invocation-ledger-unknown-2',
      turnId,
      callNumber: 2,
      provider: 'ledger-provider',
      model: 'ledger-model',
      rawEventIds: ['evt-turn-redaction'],
    });
    invocationRepo.completePiTurnInvocation(secondId, undefined, 'unknown');

    repo.markCompletedFromPiInvocations(turnId, { responseText: 'unknown aggregate' });

    expect(db.prepare(
      `SELECT status, tokens_input, tokens_output, tokens_total
         FROM agent_turns WHERE id = ?`,
    ).get(turnId)).toEqual({
      status: 'completed',
      tokens_input: null,
      tokens_output: null,
      tokens_total: null,
    });
  });

  it('does not fabricate totals for missing, running, failed, or aborted ledgers', async () => {
    const invocationRepo = new ModelInvocationRepository(db);
    const cases = [
      { id: 'turn-ledger-missing', prepare: () => undefined },
      {
        id: 'turn-ledger-running',
        prepare: () => {
          invocationRepo.startPiTurnInvocation({
            id: 'invocation-ledger-running',
            turnId: 'turn-ledger-running',
            callNumber: 1,
            provider: 'ledger-provider',
            model: 'ledger-model',
            rawEventIds: ['evt-turn-redaction'],
          });
        },
      },
      {
        id: 'turn-ledger-failed',
        prepare: () => {
          const id = invocationRepo.startPiTurnInvocation({
            id: 'invocation-ledger-failed',
            turnId: 'turn-ledger-failed',
            callNumber: 1,
            provider: 'ledger-provider',
            model: 'ledger-model',
            rawEventIds: ['evt-turn-redaction'],
          });
          invocationRepo.failInvocation(id, 'provider_error', 'failed');
        },
      },
      {
        id: 'turn-ledger-aborted',
        prepare: () => {
          const id = invocationRepo.startPiTurnInvocation({
            id: 'invocation-ledger-aborted',
            turnId: 'turn-ledger-aborted',
            callNumber: 1,
            provider: 'ledger-provider',
            model: 'ledger-model',
            rawEventIds: ['evt-turn-redaction'],
          });
          invocationRepo.failInvocation(id, 'turn_ended', 'aborted');
        },
      },
    ] as const;

    for (const testCase of cases) {
      const turnId = await repo.createPending({
        id: testCase.id,
        conversationId: 'private:test',
        triggerEventId: 'evt-turn-redaction',
        piModel: 'ledger-model',
        piProvider: 'ledger-provider',
        startedAt: new Date(1000),
      });
      await repo.markRunning(turnId, `context-${turnId}`);
      testCase.prepare();

      expect(() => repo.markCompletedFromPiInvocations(turnId, { responseText: 'must not complete' }))
        .toThrow();
      expect(db.prepare(
        `SELECT status, tokens_input, tokens_output, tokens_total
           FROM agent_turns WHERE id = ?`,
      ).get(turnId)).toEqual({
        status: 'running',
        tokens_input: null,
        tokens_output: null,
        tokens_total: null,
      });
    }
  });

  it('makes ledger completion idempotent and preserves local known-zero completion', async () => {
    const invocationRepo = new ModelInvocationRepository(db);
    const turnId = await repo.createPending({
      id: 'turn-ledger-repeat',
      conversationId: 'private:test',
      triggerEventId: 'evt-turn-redaction',
      piModel: 'ledger-model',
      piProvider: 'ledger-provider',
      startedAt: new Date(1000),
    });
    await repo.markRunning(turnId, 'context-ledger-repeat');
    const invocationId = invocationRepo.startPiTurnInvocation({
      id: 'invocation-ledger-repeat',
      turnId,
      callNumber: 1,
      provider: 'ledger-provider',
      model: 'ledger-model',
      rawEventIds: ['evt-turn-redaction'],
    });
    invocationRepo.completePiTurnInvocation(invocationId, { input: 1, output: 2, total: 3 }, 'round');

    repo.markCompletedFromPiInvocations(turnId, { responseText: 'first', completedAt: new Date(2000) });
    const first = db.prepare('SELECT * FROM agent_turns WHERE id = ?').get(turnId);
    repo.markCompletedFromPiInvocations(turnId, { responseText: 'second', completedAt: new Date(3000) });
    expect(db.prepare('SELECT * FROM agent_turns WHERE id = ?').get(turnId)).toEqual(first);

    const localTurnId = await repo.createPending({
      id: 'turn-local-zero',
      conversationId: 'private:test',
      triggerEventId: 'evt-turn-redaction',
      piModel: 'mock',
      piProvider: 'mock',
      startedAt: new Date(1000),
    });
    repo.markCompleted(localTurnId, {
      responseText: 'local',
      tokensUsed: { input: 0, output: 0, total: 0 },
      completedAt: new Date(2000),
    });
    expect(db.prepare(
      `SELECT status, tokens_input, tokens_output, tokens_total FROM agent_turns WHERE id = ?`,
    ).get(localTurnId)).toEqual({
      status: 'completed',
      tokens_input: 0,
      tokens_output: 0,
      tokens_total: 0,
    });
  });
});
