import { mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backupSqliteDatabase,
  restoreSqliteDatabase,
} from '../../../src/operations/sqlite-maintenance.js';
import {
  closeDatabase,
  getSchemaVersion,
  initDatabase,
  recordSchemaVersion,
  runMigration,
  runMigrations,
} from '../../../src/storage/database.js';

const BASE_TIME = 1_700_000_000_000;
const migrationDirectory = join(process.cwd(), 'migrations');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('schema v7 Pi invocation migration', () => {
  it('preserves the v7 contract through the current schema and is zero-write when repeated', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);

      expect(getSchemaVersion(db)).toBe(8);
      expect(db.prepare(
        'SELECT version, description FROM schema_version ORDER BY version',
      ).all()).toEqual([
        { version: 1, description: 'Initial schema' },
        { version: 2, description: 'Evaluator authority ownership' },
        { version: 3, description: 'Evaluator model invocations' },
        { version: 4, description: 'Evaluator correction attempts' },
        { version: 5, description: 'Delayed attention' },
        { version: 6, description: 'Group summary policy' },
        { version: 7, description: 'Pi turn model invocations' },
        { version: 8, description: 'Memory maintenance proposals' },
      ]);

      const columns = db.prepare('PRAGMA table_info(model_invocations)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'turn_id',
        'job_attempt_id',
        'context_id',
        'purpose',
        'evaluator_request_id',
        'evaluator_domain',
        'prompt_version',
        'call_number',
        'provider',
        'model',
        'status',
        'started_at',
        'completed_at',
        'tokens_input',
        'tokens_output',
        'tokens_total',
        'tokens_cache_read',
        'tokens_cache_write',
        'tokens_reasoning',
        'response_sha256',
        'response_bytes',
        'error_code',
      ]);
      expect(db.prepare(
        `SELECT name FROM pragma_index_list('model_invocations')
          WHERE name = 'idx_model_invocations_pi_turn_call'`,
      ).get()).toEqual({ name: 'idx_model_invocations_pi_turn_call' });
      expect(db.prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'trigger'
            AND name = 'trg_require_running_pi_turn_invocation'`,
      ).get()).toEqual({ name: 'trg_require_running_pi_turn_invocation' });

      const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
      runMigrations(db, migrationDirectory);
      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('upgrades populated v6 rows without changing rowids or relationships', () => {
    const db = openDatabase();
    try {
      migrateToV6(db);
      const fixture = insertV6Evidence(db);

      runMigrations(db, migrationDirectory);

      expect(getSchemaVersion(db)).toBe(8);
      expect(db.prepare(
        `SELECT rowid, id, turn_id, job_attempt_id, context_id, purpose,
                call_number, status, tokens_input, tokens_output, tokens_total,
                tokens_cache_read, tokens_cache_write, tokens_reasoning
           FROM model_invocations ORDER BY rowid`,
      ).all()).toEqual([
        {
          rowid: fixture.summaryRowId,
          id: 'invocation-v6-summary',
          turn_id: null,
          job_attempt_id: 'attempt-v6-summary',
          context_id: 'context-v6-summary',
          purpose: 'summary',
          call_number: 1,
          status: 'completed',
          tokens_input: 10,
          tokens_output: 5,
          tokens_total: 15,
          tokens_cache_read: null,
          tokens_cache_write: null,
          tokens_reasoning: null,
        },
        {
          rowid: fixture.evaluatorRowId,
          id: 'invocation-v6-evaluator',
          turn_id: 'turn-v6-evaluator',
          job_attempt_id: null,
          context_id: null,
          purpose: 'evaluator',
          call_number: 1,
          status: 'completed',
          tokens_input: 12,
          tokens_output: 4,
          tokens_total: 16,
          tokens_cache_read: null,
          tokens_cache_write: null,
          tokens_reasoning: null,
        },
      ]);
      expect(db.prepare(
        `SELECT rowid, model_invocation_id, raw_event_id, source_ordinal
           FROM model_invocation_sources ORDER BY model_invocation_id, source_ordinal`,
      ).all()).toEqual(fixture.sourceRows);
      expect(db.prepare(
        `SELECT rowid, id, model_invocation_id
           FROM evaluator_decisions WHERE id = 'decision-v6-evaluator'`,
      ).get()).toEqual({
        rowid: fixture.decisionRowId,
        id: 'decision-v6-evaluator',
        model_invocation_id: 'invocation-v6-evaluator',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_policies').get())
        .toEqual({ count: 0 });
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('restores an immutable populated v6 snapshot after a v7 candidate migration', async () => {
    const root = createTemporaryRoot();
    mkdirSync(join(root, 'shared'), { recursive: true });
    mkdirSync(join(root, 'backup'), { recursive: true });
    const databasePath = join(root, 'shared', 'lethebot.db');
    const backupPath = join(root, 'backup', 'v6.db');
    const source = initDatabase({ path: databasePath });
    try {
      migrateToV6(source);
      insertV6Evidence(source);

      const backup = await backupSqliteDatabase({ sourcePath: databasePath, backupPath });
      expect(backup).toMatchObject({ integrityOk: true, remainingPages: 0 });
    } finally {
      closeDatabase(source);
    }

    const candidate = initDatabase({ path: databasePath });
    try {
      runMigrations(candidate, migrationDirectory);
      expect(getSchemaVersion(candidate)).toBe(8);
    } finally {
      closeDatabase(candidate);
    }

    const restored = restoreSqliteDatabase({
      backupPath,
      targetPath: databasePath,
      overwrite: true,
    });
    expect(restored).toMatchObject({ integrityOk: true, foreignKeyViolations: 0 });

    const rolledBack = initDatabase({ path: databasePath, readonly: true });
    try {
      expect(getSchemaVersion(rolledBack)).toBe(6);
      expect(rolledBack.prepare(
        `SELECT id FROM model_invocations
          WHERE id IN ('invocation-v6-summary', 'invocation-v6-evaluator')
          ORDER BY id`,
      ).all()).toEqual([
        { id: 'invocation-v6-evaluator' },
        { id: 'invocation-v6-summary' },
      ]);
      expect(rolledBack.prepare('PRAGMA table_info(model_invocations)').all())
        .not.toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'tokens_cache_read' }),
        ]));
      expect(rolledBack.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(rolledBack.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(rolledBack);
    }
  });

  it('stores known and unknown Pi usage, preserves source order, and isolates call ordinals per turn', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      seedRawEvent(db, 'raw-v7-usage');
      seedTurn(db, 'turn-v7-usage', 'running', 'raw-v7-usage');
      seedRawEvent(db, 'raw-v7-usage-2');

      insertPiInvocation(db, {
        id: 'invocation-v7-known',
        turnId: 'turn-v7-usage',
        callNumber: 1,
        status: 'completed',
        completedAt: BASE_TIME + 30,
        tokensInput: 20,
        tokensOutput: 7,
        tokensTotal: 27,
        tokensCacheRead: 4,
        tokensCacheWrite: 2,
        tokensReasoning: null,
      });
      insertSource(db, 'invocation-v7-known', 'raw-v7-usage', 0);
      insertSource(db, 'invocation-v7-known', 'raw-v7-usage-2', 1);

      insertPiInvocation(db, {
        id: 'invocation-v7-unknown',
        turnId: 'turn-v7-usage',
        callNumber: 2,
        status: 'completed',
        completedAt: BASE_TIME + 40,
        tokensInput: null,
        tokensOutput: null,
        tokensTotal: null,
        tokensCacheRead: null,
        tokensCacheWrite: null,
        tokensReasoning: null,
      });
      insertSource(db, 'invocation-v7-unknown', 'raw-v7-usage', 0);

      expect(db.prepare(
        `SELECT id, tokens_input, tokens_output, tokens_total,
                tokens_cache_read, tokens_cache_write, tokens_reasoning
           FROM model_invocations ORDER BY id`,
      ).all()).toEqual([
        {
          id: 'invocation-v7-known',
          tokens_input: 20,
          tokens_output: 7,
          tokens_total: 27,
          tokens_cache_read: 4,
          tokens_cache_write: 2,
          tokens_reasoning: null,
        },
        {
          id: 'invocation-v7-unknown',
          tokens_input: null,
          tokens_output: null,
          tokens_total: null,
          tokens_cache_read: null,
          tokens_cache_write: null,
          tokens_reasoning: null,
        },
      ]);
      expect(db.prepare(
        `SELECT raw_event_id, source_ordinal
           FROM model_invocation_sources
          WHERE model_invocation_id = 'invocation-v7-known'
          ORDER BY source_ordinal`,
      ).all()).toEqual([
        { raw_event_id: 'raw-v7-usage', source_ordinal: 0 },
        { raw_event_id: 'raw-v7-usage-2', source_ordinal: 1 },
      ]);

      expect(() => insertPiInvocation(db, {
        id: 'invocation-v7-duplicate-call',
        turnId: 'turn-v7-usage',
        callNumber: 1,
        status: 'running',
      })).toThrow();

      seedRawEvent(db, 'raw-v7-other');
      seedTurn(db, 'turn-v7-other', 'running', 'raw-v7-other');
      expect(() => insertPiInvocation(db, {
        id: 'invocation-v7-other-turn-call-one',
        turnId: 'turn-v7-other',
        callNumber: 1,
        status: 'running',
      })).not.toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects invalid owners, ordinals, source links, token shapes, and terminal shapes atomically', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      seedRawEvent(db, 'raw-v7-invalid');
      seedTurn(db, 'turn-v7-running', 'running', 'raw-v7-invalid');
      seedTurn(db, 'turn-v7-pending', 'pending', 'raw-v7-invalid');
      seedTurn(db, 'turn-v7-completed', 'completed', 'raw-v7-invalid');
      seedJobAttempt(db, 'job-v7-owner', 'attempt-v7-owner', 'running');

      expect(() => insertPiInvocation(db, {
        id: 'invalid-owner-none',
        turnId: null,
        jobAttemptId: null,
        callNumber: 1,
        status: 'running',
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-owner-job',
        turnId: null,
        jobAttemptId: 'attempt-v7-owner',
        callNumber: 1,
        status: 'running',
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-owner-both',
        turnId: 'turn-v7-running',
        jobAttemptId: 'attempt-v7-owner',
        callNumber: 1,
        status: 'running',
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-owner-pending',
        turnId: 'turn-v7-pending',
        callNumber: 1,
        status: 'running',
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-owner-completed',
        turnId: 'turn-v7-completed',
        callNumber: 1,
        status: 'running',
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-call-zero',
        turnId: 'turn-v7-running',
        callNumber: 0,
        status: 'running',
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-call-fraction',
        turnId: 'turn-v7-running',
        callNumber: 1.5,
        status: 'running',
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-metadata',
        turnId: 'turn-v7-running',
        callNumber: 1,
        status: 'running',
        contextId: 'context-not-allowed',
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-negative-cache',
        turnId: 'turn-v7-running',
        callNumber: 1,
        status: 'completed',
        completedAt: BASE_TIME + 10,
        tokensInput: 1,
        tokensOutput: 1,
        tokensTotal: 2,
        tokensCacheRead: -1,
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-partial-core-usage',
        turnId: 'turn-v7-running',
        callNumber: 1,
        status: 'completed',
        completedAt: BASE_TIME + 10,
        tokensInput: 1,
        tokensOutput: null,
        tokensTotal: 2,
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-completed-no-time',
        turnId: 'turn-v7-running',
        callNumber: 1,
        status: 'completed',
        tokensInput: null,
        tokensOutput: null,
        tokensTotal: null,
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-running-token',
        turnId: 'turn-v7-running',
        callNumber: 1,
        status: 'running',
        tokensInput: 1,
      })).toThrow();
      expect(() => insertPiInvocation(db, {
        id: 'invalid-failed-error',
        turnId: 'turn-v7-running',
        callNumber: 1,
        status: 'failed',
        completedAt: BASE_TIME + 10,
      })).toThrow();

      expect(() => db.transaction(() => {
        insertPiInvocation(db, {
          id: 'invalid-source-transaction',
          turnId: 'turn-v7-running',
          callNumber: 1,
          status: 'running',
        });
        insertSource(db, 'invalid-source-transaction', 'raw-v7-invalid', -1);
      })()).toThrow();
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM model_invocations
          WHERE id = 'invalid-source-transaction'`,
      ).get()).toEqual({ count: 0 });

      insertPiInvocation(db, {
        id: 'valid-source-shape',
        turnId: 'turn-v7-running',
        callNumber: 1,
        status: 'running',
      });
      insertSource(db, 'valid-source-shape', 'raw-v7-invalid', 0);
      expect(() => insertSource(db, 'valid-source-shape', 'raw-v7-invalid', 1)).toThrow();
      expect(() => insertSource(db, 'valid-source-shape', 'missing-raw-event', 1)).toThrow();
      expect(() => insertSource(db, 'valid-source-shape', 'raw-v7-invalid', -1)).toThrow();
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('aborts running Pi invocations when their exact turn becomes terminal', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      seedRawEvent(db, 'raw-v7-terminal');
      seedTurn(db, 'turn-v7-terminal', 'running', 'raw-v7-terminal');
      insertPiInvocation(db, {
        id: 'invocation-v7-terminal',
        turnId: 'turn-v7-terminal',
        callNumber: 1,
        status: 'running',
        startedAt: BASE_TIME + 100,
      });
      insertSource(db, 'invocation-v7-terminal', 'raw-v7-terminal', 0);

      db.prepare(
        `UPDATE agent_turns
            SET status = 'completed', completed_at = ?
          WHERE id = 'turn-v7-terminal'`,
      ).run(BASE_TIME + 150);

      expect(db.prepare(
        `SELECT status, completed_at, tokens_input, tokens_output, tokens_total,
                tokens_cache_read, tokens_cache_write, tokens_reasoning, error_code
           FROM model_invocations WHERE id = 'invocation-v7-terminal'`,
      ).get()).toEqual({
        status: 'aborted',
        completed_at: BASE_TIME + 150,
        tokens_input: null,
        tokens_output: null,
        tokens_total: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
        tokens_reasoning: null,
        error_code: 'turn_ended',
      });
      expect(db.prepare(
        `SELECT model_invocation_id, raw_event_id, source_ordinal
           FROM model_invocation_sources`,
      ).all()).toEqual([{
        model_invocation_id: 'invocation-v7-terminal',
        raw_event_id: 'raw-v7-terminal',
        source_ordinal: 0,
      }]);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });
});

