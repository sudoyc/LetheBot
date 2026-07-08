/**
 * Durable background job repository.
 *
 * Provides idempotent enqueue, leasing/claiming, per-attempt rows, retry state,
 * and worker heartbeats for local-first background workers.
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type JobAttemptStatus = 'running' | 'completed' | 'failed';
export type WorkerHeartbeatStatus = 'idle' | 'running' | 'stopping' | 'error';

export interface EnqueueJobInput {
  id?: string;
  type: string;
  payload: unknown;
  idempotencyKey?: string;
  scheduledAt?: number | Date;
  maxAttempts?: number;
  now?: number;
}

export interface JobRecord {
  id: string;
  type: string;
  payload: unknown;
  idempotencyKey?: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  heartbeatAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  scheduledAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  result?: unknown;
}

export interface ClaimedJob {
  job: JobRecord;
  attemptId: string;
  attemptNumber: number;
}

export interface ClaimJobOptions {
  workerId: string;
  now?: number;
  leaseMs?: number;
  types?: string[];
}

export interface CompleteJobOptions {
  jobId: string;
  attemptId: string;
  result?: unknown;
  now?: number;
}

export interface FailJobOptions {
  jobId: string;
  attemptId: string;
  error: string;
  terminal?: boolean;
  retryDelayMs?: number;
  now?: number;
}

export interface HeartbeatOptions {
  workerId: string;
  workerType: string;
  status: WorkerHeartbeatStatus;
  currentJobId?: string;
  details?: object;
  now?: number;
}

interface JobRow {
  id: string;
  type: string;
  payload: string;
  idempotency_key: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  result: string | null;
}

interface AttemptNumberRow {
  attempts: number;
  max_attempts: number;
}

export class JobRepository {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: EnqueueJobInput): string {
    if (input.idempotencyKey) {
      const existing = this.db
        .prepare('SELECT id FROM jobs WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as { id: string } | undefined;
      if (existing) {
        return existing.id;
      }
    }

    const id = input.id ?? ulid();
    const now = input.now ?? Date.now();
    const scheduledAt = this.toMillis(input.scheduledAt ?? now);

    this.db
      .prepare(
        `INSERT INTO jobs (
          id, type, payload, idempotency_key,
          status, attempts, max_attempts,
          created_at, updated_at, scheduled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.type,
        JSON.stringify(input.payload),
        input.idempotencyKey ?? null,
        'pending',
        0,
        input.maxAttempts ?? 3,
        now,
        now,
        scheduledAt
      );

    return id;
  }

  findById(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  list(options: { status?: JobStatus; type?: string; limit?: number } = {}): JobRecord[] {
    const params: unknown[] = [];
    let sql = 'SELECT * FROM jobs WHERE 1=1';

    if (options.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }

    if (options.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }

    sql += ' ORDER BY scheduled_at ASC, created_at ASC LIMIT ?';
    params.push(options.limit ?? 100);

    return (this.db.prepare(sql).all(...params) as JobRow[]).map((row) => this.rowToJob(row));
  }

  getWorkerHeartbeatStatus(workerId: string): WorkerHeartbeatStatus | undefined {
    const row = this.db
      .prepare('SELECT status FROM worker_heartbeats WHERE worker_id = ?')
      .get(workerId) as { status: WorkerHeartbeatStatus } | undefined;
    return row?.status;
  }

  claimNext(options: ClaimJobOptions): ClaimedJob | null {
    const now = options.now ?? Date.now();
    const leaseMs = options.leaseMs ?? 60_000;
    const typeFilter = this.buildTypeFilter(options.types);

    const transaction = this.db.transaction((): ClaimedJob | null => {
      this.failExpiredMaxAttemptLeases(typeFilter, now);

      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE attempts < max_attempts
             AND ${typeFilter.sql}
             AND (
               (status = 'pending' AND scheduled_at <= ?)
               OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
           ORDER BY scheduled_at ASC, created_at ASC
           LIMIT 1`
        )
        .get(...typeFilter.params, now, now) as JobRow | undefined;

      if (!row) {
        return null;
      }

      const attemptNumber = row.attempts + 1;
      const attemptId = ulid();
      const leaseExpiresAt = now + leaseMs;
      const staleLeaseError = redactJobDiagnosticText(
        `Lease expired before retry by ${options.workerId}`
      );

      if (row.status === 'running') {
        this.db
          .prepare(
            `UPDATE job_attempts
             SET status = 'failed', completed_at = COALESCE(completed_at, ?),
                 heartbeat_at = ?, error = COALESCE(error, ?)
             WHERE job_id = ? AND status = 'running'`
          )
          .run(now, now, staleLeaseError, row.id);
      }

      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'running', attempts = ?, started_at = COALESCE(started_at, ?),
               updated_at = ?, lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?
           WHERE id = ?`
        )
        .run(attemptNumber, now, now, options.workerId, leaseExpiresAt, now, row.id);

      this.db
        .prepare(
          `INSERT INTO job_attempts (
            id, job_id, attempt_number, worker_id, status, started_at, heartbeat_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(attemptId, row.id, attemptNumber, options.workerId, 'running', now, now);

      const updated = this.findById(row.id);
      if (!updated) {
        throw new Error(`Claimed job ${row.id} disappeared`);
      }

      return { job: updated, attemptId, attemptNumber };
    });

    return transaction();
  }

  private failExpiredMaxAttemptLeases(typeFilter: { sql: string; params: unknown[] }, now: number): void {
    const error = 'Lease expired after max attempts';

    this.db
      .prepare(
        `UPDATE job_attempts
         SET status = 'failed', completed_at = COALESCE(completed_at, ?),
             heartbeat_at = ?, error = COALESCE(error, ?)
         WHERE status = 'running'
           AND job_id IN (
             SELECT id FROM jobs
             WHERE status = 'running'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?
               AND attempts >= max_attempts
               AND ${typeFilter.sql}
           )`
      )
      .run(now, now, error, now, ...typeFilter.params);

    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed', completed_at = COALESCE(completed_at, ?),
             updated_at = ?, error = ?,
             lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ?
         WHERE status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
           AND attempts >= max_attempts
           AND ${typeFilter.sql}`
      )
      .run(now, now, error, now, now, ...typeFilter.params);
  }

  complete(options: CompleteJobOptions): void {
    const now = options.now ?? Date.now();
    const transaction = this.db.transaction(() => {
      const resultJson =
        options.result === undefined ? null : JSON.stringify(redactStructuredDiagnostics(options.result));

      const attemptResult = this.db
        .prepare(
          `UPDATE job_attempts
           SET status = 'completed', completed_at = ?, heartbeat_at = ?, result = ?
           WHERE id = ? AND job_id = ? AND status = 'running'`
        )
        .run(now, now, resultJson, options.attemptId, options.jobId);

      if (attemptResult.changes === 0) {
        return;
      }

      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'completed', completed_at = ?, updated_at = ?, result = ?,
               lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ?
           WHERE id = ? AND status = 'running'`
        )
        .run(now, now, resultJson, now, options.jobId);
    });

    transaction();
  }

  fail(options: FailJobOptions): void {
    const now = options.now ?? Date.now();
    const retryDelayMs = options.retryDelayMs ?? 0;
    const redactedError = redactJobDiagnosticText(options.error);
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT attempts, max_attempts FROM jobs WHERE id = ?')
        .get(options.jobId) as AttemptNumberRow | undefined;
      if (!row) {
        return;
      }

      const shouldRetry = !options.terminal && row.attempts < row.max_attempts;
      const nextStatus: JobStatus = shouldRetry ? 'pending' : 'failed';
      const scheduledAt = shouldRetry ? now + retryDelayMs : now;
      const completedAt = shouldRetry ? null : now;

      const attemptResult = this.db
        .prepare(
          `UPDATE job_attempts
           SET status = 'failed', completed_at = ?, heartbeat_at = ?, error = ?
           WHERE id = ? AND job_id = ? AND status = 'running'`
        )
        .run(now, now, redactedError, options.attemptId, options.jobId);

      if (attemptResult.changes === 0) {
        return;
      }

      this.db
        .prepare(
          `UPDATE jobs
           SET status = ?, scheduled_at = ?, completed_at = ?, updated_at = ?, error = ?,
               lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ?
           WHERE id = ? AND status = 'running'`
        )
        .run(nextStatus, scheduledAt, completedAt, now, redactedError, now, options.jobId);
    });

    transaction();
  }

  heartbeat(options: HeartbeatOptions): void {
    const now = options.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO worker_heartbeats (
          worker_id, worker_type, status, current_job_id, heartbeat_at, details
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET
          worker_type = excluded.worker_type,
          status = excluded.status,
          current_job_id = excluded.current_job_id,
          heartbeat_at = excluded.heartbeat_at,
          details = excluded.details`
      )
      .run(
        options.workerId,
        options.workerType,
        options.status,
        options.currentJobId ?? null,
        now,
        options.details ? JSON.stringify(redactStructuredDiagnostics(options.details)) : null
      );
  }

  extendLease(options: { jobId: string; attemptId: string; workerId: string; leaseMs: number; now?: number }): void {
    const now = options.now ?? Date.now();
    const leaseExpiresAt = now + options.leaseMs;
    const transaction = this.db.transaction(() => {
      const attemptResult = this.db
        .prepare(
          `UPDATE job_attempts
           SET heartbeat_at = ?
           WHERE id = ? AND job_id = ? AND worker_id = ? AND status = 'running'`
        )
        .run(now, options.attemptId, options.jobId, options.workerId);

      if (attemptResult.changes === 0) {
        return;
      }

      this.db
        .prepare(
          `UPDATE jobs
           SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`
        )
        .run(options.workerId, leaseExpiresAt, now, now, options.jobId, options.workerId);
    });

    transaction();
  }

  private buildTypeFilter(types: string[] | undefined): { sql: string; params: unknown[] } {
    if (!types || types.length === 0) {
      return { sql: '1=1', params: [] };
    }

    return {
      sql: `type IN (${types.map(() => '?').join(', ')})`,
      params: types,
    };
  }

  private toMillis(value: number | Date): number {
    return value instanceof Date ? value.getTime() : value;
  }

  private rowToJob(row: JobRow): JobRecord {
    return {
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload) as unknown,
      idempotencyKey: row.idempotency_key ?? undefined,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      leaseOwner: row.lease_owner ?? undefined,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : undefined,
      heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      scheduledAt: new Date(row.scheduled_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      error: row.error ?? undefined,
      result: row.result ? JSON.parse(row.result) as unknown : undefined,
    };
  }
}

function redactJobDiagnosticText(text: string): string {
  const platformRedacted = redactPlatformIdentifiers(text);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function redactStructuredDiagnostics(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactJobDiagnosticText(value);
  }

  if (typeof value === 'number') {
    return shouldRedactNumericPlatformId([], value) ? '[REDACTED:platform_id]' : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredDiagnostics(item));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactJobDiagnosticText(key),
        redactStructuredDiagnosticValue(item, [key]),
      ])
    );
  }

  return value;
}

function redactStructuredDiagnosticValue(value: unknown, path: string[]): unknown {
  if (typeof value === 'string') {
    return redactJobDiagnosticText(value);
  }

  if (typeof value === 'number') {
    return shouldRedactNumericPlatformId(path, value) ? '[REDACTED:platform_id]' : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredDiagnosticValue(item, path));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactJobDiagnosticText(key),
        redactStructuredDiagnosticValue(item, [...path, key]),
      ])
    );
  }

  return value;
}

function shouldRedactNumericPlatformId(path: string[], value: number): boolean {
  return Number.isInteger(value)
    && isPlatformIdField(path)
    && /^\d{8,12}$/.test(String(Math.abs(value)));
}

function isPlatformIdField(path: string[]): boolean {
  const key = path.at(-1);
  if (!key) {
    return false;
  }

  return /(^|_)(?:target|subject|recipient|actor|owner)?[_-]?(user|sender|group|message|conversation|platform|qq)[_-]?ids?$/i.test(key)
    || /^(?:target|subject|recipient|actor|owner)?(?:User|Sender|Group|Message|Conversation|Platform|Qq)Ids?$/i.test(key)
    || /^(userId|senderId|groupId|messageId|conversationId|platformUserId|platformMessageId)$/i.test(key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
