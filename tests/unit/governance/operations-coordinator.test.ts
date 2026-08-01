import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as operationsDoctor from '../../../src/operations/doctor.js';
import * as sqliteMaintenance from '../../../src/operations/sqlite-maintenance.js';
import type {
  OperationsDoctorConfig,
  OperationsDoctorResult,
} from '../../../src/operations/doctor.js';
import {
  GovernanceOperationsCoordinator,
  projectSqliteBackupForGovernance,
  type GovernanceOperationsStatus,
} from '../../../src/governance/operations-coordinator.js';
import {
  closeDatabase,
  initDatabase,
  runMigrations,
} from '../../../src/storage/database.js';
import { AuditRepository } from '../../../src/storage/audit-repository.js';

const db = {} as Database.Database;
const dbPath = '/srv/lethebot/private/lethebot.db';
const secret = 'sk-operations-secret-abcdefghijklmnopqrstuvwxyz';
const platformId = '123456789';
const config: OperationsDoctorConfig = {
  onebotTransport: 'ws',
  onebotHttpUrl: `https://onebot.example/${secret}/${platformId}`,
  onebotWsUrl: `wss://onebot.example/${secret}/${platformId}`,
  onebotToken: secret,
  onebotBotQqId: platformId,
  lethebotHost: '127.0.0.1',
  lethebotPort: 6700,
  lethebotHealthPath: '/healthz',
  lethebotReadinessPath: '/readyz',
  lethebotMetricsPath: '/metrics',
  lethebotEventPath: '/onebot/event',
  rawEventRetentionDays: 90,
  chatMessageRetentionDays: 30,
  auditLogRetentionDays: 180,
  disabledDeletedMemoryRetentionDays: 365,
  eventProcessingFailureRetentionDays: 14,
};

const counts = {
  raw_events: 1,
  event_ingress_receipts: 2,
  event_processing_admissions: 3,
  chat_messages: 4,
  event_processing_failures: 5,
  agent_turns: 6,
  context_traces: 7,
  action_decisions: 8,
  action_executions: 9,
  memory_records: 10,
  memory_sources: 11,
  memory_revisions: 12,
  tool_calls: 13,
  audit_log: 14,
  jobs: 15,
  job_attempts: 16,
  worker_heartbeats: 17,
};

type ExpectedBackupPreview = {
  action: 'create_verified_backup';
  currentState: 'available';
  contractVersion: 1;
  effects: {
    databaseMutation: false;
    privateArtifactCreation: true;
    integrityVerification: true;
    destinationOverwrite: false;
  };
  restore: {
    availableAfterCompletion: true;
    executionBoundary: 'stopped_service_only';
  };
  rollback: {
    available: false;
    reason: 'artifact_removal_not_exposed';
  };
  previewDigest: string;
};

type ExpectedRestoreHandoffPreview = {
  action: 'prepare_restore_handoff';
  currentState: 'verified_backup_available';
  contractVersion: 1;
  artifact: {
    integrity: 'verified';
    sizeBytes: number;
  };
  effects: {
    databaseMutation: false;
    artifactMutation: false;
    restoreExecution: false;
    serviceStopRequired: true;
  };
  restore: {
    available: true;
    executionBoundary: 'stopped_service_only';
  };
  rollback: {
    available: false;
    reason: 'no_in_process_effect';
  };
  previewDigest: string;
};

function doctorResult(overrides: Partial<OperationsDoctorResult> = {}): OperationsDoctorResult {
  const result: OperationsDoctorResult = {
    generatedAt: '2026-07-28T05:00:00.000Z',
    overall: 'ok',
    database: {
      dbPath,
      open: true,
      readonly: true,
      integrityOk: true,
      integrityResult: 'ok',
      foreignKeyViolations: 0,
    },
    schema: {
      ready: true,
      requiredTablesPresent: 34,
      requiredTablesTotal: 34,
      missingTables: [],
    },
    counts,
    configuration: {
      oneBot: {
        transport: config.onebotTransport,
        httpUrlConfigured: true,
        wsUrlConfigured: true,
        tokenConfigured: true,
        botIdConfigured: true,
      },
      server: {
        hostConfigured: true,
        portConfigured: true,
        healthPathConfigured: true,
        readinessPathConfigured: true,
        metricsPathConfigured: true,
        eventPathConfigured: true,
      },
      retentionDays: {
        rawEvents: config.rawEventRetentionDays,
        chatMessages: config.chatMessageRetentionDays,
        auditLog: config.auditLogRetentionDays,
        disabledDeletedMemory: config.disabledDeletedMemoryRetentionDays,
        eventProcessingFailures: config.eventProcessingFailureRetentionDays,
      },
    },
  };

  return {
    ...result,
    ...overrides,
  };
}

function expectFixedStatus(status: GovernanceOperationsStatus): void {
  expect(Object.keys(status)).toEqual([
    'generatedAt',
    'overall',
    'database',
    'schema',
    'counts',
    'configuration',
    'workflows',
  ]);
  expect(Object.keys(status.database)).toEqual([
    'open',
    'readonly',
    'integrity',
    'foreignKeys',
  ]);
  expect(Object.keys(status.schema)).toEqual([
    'ready',
    'requiredTablesPresent',
    'requiredTablesTotal',
    'missingTableCount',
  ]);
  expect(Object.keys(status.workflows)).toEqual(['backup', 'restore']);
  expect(Object.keys(status.workflows.backup)).toEqual(['available']);
  expect(Object.keys(status.workflows.restore)).toEqual([
    'available',
    'executionBoundary',
  ]);
}

