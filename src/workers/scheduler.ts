/**
 * Worker Scheduler
 *
 * 定期执行后台任务（如记忆提取）
 */

import { getLogger } from '../logger/index.js';

const logger = getLogger();

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
  private running = false;

  /**
   * 注册定期任务
   */
  register(job: WorkerJob): void {
    if (this.jobs.has(job.name)) {
      logger.warn({ jobName: job.name }, 'Job already registered, skipping');
      return;
    }

    logger.info({
      jobName: job.name,
      intervalMs: job.intervalMs,
    }, 'Registering worker job');

    // 立即执行一次（可选）
    // job.handler().catch(err => logger.error({ err, jobName: job.name }, 'Job failed on initial run'));

    // 设置定期执行
    const timer = setInterval(() => {
      if (!this.running) return;

      logger.debug({ jobName: job.name }, 'Running scheduled job');
      job.handler().catch((error) => {
        logger.error({
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          } : error,
          jobName: job.name,
        }, 'Job execution failed');
      });
    }, job.intervalMs);

    this.jobs.set(job.name, timer);
  }

  /**
   * 启动调度器
   */
  start(): void {
    logger.info('Starting worker scheduler');
    this.running = true;
  }

  /**
   * 停止调度器
   */
  stop(): void {
    logger.info('Stopping worker scheduler');
    this.running = false;

    // 清理所有定时器
    for (const [name, timer] of this.jobs.entries()) {
      clearInterval(timer);
      logger.debug({ jobName: name }, 'Cleared job timer');
    }

    this.jobs.clear();
  }

  /**
   * 获取已注册的任务数
   */
  get jobCount(): number {
    return this.jobs.size;
  }
}
