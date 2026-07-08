import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase, runMigration } from '../../../src/storage/database.js';
import {
  applyRetentionPolicy,
  backupSqliteDatabase,
  collectOperationsMetrics,
  formatOperationsMetricsPrometheus,
  restoreSqliteDatabase,
} from '../../../src/operations/sqlite-maintenance.js';

const migrationPath = join(process.cwd(), 'migrations/001_initial_schema.sql');

describe('SQLite operations maintenance', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lethebot-ops-'));
    tempDirs.push(dir);
    return dir;
  }

  it('backs up and restores a temp SQLite database', async () => {
    const dir = createTempDir();
    const sourcePath = join(dir, 'source.db');
    const backupPath = join(dir, 'backups', 'source.backup.db');
    const restoredPath = join(dir, 'restored.db');
    const db = initDatabase({ path: sourcePath });

    try {
      runMigration(db, migrationPath);
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'evt-backup-1',
        'chat.message.received',
        1782970000000,
        'gateway',
        'qq',
        'private:qq-1',
        '{}',
        1782970000000,
      );

      const backup = await backupSqliteDatabase({ sourcePath, backupPath });
      expect(backup.integrityOk).toBe(true);
      expect(backup.backupSizeBytes).toBeGreaterThan(0);

      const restore = restoreSqliteDatabase({ backupPath, targetPath: restoredPath });
      expect(restore.integrityOk).toBe(true);

      const restored = initDatabase({ path: restoredPath, readonly: true });
      try {
        const row = restored
          .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE id = ?')
          .get('evt-backup-1') as { count: number };
        expect(row.count).toBe(1);
      } finally {
        closeDatabase(restored);
      }
    } finally {
      closeDatabase(db);
    }
  });

  it('applies retention without breaking foreign keys', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'retention.db') });
    const now = Date.UTC(2026, 6, 2);
    const old = now - 40 * 24 * 60 * 60 * 1000;
    const recent = now - 5 * 24 * 60 * 60 * 1000;

    try {
      runMigration(db, migrationPath);
      insertRawEvent(db, 'evt-old-chat', old);
      insertRawEvent(db, 'evt-recent-chat', recent);
      insertChatMessage(db, 'msg-old', 'evt-old-chat', old);
      insertChatMessage(db, 'msg-recent', 'evt-recent-chat', recent);
      insertEventProcessingFailure(db, 'failure-old', 'evt-old-chat', undefined, old);
      insertEventProcessingFailure(db, 'failure-recent', 'evt-recent-chat', undefined, recent);
      insertAudit(db, 'audit-old', old);
      insertMemory(db, 'mem-old-deleted', 'deleted', old);
      insertMemory(db, 'mem-old-active', 'active', old);
      db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by
        ) VALUES (?, ?, ?, ?, ?)`
      ).run('mem-old-deleted', 'raw_event', 'evt-old-chat', old, 'test');
      db.prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type, previous_state, new_state,
          reason, actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('rev-old-deleted', 'mem-old-deleted', 1, 'delete', null, '{}', 'test', 'admin', old);

      const result = applyRetentionPolicy(db, {
        rawEventsDays: 30,
        chatMessagesDays: 30,
        auditLogDays: 30,
        disabledDeletedMemoryDays: 30,
        eventProcessingFailuresDays: 30,
      }, now);

      expect(result.chatMessagesDeleted).toBe(1);
      expect(result.rawEventsDeleted).toBe(1);
      expect(result.auditLogDeleted).toBe(1);
      expect(result.eventProcessingFailuresDeleted).toBe(1);
      expect(result.memoriesPurged).toBe(1);
      expect(result.memorySourcesDeleted).toBe(1);
      expect(result.memoryRevisionsDeleted).toBe(1);

      expect(count(db, 'chat_messages', 'id', 'msg-old')).toBe(0);
      expect(count(db, 'raw_events', 'id', 'evt-old-chat')).toBe(0);
      expect(count(db, 'chat_messages', 'id', 'msg-recent')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-recent-chat')).toBe(1);
      expect(count(db, 'event_processing_failures', 'id', 'failure-old')).toBe(0);
      expect(count(db, 'event_processing_failures', 'id', 'failure-recent')).toBe(1);
      expect(count(db, 'memory_records', 'id', 'mem-old-deleted')).toBe(0);
      expect(count(db, 'memory_records', 'id', 'mem-old-active')).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('collects operations metrics for turns, memory writes, policy audit, and tools', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'metrics.db') });
    const now = Date.UTC(2026, 6, 2);

    try {
      runMigration(db, migrationPath);
      insertRawEvent(db, 'evt-metrics', now);
      insertChatMessage(db, 'msg-metrics', 'evt-metrics', now);
      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, pi_model, pi_provider,
          response_text, status, tokens_input, tokens_output, tokens_total,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'turn-metrics',
        'private:qq-1',
        'evt-metrics',
        'mock',
        'mock',
        'ok',
        'completed',
        3,
        4,
        7,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO context_traces (
          id, turn_id, conversation_id, conversation_type, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'ctx-metrics',
        'turn-metrics',
        'private:qq-1',
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
        now,
      );
      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-metrics',
        'turn-metrics',
        'evaluator',
        'medium',
        0.9,
        1,
        1,
        '[]',
        '[]',
        '[]',
        now,
      );
      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status,
          audit_level, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'execution-metrics',
        'decision-metrics',
        'reply_full',
        'success',
        'summary',
        now,
      );
      insertMemory(db, 'mem-metrics', 'active', now);
      insertAudit(db, 'audit-metrics', now);
      db.prepare(
        `INSERT INTO tool_calls (
          id, turn_id, tool_name, input, output, requested_by,
          actor_class, invocation_context, status,
          execution_time_ms, secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'tool-metrics',
        'turn-metrics',
        'test.tool',
        '{}',
        '{}',
        'pi',
        'user',
        'private_chat',
        'success',
        12,
        1,
        now,
      );
      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          lease_owner, lease_expires_at,
          created_at, updated_at, scheduled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'job-metrics',
        'summary',
        '{}',
        'running',
        1,
        3,
        'worker-metrics',
        now - 1,
        now,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO job_attempts (
          id, job_id, attempt_number, worker_id, status,
          started_at, completed_at, heartbeat_at, result
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'attempt-metrics',
        'job-metrics',
        1,
        'worker-metrics',
        'running',
        now,
        null,
        now,
        null,
      );
      db.prepare(
        `INSERT INTO worker_heartbeats (
          worker_id, worker_type, status, heartbeat_at, details
        ) VALUES (?, ?, ?, ?, ?)`
      ).run(
        'worker-metrics',
        'background',
        'idle',
        now,
        '{}',
      );
      insertEventProcessingFailure(db, 'failure-metrics', 'evt-metrics', 'turn-metrics', now);

      const metrics = collectOperationsMetrics(db, now - 1000, now);

      expect(metrics.rawEvents.total).toBe(1);
      expect(metrics.chatMessages.total).toBe(1);
      expect(metrics.agentTurns.total).toBe(1);
      expect(metrics.agentTurns.byStatus.completed).toBe(1);
      expect(metrics.agentTurns.tokensTotal).toBe(7);
      expect(metrics.contextTraces.total).toBe(1);
      expect(metrics.actionDecisions.total).toBe(1);
      expect(metrics.actionDecisions.byDecidedBy.evaluator).toBe(1);
      expect(metrics.actionDecisions.byRiskLevel.medium).toBe(1);
      expect(metrics.actionDecisions.evaluatorRequired).toBe(1);
      expect(metrics.actionExecutions.total).toBe(1);
      expect(metrics.actionExecutions.byStatus.success).toBe(1);
      expect(metrics.actionExecutions.byActionType.reply_full).toBe(1);
      expect(metrics.memoryWrites.total).toBe(1);
      expect(metrics.memoryWrites.byState.active).toBe(1);
      expect(metrics.policyAuditEvents.total).toBe(1);
      expect(metrics.policyAuditEvents.byCategory.system).toBe(1);
      expect(metrics.toolCalls.total).toBe(1);
      expect(metrics.toolCalls.byStatus.success).toBe(1);
      expect(metrics.toolCalls.secretsRedacted).toBe(1);
      expect(metrics.jobs.total).toBe(1);
      expect(metrics.jobs.byStatus.running).toBe(1);
      expect(metrics.jobs.byType.summary).toBe(1);
      expect(metrics.jobs.pending).toBe(0);
      expect(metrics.jobs.running).toBe(1);
      expect(metrics.jobs.failed).toBe(0);
      expect(metrics.jobs.expiredRunningLeases).toBe(1);
      expect(metrics.jobAttempts.total).toBe(1);
      expect(metrics.jobAttempts.byStatus.running).toBe(1);
      expect(metrics.workerHeartbeats.total).toBe(1);
      expect(metrics.workerHeartbeats.byStatus.idle).toBe(1);
      expect(metrics.workerHeartbeats.byWorkerType.background).toBe(1);
      expect(metrics.eventProcessingFailures.total).toBe(1);
      expect(metrics.eventProcessingFailures.byStage.pi_inference).toBe(1);
      expect(metrics.eventProcessingFailures.byConversationType.private).toBe(1);

      const prometheus = formatOperationsMetricsPrometheus({
        ...metrics,
        jobs: {
          ...metrics.jobs,
          byType: {
            ...metrics.jobs.byType,
            'qq-12345678': 2,
          },
        },
        workerHeartbeats: {
          ...metrics.workerHeartbeats,
          byWorkerType: {
            ...metrics.workerHeartbeats.byWorkerType,
            'sk-abcdefghijklmnopqrstuvwxyz123456': 3,
          },
        },
        eventProcessingFailures: {
          ...metrics.eventProcessingFailures,
          byStage: {
            ...metrics.eventProcessingFailures.byStage,
            'custom-stage-qq-87654321': 4,
          },
        },
      });
      expect(prometheus).toContain('lethebot_raw_events_total 1');
      expect(prometheus).toContain('lethebot_agent_turns_status_total{status="completed"} 1');
      expect(prometheus).toContain('lethebot_jobs_type_total{type="summary"} 1');
      expect(prometheus).toContain('lethebot_jobs_type_total{type="other"} 2');
      expect(prometheus).toContain('lethebot_worker_heartbeats_type_total{worker_type="other"} 3');
      expect(prometheus).toContain('lethebot_event_processing_failures_stage_total{stage="other"} 4');
      expect(prometheus).not.toContain('qq-12345678');
      expect(prometheus).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
      expect(prometheus).not.toContain('custom-stage-qq-87654321');
      expect(prometheus).not.toContain('private:qq-1');
      expect(prometheus).not.toContain('job-metrics');
    } finally {
      closeDatabase(db);
    }
  });
});

