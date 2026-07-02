/**
 * SQLite maintenance helpers for local-first operations.
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';

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
  restoredSizeBytes: number;
}

export interface RetentionPolicy {
  rawEventsDays?: number;
  chatMessagesDays?: number;
  auditLogDays?: number;
  disabledDeletedMemoryDays?: number;
}

export interface RetentionResult {
  rawEventsDeleted: number;
  chatMessagesDeleted: number;
  auditLogDeleted: number;
  memoriesPurged: number;
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
  chatMessages: {
    total: number;
  };
  agentTurns: {
    total: number;
    byStatus: Record<string, number>;
    tokensTotal: number;
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
}

export async function backupSqliteDatabase(
  options: SqliteBackupOptions,
): Promise<SqliteBackupResult> {
  if (!existsSync(options.sourcePath)) {
    throw new Error(`Source database does not exist: ${options.sourcePath}`);
  }

  ensureParentDirectory(options.backupPath);

  const source = new Database(options.sourcePath, { readonly: true });
  try {
    const metadata = await source.backup(options.backupPath);
    const integrity = verifySqliteIntegrity(options.backupPath);
    const backupSizeBytes = statSync(options.backupPath).size;

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

  ensureParentDirectory(options.targetPath);
  if (existsSync(options.targetPath)) {
    rmSync(options.targetPath, { force: true });
  }

  copyFileSync(options.backupPath, options.targetPath);
  const restoredIntegrity = verifySqliteIntegrity(options.targetPath);
  const restoredSizeBytes = statSync(options.targetPath).size;

  return {
    backupPath: options.backupPath,
    targetPath: options.targetPath,
    integrityOk: restoredIntegrity.ok,
    integrityResult: restoredIntegrity.result,
    restoredSizeBytes,
  };
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

export function applyRetentionPolicy(
  db: BetterSqlite3.Database,
  policy: RetentionPolicy,
  nowMs: number = Date.now(),
): RetentionResult {
  const result: RetentionResult = {
    rawEventsDeleted: 0,
    chatMessagesDeleted: 0,
    auditLogDeleted: 0,
    memoriesPurged: 0,
    memorySourcesDeleted: 0,
    memoryRevisionsDeleted: 0,
    memoryFtsRowsDeleted: 0,
  };

  db.transaction(() => {
    const chatCutoff = cutoffMs(policy.chatMessagesDays, nowMs);
    if (chatCutoff !== undefined) {
      result.chatMessagesDeleted = db
        .prepare('DELETE FROM chat_messages WHERE timestamp < ?')
        .run(chatCutoff).changes;
    }

    const rawCutoff = cutoffMs(policy.rawEventsDays, nowMs);
    if (rawCutoff !== undefined) {
      result.rawEventsDeleted = db
        .prepare(
          `DELETE FROM raw_events
           WHERE timestamp < ?
             AND id NOT IN (SELECT raw_event_id FROM chat_messages)
             AND id NOT IN (SELECT trigger_event_id FROM agent_turns)`
        )
        .run(rawCutoff).changes;
    }

    const auditCutoff = cutoffMs(policy.auditLogDays, nowMs);
    if (auditCutoff !== undefined) {
      result.auditLogDeleted = db
        .prepare('DELETE FROM audit_log WHERE timestamp < ?')
        .run(auditCutoff).changes;
    }

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
    chatMessages: {
      total: countRows(db, 'chat_messages', 'timestamp', sinceMs),
    },
    agentTurns: {
      total: countRows(db, 'agent_turns', 'started_at', sinceMs),
      byStatus: countBy(db, 'agent_turns', 'status', 'started_at', sinceMs),
      tokensTotal: sumColumn(db, 'agent_turns', 'tokens_total', 'started_at', sinceMs),
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
  };
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
    counts[row.key] = row.count;
  }

  return counts;
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
