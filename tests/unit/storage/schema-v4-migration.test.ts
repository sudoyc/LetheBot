import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  getSchemaVersion,
  initDatabase,
  recordSchemaVersion,
  runMigration,
  runMigrations,
} from '../../../src/storage/database.js';

const temporaryRoots: string[] = [];
const migrationDirectory = join(process.cwd(), 'migrations');

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('schema v4 evaluator correction attempts migration', () => {
  it('upgrades v3 through v6 without changing linked invocation, source, or decision rows', () => {
    const db = openDatabase();
    try {
      migrateToV3(db);
      const fixture = insertV3EvaluatorEvidence(db);

      runMigrations(db, migrationDirectory);

      expect(getSchemaVersion(db)).toBe(6);
      expect(db.prepare(
        'SELECT version, description FROM schema_version ORDER BY version',
      ).all()).toEqual([
        { version: 1, description: 'Initial schema' },
        { version: 2, description: 'Evaluator authority ownership' },
        { version: 3, description: 'Evaluator model invocations' },
        { version: 4, description: 'Evaluator correction attempts' },
        { version: 5, description: 'Delayed attention' },
        { version: 6, description: 'Group summary policy' },
      ]);
      expect(db.prepare(
        `SELECT rowid, id, call_number, status, error_code
         FROM model_invocations ORDER BY id`,
      ).all()).toEqual([
        {
          rowid: fixture.failedInvocationRowId,
          id: 'invocation-v3-failed',
          call_number: 1,
          status: 'failed',
          error_code: 'invalid_structured_output',
        },
        {
          rowid: fixture.linkedInvocationRowId,
          id: 'invocation-v3-linked',
          call_number: 1,
          status: 'completed',
          error_code: null,
        },
      ]);
      expect(db.prepare(
        'SELECT rowid, id, model_invocation_id FROM evaluator_decisions',
      ).get()).toEqual({
        rowid: fixture.decisionRowId,
        id: 'decision-v3-linked',
        model_invocation_id: 'invocation-v3-linked',
      });
      expect(db.prepare(
        `SELECT model_invocation_id, raw_event_id, source_ordinal
         FROM model_invocation_sources ORDER BY model_invocation_id`,
      ).all()).toEqual([
        {
          model_invocation_id: 'invocation-v3-failed',
          raw_event_id: 'raw-v4-evaluator',
          source_ordinal: 0,
        },
        {
          model_invocation_id: 'invocation-v3-linked',
          raw_event_id: 'raw-v4-evaluator',
          source_ordinal: 0,
        },
      ]);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('allows exactly two evaluator calls per request while preserving summary uniqueness', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      insertTurnSource(db);
      const insert = db.prepare(
        `INSERT INTO model_invocations (
          id, turn_id, purpose, evaluator_request_id, evaluator_domain,
          prompt_version, call_number, provider, model, status,
          started_at, completed_at, error_code
        ) VALUES (?, 'turn-v4-evaluator', 'evaluator', 'request-v4-evaluator',
                  'tool', 'governance-v1', ?, 'openai', 'gpt-4', ?, ?, ?, ?)`,
      );
      insert.run(
        'invocation-v4-first',
        1,
        'failed',
        1_700_000_000_001,
        1_700_000_000_002,
        'invalid_structured_output',
      );
      expect(() => insert.run(
        'invocation-v4-second',
        2,
        'running',
        1_700_000_000_003,
        null,
        null,
      )).not.toThrow();
      expect(() => insert.run(
        'invocation-v4-third',
        3,
        'running',
        1_700_000_000_004,
        null,
        null,
      )).toThrow();
      expect(() => insert.run(
        'invocation-v4-duplicate-second',
        2,
        'running',
        1_700_000_000_004,
        null,
        null,
      )).toThrow();

      const uniqueIndex = db.prepare(
        `SELECT name FROM pragma_index_list('model_invocations')
         WHERE name = 'idx_model_invocations_evaluator_request_call'`,
      ).get();
      expect(uniqueIndex).toEqual({ name: 'idx_model_invocations_evaluator_request_call' });
      expect(db.prepare(
        `SELECT name FROM pragma_index_info('idx_model_invocations_evaluator_request_call')
         ORDER BY seqno`,
      ).all()).toEqual([
        { name: 'evaluator_request_id' },
        { name: 'call_number' },
      ]);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });
});

function openDatabase(): Database.Database {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-schema-v4-'));
  temporaryRoots.push(root);
  return initDatabase({ path: join(root, 'test.db') });
}

function migrateToV3(db: Database.Database): void {
  runMigration(db, join(migrationDirectory, '001_initial_schema.sql'));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(readFileSync(
        join(migrationDirectory, '002_evaluator_authority_ownership.sql'),
        'utf8',
      ));
      recordSchemaVersion(db, 2, 'Evaluator authority ownership');
      db.exec(readFileSync(
        join(migrationDirectory, '003_evaluator_model_invocations.sql'),
        'utf8',
      ));
      recordSchemaVersion(db, 3, 'Evaluator model invocations');
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function insertTurnSource(db: Database.Database): void {
  const now = 1_700_000_000_000;
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES ('raw-v4-evaluator', 'chat.message.received', ?, 'gateway', 'qq',
              'conversation-v4-evaluator', '{}', ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO agent_turns (
      id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
    ) VALUES ('turn-v4-evaluator', 'conversation-v4-evaluator', 'raw-v4-evaluator',
              'fixture-model', 'fixture-provider', 'running', ?)`,
  ).run(now);
}

function insertV3EvaluatorEvidence(db: Database.Database): {
  failedInvocationRowId: number;
  linkedInvocationRowId: number;
  decisionRowId: number;
} {
  insertTurnSource(db);
  const insertInvocation = db.prepare(
    `INSERT INTO model_invocations (
      id, turn_id, purpose, evaluator_request_id, evaluator_domain,
      prompt_version, call_number, provider, model, status,
      started_at, completed_at, tokens_input, tokens_output, tokens_total,
      response_sha256, response_bytes, error_code
    ) VALUES (?, 'turn-v4-evaluator', 'evaluator', ?, 'tool', 'governance-v1', 1,
              'openai', 'gpt-4', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertInvocation.run(
    'invocation-v3-linked',
    'request-v3-linked',
    'completed',
    1_700_000_000_001,
    1_700_000_000_002,
    10,
    5,
    15,
    'a'.repeat(64),
    32,
    null,
  );
  insertInvocation.run(
    'invocation-v3-failed',
    'request-v3-failed',
    'failed',
    1_700_000_000_003,
    1_700_000_000_004,
    null,
    null,
    null,
    null,
    null,
    'invalid_structured_output',
  );
  const insertSource = db.prepare(
    `INSERT INTO model_invocation_sources (
      model_invocation_id, raw_event_id, source_ordinal
    ) VALUES (?, 'raw-v4-evaluator', 0)`,
  );
  insertSource.run('invocation-v3-linked');
  insertSource.run('invocation-v3-failed');
  db.prepare(
    `INSERT INTO evaluator_decisions (
      id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
      evaluator_version, model_invocation_id, actor_class, invocation_context,
      source_event_ids, request_created_at, decided_at
    ) VALUES ('decision-v3-linked', 'request-v3-linked', 'tool', 'turn-v4-evaluator',
              'approve', 'preserved', 1, 'low', 'openai/gpt-4/governance-v1',
              'invocation-v3-linked', 'user', 'private_chat',
              '["raw-v4-evaluator"]', 1700000000000, 1700000000002)`,
  ).run();
  return {
    failedInvocationRowId: db.prepare(
      "SELECT rowid FROM model_invocations WHERE id = 'invocation-v3-failed'",
    ).pluck().get() as number,
    linkedInvocationRowId: db.prepare(
      "SELECT rowid FROM model_invocations WHERE id = 'invocation-v3-linked'",
    ).pluck().get() as number,
    decisionRowId: db.prepare(
      "SELECT rowid FROM evaluator_decisions WHERE id = 'decision-v3-linked'",
    ).pluck().get() as number,
  };
}
