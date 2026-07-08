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
});
