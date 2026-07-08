/**
 * Opt-in worker scheduler soak helpers.
 *
 * This is intentionally local and aggregate-only: it exercises the durable
 * JobRepository/BackgroundWorker/WorkerScheduler path without exposing job
 * payloads, worker details, or error text in the returned evidence.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { BackgroundWorker, type TaskResult } from '../workers/background.js';
import { WorkerScheduler, type SchedulerLogger } from '../workers/scheduler.js';
import { JobRepository } from '../storage/job-repository.js';

export interface WorkerSchedulerSoakOptions {
  db: BetterSqlite3.Database;
  durationMs?: number;
  intervalMs?: number;
  workerId?: string;
}

export interface WorkerSchedulerSoakResult {
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  intervalMs: number;
  ticks: number;
  processed: number;
  outcomes: {
    byStatus: Record<string, number>;
  };
  jobs: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  jobAttempts: {
    total: number;
    byStatus: Record<string, number>;
    running: number;
    completed: number;
    failed: number;
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
  } | null;
  foreignKeyViolations: number;
  success: boolean;
}

interface JobStatusRow {
  type: string;
  status: string;
}

interface AttemptStatusRow {
  status: string;
}

interface WorkerHeartbeatRow {
  worker_type: string;
  status: string;
  current_job_id: string | null;
}

const silentSchedulerLogger: SchedulerLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
};

export async function runWorkerSchedulerSoak(
  options: WorkerSchedulerSoakOptions,
): Promise<WorkerSchedulerSoakResult> {
  const durationMs = options.durationMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const workerId = options.workerId ?? 'ops-worker-soak';
  const leaseMs = Math.max(intervalMs * 4, 40);
  const runId = randomUUID();
  const startedAtMs = Date.now();
  const jobRepository = new JobRepository(options.db);
  const scheduler = new WorkerScheduler({ logger: silentSchedulerLogger });
  const outcomes: TaskResult[] = [];
  let ticks = 0;
  let inFlight = false;
  let extractionAttempts = 0;
  let leaseExtensionCount = 0;
  let leaseExtensionObserved: (() => void) | undefined;
  const leaseExtensionPromise = new Promise<void>((resolve) => {
    leaseExtensionObserved = resolve;
  });
  const originalExtendLease = jobRepository.extendLease.bind(jobRepository);

  jobRepository.extendLease = (extendOptions) => {
    originalExtendLease(extendOptions);
    leaseExtensionCount += 1;
    leaseExtensionObserved?.();
  };

  const worker = new BackgroundWorker({
    jobRepository,
    workerId,
    leaseMs,
    handlers: {
      summary: async () => ({
        completed: true,
        leaseExtensionObserved: await waitForLeaseExtension(
          () => leaseExtensionCount > 0,
          leaseExtensionPromise,
          Math.max(leaseMs + intervalMs, intervalMs * 6),
        ),
      }),
      extraction: async () => {
        extractionAttempts += 1;
        if (extractionAttempts === 1) {
          throw new Error('planned worker soak retry');
        }
        return { extracted: 1 };
      },
      retention: async () => ({ retained: true }),
      admin_digest: async () => ({ generated: true }),
      conflict: async () => ({ conflictCount: 0 }),
      decay: async () => ({ candidateCount: 0 }),
      consolidation: async () => ({ groupCount: 0 }),
    },
  });

  const jobIds = [
    worker.enqueue({
      type: 'summary',
      payload: { conversationId: `worker-soak-${runId}` },
      idempotencyKey: `worker-soak:${runId}:summary`,
      maxAttempts: 2,
    }),
    worker.enqueue({
      type: 'extraction',
      payload: { conversationId: `worker-soak-${runId}`, extractionHint: 'planned-retry' },
      idempotencyKey: `worker-soak:${runId}:extraction`,
      maxAttempts: 3,
    }),
    worker.enqueue({
      type: 'retention',
      payload: { dryRun: true },
      idempotencyKey: `worker-soak:${runId}:retention`,
      scheduledAt: startedAtMs + intervalMs * 2,
      maxAttempts: 2,
    }),
    worker.enqueue({
      type: 'admin_digest',
      payload: { sinceMs: startedAtMs - intervalMs, untilMs: startedAtMs },
      idempotencyKey: `worker-soak:${runId}:admin-digest`,
      scheduledAt: startedAtMs + intervalMs * 3,
      maxAttempts: 2,
    }),
    worker.enqueue({
      type: 'conflict',
      payload: { limit: 10 },
      idempotencyKey: `worker-soak:${runId}:conflict`,
      scheduledAt: startedAtMs + intervalMs * 4,
      maxAttempts: 2,
    }),
    worker.enqueue({
      type: 'decay',
      payload: { limit: 10, dryRun: true },
      idempotencyKey: `worker-soak:${runId}:decay`,
      scheduledAt: startedAtMs + intervalMs * 5,
      maxAttempts: 2,
    }),
    worker.enqueue({
      type: 'consolidation',
      payload: { limit: 10 },
      idempotencyKey: `worker-soak:${runId}:consolidation`,
      scheduledAt: startedAtMs + intervalMs * 6,
      maxAttempts: 2,
    }),
  ];

  scheduler.register({
    name: `worker-soak-${runId}`,
    intervalMs,
    handler: async () => {
      if (inFlight) {
        return;
      }

      inFlight = true;
      ticks += 1;
      try {
        const result = await worker.processNext();
        if (result) {
          outcomes.push(result);
        }
      } finally {
        inFlight = false;
      }
    },
  });

  scheduler.start();
  try {
    await sleep(durationMs);
  } finally {
    scheduler.stop();
  }

  const completedAtMs = Date.now();
  const jobs = readJobRows(options.db, jobIds);
  const attempts = readAttemptRows(options.db, jobIds);
  const heartbeat = options.db
    .prepare(
      `SELECT worker_type, status, current_job_id
       FROM worker_heartbeats
       WHERE worker_id = ?`
    )
    .get(workerId) as WorkerHeartbeatRow | undefined;
  const foreignKeyViolations = options.db.prepare('PRAGMA foreign_key_check').all().length;
  const jobsByStatus = countBy(jobs.map((row) => row.status));
  const jobsByType = countBy(jobs.map((row) => row.type));
  const attemptsByStatus = countBy(attempts.map((row) => row.status));
  const outcomesByStatus = countBy(outcomes.map((result) => result.status));
  const completedJobs = jobsByStatus.completed ?? 0;
  const runningAttempts = attemptsByStatus.running ?? 0;
  const failedAttempts = attemptsByStatus.failed ?? 0;
  const completedAttempts = attemptsByStatus.completed ?? 0;
  const heartbeatSummary = heartbeat
    ? {
        workerType: heartbeat.worker_type,
        status: heartbeat.status,
        currentJobIdPresent: heartbeat.current_job_id !== null,
      }
    : null;

  return {
    runId,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs,
    intervalMs,
    ticks,
    processed: outcomes.length,
    outcomes: {
      byStatus: outcomesByStatus,
    },
    jobs: {
      total: jobs.length,
      byStatus: jobsByStatus,
      byType: jobsByType,
      pending: jobsByStatus.pending ?? 0,
      running: jobsByStatus.running ?? 0,
      completed: completedJobs,
      failed: jobsByStatus.failed ?? 0,
    },
    jobAttempts: {
      total: attempts.length,
      byStatus: attemptsByStatus,
      running: runningAttempts,
      completed: completedAttempts,
      failed: failedAttempts,
      plannedRetryObserved: failedAttempts >= 1 && completedAttempts >= 3,
    },
    leaseExtensions: {
      observed: leaseExtensionCount > 0,
      count: leaseExtensionCount,
    },
    workerHeartbeat: heartbeatSummary,
    foreignKeyViolations,
    success:
      completedJobs === jobIds.length &&
      runningAttempts === 0 &&
      failedAttempts >= 1 &&
      leaseExtensionCount > 0 &&
      heartbeatSummary?.status === 'idle' &&
      heartbeatSummary.currentJobIdPresent === false &&
      foreignKeyViolations === 0,
  };
}

function readJobRows(db: BetterSqlite3.Database, jobIds: string[]): JobStatusRow[] {
  const placeholders = jobIds.map(() => '?').join(', ');
  return db
    .prepare(`SELECT type, status FROM jobs WHERE id IN (${placeholders})`)
    .all(...jobIds) as JobStatusRow[];
}

function readAttemptRows(db: BetterSqlite3.Database, jobIds: string[]): AttemptStatusRow[] {
  const placeholders = jobIds.map(() => '?').join(', ');
  return db
    .prepare(`SELECT status FROM job_attempts WHERE job_id IN (${placeholders})`)
    .all(...jobIds) as AttemptStatusRow[];
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLeaseExtension(
  isObserved: () => boolean,
  observed: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  if (isObserved()) {
    return true;
  }

  await Promise.race([observed, sleep(timeoutMs)]);
  return isObserved();
}
