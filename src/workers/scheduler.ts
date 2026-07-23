/**
 * Worker Scheduler
 *
 * 定期执行后台任务（如记忆提取）
 */

import { getLogger } from '../logger/index.js';

export interface SchedulerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface WorkerSchedulerOptions {
  logger?: SchedulerLogger;
}

export interface WorkerJob {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
}

/**
 * 简单的 Worker 调度器
 */
export class WorkerScheduler {
  private jobs: Map<string, NodeJS.Timeout> = new Map();
  private readonly activeHandlers = new Map<string, Promise<void>>();
  private running = false;
  private readonly logger: SchedulerLogger;

  constructor(options: WorkerSchedulerOptions = {}) {
    this.logger = options.logger ?? getLogger();
  }

  /**
   * 注册定期任务
   */
  register(job: WorkerJob): void {
    if (this.jobs.has(job.name)) {
      this.logger.warn({ jobName: job.name }, 'Job already registered, skipping');
      return;
    }

    this.logger.info({
      jobName: job.name,
      intervalMs: job.intervalMs,
    }, 'Registering worker job');

    // 立即执行一次（可选）
    // job.handler().catch(err => logger.error({ err, jobName: job.name }, 'Job failed on initial run'));

    // 设置定期执行
    const timer = setInterval(() => {
      if (!this.running) return;
      if (this.activeHandlers.has(job.name)) {
        this.logger.debug({ jobName: job.name }, 'Scheduled job is still running, skipping tick');
        return;
      }

      this.logger.debug({ jobName: job.name }, 'Running scheduled job');
      let handlerResult: Promise<void>;
      try {
        handlerResult = job.handler();
      } catch (error) {
        handlerResult = Promise.reject(error);
      }
      const activeHandler = handlerResult.catch((error) => {
        this.logger.error({
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          } : error,
          jobName: job.name,
        }, 'Job execution failed');
      });
      this.activeHandlers.set(job.name, activeHandler);
      void activeHandler.then(() => {
        if (this.activeHandlers.get(job.name) === activeHandler) {
          this.activeHandlers.delete(job.name);
        }
      });
    }, job.intervalMs);

    this.jobs.set(job.name, timer);
  }

  /**
   * 启动调度器
   */
  start(): void {
    this.logger.info('Starting worker scheduler');
    this.running = true;
  }

  /**
   * 停止调度器
   */
  stop(): void {
    this.logger.info('Stopping worker scheduler');
    this.running = false;

    // 清理所有定时器
    for (const [name, timer] of this.jobs.entries()) {
      clearInterval(timer);
      this.logger.debug({ jobName: name }, 'Cleared job timer');
    }

    this.jobs.clear();
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.activeHandlers.values()]);
  }

  /**
   * 获取已注册的任务数
   */
  get jobCount(): number {
    return this.jobs.size;
  }
}
