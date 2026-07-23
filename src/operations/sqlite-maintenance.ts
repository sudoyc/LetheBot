/**
 * SQLite maintenance helpers for local-first operations.
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecretsInText } from '../memory/secret-scan.js';

export interface SqliteBackupOptions {
  sourcePath: string;
  backupPath: string;
}

export interface SqliteBackupResult {
  sourcePath: string;
  backupPath: string;
  totalPages: number;
  remainingPages: number;
  integrityOk: boolean;
  integrityResult: string;
  backupSizeBytes: number;
}

export interface SqliteRestoreOptions {
  backupPath: string;
  targetPath: string;
  overwrite?: boolean;
}

export interface SqliteRestoreResult {
  backupPath: string;
  targetPath: string;
  integrityOk: boolean;
  integrityResult: string;
  foreignKeyViolations: number;
  restoredSizeBytes: number;
}

export interface RetentionPolicy {
  rawEventsDays?: number;
  chatMessagesDays?: number;
  auditLogDays?: number;
  disabledDeletedMemoryDays?: number;
  eventProcessingFailuresDays?: number;
}

export interface RetentionResult {
  rawEventsDeleted: number;
  modelInvocationSourcesDeleted: number;
  chatMessagesDeleted: number;
  auditLogDeleted: number;
  eventProcessingFailuresDeleted: number;
  memoriesPurged: number;
  actionMemoryLinksCleared: number;
  memorySourcesDeleted: number;
  memoryRevisionsDeleted: number;
  memoryFtsRowsDeleted: number;
}

export interface OperationsMetrics {
  generatedAt: string;
  sinceMs?: number;
  rawEvents: {
    total: number;
  };
  eventIngressReceipts: {
    total: number;
    byDisposition: Record<string, number>;
  };
  eventProcessingAdmissions: {
    total: number;
    byState: Record<string, number>;
  };
  chatMessages: {
    total: number;
  };
  agentTurns: {
    total: number;
    byStatus: Record<string, number>;
    tokensTotal: number;
  };
  contextTraces: {
    total: number;
  };
  actionDecisions: {
    total: number;
    byDecidedBy: Record<string, number>;
    byRiskLevel: Record<string, number>;
    evaluatorRequired: number;
  };
  actionExecutions: {
    total: number;
    byStatus: Record<string, number>;
    byActionType: Record<string, number>;
  };
  memoryWrites: {
    total: number;
    byState: Record<string, number>;
  };
  policyAuditEvents: {
    total: number;
    byCategory: Record<string, number>;
    byRiskLevel: Record<string, number>;
    byEventType: Record<string, number>;
  };
  toolCalls: {
    total: number;
    byStatus: Record<string, number>;
    secretsRedacted: number;
  };
  jobs: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    pending: number;
    running: number;
    failed: number;
    expiredRunningLeases: number;
  };
  jobAttempts: {
    total: number;
    byStatus: Record<string, number>;
  };
  workerHeartbeats: {
    total: number;
    byStatus: Record<string, number>;
    byWorkerType: Record<string, number>;
  };
  eventProcessingFailures: {
    total: number;
    byStage: Record<string, number>;
    byConversationType: Record<string, number>;
  };
}

const AGENT_TURN_STATUSES = ['pending', 'running', 'completed', 'failed', 'aborted'] as const;
const INGRESS_DISPOSITIONS = ['accepted', 'duplicate'] as const;
const EVENT_PROCESSING_ADMISSION_STATES = [
  'accepted',
  'processing',
  'completed',
  'failed',
  'interrupted_review',
] as const;
const ACTION_DECIDED_BY_VALUES = ['attention', 'pi', 'evaluator'] as const;
const RISK_LEVELS = ['low', 'medium', 'high', 'prohibited'] as const;
const ACTION_EXECUTION_STATUSES = ['success', 'downgraded', 'failed', 'rejected'] as const;
const ACTION_TYPES = [
  'silent_store',
  'silent_summarize_later',
  'reply_short',
  'reply_full',
  'reply_with_tool',
  'propose_memory',
  'admin_digest',
  'schedule_background_task',
  'dm_user',
  'react_only',
  'send_folded_forward',
  'ask_clarification',
] as const;
const MEMORY_STATES = ['proposed', 'active', 'rejected', 'superseded', 'disabled', 'deleted'] as const;
const AUDIT_CATEGORIES = ['tool', 'memory', 'social', 'evaluator', 'system'] as const;
const TOOL_CALL_STATUSES = ['success', 'error', 'timeout', 'rejected'] as const;
const JOB_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
const JOB_TYPES = [
  'summary',
  'extraction',
  'attention_recheck',
  'retention',
  'admin_digest',
  'conflict',
  'decay',
  'consolidation',
] as const;
const JOB_ATTEMPT_STATUSES = ['running', 'completed', 'failed'] as const;
const WORKER_HEARTBEAT_STATUSES = ['idle', 'running', 'stopping', 'error'] as const;
const WORKER_TYPES = [
  'background',
  'summary',
  'extraction',
  'retention',
  'admin_digest',
  'conflict',
  'decay',
  'consolidation',
] as const;
const EVENT_PROCESSING_STAGES = [
  'raw_event_store',
  'identity_resolution',
  'display_metadata',
  'chat_message_store',
  'attention_analysis',
  'delayed_attention_persist',
  'turn_create',
  'context_building',
  'pi_inference',
  'social_decision',
  'action_execution',
  'bot_response_persist',
  'memory_extraction',
  'memory_extraction_enqueue',
  'turn_complete',
] as const;
const CONVERSATION_TYPES = ['private', 'group'] as const;

const RAW_EVENT_RETENTION_PREDICATE = `raw_events.timestamp < ?
  AND NOT EXISTS (
    SELECT 1 FROM chat_messages WHERE raw_event_id = raw_events.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM agent_turns WHERE trigger_event_id = raw_events.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM memory_sources
    WHERE (resolution_state = 'internal' AND raw_event_id = raw_events.id)
       OR (resolution_state = 'legacy_unresolved'
           AND source_type = 'raw_event'
           AND source_id = raw_events.id)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM event_processing_admissions
    WHERE raw_event_id = raw_events.id
      AND state IN ('accepted', 'processing')
  )`;

const ACTIVE_DELAYED_ATTENTION_CHAT_GUARD = `
  AND NOT EXISTS (
    SELECT 1
    FROM attention_candidates AS candidate
    JOIN jobs AS job ON job.id = candidate.job_id
    WHERE candidate.source_chat_message_id = chat_messages.id
      AND job.status IN ('pending', 'running')
  )`;

const ACTIVE_DELAYED_ATTENTION_RAW_GUARD = `
  AND NOT EXISTS (
    SELECT 1
    FROM attention_candidates AS candidate
    JOIN jobs AS job ON job.id = candidate.job_id
    WHERE candidate.source_raw_event_id = raw_events.id
      AND job.status IN ('pending', 'running')
  )`;

const ACTIVE_GROUP_SUMMARY_CHAT_GUARD = `
  AND NOT EXISTS (
    SELECT 1
    FROM jobs AS summary_job
    JOIN json_each(
      CASE
        WHEN json_valid(summary_job.payload) THEN
          CASE
            WHEN json_type(summary_job.payload, '$.sourceChatMessageIds') = 'array'
              THEN summary_job.payload
            ELSE '{"sourceChatMessageIds":[]}'
          END
        ELSE '{"sourceChatMessageIds":[]}'
      END,
      '$.sourceChatMessageIds'
    ) AS summary_source
    WHERE summary_job.type = 'summary'
      AND summary_job.status IN ('pending', 'running')
      AND summary_source.type = 'text'
      AND summary_source.value = chat_messages.id
  )`;

const ACTIVE_GROUP_SUMMARY_RAW_GUARD = `
  AND NOT EXISTS (
    SELECT 1
    FROM jobs AS summary_job
    JOIN json_each(
      CASE
        WHEN json_valid(summary_job.payload) THEN
          CASE
            WHEN json_type(summary_job.payload, '$.sourceChatMessageIds') = 'array'
              THEN summary_job.payload
            ELSE '{"sourceChatMessageIds":[]}'
          END
        ELSE '{"sourceChatMessageIds":[]}'
      END,
      '$.sourceChatMessageIds'
    ) AS summary_source
    JOIN chat_messages AS summary_message ON summary_message.id = summary_source.value
    WHERE summary_job.type = 'summary'
      AND summary_job.status IN ('pending', 'running')
      AND summary_source.type = 'text'
      AND summary_message.raw_event_id = raw_events.id
  )`;

export async function backupSqliteDatabase(
  options: SqliteBackupOptions,
): Promise<SqliteBackupResult> {
  if (!existsSync(options.sourcePath)) {
    throw new Error(`Source database does not exist: ${options.sourcePath}`);
  }

  ensureParentDirectory(options.backupPath);
  const candidateDirectory = mkdtempSync(
    join(dirname(options.backupPath), '.lethebot-backup-'),
  );
  const candidatePath = join(candidateDirectory, 'candidate.db');
  try {
    chmodSync(candidateDirectory, 0o700);
    const source = new Database(options.sourcePath, { readonly: true });
    try {
      const metadata = await source.backup(candidatePath);
      chmodSync(candidatePath, 0o600);
      const integrity = verifySqliteIntegrity(candidatePath);
      if (!integrity.ok) {
        throw new Error(`Backup integrity check failed: ${integrity.result}`);
      }
      const backupSizeBytes = statSync(candidatePath).size;
      publishFileWithoutOverwrite(candidatePath, options.backupPath, 'Backup database');

      return {
        sourcePath: options.sourcePath,
        backupPath: options.backupPath,
        totalPages: metadata.totalPages,
        remainingPages: metadata.remainingPages,
        integrityOk: integrity.ok,
        integrityResult: integrity.result,
        backupSizeBytes,
      };
    } finally {
      source.close();
    }
  } finally {
    rmSync(candidateDirectory, { recursive: true, force: true });
  }
}

export function restoreSqliteDatabase(
  options: SqliteRestoreOptions,
): SqliteRestoreResult {
  if (!existsSync(options.backupPath)) {
    throw new Error(`Backup database does not exist: ${options.backupPath}`);
  }

  const backupIntegrity = verifySqliteIntegrity(options.backupPath);
  if (!backupIntegrity.ok) {
    throw new Error(`Backup integrity check failed: ${backupIntegrity.result}`);
  }

  if (existsSync(options.targetPath) && !options.overwrite) {
    throw new Error(`Target database already exists: ${options.targetPath}`);
  }

  assertDistinctRestoreFiles(options.backupPath, options.targetPath);
  assertNoRestoreSidecars(options.targetPath);
  ensureParentDirectory(options.targetPath);
  const candidateDirectory = mkdtempSync(
    join(dirname(options.targetPath), '.lethebot-restore-'),
  );
  const candidatePath = join(candidateDirectory, 'candidate.db');

  try {
    chmodSync(candidateDirectory, 0o700);
    copyFileSync(options.backupPath, candidatePath);
    chmodSync(candidatePath, 0o600);
    const restoredIntegrity = verifySqliteIntegrity(candidatePath);
    if (!restoredIntegrity.ok) {
      throw new Error(`Restore candidate integrity check failed: ${restoredIntegrity.result}`);
    }

    const foreignKeyViolations = countSqliteForeignKeyViolations(candidatePath);
    if (foreignKeyViolations > 0) {
      throw new Error(
        `Restore candidate foreign key check failed: ${foreignKeyViolations} violation(s)`,
      );
    }

    if (existsSync(options.targetPath) && !options.overwrite) {
      throw new Error(`Target database already exists: ${options.targetPath}`);
    }
    assertNoRestoreSidecars(options.targetPath);

    const restoredSizeBytes = statSync(candidatePath).size;
    if (options.overwrite) {
      renameSync(candidatePath, options.targetPath);
    } else {
      publishFileWithoutOverwrite(candidatePath, options.targetPath, 'Target database');
    }

    return {
      backupPath: options.backupPath,
      targetPath: options.targetPath,
      integrityOk: true,
      integrityResult: restoredIntegrity.result,
      foreignKeyViolations,
      restoredSizeBytes,
    };
  } finally {
    rmSync(candidateDirectory, { recursive: true, force: true });
  }
}

function publishFileWithoutOverwrite(
  sourcePath: string,
  targetPath: string,
  label: string,
): void {
  try {
    linkSync(sourcePath, targetPath);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new Error(`${label} already exists: ${targetPath}`, { cause: error });
    }
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

export function verifySqliteIntegrity(dbPath: string): { ok: boolean; result: string } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    return {
      ok: row.integrity_check === 'ok',
      result: row.integrity_check,
    };
  } finally {
    db.close();
  }
}

function countSqliteForeignKeyViolations(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('PRAGMA foreign_key_check').all().length;
  } finally {
    db.close();
  }
}

function assertDistinctRestoreFiles(backupPath: string, targetPath: string): void {
  if (!existsSync(targetPath)) {
    return;
  }

  const backup = statSync(backupPath);
  const target = statSync(targetPath);
  if (backup.dev === target.dev && backup.ino === target.ino) {
    throw new Error('Backup and target database must be different files');
  }
}

function assertNoRestoreSidecars(targetPath: string): void {
  if (existsSync(`${targetPath}-wal`) || existsSync(`${targetPath}-shm`)) {
    throw new Error(
      'Target database sidecar exists; stop LetheBot and copy the DB, WAL, and SHM aside before restore',
    );
  }
}

export function applyRetentionPolicy(
  db: BetterSqlite3.Database,
  policy: RetentionPolicy,
  nowMs: number = Date.now(),
): RetentionResult {
  const result: RetentionResult = {
    rawEventsDeleted: 0,
    modelInvocationSourcesDeleted: 0,
    chatMessagesDeleted: 0,
    auditLogDeleted: 0,
    eventProcessingFailuresDeleted: 0,
    memoriesPurged: 0,
    actionMemoryLinksCleared: 0,
    memorySourcesDeleted: 0,
    memoryRevisionsDeleted: 0,
    memoryFtsRowsDeleted: 0,
  };
  const hasDelayedAttentionSchema = db.prepare(
    `SELECT 1
     FROM sqlite_schema
     WHERE type = 'table' AND name = 'attention_candidates'`,
  ).get() !== undefined;
  const activeAttentionChatGuard = hasDelayedAttentionSchema
    ? ACTIVE_DELAYED_ATTENTION_CHAT_GUARD
    : '';
  const rawEventRetentionPredicate = `${RAW_EVENT_RETENTION_PREDICATE}${ACTIVE_GROUP_SUMMARY_RAW_GUARD}${
    hasDelayedAttentionSchema ? ACTIVE_DELAYED_ATTENTION_RAW_GUARD : ''
  }`;

  db.transaction(() => {
    const memoryCutoff = cutoffMs(policy.disabledDeletedMemoryDays, nowMs);
    if (memoryCutoff !== undefined) {
      const memories = db
        .prepare(
          `SELECT id
           FROM memory_records
           WHERE state IN ('disabled', 'deleted') AND updated_at < ?`
        )
        .all(memoryCutoff) as Array<{ id: string }>;

      for (const memory of memories) {
        result.actionMemoryLinksCleared += db
          .prepare('UPDATE action_executions SET executed_memory_id = NULL WHERE executed_memory_id = ?')
          .run(memory.id).changes;
        result.memorySourcesDeleted += db
          .prepare('DELETE FROM memory_sources WHERE memory_id = ?')
          .run(memory.id).changes;
        result.memoryRevisionsDeleted += db
          .prepare('DELETE FROM memory_revisions WHERE memory_id = ?')
          .run(memory.id).changes;
        result.memoriesPurged += db
          .prepare('DELETE FROM memory_records WHERE id = ?')
          .run(memory.id).changes;
      }

      if (memories.length > 0) {
        db.prepare("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')").run();
      }
    }

    const chatCutoff = cutoffMs(policy.chatMessagesDays, nowMs);
    if (chatCutoff !== undefined) {
      result.chatMessagesDeleted = db
        .prepare(
          `DELETE FROM chat_messages
           WHERE timestamp < ?
             AND NOT EXISTS (
               SELECT 1
               FROM memory_sources
               WHERE (resolution_state = 'internal'
                      AND (chat_message_id = chat_messages.id
                           OR raw_event_id = chat_messages.raw_event_id))
                  OR (resolution_state = 'legacy_unresolved'
                      AND ((source_type = 'chat_message'
                            AND (source_id = chat_messages.id
                                 OR source_id = chat_messages.message_id))
                           OR (source_type = 'raw_event'
                               AND source_id = chat_messages.raw_event_id)))
             )
             AND NOT EXISTS (
               SELECT 1
               FROM jobs
               WHERE type = 'extraction'
                 AND status IN ('pending', 'running')
                 AND CASE
                   WHEN json_valid(payload) THEN json_extract(payload, '$.sourceChatMessageId')
                   ELSE NULL
                 END = chat_messages.id
             )
             ${ACTIVE_GROUP_SUMMARY_CHAT_GUARD}
             ${activeAttentionChatGuard}`
        )
        .run(chatCutoff).changes;
    }

    const rawCutoff = cutoffMs(policy.rawEventsDays, nowMs);
    if (rawCutoff !== undefined) {
      result.modelInvocationSourcesDeleted = db
        .prepare(
          `DELETE FROM model_invocation_sources
           WHERE raw_event_id IN (
             SELECT raw_events.id
             FROM raw_events
             WHERE ${rawEventRetentionPredicate}
           )`
        )
        .run(rawCutoff).changes;
      result.rawEventsDeleted = db
        .prepare(
          `DELETE FROM raw_events
           WHERE ${rawEventRetentionPredicate}`
        )
        .run(rawCutoff).changes;
    }

    const auditCutoff = cutoffMs(policy.auditLogDays, nowMs);
    if (auditCutoff !== undefined) {
      result.auditLogDeleted = db
        .prepare('DELETE FROM audit_log WHERE timestamp < ?')
        .run(auditCutoff).changes;
    }

    const eventFailureCutoff = cutoffMs(policy.eventProcessingFailuresDays, nowMs);
    if (eventFailureCutoff !== undefined) {
      result.eventProcessingFailuresDeleted = db
        .prepare('DELETE FROM event_processing_failures WHERE occurred_at < ?')
        .run(eventFailureCutoff).changes;
    }

  })();

  return result;
}

export function collectOperationsMetrics(
  db: BetterSqlite3.Database,
  sinceMs?: number,
  nowMs: number = Date.now(),
): OperationsMetrics {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    sinceMs,
    rawEvents: {
      total: countRows(db, 'raw_events', 'created_at', sinceMs),
    },
    eventIngressReceipts: {
      total: countRows(db, 'event_ingress_receipts', 'received_at', sinceMs),
      byDisposition: countBy(db, 'event_ingress_receipts', 'disposition', 'received_at', sinceMs),
    },
    eventProcessingAdmissions: {
      total: countRows(db, 'event_processing_admissions', 'accepted_at', sinceMs),
      byState: countBy(db, 'event_processing_admissions', 'state', 'accepted_at', sinceMs),
    },
    chatMessages: {
      total: countRows(db, 'chat_messages', 'timestamp', sinceMs),
    },
    agentTurns: {
      total: countRows(db, 'agent_turns', 'started_at', sinceMs),
      byStatus: countBy(db, 'agent_turns', 'status', 'started_at', sinceMs),
      tokensTotal: sumColumn(db, 'agent_turns', 'tokens_total', 'started_at', sinceMs),
    },
    contextTraces: {
      total: countRows(db, 'context_traces', 'created_at', sinceMs),
    },
    actionDecisions: {
      total: countRows(db, 'action_decisions', 'created_at', sinceMs),
      byDecidedBy: countBy(db, 'action_decisions', 'decided_by', 'created_at', sinceMs),
      byRiskLevel: countBy(db, 'action_decisions', 'risk_level', 'created_at', sinceMs),
      evaluatorRequired: sumColumn(db, 'action_decisions', 'evaluator_required', 'created_at', sinceMs),
    },
    actionExecutions: {
      total: countRows(db, 'action_executions', 'executed_at', sinceMs),
      byStatus: countBy(db, 'action_executions', 'status', 'executed_at', sinceMs),
      byActionType: countBy(db, 'action_executions', 'action_type', 'executed_at', sinceMs),
    },
    memoryWrites: {
      total: countRows(db, 'memory_records', 'created_at', sinceMs),
      byState: countBy(db, 'memory_records', 'state', 'created_at', sinceMs),
    },
    policyAuditEvents: {
      total: countRows(db, 'audit_log', 'timestamp', sinceMs),
      byCategory: countBy(db, 'audit_log', 'category', 'timestamp', sinceMs),
      byRiskLevel: countBy(db, 'audit_log', 'risk_level', 'timestamp', sinceMs),
      byEventType: countBy(db, 'audit_log', 'event_type', 'timestamp', sinceMs),
    },
    toolCalls: {
      total: countRows(db, 'tool_calls', 'created_at', sinceMs),
      byStatus: countBy(db, 'tool_calls', 'status', 'created_at', sinceMs),
      secretsRedacted: sumColumn(db, 'tool_calls', 'secrets_redacted', 'created_at', sinceMs),
    },
    jobs: {
      total: countRows(db, 'jobs', 'created_at', sinceMs),
      byStatus: countBy(db, 'jobs', 'status', 'created_at', sinceMs),
      byType: countBy(db, 'jobs', 'type', 'created_at', sinceMs),
      pending: countRowsWhere(db, 'jobs', 'status = ?', ['pending'], 'created_at', sinceMs),
      running: countRowsWhere(db, 'jobs', 'status = ?', ['running'], 'created_at', sinceMs),
      failed: countRowsWhere(db, 'jobs', 'status = ?', ['failed'], 'created_at', sinceMs),
      expiredRunningLeases: countRowsWhere(
        db,
        'jobs',
        'status = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?',
        ['running', nowMs],
        'created_at',
        sinceMs,
      ),
    },
    jobAttempts: {
      total: countRows(db, 'job_attempts', 'started_at', sinceMs),
      byStatus: countBy(db, 'job_attempts', 'status', 'started_at', sinceMs),
    },
    workerHeartbeats: {
      total: countRows(db, 'worker_heartbeats', 'heartbeat_at', sinceMs),
      byStatus: countBy(db, 'worker_heartbeats', 'status', 'heartbeat_at', sinceMs),
      byWorkerType: countBy(db, 'worker_heartbeats', 'worker_type', 'heartbeat_at', sinceMs),
    },
    eventProcessingFailures: {
      total: countRows(db, 'event_processing_failures', 'occurred_at', sinceMs),
      byStage: countBy(db, 'event_processing_failures', 'stage', 'occurred_at', sinceMs),
      byConversationType: countBy(db, 'event_processing_failures', 'conversation_type', 'occurred_at', sinceMs),
    },
  };
}

export function formatOperationsMetricsPrometheus(metrics: OperationsMetrics): string {
  const lines: string[] = [
    '# HELP lethebot_metrics_snapshot_info Count-only LetheBot operations metrics snapshot.',
    '# TYPE lethebot_metrics_snapshot_info gauge',
    'lethebot_metrics_snapshot_info 1',
  ];

  appendGauge(lines, 'lethebot_raw_events_total', 'Raw events stored.', metrics.rawEvents.total);
  appendGauge(
    lines,
    'lethebot_event_ingress_receipts_total',
    'Accepted and duplicate gateway ingress receipts stored.',
    metrics.eventIngressReceipts.total,
  );
  appendLabelCounts(
    lines,
    'lethebot_event_ingress_receipts_disposition_total',
    'Gateway ingress receipts by bounded disposition.',
    'disposition',
    metrics.eventIngressReceipts.byDisposition,
    INGRESS_DISPOSITIONS,
  );
  appendGauge(
    lines,
    'lethebot_event_processing_admissions_total',
    'Durable event-processing admissions stored.',
    metrics.eventProcessingAdmissions.total,
  );
  appendLabelCounts(
    lines,
    'lethebot_event_processing_admissions_state_total',
    'Event-processing admissions by bounded lifecycle state.',
    'state',
    metrics.eventProcessingAdmissions.byState,
    EVENT_PROCESSING_ADMISSION_STATES,
  );
  appendGauge(lines, 'lethebot_chat_messages_total', 'Chat messages stored.', metrics.chatMessages.total);
  appendGauge(lines, 'lethebot_agent_turns_total', 'Agent turns stored.', metrics.agentTurns.total);
  appendGauge(lines, 'lethebot_agent_turn_tokens_total', 'Total tokens recorded on agent turns.', metrics.agentTurns.tokensTotal);
  appendLabelCounts(lines, 'lethebot_agent_turns_status_total', 'Agent turns by status.', 'status', metrics.agentTurns.byStatus, AGENT_TURN_STATUSES);
  appendGauge(lines, 'lethebot_context_traces_total', 'Context traces stored.', metrics.contextTraces.total);
  appendGauge(lines, 'lethebot_action_decisions_total', 'Action decisions stored.', metrics.actionDecisions.total);
  appendGauge(lines, 'lethebot_action_decisions_evaluator_required_total', 'Action decisions requiring evaluator review.', metrics.actionDecisions.evaluatorRequired);
  appendLabelCounts(lines, 'lethebot_action_decisions_decided_by_total', 'Action decisions by decider.', 'decided_by', metrics.actionDecisions.byDecidedBy, ACTION_DECIDED_BY_VALUES);
  appendLabelCounts(lines, 'lethebot_action_decisions_risk_level_total', 'Action decisions by risk level.', 'risk_level', metrics.actionDecisions.byRiskLevel, RISK_LEVELS);
  appendGauge(lines, 'lethebot_action_executions_total', 'Action executions stored.', metrics.actionExecutions.total);
  appendLabelCounts(lines, 'lethebot_action_executions_status_total', 'Action executions by status.', 'status', metrics.actionExecutions.byStatus, ACTION_EXECUTION_STATUSES);
  appendLabelCounts(lines, 'lethebot_action_executions_action_type_total', 'Action executions by action type.', 'action_type', metrics.actionExecutions.byActionType, ACTION_TYPES);
  appendGauge(lines, 'lethebot_memory_writes_total', 'Memory records stored.', metrics.memoryWrites.total);
  appendLabelCounts(lines, 'lethebot_memory_writes_state_total', 'Memory records by lifecycle state.', 'state', metrics.memoryWrites.byState, MEMORY_STATES);
  appendGauge(lines, 'lethebot_policy_audit_events_total', 'Audit events stored.', metrics.policyAuditEvents.total);
  appendLabelCounts(lines, 'lethebot_policy_audit_events_category_total', 'Audit events by category.', 'category', metrics.policyAuditEvents.byCategory, AUDIT_CATEGORIES);
  appendLabelCounts(lines, 'lethebot_policy_audit_events_risk_level_total', 'Audit events by risk level.', 'risk_level', metrics.policyAuditEvents.byRiskLevel, RISK_LEVELS);
  appendGauge(lines, 'lethebot_tool_calls_total', 'Tool calls stored.', metrics.toolCalls.total);
  appendGauge(lines, 'lethebot_tool_calls_secrets_redacted_total', 'Tool calls with secret redaction evidence.', metrics.toolCalls.secretsRedacted);
  appendLabelCounts(lines, 'lethebot_tool_calls_status_total', 'Tool calls by status.', 'status', metrics.toolCalls.byStatus, TOOL_CALL_STATUSES);
  appendGauge(lines, 'lethebot_jobs_total', 'Durable jobs stored.', metrics.jobs.total);
  appendGauge(lines, 'lethebot_jobs_pending_total', 'Durable jobs currently pending.', metrics.jobs.pending);
  appendGauge(lines, 'lethebot_jobs_running_total', 'Durable jobs currently running.', metrics.jobs.running);
  appendGauge(lines, 'lethebot_jobs_failed_total', 'Durable jobs currently failed.', metrics.jobs.failed);
  appendGauge(lines, 'lethebot_jobs_expired_running_leases_total', 'Running durable jobs with expired leases.', metrics.jobs.expiredRunningLeases);
  appendLabelCounts(lines, 'lethebot_jobs_status_total', 'Durable jobs by status.', 'status', metrics.jobs.byStatus, JOB_STATUSES);
  appendLabelCounts(lines, 'lethebot_jobs_type_total', 'Durable jobs by bounded known type.', 'type', metrics.jobs.byType, JOB_TYPES);
  appendGauge(lines, 'lethebot_job_attempts_total', 'Durable job attempts stored.', metrics.jobAttempts.total);
  appendLabelCounts(lines, 'lethebot_job_attempts_status_total', 'Durable job attempts by status.', 'status', metrics.jobAttempts.byStatus, JOB_ATTEMPT_STATUSES);
  appendGauge(lines, 'lethebot_worker_heartbeats_total', 'Worker heartbeat rows stored.', metrics.workerHeartbeats.total);
  appendLabelCounts(lines, 'lethebot_worker_heartbeats_status_total', 'Worker heartbeats by status.', 'status', metrics.workerHeartbeats.byStatus, WORKER_HEARTBEAT_STATUSES);
  appendLabelCounts(lines, 'lethebot_worker_heartbeats_type_total', 'Worker heartbeats by bounded known type.', 'worker_type', metrics.workerHeartbeats.byWorkerType, WORKER_TYPES);
  appendGauge(lines, 'lethebot_event_processing_failures_total', 'Durable event-processing failures stored.', metrics.eventProcessingFailures.total);
  appendLabelCounts(lines, 'lethebot_event_processing_failures_stage_total', 'Event-processing failures by bounded known stage.', 'stage', metrics.eventProcessingFailures.byStage, EVENT_PROCESSING_STAGES);
  appendLabelCounts(lines, 'lethebot_event_processing_failures_conversation_type_total', 'Event-processing failures by conversation type.', 'conversation_type', metrics.eventProcessingFailures.byConversationType, CONVERSATION_TYPES);

  return `${lines.join('\n')}\n`;
}

function cutoffMs(days: number | undefined, nowMs: number): number | undefined {
  if (days === undefined || days <= 0) {
    return undefined;
  }

  return nowMs - days * 24 * 60 * 60 * 1000;
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function countRows(
  db: BetterSqlite3.Database,
  table: string,
  timestampColumn: string,
  sinceMs?: number,
): number {
  const row = sinceMs === undefined
    ? db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
    : db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${timestampColumn} >= ?`).get(sinceMs);

  return readCount(row);
}

function countBy(
  db: BetterSqlite3.Database,
  table: string,
  groupColumn: string,
  timestampColumn: string,
  sinceMs?: number,
): Record<string, number> {
  const where = sinceMs === undefined
    ? `${groupColumn} IS NOT NULL`
    : `${groupColumn} IS NOT NULL AND ${timestampColumn} >= ?`;
  const rows = sinceMs === undefined
    ? db.prepare(`SELECT ${groupColumn} AS key, COUNT(*) AS count FROM ${table} WHERE ${where} GROUP BY ${groupColumn}`).all()
    : db.prepare(`SELECT ${groupColumn} AS key, COUNT(*) AS count FROM ${table} WHERE ${where} GROUP BY ${groupColumn}`).all(sinceMs);

  const counts: Record<string, number> = {};
  for (const row of rows as Array<{ key: string; count: number }>) {
    const key = redactMetricKey(row.key);
    counts[key] = (counts[key] ?? 0) + row.count;
  }

  return counts;
}

function redactMetricKey(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const redacted = redactPlatformIdentifiers(redactSecretsInText(platformRedacted).text);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function countRowsWhere(
  db: BetterSqlite3.Database,
  table: string,
  whereClause: string,
  whereParams: unknown[],
  timestampColumn: string,
  sinceMs?: number,
): number {
  const sql = sinceMs === undefined
    ? `SELECT COUNT(*) AS count FROM ${table} WHERE ${whereClause}`
    : `SELECT COUNT(*) AS count FROM ${table} WHERE ${whereClause} AND ${timestampColumn} >= ?`;
  const params = sinceMs === undefined ? whereParams : [...whereParams, sinceMs];
  return readCount(db.prepare(sql).get(...params));
}

function sumColumn(
  db: BetterSqlite3.Database,
  table: string,
  sumTargetColumn: string,
  timestampColumn: string,
  sinceMs?: number,
): number {
  const row = sinceMs === undefined
    ? db.prepare(`SELECT COALESCE(SUM(${sumTargetColumn}), 0) AS count FROM ${table}`).get()
    : db.prepare(`SELECT COALESCE(SUM(${sumTargetColumn}), 0) AS count FROM ${table} WHERE ${timestampColumn} >= ?`).get(sinceMs);

  return readCount(row);
}

function readCount(row: unknown): number {
  if (typeof row !== 'object' || row === null) {
    return 0;
  }

  const value = (row as { count?: unknown }).count;
  return typeof value === 'number' ? value : 0;
}

function appendGauge(lines: string[], name: string, help: string, value: number): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  lines.push(`${name} ${formatMetricNumber(value)}`);
}

function appendLabelCounts(
  lines: string[],
  name: string,
  help: string,
  labelName: string,
  counts: Record<string, number>,
  allowedValues: readonly string[],
): void {
  const allowed = new Set(allowedValues);
  let other = 0;

  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);

  for (const value of allowedValues) {
    const count = counts[value];
    if (count !== undefined) {
      lines.push(`${name}{${labelName}="${value}"} ${formatMetricNumber(count)}`);
    }
  }

  for (const [value, count] of Object.entries(counts)) {
    if (!allowed.has(value)) {
      other += count;
    }
  }

  if (other > 0) {
    lines.push(`${name}{${labelName}="other"} ${formatMetricNumber(other)}`);
  }
}

function formatMetricNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}
