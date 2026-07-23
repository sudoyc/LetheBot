import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function openDatabase(): Database.Database {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-schema-v3-'));
  temporaryRoots.push(root);
  return initDatabase({ path: join(root, 'test.db') });
}

function createFailingV3MigrationDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-schema-v3-migrations-'));
  temporaryRoots.push(root);
  const directory = join(root, 'migrations');
  mkdirSync(directory);
  copyFileSync(
    join(migrationDirectory, '001_initial_schema.sql'),
    join(directory, '001_initial_schema.sql'),
  );
  copyFileSync(
    join(migrationDirectory, '002_evaluator_authority_ownership.sql'),
    join(directory, '002_evaluator_authority_ownership.sql'),
  );
  writeFileSync(
    join(directory, '003_evaluator_model_invocations.sql'),
    `CREATE TABLE partial_v3_write (value TEXT);\nSELECT missing_v3_function();\n`,
    'utf8',
  );
  copyFileSync(
    join(migrationDirectory, '004_evaluator_correction_attempts.sql'),
    join(directory, '004_evaluator_correction_attempts.sql'),
  );
  copyFileSync(
    join(migrationDirectory, '005_delayed_attention.sql'),
    join(directory, '005_delayed_attention.sql'),
  );
  copyFileSync(
    join(migrationDirectory, '006_group_summary_policy.sql'),
    join(directory, '006_group_summary_policy.sql'),
  );
  return directory;
}

function schemaSnapshot(db: Database.Database): unknown {
  return {
    ledger: db.prepare(
      'SELECT version, description, applied_at FROM schema_version ORDER BY version',
    ).all(),
    schema: db.prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    ).all(),
  };
}

