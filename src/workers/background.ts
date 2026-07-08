/**
 * Background Worker
 *
 * Local background task worker. It can run in legacy in-memory mode for simple
 * tests or use JobRepository for durable job/attempt/lease/idempotency state.
 */

import { redactSecretsInText } from '../memory/secret-scan.js';
import type { JobRepository, JobRecord } from '../storage/job-repository.js';

export type TaskType =
  | 'summary'
  | 'extraction'
  | 'consolidation'
  | 'decay'
  | 'conflict'
  | 'admin_digest'
  | 'retention';

export interface BackgroundTask {
  id: string;
  type: TaskType | string;
  payload: {
    conversationId?: string;
    conversationType?: 'private' | 'group';
    messageRange?: { start: string; end: string };
    targetUserId?: string;
    extractionHint?: string;
    [key: string]: unknown;
  };
  idempotencyKey?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
}

export interface EnqueueTaskInput {
  type: TaskType;
  payload: BackgroundTask['payload'];
  idempotencyKey?: string;
  scheduledAt?: number | Date;
  maxAttempts?: number;
}

export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: string;
}

export type BackgroundTaskHandler = (task: BackgroundTask) => Promise<unknown>;

export interface BackgroundWorkerOptions {
  jobRepository?: JobRepository;
  workerId?: string;
  leaseMs?: number;
  handlers?: Partial<Record<TaskType, BackgroundTaskHandler>>;
}

export class BackgroundWorker {
  private tasks = new Map<string, BackgroundTask>();
  private taskCounter = 0;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly handlers: Partial<Record<TaskType, BackgroundTaskHandler>>;
  private readonly jobRepository?: JobRepository;

  constructor(options: BackgroundWorkerOptions = {}) {
    this.jobRepository = options.jobRepository;
    this.workerId = options.workerId ?? 'background-worker-local';
    this.leaseMs = options.leaseMs ?? 60_000;
    this.handlers = options.handlers ?? {};
  }

  /**
   * 入队任务
   */
  enqueue(task: EnqueueTaskInput): string {
    if (this.jobRepository) {
      return this.jobRepository.enqueue({
        type: task.type,
        payload: task.payload,
        idempotencyKey: task.idempotencyKey,
        scheduledAt: task.scheduledAt,
        maxAttempts: task.maxAttempts,
      });
    }

    this.taskCounter++;
    const id = `task-${this.taskCounter.toString().padStart(6, '0')}`;

    this.tasks.set(id, {
      id,
      type: task.type,
      payload: task.payload,
      idempotencyKey: task.idempotencyKey,
      status: 'pending',
      createdAt: new Date(),
    });

    return id;
  }

  /**
   * 获取任务状态
   */
  getStatus(taskId: string): BackgroundTask['status'] | undefined {
    if (this.jobRepository) {
      const job = this.jobRepository.findById(taskId);
      return job ? this.jobStatusToTaskStatus(job.status) : undefined;
    }

    return this.tasks.get(taskId)?.status;
  }

  /**
   * 列出所有任务
   */
  list(): BackgroundTask[] {
    if (this.jobRepository) {
      return this.jobRepository.list().map((job) => this.redactTaskForList(this.jobToTask(job)));
    }

    return Array.from(this.tasks.values()).map((task) => this.redactTaskForList(task));
  }

  /**
   * 处理下一个待处理任务
   */
  async processNext(): Promise<TaskResult | null> {
    if (this.jobRepository) {
      return this.processNextDurable();
    }

    const pending = Array.from(this.tasks.values()).find((t) => t.status === 'pending');

    if (!pending) {
      return null;
    }

    pending.status = 'processing';

    try {
      const output = redactWorkerDiagnosticValue(await this.processTask(pending));

      pending.status = 'completed';
      pending.completedAt = new Date();

      return {
        taskId: pending.id,
        status: 'completed',
        output,
      };
    } catch (error) {
      const message = redactWorkerDiagnosticText(
        error instanceof Error ? error.message : 'Unknown error',
      );
      pending.status = 'failed';
      pending.completedAt = new Date();

      return {
        taskId: pending.id,
        status: 'failed',
        error: message,
      };
    }
  }

