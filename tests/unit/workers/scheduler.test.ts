/**
 * Unit Test: Worker Scheduler
 *
 * 验证 Worker 调度器功能
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerScheduler } from '../../../src/workers/scheduler.js';
import { BackgroundWorker } from '../../../src/workers/background.js';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database.js';
import { JobRepository } from '../../../src/storage/job-repository.js';

describe('WorkerScheduler', () => {
  let scheduler: WorkerScheduler;

  beforeEach(() => {
    scheduler = new WorkerScheduler();
    vi.useFakeTimers();
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
  });

  it('should register a job', () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.register({
      name: 'test-job',
      intervalMs: 1000,
      handler,
    });

    expect(scheduler.jobCount).toBe(1);
  });

  it('should not register duplicate jobs', () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.register({
      name: 'test-job',
      intervalMs: 1000,
      handler,
    });

    scheduler.register({
      name: 'test-job',
      intervalMs: 2000,
      handler,
    });

    expect(scheduler.jobCount).toBe(1);
  });

  it('should execute job at intervals when started', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.register({
      name: 'test-job',
      intervalMs: 1000,
      handler,
    });

    scheduler.start();

    // 初始不执行
    expect(handler).not.toHaveBeenCalled();

    // 1 秒后执行
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    // 再 1 秒后再次执行
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should skip ticks while the same job is still running', async () => {
    let releaseHandler: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handler = vi.fn(() => pending);

    scheduler.register({
      name: 'single-flight-job',
      intervalMs: 1000,
      handler,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(handler).toHaveBeenCalledTimes(1);

    releaseHandler?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should not execute job when not started', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.register({
      name: 'test-job',
      intervalMs: 1000,
      handler,
    });

    // 不启动
    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('should stop executing jobs after stop', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.register({
      name: 'test-job',
      intervalMs: 1000,
      handler,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    scheduler.stop();

    // 停止后不再执行
    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should clear all timers on stop', () => {
    const handler1 = vi.fn().mockResolvedValue(undefined);
    const handler2 = vi.fn().mockResolvedValue(undefined);

    scheduler.register({
      name: 'job-1',
      intervalMs: 1000,
      handler: handler1,
    });

    scheduler.register({
      name: 'job-2',
      intervalMs: 2000,
      handler: handler2,
    });

    expect(scheduler.jobCount).toBe(2);

    scheduler.stop();

    expect(scheduler.jobCount).toBe(0);
  });

  it('should stop new ticks and drain every active handler', async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const firstHandler = vi.fn(() => new Promise<void>((resolve) => {
      resolveFirst = resolve;
    }));
    const secondHandler = vi.fn(() => new Promise<void>((resolve) => {
      resolveSecond = resolve;
    }));

    scheduler.register({
      name: 'first-job',
      intervalMs: 1000,
      handler: firstHandler,
    });
    scheduler.register({
      name: 'second-job',
      intervalMs: 1000,
      handler: secondHandler,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);

    let drained = false;
    const drainPromise = scheduler.stopAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveSecond?.();
    await drainPromise;
    expect(drained).toBe(true);
  });

  it('should handle job errors gracefully', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('Job failed'));

    scheduler.register({
      name: 'failing-job',
      intervalMs: 1000,
      handler,
    });

    scheduler.start();

    // 应该捕获错误但不崩溃
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    // 下次仍然执行
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should support multiple jobs with different intervals', async () => {
    const handler1 = vi.fn().mockResolvedValue(undefined);
    const handler2 = vi.fn().mockResolvedValue(undefined);

    scheduler.register({
      name: 'job-1',
      intervalMs: 1000,
      handler: handler1,
    });

    scheduler.register({
      name: 'job-2',
      intervalMs: 2000,
      handler: handler2,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler1).toHaveBeenCalledTimes(2);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should drive a durable background worker across repeated scheduler ticks with retry evidence', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-scheduler-soak-'));
    const db = initDatabase({ path: join(testDir, 'test.db') });

    try {
      runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
      const now = new Date('2026-07-03T00:00:00.000Z');
      vi.setSystemTime(now);

      const jobRepository = new JobRepository(db);
      let extractionCalls = 0;
      const durableWorker = new BackgroundWorker({
        jobRepository,
        workerId: 'scheduler-soak-worker',
        leaseMs: 2_000,
        handlers: {
          summary: async (task) => ({ summaryId: `summary:${task.payload.conversationId}` }),
          extraction: async () => {
            extractionCalls += 1;
            if (extractionCalls === 1) {
              throw new Error('scheduled extraction transient failure');
            }

            return { extracted: 1 };
          },
          retention: async (task) => ({ retained: true, rawDays: task.payload.rawDays }),
        },
      });

      const summaryJobId = durableWorker.enqueue({
        type: 'summary',
        payload: { conversationId: 'conv-scheduler-soak' },
        idempotencyKey: 'summary:conv-scheduler-soak:window-1',
        scheduledAt: now.getTime(),
      });
      const extractionJobId = durableWorker.enqueue({
        type: 'extraction',
        payload: { conversationId: 'conv-scheduler-soak', targetUserId: 'user-scheduler-soak' },
        maxAttempts: 2,
        scheduledAt: now.getTime() + 1,
      });
      const retentionJobId = durableWorker.enqueue({
        type: 'retention',
        payload: { rawDays: 30 },
        scheduledAt: now.getTime() + 3_000,
      });
      const results: unknown[] = [];

      scheduler.register({
        name: 'durable-worker-soak',
        intervalMs: 1_000,
        handler: async () => {
          results.push(await durableWorker.processNext());
        },
      });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      scheduler.stop();
      const resultCountAtStop = results.length;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(results).toEqual([
        {
          taskId: summaryJobId,
          status: 'completed',
          output: { summaryId: 'summary:conv-scheduler-soak' },
        },
        {
          taskId: extractionJobId,
          status: 'failed',
          error: 'scheduled extraction transient failure',
        },
        {
          taskId: extractionJobId,
          status: 'completed',
          output: { extracted: 1 },
        },
        {
          taskId: retentionJobId,
          status: 'completed',
          output: { retained: true, rawDays: 30 },
        },
      ]);
      expect(results).toHaveLength(resultCountAtStop);
      expect(durableWorker.getStatus(summaryJobId)).toBe('completed');
      expect(durableWorker.getStatus(extractionJobId)).toBe('completed');
      expect(durableWorker.getStatus(retentionJobId)).toBe('completed');

      const jobs = db
        .prepare('SELECT id, type, status, attempts, result FROM jobs WHERE id IN (?, ?, ?) ORDER BY type ASC')
        .all(summaryJobId, extractionJobId, retentionJobId) as Array<{
          id: string;
          type: string;
          status: string;
          attempts: number;
          result: string;
        }>;
      const extractionAttempts = db
        .prepare('SELECT status, error, result FROM job_attempts WHERE job_id = ? ORDER BY attempt_number ASC')
        .all(extractionJobId) as Array<{ status: string; error: string | null; result: string | null }>;
      const runningAttempts = db
        .prepare('SELECT COUNT(*) as count FROM job_attempts WHERE status = ?')
        .get('running') as { count: number };
      const heartbeat = db
        .prepare('SELECT status, current_job_id FROM worker_heartbeats WHERE worker_id = ?')
        .get('scheduler-soak-worker') as { status: string; current_job_id: string | null };

      expect(jobs).toEqual([
        {
          id: extractionJobId,
          type: 'extraction',
          status: 'completed',
          attempts: 2,
          result: JSON.stringify({ extracted: 1 }),
        },
        {
          id: retentionJobId,
          type: 'retention',
          status: 'completed',
          attempts: 1,
          result: JSON.stringify({ retained: true, rawDays: 30 }),
        },
        {
          id: summaryJobId,
          type: 'summary',
          status: 'completed',
          attempts: 1,
          result: JSON.stringify({ summaryId: 'summary:conv-scheduler-soak' }),
        },
      ]);
      expect(extractionAttempts).toEqual([
        {
          status: 'failed',
          error: 'scheduled extraction transient failure',
          result: null,
        },
        {
          status: 'completed',
          error: null,
          result: JSON.stringify({ extracted: 1 }),
        },
      ]);
      expect(runningAttempts.count).toBe(0);
      expect(heartbeat).toEqual({
        status: 'idle',
        current_job_id: null,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