function openDatabase(): Database.Database {
  const root = createTemporaryRoot();
  return initDatabase({ path: join(root, 'test.db') });
}

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-schema-v7-'));
  temporaryRoots.push(root);
  return root;
}

function migrateToV6(db: Database.Database): void {
  runMigration(db, join(migrationDirectory, '001_initial_schema.sql'));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const [version, fileName, description] of [
        [2, '002_evaluator_authority_ownership.sql', 'Evaluator authority ownership'],
        [3, '003_evaluator_model_invocations.sql', 'Evaluator model invocations'],
        [4, '004_evaluator_correction_attempts.sql', 'Evaluator correction attempts'],
        [5, '005_delayed_attention.sql', 'Delayed attention'],
        [6, '006_group_summary_policy.sql', 'Group summary policy'],
      ] as const) {
        db.exec(readFileSync(join(migrationDirectory, fileName), 'utf8'));
        recordSchemaVersion(db, version, description);
      }
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function insertV6Evidence(db: Database.Database): {
  summaryRowId: number;
  evaluatorRowId: number;
  decisionRowId: number;
  sourceRows: Array<{
    rowid: number;
    model_invocation_id: string;
    raw_event_id: string;
    source_ordinal: number;
  }>;
} {
  seedRawEvent(db, 'raw-v6-summary');
  seedRawEvent(db, 'raw-v6-evaluator');
  seedJobAttempt(db, 'job-v6-summary', 'attempt-v6-summary', 'completed');
  seedTurn(db, 'turn-v6-evaluator', 'completed', 'raw-v6-evaluator');
  db.prepare(
    `INSERT INTO model_contexts (
       id, job_attempt_id, purpose, conversation_ref, conversation_type,
       group_ref, candidate_memory_ids, selected_memory_ids, rejected_memories,
       filters_applied, injected_identity_fields, recent_message_ids,
       token_budget, memories, created_at
     ) VALUES ('context-v6-summary', 'attempt-v6-summary', 'summary', ?, 'private',
       NULL, '[]', '[]', '[]', '[]', '[]', '["chat-v6-summary"]', '{}', '[]', ?)`,
  ).run(`ctxref-sha256:${'a'.repeat(64)}`, BASE_TIME);
  db.prepare(
    `INSERT INTO model_invocations (
       id, job_attempt_id, context_id, purpose, call_number, provider, model,
       status, started_at, completed_at, tokens_input, tokens_output,
       tokens_total, response_sha256, response_bytes
     ) VALUES ('invocation-v6-summary', 'attempt-v6-summary', 'context-v6-summary',
       'summary', 1, 'summary-provider', 'summary-model', 'completed', ?, ?,
       10, 5, 15, ?, 8)`,
  ).run(BASE_TIME + 1, BASE_TIME + 2, 'b'.repeat(64));
  db.prepare(
    `INSERT INTO model_invocation_sources (
       model_invocation_id, raw_event_id, source_ordinal
     ) VALUES ('invocation-v6-summary', 'raw-v6-summary', 0)`,
  ).run();

  db.prepare(
    `INSERT INTO model_invocations (
       id, turn_id, purpose, evaluator_request_id, evaluator_domain,
       prompt_version, call_number, provider, model, status, started_at,
       completed_at, tokens_input, tokens_output, tokens_total,
       response_sha256, response_bytes
     ) VALUES ('invocation-v6-evaluator', 'turn-v6-evaluator', 'evaluator',
       'request-v6-evaluator', 'tool', 'evaluator-v1', 1, 'eval-provider',
       'eval-model', 'completed', ?, ?, 12, 4, 16, ?, 9)`,
  ).run(BASE_TIME + 3, BASE_TIME + 4, 'c'.repeat(64));
  db.prepare(
    `INSERT INTO model_invocation_sources (
       model_invocation_id, raw_event_id, source_ordinal
     ) VALUES ('invocation-v6-evaluator', 'raw-v6-evaluator', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO evaluator_decisions (
       id, request_id, domain, turn_id, model_invocation_id, decision, reason,
       confidence, risk_level, evaluator_version, actor_class,
       invocation_context, source_event_ids, request_created_at, decided_at
     ) VALUES ('decision-v6-evaluator', 'request-v6-evaluator', 'tool',
       'turn-v6-evaluator', 'invocation-v6-evaluator', 'approve', 'fixture', 1,
       'low', 'evaluator-v1', 'user', 'private_chat', '["raw-v6-evaluator"]',
       ?, ?)`,
  ).run(BASE_TIME + 2, BASE_TIME + 5);

  return {
    summaryRowId: db.prepare(
      `SELECT rowid FROM model_invocations WHERE id = 'invocation-v6-summary'`,
    ).pluck().get() as number,
    evaluatorRowId: db.prepare(
      `SELECT rowid FROM model_invocations WHERE id = 'invocation-v6-evaluator'`,
    ).pluck().get() as number,
    decisionRowId: db.prepare(
      `SELECT rowid FROM evaluator_decisions WHERE id = 'decision-v6-evaluator'`,
    ).pluck().get() as number,
    sourceRows: db.prepare(
      `SELECT rowid, model_invocation_id, raw_event_id, source_ordinal
         FROM model_invocation_sources ORDER BY model_invocation_id, source_ordinal`,
    ).all() as Array<{
      rowid: number;
      model_invocation_id: string;
      raw_event_id: string;
      source_ordinal: number;
    }>,
  };
}