function insertRawEvent(db: ReturnType<typeof initDatabase>, id: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform,
      conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    'chat.message.received',
    timestamp,
    'gateway',
    'qq',
    'private:qq-1',
    '{}',
    timestamp,
  );
}

function insertChatMessage(
  db: ReturnType<typeof initDatabase>,
  id: string,
  rawEventId: string,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id,
      conversation_type, sender_id, text, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, rawEventId, id, 'private:qq-1', 'private', 'qq-1', 'hello', timestamp);
}

function insertAudit(db: ReturnType<typeof initDatabase>, id: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO audit_log (
      id, timestamp, category, level, event_type, event_id,
      actor_class, invocation_context, summary, redacted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    timestamp,
    'system',
    'summary',
    'policy.test',
    id,
    'system',
    'system',
    'test audit',
    0,
  );
}

function insertEventProcessingFailure(
  db: ReturnType<typeof initDatabase>,
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

function insertMemory(
  db: ReturnType<typeof initDatabase>,
  id: string,
  state: 'active' | 'deleted',
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO memory_records (
      id, scope, visibility, sensitivity, authority,
      kind, title, content, state, confidence, importance,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    'system',
    'owner_admin_only',
    'normal',
    'system',
    'fact',
    id,
    'content',
    state,
    0.9,
    0.5,
    timestamp,
    timestamp,
  );
}

function count(db: ReturnType<typeof initDatabase>, table: string, column: string, value: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(value) as { count: number };
  return row.count;
}