  private async processNextDurable(): Promise<TaskResult | null> {
    if (!this.jobRepository) {
      return null;
    }

    if (this.jobRepository.getWorkerHeartbeatStatus(this.workerId) !== 'error') {
      this.jobRepository.heartbeat({
        workerId: this.workerId,
        workerType: 'background',
        status: 'idle',
      });
    }

    const claimed = this.jobRepository.claimNext({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });

    if (!claimed) {
      return null;
    }

    if (!isKnownTaskType(claimed.job.type)) {
      const message = redactWorkerDiagnosticText(
        `Unsupported background job type: ${claimed.job.type}`,
      );
      this.jobRepository.fail({
        jobId: claimed.job.id,
        attemptId: claimed.attemptId,
        error: message,
        terminal: true,
      });
      this.jobRepository.heartbeat({
        workerId: this.workerId,
        workerType: 'background',
        status: 'error',
        currentJobId: claimed.job.id,
        details: { jobId: claimed.job.id, error: message, type: claimed.job.type },
      });

      return {
        taskId: claimed.job.id,
        status: 'failed',
        error: message,
      };
    }

    const task = this.jobToTask(claimed.job);
    task.status = 'processing';

    this.jobRepository.heartbeat({
      workerId: this.workerId,
      workerType: 'background',
      status: 'running',
      currentJobId: claimed.job.id,
      details: {
        attemptId: claimed.attemptId,
        attemptNumber: claimed.attemptNumber,
        type: claimed.job.type,
      },
    });

    const stopLeaseHeartbeat = this.startDurableLeaseHeartbeat(claimed);

    try {
      const output = redactWorkerDiagnosticValue(await this.processTask(task));
      this.jobRepository.complete({
        jobId: claimed.job.id,
        attemptId: claimed.attemptId,
        result: output,
      });
      this.jobRepository.heartbeat({
        workerId: this.workerId,
        workerType: 'background',
        status: 'idle',
      });

      return {
        taskId: claimed.job.id,
        status: 'completed',
        output,
      };
    } catch (error) {
      const message = redactWorkerDiagnosticText(
        error instanceof Error ? error.message : 'Unknown error',
      );
      this.jobRepository.fail({
        jobId: claimed.job.id,
        attemptId: claimed.attemptId,
        error: message,
      });
      this.jobRepository.heartbeat({
        workerId: this.workerId,
        workerType: 'background',
        status: 'error',
        currentJobId: claimed.job.id,
        details: { jobId: claimed.job.id, error: message },
      });

      return {
        taskId: claimed.job.id,
        status: 'failed',
        error: message,
      };
    } finally {
      stopLeaseHeartbeat();
    }
  }

  private startDurableLeaseHeartbeat(claimed: {
    job: JobRecord;
    attemptId: string;
    attemptNumber: number;
  }): () => void {
    if (!this.jobRepository) {
      return () => undefined;
    }

    const intervalMs = Math.max(1, Math.floor(this.leaseMs / 2));
    const timer = setInterval(() => {
      try {
        this.jobRepository?.extendLease({
          jobId: claimed.job.id,
          attemptId: claimed.attemptId,
          workerId: this.workerId,
          leaseMs: this.leaseMs,
        });
        this.jobRepository?.heartbeat({
          workerId: this.workerId,
          workerType: 'background',
          status: 'running',
          currentJobId: claimed.job.id,
          details: {
            attemptId: claimed.attemptId,
            attemptNumber: claimed.attemptNumber,
            type: claimed.job.type,
          },
        });
      } catch {
        clearInterval(timer);
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }

  /**
   * 处理任务。未注册专用 handler 时使用安全桩输出。
   */
  private async processTask(task: BackgroundTask): Promise<unknown> {
    const handler = isKnownTaskType(task.type) ? this.handlers[task.type] : undefined;
    if (handler) {
      return handler(task);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    if (task.type === 'summary') {
      return { summary: 'Stub summary' };
    }

    if (task.type === 'extraction') {
      return { extracted: 0 };
    }

    return { processed: true, type: task.type };
  }

  private jobToTask(job: JobRecord): BackgroundTask {
    return {
      id: job.id,
      type: job.type,
      payload: this.toTaskPayload(job.payload),
      idempotencyKey: job.idempotencyKey,
      status: this.jobStatusToTaskStatus(job.status),
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  private toTaskPayload(value: unknown): BackgroundTask['payload'] {
    if (typeof value === 'object' && value !== null) {
      return value as BackgroundTask['payload'];
    }

    return { originalPayload: value };
  }

  private jobStatusToTaskStatus(status: JobRecord['status']): BackgroundTask['status'] {
    if (status === 'running') {
      return 'processing';
    }

    return status;
  }

  private redactTaskForList(task: BackgroundTask): BackgroundTask {
    return {
      ...task,
      type: redactWorkerDiagnosticText(task.type),
      payload: this.toTaskPayload(redactWorkerDiagnosticValue(task.payload)),
      idempotencyKey: task.idempotencyKey
        ? redactWorkerDiagnosticText(task.idempotencyKey)
        : undefined,
    };
  }
}

function isKnownTaskType(value: string): value is TaskType {
  return (
    value === 'summary' ||
    value === 'extraction' ||
    value === 'consolidation' ||
    value === 'decay' ||
    value === 'conflict' ||
    value === 'admin_digest' ||
    value === 'retention'
  );
}

function redactWorkerDiagnosticText(text: string): string {
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

function redactWorkerDiagnosticValue(value: unknown, path: string[] = []): unknown {
  if (typeof value === 'string') {
    return redactWorkerDiagnosticText(value);
  }

  if (typeof value === 'number') {
    return shouldRedactNumericPlatformId(path, value) ? '[REDACTED:platform_id]' : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactWorkerDiagnosticValue(item, path));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactWorkerDiagnosticText(key),
        redactWorkerDiagnosticValue(item, [...path, key]),
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
