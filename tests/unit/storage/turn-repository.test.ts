import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { TurnRepository } from '../../../src/storage/turn-repository';

describe('TurnRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: TurnRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-turn-repo-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
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
});