function migrateToV2(db: Database.Database): void {
  runMigration(db, join(migrationDirectory, '001_initial_schema.sql'));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(readFileSync(
        join(migrationDirectory, '002_evaluator_authority_ownership.sql'),
        'utf8',
      ));
      recordSchemaVersion(db, 2, 'Evaluator authority ownership');
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function insertV2SummaryEvidence(db: Database.Database): {
  invocationRowId: number;
  evaluatorRowId: number;
} {
  const now = 1_700_000_000_000;
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES ('raw-v2-preserved', 'chat.message.received', ?, 'gateway', 'qq',
              'conversation-v2-preserved', '{}', ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id, conversation_type,
      sender_id, text, timestamp
    ) VALUES ('chat-v2-preserved', 'raw-v2-preserved', 'platform-v2-preserved',
              'conversation-v2-preserved', 'private', 'sender-v2-preserved',
              'preserved fixture', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO agent_turns (
      id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
    ) VALUES ('turn-v2-preserved', 'conversation-v2-preserved', 'raw-v2-preserved',
              'mock', 'mock', 'completed', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO evaluator_decisions (
      id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
      evaluator_version, actor_class, invocation_context, source_event_ids,
      request_created_at, decided_at
    ) VALUES ('decision-v2-preserved', 'request-v2-preserved', 'tool',
              'turn-v2-preserved', 'approve', 'preserved', 1, 'low', 'fixture-v2',
              'user', 'private_chat', '["raw-v2-preserved"]', ?, ?)`,
  ).run(now, now + 1);
  db.prepare(
    `INSERT INTO jobs (
      id, type, payload, status, attempts, max_attempts, lease_owner,
      lease_expires_at, heartbeat_at, created_at, updated_at, scheduled_at, started_at
    ) VALUES ('job-v2-preserved', 'summary', '{}', 'running', 1, 3, 'worker-v2',
              ?, ?, ?, ?, ?, ?)`,
  ).run(now + 60_000, now, now, now, now, now);
  db.prepare(
    `INSERT INTO job_attempts (
      id, job_id, attempt_number, worker_id, status, started_at, heartbeat_at
    ) VALUES ('attempt-v2-preserved', 'job-v2-preserved', 1, 'worker-v2',
              'running', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO model_contexts (
      id, job_attempt_id, purpose, conversation_ref, conversation_type, group_ref,
      candidate_memory_ids, selected_memory_ids, rejected_memories, filters_applied,
      injected_identity_fields, recent_message_ids, token_budget, memories, created_at
    ) VALUES ('context-v2-preserved', 'attempt-v2-preserved', 'summary',
              ?, 'private', NULL, '[]', '[]', '[]', '[]', '[]',
              '["chat-v2-preserved"]', '{}', '[]', ?)`,
  ).run(`ctxref-sha256:${'a'.repeat(64)}`, now);
  db.prepare(
    `INSERT INTO model_invocations (
      id, job_attempt_id, context_id, purpose, call_number, provider, model, status,
      started_at, completed_at, tokens_input, tokens_output, tokens_total,
      response_sha256, response_bytes
    ) VALUES ('invocation-v2-preserved', 'attempt-v2-preserved',
              'context-v2-preserved', 'summary', 1, 'fixture-provider', 'fixture-model',
              'completed', ?, ?, 10, 5, 15, ?, 12)`,
  ).run(now, now + 2, 'b'.repeat(64));
  db.prepare(
    `INSERT INTO model_invocation_sources (
      model_invocation_id, raw_event_id, source_ordinal
    ) VALUES ('invocation-v2-preserved', 'raw-v2-preserved', 0)`,
  ).run();

  return {
    invocationRowId: db.prepare(
      'SELECT rowid FROM model_invocations WHERE id = ?',
    ).pluck().get('invocation-v2-preserved') as number,
    evaluatorRowId: db.prepare(
      'SELECT rowid FROM evaluator_decisions WHERE id = ?',
    ).pluck().get('decision-v2-preserved') as number,
  };
}

describe('schema v3 evaluator invocation migration through the current schema', () => {
  it('upgrades v2 through v6 while preserving summary and evaluator evidence with clean foreign keys', () => {
    const db = openDatabase();
    try {
      migrateToV2(db);
      const fixture = insertV2SummaryEvidence(db);
      const v1AppliedAt = db.prepare(
        'SELECT applied_at FROM schema_version WHERE version = 1',
      ).pluck().get();
      const v2AppliedAt = db.prepare(
        'SELECT applied_at FROM schema_version WHERE version = 2',
      ).pluck().get();

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
        'SELECT applied_at FROM schema_version WHERE version = 1',
      ).pluck().get()).toBe(v1AppliedAt);
      expect(db.prepare(
        'SELECT applied_at FROM schema_version WHERE version = 2',
      ).pluck().get()).toBe(v2AppliedAt);
      expect(db.prepare(
        `SELECT rowid, turn_id, job_attempt_id, context_id, purpose,
                evaluator_request_id, evaluator_domain, prompt_version
           FROM model_invocations WHERE id = 'invocation-v2-preserved'`,
      ).get()).toEqual({
        rowid: fixture.invocationRowId,
        turn_id: null,
        job_attempt_id: 'attempt-v2-preserved',
        context_id: 'context-v2-preserved',
        purpose: 'summary',
        evaluator_request_id: null,
        evaluator_domain: null,
        prompt_version: null,
      });
      expect(db.prepare(
        `SELECT rowid, model_invocation_id
           FROM evaluator_decisions WHERE id = 'decision-v2-preserved'`,
      ).get()).toEqual({
        rowid: fixture.evaluatorRowId,
        model_invocation_id: null,
      });
      expect(db.prepare('SELECT * FROM model_invocation_sources').all()).toEqual([
        {
          model_invocation_id: 'invocation-v2-preserved',
          raw_event_id: 'raw-v2-preserved',
          source_ordinal: 0,
        },
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('enforces exact purpose metadata, owner XOR, decision linkage, and call identity', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      insertV2SummaryEvidence(db);

      const insertInvocation = db.prepare(
        `INSERT INTO model_invocations (
          id, turn_id, job_attempt_id, context_id, purpose,
          evaluator_request_id, evaluator_domain, prompt_version, call_number,
          provider, model, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture-provider', 'fixture-model',
                  'running', 1700000000100)`,
      );
      expect(() => insertInvocation.run(
        'invocation-evaluator-turn',
        'turn-v2-preserved',
        null,
        null,
        'evaluator',
        'request-evaluator-turn',
        'tool',
        'prompt-v1',
        1,
      )).not.toThrow();
      expect(() => insertInvocation.run(
        'invocation-owner-missing', null, null, null, 'evaluator',
        'request-owner-missing', 'tool', 'prompt-v1', 1,
      )).toThrow();
      expect(() => insertInvocation.run(
        'invocation-owner-both', 'turn-v2-preserved', 'attempt-v2-preserved', null,
        'evaluator', 'request-owner-both', 'memory', 'prompt-v1', 1,
      )).toThrow();
      expect(() => insertInvocation.run(
        'invocation-evaluator-context', 'turn-v2-preserved', null,
        'context-v2-preserved', 'evaluator', 'request-evaluator-context', 'tool',
        'prompt-v1', 1,
      )).toThrow();
      expect(() => insertInvocation.run(
        'invocation-evaluator-call-two', 'turn-v2-preserved', null, null,
        'evaluator', 'request-evaluator-call-two', 'tool', 'prompt-v1', 2,
      )).not.toThrow();
      expect(() => insertInvocation.run(
        'invocation-job-tool', null, 'attempt-v2-preserved', null,
        'evaluator', 'request-job-tool', 'tool', 'prompt-v1', 1,
      )).toThrow();
      expect(() => insertInvocation.run(
        'invocation-job-memory', null, 'attempt-v2-preserved', null,
        'evaluator', 'request-job-memory', 'memory', 'prompt-v1', 1,
      )).not.toThrow();
      expect(() => insertInvocation.run(
        'invocation-summary-metadata', null, 'attempt-v2-preserved',
        'context-v2-preserved', 'summary', 'request-summary-invalid', null, null, 2,
      )).toThrow();

      db.prepare(
        `UPDATE model_invocations
            SET status = 'completed', completed_at = 1700000000101,
                tokens_input = 1, tokens_output = 1, tokens_total = 2,
                response_sha256 = ?, response_bytes = 2
          WHERE id = 'invocation-evaluator-turn'`,
      ).run('c'.repeat(64));
      expect(db.prepare(
        `SELECT status FROM model_invocations
          WHERE id = 'invocation-evaluator-turn'`,
      ).get()).toEqual({ status: 'completed' });

      db.prepare(
        `INSERT INTO evaluator_decisions (
          id, request_id, domain, turn_id, model_invocation_id,
          decision, reason, confidence, risk_level, evaluator_version,
          actor_class, invocation_context, source_event_ids,
          request_created_at, decided_at
        ) VALUES ('decision-evaluator-turn', 'request-evaluator-turn', 'tool',
                  'turn-v2-preserved', 'invocation-evaluator-turn', 'approve',
                  'linked', 1, 'low', 'fixture-v3', 'user', 'private_chat',
                  '["raw-v2-preserved"]', 1700000000100, 1700000000101)`,
      ).run();
      expect(() => db.prepare(
        `INSERT INTO evaluator_decisions (
          id, request_id, domain, turn_id, model_invocation_id,
          decision, reason, confidence, risk_level, evaluator_version,
          actor_class, invocation_context, source_event_ids,
          request_created_at, decided_at
        ) VALUES ('decision-duplicate-link', 'request-duplicate-link', 'tool',
                  'turn-v2-preserved', 'invocation-evaluator-turn', 'approve',
                  'duplicate', 1, 'low', 'fixture-v3', 'user', 'private_chat',
                  '["raw-v2-preserved"]', 1700000000100, 1700000000101)`,
      ).run()).toThrow();
      expect(() => db.prepare(
        "UPDATE evaluator_decisions SET model_invocation_id = 'missing-invocation' WHERE id = 'decision-v2-preserved'",
      ).run()).toThrow();
      expect(() => db.prepare(
        "DELETE FROM model_invocations WHERE id = 'invocation-evaluator-turn'",
      ).run()).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('aborts running evaluator invocations when either exact owner becomes terminal', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      insertV2SummaryEvidence(db);
      db.prepare(
        `UPDATE agent_turns SET status = 'running', completed_at = NULL
          WHERE id = 'turn-v2-preserved'`,
      ).run();
      const insert = db.prepare(
        `INSERT INTO model_invocations (
          id, turn_id, job_attempt_id, purpose, evaluator_request_id,
          evaluator_domain, prompt_version, call_number, provider, model,
          status, started_at
        ) VALUES (?, ?, ?, 'evaluator', ?, ?, 'prompt-v1', 1,
                  'fixture-provider', 'fixture-model', 'running', 1700000000100)`,
      );
      insert.run(
        'invocation-turn-abort',
        'turn-v2-preserved',
        null,
        'request-turn-abort',
        'social',
      );
      insert.run(
        'invocation-attempt-abort',
        null,
        'attempt-v2-preserved',
        'request-attempt-abort',
        'memory',
      );

      db.prepare(
        `UPDATE agent_turns SET status = 'failed', completed_at = 1700000000200
          WHERE id = 'turn-v2-preserved'`,
      ).run();
      db.prepare(
        `UPDATE job_attempts
            SET status = 'failed', completed_at = 1700000000300,
                heartbeat_at = 1700000000300
          WHERE id = 'attempt-v2-preserved'`,
      ).run();

      expect(db.prepare(
        `SELECT id, status, error_code FROM model_invocations
          WHERE purpose = 'evaluator' ORDER BY id`,
      ).all()).toEqual([
        {
          id: 'invocation-attempt-abort',
          status: 'aborted',
          error_code: 'job_attempt_ended',
        },
        {
          id: 'invocation-turn-abort',
          status: 'aborted',
          error_code: 'turn_ended',
        },
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('rolls back all writes when v3 fails for fresh and finalized-v2 inputs', () => {
    const failingDirectory = createFailingV3MigrationDirectory();
    const freshDb = openDatabase();
    try {
      freshDb.exec(`
        CREATE TABLE preserved_fresh_probe (value TEXT NOT NULL);
        INSERT INTO preserved_fresh_probe VALUES ('unchanged');
      `);
      const before = freshDb.prepare(
        'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name',
      ).all();

      expect(() => runMigrations(freshDb, failingDirectory)).toThrow();

      expect(freshDb.prepare(
        'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name',
      ).all()).toEqual(before);
      expect(getSchemaVersion(freshDb)).toBe(0);
      expect(freshDb.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      closeDatabase(freshDb);
    }

    const v2Db = openDatabase();
    try {
      migrateToV2(v2Db);
      insertV2SummaryEvidence(v2Db);
      const before = schemaSnapshot(v2Db);

      expect(() => runMigrations(v2Db, failingDirectory)).toThrow();

      expect(schemaSnapshot(v2Db)).toEqual(before);
      expect(getSchemaVersion(v2Db)).toBe(2);
      expect(v2Db.prepare(
        "SELECT name FROM sqlite_schema WHERE name = 'partial_v3_write'",
      ).get()).toBeUndefined();
      expect(v2Db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(v2Db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(v2Db);
    }
  });
});
