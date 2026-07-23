import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { GroupSummaryPolicyRepository } from '../../../src/storage/group-summary-policy-repository.js';
import { JobRepository } from '../../../src/storage/job-repository.js';

const BASE_TIME = 1_700_000_000_000;
const migrationDirectory = join(process.cwd(), 'migrations');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('schema v6 group summary policy migration', () => {
  it('upgrades v5 without enabling groups or changing existing jobs', () => {
    const db = openDatabase();
    try {
      migrateToV5(db);
      db.prepare(
        `INSERT INTO jobs (
           id, type, payload, status, attempts, max_attempts,
           created_at, updated_at, scheduled_at
         ) VALUES ('job-v6-preserved', 'summary', '{}', 'pending', 0, 3, ?, ?, ?)`,
      ).run(BASE_TIME, BASE_TIME, BASE_TIME);
      const preservedRowId = db.prepare(
        `SELECT rowid FROM jobs WHERE id = 'job-v6-preserved'`,
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
      expect(db.prepare('SELECT COUNT(*) FROM group_summary_policies').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM group_summary_job_bindings').pluck().get()).toBe(0);
      expect(db.prepare(
        `SELECT rowid FROM jobs WHERE id = 'job-v6-preserved'`,
      ).pluck().get()).toBe(preservedRowId);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('enforces state epochs, exact bindings, restricted deletion, and paired cancellation evidence', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);

      expect(() => insertPolicy(db, {
        groupId: ' qq-group-invalid ',
        state: 'enabled',
        generation: 1,
        eligibleAfter: BASE_TIME,
      })).toThrow();
      expect(() => insertPolicy(db, {
        groupId: 'qq-group-invalid-generation',
        state: 'enabled',
        generation: 0,
        eligibleAfter: BASE_TIME,
      })).toThrow();
      expect(() => insertPolicy(db, {
        groupId: 'qq-group-enabled-without-epoch',
        state: 'enabled',
        generation: 1,
        eligibleAfter: null,
      })).toThrow();
      expect(() => insertPolicy(db, {
        groupId: 'qq-group-disabled-with-epoch',
        state: 'disabled',
        generation: 1,
        eligibleAfter: BASE_TIME,
      })).toThrow();

      insertPolicy(db, {
        groupId: 'qq-group-alpha',
        state: 'enabled',
        generation: 3,
        eligibleAfter: BASE_TIME,
      });
      seedJob(db, 'job-summary-alpha', 'summary');
      seedJob(db, 'job-not-summary', 'retention');

      expect(() => insertBinding(db, {
        jobId: 'missing-job',
        groupId: 'qq-group-alpha',
        conversationId: 'group:alpha',
      })).toThrow();
      expect(() => insertBinding(db, {
        jobId: 'job-summary-alpha',
        groupId: 'missing-group',
        conversationId: 'group:alpha',
      })).toThrow();
      expect(() => insertBinding(db, {
        jobId: 'job-summary-alpha',
        groupId: 'qq-group-alpha',
        conversationId: ' group:alpha ',
      })).toThrow();
      expect(() => insertBinding(db, {
        jobId: 'job-summary-alpha',
        groupId: 'qq-group-alpha',
        conversationId: 'group:alpha',
        createdAt: BASE_TIME - 1,
      })).toThrow();
      expect(() => insertBinding(db, {
        jobId: 'job-summary-alpha',
        groupId: 'qq-group-alpha',
        conversationId: 'group:alpha',
        canceledAt: BASE_TIME + 1,
      })).toThrow();
      expect(() => insertBinding(db, {
        jobId: 'job-summary-alpha',
        groupId: 'qq-group-alpha',
        conversationId: 'group:alpha',
        cancellationCode: 'group_summary_policy_disabled',
      })).toThrow();
      expect(() => insertBinding(db, {
        jobId: 'job-summary-alpha',
        groupId: 'qq-group-alpha',
        conversationId: 'group:alpha',
        canceledAt: BASE_TIME + 1,
        cancellationCode: 'unsupported_code',
      })).toThrow();

      insertBinding(db, {
        jobId: 'job-summary-alpha',
        groupId: 'qq-group-alpha',
        conversationId: 'group:alpha',
      });
      expect(() => db.prepare(
        `DELETE FROM jobs WHERE id = 'job-summary-alpha'`,
      ).run()).toThrow();
      expect(() => db.prepare(
        `DELETE FROM group_summary_policies WHERE group_id = 'qq-group-alpha'`,
      ).run()).toThrow();
      db.prepare(
        `UPDATE group_summary_job_bindings
            SET canceled_at = ?, cancellation_code = 'group_summary_policy_disabled'
          WHERE job_id = 'job-summary-alpha'`,
      ).run(BASE_TIME + 1);

      expect(db.prepare(
        `SELECT group_id, conversation_id, generation, eligible_after,
                canceled_at, cancellation_code
           FROM group_summary_job_bindings`,
      ).get()).toEqual({
        group_id: 'qq-group-alpha',
        conversation_id: 'group:alpha',
        generation: 3,
        eligible_after: BASE_TIME,
        canceled_at: BASE_TIME + 1,
        cancellation_code: 'group_summary_policy_disabled',
      });
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('performs a zero-write validation pass after a fresh v6 migration', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

      runMigrations(db, migrationDirectory);

      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(getSchemaVersion(db)).toBe(6);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('backs up and restores populated v6 group summary policy state', async () => {
    const root = createTemporaryRoot();
    const sourcePath = join(root, 'source.db');
    const backupPath = join(root, 'backups', 'source-v6.backup.db');
    const restoredPath = join(root, 'restored.db');
    const source = initDatabase({ path: sourcePath });
    try {
      runMigrations(source, migrationDirectory);
      const policies = new GroupSummaryPolicyRepository(source);
      const jobs = new JobRepository(source);
      policies.setEnabled({
        groupId: 'group-backup-alpha',
        enabled: true,
        now: BASE_TIME,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-backup-owner',
          invocationContext: 'admin_cli',
        },
      });
      const jobId = jobs.enqueue({
        id: 'job-summary-backup',
        type: 'summary',
        payload: {
          conversationId: 'group:backup-alpha',
          conversationType: 'group',
          groupId: 'group-backup-alpha',
        },
        idempotencyKey: 'summary:group-backup-alpha:g1',
        maxAttempts: 4,
        scheduledAt: BASE_TIME + 20,
        now: BASE_TIME + 10,
      });
      policies.bindSummaryJob({
        jobId,
        groupId: 'group-backup-alpha',
        conversationId: 'group:backup-alpha',
        now: BASE_TIME + 10,
      });

      const backup = await backupSqliteDatabase({ sourcePath, backupPath });
      expect(backup.integrityOk).toBe(true);
      expect(backup.remainingPages).toBe(0);

      const restore = restoreSqliteDatabase({ backupPath, targetPath: restoredPath });
      expect(restore).toMatchObject({
        integrityOk: true,
        foreignKeyViolations: 0,
      });

      const restored = initDatabase({ path: restoredPath, readonly: true });
      try {
        const restoredPolicies = new GroupSummaryPolicyRepository(restored);
        const restoredJobs = new JobRepository(restored);
        expect(getSchemaVersion(restored)).toBe(6);
        expect(restoredPolicies.get('group-backup-alpha')).toEqual({
          groupId: 'group-backup-alpha',
          state: 'enabled',
          generation: 1,
          eligibleAfter: BASE_TIME + 1,
          createdAt: new Date(BASE_TIME + 1),
          updatedAt: new Date(BASE_TIME + 1),
        });
        expect(restoredJobs.findById(jobId)).toEqual({
          id: jobId,
          type: 'summary',
          payload: {
            conversationId: 'group:backup-alpha',
            conversationType: 'group',
            groupId: 'group-backup-alpha',
          },
          idempotencyKey: 'summary:group-backup-alpha:g1',
          status: 'pending',
          attempts: 0,
          maxAttempts: 4,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          heartbeatAt: undefined,
          createdAt: new Date(BASE_TIME + 10),
          updatedAt: new Date(BASE_TIME + 10),
          scheduledAt: new Date(BASE_TIME + 20),
          startedAt: undefined,
          completedAt: undefined,
          error: undefined,
          result: undefined,
        });
        expect(restoredPolicies.getBinding(jobId)).toEqual({
          jobId,
          groupId: 'group-backup-alpha',
          conversationId: 'group:backup-alpha',
          generation: 1,
          eligibleAfter: BASE_TIME + 1,
          createdAt: new Date(BASE_TIME + 10),
        });
        expect(restored.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
        expect(restored.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(restored);
      }
    } finally {
      closeDatabase(source);
    }
  });

  it('restores a pre-v6 backup after a v5 to v6 rollback rehearsal', async () => {
    const root = createTemporaryRoot();
    const databasePath = join(root, 'rollback.db');
    const backupPath = join(root, 'backups', 'pre-v6.backup.db');
    const candidate = initDatabase({ path: databasePath });
    try {
      migrateToV5(candidate);
      const jobs = new JobRepository(candidate);
      jobs.enqueue({
        id: 'job-pre-v6-sentinel',
        type: 'summary',
        payload: { marker: 'pre-v6' },
        idempotencyKey: 'pre-v6-sentinel',
        maxAttempts: 5,
        scheduledAt: BASE_TIME + 40,
        now: BASE_TIME + 30,
      });

      const backup = await backupSqliteDatabase({ sourcePath: databasePath, backupPath });
      expect(backup.integrityOk).toBe(true);

      runMigrations(candidate, migrationDirectory);
      const policies = new GroupSummaryPolicyRepository(candidate);
      policies.setEnabled({
        groupId: 'group-rollback-alpha',
        enabled: true,
        now: BASE_TIME + 50,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-rollback-owner',
          invocationContext: 'admin_cli',
        },
      });
      policies.bindSummaryJob({
        jobId: 'job-pre-v6-sentinel',
        groupId: 'group-rollback-alpha',
        conversationId: 'group:rollback-alpha',
        now: BASE_TIME + 51,
      });
      candidate.prepare(
        `UPDATE jobs SET payload = ?, updated_at = ? WHERE id = 'job-pre-v6-sentinel'`,
      ).run(JSON.stringify({ marker: 'candidate-v6' }), BASE_TIME + 60);
      expect(getSchemaVersion(candidate)).toBe(6);
      expect(policies.getBinding('job-pre-v6-sentinel')).not.toBeNull();
    } finally {
      closeDatabase(candidate);
    }

    const restore = restoreSqliteDatabase({
      backupPath,
      targetPath: databasePath,
      overwrite: true,
    });
    expect(restore).toMatchObject({
      integrityOk: true,
      foreignKeyViolations: 0,
    });

    const rolledBack = initDatabase({ path: databasePath, readonly: true });
    try {
      expect(getSchemaVersion(rolledBack)).toBe(5);
      expect(rolledBack.prepare(
        'SELECT version, description FROM schema_version ORDER BY version',
      ).all()).toEqual([
        { version: 1, description: 'Initial schema' },
        { version: 2, description: 'Evaluator authority ownership' },
        { version: 3, description: 'Evaluator model invocations' },
        { version: 4, description: 'Evaluator correction attempts' },
        { version: 5, description: 'Delayed attention' },
      ]);
      expect(rolledBack.prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table'
            AND name IN ('group_summary_policies', 'group_summary_job_bindings')
          ORDER BY name`,
      ).all()).toEqual([]);
      expect(new JobRepository(rolledBack).findById('job-pre-v6-sentinel')).toEqual({
        id: 'job-pre-v6-sentinel',
        type: 'summary',
        payload: { marker: 'pre-v6' },
        idempotencyKey: 'pre-v6-sentinel',
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        heartbeatAt: undefined,
        createdAt: new Date(BASE_TIME + 30),
        updatedAt: new Date(BASE_TIME + 30),
        scheduledAt: new Date(BASE_TIME + 40),
        startedAt: undefined,
        completedAt: undefined,
        error: undefined,
        result: undefined,
      });
      expect(rolledBack.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(rolledBack.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(rolledBack);
    }
  });
});

function openDatabase(): Database.Database {
  const root = createTemporaryRoot();
  return initDatabase({ path: join(root, 'test.db') });
}

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-schema-v6-'));
  temporaryRoots.push(root);
  return root;
}

function migrateToV5(db: Database.Database): void {
  runMigration(db, join(migrationDirectory, '001_initial_schema.sql'));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const [version, fileName, description] of [
        [2, '002_evaluator_authority_ownership.sql', 'Evaluator authority ownership'],
        [3, '003_evaluator_model_invocations.sql', 'Evaluator model invocations'],
        [4, '004_evaluator_correction_attempts.sql', 'Evaluator correction attempts'],
        [5, '005_delayed_attention.sql', 'Delayed attention'],
      ] as const) {
        db.exec(readFileSync(join(migrationDirectory, fileName), 'utf8'));
        recordSchemaVersion(db, version, description);
      }
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function insertPolicy(db: Database.Database, input: {
  groupId: string;
  state: string;
  generation: number;
  eligibleAfter: number | null;
}): void {
  db.prepare(
    `INSERT INTO group_summary_policies (
       group_id, state, generation, eligible_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.groupId,
    input.state,
    input.generation,
    input.eligibleAfter,
    BASE_TIME,
    BASE_TIME,
  );
}

function seedJob(db: Database.Database, id: string, type: string): void {
  db.prepare(
    `INSERT INTO jobs (
       id, type, payload, status, attempts, max_attempts,
       created_at, updated_at, scheduled_at
     ) VALUES (?, ?, '{}', 'pending', 0, 3, ?, ?, ?)`,
  ).run(id, type, BASE_TIME, BASE_TIME, BASE_TIME);
}

function insertBinding(db: Database.Database, input: {
  jobId: string;
  groupId: string;
  conversationId: string;
  createdAt?: number;
  canceledAt?: number;
  cancellationCode?: string;
}): void {
  db.prepare(
    `INSERT INTO group_summary_job_bindings (
       job_id, group_id, conversation_id, generation, eligible_after,
       created_at, canceled_at, cancellation_code
     ) VALUES (?, ?, ?, 3, ?, ?, ?, ?)`,
  ).run(
    input.jobId,
    input.groupId,
    input.conversationId,
    BASE_TIME,
    input.createdAt ?? BASE_TIME,
    input.canceledAt ?? null,
    input.cancellationCode ?? null,
  );
}