function seedRawEvent(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO raw_events (
       id, type, timestamp, source, platform, conversation_id, payload, created_at
     ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, '{}', ?)`,
  ).run(id, BASE_TIME, `conversation:${id}`, BASE_TIME);
}

function seedTurn(
  db: Database.Database,
  id: string,
  status: 'pending' | 'running' | 'completed',
  triggerEventId: string,
): void {
  db.prepare(
    `INSERT INTO agent_turns (
       id, conversation_id, trigger_event_id, pi_model, pi_provider, status,
       started_at, completed_at
     ) VALUES (?, ?, ?, 'fixture-model', 'fixture-provider', ?, ?, ?)`,
  ).run(
    id,
    `conversation:${id}`,
    triggerEventId,
    status,
    BASE_TIME,
    status === 'completed' ? BASE_TIME + 20 : null,
  );
}

function seedJobAttempt(
  db: Database.Database,
  jobId: string,
  attemptId: string,
  status: 'running' | 'completed',
): void {
  db.prepare(
    `INSERT INTO jobs (
       id, type, payload, status, attempts, max_attempts, created_at,
       updated_at, scheduled_at, started_at, completed_at
     ) VALUES (?, 'summary', '{}', ?, 1, 3, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    status === 'running' ? 'running' : 'completed',
    BASE_TIME,
    BASE_TIME,
    BASE_TIME,
    BASE_TIME,
    status === 'completed' ? BASE_TIME + 20 : null,
  );
  db.prepare(
    `INSERT INTO job_attempts (
       id, job_id, attempt_number, worker_id, status, started_at,
       completed_at, heartbeat_at
     ) VALUES (?, ?, 1, 'fixture-worker', ?, ?, ?, ?)`,
  ).run(
    attemptId,
    jobId,
    status,
    BASE_TIME,
    status === 'completed' ? BASE_TIME + 20 : null,
    BASE_TIME,
  );
}

