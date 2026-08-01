/**
 * Fixed governance projections over shared Operations owners.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  runOperationsDoctor,
  type OperationsDoctorConfig,
  type OperationsDoctorResult,
} from '../operations/doctor.js';
import {
  applyRetentionPlanInCurrentTransaction,
  backupSqliteDatabase,
  planRetentionPolicy,
  type RetentionPolicy,
  type RetentionResult,
  type SqliteBackupResult,
  verifySqliteSnapshotIntegrity,
} from '../operations/sqlite-maintenance.js';
import { AuditRepository } from '../storage/audit-repository.js';

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERIFIED_BACKUP_PREVIEW_DIGEST_DOMAIN =
  'lethebot.governance.operations.verified_backup.preview.v1';
const RESTORE_HANDOFF_PREVIEW_DIGEST_DOMAIN =
  'lethebot.governance.operations.restore_handoff.preview.v1';
const CONFIGURED_RETENTION_PREVIEW_DIGEST_DOMAIN =
  'lethebot.governance.operations.configured_retention.preview.v1';
const MANAGED_BACKUP_DIRECTORY_NAME = '.lethebot-governance-backups';
const MANAGED_BACKUP_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface GovernanceOperationsStatus {
  generatedAt: string;
  overall: 'ok' | 'attention_required';
  database: {
    open: boolean;
    readonly: boolean;
    integrity: 'ok' | 'attention_required';
    foreignKeys: 'clean' | 'violations_present';
  };
  schema: {
    ready: boolean;
    requiredTablesPresent: number;
    requiredTablesTotal: number;
    missingTableCount: number;
  };
  counts: {
    rawEvents: number;
    eventIngressReceipts: number;
    eventProcessingAdmissions: number;
    chatMessages: number;
    eventProcessingFailures: number;
    agentTurns: number;
    contextTraces: number;
    actionDecisions: number;
    actionExecutions: number;
    memoryRecords: number;
    memorySources: number;
    memoryRevisions: number;
    toolCalls: number;
    auditLog: number;
    jobs: number;
    jobAttempts: number;
    workerHeartbeats: number;
  };
  configuration: {
    oneBot: {
      transport: OperationsDoctorConfig['onebotTransport'];
      httpConfigured: boolean;
      wsConfigured: boolean;
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
    retentionDays: {
      rawEvents: number;
      chatMessages: number;
      auditLog: number;
      disabledDeletedMemory: number;
      eventProcessingFailures: number;
    };
  };
  workflows: {
    backup: {
      available: true;
    };
    restore: {
      available: true;
      executionBoundary: 'stopped_service_only';
    };
  };
}

export interface GovernanceOperationsCoordinatorOptions {
  db: Database.Database;
  dbPath: string;
  config: OperationsDoctorConfig;
  now?: () => number;
}

export interface GovernanceOperationsBackupOptions {
  backupPath: string;
}

export interface GovernanceOperationsBackupStatus {
  status: 'completed' | 'attention_required';
  artifact: {
    integrity: 'verified' | 'attention_required';
    sizeBytes: number;
  };
  pages: {
    total: number;
    remaining: number;
    complete: boolean;
  };
  restore: {
    available: boolean;
    executionBoundary: 'stopped_service_only';
  };
}

export interface GovernanceOperationsManagedBackupStatus
  extends GovernanceOperationsBackupStatus {
  backupRef: string | null;
}

export interface GovernanceOperationsBackupPreview {
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
}

export interface GovernanceOperationsRestoreHandoffPreview {
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
}

export interface GovernanceOperationsRetentionPreview {
  action: 'apply_configured_retention';
  currentState: string;
  contractVersion: 1;
  asOf: string;
  configuredPolicy: {
    rawEventsDays: number;
    chatMessagesDays: number;
    auditLogDays: number;
    disabledDeletedMemoryDays: number;
    eventProcessingFailuresDays: number;
  };
  memoryStates: readonly ['rejected', 'disabled', 'deleted'];
  effects: RetentionResult;
  zeroMeansForever: true;
  irreversible: {
    hardDelete: true;
    rollbackAvailable: false;
    boundary: 'verified_backup_recommended';
  };
  previewDigest: string;
}

export interface GovernanceOperationsRetentionConfirmation {
  action: 'apply_configured_retention';
  status: 'applied';
  contractVersion: 1;
  appliedAt: string;
  configuredPolicy: GovernanceOperationsRetentionPreview['configuredPolicy'];
  memoryStates: GovernanceOperationsRetentionPreview['memoryStates'];
  effects: RetentionResult;
  zeroMeansForever: true;
  irreversible: GovernanceOperationsRetentionPreview['irreversible'];
}

export interface ConfirmConfiguredRetentionInput {
  expectedState: string;
  expectedRevisionNumber: number;
  previewDigest: string;
  expectedAtMs: number;
}

export class GovernanceOperationsCoordinator {
  private readonly db: Database.Database;
  private readonly dbPath: string;
  private readonly config: OperationsDoctorConfig;
  private readonly auditRepository: AuditRepository;
  private readonly now: () => number;

  constructor(options: GovernanceOperationsCoordinatorOptions) {
    this.db = options.db;
    this.dbPath = options.dbPath;
    this.config = options.config;
    this.auditRepository = new AuditRepository(options.db);
    this.now = options.now ?? Date.now;
  }

  inspect(): GovernanceOperationsStatus {
    const doctor = runOperationsDoctor(this.db, this.dbPath, this.config);
    return projectOperationsDoctorForGovernance(doctor);
  }

  previewConfiguredRetention(asOfMs: number = this.readNow()): GovernanceOperationsRetentionPreview {
    const plan = planRetentionPolicy(this.db, this.currentRetentionPolicy(), asOfMs);
    const preview = {
      action: 'apply_configured_retention',
      currentState: plan.stateFingerprint,
      contractVersion: 1,
      asOf: new Date(plan.asOfMs).toISOString(),
      configuredPolicy: plan.policy,
      memoryStates: ['rejected', 'disabled', 'deleted'],
      effects: plan.effects,
      zeroMeansForever: true,
      irreversible: {
        hardDelete: true,
        rollbackAvailable: false,
        boundary: 'verified_backup_recommended',
      },
    } as const;
    const previewDigest = createHash('sha256')
      .update(CONFIGURED_RETENTION_PREVIEW_DIGEST_DOMAIN)
      .update('\0')
      .update(JSON.stringify({
        ...preview,
        candidateFingerprints: plan.candidateFingerprints,
      }))
      .digest('hex');
    return { ...preview, previewDigest };
  }

  confirmConfiguredRetention(
    input: ConfirmConfiguredRetentionInput,
  ): GovernanceOperationsRetentionConfirmation | null {
    if (
      !/^[0-9a-f]{64}$/u.test(input.expectedState)
      || input.expectedRevisionNumber !== 1
      || !/^[0-9a-f]{64}$/u.test(input.previewDigest)
      || !Number.isSafeInteger(input.expectedAtMs)
      || input.expectedAtMs < 0
      || !Number.isFinite(new Date(input.expectedAtMs).getTime())
    ) {
      return null;
    }

    return this.db.transaction(() => {
      const currentPreview = this.previewConfiguredRetention(input.expectedAtMs);
      if (
        currentPreview.currentState !== input.expectedState
        || currentPreview.contractVersion !== input.expectedRevisionNumber
        || currentPreview.previewDigest !== input.previewDigest
      ) {
        return null;
      }

      const plan = planRetentionPolicy(
        this.db,
        this.currentRetentionPolicy(),
        input.expectedAtMs,
      );
      const effects = applyRetentionPlanInCurrentTransaction(this.db, plan);
      const appliedAtMs = this.readNow();
      this.auditRepository.createSync({
        timestamp: new Date(appliedAtMs),
        category: 'system',
        level: 'redacted_full',
        eventType: 'operations.retention.applied',
        eventId: `configured-retention-${input.expectedAtMs}`,
        actor: {
          actorClass: 'admin',
          context: 'internal',
        },
        summary: 'Configured retention policy applied through governance confirmation',
        details: {
          action: currentPreview.action,
          contractVersion: currentPreview.contractVersion,
          asOf: currentPreview.asOf,
          configuredPolicy: currentPreview.configuredPolicy,
          memoryStates: currentPreview.memoryStates,
          effects,
          zeroMeansForever: true,
          irreversible: currentPreview.irreversible,
        },
        redacted: true,
        riskLevel: 'high',
      });

      return {
        action: currentPreview.action,
        status: 'applied' as const,
        contractVersion: currentPreview.contractVersion,
        appliedAt: new Date(appliedAtMs).toISOString(),
        configuredPolicy: currentPreview.configuredPolicy,
        memoryStates: currentPreview.memoryStates,
        effects,
        zeroMeansForever: true as const,
        irreversible: currentPreview.irreversible,
      };
    }).immediate();
  }

  previewVerifiedBackup(): GovernanceOperationsBackupPreview {
    const preview = {
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
    const previewDigest = createHash('sha256')
      .update(VERIFIED_BACKUP_PREVIEW_DIGEST_DOMAIN)
      .update('\0')
      .update(JSON.stringify(preview))
      .digest('hex');

    return { ...preview, previewDigest };
  }

  async createVerifiedBackup(
    options: GovernanceOperationsBackupOptions,
  ): Promise<GovernanceOperationsBackupStatus> {
    try {
      const backup = await backupSqliteDatabase({
        sourcePath: this.dbPath,
        backupPath: options.backupPath,
      });
      return projectSqliteBackupForGovernance(backup);
    } catch {
      return failedBackupStatus();
    }
  }

  async createServerOwnedVerifiedBackup(): Promise<GovernanceOperationsManagedBackupStatus> {
    let backupRef: string;
    let backupPath: string;
    try {
      const sourcePath = realpathSync(this.dbPath);
      const backupDirectory = join(dirname(sourcePath), MANAGED_BACKUP_DIRECTORY_NAME);
      ensurePrivateManagedBackupDirectory(backupDirectory);
      backupRef = randomBytes(32).toString('base64url');
      backupPath = join(backupDirectory, `${backupRef}.db`);
    } catch {
      return { ...failedBackupStatus(), backupRef: null };
    }

    const status = await this.createVerifiedBackup({ backupPath });
    return {
      ...status,
      backupRef: status.status === 'completed' ? backupRef : null,
    };
  }

  previewServerOwnedBackupRestore(
    backupRef: string,
  ): GovernanceOperationsRestoreHandoffPreview | null {
    if (!MANAGED_BACKUP_REFERENCE_PATTERN.test(backupRef)) {
      return null;
    }

    try {
      const sourcePath = realpathSync(this.dbPath);
      const backupDirectory = join(dirname(sourcePath), MANAGED_BACKUP_DIRECTORY_NAME);
      assertPrivateManagedBackupDirectory(backupDirectory);
      const backupPath = join(backupDirectory, `${backupRef}.db`);
      const databaseBytes = readPrivateManagedBackupSnapshot(backupPath);
      if (verifySqliteSnapshotIntegrity(databaseBytes).ok !== true) {
        return null;
      }
      const artifactFingerprint = createHash('sha256').update(databaseBytes).digest('hex');

      const preview = {
        action: 'prepare_restore_handoff',
        currentState: 'verified_backup_available',
        contractVersion: 1,
        artifact: {
          integrity: 'verified',
          sizeBytes: databaseBytes.length,
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
      } as const;
      const previewDigest = createHash('sha256')
        .update(RESTORE_HANDOFF_PREVIEW_DIGEST_DOMAIN)
        .update('\0')
        .update(backupRef)
        .update('\0')
        .update(artifactFingerprint)
        .update('\0')
        .update(JSON.stringify(preview))
        .digest('hex');

      return { ...preview, previewDigest };
    } catch {
      return null;
    }
  }

  private currentRetentionPolicy(): RetentionPolicy {
    return {
      rawEventsDays: this.config.rawEventRetentionDays,
      chatMessagesDays: this.config.chatMessageRetentionDays,
      auditLogDays: this.config.auditLogRetentionDays,
      disabledDeletedMemoryDays: this.config.disabledDeletedMemoryRetentionDays,
      eventProcessingFailuresDays: this.config.eventProcessingFailureRetentionDays,
    };
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) {
      throw new Error('Invalid governance Operations clock');
    }
    return now;
  }
}

export function projectSqliteBackupForGovernance(
  backup: SqliteBackupResult,
): GovernanceOperationsBackupStatus {
  const totalIsValid = isNonNegativeSafeInteger(backup.totalPages);
  const remainingIsValid = isNonNegativeSafeInteger(backup.remainingPages);
  const sizeIsValid = isNonNegativeSafeInteger(backup.backupSizeBytes);
  const total = boundedCount(backup.totalPages);
  const rawRemaining = boundedCount(backup.remainingPages);
  const remaining = total === 0 ? 0 : Math.min(total, rawRemaining);
  const pagesAreConsistent = totalIsValid
    && remainingIsValid
    && rawRemaining <= total;
  const complete = pagesAreConsistent && rawRemaining === 0;
  const integrity = backup.integrityOk === true ? 'verified' : 'attention_required';
  const sizeBytes = boundedCount(backup.backupSizeBytes);
  const status = integrity === 'verified'
    && complete
    && sizeIsValid
    && sizeBytes > 0
    ? 'completed'
    : 'attention_required';

  return {
    status,
    artifact: { integrity, sizeBytes },
    pages: { total, remaining, complete },
    restore: {
      available: status === 'completed',
      executionBoundary: 'stopped_service_only',
    },
  };
}

export function projectOperationsDoctorForGovernance(
  doctor: OperationsDoctorResult,
): GovernanceOperationsStatus {
  const requiredTablesTotal = boundedCount(doctor.schema.requiredTablesTotal);
  const requiredTablesPresent = Math.min(
    requiredTablesTotal,
    boundedCount(doctor.schema.requiredTablesPresent),
  );

  return {
    generatedAt: ISO_TIMESTAMP_PATTERN.test(doctor.generatedAt)
      ? doctor.generatedAt
      : new Date(0).toISOString(),
    overall: doctor.overall === 'ok' ? 'ok' : 'attention_required',
    database: {
      open: doctor.database.open === true,
      readonly: doctor.database.readonly === true,
      integrity: doctor.database.integrityOk === true ? 'ok' : 'attention_required',
      foreignKeys: doctor.database.foreignKeyViolations === 0
        ? 'clean'
        : 'violations_present',
    },
    schema: {
      ready: doctor.schema.ready === true,
      requiredTablesPresent,
      requiredTablesTotal,
      missingTableCount: requiredTablesTotal - requiredTablesPresent,
    },
    counts: {
      rawEvents: boundedCount(doctor.counts.raw_events),
      eventIngressReceipts: boundedCount(doctor.counts.event_ingress_receipts),
      eventProcessingAdmissions: boundedCount(doctor.counts.event_processing_admissions),
      chatMessages: boundedCount(doctor.counts.chat_messages),
      eventProcessingFailures: boundedCount(doctor.counts.event_processing_failures),
      agentTurns: boundedCount(doctor.counts.agent_turns),
      contextTraces: boundedCount(doctor.counts.context_traces),
      actionDecisions: boundedCount(doctor.counts.action_decisions),
      actionExecutions: boundedCount(doctor.counts.action_executions),
      memoryRecords: boundedCount(doctor.counts.memory_records),
      memorySources: boundedCount(doctor.counts.memory_sources),
      memoryRevisions: boundedCount(doctor.counts.memory_revisions),
      toolCalls: boundedCount(doctor.counts.tool_calls),
      auditLog: boundedCount(doctor.counts.audit_log),
      jobs: boundedCount(doctor.counts.jobs),
      jobAttempts: boundedCount(doctor.counts.job_attempts),
      workerHeartbeats: boundedCount(doctor.counts.worker_heartbeats),
    },
    configuration: {
      oneBot: {
        transport: doctor.configuration.oneBot.transport === 'http' ? 'http' : 'ws',
        httpConfigured: doctor.configuration.oneBot.httpUrlConfigured === true,
        wsConfigured: doctor.configuration.oneBot.wsUrlConfigured === true,
        tokenConfigured: doctor.configuration.oneBot.tokenConfigured === true,
        botIdConfigured: doctor.configuration.oneBot.botIdConfigured === true,
      },
      server: {
        hostConfigured: doctor.configuration.server.hostConfigured === true,
        portConfigured: doctor.configuration.server.portConfigured === true,
        healthPathConfigured: doctor.configuration.server.healthPathConfigured === true,
        readinessPathConfigured: doctor.configuration.server.readinessPathConfigured === true,
        metricsPathConfigured: doctor.configuration.server.metricsPathConfigured === true,
        eventPathConfigured: doctor.configuration.server.eventPathConfigured === true,
      },
      retentionDays: {
        rawEvents: boundedCount(doctor.configuration.retentionDays.rawEvents),
        chatMessages: boundedCount(doctor.configuration.retentionDays.chatMessages),
        auditLog: boundedCount(doctor.configuration.retentionDays.auditLog),
        disabledDeletedMemory: boundedCount(doctor.configuration.retentionDays.disabledDeletedMemory),
        eventProcessingFailures: boundedCount(doctor.configuration.retentionDays.eventProcessingFailures),
      },
    },
    workflows: {
      backup: { available: true },
      restore: { available: true, executionBoundary: 'stopped_service_only' },
    },
  };
}

function boundedCount(value: number): number {
  if (!isNonNegativeSafeInteger(value)) {
    return 0;
  }
  return value;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function ensurePrivateManagedBackupDirectory(directoryPath: string): void {
  let created = false;
  try {
    mkdirSync(directoryPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }
  if (created) {
    chmodSync(directoryPath, 0o700);
  }

  assertPrivateManagedBackupDirectory(directoryPath);
}

function assertPrivateManagedBackupDirectory(directoryPath: string): void {
  const entry = lstatSync(directoryPath);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    entry.isSymbolicLink()
    || !entry.isDirectory()
    || (entry.mode & 0o7777) !== 0o700
    || (currentUid !== null && entry.uid !== currentUid)
    || realpathSync(directoryPath) !== directoryPath
  ) {
    throw new Error('Invalid managed backup directory');
  }
}

function readPrivateManagedBackupSnapshot(backupPath: string): Buffer {
  const entry = lstatSync(backupPath);
  assertPrivateManagedBackupArtifact(entry, backupPath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const descriptor = openSync(backupPath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    assertPrivateManagedBackupArtifact(opened, backupPath, false);
    if (entry.dev !== opened.dev || entry.ino !== opened.ino) {
      throw new Error('Managed backup artifact changed during open');
    }
    const databaseBytes = readFileSync(descriptor);
    if (databaseBytes.length !== opened.size) {
      throw new Error('Managed backup artifact changed during read');
    }
    const after = lstatSync(backupPath);
    assertPrivateManagedBackupArtifact(after, backupPath);
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size) {
      throw new Error('Managed backup artifact changed during read');
    }
    return databaseBytes;
  } finally {
    closeSync(descriptor);
  }
}

function assertPrivateManagedBackupArtifact(
  entry: Stats,
  backupPath: string,
  checkResolvedPath = true,
): void {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    entry.isSymbolicLink()
    || !entry.isFile()
    || entry.nlink !== 1
    || (entry.mode & 0o7777) !== 0o600
    || (currentUid !== null && entry.uid !== currentUid)
    || !isNonNegativeSafeInteger(entry.size)
    || entry.size === 0
    || (checkResolvedPath && realpathSync(backupPath) !== backupPath)
  ) {
    throw new Error('Invalid managed backup artifact');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function failedBackupStatus(): GovernanceOperationsBackupStatus {
  return {
    status: 'attention_required',
    artifact: { integrity: 'attention_required', sizeBytes: 0 },
    pages: { total: 0, remaining: 0, complete: false },
    restore: { available: false, executionBoundary: 'stopped_service_only' },
  };
}