describe('GovernanceOperationsCoordinator', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('previews and atomically confirms configured retention with aggregate-only audit evidence', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lethebot-governance-retention-'));
    const liveDbPath = join(tempDir, 'operations.db');
    const liveDb = initDatabase({ path: liveDbPath });
    const now = 1_800_000_000_000;
    const retentionConfig = { ...config, auditLogRetentionDays: 1 };

    try {
      runMigrations(liveDb, join(process.cwd(), 'migrations'));
      liveDb.prepare(`INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id, actor_class,
        invocation_context, summary, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('old-audit', now - 2 * 86_400_000, 'system', 'summary', 'old.event', 'old-event', 'system', 'internal', 'old', 1, 'low');
      const coordinator = new GovernanceOperationsCoordinator({
        db: liveDb,
        dbPath: liveDbPath,
        config: retentionConfig,
        now: () => now,
      });
      const preview = coordinator.previewConfiguredRetention();

      expect(preview.effects.auditLogDeleted).toBe(1);
      expect(Object.keys(preview)).toEqual([
        'action', 'currentState', 'contractVersion', 'asOf', 'configuredPolicy',
        'memoryStates', 'effects', 'zeroMeansForever', 'irreversible', 'previewDigest',
      ]);
      expect(JSON.stringify(preview)).not.toContain('old-audit');
      const confirmation = coordinator.confirmConfiguredRetention({
        expectedState: preview.currentState,
        expectedRevisionNumber: preview.contractVersion,
        previewDigest: preview.previewDigest,
        expectedAtMs: now,
      });

      expect(confirmation).toMatchObject({
        action: 'apply_configured_retention',
        status: 'applied',
        effects: { auditLogDeleted: 1 },
      });
      expect(liveDb.prepare('SELECT id FROM audit_log WHERE id = ?').get('old-audit'))
        .toBeUndefined();
      const audit = liveDb.prepare(
        'SELECT event_type, details, redacted, risk_level FROM audit_log',
      ).get() as { event_type: string; details: string; redacted: number; risk_level: string };
      expect(audit.event_type).toBe('operations.retention.applied');
      expect(audit.redacted).toBe(1);
      expect(audit.risk_level).toBe('high');
      expect(audit.details).not.toContain('old-audit');
      expect(liveDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(liveDb);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rolls retention deletion back when aggregate audit insertion fails', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lethebot-governance-retention-rollback-'));
    const liveDbPath = join(tempDir, 'operations.db');
    const liveDb = initDatabase({ path: liveDbPath });
    const now = 1_800_000_000_000;

    try {
      runMigrations(liveDb, join(process.cwd(), 'migrations'));
      liveDb.prepare(`INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id, actor_class,
        invocation_context, summary, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('rollback-audit', now - 2 * 86_400_000, 'system', 'summary', 'old.event', 'rollback-event', 'system', 'internal', 'old', 1, 'low');
      const coordinator = new GovernanceOperationsCoordinator({
        db: liveDb,
        dbPath: liveDbPath,
        config: { ...config, auditLogRetentionDays: 1 },
        now: () => now,
      });
      const preview = coordinator.previewConfiguredRetention();
      vi.spyOn(AuditRepository.prototype, 'createSync')
        .mockImplementation(() => { throw new Error('synthetic audit failure'); });

      expect(() => coordinator.confirmConfiguredRetention({
        expectedState: preview.currentState,
        expectedRevisionNumber: preview.contractVersion,
        previewDigest: preview.previewDigest,
        expectedAtMs: now,
      })).toThrow('synthetic audit failure');
      expect(liveDb.prepare('SELECT id FROM audit_log WHERE id = ?').get('rollback-audit'))
        .toEqual({ id: 'rollback-audit' });
    } finally {
      closeDatabase(liveDb);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects configured retention when policy drifts after preview', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lethebot-governance-retention-drift-'));
    const liveDbPath = join(tempDir, 'operations.db');
    const liveDb = initDatabase({ path: liveDbPath });
    const now = 1_800_000_000_000;
    const retentionConfig = { ...config };

    try {
      runMigrations(liveDb, join(process.cwd(), 'migrations'));
      const coordinator = new GovernanceOperationsCoordinator({
        db: liveDb,
        dbPath: liveDbPath,
        config: retentionConfig,
        now: () => now,
      });
      const preview = coordinator.previewConfiguredRetention();
      retentionConfig.rawEventRetentionDays += 1;

      expect(coordinator.confirmConfiguredRetention({
        expectedState: preview.currentState,
        expectedRevisionNumber: preview.contractVersion,
        previewDigest: preview.previewDigest,
        expectedAtMs: now,
      })).toBeNull();
      expect(liveDb.prepare(
        "SELECT COUNT(*) FROM audit_log WHERE event_type = 'operations.retention.applied'",
      ).pluck().get()).toBe(0);
    } finally {
      closeDatabase(liveDb);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('previews verified backup semantics without doctor, owner, database, or file effects', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lethebot-governance-backup-preview-'));
    const liveDbPath = join(tempDir, 'operations.db');
    const liveDb = initDatabase({ path: liveDbPath });

    try {
      runMigrations(liveDb, join(process.cwd(), 'migrations'));
      const doctor = vi.spyOn(operationsDoctor, 'runOperationsDoctor');
      const backup = vi.spyOn(sqliteMaintenance, 'backupSqliteDatabase');
      const changesBefore = liveDb.prepare('SELECT total_changes()').pluck().get();
      const filesBefore = readdirSync(tempDir).sort();
      const coordinator = new GovernanceOperationsCoordinator({
        db: liveDb,
        dbPath: liveDbPath,
        config,
      });
      let first: ExpectedBackupPreview;
      let second: ExpectedBackupPreview;

      try {
        first = coordinator.previewVerifiedBackup();
        second = coordinator.previewVerifiedBackup();
      } finally {
        expect(doctor).not.toHaveBeenCalled();
        expect(backup).not.toHaveBeenCalled();
        expect(readdirSync(tempDir).sort()).toEqual(filesBefore);
        expect(liveDb.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
        expect(liveDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      }

      const semanticPreview = {
        action: 'create_verified_backup',
        currentState: 'available',
        contractVersion: 1,
        effects: {
          databaseMutation: false,
          privateArtifactCreation: true,
          integrityVerification: true,
          destinationOverwrite: false,
        },
        restore: {
          availableAfterCompletion: true,
          executionBoundary: 'stopped_service_only',
        },
        rollback: {
          available: false,
          reason: 'artifact_removal_not_exposed',
        },
      } as const;
      const digestDomain = 'lethebot.governance.operations.verified_backup.preview.v1';
      const expectedDigest = createHash('sha256')
        .update(digestDomain)
        .update('\0')
        .update(JSON.stringify(semanticPreview))
        .digest('hex');

      expect(first).toEqual({ ...semanticPreview, previewDigest: expectedDigest });
      expect(second).toEqual(first);
      expect(Object.keys(first)).toEqual([
        'action',
        'currentState',
        'contractVersion',
        'effects',
        'restore',
        'rollback',
        'previewDigest',
      ]);
      expect(Object.keys(first.effects)).toEqual([
        'databaseMutation',
        'privateArtifactCreation',
        'integrityVerification',
        'destinationOverwrite',
      ]);
      expect(first.previewDigest).toMatch(/^[0-9a-f]{64}$/u);

      const changedDigest = createHash('sha256')
        .update(digestDomain)
        .update('\0')
        .update(JSON.stringify({
          ...semanticPreview,
          effects: { ...semanticPreview.effects, destinationOverwrite: true },
        }))
        .digest('hex');
      expect(changedDigest).not.toBe(first.previewDigest);

      const raw = JSON.stringify(first);
      expect(raw).not.toContain(liveDbPath);
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain(platformId);
      expect(raw).not.toContain('generatedAt');
      expect(raw).not.toContain('diagnostic');
    } finally {
      closeDatabase(liveDb);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates server-owned verified backups with opaque references and rejects unsafe directories', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lethebot-governance-managed-backup-'));
    const databaseDirectory = join(tempDir, 'private-database');
    const backupDirectory = join(databaseDirectory, '.lethebot-governance-backups');
    const liveDbPath = join(databaseDirectory, 'operations.db');
    mkdirSync(databaseDirectory, { mode: 0o700 });
    const liveDb = initDatabase({ path: liveDbPath });

    try {
      runMigrations(liveDb, join(process.cwd(), 'migrations'));
      const backupOwner = sqliteMaintenance.backupSqliteDatabase;
      const backup = vi.spyOn(sqliteMaintenance, 'backupSqliteDatabase')
        .mockImplementation(backupOwner);
      const coordinator = new GovernanceOperationsCoordinator({
        db: liveDb,
        dbPath: liveDbPath,
        config,
      });
      const createTrustedBackup = vi.spyOn(coordinator, 'createVerifiedBackup');
      const sourceBefore = readFileSync(liveDbPath);
      const changesBefore = liveDb.prepare('SELECT total_changes()').pluck().get();
      const topLevelBefore = readdirSync(databaseDirectory).sort();

      expect(backup).not.toHaveBeenCalled();
      expect(createTrustedBackup).not.toHaveBeenCalled();
      expect(readdirSync(databaseDirectory).sort()).toEqual(topLevelBefore);
      expect(liveDb.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(typeof coordinator.createServerOwnedVerifiedBackup).toBe('function');

      const previousUmask = process.umask(0o000);
      let first: Awaited<ReturnType<typeof coordinator.createServerOwnedVerifiedBackup>>;
      try {
        first = await coordinator.createServerOwnedVerifiedBackup();
      } finally {
        process.umask(previousUmask);
      }

      expect(Object.keys(first)).toEqual([
        'status',
        'artifact',
        'pages',
        'restore',
        'backupRef',
      ]);
      expect(first).toMatchObject({
        status: 'completed',
        artifact: {
          integrity: 'verified',
          sizeBytes: expect.any(Number),
        },
        pages: {
          total: expect.any(Number),
          remaining: 0,
          complete: true,
        },
        restore: {
          available: true,
          executionBoundary: 'stopped_service_only',
        },
        backupRef: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      });
      if (first.backupRef === null) {
        throw new Error('Expected completed managed backup reference');
      }
      const firstBackupPath = join(backupDirectory, `${first.backupRef}.db`);
      expect(createTrustedBackup).toHaveBeenCalledTimes(1);
      expect(createTrustedBackup).toHaveBeenCalledWith({ backupPath: firstBackupPath });
      expect(backup).toHaveBeenCalledTimes(1);
      expect(backup).toHaveBeenCalledWith({
        sourcePath: liveDbPath,
        backupPath: firstBackupPath,
      });
      expect(statSync(backupDirectory).isDirectory()).toBe(true);
      expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(firstBackupPath).mode & 0o777).toBe(0o600);

      const second = await coordinator.createServerOwnedVerifiedBackup();
      expect(second.status).toBe('completed');
      expect(second.backupRef).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(second.backupRef).not.toBe(first.backupRef);
      if (second.backupRef === null) {
        throw new Error('Expected repeated managed backup reference');
      }
      const secondBackupPath = join(backupDirectory, `${second.backupRef}.db`);
      expect(createTrustedBackup).toHaveBeenCalledTimes(2);
      expect(createTrustedBackup).toHaveBeenLastCalledWith({ backupPath: secondBackupPath });
      expect(backup).toHaveBeenCalledTimes(2);
      expect(statSync(secondBackupPath).mode & 0o777).toBe(0o600);
      expect(readdirSync(backupDirectory).sort()).toEqual([
        `${first.backupRef}.db`,
        `${second.backupRef}.db`,
      ].sort());
      expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
      expect(readFileSync(liveDbPath)).toEqual(sourceBefore);
      expect(liveDb.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(liveDb.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(liveDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      const successRaw = JSON.stringify([first, second]);
      expect(successRaw).not.toContain(liveDbPath);
      expect(successRaw).not.toContain(backupDirectory);
      expect(successRaw).not.toContain(firstBackupPath);
      expect(successRaw).not.toContain(secondBackupPath);
      expect(successRaw).not.toContain(secret);
      expect(successRaw).not.toContain(platformId);

      const failedStatus = {
        status: 'attention_required',
        artifact: { integrity: 'attention_required', sizeBytes: 0 },
        pages: { total: 0, remaining: 0, complete: false },
        restore: { available: false, executionBoundary: 'stopped_service_only' },
        backupRef: null,
      } as const;
      rmSync(backupDirectory, { recursive: true });

      writeFileSync(backupDirectory, 'file-must-survive');
      const callsBeforeFile = createTrustedBackup.mock.calls.length;
      expect(await coordinator.createServerOwnedVerifiedBackup()).toEqual(failedStatus);
      expect(createTrustedBackup).toHaveBeenCalledTimes(callsBeforeFile);
      expect(readFileSync(backupDirectory, 'utf8')).toBe('file-must-survive');
      rmSync(backupDirectory);

      const symlinkTarget = join(tempDir, 'symlink-target');
      mkdirSync(symlinkTarget, { mode: 0o700 });
      writeFileSync(join(symlinkTarget, 'marker'), 'symlink-target-must-survive');
      symlinkSync(symlinkTarget, backupDirectory, 'dir');
      const callsBeforeSymlink = createTrustedBackup.mock.calls.length;
      expect(await coordinator.createServerOwnedVerifiedBackup()).toEqual(failedStatus);
      expect(createTrustedBackup).toHaveBeenCalledTimes(callsBeforeSymlink);
      expect(readFileSync(join(symlinkTarget, 'marker'), 'utf8'))
        .toBe('symlink-target-must-survive');
      rmSync(backupDirectory);

      mkdirSync(backupDirectory, { mode: 0o755 });
      chmodSync(backupDirectory, 0o755);
      writeFileSync(join(backupDirectory, 'marker'), 'mode-must-survive');
      const callsBeforeMode = createTrustedBackup.mock.calls.length;
      expect(await coordinator.createServerOwnedVerifiedBackup()).toEqual(failedStatus);
      expect(createTrustedBackup).toHaveBeenCalledTimes(callsBeforeMode);
      expect(statSync(backupDirectory).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(backupDirectory, 'marker'), 'utf8')).toBe('mode-must-survive');
      chmodSync(backupDirectory, 0o700);
      rmSync(backupDirectory, { recursive: true });

      const missingPathCoordinator = new GovernanceOperationsCoordinator({
        db: liveDb,
        dbPath: join(tempDir, 'missing', 'operations.db'),
        config,
      });
      const ownerCallsBeforeMissing = backup.mock.calls.length;
      expect(await missingPathCoordinator.createServerOwnedVerifiedBackup())
        .toEqual(failedStatus);
      expect(backup).toHaveBeenCalledTimes(ownerCallsBeforeMissing);

      mkdirSync(backupDirectory, { mode: 0o700 });
      const trustedCallsBeforeThrow = createTrustedBackup.mock.calls.length;
      backup.mockRejectedValueOnce(new Error(`owner failure ${secret} ${liveDbPath}`));
      const thrownOwner = await coordinator.createServerOwnedVerifiedBackup();
      expect(thrownOwner).toEqual(failedStatus);
      expect(createTrustedBackup).toHaveBeenCalledTimes(trustedCallsBeforeThrow + 1);
      expect(backup).toHaveBeenCalledTimes(ownerCallsBeforeMissing + 1);
      expect(readdirSync(backupDirectory)).toEqual([]);

      const trustedCallsBeforeAttention = createTrustedBackup.mock.calls.length;
      backup.mockResolvedValueOnce(Object.assign({
        sourcePath: liveDbPath,
        backupPath: join(backupDirectory, `injected-${secret}.db`),
        totalPages: 0,
        remainingPages: 0,
        integrityOk: false,
        integrityResult: `diagnostic ${secret}`,
        backupSizeBytes: 0,
      }, { rowPayload: { platformId, path: backupDirectory } }));
      const attention = await coordinator.createServerOwnedVerifiedBackup();
      expect(attention).toEqual({
        status: 'attention_required',
        artifact: { integrity: 'attention_required', sizeBytes: 0 },
        pages: { total: 0, remaining: 0, complete: true },
        restore: { available: false, executionBoundary: 'stopped_service_only' },
        backupRef: null,
      });
      expect(createTrustedBackup).toHaveBeenCalledTimes(trustedCallsBeforeAttention + 1);
      expect(backup).toHaveBeenCalledTimes(ownerCallsBeforeMissing + 2);
      expect(readdirSync(backupDirectory)).toEqual([]);
      const failureRaw = JSON.stringify([thrownOwner, attention]);
      expect(failureRaw).not.toContain(liveDbPath);
      expect(failureRaw).not.toContain(backupDirectory);
      expect(failureRaw).not.toContain(secret);
      expect(failureRaw).not.toContain(platformId);
      expect(readFileSync(liveDbPath)).toEqual(sourceBefore);
      expect(liveDb.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(liveDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(liveDb);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('previews one exact server-owned backup for stopped-service restore handoff', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lethebot-governance-restore-preview-'));
    const databaseDirectory = join(tempDir, 'private-database');
    const backupDirectory = join(databaseDirectory, '.lethebot-governance-backups');
    const liveDbPath = join(databaseDirectory, 'operations.db');
    mkdirSync(databaseDirectory, { mode: 0o700 });
    const liveDb = initDatabase({ path: liveDbPath });

    try {
      runMigrations(liveDb, join(process.cwd(), 'migrations'));
      const coordinator = new GovernanceOperationsCoordinator({
        db: liveDb,
        dbPath: liveDbPath,
        config,
      });
      const firstBackup = await coordinator.createServerOwnedVerifiedBackup();
      const secondBackup = await coordinator.createServerOwnedVerifiedBackup();
      if (firstBackup.backupRef === null || secondBackup.backupRef === null) {
        throw new Error('Expected managed backup references');
      }
      const firstRef = firstBackup.backupRef;
      const secondRef = secondBackup.backupRef;
      const firstPath = join(backupDirectory, `${firstRef}.db`);
      const secondPath = join(backupDirectory, `${secondRef}.db`);
      const firstBytes = readFileSync(firstPath);
      const secondBytes = readFileSync(secondPath);
      const sourceBefore = readFileSync(liveDbPath);
      const filesBefore = readdirSync(backupDirectory).sort();
      const changesBefore = liveDb.prepare('SELECT total_changes()').pluck().get();
      const auditsBefore = liveDb.prepare('SELECT COUNT(*) FROM audit_log').pluck().get();
      const integrityOwner = sqliteMaintenance.verifySqliteSnapshotIntegrity;
      const integrity = vi.spyOn(sqliteMaintenance, 'verifySqliteSnapshotIntegrity')
        .mockImplementation(integrityOwner);
      const doctor = vi.spyOn(operationsDoctor, 'runOperationsDoctor');
      const restore = vi.spyOn(sqliteMaintenance, 'restoreSqliteDatabase')
        .mockImplementation(() => {
          throw new Error('Restore execution must stay absent');
        });
      const retention = vi.spyOn(sqliteMaintenance, 'applyRetentionPolicy')
        .mockImplementation(() => {
          throw new Error('Retention execution must stay absent');
        });
      const candidate = Reflect.get(coordinator, 'previewServerOwnedBackupRestore');

      expect(doctor).not.toHaveBeenCalled();
      expect(integrity).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(retention).not.toHaveBeenCalled();
      expect(readdirSync(backupDirectory).sort()).toEqual(filesBefore);
      expect(liveDb.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(typeof candidate).toBe('function');

      const preview = candidate as (
        this: GovernanceOperationsCoordinator,
        backupRef: string,
      ) => ExpectedRestoreHandoffPreview | null;
      const callPreview = (backupRef: string): ExpectedRestoreHandoffPreview | null => (
        preview.call(coordinator, backupRef)
      );
      const semanticPreview = (sizeBytes: number) => ({
        action: 'prepare_restore_handoff',
        currentState: 'verified_backup_available',
        contractVersion: 1,
        artifact: {
          integrity: 'verified',
          sizeBytes,
        },
        effects: {
          databaseMutation: false,
          artifactMutation: false,
          restoreExecution: false,
          serviceStopRequired: true,
        },
        restore: {
          available: true,
          executionBoundary: 'stopped_service_only',
        },
        rollback: {
          available: false,
          reason: 'no_in_process_effect',
        },
      } as const);
      const digestDomain = 'lethebot.governance.operations.restore_handoff.preview.v1';
      const expectedPreview = (
        backupRef: string,
        databaseBytes: Buffer,
      ): ExpectedRestoreHandoffPreview => {
        const semantics = semanticPreview(databaseBytes.length);
        const artifactFingerprint = createHash('sha256').update(databaseBytes).digest('hex');
        return {
          ...semantics,
          previewDigest: createHash('sha256')
            .update(digestDomain)
            .update('\0')
            .update(backupRef)
            .update('\0')
            .update(artifactFingerprint)
            .update('\0')
            .update(JSON.stringify(semantics))
            .digest('hex'),
        };
      };

      const first = callPreview(firstRef);
      const repeated = callPreview(firstRef);
      const second = callPreview(secondRef);

      expect(first).toEqual(expectedPreview(firstRef, firstBytes));
      expect(repeated).toEqual(first);
      expect(second).toEqual(expectedPreview(secondRef, secondBytes));
      expect(second?.previewDigest).not.toBe(first?.previewDigest);
      expect(Object.keys(first ?? {})).toEqual([
        'action',
        'currentState',
        'contractVersion',
        'artifact',
        'effects',
        'restore',
        'rollback',
        'previewDigest',
      ]);
      expect(Object.keys(first?.effects ?? {})).toEqual([
        'databaseMutation',
        'artifactMutation',
        'restoreExecution',
        'serviceStopRequired',
      ]);
      expect(integrity).toHaveBeenCalledTimes(3);
      expect(integrity).toHaveBeenNthCalledWith(1, firstBytes);
      expect(integrity).toHaveBeenNthCalledWith(2, firstBytes);
      expect(integrity).toHaveBeenNthCalledWith(3, secondBytes);
      const successRaw = JSON.stringify([first, repeated, second]);
      expect(successRaw).not.toContain(firstRef);
      expect(successRaw).not.toContain(secondRef);
      expect(successRaw).not.toContain(firstPath);
      expect(successRaw).not.toContain(backupDirectory);
      expect(successRaw).not.toContain(liveDbPath);
      expect(successRaw).not.toContain(secret);
      expect(successRaw).not.toContain(platformId);
      expect(successRaw).not.toContain('diagnostic');

      const callsBeforeInvalidReferences = integrity.mock.calls.length;
      for (const invalidRef of [
        '',
        'a'.repeat(42),
        'a'.repeat(44),
        'a'.repeat(42) + '/',
        '../' + 'a'.repeat(40),
        'a'.repeat(42) + '=',
        'a'.repeat(42) + '!',
      ]) {
        expect(callPreview(invalidRef)).toBeNull();
      }
      expect(integrity).toHaveBeenCalledTimes(callsBeforeInvalidReferences);

      const missingRef = 'Z'.repeat(43);
      expect([firstRef, secondRef]).not.toContain(missingRef);
      expect(callPreview(missingRef)).toBeNull();
      expect(integrity).toHaveBeenCalledTimes(callsBeforeInvalidReferences);

      const restoreFirstArtifact = (): void => {
        rmSync(firstPath, { recursive: true, force: true });
        writeFileSync(firstPath, firstBytes, { mode: 0o600 });
        chmodSync(firstPath, 0o600);
      };
      const restoreManagedDirectory = (): void => {
        rmSync(backupDirectory, { recursive: true, force: true });
        mkdirSync(backupDirectory, { mode: 0o700 });
        chmodSync(backupDirectory, 0o700);
        writeFileSync(firstPath, firstBytes, { mode: 0o600 });
        writeFileSync(secondPath, secondBytes, { mode: 0o600 });
        chmodSync(firstPath, 0o600);
        chmodSync(secondPath, 0o600);
      };

      rmSync(firstPath);
      mkdirSync(firstPath, { mode: 0o700 });
      expect(callPreview(firstRef)).toBeNull();
      restoreFirstArtifact();

      chmodSync(firstPath, 0o644);
      expect(callPreview(firstRef)).toBeNull();
      expect(statSync(firstPath).mode & 0o777).toBe(0o644);
      restoreFirstArtifact();

      writeFileSync(firstPath, Buffer.alloc(0));
      expect(callPreview(firstRef)).toBeNull();
      expect(statSync(firstPath).size).toBe(0);
      restoreFirstArtifact();

      const outsideArtifact = join(tempDir, 'outside.db');
      writeFileSync(outsideArtifact, firstBytes, { mode: 0o600 });
      rmSync(firstPath);
      symlinkSync(outsideArtifact, firstPath, 'file');
      expect(callPreview(firstRef)).toBeNull();
      expect(readFileSync(outsideArtifact)).toEqual(firstBytes);
      restoreFirstArtifact();

      const outsideHardlink = join(tempDir, 'outside-hardlink.db');
      writeFileSync(outsideHardlink, firstBytes, { mode: 0o600 });
      rmSync(firstPath);
      linkSync(outsideHardlink, firstPath);
      expect(callPreview(firstRef)).toBeNull();
      expect(readFileSync(outsideHardlink)).toEqual(firstBytes);
      restoreFirstArtifact();

      writeFileSync(firstPath, `corrupt ${secret}`);
      chmodSync(firstPath, 0o600);
      const callsBeforeCorrupt = integrity.mock.calls.length;
      expect(callPreview(firstRef)).toBeNull();
      expect(integrity).toHaveBeenCalledTimes(callsBeforeCorrupt + 1);
      restoreFirstArtifact();

      const callsBeforeThrownIntegrity = integrity.mock.calls.length;
      integrity.mockImplementationOnce(() => {
        throw new Error(`integrity diagnostic ${secret} ${firstPath}`);
      });
      expect(callPreview(firstRef)).toBeNull();
      expect(integrity).toHaveBeenCalledTimes(callsBeforeThrownIntegrity + 1);

      if (typeof process.getuid === 'function') {
        const currentUid = process.getuid();
        const getuid = vi.spyOn(process, 'getuid')
          .mockReturnValue(currentUid === 0 ? 1 : currentUid - 1);
        const callsBeforeWrongOwner = integrity.mock.calls.length;
        try {
          expect(callPreview(firstRef)).toBeNull();
          expect(integrity).toHaveBeenCalledTimes(callsBeforeWrongOwner);
        } finally {
          getuid.mockRestore();
        }
      }

      rmSync(backupDirectory, { recursive: true });
      const callsBeforeMissingDirectory = integrity.mock.calls.length;
      expect(callPreview(firstRef)).toBeNull();
      expect(existsSync(backupDirectory)).toBe(false);
      expect(integrity).toHaveBeenCalledTimes(callsBeforeMissingDirectory);

      writeFileSync(backupDirectory, 'directory-file-must-survive');
      expect(callPreview(firstRef)).toBeNull();
      expect(readFileSync(backupDirectory, 'utf8')).toBe('directory-file-must-survive');
      rmSync(backupDirectory);

      const outsideDirectory = join(tempDir, 'outside-directory');
      mkdirSync(outsideDirectory, { mode: 0o700 });
      writeFileSync(join(outsideDirectory, 'marker'), 'directory-target-must-survive');
      symlinkSync(outsideDirectory, backupDirectory, 'dir');
      expect(callPreview(firstRef)).toBeNull();
      expect(readFileSync(join(outsideDirectory, 'marker'), 'utf8'))
        .toBe('directory-target-must-survive');
      rmSync(backupDirectory);

      mkdirSync(backupDirectory, { mode: 0o755 });
      chmodSync(backupDirectory, 0o755);
      writeFileSync(firstPath, firstBytes, { mode: 0o600 });
      expect(callPreview(firstRef)).toBeNull();
      expect(statSync(backupDirectory).mode & 0o777).toBe(0o755);
      restoreManagedDirectory();

      expect(callPreview(firstRef)).toEqual(expectedPreview(firstRef, firstBytes));
      expect(readdirSync(backupDirectory).sort()).toEqual(filesBefore);
      expect(readFileSync(firstPath)).toEqual(firstBytes);
      expect(readFileSync(secondPath)).toEqual(secondBytes);
      expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(firstPath).mode & 0o777).toBe(0o600);
      expect(statSync(secondPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(liveDbPath)).toEqual(sourceBefore);
      expect(liveDb.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(liveDb.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(auditsBefore);
      expect(liveDb.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(liveDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      expect(doctor).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(retention).not.toHaveBeenCalled();
    } finally {
      closeDatabase(liveDb);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('projects the shared doctor once into a fixed path-free status', () => {
    const doctor = vi.spyOn(operationsDoctor, 'runOperationsDoctor')
      .mockReturnValue(doctorResult());
    const coordinator = new GovernanceOperationsCoordinator({ db, dbPath, config });

    const status = coordinator.inspect();

    expect(doctor).toHaveBeenCalledTimes(1);
    expect(doctor).toHaveBeenCalledWith(db, dbPath, config);
    expectFixedStatus(status);
    expect(status).toEqual({
      generatedAt: '2026-07-28T05:00:00.000Z',
      overall: 'ok',
      database: {
        open: true,
        readonly: true,
        integrity: 'ok',
        foreignKeys: 'clean',
      },
      schema: {
        ready: true,
        requiredTablesPresent: 34,
        requiredTablesTotal: 34,
        missingTableCount: 0,
      },
      counts: {
        rawEvents: 1,
        eventIngressReceipts: 2,
        eventProcessingAdmissions: 3,
        chatMessages: 4,
        eventProcessingFailures: 5,
        agentTurns: 6,
        contextTraces: 7,
        actionDecisions: 8,
        actionExecutions: 9,
        memoryRecords: 10,
        memorySources: 11,
        memoryRevisions: 12,
        toolCalls: 13,
        auditLog: 14,
        jobs: 15,
        jobAttempts: 16,
        workerHeartbeats: 17,
      },
      configuration: {
        oneBot: {
          transport: 'ws',
          httpConfigured: true,
          wsConfigured: true,
          tokenConfigured: true,
          botIdConfigured: true,
        },
        server: {
          hostConfigured: true,
          portConfigured: true,
          healthPathConfigured: true,
          readinessPathConfigured: true,
          metricsPathConfigured: true,
          eventPathConfigured: true,
        },
        retentionDays: {
          rawEvents: 90,
          chatMessages: 30,
          auditLog: 180,
          disabledDeletedMemory: 365,
          eventProcessingFailures: 14,
        },
      },
      workflows: {
        backup: { available: true },
        restore: { available: true, executionBoundary: 'stopped_service_only' },
      },
    });

    const raw = JSON.stringify(status);
    expect(raw).not.toContain(dbPath);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(platformId);
    expect(raw).not.toContain('onebot.example');
    expect(raw).not.toContain('integrity diagnostic');
    expect(raw).not.toContain('missing_table_name');
  });

  it('keeps attention classifications and omits dynamic diagnostics', () => {
    const result = doctorResult({
      overall: 'attention_required',
      database: {
        dbPath,
        open: true,
        readonly: true,
        integrityOk: false,
        integrityResult: `corrupt: ${secret}`,
        foreignKeyViolations: 2,
      },
      schema: {
        ready: false,
        requiredTablesPresent: 33,
        requiredTablesTotal: 34,
        missingTables: [`missing_table_name:${secret}`],
      },
    });
    Object.assign(result, {
      diagnostic: `sql=${secret}`,
      rowPayload: { url: `https://example.invalid/${secret}`, platformId },
    });
    Object.assign(result.database, { rawPath: dbPath, details: secret });
    Object.assign(result.schema, { tableNames: [`schema-name:${secret}`] });

    const doctor = vi.spyOn(operationsDoctor, 'runOperationsDoctor')
      .mockReturnValue(result);
    const status = new GovernanceOperationsCoordinator({ db, dbPath, config }).inspect();

    expect(doctor).toHaveBeenCalledTimes(1);
    expect(status.overall).toBe('attention_required');
    expect(status.database).toEqual({
      open: true,
      readonly: true,
      integrity: 'attention_required',
      foreignKeys: 'violations_present',
    });
    expect(status.schema).toEqual({
      ready: false,
      requiredTablesPresent: 33,
      requiredTablesTotal: 34,
      missingTableCount: 1,
    });
    const raw = JSON.stringify(status);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(dbPath);
    expect(raw).not.toContain('schema-name');
    expect(raw).not.toContain('https://');
    expect(raw).not.toContain('diagnostic');
  });

  it('repeats the shared inspection without changing a migrated database', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lethebot-governance-operations-'));
    const liveDbPath = join(tempDir, 'operations.db');
    const liveDb = initDatabase({ path: liveDbPath });

    try {
      runMigrations(liveDb, join(process.cwd(), 'migrations'));
      const changesBefore = liveDb.prepare('SELECT total_changes()').pluck().get();
      const coordinator = new GovernanceOperationsCoordinator({
        db: liveDb,
        dbPath: liveDbPath,
        config,
      });

      const first = coordinator.inspect();
      const second = coordinator.inspect();

      expect(first.overall).toBe('ok');
      expect(second.overall).toBe('ok');
      expect(first.database).toEqual({
        open: true,
        readonly: true,
        integrity: 'ok',
        foreignKeys: 'clean',
      });
      expect(JSON.stringify(first)).not.toContain(liveDbPath);
      expect(liveDb.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(liveDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(liveDb);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates a verified backup and projects only bounded artifact evidence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lethebot-governance-backup-'));
    const liveDbPath = join(tempDir, 'operations.db');
    const backupPath = join(tempDir, `backup-${secret}-${platformId}.db`);
    const liveDb = initDatabase({ path: liveDbPath });

    try {
      runMigrations(liveDb, join(process.cwd(), 'migrations'));
      const changesBefore = liveDb.prepare('SELECT total_changes()').pluck().get();
      const backupOwner = sqliteMaintenance.backupSqliteDatabase;
      const backup = vi.spyOn(sqliteMaintenance, 'backupSqliteDatabase')
        .mockImplementation(async (options) => {
          const result = await backupOwner(options);
          return Object.assign(result, {
            diagnostic: `integrity diagnostic ${secret}`,
            rowPayload: { platformId, path: backupPath },
          });
        });
      const coordinator = new GovernanceOperationsCoordinator({
        db: liveDb,
        dbPath: liveDbPath,
        config,
      });

      const status = await coordinator.createVerifiedBackup({ backupPath });

      expect(backup).toHaveBeenCalledTimes(1);
      expect(backup).toHaveBeenCalledWith({ sourcePath: liveDbPath, backupPath });
      expect(Object.keys(status)).toEqual(['status', 'artifact', 'pages', 'restore']);
      expect(Object.keys(status.artifact)).toEqual(['integrity', 'sizeBytes']);
      expect(Object.keys(status.pages)).toEqual(['total', 'remaining', 'complete']);
      expect(Object.keys(status.restore)).toEqual(['available', 'executionBoundary']);
      expect(status.status).toBe('completed');
      expect(status.artifact.integrity).toBe('verified');
      expect(status.artifact.sizeBytes).toBeGreaterThan(0);
      expect(status.pages.total).toBeGreaterThan(0);
      expect(status.pages.remaining).toBe(0);
      expect(status.pages.complete).toBe(true);
      expect(status.restore).toEqual({
        available: true,
        executionBoundary: 'stopped_service_only',
      });
      expect(existsSync(backupPath)).toBe(true);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(liveDb.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);

      const raw = JSON.stringify(status);
      expect(raw).not.toContain(liveDbPath);
      expect(raw).not.toContain(backupPath);
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain(platformId);
      expect(raw).not.toContain('integrity diagnostic');
      expect(raw).not.toContain('rowPayload');
    } finally {
      closeDatabase(liveDb);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns a fixed path-free attention status when backup creation fails', async () => {
    const backupPath = `/srv/lethebot/private/${secret}/${platformId}.db`;
    const backup = vi.spyOn(sqliteMaintenance, 'backupSqliteDatabase')
      .mockRejectedValue(new Error(`backup failed: ${backupPath}`));
    const coordinator = new GovernanceOperationsCoordinator({ db, dbPath, config });

    const status = await coordinator.createVerifiedBackup({ backupPath });

    expect(backup).toHaveBeenCalledTimes(1);
    expect(backup).toHaveBeenCalledWith({ sourcePath: dbPath, backupPath });
    expect(status).toEqual({
      status: 'attention_required',
      artifact: { integrity: 'attention_required', sizeBytes: 0 },
      pages: { total: 0, remaining: 0, complete: false },
      restore: { available: false, executionBoundary: 'stopped_service_only' },
    });
    const raw = JSON.stringify(status);
    expect(raw).not.toContain(dbPath);
    expect(raw).not.toContain(backupPath);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(platformId);
    expect(raw).not.toContain('backup failed');
  });

  it('bounds malformed backup metadata without passing through extra fields', () => {
    const projected = projectSqliteBackupForGovernance(Object.assign({
      sourcePath: dbPath,
      backupPath: `/private/${secret}/${platformId}.db`,
      totalPages: Number.MAX_SAFE_INTEGER + 1,
      remainingPages: -1,
      integrityOk: true,
      integrityResult: `ok:${secret}`,
      backupSizeBytes: Number.POSITIVE_INFINITY,
    }, {
      diagnostic: secret,
      rows: [{ platformId }],
    }));

    expect(projected).toEqual({
      status: 'attention_required',
      artifact: { integrity: 'verified', sizeBytes: 0 },
      pages: { total: 0, remaining: 0, complete: false },
      restore: { available: false, executionBoundary: 'stopped_service_only' },
    });
    const raw = JSON.stringify(projected);
    expect(raw).not.toContain(dbPath);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(platformId);
    expect(raw).not.toContain('diagnostic');
    expect(raw).not.toContain('rows');
  });
});
