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
  load: {
    windows: number;
    enqueued: number;
    enqueuedByWindow: number[];
    completedByWindow: number[];
    lastEnqueueOffsetMs: number;
    emptyPolls: number;
  };
  drain: {
    processed: number;
    timedOut: boolean;
  };
  schedulerErrors: {
    producer: number;
    consumer: number;
    total: number;
  };
  isolation: {
    clean: boolean;
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

const SUSTAINED_LOAD_WINDOWS = 3;

export async function runWorkerSchedulerSoak(
  options: WorkerSchedulerSoakOptions,
): Promise<WorkerSchedulerSoakResult> {
  assertEmptyWorkerState(options.db);
  const durationMs = options.durationMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const workerId = options.workerId ?? 'ops-worker-soak';
  const leaseMs = Math.max(intervalMs * 4, 40);
  const runId = randomUUID();
  const setupAtMs = Date.now();
  let startedAtMs = 0;
  let loadDeadlineMs = 0;
  const jobRepository = new JobRepository(options.db);
  const scheduler = new WorkerScheduler({ logger: silentSchedulerLogger });
  const outcomes: TaskResult[] = [];
  const loadEnqueuedAtMs: number[] = [];
  const loadCompletedAtMs: number[] = [];
  let ticks = 0;
  let loadEmptyPolls = 0;
  let producerSequence = 0;
  let drainProcessed = 0;
  let drainTimedOut = false;
  let producerErrors = 0;
  let consumerErrors = 0;
  let extractionAttempts = 0;
  let leaseExtensionCount = 0;
  let leaseExtensionObserved: (() => void) | undefined;
  const leaseExtensionPromise = new Promise<void>((resolve) => {
    leaseExtensionObserved = resolve;
  });
  const originalExtendLease = jobRepository.extendLease.bind(jobRepository);

  jobRepository.extendLease = (extendOptions) => {
    const extended = originalExtendLease(extendOptions);
    if (extended) {
      leaseExtensionCount += 1;
      leaseExtensionObserved?.();
    }
    return extended;
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
      maxAttempts: 2,
    }),
    worker.enqueue({
      type: 'admin_digest',
      payload: { sinceMs: setupAtMs - intervalMs, untilMs: setupAtMs },
      idempotencyKey: `worker-soak:${runId}:admin-digest`,
      maxAttempts: 2,
    }),
    worker.enqueue({
      type: 'conflict',
      payload: { limit: 10 },
      idempotencyKey: `worker-soak:${runId}:conflict`,
      maxAttempts: 2,
    }),
    worker.enqueue({
      type: 'decay',
      payload: { limit: 10, dryRun: true },
      idempotencyKey: `worker-soak:${runId}:decay`,
      maxAttempts: 2,
    }),
    worker.enqueue({
      type: 'consolidation',
      payload: { limit: 10 },
      idempotencyKey: `worker-soak:${runId}:consolidation`,
      maxAttempts: 2,
    }),
  ];

  scheduler.register({
    name: `worker-soak-consumer-${runId}`,
    intervalMs,
    handler: async () => {
      const tickStartedAtMs = Date.now();
      if (tickStartedAtMs >= loadDeadlineMs) {
        return;
      }
      ticks += 1;
      try {
        const result = await worker.processNext();
        if (result) {
          outcomes.push(result);
          const completedAtMs = Date.now();
          if (result.status === 'completed' && completedAtMs < loadDeadlineMs) {
            loadCompletedAtMs.push(completedAtMs);
          }
        } else {
          loadEmptyPolls += 1;
        }
      } catch {
        consumerErrors += 1;
      }
    },
  });

  scheduler.register({
    name: `worker-soak-producer-${runId}`,
    intervalMs,
    handler: async () => {
      if (Date.now() >= loadDeadlineMs) {
        return;
      }
      producerSequence += 1;
      try {
        jobIds.push(worker.enqueue({
          type: 'retention',
          payload: { dryRun: true, sequence: producerSequence },
          idempotencyKey: `worker-soak:${runId}:load:${producerSequence}`,
          maxAttempts: 2,
        }));
        loadEnqueuedAtMs.push(Date.now());
      } catch {
        producerErrors += 1;
      }
    },
  });

  startedAtMs = Date.now();
  loadDeadlineMs = startedAtMs + durationMs;
  scheduler.start();
  try {
    await sleep(durationMs);
  } finally {
    await scheduler.stopAndDrain();
  }

  if (loadEnqueuedAtMs.length > 0) {
    const drainDeadlineMs = Date.now() + Math.min(
      Math.max(intervalMs * 10, 1_000),
      30_000,
    );
    const drainAttemptLimit = jobIds.length + 1;
    let drainAttempts = 0;
    while (!allJobsTerminal(readJobRows(options.db, runId), jobIds.length)) {
      if (Date.now() >= drainDeadlineMs || drainAttempts >= drainAttemptLimit) {
        drainTimedOut = true;
        break;
      }

      drainAttempts += 1;
      try {
        const result = await worker.processNext();
        if (result) {
          outcomes.push(result);
          drainProcessed += 1;
        } else {
          await sleep(Math.min(intervalMs, 25));
        }
      } catch {
        consumerErrors += 1;
      }
    }

    if (!drainTimedOut) {
      try {
        const finalIdleResult = await worker.processNext();
        if (finalIdleResult) {
          outcomes.push(finalIdleResult);
          drainProcessed += 1;
        }
      } catch {
        consumerErrors += 1;
      }
    }
  }

  const completedAtMs = Date.now();
  const jobs = readJobRows(options.db, runId);
  const attempts = readAttemptRows(options.db, runId);
  const workerStateCounts = readWorkerStateCounts(options.db);
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
  const enqueuedByWindow = countTimestampsByWindow(
    loadEnqueuedAtMs,
    startedAtMs,
    durationMs,
    SUSTAINED_LOAD_WINDOWS,
  );
  const completedByWindow = countTimestampsByWindow(
    loadCompletedAtMs,
    startedAtMs,
    durationMs,
    SUSTAINED_LOAD_WINDOWS,
  );
  const lastEnqueueOffsetMs = loadEnqueuedAtMs.length > 0
    ? Math.max(...loadEnqueuedAtMs) - startedAtMs
    : 0;
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
  const sustainedLoadObserved =
    enqueuedByWindow.every((count) => count >= 1) &&
    completedByWindow.every((count) => count >= 1) &&
    lastEnqueueOffsetMs >= Math.max(0, durationMs - intervalMs * 2) &&
    loadEmptyPolls === 0;
  const schedulerErrorCount = producerErrors + consumerErrors;
  const isolationClean =
    workerStateCounts.jobs === jobs.length &&
    workerStateCounts.attempts === attempts.length &&
    workerStateCounts.heartbeats === (heartbeatSummary ? 1 : 0);

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
    load: {
      windows: SUSTAINED_LOAD_WINDOWS,
      enqueued: loadEnqueuedAtMs.length,
      enqueuedByWindow,
      completedByWindow,
      lastEnqueueOffsetMs,
      emptyPolls: loadEmptyPolls,
    },
    drain: {
      processed: drainProcessed,
      timedOut: drainTimedOut,
    },
    schedulerErrors: {
      producer: producerErrors,
      consumer: consumerErrors,
      total: schedulerErrorCount,
    },
    isolation: {
      clean: isolationClean,
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
      plannedRetryObserved:
        failedAttempts === 1 && completedAttempts === jobs.length,
    },
    leaseExtensions: {
      observed: leaseExtensionCount > 0,
      count: leaseExtensionCount,
    },
    workerHeartbeat: heartbeatSummary,
    foreignKeyViolations,
    success:
      sustainedLoadObserved &&
      !drainTimedOut &&
      schedulerErrorCount === 0 &&
      isolationClean &&
      jobs.length === jobIds.length &&
      completedJobs === jobIds.length &&
      (jobsByStatus.pending ?? 0) === 0 &&
      (jobsByStatus.running ?? 0) === 0 &&
      (jobsByStatus.failed ?? 0) === 0 &&
      attempts.length === jobs.length + 1 &&
      outcomes.length === attempts.length &&
      (outcomesByStatus.completed ?? 0) === jobs.length &&
      (outcomesByStatus.failed ?? 0) === 1 &&
      runningAttempts === 0 &&
      failedAttempts === 1 &&
      completedAttempts === jobs.length &&
      leaseExtensionCount > 0 &&
      heartbeatSummary?.status === 'idle' &&
      heartbeatSummary.currentJobIdPresent === false &&
      foreignKeyViolations === 0,
  };
}

