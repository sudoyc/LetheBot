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
import { JobRepository } from '../../../src/storage/job-repository.js';

const temporaryRoots: string[] = [];
const migrationDirectory = join(process.cwd(), 'migrations');
const initialMigration = join(migrationDirectory, '001_initial_schema.sql');

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function openDatabase(): Database.Database {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-schema-v2-'));
  temporaryRoots.push(root);
  return initDatabase({ path: join(root, 'test.db') });
}

function createSyntheticMigrationDirectory(secondMigration: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-schema-v2-migrations-'));
  temporaryRoots.push(root);
  const directory = join(root, 'migrations');
  mkdirSync(directory);
  copyFileSync(initialMigration, join(directory, '001_initial_schema.sql'));
  writeFileSync(
    join(directory, '002_evaluator_authority_ownership.sql'),
    secondMigration,
    'utf8',
  );
  copyFileSync(
    join(migrationDirectory, '003_evaluator_model_invocations.sql'),
    join(directory, '003_evaluator_model_invocations.sql'),
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

function createTurnBoundEvaluatorFixture(db: Database.Database): {
  turnId: string;
  evaluatorId: string;
  evaluatorRowId: number;
} {
  const now = Date.now();
  const turnId = 'turn-v1-preserved';
  const evaluatorId = 'evaluator-v1-preserved';
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, 'message.private', ?, 'gateway', 'qq', ?, '{}', ?)`,
  ).run('event-v1-preserved', now, 'conversation-v1-preserved', now);
  db.prepare(
    `INSERT INTO agent_turns (
      id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
    ) VALUES (?, ?, ?, 'mock', 'mock', 'running', ?)`,
  ).run(turnId, 'conversation-v1-preserved', 'event-v1-preserved', now);
  db.prepare(
    `INSERT INTO evaluator_decisions (
      id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
      evaluator_version, tool_name, actor_class, invocation_context,
      source_event_ids, request_created_at, decided_at
    ) VALUES (?, ?, 'tool', ?, 'approve', 'preserved', 0.9, 'low',
              'fixture-v1', 'memory.search', 'user', 'private_chat', ?, ?, ?)`,
  ).run(
    evaluatorId,
    'request-v1-preserved',
    turnId,
    JSON.stringify(['event-v1-preserved']),
    now,
    now + 1,
  );
  db.prepare(
    `INSERT INTO action_decisions (
      id, turn_id, decided_by, risk_level, confidence, evaluator_required,
      evaluator_passed, evaluator_decision_id, actions, created_at
    ) VALUES (?, ?, 'evaluator', 'low', 0.9, 1, 1, ?, '[]', ?)`,
  ).run('action-v1-preserved', turnId, evaluatorId, now + 2);
  db.prepare(
    `INSERT INTO tool_calls (
      id, turn_id, evaluator_decision_id, tool_name, input, output,
      requested_by, actor_class, invocation_context, status,
      secrets_redacted, created_at
    ) VALUES (?, ?, ?, 'memory.search', '{}', '{}',
              'pi', 'user', 'private_chat', 'success', 0, ?)`,
  ).run('tool-v1-preserved', turnId, evaluatorId, now + 3);
  const evaluatorRowId = db.prepare(
    'SELECT rowid FROM evaluator_decisions WHERE id = ?',
  ).pluck().get(evaluatorId) as number;
  return { turnId, evaluatorId, evaluatorRowId };
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

describe('schema v2 evaluator authority migration', () => {
  it('atomically adopts an unversioned database and creates the ordered v2 ledger', () => {
    const db = openDatabase();
    try {
      db.exec(`
        CREATE TABLE legacy_sentinel (value TEXT NOT NULL);
        INSERT INTO legacy_sentinel (value) VALUES ('preserved');
      `);

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
      expect(db.prepare('SELECT value FROM legacy_sentinel').pluck().get()).toBe('preserved');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

      const columns = db.prepare('PRAGMA table_info(evaluator_decisions)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      expect(columns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'turn_id', notnull: 0 }),
        expect.objectContaining({ name: 'job_attempt_id', notnull: 0 }),
      ]));
      expect(db.prepare('PRAGMA index_list(evaluator_decisions)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'idx_evaluator_decisions_turn' }),
          expect.objectContaining({ name: 'idx_evaluator_decisions_job_attempt' }),
          expect.objectContaining({ name: 'idx_evaluator_decisions_request', unique: 1 }),
        ]),
      );
    } finally {
      closeDatabase(db);
    }
  });

  it('upgrades v1 in place while preserving ledger time, rowid, data, and child references', () => {
    const db = openDatabase();
    try {
      runMigration(db, initialMigration);
      const fixture = createTurnBoundEvaluatorFixture(db);
      const v1AppliedAt = db.prepare(
        'SELECT applied_at FROM schema_version WHERE version = 1',
      ).pluck().get();

      runMigrations(db, migrationDirectory);

      expect(db.prepare(
        `SELECT rowid, id, turn_id, job_attempt_id
           FROM evaluator_decisions WHERE id = ?`,
      ).get(fixture.evaluatorId)).toEqual({
        rowid: fixture.evaluatorRowId,
        id: fixture.evaluatorId,
        turn_id: fixture.turnId,
        job_attempt_id: null,
      });
      expect(db.prepare(
        'SELECT evaluator_decision_id FROM action_decisions WHERE id = ?',
      ).get('action-v1-preserved')).toEqual({ evaluator_decision_id: fixture.evaluatorId });
      expect(db.prepare(
        'SELECT evaluator_decision_id FROM tool_calls WHERE id = ?',
      ).get('tool-v1-preserved')).toEqual({ evaluator_decision_id: fixture.evaluatorId });
      expect(db.prepare(
        'SELECT applied_at FROM schema_version WHERE version = 1',
      ).pluck().get()).toBe(v1AppliedAt);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('is a zero-write validation pass once schema v2 is current', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      const before = schemaSnapshot(db);
      const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

      runMigrations(db, migrationDirectory);

      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(schemaSnapshot(db)).toEqual(before);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('enforces exactly one valid turn or job-attempt owner and RESTRICT deletion', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      const turn = createTurnBoundEvaluatorFixture(db);
      const jobs = new JobRepository(db);
      const jobId = jobs.enqueue({ type: 'extraction', payload: {}, now: 100 });
      const claimed = jobs.claimNext({ workerId: 'schema-v2-test', now: 100 });
      expect(claimed?.job.id).toBe(jobId);
      const attemptId = claimed?.attemptId;
      expect(attemptId).toBeTypeOf('string');

      const insert = db.prepare(
        `INSERT INTO evaluator_decisions (
          id, request_id, domain, turn_id, job_attempt_id,
          decision, reason, confidence, risk_level, evaluator_version,
          actor_class, invocation_context, source_event_ids,
          request_created_at, decided_at
        ) VALUES (?, ?, 'memory', ?, ?, 'approve', 'test', 0.9, 'low',
                  'fixture-v2', 'system_worker', 'background_worker', '[]', 1, 2)`,
      );
      expect(() => insert.run(
        'decision-job-owned',
        'request-job-owned',
        null,
        attemptId,
      )).not.toThrow();
      expect(() => insert.run(
        'decision-owner-empty',
        'request-owner-empty',
        null,
        null,
      )).toThrow();
      expect(() => insert.run(
        'decision-owner-both',
        'request-owner-both',
        turn.turnId,
        attemptId,
      )).toThrow();
      expect(() => insert.run(
        'decision-owner-missing',
        'request-owner-missing',
        null,
        'missing-attempt',
      )).toThrow();
      expect(() => db.prepare('DELETE FROM agent_turns WHERE id = ?').run(turn.turnId)).toThrow();
      expect(() => db.prepare('DELETE FROM job_attempts WHERE id = ?').run(attemptId)).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('rolls back fresh and v1 inputs when the second migration fails', () => {
    const failingDirectory = createSyntheticMigrationDirectory(`
      CREATE TABLE partial_v2_write (value TEXT);
      INSERT INTO partial_v2_write VALUES ('must roll back');
      SELECT missing_migration_function();
    `);
    const freshDb = openDatabase();
    try {
      freshDb.exec(`
        CREATE TABLE fresh_probe (value TEXT NOT NULL);
        INSERT INTO fresh_probe VALUES ('unchanged');
      `);
      const before = freshDb.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all();

      expect(() => runMigrations(freshDb, failingDirectory)).toThrow();

      expect(freshDb.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all()).toEqual(before);
      expect(getSchemaVersion(freshDb)).toBe(0);
      expect(freshDb.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      closeDatabase(freshDb);
    }

    const db = openDatabase();
    try {
      runMigration(db, initialMigration);
      createTurnBoundEvaluatorFixture(db);
      const before = schemaSnapshot(db);

      expect(() => runMigrations(db, failingDirectory)).toThrow();

      expect(schemaSnapshot(db)).toEqual(before);
      expect(getSchemaVersion(db)).toBe(1);
      expect(db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'partial_v2_write'",
      ).get()).toBeUndefined();
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects malformed, future, and unsafe v1 metadata before migration writes', () => {
    const cases: Array<(db: Database.Database) => void> = [
      (db) => {
        db.exec(`
          CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
          INSERT INTO schema_version VALUES (2, 'gap', 1);
        `);
      },
      (db) => {
        runMigration(db, initialMigration);
        recordSchemaVersion(db, 2, 'Evaluator authority ownership');
        recordSchemaVersion(db, 3, 'Evaluator model invocations');
        recordSchemaVersion(db, 4, 'Evaluator correction attempts');
        recordSchemaVersion(db, 5, 'Delayed attention');
        recordSchemaVersion(db, 6, 'Group summary policy');
        recordSchemaVersion(db, 7, 'Future schema');
      },
      (db) => {
        runMigration(db, initialMigration);
        db.exec(`
          CREATE TRIGGER unmanaged_evaluator_trigger
          AFTER INSERT ON evaluator_decisions
          BEGIN
            SELECT 1;
          END;
        `);
      },
      (db) => {
        runMigrations(db, migrationDirectory);
        db.exec(`
          CREATE TRIGGER unmanaged_v2_evaluator_trigger
          AFTER INSERT ON evaluator_decisions
          BEGIN
            SELECT 1;
          END;
        `);
      },
    ];

    for (const arrange of cases) {
      const db = openDatabase();
      try {
        db.exec(`
          CREATE TABLE preserved_probe (value TEXT NOT NULL);
          INSERT INTO preserved_probe VALUES ('unchanged');
        `);
        arrange(db);
        const before = schemaSnapshot(db);

        expect(() => runMigrations(db, migrationDirectory)).toThrow();

        expect(schemaSnapshot(db)).toEqual(before);
        expect(db.prepare('SELECT value FROM preserved_probe').pluck().get()).toBe('unchanged');
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      } finally {
        closeDatabase(db);
      }
    }
  });

  it('rejects a v2 owner CHECK removed from DDL but retained in a SQL comment', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      const migrationSql = readFileSync(
        join(migrationDirectory, '002_evaluator_authority_ownership.sql'),
        'utf8',
      );
      const ownerCheck = `  CHECK(
    (turn_id IS NOT NULL AND job_attempt_id IS NULL)
    OR (turn_id IS NULL AND job_attempt_id IS NOT NULL)
  )`;
      const ownerConstraintBlock = `  FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE RESTRICT,

${ownerCheck}`;
      const driftedSql = migrationSql.replace(
        ownerConstraintBlock,
        `  FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE RESTRICT

  /* ${ownerCheck.trim()} */`,
      );
      expect(driftedSql).not.toBe(migrationSql);

      db.pragma('foreign_keys = OFF');
      db.exec(driftedSql);
      db.pragma('foreign_keys = ON');
      expect(() => db.prepare(
        `INSERT INTO evaluator_decisions (
          id, request_id, domain, turn_id, job_attempt_id,
          decision, reason, confidence, risk_level, evaluator_version,
          actor_class, invocation_context, source_event_ids,
          request_created_at, decided_at
        ) VALUES ('comment-drift', 'comment-drift-request', 'memory', NULL, NULL,
                  'reject', 'drift probe', 1, 'low', 'fixture',
                  'system_worker', 'background_worker', '[]', 1, 2)`,
      ).run()).not.toThrow();
      const before = schemaSnapshot(db);

      expect(() => runMigrations(db, migrationDirectory)).toThrow();

      expect(schemaSnapshot(db)).toEqual(before);
      expect(getSchemaVersion(db)).toBe(6);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });
});
