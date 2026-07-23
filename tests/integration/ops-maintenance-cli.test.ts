import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../src/storage/database';
import { JobRepository } from '../../src/storage/job-repository';
import { BackgroundWorker } from '../../src/workers/background';

describe('ops maintenance CLI', () => {
  let testDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-ops-cli-'));
    dbPath = join(testDir, 'ops.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(process.cwd(), 'migrations/001_initial_schema.sql'));
  });

  afterEach(() => {
    if (db?.open) {
      closeDatabase(db);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  function reopenDb(readonly = false): void {
    if (db?.open) {
      closeDatabase(db);
    }
    db = initDatabase({ path: dbPath, readonly });
  }

  function runOps(
    args: string[],
    envOverrides: Record<string, string | undefined> = {},
  ): { stdout: string; stderr: string; status: number | null } {
    if (db?.open) {
      closeDatabase(db);
    }

    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LETHEBOT_DB_PATH: dbPath,
      LETHEBOT_TEST: 'true',
      LOG_LEVEL: 'fatal',
      ONEBOT_TRANSPORT: 'ws',
      ONEBOT_HTTP_URL: 'http://localhost:3000',
      ONEBOT_WS_URL: 'ws://localhost:3001/',
      LETHEBOT_PORT: '6700',
      ...envOverrides,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete env[key];
      }
    }

    const result = spawnSync(tsxBin, ['src/scripts/ops-maintenance.ts', ...args], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    });

    db = initDatabase({ path: dbPath });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      status: result.status,
    };
  }

  function expectSuccessfulOps(args: string[]): string {
    const result = runOps(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toBe('');
    return result.stdout;
  }

  function expectFailedOps(args: string[], expectedError: string): void {
    const result = runOps(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(expectedError);
  }

  it('runs documented backup, restore, retention, and metrics commands on a temp migrated DB', () => {
    const now = Date.UTC(2026, 6, 3);
    const old = now - 45 * 24 * 60 * 60 * 1000;
    const recent = now - 2 * 24 * 60 * 60 * 1000;
    seedOperationalRows(old, recent);
    closeDatabase(db);

    const metrics = JSON.parse(expectSuccessfulOps(['metrics', `--db=${dbPath}`])) as {
      rawEvents: { total: number };
      eventIngressReceipts: { total: number; byDisposition: Record<string, number> };
      eventProcessingAdmissions: { total: number; byState: Record<string, number> };
      chatMessages: { total: number };
      agentTurns: { total: number; byStatus: Record<string, number>; tokensTotal: number };
      contextTraces: { total: number };
      actionDecisions: { total: number; byDecidedBy: Record<string, number> };
      actionExecutions: { total: number; byStatus: Record<string, number> };
      memoryWrites: { total: number; byState: Record<string, number> };
      policyAuditEvents: { total: number; byCategory: Record<string, number> };
      toolCalls: { total: number; byStatus: Record<string, number>; secretsRedacted: number };
      jobs: {
        total: number;
        byStatus: Record<string, number>;
        pending: number;
        running: number;
        failed: number;
        expiredRunningLeases: number;
      };
      jobAttempts: { total: number; byStatus: Record<string, number> };
      workerHeartbeats: { total: number; byStatus: Record<string, number>; byWorkerType: Record<string, number> };
      eventProcessingFailures: {
        total: number;
        byStage: Record<string, number>;
        byConversationType: Record<string, number>;
      };
    };

    expect(metrics).toMatchObject({
      rawEvents: { total: 2 },
      eventIngressReceipts: { total: 0, byDisposition: {} },
      eventProcessingAdmissions: { total: 0, byState: {} },
      chatMessages: { total: 2 },
      agentTurns: { total: 1, byStatus: { completed: 1 }, tokensTotal: 7 },
      contextTraces: { total: 1 },
      actionDecisions: { total: 1, byDecidedBy: { evaluator: 1 } },
      actionExecutions: { total: 1, byStatus: { success: 1 } },
      memoryWrites: { total: 2, byState: { active: 1, deleted: 1 } },
      policyAuditEvents: { total: 2, byCategory: { system: 2 } },
      toolCalls: { total: 1, byStatus: { success: 1 }, secretsRedacted: 1 },
      jobs: {
        total: 1,
        byStatus: { running: 1 },
        pending: 0,
        running: 1,
        failed: 0,
        expiredRunningLeases: 1,
      },
      jobAttempts: { total: 1, byStatus: { running: 1 } },
      workerHeartbeats: { total: 1, byStatus: { idle: 1 }, byWorkerType: { background: 1 } },
      eventProcessingFailures: {
        total: 2,
        byStage: { pi_inference: 2 },
        byConversationType: { private: 2 },
      },
    });
    const jsonMetrics = JSON.parse(expectSuccessfulOps([
      'metrics',
      '--db',
      dbPath,
      '--format=json',
    ])) as { rawEvents: { total: number } };
    expect(jsonMetrics.rawEvents.total).toBe(2);

    const prometheusMetrics = expectSuccessfulOps(['metrics', `--db=${dbPath}`, '--format=prometheus']);
    expect(prometheusMetrics).toContain('lethebot_raw_events_total 2');
    expect(prometheusMetrics).toContain('lethebot_jobs_type_total{type="summary"} 1');
    expect(prometheusMetrics).toContain('lethebot_event_processing_failures_stage_total{stage="pi_inference"} 2');
    expect(prometheusMetrics).not.toContain('private:qq-ops');
    expect(prometheusMetrics).not.toContain('qq-ops');
    expect(prometheusMetrics).not.toContain('worker-ops');
    expect(prometheusMetrics).not.toContain('job-ops');

    const futureMetrics = JSON.parse(expectSuccessfulOps([
      'metrics',
      `--db=${dbPath}`,
      '--since=2026-07-04T00:00:00.000Z',
    ])) as {
      rawEvents: { total: number };
      jobs: { total: number };
      jobAttempts: { total: number };
      eventProcessingFailures: { total: number };
    };
    expect(futureMetrics.rawEvents.total).toBe(0);
    expect(futureMetrics.jobs.total).toBe(0);
    expect(futureMetrics.jobAttempts.total).toBe(0);
    expect(futureMetrics.eventProcessingFailures.total).toBe(0);

    const backupPath = join(testDir, 'backups', 'ops.backup.db');
    const backup = JSON.parse(expectSuccessfulOps([
      'backup',
      `--db=${dbPath}`,
      `--out=${backupPath}`,
    ])) as { integrityOk: boolean; backupSizeBytes: number; backupPath: string };
    expect(backup).toMatchObject({ integrityOk: true, backupPath });
    expect(backup.backupSizeBytes).toBeGreaterThan(0);
    expect(existsSync(backupPath)).toBe(true);

    const restoredPath = join(testDir, 'restored.db');
    const restore = JSON.parse(expectSuccessfulOps([
      'restore',
      `--backup=${backupPath}`,
      `--db=${restoredPath}`,
    ])) as {
      integrityOk: boolean;
      foreignKeyViolations: number;
      restoredSizeBytes: number;
      targetPath: string;
    };
    expect(restore).toMatchObject({
      integrityOk: true,
      foreignKeyViolations: 0,
      targetPath: restoredPath,
    });
    expect(restore.restoredSizeBytes).toBeGreaterThan(0);

    const restored = initDatabase({ path: restoredPath, readonly: true });
    try {
      expect(countRows(restored, 'raw_events')).toBe(2);
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(restored);
    }

    const retention = JSON.parse(expectSuccessfulOps([
      'retention',
      `--db=${dbPath}`,
      '--raw-days=30',
      '--chat-days=30',
      '--audit-days=30',
      '--memory-days=30',
      '--event-failure-days=30',
    ])) as {
      result: {
        rawEventsDeleted: number;
        modelInvocationSourcesDeleted: number;
        chatMessagesDeleted: number;
        auditLogDeleted: number;
        eventProcessingFailuresDeleted: number;
        memoriesPurged: number;
        memorySourcesDeleted: number;
        memoryRevisionsDeleted: number;
      };
    };
    expect(retention.result).toMatchObject({
      rawEventsDeleted: 1,
      modelInvocationSourcesDeleted: 0,
      chatMessagesDeleted: 1,
      auditLogDeleted: 1,
      eventProcessingFailuresDeleted: 1,
      memoriesPurged: 1,
      memorySourcesDeleted: 1,
      memoryRevisionsDeleted: 1,
    });

    reopenDb(true);
    expect(countRows(db, 'raw_events')).toBe(1);
    expect(countRows(db, 'chat_messages')).toBe(1);
    expect(countRows(db, 'event_processing_failures')).toBe(1);
    expect(countRows(db, 'memory_records')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('runs doctor with read-only aggregate DB and configuration evidence', () => {
    const now = Date.UTC(2026, 6, 3);
    const old = now - 45 * 24 * 60 * 60 * 1000;
    const recent = now - 2 * 24 * 60 * 60 * 1000;
    const secret = 'sk-ops-doctor-secret-should-not-leak';
    const platformId = 'qq-987654321';
    const rawSensitiveDbPath = join(testDir, `api_key=${secret}-${platformId}.db`);

    closeDatabase(db);
    dbPath = rawSensitiveDbPath;
    db = initDatabase({ path: dbPath });
    runMigration(db, join(process.cwd(), 'migrations/001_initial_schema.sql'));
    seedOperationalRows(old, recent);

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const result = runOps(['doctor'], {
      ONEBOT_HTTP_URL: `http://example.invalid/${secret}/${platformId}`,
      ONEBOT_WS_URL: `ws://example.invalid/${secret}/${platformId}`,
      ONEBOT_TOKEN: `token-${secret}-${platformId}`,
      LETHEBOT_BOT_QQ_ID: platformId,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toBe('');
    const stdout = result.stdout;
    const doctor = JSON.parse(stdout) as {
      overall: string;
      database: {
        dbPath: string;
        open: boolean;
        readonly: boolean;
        integrityOk: boolean;
        integrityResult: string;
        foreignKeyViolations: number;
      };
      schema: {
        ready: boolean;
        requiredTablesPresent: number;
        requiredTablesTotal: number;
        missingTables: string[];
      };
      counts: {
        raw_events: number;
        event_ingress_receipts: number;
        event_processing_admissions: number;
        chat_messages: number;
        event_processing_failures: number;
        agent_turns: number;
        jobs: number;
        audit_log: number;
        memory_records: number;
      };
      configuration: {
        oneBot: {
          transport: string;
          httpUrlConfigured: boolean;
          wsUrlConfigured: boolean;
          tokenConfigured: boolean;
          botIdConfigured: boolean;
        };
        server: {
          hostConfigured: boolean;
          portConfigured: boolean;
          healthPathConfigured: boolean;
          readinessPathConfigured: boolean;
          metricsPathConfigured: boolean;
          eventPathConfigured: boolean;
        };
      };
    };

    expect(doctor.overall).toBe('ok');
    expect(doctor.database).toMatchObject({
      open: true,
      readonly: true,
      integrityOk: true,
      integrityResult: 'ok',
      foreignKeyViolations: 0,
    });
    expect(doctor.database.dbPath).toContain('[REDACTED:api_key_assignment]');
    expect(doctor.database.dbPath).toContain('[REDACTED:platform_id]');
    expect(doctor.schema.ready).toBe(true);
    expect(doctor.schema.missingTables).toEqual([]);
    expect(doctor.schema.requiredTablesPresent).toBe(doctor.schema.requiredTablesTotal);
    expect(doctor.counts).toMatchObject({
      raw_events: 2,
      event_ingress_receipts: 0,
      event_processing_admissions: 0,
      chat_messages: 2,
      event_processing_failures: 2,
      agent_turns: 1,
      jobs: 1,
      audit_log: 2,
      memory_records: 2,
    });
    expect(doctor.configuration.oneBot).toEqual({
      transport: 'ws',
      httpUrlConfigured: true,
      wsUrlConfigured: true,
      tokenConfigured: true,
      botIdConfigured: true,
    });
    expect(doctor.configuration.server).toEqual({
      hostConfigured: true,
      portConfigured: true,
      healthPathConfigured: true,
      readinessPathConfigured: true,
      metricsPathConfigured: true,
      eventPathConfigured: true,
    });

    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('987654321');
    expect(stdout).not.toContain(rawSensitiveDbPath);
    expect(stdout).not.toContain('example.invalid');
    expect(stdout).not.toContain('token-');
    expect(stdout).not.toContain('private:qq-ops');
    expect(stdout).not.toContain('qq-ops');
    expect(stdout).not.toContain('hello');
    expect(stdout).not.toContain('test audit');

    reopenDb(true);
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('reports a missing ingress receipt table as an incomplete schema', () => {
    db.exec('DROP TABLE event_ingress_receipts');

    const result = runOps(['doctor', `--db=${dbPath}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const doctor = JSON.parse(result.stdout) as {
      overall: string;
      schema: { ready: boolean; missingTables: string[] };
      counts: { event_ingress_receipts?: number };
    };

    expect(doctor.overall).toBe('attention_required');
    expect(doctor.schema.ready).toBe(false);
    expect(doctor.schema.missingTables).toContain('event_ingress_receipts');
    expect(doctor.counts.event_ingress_receipts).toBe(0);
  });

  it('rehearses backup, restore, retention, and doctor on a disposable DB with aggregate-only evidence', () => {
    const secret = 'sk-ops-maintenance-rehearsal-secret-should-not-leak';
    const platformId = 'qq-456789012';
    const sensitiveRehearsalDir = join(testDir, platformId);
    mkdirSync(sensitiveRehearsalDir, { recursive: true });
    const sensitiveRehearsalDbPath = join(sensitiveRehearsalDir, `maintenance-${secret}.db`);
    const expectedBackupPath = join(sensitiveRehearsalDir, 'maintenance-rehearsal.backup.db');
    const expectedRestoredPath = join(sensitiveRehearsalDir, 'maintenance-rehearsal.restored.db');

    const result = runOps(['rehearse-maintenance', `--db=${sensitiveRehearsalDbPath}`], {
      ONEBOT_HTTP_URL: `http://example.invalid/${secret}/${platformId}`,
      ONEBOT_WS_URL: `ws://example.invalid/${secret}/${platformId}`,
      ONEBOT_TOKEN: `token-${secret}-${platformId}`,
      LETHEBOT_BOT_QQ_ID: platformId,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(result.stdout).toContain('[REDACTED:platform_id]');
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(platformId);
    expect(result.stdout).not.toContain('456789012');
    expect(result.stdout).not.toContain(sensitiveRehearsalDbPath);
    expect(result.stdout).not.toContain('example.invalid');
    expect(result.stdout).not.toContain('token-');
    expect(result.stdout).not.toContain('[synthetic ops rehearsal message]');

    const rehearsal = JSON.parse(result.stdout) as {
      success: boolean;
      temporary: boolean;
      dbPath: string;
      backup: {
        backupPath: string;
        integrityOk: boolean;
        backupSizeBytes: number;
      };
      restore: {
        targetPath: string;
        integrityOk: boolean;
        foreignKeyViolations: number;
        restoredSizeBytes: number;
      };
      doctor: {
        beforeRetention: {
          overall: string;
          schemaReady: boolean;
          foreignKeyViolations: number;
        };
        afterRetention: {
          overall: string;
          schemaReady: boolean;
          foreignKeyViolations: number;
        };
      };
      retention: {
        policy: {
          rawEventsDays: number;
          chatMessagesDays: number;
          auditLogDays: number;
          disabledDeletedMemoryDays: number;
          eventProcessingFailuresDays: number;
        };
        result: {
          rawEventsDeleted: number;
          modelInvocationSourcesDeleted: number;
          chatMessagesDeleted: number;
          auditLogDeleted: number;
          eventProcessingFailuresDeleted: number;
          memoriesPurged: number;
          memorySourcesDeleted: number;
          memoryRevisionsDeleted: number;
        };
      };
      counts: {
        sourceBefore: {
          raw_events: number;
          chat_messages: number;
          event_processing_failures: number;
          audit_log: number;
          memory_records: number;
          memory_sources: number;
          memory_revisions: number;
        };
        restoredBefore: {
          raw_events: number;
          chat_messages: number;
          event_processing_failures: number;
          audit_log: number;
          memory_records: number;
          memory_sources: number;
          memory_revisions: number;
        };
        restoredAfter: {
          raw_events: number;
          chat_messages: number;
          event_processing_failures: number;
          audit_log: number;
          memory_records: number;
          memory_sources: number;
          memory_revisions: number;
        };
      };
    };

    expect(rehearsal.success).toBe(true);
    expect(rehearsal.temporary).toBe(false);
    expect(rehearsal.dbPath).toContain('[REDACTED:openai_like_api_key]');
    expect(rehearsal.dbPath).toContain('[REDACTED:platform_id]');
    expect(rehearsal.backup.backupPath).toContain('[REDACTED:platform_id]');
    expect(rehearsal.backup.integrityOk).toBe(true);
    expect(rehearsal.backup.backupSizeBytes).toBeGreaterThan(0);
    expect(rehearsal.restore.targetPath).toContain('[REDACTED:platform_id]');
    expect(rehearsal.restore.integrityOk).toBe(true);
    expect(rehearsal.restore.foreignKeyViolations).toBe(0);
    expect(rehearsal.restore.restoredSizeBytes).toBeGreaterThan(0);
    expect(rehearsal.doctor.beforeRetention).toEqual({
      overall: 'ok',
      schemaReady: true,
      foreignKeyViolations: 0,
    });
    expect(rehearsal.doctor.afterRetention).toEqual({
      overall: 'ok',
      schemaReady: true,
      foreignKeyViolations: 0,
    });
    expect(rehearsal.retention.policy).toEqual({
      rawEventsDays: 30,
      chatMessagesDays: 30,
      auditLogDays: 30,
      disabledDeletedMemoryDays: 30,
      eventProcessingFailuresDays: 30,
    });
    expect(rehearsal.retention.result).toMatchObject({
      rawEventsDeleted: 1,
      modelInvocationSourcesDeleted: 0,
      chatMessagesDeleted: 1,
      auditLogDeleted: 1,
      eventProcessingFailuresDeleted: 1,
      memoriesPurged: 1,
      memorySourcesDeleted: 1,
      memoryRevisionsDeleted: 1,
    });
    expect(rehearsal.counts.sourceBefore).toMatchObject({
      raw_events: 2,
      chat_messages: 2,
      event_processing_failures: 2,
      audit_log: 2,
      memory_records: 2,
      memory_sources: 1,
      memory_revisions: 1,
    });
    expect(rehearsal.counts.restoredBefore).toEqual(rehearsal.counts.sourceBefore);
    expect(rehearsal.counts.restoredAfter).toMatchObject({
      raw_events: 1,
      chat_messages: 1,
      event_processing_failures: 1,
      audit_log: 1,
      memory_records: 1,
      memory_sources: 0,
      memory_revisions: 0,
    });

    expect(existsSync(sensitiveRehearsalDbPath)).toBe(true);
    expect(existsSync(expectedBackupPath)).toBe(true);
    expect(existsSync(expectedRestoredPath)).toBe(true);

    const sourceDb = initDatabase({ path: sensitiveRehearsalDbPath, readonly: true });
    try {
      expect(countRows(sourceDb, 'raw_events')).toBe(2);
      expect(countRows(sourceDb, 'chat_messages')).toBe(2);
      expect(sourceDb.prepare(
        `SELECT source_type, source_id, resolution_state,
                raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
         FROM memory_sources
         WHERE memory_id = ?`,
      ).get('rehearsal-memory-old-deleted')).toEqual({
        source_type: 'raw_event',
        source_id: 'rehearsal-raw-old',
        resolution_state: 'internal',
        raw_event_id: 'rehearsal-raw-old',
        chat_message_id: null,
        tool_call_id: null,
        job_id: null,
        job_attempt_id: null,
      });
      expect(sourceDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(sourceDb);
    }

    const restoredDb = initDatabase({ path: expectedRestoredPath, readonly: true });
    try {
      expect(countRows(restoredDb, 'raw_events')).toBe(1);
      expect(countRows(restoredDb, 'chat_messages')).toBe(1);
      expect(countRows(restoredDb, 'event_processing_failures')).toBe(1);
      expect(countRows(restoredDb, 'memory_records')).toBe(1);
      expect(restoredDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(restoredDb);
    }
  });

  it('rehearses rollback by restoring a backup over a synthetic update with aggregate-only evidence', () => {
    const secret = 'sk-ops-rollback-rehearsal-secret-should-not-leak';
    const platformId = 'qq-567890123';
    const sensitiveRollbackDir = join(testDir, platformId);
    mkdirSync(sensitiveRollbackDir, { recursive: true });
    const sensitiveRollbackDbPath = join(sensitiveRollbackDir, `rollback-${secret}.db`);
    const expectedBackupPath = join(sensitiveRollbackDir, 'rollback-rehearsal.backup.db');

    const result = runOps(['rehearse-rollback', `--db=${sensitiveRollbackDbPath}`], {
      ONEBOT_HTTP_URL: `http://example.invalid/${secret}/${platformId}`,
      ONEBOT_WS_URL: `ws://example.invalid/${secret}/${platformId}`,
      ONEBOT_TOKEN: `token-${secret}-${platformId}`,
      LETHEBOT_BOT_QQ_ID: platformId,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(result.stdout).toContain('[REDACTED:platform_id]');
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(platformId);
    expect(result.stdout).not.toContain('567890123');
    expect(result.stdout).not.toContain(sensitiveRollbackDbPath);
    expect(result.stdout).not.toContain('example.invalid');
    expect(result.stdout).not.toContain('token-');
    expect(result.stdout).not.toContain('rollback-mutation');
    expect(result.stdout).not.toContain('[synthetic ops rehearsal message]');

    const rehearsal = JSON.parse(result.stdout) as {
      success: boolean;
      temporary: boolean;
      dbPath: string;
      backup: {
        backupPath: string;
        integrityOk: boolean;
        backupSizeBytes: number;
      };
      restore: {
        targetPath: string;
        overwrite: boolean;
        integrityOk: boolean;
        foreignKeyViolations: number;
        restoredSizeBytes: number;
      };
      doctor: {
        afterRollback: {
          overall: string;
          schemaReady: boolean;
          foreignKeyViolations: number;
        };
      };
      rollback: {
        restoredMatchesBackup: boolean;
        syntheticRowsRemoved: boolean;
      };
      fingerprints: {
        beforeUpdate: string;
        afterSyntheticUpdate: string;
        afterRollback: string;
      };
      counts: {
        beforeUpdate: {
          raw_events: number;
          chat_messages: number;
          event_processing_failures: number;
          audit_log: number;
          memory_records: number;
          memory_sources: number;
          memory_revisions: number;
        };
        afterSyntheticUpdate: {
          raw_events: number;
          chat_messages: number;
          event_processing_failures: number;
          audit_log: number;
          memory_records: number;
          memory_sources: number;
          memory_revisions: number;
        };
        afterRollback: {
          raw_events: number;
          chat_messages: number;
          event_processing_failures: number;
          audit_log: number;
          memory_records: number;
          memory_sources: number;
          memory_revisions: number;
        };
      };
    };

    expect(rehearsal.success).toBe(true);
    expect(rehearsal.temporary).toBe(false);
    expect(rehearsal.dbPath).toContain('[REDACTED:openai_like_api_key]');
    expect(rehearsal.dbPath).toContain('[REDACTED:platform_id]');
    expect(rehearsal.backup.backupPath).toContain('[REDACTED:platform_id]');
    expect(rehearsal.backup.integrityOk).toBe(true);
    expect(rehearsal.backup.backupSizeBytes).toBeGreaterThan(0);
    expect(rehearsal.restore.targetPath).toContain('[REDACTED:platform_id]');
    expect(rehearsal.restore.overwrite).toBe(true);
    expect(rehearsal.restore.integrityOk).toBe(true);
    expect(rehearsal.restore.foreignKeyViolations).toBe(0);
    expect(rehearsal.restore.restoredSizeBytes).toBeGreaterThan(0);
    expect(rehearsal.doctor.afterRollback).toEqual({
      overall: 'ok',
      schemaReady: true,
      foreignKeyViolations: 0,
    });
    expect(rehearsal.rollback).toEqual({
      restoredMatchesBackup: true,
      syntheticRowsRemoved: true,
    });
    expect(rehearsal.counts.beforeUpdate).toMatchObject({
      raw_events: 2,
      chat_messages: 2,
      event_processing_failures: 2,
      audit_log: 2,
      memory_records: 2,
      memory_sources: 1,
      memory_revisions: 1,
    });
    expect(rehearsal.counts.afterSyntheticUpdate).toMatchObject({
      raw_events: 3,
      chat_messages: 3,
      event_processing_failures: 3,
      audit_log: 3,
      memory_records: 3,
      memory_sources: 2,
      memory_revisions: 2,
    });
    expect(rehearsal.counts.afterRollback).toEqual(rehearsal.counts.beforeUpdate);
    expect(rehearsal.fingerprints.beforeUpdate).toMatch(/^[a-f0-9]{64}$/);
    expect(rehearsal.fingerprints.afterSyntheticUpdate).toMatch(/^[a-f0-9]{64}$/);
    expect(rehearsal.fingerprints.afterRollback).toBe(rehearsal.fingerprints.beforeUpdate);
    expect(rehearsal.fingerprints.afterSyntheticUpdate).not.toBe(rehearsal.fingerprints.beforeUpdate);

    expect(existsSync(sensitiveRollbackDbPath)).toBe(true);
    expect(existsSync(expectedBackupPath)).toBe(true);

    const rollbackDb = initDatabase({ path: sensitiveRollbackDbPath, readonly: true });
    try {
      expect(countRows(rollbackDb, 'raw_events')).toBe(2);
      expect(countRows(rollbackDb, 'chat_messages')).toBe(2);
      const mutation = rollbackDb
        .prepare("SELECT COUNT(*) AS count FROM raw_events WHERE id = 'rollback-mutation-raw'")
        .get() as { count: number };
      expect(mutation.count).toBe(0);
      expect(rollbackDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(rollbackDb);
    }
  });

  it('reports final worker failures in metrics without leaking job, worker, or secret details', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const jobId = 'job-qq-456789012';
    const workerId = 'qq-234567890';
    const errorPlatformId = 'qq-345678901';
    const jobRepo = new JobRepository(db);
    jobRepo.enqueue({
      id: jobId,
      type: 'conflict',
      payload: { conversationId: 'group:ops-worker-failure', token: secret },
      idempotencyKey: `conflict:${secret}`,
      maxAttempts: 1,
    });

    const worker = new BackgroundWorker({
      jobRepository: jobRepo,
      workerId,
      handlers: {
        conflict: async () => {
          throw new Error(`api_key=${secret} failed for ${errorPlatformId}`);
        },
      },
    });

    const result = await worker.processNext();
    expect(result).toMatchObject({
      taskId: jobId,
      status: 'failed',
    });
    expect(result?.error).toContain('[REDACTED:api_key_assignment]');
    expect(result?.error).toContain('[REDACTED:platform_id]');
    expect(result?.error).not.toContain(secret);
    expect(result?.error).not.toContain(errorPlatformId);

    closeDatabase(db);

    const metrics = JSON.parse(expectSuccessfulOps([
      'metrics',
      `--db=${dbPath}`,
      '--format=json',
    ])) as {
      jobs: {
        total: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
        pending: number;
        running: number;
        failed: number;
        expiredRunningLeases: number;
      };
      jobAttempts: { total: number; byStatus: Record<string, number> };
      workerHeartbeats: {
        total: number;
        byStatus: Record<string, number>;
        byWorkerType: Record<string, number>;
      };
    };

    expect(metrics.jobs).toMatchObject({
      total: 1,
      byStatus: { failed: 1 },
      byType: { conflict: 1 },
      pending: 0,
      running: 0,
      failed: 1,
      expiredRunningLeases: 0,
    });
    expect(metrics.jobAttempts).toMatchObject({
      total: 1,
      byStatus: { failed: 1 },
    });
    expect(metrics.workerHeartbeats).toMatchObject({
      total: 1,
      byStatus: { error: 1 },
      byWorkerType: { background: 1 },
    });

    const serializedMetrics = JSON.stringify(metrics);
    expect(serializedMetrics).not.toContain(secret);
    expect(serializedMetrics).not.toContain(jobId);
    expect(serializedMetrics).not.toContain(workerId);
    expect(serializedMetrics).not.toContain(errorPlatformId);
    expect(serializedMetrics).not.toContain('api_key=');
    expect(serializedMetrics).not.toContain('group:ops-worker-failure');

    const prometheusMetrics = expectSuccessfulOps([
      'metrics',
      `--db=${dbPath}`,
      '--format=prometheus',
    ]);
    expect(prometheusMetrics).toContain('lethebot_jobs_failed_total 1');
    expect(prometheusMetrics).toContain('lethebot_jobs_status_total{status="failed"} 1');
    expect(prometheusMetrics).toContain('lethebot_jobs_type_total{type="conflict"} 1');
    expect(prometheusMetrics).toContain('lethebot_job_attempts_status_total{status="failed"} 1');
    expect(prometheusMetrics).toContain('lethebot_worker_heartbeats_status_total{status="error"} 1');
    expect(prometheusMetrics).toContain('lethebot_worker_heartbeats_type_total{worker_type="background"} 1');
    expect(prometheusMetrics).not.toContain(secret);
    expect(prometheusMetrics).not.toContain(jobId);
    expect(prometheusMetrics).not.toContain(workerId);
    expect(prometheusMetrics).not.toContain(errorPlatformId);
    expect(prometheusMetrics).not.toContain('api_key=');
    expect(prometheusMetrics).not.toContain('group:ops-worker-failure');

    reopenDb(true);
    const persistedJob = db.prepare('SELECT error FROM jobs WHERE id = ?').get(jobId) as { error: string };
    const persistedAttempt = db.prepare('SELECT error FROM job_attempts WHERE job_id = ?').get(jobId) as {
      error: string;
    };
    const persistedHeartbeat = db
      .prepare('SELECT details FROM worker_heartbeats WHERE worker_id = ?')
      .get(workerId) as { details: string };
    expect(persistedJob.error).toContain('[REDACTED:api_key_assignment]');
    expect(persistedJob.error).toContain('[REDACTED:platform_id]');
    expect(persistedJob.error).not.toContain(secret);
    expect(persistedJob.error).not.toContain(errorPlatformId);
    expect(persistedAttempt.error).toBe(persistedJob.error);
    expect(persistedHeartbeat.details).toContain('[REDACTED:api_key_assignment]');
    expect(persistedHeartbeat.details).toContain('[REDACTED:platform_id]');
    expect(persistedHeartbeat.details).not.toContain(secret);
    expect(persistedHeartbeat.details).not.toContain(errorPlatformId);
    expect(countRows(db, 'jobs')).toBe(1);
    expect(countRows(db, 'job_attempts')).toBe(1);
    expect(countRows(db, 'worker_heartbeats')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts dynamic aggregate keys in metrics JSON without changing raw DB rows', () => {
    const now = Date.UTC(2026, 6, 6);
    const secret = 'sk-ops-metrics-key-secret-should-not-leak';
    const platformId = 'qq-765432109';
    const actionType = `reply-${platformId}-${secret}`;
    const auditEventType = `audit.${platformId}.${secret}`;
    const auditRiskLevel = `risk-${platformId}-${secret}`;
    const jobType = `summary-${platformId}-${secret}`;
    const workerType = `background-${platformId}-${secret}`;

    insertRawEvent('evt-ops-metrics-key', now);
    insertAgentTurn('turn-ops-metrics-key', 'evt-ops-metrics-key', now);
    insertActionDecision('decision-ops-metrics-key', 'turn-ops-metrics-key', now);
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status, audit_level, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('execution-ops-metrics-key', 'decision-ops-metrics-key', actionType, 'success', 'summary', now);
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-ops-metrics-key',
      now,
      'system',
      'summary',
      auditEventType,
      'audit-event-ops-metrics-key',
      'system',
      'system',
      'sensitive aggregate key audit',
      1,
      auditRiskLevel,
    );
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('job-ops-metrics-key', jobType, '{}', 'pending', 0, 3, now, now, now);
    db.prepare(
      `INSERT INTO worker_heartbeats (
        worker_id, worker_type, status, heartbeat_at, details
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('worker-ops-metrics-key', workerType, 'idle', now, '{}');

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };

    const stdout = expectSuccessfulOps(['metrics', `--db=${dbPath}`, '--format=json']);
    expect(stdout).toContain('[REDACTED:');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('765432109');

    const metrics = JSON.parse(stdout) as {
      actionExecutions: { byActionType: Record<string, number> };
      policyAuditEvents: {
        byRiskLevel: Record<string, number>;
        byEventType: Record<string, number>;
      };
      jobs: { byType: Record<string, number> };
      workerHeartbeats: { byWorkerType: Record<string, number> };
    };
    for (const counts of [
      metrics.actionExecutions.byActionType,
      metrics.policyAuditEvents.byRiskLevel,
      metrics.policyAuditEvents.byEventType,
      metrics.jobs.byType,
      metrics.workerHeartbeats.byWorkerType,
    ]) {
      const keys = Object.keys(counts);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain('[REDACTED:');
      expect(counts[keys[0] as string]).toBe(1);
    }

    const prometheus = expectSuccessfulOps(['metrics', `--db=${dbPath}`, '--format=prometheus']);
    expect(prometheus).not.toContain(secret);
    expect(prometheus).not.toContain(platformId);
    expect(prometheus).not.toContain('765432109');
    expect(prometheus).toContain('lethebot_action_executions_action_type_total{action_type="other"} 1');
    expect(prometheus).toContain('lethebot_policy_audit_events_risk_level_total{risk_level="other"} 1');
    expect(prometheus).toContain('lethebot_jobs_type_total{type="other"} 1');
    expect(prometheus).toContain('lethebot_worker_heartbeats_type_total{worker_type="other"} 1');

    reopenDb(true);
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts adjacent secret/platform identifiers in metrics aggregate keys without changing raw DB rows', () => {
    const now = Date.UTC(2026, 6, 6);
    const adjacentSecretPlatform = 'sk-ops-adjacent-metrics-secret-qq-246813579';
    const actionType = `reply-${adjacentSecretPlatform}`;
    const auditEventType = `audit.${adjacentSecretPlatform}`;
    const auditRiskLevel = `risk-${adjacentSecretPlatform}`;
    const jobType = `summary-${adjacentSecretPlatform}`;
    const workerType = `background-${adjacentSecretPlatform}`;

    insertRawEvent('evt-ops-adjacent-metrics-key', now);
    insertAgentTurn('turn-ops-adjacent-metrics-key', 'evt-ops-adjacent-metrics-key', now);
    insertActionDecision('decision-ops-adjacent-metrics-key', 'turn-ops-adjacent-metrics-key', now);
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status, audit_level, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-ops-adjacent-metrics-key',
      'decision-ops-adjacent-metrics-key',
      actionType,
      'success',
      'summary',
      now,
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-ops-adjacent-metrics-key',
      now,
      'system',
      'summary',
      auditEventType,
      'audit-event-ops-adjacent-metrics-key',
      'system',
      'system',
      'adjacent secret/platform aggregate key audit',
      1,
      auditRiskLevel,
    );
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('job-ops-adjacent-metrics-key', jobType, '{}', 'pending', 0, 3, now, now, now);
    db.prepare(
      `INSERT INTO worker_heartbeats (
        worker_id, worker_type, status, heartbeat_at, details
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('worker-ops-adjacent-metrics-key', workerType, 'idle', now, '{}');

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };

    const stdout = expectSuccessfulOps(['metrics', `--db=${dbPath}`, '--format=json']);
    expect(stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(adjacentSecretPlatform);
    expect(stdout).not.toContain('qq-246813579');
    expect(stdout).not.toContain('246813579');

    const metrics = JSON.parse(stdout) as {
      actionExecutions: { byActionType: Record<string, number> };
      policyAuditEvents: {
        byRiskLevel: Record<string, number>;
        byEventType: Record<string, number>;
      };
      jobs: { byType: Record<string, number> };
      workerHeartbeats: { byWorkerType: Record<string, number> };
    };
    for (const counts of [
      metrics.actionExecutions.byActionType,
      metrics.policyAuditEvents.byRiskLevel,
      metrics.policyAuditEvents.byEventType,
      metrics.jobs.byType,
      metrics.workerHeartbeats.byWorkerType,
    ]) {
      const keys = Object.keys(counts);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain('[REDACTED:openai_like_api_key]');
      expect(keys[0]).toContain('[REDACTED:platform_id]');
      expect(counts[keys[0] as string]).toBe(1);
    }

    reopenDb(true);
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves assignment-shaped adjacent markers in metrics aggregate keys without changing raw DB rows', () => {
    const now = Date.UTC(2026, 6, 6);
    const assignmentSecretPlatform = 'api_key=sk-ops-assignment-metrics-secret-qq-135792468';
    const actionType = `reply-${assignmentSecretPlatform}`;
    const auditEventType = `audit.${assignmentSecretPlatform}`;
    const auditRiskLevel = `risk-${assignmentSecretPlatform}`;
    const jobType = `summary-${assignmentSecretPlatform}`;
    const workerType = `background-${assignmentSecretPlatform}`;

    insertRawEvent('evt-ops-assignment-metrics-key', now);
    insertAgentTurn('turn-ops-assignment-metrics-key', 'evt-ops-assignment-metrics-key', now);
    insertActionDecision('decision-ops-assignment-metrics-key', 'turn-ops-assignment-metrics-key', now);
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status, audit_level, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-ops-assignment-metrics-key',
      'decision-ops-assignment-metrics-key',
      actionType,
      'success',
      'summary',
      now,
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-ops-assignment-metrics-key',
      now,
      'system',
      'summary',
      auditEventType,
      'audit-event-ops-assignment-metrics-key',
      'system',
      'system',
      'assignment-shaped aggregate key audit',
      1,
      auditRiskLevel,
    );
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('job-ops-assignment-metrics-key', jobType, '{}', 'pending', 0, 3, now, now, now);
    db.prepare(
      `INSERT INTO worker_heartbeats (
        worker_id, worker_type, status, heartbeat_at, details
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('worker-ops-assignment-metrics-key', workerType, 'idle', now, '{}');

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };

    const stdout = expectSuccessfulOps(['metrics', `--db=${dbPath}`, '--format=json']);
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(assignmentSecretPlatform);
    expect(stdout).not.toContain('api_key=');
    expect(stdout).not.toContain('sk-ops-assignment-metrics-secret');
    expect(stdout).not.toContain('qq-135792468');
    expect(stdout).not.toContain('135792468');

    const metrics = JSON.parse(stdout) as {
      actionExecutions: { byActionType: Record<string, number> };
      policyAuditEvents: {
        byRiskLevel: Record<string, number>;
        byEventType: Record<string, number>;
      };
      jobs: { byType: Record<string, number> };
      workerHeartbeats: { byWorkerType: Record<string, number> };
    };
    for (const counts of [
      metrics.actionExecutions.byActionType,
      metrics.policyAuditEvents.byRiskLevel,
      metrics.policyAuditEvents.byEventType,
      metrics.jobs.byType,
      metrics.workerHeartbeats.byWorkerType,
    ]) {
      const keys = Object.keys(counts);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain('[REDACTED:api_key_assignment]');
      expect(keys[0]).toContain('[REDACTED:platform_id]');
      expect(counts[keys[0] as string]).toBe(1);
    }

    const prometheus = expectSuccessfulOps(['metrics', `--db=${dbPath}`, '--format=prometheus']);
    expect(prometheus).not.toContain(assignmentSecretPlatform);
    expect(prometheus).not.toContain('api_key=');
    expect(prometheus).not.toContain('sk-ops-assignment-metrics-secret');
    expect(prometheus).not.toContain('qq-135792468');
    expect(prometheus).not.toContain('135792468');

    reopenDb(true);
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts embedded platform identifiers in metrics aggregate keys without changing raw DB rows', () => {
    const now = Date.UTC(2026, 6, 6);
    const embeddedPrefixedPlatformId = 'legacy_qq-765432109';
    const embeddedNumericPlatformId = 'legacy_876543210';
    const actionType = `reply_${embeddedPrefixedPlatformId}`;
    const auditEventType = `audit.${embeddedNumericPlatformId}`;
    const auditRiskLevel = `risk_${embeddedPrefixedPlatformId}_${embeddedNumericPlatformId}`;
    const jobType = `summary_${embeddedNumericPlatformId}`;
    const workerType = `background_${embeddedPrefixedPlatformId}_${embeddedNumericPlatformId}`;

    insertRawEvent('evt-ops-embedded-platform-metrics-key', now);
    insertAgentTurn('turn-ops-embedded-platform-metrics-key', 'evt-ops-embedded-platform-metrics-key', now);
    insertActionDecision('decision-ops-embedded-platform-metrics-key', 'turn-ops-embedded-platform-metrics-key', now);
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status, audit_level, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-ops-embedded-platform-metrics-key',
      'decision-ops-embedded-platform-metrics-key',
      actionType,
      'success',
      'summary',
      now,
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-ops-embedded-platform-metrics-key',
      now,
      'system',
      'summary',
      auditEventType,
      'audit-event-ops-embedded-platform-metrics-key',
      'system',
      'system',
      'embedded platform aggregate key audit',
      1,
      auditRiskLevel,
    );
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('job-ops-embedded-platform-metrics-key', jobType, '{}', 'pending', 0, 3, now, now, now);
    db.prepare(
      `INSERT INTO worker_heartbeats (
        worker_id, worker_type, status, heartbeat_at, details
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('worker-ops-embedded-platform-metrics-key', workerType, 'idle', now, '{}');

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };

    const stdout = expectSuccessfulOps(['metrics', `--db=${dbPath}`, '--format=json']);
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(embeddedPrefixedPlatformId);
    expect(stdout).not.toContain(embeddedNumericPlatformId);
    expect(stdout).not.toContain('legacy_qq-');
    expect(stdout).not.toContain('765432109');
    expect(stdout).not.toContain('876543210');

    const metrics = JSON.parse(stdout) as {
      actionExecutions: { byActionType: Record<string, number> };
      policyAuditEvents: {
        byRiskLevel: Record<string, number>;
        byEventType: Record<string, number>;
      };
      jobs: { byType: Record<string, number> };
      workerHeartbeats: { byWorkerType: Record<string, number> };
    };
    for (const counts of [
      metrics.actionExecutions.byActionType,
      metrics.policyAuditEvents.byRiskLevel,
      metrics.policyAuditEvents.byEventType,
      metrics.jobs.byType,
      metrics.workerHeartbeats.byWorkerType,
    ]) {
      const keys = Object.keys(counts);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain('[REDACTED:platform_id]');
      expect(counts[keys[0] as string]).toBe(1);
    }

    const prometheus = expectSuccessfulOps(['metrics', `--db=${dbPath}`, '--format=prometheus']);
    expect(prometheus).not.toContain(embeddedPrefixedPlatformId);
    expect(prometheus).not.toContain(embeddedNumericPlatformId);
    expect(prometheus).not.toContain('765432109');
    expect(prometheus).not.toContain('876543210');

    reopenDb(true);
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects nonempty durable worker state before a soak can claim unrelated jobs', () => {
    const soakDbPath = join(testDir, 'worker-soak-nonempty.db');
    const soakDb = initDatabase({ path: soakDbPath });
    let unrelatedJobId: string;
    try {
      runMigration(soakDb, join(process.cwd(), 'migrations/001_initial_schema.sql'));
      unrelatedJobId = new JobRepository(soakDb).enqueue({
        type: 'retention',
        payload: { unrelated: true },
        idempotencyKey: 'unrelated-worker-soak-guard',
      });
    } finally {
      closeDatabase(soakDb);
    }

    const result = runOps([
      'worker-soak',
      `--db=${soakDbPath}`,
      '--duration-ms=500',
      '--interval-ms=20',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Worker soak requires empty durable worker tables');

    const verifiedDb = initDatabase({ path: soakDbPath, readonly: true });
    try {
      expect(verifiedDb.prepare(
        'SELECT status, attempts FROM jobs WHERE id = ?',
      ).get(unrelatedJobId)).toEqual({ status: 'pending', attempts: 0 });
      expect(countRows(verifiedDb, 'jobs')).toBe(1);
      expect(countRows(verifiedDb, 'job_attempts')).toBe(0);
      expect(countRows(verifiedDb, 'worker_heartbeats')).toBe(0);
    } finally {
      closeDatabase(verifiedDb);
    }
  });

  it('reports scheduler producer failures as unhealthy aggregate evidence', () => {
    const soakDbPath = join(testDir, 'worker-soak-producer-failure.db');
    const soakDb = initDatabase({ path: soakDbPath });
    try {
      runMigration(soakDb, join(process.cwd(), 'migrations/001_initial_schema.sql'));
      soakDb.exec(`
        CREATE TRIGGER fail_first_soak_producer
        BEFORE INSERT ON jobs
        WHEN NEW.idempotency_key LIKE 'worker-soak:%:load:1'
        BEGIN
          SELECT RAISE(ABORT, 'synthetic producer failure must stay private');
        END;
      `);
    } finally {
      closeDatabase(soakDb);
    }

    const result = runOps([
      'worker-soak',
      `--db=${soakDbPath}`,
      '--duration-ms=500',
      '--interval-ms=20',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('synthetic producer failure');
    const soak = JSON.parse(result.stdout) as {
      success: boolean;
      schedulerErrors: { producer: number; consumer: number; total: number };
      isolation: { clean: boolean };
    };
    expect(soak.success).toBe(false);
    expect(soak.schedulerErrors).toEqual({ producer: 1, consumer: 0, total: 1 });
    expect(soak.isolation.clean).toBe(true);
  });

  it('runs an opt-in worker scheduler soak with aggregate-only evidence', () => {
    const soakDbPath = join(testDir, 'worker-soak.db');
    const soak = JSON.parse(expectSuccessfulOps([
      'worker-soak',
      `--db=${soakDbPath}`,
      '--duration-ms=500',
      '--interval-ms=20',
    ])) as {
      dbPath: string;
      temporary: boolean;
      success: boolean;
      ticks: number;
      processed: number;
      outcomes: { byStatus: Record<string, number> };
      load: {
        windows: number;
        enqueued: number;
        enqueuedByWindow: number[];
        completedByWindow: number[];
        lastEnqueueOffsetMs: number;
        emptyPolls: number;
      };
      drain: { processed: number; timedOut: boolean };
      schedulerErrors: { producer: number; consumer: number; total: number };
      isolation: { clean: boolean };
      jobs: {
        total: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
        completed: number;
        running: number;
        failed: number;
      };
      jobAttempts: {
        total: number;
        byStatus: Record<string, number>;
        completed: number;
        failed: number;
        running: number;
        plannedRetryObserved: boolean;
      };
      leaseExtensions: {
        observed: boolean;
        count: number;
      };
      workerHeartbeat: {
        workerType: string;
        status: string;
        currentJobIdPresent: boolean;
      };
      foreignKeyViolations: number;
    };

    expect(soak.dbPath).toBe(soakDbPath);
    expect(soak.temporary).toBe(false);
    expect(soak.success).toBe(true);
    expect(soak.ticks).toBeGreaterThanOrEqual(4);
    expect(soak.load.windows).toBe(3);
    expect(soak.load.enqueued).toBeGreaterThanOrEqual(3);
    expect(soak.load.enqueuedByWindow).toHaveLength(3);
    expect(soak.load.completedByWindow).toHaveLength(3);
    expect(soak.load.enqueuedByWindow.every((count) => count >= 1)).toBe(true);
    expect(soak.load.completedByWindow.every((count) => count >= 1)).toBe(true);
    expect(soak.load.lastEnqueueOffsetMs).toBeGreaterThanOrEqual(460);
    expect(soak.load.emptyPolls).toBe(0);
    expect(soak.drain.timedOut).toBe(false);
    expect(soak.schedulerErrors).toEqual({ producer: 0, consumer: 0, total: 0 });
    expect(soak.isolation.clean).toBe(true);
    expect(soak.processed).toBe(soak.jobs.total + 1);
    expect(soak.outcomes.byStatus.completed).toBe(soak.jobs.total);
    expect(soak.outcomes.byStatus.failed).toBe(1);
    expect(soak.jobs.total).toBe(7 + soak.load.enqueued);
    expect(soak.jobs).toMatchObject({
      completed: soak.jobs.total,
      running: 0,
      failed: 0,
      byStatus: { completed: soak.jobs.total },
      byType: {
        admin_digest: 1,
        conflict: 1,
        consolidation: 1,
        decay: 1,
        summary: 1,
        extraction: 1,
        retention: 1 + soak.load.enqueued,
      },
    });
    expect(soak.jobAttempts.total).toBe(soak.jobs.total + 1);
    expect(soak.jobAttempts).toMatchObject({
      completed: soak.jobs.total,
      failed: 1,
      running: 0,
      byStatus: {
        completed: soak.jobs.total,
        failed: 1,
      },
      plannedRetryObserved: true,
    });
    expect(soak.leaseExtensions.observed).toBe(true);
    expect(soak.leaseExtensions.count).toBeGreaterThanOrEqual(1);
    expect(soak.workerHeartbeat).toEqual({
      workerType: 'background',
      status: 'idle',
      currentJobIdPresent: false,
    });
    expect(soak.foreignKeyViolations).toBe(0);

    const serialized = JSON.stringify(soak);
    expect(serialized).not.toContain('planned worker soak retry');
    expect(serialized).not.toContain('extractionHint');
    expect(serialized).not.toContain('payload');

    const soakDb = initDatabase({ path: soakDbPath, readonly: true });
    try {
      expect(countRows(soakDb, 'jobs')).toBe(soak.jobs.total);
      expect(countRows(soakDb, 'job_attempts')).toBe(soak.jobAttempts.total);
      expect(countRows(soakDb, 'worker_heartbeats')).toBe(1);
      expect(soakDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(soakDb);
    }
  });

  it('prints machine-readable worker-soak JSON without scheduler logs under default logging', () => {
    const soakDbPath = join(testDir, 'worker-soak-default-log.db');
    const result = runOps([
      'worker-soak',
      `--db=${soakDbPath}`,
      '--duration-ms=500',
      '--interval-ms=20',
    ], { LOG_LEVEL: undefined });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.startsWith('{')).toBe(true);
    expect(result.stdout).not.toContain('Registering worker job');
    expect(result.stdout).not.toContain('Starting worker scheduler');
    expect(result.stdout).not.toContain('Stopping worker scheduler');

    const soak = JSON.parse(result.stdout) as {
      success: boolean;
      temporary: boolean;
      processed: number;
      load: { enqueued: number; emptyPolls: number; completedByWindow: number[] };
      drain: { timedOut: boolean };
      jobs: { total: number; completed: number; failed: number };
      jobAttempts: { total: number; failed: number; plannedRetryObserved: boolean };
      leaseExtensions: { observed: boolean };
      foreignKeyViolations: number;
    };

    expect(soak).toMatchObject({
      success: true,
      temporary: false,
      jobAttempts: {
        failed: 1,
        plannedRetryObserved: true,
      },
      leaseExtensions: {
        observed: true,
      },
      foreignKeyViolations: 0,
    });
    expect(soak.load.enqueued).toBeGreaterThanOrEqual(3);
    expect(soak.load.emptyPolls).toBe(0);
    expect(soak.load.completedByWindow.every((count) => count >= 1)).toBe(true);
    expect(soak.drain.timedOut).toBe(false);
    expect(soak.jobs.total).toBe(7 + soak.load.enqueued);
    expect(soak.jobs.completed).toBe(soak.jobs.total);
    expect(soak.jobs.failed).toBe(0);
    expect(soak.jobAttempts.total).toBe(soak.jobs.total + 1);
    expect(soak.processed).toBe(soak.jobAttempts.total);

    const soakDb = initDatabase({ path: soakDbPath, readonly: true });
    try {
      expect(countRows(soakDb, 'jobs')).toBe(soak.jobs.total);
      expect(countRows(soakDb, 'job_attempts')).toBe(soak.jobAttempts.total);
      expect(countRows(soakDb, 'worker_heartbeats')).toBe(1);
      expect(soakDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(soakDb);
    }
  });

  it('runs worker-soak with a default temporary migrated DB and aggregate-only evidence', () => {
    let temporarySoakDir: string | undefined;
    const result = runOps([
      'worker-soak',
      '--duration-ms=500',
      '--interval-ms=20',
    ], { LOG_LEVEL: undefined });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.startsWith('{')).toBe(true);
    expect(result.stdout).not.toContain('Registering worker job');
    expect(result.stdout).not.toContain('Starting worker scheduler');
    expect(result.stdout).not.toContain('Stopping worker scheduler');

    const soak = JSON.parse(result.stdout) as {
      dbPath: string;
      temporary: boolean;
      success: boolean;
      processed: number;
      load: { enqueued: number; emptyPolls: number; completedByWindow: number[] };
      drain: { timedOut: boolean };
      jobs: { total: number; completed: number; failed: number };
      jobAttempts: { total: number; failed: number; plannedRetryObserved: boolean };
      leaseExtensions: { observed: boolean };
      foreignKeyViolations: number;
    };

    try {
      expect(soak.temporary).toBe(true);
      expect(soak.dbPath.startsWith(tmpdir())).toBe(true);
      expect(soak.dbPath).toContain('lethebot-worker-soak-');
      expect(soak.dbPath.endsWith('worker-soak.db')).toBe(true);
      expect(existsSync(soak.dbPath)).toBe(true);
      temporarySoakDir = dirname(soak.dbPath);
      expect(soak).toMatchObject({
        success: true,
        jobAttempts: {
          failed: 1,
          plannedRetryObserved: true,
        },
        leaseExtensions: {
          observed: true,
        },
        foreignKeyViolations: 0,
      });
      expect(soak.load.enqueued).toBeGreaterThanOrEqual(3);
      expect(soak.load.emptyPolls).toBe(0);
      expect(soak.load.completedByWindow.every((count) => count >= 1)).toBe(true);
      expect(soak.drain.timedOut).toBe(false);
      expect(soak.jobs.total).toBe(7 + soak.load.enqueued);
      expect(soak.jobs.completed).toBe(soak.jobs.total);
      expect(soak.jobs.failed).toBe(0);
      expect(soak.jobAttempts.total).toBe(soak.jobs.total + 1);
      expect(soak.processed).toBe(soak.jobAttempts.total);

      const soakDb = initDatabase({ path: soak.dbPath, readonly: true });
      try {
        expect(countRows(soakDb, 'jobs')).toBe(soak.jobs.total);
        expect(countRows(soakDb, 'job_attempts')).toBe(soak.jobAttempts.total);
        expect(countRows(soakDb, 'worker_heartbeats')).toBe(1);
        expect(soakDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(soakDb);
      }
    } finally {
      if (
        temporarySoakDir !== undefined
        && temporarySoakDir.startsWith(tmpdir())
        && temporarySoakDir.includes('lethebot-worker-soak-')
      ) {
        rmSync(temporarySoakDir, { recursive: true, force: true });
      }
    }
  });

  it('redacts worker-soak successful JSON display while preserving raw local DB and worker rows', () => {
    const secret = 'sk-ops-worker-soak-success-secret-should-not-leak';
    const platformId = 'qq-234567890';
    const sensitiveSoakDir = join(testDir, platformId);
    mkdirSync(sensitiveSoakDir, { recursive: true });
    const sensitiveSoakDbPath = join(sensitiveSoakDir, `worker-soak-${secret}.db`);
    const sensitiveWorkerId = `${platformId}-${secret}`;

    const soakResult = runOps([
      'worker-soak',
      `--db=${sensitiveSoakDbPath}`,
      '--duration-ms=500',
      '--interval-ms=20',
      `--worker-id=${sensitiveWorkerId}`,
    ]);

    expect(soakResult.status, soakResult.stderr).toBe(0);
    expect(soakResult.stderr).toBe('');
    expect(soakResult.stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(soakResult.stdout).toContain('[REDACTED:platform_id]');
    expect(soakResult.stdout).not.toContain(secret);
    expect(soakResult.stdout).not.toContain(platformId);
    expect(soakResult.stdout).not.toContain('234567890');
    expect(existsSync(sensitiveSoakDbPath)).toBe(true);

    const soak = JSON.parse(soakResult.stdout) as {
      dbPath: string;
      temporary: boolean;
      success: boolean;
      load: { enqueued: number; emptyPolls: number; completedByWindow: number[] };
      drain: { timedOut: boolean };
      jobs: { total: number; completed: number; failed: number };
      jobAttempts: { total: number };
      workerHeartbeat: {
        workerType: string;
        status: string;
        currentJobIdPresent: boolean;
      };
      leaseExtensions: {
        observed: boolean;
        count: number;
      };
      foreignKeyViolations: number;
    };

    expect(soak.dbPath).toContain('[REDACTED:openai_like_api_key]');
    expect(soak.dbPath).toContain('[REDACTED:platform_id]');
    expect(soak.temporary).toBe(false);
    expect(soak.success).toBe(true);
    expect(soak.load.enqueued).toBeGreaterThanOrEqual(3);
    expect(soak.load.emptyPolls).toBe(0);
    expect(soak.load.completedByWindow.every((count) => count >= 1)).toBe(true);
    expect(soak.drain.timedOut).toBe(false);
    expect(soak.jobs.total).toBe(7 + soak.load.enqueued);
    expect(soak.jobs.completed).toBe(soak.jobs.total);
    expect(soak.jobs.failed).toBe(0);
    expect(soak.jobAttempts.total).toBe(soak.jobs.total + 1);
    expect(soak.leaseExtensions.observed).toBe(true);
    expect(soak.leaseExtensions.count).toBeGreaterThanOrEqual(1);
    expect(soak.workerHeartbeat).toEqual({
      workerType: 'background',
      status: 'idle',
      currentJobIdPresent: false,
    });
    expect(soak.foreignKeyViolations).toBe(0);

    const soakDb = initDatabase({ path: sensitiveSoakDbPath, readonly: true });
    try {
      const workerRow = soakDb
        .prepare('SELECT worker_id FROM worker_heartbeats WHERE worker_id = ?')
        .get(sensitiveWorkerId) as { worker_id: string } | undefined;
      expect(workerRow?.worker_id).toBe(sensitiveWorkerId);
      expect(countRows(soakDb, 'jobs')).toBe(soak.jobs.total);
      expect(countRows(soakDb, 'job_attempts')).toBe(soak.jobAttempts.total);
      expect(countRows(soakDb, 'worker_heartbeats')).toBe(1);
      expect(soakDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(soakDb);
    }
  });

  it('exits non-zero with redacted aggregate evidence when worker-soak stays unhealthy', () => {
    const secret = 'sk-ops-worker-soak-unhealthy-secret-should-not-leak';
    const platformId = 'qq-345678901';
    const sensitiveSoakDir = join(testDir, platformId);
    mkdirSync(sensitiveSoakDir, { recursive: true });
    const sensitiveSoakDbPath = join(sensitiveSoakDir, `worker-soak-${secret}.db`);

    const result = runOps([
      'worker-soak',
      `--db=${sensitiveSoakDbPath}`,
      '--duration-ms=1',
      '--interval-ms=1000',
      `--worker-id=${platformId}-${secret}`,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(result.stdout).toContain('[REDACTED:platform_id]');
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(platformId);
    expect(result.stdout).not.toContain('345678901');
    expect(existsSync(sensitiveSoakDbPath)).toBe(true);

    const soak = JSON.parse(result.stdout) as {
      success: boolean;
      ticks: number;
      processed: number;
      jobs: {
        total: number;
        pending: number;
        completed: number;
        failed: number;
      };
      jobAttempts: {
        total: number;
        running: number;
        completed: number;
        failed: number;
        plannedRetryObserved: boolean;
      };
      leaseExtensions: {
        observed: boolean;
        count: number;
      };
      workerHeartbeat: null | {
        status: string;
        currentJobIdPresent: boolean;
      };
      foreignKeyViolations: number;
    };

    expect(soak.success).toBe(false);
    expect(soak.ticks).toBe(0);
    expect(soak.processed).toBe(0);
    expect(soak.jobs).toMatchObject({
      total: 7,
      pending: 7,
      completed: 0,
      failed: 0,
    });
    expect(soak.jobAttempts).toMatchObject({
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
      plannedRetryObserved: false,
    });
    expect(soak.leaseExtensions).toEqual({
      observed: false,
      count: 0,
    });
    expect(soak.workerHeartbeat).toBeNull();
    expect(soak.foreignKeyViolations).toBe(0);

    const soakDb = initDatabase({ path: sensitiveSoakDbPath, readonly: true });
    try {
      expect(countRows(soakDb, 'jobs')).toBe(7);
      expect(countRows(soakDb, 'job_attempts')).toBe(0);
      expect(countRows(soakDb, 'worker_heartbeats')).toBe(0);
      expect(soakDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(soakDb);
    }
  });

  it('redacts successful ops JSON display paths without changing raw file operations', () => {
    const now = Date.UTC(2026, 6, 3);
    insertRawEvent('evt-ops-redacted-success', now);
    closeDatabase(db);

    const secret = 'sk-ops-success-output-secret-should-not-leak';
    const platformId = 'qq-123456789';
    const sensitiveBackupPath = join(testDir, platformId, `backup-${secret}.db`);

    const backupResult = runOps([
      'backup',
      `--db=${dbPath}`,
      `--out=${sensitiveBackupPath}`,
    ]);

    expect(backupResult.status, backupResult.stderr).toBe(0);
    expect(backupResult.stderr).toBe('');
    expect(backupResult.stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(backupResult.stdout).toContain('[REDACTED:platform_id]');
    expect(backupResult.stdout).not.toContain(secret);
    expect(backupResult.stdout).not.toContain(platformId);
    expect(backupResult.stdout).not.toContain('123456789');
    expect(existsSync(sensitiveBackupPath)).toBe(true);

    const backup = JSON.parse(backupResult.stdout) as {
      integrityOk: boolean;
      backupPath: string;
      backupSizeBytes: number;
    };
    expect(backup.integrityOk).toBe(true);
    expect(backup.backupPath).toContain('[REDACTED:openai_like_api_key]');
    expect(backup.backupPath).toContain('[REDACTED:platform_id]');
    expect(backup.backupSizeBytes).toBeGreaterThan(0);

    const restoredPath = join(testDir, platformId, `restored-${secret}.db`);
    const restoreResult = runOps([
      'restore',
      `--backup=${sensitiveBackupPath}`,
      `--db=${restoredPath}`,
    ]);

    expect(restoreResult.status, restoreResult.stderr).toBe(0);
    expect(restoreResult.stderr).toBe('');
    expect(restoreResult.stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(restoreResult.stdout).toContain('[REDACTED:platform_id]');
    expect(restoreResult.stdout).not.toContain(secret);
    expect(restoreResult.stdout).not.toContain(platformId);
    expect(restoreResult.stdout).not.toContain('123456789');
    expect(existsSync(restoredPath)).toBe(true);

    const restored = initDatabase({ path: restoredPath, readonly: true });
    try {
      expect(countRows(restored, 'raw_events')).toBe(1);
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(restored);
    }
  });

  it('redacts embedded platform identifiers in ops JSON paths and parser errors without mutating data', () => {
    const now = Date.UTC(2026, 6, 3);
    insertRawEvent('evt-ops-embedded-platform-display', now);
    closeDatabase(db);

    const secret = 'sk-ops-embedded-platform-secret-should-not-leak';
    const embeddedPrefixedPlatformId = 'legacy_qq-123456789';
    const embeddedNumericPlatformId = 'legacy_987654321';
    const sensitiveBackupPath = join(
      testDir,
      embeddedPrefixedPlatformId,
      `backup-${embeddedNumericPlatformId}-${secret}.db`,
    );

    const backupResult = runOps([
      'backup',
      `--db=${dbPath}`,
      `--out=${sensitiveBackupPath}`,
    ]);

    expect(backupResult.status, backupResult.stderr).toBe(0);
    expect(backupResult.stderr).toBe('');
    expect(backupResult.stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(backupResult.stdout).toContain('[REDACTED:platform_id]');
    expect(backupResult.stdout).not.toContain(secret);
    expect(backupResult.stdout).not.toContain(embeddedPrefixedPlatformId);
    expect(backupResult.stdout).not.toContain(embeddedNumericPlatformId);
    expect(backupResult.stdout).not.toContain('legacy_qq-');
    expect(backupResult.stdout).not.toContain('123456789');
    expect(backupResult.stdout).not.toContain('987654321');
    expect(existsSync(sensitiveBackupPath)).toBe(true);

    const backup = JSON.parse(backupResult.stdout) as {
      integrityOk: boolean;
      backupPath: string;
      backupSizeBytes: number;
    };
    expect(backup.integrityOk).toBe(true);
    expect(backup.backupPath).toContain('[REDACTED:openai_like_api_key]');
    expect(backup.backupPath).toContain('[REDACTED:platform_id]');
    expect(backup.backupSizeBytes).toBeGreaterThan(0);

    const invalidFormat = runOps([
      'metrics',
      `--db=${dbPath}`,
      `--format=${secret}+${embeddedPrefixedPlatformId}+${embeddedNumericPlatformId}`,
    ]);
    expect(invalidFormat.status).toBe(1);
    expect(invalidFormat.stdout).toBe('');
    expect(invalidFormat.stderr).toContain('Invalid --format:');
    expect(invalidFormat.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(invalidFormat.stderr).toContain('[REDACTED:platform_id]');
    expect(invalidFormat.stderr).not.toContain(secret);
    expect(invalidFormat.stderr).not.toContain(embeddedPrefixedPlatformId);
    expect(invalidFormat.stderr).not.toContain(embeddedNumericPlatformId);
    expect(invalidFormat.stderr).not.toContain('legacy_qq-');
    expect(invalidFormat.stderr).not.toContain('123456789');
    expect(invalidFormat.stderr).not.toContain('987654321');
    expect(invalidFormat.stderr).not.toContain('src/scripts');
    expect(invalidFormat.stderr).not.toContain('\n    at ');

    reopenDb(true);
    expect(countRows(db, 'raw_events')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts adjacent secret/platform identifiers in ops JSON paths and parser errors without mutating data', () => {
    const now = Date.UTC(2026, 6, 3);
    insertRawEvent('evt-ops-adjacent-platform-display', now);
    closeDatabase(db);

    const adjacentSecretPlatform = 'sk-ops-adjacent-display-secret-qq-975318642';
    const sensitiveBackupPath = join(testDir, `backup-${adjacentSecretPlatform}.db`);

    const backupResult = runOps([
      'backup',
      `--db=${dbPath}`,
      `--out=${sensitiveBackupPath}`,
    ]);

    expect(backupResult.status, backupResult.stderr).toBe(0);
    expect(backupResult.stderr).toBe('');
    expect(backupResult.stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(backupResult.stdout).toContain('[REDACTED:platform_id]');
    expect(backupResult.stdout).not.toContain(adjacentSecretPlatform);
    expect(backupResult.stdout).not.toContain('qq-975318642');
    expect(backupResult.stdout).not.toContain('975318642');
    expect(existsSync(sensitiveBackupPath)).toBe(true);

    const backup = JSON.parse(backupResult.stdout) as {
      integrityOk: boolean;
      backupPath: string;
      backupSizeBytes: number;
    };
    expect(backup.integrityOk).toBe(true);
    expect(backup.backupPath).toContain('[REDACTED:openai_like_api_key]');
    expect(backup.backupPath).toContain('[REDACTED:platform_id]');
    expect(backup.backupSizeBytes).toBeGreaterThan(0);

    const invalidFormat = runOps([
      'metrics',
      `--db=${dbPath}`,
      `--format=${adjacentSecretPlatform}`,
    ]);
    expect(invalidFormat.status).toBe(1);
    expect(invalidFormat.stdout).toBe('');
    expect(invalidFormat.stderr).toContain('Invalid --format:');
    expect(invalidFormat.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(invalidFormat.stderr).toContain('[REDACTED:platform_id]');
    expect(invalidFormat.stderr).not.toContain(adjacentSecretPlatform);
    expect(invalidFormat.stderr).not.toContain('qq-975318642');
    expect(invalidFormat.stderr).not.toContain('975318642');
    expect(invalidFormat.stderr).not.toContain('src/scripts');
    expect(invalidFormat.stderr).not.toContain('\n    at ');

    reopenDb(true);
    expect(countRows(db, 'raw_events')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves assignment-shaped adjacent markers in ops JSON paths and parser errors without mutating data', () => {
    const now = Date.UTC(2026, 6, 3);
    insertRawEvent('evt-ops-assignment-adjacent-display', now);
    closeDatabase(db);

    const rawAssignment = 'api_key=sk-ops-assignment-display-secret-qq-975318642';
    const rawSecret = 'sk-ops-assignment-display-secret-qq-975318642';
    const rawPlatformId = 'qq-975318642';
    const sensitiveBackupPath = join(testDir, `backup-${rawAssignment}.db`);

    const backupResult = runOps([
      'backup',
      `--db=${dbPath}`,
      `--out=${sensitiveBackupPath}`,
    ]);

    expect(backupResult.status, backupResult.stderr).toBe(0);
    expect(backupResult.stderr).toBe('');
    expect(backupResult.stdout).toContain('[REDACTED:api_key_assignment]');
    expect(backupResult.stdout).toContain('[REDACTED:platform_id]');
    expect(backupResult.stdout).not.toContain(rawAssignment);
    expect(backupResult.stdout).not.toContain(rawSecret);
    expect(backupResult.stdout).not.toContain(rawPlatformId);
    expect(backupResult.stdout).not.toContain('975318642');
    expect(existsSync(sensitiveBackupPath)).toBe(true);

    const backup = JSON.parse(backupResult.stdout) as {
      integrityOk: boolean;
      backupPath: string;
      backupSizeBytes: number;
    };
    expect(backup.integrityOk).toBe(true);
    expect(backup.backupPath).toContain('[REDACTED:api_key_assignment]');
    expect(backup.backupPath).toContain('[REDACTED:platform_id]');
    expect(backup.backupSizeBytes).toBeGreaterThan(0);

    const invalidFormat = runOps([
      'metrics',
      `--db=${dbPath}`,
      `--format=${rawAssignment}`,
    ]);
    expect(invalidFormat.status).toBe(1);
    expect(invalidFormat.stdout).toBe('');
    expect(invalidFormat.stderr).toContain('Invalid --format:');
    expect(invalidFormat.stderr).toContain('[REDACTED:api_key_assignment]');
    expect(invalidFormat.stderr).toContain('[REDACTED:platform_id]');
    expect(invalidFormat.stderr).not.toContain(rawAssignment);
    expect(invalidFormat.stderr).not.toContain(rawSecret);
    expect(invalidFormat.stderr).not.toContain(rawPlatformId);
    expect(invalidFormat.stderr).not.toContain('975318642');
    expect(invalidFormat.stderr).not.toContain('src/scripts');
    expect(invalidFormat.stderr).not.toContain('\n    at ');

    reopenDb(true);
    expect(countRows(db, 'raw_events')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts sensitive paths in low-level ops file errors without mutating data', () => {
    const now = Date.UTC(2026, 6, 6);
    insertRawEvent('evt-ops-file-error-redaction', now);

    const secret = 'sk-ops-file-error-secret-should-not-leak';
    const platformId = 'qq-123456789';
    const sensitiveDir = join(testDir, platformId);
    mkdirSync(sensitiveDir, { recursive: true });
    const missingSourcePath = join(sensitiveDir, `missing-source-${secret}.db`);
    const unusedBackupPath = join(testDir, 'unused-backup.db');

    const missingSource = runOps([
      'backup',
      `--db=${missingSourcePath}`,
      `--out=${unusedBackupPath}`,
    ]);
    expect(missingSource.status).toBe(1);
    expect(missingSource.stdout).toBe('');
    expect(missingSource.stderr).toContain('Source database does not exist:');
    expect(missingSource.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(missingSource.stderr).toContain('[REDACTED:platform_id]');
    expect(missingSource.stderr).not.toContain(secret);
    expect(missingSource.stderr).not.toContain(platformId);
    expect(missingSource.stderr).not.toContain('123456789');
    expect(missingSource.stderr).not.toContain('src/scripts');
    expect(missingSource.stderr).not.toContain('\n    at ');

    const corruptSourcePath = join(sensitiveDir, `corrupt-source-${secret}.db`);
    const corruptBackupOutputPath = join(testDir, 'corrupt-source-backup-output.db');
    writeFileSync(corruptSourcePath, 'not a sqlite database');
    const corruptSource = runOps([
      'backup',
      `--db=${corruptSourcePath}`,
      `--out=${corruptBackupOutputPath}`,
    ]);
    expect(corruptSource.status).toBe(1);
    expect(corruptSource.stdout).toBe('');
    expect(corruptSource.stderr).toContain('file is not a database');
    expect(corruptSource.stderr).not.toContain(secret);
    expect(corruptSource.stderr).not.toContain(platformId);
    expect(corruptSource.stderr).not.toContain('123456789');
    expect(corruptSource.stderr).not.toContain(corruptSourcePath);
    expect(corruptSource.stderr).not.toContain(corruptBackupOutputPath);
    expect(corruptSource.stderr).not.toContain('src/scripts');
    expect(corruptSource.stderr).not.toContain('\n    at ');
    expect(existsSync(corruptBackupOutputPath)).toBe(false);

    const corruptRetentionPath = join(sensitiveDir, `corrupt-retention-${secret}.db`);
    writeFileSync(corruptRetentionPath, 'not a sqlite database');
    const corruptRetention = runOps([
      'retention',
      `--db=${corruptRetentionPath}`,
      '--raw-days=1',
    ]);
    expect(corruptRetention.status).toBe(1);
    expect(corruptRetention.stdout).toBe('');
    expect(corruptRetention.stderr).toContain('file is not a database');
    expect(corruptRetention.stderr).not.toContain(secret);
    expect(corruptRetention.stderr).not.toContain(platformId);
    expect(corruptRetention.stderr).not.toContain('123456789');
    expect(corruptRetention.stderr).not.toContain(corruptRetentionPath);
    expect(corruptRetention.stderr).not.toContain('src/scripts');
    expect(corruptRetention.stderr).not.toContain('\n    at ');

    const corruptMetricsPath = join(sensitiveDir, `corrupt-metrics-${secret}.db`);
    writeFileSync(corruptMetricsPath, 'not a sqlite database');
    const corruptMetrics = runOps([
      'metrics',
      `--db=${corruptMetricsPath}`,
    ]);
    expect(corruptMetrics.status).toBe(1);
    expect(corruptMetrics.stdout).toBe('');
    expect(corruptMetrics.stderr).toContain('file is not a database');
    expect(corruptMetrics.stderr).not.toContain(secret);
    expect(corruptMetrics.stderr).not.toContain(platformId);
    expect(corruptMetrics.stderr).not.toContain('123456789');
    expect(corruptMetrics.stderr).not.toContain(corruptMetricsPath);
    expect(corruptMetrics.stderr).not.toContain('src/scripts');
    expect(corruptMetrics.stderr).not.toContain('\n    at ');

    const backupPath = join(testDir, 'file-error-source.backup.db');
    expectSuccessfulOps(['backup', `--db=${dbPath}`, `--out=${backupPath}`]);

    const sensitiveTargetPath = join(sensitiveDir, `existing-target-${secret}.db`);
    writeFileSync(sensitiveTargetPath, 'existing target marker');
    const existingTarget = runOps([
      'restore',
      `--backup=${backupPath}`,
      `--db=${sensitiveTargetPath}`,
    ]);
    expect(existingTarget.status).toBe(1);
    expect(existingTarget.stdout).toBe('');
    expect(existingTarget.stderr).toContain('Target database already exists:');
    expect(existingTarget.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(existingTarget.stderr).toContain('[REDACTED:platform_id]');
    expect(existingTarget.stderr).not.toContain(secret);
    expect(existingTarget.stderr).not.toContain(platformId);
    expect(existingTarget.stderr).not.toContain('123456789');
    expect(existingTarget.stderr).not.toContain('src/scripts');
    expect(existingTarget.stderr).not.toContain('\n    at ');

    const corruptBackupPath = join(sensitiveDir, `corrupt-backup-${secret}.db`);
    const corruptRestoreTarget = join(testDir, 'corrupt-restore-target.db');
    writeFileSync(corruptBackupPath, 'not a sqlite database');
    const corruptBackup = runOps([
      'restore',
      `--backup=${corruptBackupPath}`,
      `--db=${corruptRestoreTarget}`,
    ]);
    expect(corruptBackup.status).toBe(1);
    expect(corruptBackup.stdout).toBe('');
    expect(corruptBackup.stderr).toContain('file is not a database');
    expect(corruptBackup.stderr).not.toContain(secret);
    expect(corruptBackup.stderr).not.toContain(platformId);
    expect(corruptBackup.stderr).not.toContain('123456789');
    expect(corruptBackup.stderr).not.toContain(corruptBackupPath);
    expect(corruptBackup.stderr).not.toContain(corruptRestoreTarget);
    expect(corruptBackup.stderr).not.toContain('src/scripts');
    expect(corruptBackup.stderr).not.toContain('\n    at ');
    expect(existsSync(corruptRestoreTarget)).toBe(false);

    const invalidForeignKeyBackupPath = join(
      sensitiveDir,
      `invalid-fk-backup-${secret}-${platformId}.db`,
    );
    const invalidForeignKeyDb = initDatabase({ path: invalidForeignKeyBackupPath });
    try {
      runMigration(invalidForeignKeyDb, join(process.cwd(), 'migrations/001_initial_schema.sql'));
      invalidForeignKeyDb.pragma('foreign_keys = OFF');
      invalidForeignKeyDb.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id,
          conversation_type, sender_id, text, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'orphan-cli-chat-message',
        'missing-cli-raw-event',
        'orphan-cli-platform-message',
        'private:test',
        'private',
        'test-user',
        'orphan',
        now,
      );
    } finally {
      closeDatabase(invalidForeignKeyDb);
    }

    const invalidForeignKeyRestore = runOps([
      'restore',
      `--backup=${invalidForeignKeyBackupPath}`,
      `--db=${dbPath}`,
      '--overwrite',
    ]);
    expect(invalidForeignKeyRestore.status).toBe(1);
    expect(invalidForeignKeyRestore.stdout).toBe('');
    expect(invalidForeignKeyRestore.stderr).toContain('foreign key check failed: 1 violation');
    expect(invalidForeignKeyRestore.stderr).not.toContain(secret);
    expect(invalidForeignKeyRestore.stderr).not.toContain(platformId);
    expect(invalidForeignKeyRestore.stderr).not.toContain('123456789');
    expect(invalidForeignKeyRestore.stderr).not.toContain(invalidForeignKeyBackupPath);
    expect(invalidForeignKeyRestore.stderr).not.toContain(dbPath);
    expect(invalidForeignKeyRestore.stderr).not.toContain('src/scripts');
    expect(invalidForeignKeyRestore.stderr).not.toContain('\n    at ');
    expect(readdirSync(testDir).filter((entry) => entry.startsWith('.lethebot-restore-'))).toEqual([]);

    reopenDb(true);
    expect(countRows(db, 'raw_events')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects malformed and unsafe ops commands without mutating persisted data', () => {
    const now = Date.UTC(2026, 6, 3);
    insertRawEvent('evt-ops-negative', now);

    expectFailedOps(['backup', `--db=${dbPath}`], 'Missing required --out');
    expectFailedOps(['metrics', `--db=${dbPath}`, '--since=not-a-date'], 'Invalid --since date: not-a-date');
    expectFailedOps(['retention', `--db=${dbPath}`, '--raw-days=-1'], 'Invalid --raw-days: -1');
    expectFailedOps(['worker-soak', '--duration-ms=0'], 'Invalid --duration-ms: 0');
    expectFailedOps(['metrics', `--db=${dbPath}`, '--since'], 'Missing value for --since');
    expectFailedOps(
      ['rehearse-maintenance', `--db=${dbPath}`],
      `Rehearsal database already exists: ${dbPath}`,
    );
    expectFailedOps(
      ['rehearse-rollback', `--db=${dbPath}`],
      `Rollback rehearsal database already exists: ${dbPath}`,
    );

    const secret = 'sk-ops-maintenance-secret-should-not-leak';
    const platformId = 'qq-123456789';
    const secretLikeInvalidSince = `${secret}+${platformId}`;
    const redactedUnknownCommand = runOps([`${secret}+${platformId}`, `--db=${dbPath}`]);
    expect(redactedUnknownCommand.status).toBe(1);
    expect(redactedUnknownCommand.stdout).toBe('');
    expect(redactedUnknownCommand.stderr).toContain('Unknown command:');
    expect(redactedUnknownCommand.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(redactedUnknownCommand.stderr).toContain('[REDACTED:platform_id]');
    expect(redactedUnknownCommand.stderr).not.toContain(secret);
    expect(redactedUnknownCommand.stderr).not.toContain(platformId);
    expect(redactedUnknownCommand.stderr).not.toContain('src/scripts');
    expect(redactedUnknownCommand.stderr).not.toContain('\n    at ');

    const redactedInvalidSince = runOps([
      'metrics',
      `--db=${dbPath}`,
      `--since=${secretLikeInvalidSince}`,
    ]);
    expect(redactedInvalidSince.status).toBe(1);
    expect(redactedInvalidSince.stdout).toBe('');
    expect(redactedInvalidSince.stderr).toContain('Invalid --since date:');
    expect(redactedInvalidSince.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(redactedInvalidSince.stderr).toContain('[REDACTED:platform_id]');
    expect(redactedInvalidSince.stderr).not.toContain(secret);
    expect(redactedInvalidSince.stderr).not.toContain(platformId);
    expect(redactedInvalidSince.stderr).not.toContain('src/scripts');
    expect(redactedInvalidSince.stderr).not.toContain('\n    at ');

    const redactedInvalidRetentionDays = runOps([
      'retention',
      `--db=${dbPath}`,
      `--event-failure-days=${secretLikeInvalidSince}`,
    ]);
    expect(redactedInvalidRetentionDays.status).toBe(1);
    expect(redactedInvalidRetentionDays.stdout).toBe('');
    expect(redactedInvalidRetentionDays.stderr).toContain('Invalid --event-failure-days:');
    expect(redactedInvalidRetentionDays.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(redactedInvalidRetentionDays.stderr).toContain('[REDACTED:platform_id]');
    expect(redactedInvalidRetentionDays.stderr).not.toContain(secret);
    expect(redactedInvalidRetentionDays.stderr).not.toContain(platformId);
    expect(redactedInvalidRetentionDays.stderr).not.toContain('src/scripts');
    expect(redactedInvalidRetentionDays.stderr).not.toContain('\n    at ');

    const redactedUnexpectedPositional = runOps([
      'metrics',
      `--db=${dbPath}`,
      `${secret}+${platformId}`,
    ]);
    expect(redactedUnexpectedPositional.status).toBe(1);
    expect(redactedUnexpectedPositional.stdout).toBe('');
    expect(redactedUnexpectedPositional.stderr).toContain('Unexpected positional argument:');
    expect(redactedUnexpectedPositional.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(redactedUnexpectedPositional.stderr).toContain('[REDACTED:platform_id]');
    expect(redactedUnexpectedPositional.stderr).not.toContain(secret);
    expect(redactedUnexpectedPositional.stderr).not.toContain(platformId);
    expect(redactedUnexpectedPositional.stderr).not.toContain('src/scripts');
    expect(redactedUnexpectedPositional.stderr).not.toContain('\n    at ');

    const redactedUnknownOption = runOps([
      'metrics',
      `--db=${dbPath}`,
      `--${platformId}=1`,
    ]);
    expect(redactedUnknownOption.status).toBe(1);
    expect(redactedUnknownOption.stdout).toBe('');
    expect(redactedUnknownOption.stderr).toContain('Unknown option --[REDACTED:platform_id]');
    expect(redactedUnknownOption.stderr).not.toContain(platformId);
    expect(redactedUnknownOption.stderr).not.toContain('src/scripts');
    expect(redactedUnknownOption.stderr).not.toContain('\n    at ');

    const redactedFlagValue = runOps([
      'restore',
      `--backup=${dbPath}`,
      `--db=${join(testDir, 'restore-flag-value.db')}`,
      `--overwrite=${secret}`,
    ]);
    expect(redactedFlagValue.status).toBe(1);
    expect(redactedFlagValue.stdout).toBe('');
    expect(redactedFlagValue.stderr).toBe('Option --overwrite does not take a value');
    expect(redactedFlagValue.stderr).not.toContain(secret);
    expect(redactedFlagValue.stderr).not.toContain('src/scripts');
    expect(redactedFlagValue.stderr).not.toContain('\n    at ');

    const redactedInvalidFormat = runOps([
      'metrics',
      `--db=${dbPath}`,
      `--format=${secret}+${platformId}`,
    ]);
    expect(redactedInvalidFormat.status).toBe(1);
    expect(redactedInvalidFormat.stdout).toBe('');
    expect(redactedInvalidFormat.stderr).toContain('Invalid --format:');
    expect(redactedInvalidFormat.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(redactedInvalidFormat.stderr).toContain('[REDACTED:platform_id]');
    expect(redactedInvalidFormat.stderr).not.toContain(secret);
    expect(redactedInvalidFormat.stderr).not.toContain(platformId);
    expect(redactedInvalidFormat.stderr).not.toContain('src/scripts');
    expect(redactedInvalidFormat.stderr).not.toContain('\n    at ');

    const redactedInvalidWorkerSoakDuration = runOps([
      'worker-soak',
      `--duration-ms=${secret}+${platformId}`,
      '--interval-ms=10',
    ]);
    expect(redactedInvalidWorkerSoakDuration.status).toBe(1);
    expect(redactedInvalidWorkerSoakDuration.stdout).toBe('');
    expect(redactedInvalidWorkerSoakDuration.stderr).toContain('Invalid --duration-ms:');
    expect(redactedInvalidWorkerSoakDuration.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(redactedInvalidWorkerSoakDuration.stderr).toContain('[REDACTED:platform_id]');
    expect(redactedInvalidWorkerSoakDuration.stderr).not.toContain(secret);
    expect(redactedInvalidWorkerSoakDuration.stderr).not.toContain(platformId);
    expect(redactedInvalidWorkerSoakDuration.stderr).not.toContain('src/scripts');
    expect(redactedInvalidWorkerSoakDuration.stderr).not.toContain('\n    at ');

    const redactedInvalidWorkerSoakInterval = runOps([
      'worker-soak',
      '--duration-ms=10',
      `--interval-ms=${secret}+${platformId}`,
    ]);
    expect(redactedInvalidWorkerSoakInterval.status).toBe(1);
    expect(redactedInvalidWorkerSoakInterval.stdout).toBe('');
    expect(redactedInvalidWorkerSoakInterval.stderr).toContain('Invalid --interval-ms:');
    expect(redactedInvalidWorkerSoakInterval.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(redactedInvalidWorkerSoakInterval.stderr).toContain('[REDACTED:platform_id]');
    expect(redactedInvalidWorkerSoakInterval.stderr).not.toContain(secret);
    expect(redactedInvalidWorkerSoakInterval.stderr).not.toContain(platformId);
    expect(redactedInvalidWorkerSoakInterval.stderr).not.toContain('src/scripts');
    expect(redactedInvalidWorkerSoakInterval.stderr).not.toContain('\n    at ');

    reopenDb(true);
    expect(countRows(db, 'raw_events')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    const backupPath = join(testDir, 'negative.backup.db');
    expectSuccessfulOps(['backup', '--db', dbPath, '--out', backupPath]);

    const restoredPath = join(testDir, 'restore-existing.db');
    expectSuccessfulOps(['restore', `--backup=${backupPath}`, `--db=${restoredPath}`]);
    expectFailedOps(
      ['restore', `--backup=${backupPath}`, `--db=${restoredPath}`],
      `Target database already exists: ${restoredPath}`,
    );

    const restored = initDatabase({ path: restoredPath, readonly: true });
    try {
      expect(countRows(restored, 'raw_events')).toBe(1);
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(restored);
    }
  });

  function seedOperationalRows(old: number, recent: number): void {
    insertRawEvent('evt-old', old);
    insertRawEvent('evt-recent', recent);
    insertChatMessage('msg-old', 'evt-old', old);
    insertChatMessage('msg-recent', 'evt-recent', recent);
    insertAgentTurn('turn-ops', 'evt-recent', recent);
    insertContextTrace('ctx-ops', 'turn-ops', recent);
    insertActionDecision('decision-ops', 'turn-ops', recent);
    insertActionExecution('execution-ops', 'decision-ops', recent);
    insertToolCall('tool-ops', 'turn-ops', recent);
    insertJob('job-ops', recent);
    insertJobAttempt('attempt-ops', 'job-ops', recent);
    insertWorkerHeartbeat('worker-ops', recent);
    insertEventProcessingFailure('failure-old', 'evt-old', undefined, old);
    insertEventProcessingFailure('failure-recent', 'evt-recent', 'turn-ops', recent);
    insertAudit('audit-old', old);
    insertAudit('audit-recent', recent);
    insertMemory('mem-old-deleted', 'deleted', old);
    insertMemory('mem-recent-active', 'active', recent);
    db.prepare(
      `INSERT INTO memory_sources (
        memory_id, source_type, source_id, source_timestamp, extracted_by
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('mem-old-deleted', 'raw_event', 'evt-old', old, 'test');
    db.prepare(
      `INSERT INTO memory_revisions (
        id, memory_id, revision_number, change_type, previous_state, new_state,
        reason, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('rev-old-deleted', 'mem-old-deleted', 1, 'delete', null, '{}', 'test', 'admin', old);
  }

  function insertRawEvent(id: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, 'chat.message.received', timestamp, 'gateway', 'qq', 'private:qq-ops', '{}', timestamp);
  }

  function insertChatMessage(id: string, rawEventId: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, rawEventId, id, 'private:qq-ops', 'private', 'qq-ops', 'hello', timestamp);
  }

  function insertAgentTurn(id: string, triggerEventId: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, response_text, status,
        tokens_input, tokens_output, tokens_total, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      'private:qq-ops',
      triggerEventId,
      'ctx-ops',
      'mock',
      'mock',
      'ok',
      'completed',
      3,
      4,
      7,
      timestamp,
      timestamp,
    );
  }

  function insertContextTrace(id: string, turnId: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      turnId,
      'private:qq-ops',
      'private',
      null,
      '[]',
      '[]',
      '[]',
      '[]',
      '[]',
      '[]',
      JSON.stringify({ max: 8000, used: 0, breakdown: { recentMessages: 0, memory: 0, identity: 0, system: 0 } }),
      '[]',
      timestamp,
    );
  }

  function insertActionDecision(id: string, turnId: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, turnId, 'evaluator', 'medium', 0.9, 1, 1, '[]', '[]', '[]', timestamp);
  }

  function insertActionExecution(id: string, decisionId: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status, audit_level, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, decisionId, 'reply_full', 'success', 'summary', timestamp);
  }

  function insertToolCall(id: string, turnId: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_class, invocation_context, status,
        execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, turnId, 'test.tool', '{}', '{}', 'pi', 'user', 'private_chat', 'success', 12, 1, timestamp);
  }

  function insertJob(id: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        lease_owner, lease_expires_at, created_at, updated_at, scheduled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      'summary',
      '{}',
      'running',
      1,
      3,
      'worker-ops',
      timestamp - 1,
      timestamp,
      timestamp,
      timestamp,
    );
  }

  function insertJobAttempt(id: string, jobId: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO job_attempts (
        id, job_id, attempt_number, worker_id, status,
        started_at, completed_at, heartbeat_at, error, result
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      jobId,
      1,
      'worker-ops',
      'running',
      timestamp,
      null,
      timestamp,
      null,
      null,
    );
  }

  function insertWorkerHeartbeat(id: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO worker_heartbeats (
        worker_id, worker_type, status, heartbeat_at, details
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(id, 'background', 'idle', timestamp, '{}');
  }

  function insertEventProcessingFailure(
    id: string,
    rawEventId: string,
    turnId: string | undefined,
    timestamp: number,
  ): void {
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, message_id_hash, sender_id_hash,
        conversation_id_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      rawEventId,
      turnId ?? null,
      timestamp,
      'pi_inference',
      'private',
      'Error',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      JSON.stringify({ redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error' }),
    );
  }

  function insertAudit(id: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, redacted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, timestamp, 'system', 'summary', 'policy.test', id, 'system', 'system', 'test audit', 0);
  }

  function insertMemory(id: string, state: 'active' | 'deleted', timestamp: number): void {
    db.prepare(
      `INSERT INTO memory_records (
        id, scope, visibility, sensitivity, authority,
        kind, title, content, state, confidence, importance,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, 'system', 'owner_admin_only', 'normal', 'system', 'fact', id, 'content', state, 0.9, 0.5, timestamp, timestamp);
  }

  function countRows(targetDb: Database.Database, tableName: string): number {
    const row = targetDb.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    return row.count;
  }
});