function assertEmptyWorkerState(db: BetterSqlite3.Database): void {
  const counts = readWorkerStateCounts(db);
  if (counts.jobs !== 0 || counts.attempts !== 0 || counts.heartbeats !== 0) {
    throw new Error('Worker soak requires empty durable worker tables');
  }
}

function readWorkerStateCounts(db: BetterSqlite3.Database): {
  jobs: number;
  attempts: number;
  heartbeats: number;
} {
  return db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM jobs) AS jobs,
       (SELECT COUNT(*) FROM job_attempts) AS attempts,
       (SELECT COUNT(*) FROM worker_heartbeats) AS heartbeats`,
  ).get() as { jobs: number; attempts: number; heartbeats: number };
}

function readJobRows(db: BetterSqlite3.Database, runId: string): JobStatusRow[] {
  return db
    .prepare('SELECT type, status FROM jobs WHERE idempotency_key LIKE ?')
    .all(`worker-soak:${runId}:%`) as JobStatusRow[];
}

function readAttemptRows(db: BetterSqlite3.Database, runId: string): AttemptStatusRow[] {
  return db
    .prepare(
      `SELECT attempt.status
       FROM job_attempts attempt
       JOIN jobs job ON job.id = attempt.job_id
       WHERE job.idempotency_key LIKE ?`,
    )
    .all(`worker-soak:${runId}:%`) as AttemptStatusRow[];
}

function allJobsTerminal(rows: JobStatusRow[], expectedCount: number): boolean {
  return rows.length === expectedCount && rows.every(
    (row) => row.status === 'completed' || row.status === 'failed',
  );
}

function countTimestampsByWindow(
  timestamps: number[],
  startedAtMs: number,
  durationMs: number,
  windows: number,
): number[] {
  const counts = Array.from({ length: windows }, () => 0);
  for (const timestamp of timestamps) {
    const offsetMs = timestamp - startedAtMs;
    if (offsetMs < 0 || offsetMs >= durationMs) {
      continue;
    }
    const index = Math.min(windows - 1, Math.floor(offsetMs * windows / durationMs));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
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
