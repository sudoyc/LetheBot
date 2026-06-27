/**
 * Unit Test: Worker Scheduler
 *
 * 验证 Worker 调度器功能
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerScheduler } from '../../../src/workers/scheduler.js';

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
});