function insertPiInvocation(db: Database.Database, input: {
  id: string;
  turnId: string | null;
  jobAttemptId?: string | null;
  contextId?: string | null;
  callNumber: number;
  status: string;
  startedAt?: number;
  completedAt?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensTotal?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  tokensReasoning?: number | null;
  responseSha256?: string | null;
  responseBytes?: number | null;
  errorCode?: string | null;
}): void {
  db.prepare(
    `INSERT INTO model_invocations (
       id, turn_id, job_attempt_id, context_id, purpose, call_number,
       evaluator_request_id, evaluator_domain, prompt_version, provider, model,
       status, started_at, completed_at, tokens_input, tokens_output,
       tokens_total, tokens_cache_read, tokens_cache_write, tokens_reasoning,
       response_sha256, response_bytes, error_code
     ) VALUES (?, ?, ?, ?, 'pi_turn', ?, NULL, NULL, NULL, 'pi-provider',
       'pi-model', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.turnId,
    input.jobAttemptId ?? null,
    input.contextId ?? null,
    input.callNumber,
    input.status,
    input.startedAt ?? BASE_TIME + 1,
    input.completedAt ?? null,
    input.tokensInput ?? null,
    input.tokensOutput ?? null,
    input.tokensTotal ?? null,
    input.tokensCacheRead ?? null,
    input.tokensCacheWrite ?? null,
    input.tokensReasoning ?? null,
    input.responseSha256 ?? (input.status === 'completed' ? 'd'.repeat(64) : null),
    input.responseBytes ?? (input.status === 'completed' ? 8 : null),
    input.errorCode ?? null,
  );
}

function insertSource(
  db: Database.Database,
  invocationId: string,
  rawEventId: string,
  sourceOrdinal: number,
): void {
  db.prepare(
    `INSERT INTO model_invocation_sources (
       model_invocation_id, raw_event_id, source_ordinal
     ) VALUES (?, ?, ?)`,
  ).run(invocationId, rawEventId, sourceOrdinal);
}
