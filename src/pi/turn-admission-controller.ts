export const PI_MAX_CONCURRENT_TURNS_MIN = 1;
export const PI_MAX_CONCURRENT_TURNS_MAX = 16;
export const PI_MAX_QUEUED_TURNS_MIN = 0;
export const PI_MAX_QUEUED_TURNS_MAX = 128;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type TurnAdmissionRejectionCode = 'overloaded' | 'queue_timeout';

export class TurnAdmissionRejectedError extends Error {
  constructor(
    public readonly code: TurnAdmissionRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = code === 'overloaded'
      ? 'TurnAdmissionOverloadedError'
      : 'TurnAdmissionQueueTimeoutError';
  }
}

export function isTurnAdmissionRejectedError(
  error: unknown,
): error is TurnAdmissionRejectedError {
  return error instanceof TurnAdmissionRejectedError;
}

export class TurnDeadlineExceededError extends Error {
  readonly code = 'deadline_exceeded' as const;

  constructor(stage: string) {
    super(`Turn deadline exceeded before ${stage}`);
    this.name = 'TurnDeadlineExceededError';
  }
}

export interface TurnAdmissionOptions {
  /** Absolute epoch deadline established when the work was admitted. */
  deadlineAtMs?: number;
}

interface QueuedWork {
  run: () => Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  deadlineAtMs?: number;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface TurnAdmissionControllerOptions {
  now?: () => number;
}

/**
 * Schedules admitted conversational workflows with one active item per key
 * and a bounded number of active keys. Keys are served round-robin so a busy
 * conversation cannot monopolize a single global slot.
 */
export class TurnAdmissionController {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly now: () => number;
  private readonly queues = new Map<string, QueuedWork[]>();
  private readonly keyOrder: string[] = [];
  private readonly activeKeys = new Set<string>();
  private readonly idleWaiters: Array<() => void> = [];
  private cursor = 0;
  private active = 0;
  private queued = 0;

  constructor(
    maxConcurrent: number,
    maxQueued: number = PI_MAX_QUEUED_TURNS_MAX,
    options: TurnAdmissionControllerOptions = {},
  ) {
    if (
      !Number.isInteger(maxConcurrent)
      || maxConcurrent < PI_MAX_CONCURRENT_TURNS_MIN
      || maxConcurrent > PI_MAX_CONCURRENT_TURNS_MAX
    ) {
      throw new RangeError(
        `maxConcurrent must be an integer in ${PI_MAX_CONCURRENT_TURNS_MIN}..${PI_MAX_CONCURRENT_TURNS_MAX}`,
      );
    }
    if (
      !Number.isInteger(maxQueued)
      || maxQueued < PI_MAX_QUEUED_TURNS_MIN
      || maxQueued > PI_MAX_QUEUED_TURNS_MAX
    ) {
      throw new RangeError(
        `maxQueued must be an integer in ${PI_MAX_QUEUED_TURNS_MIN}..${PI_MAX_QUEUED_TURNS_MAX}`,
      );
    }
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.now = options.now ?? Date.now;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queued;
  }

  get maxConcurrentCount(): number {
    return this.maxConcurrent;
  }

  get maxQueuedCount(): number {
    return this.maxQueued;
  }

  schedule<T>(
    conversationKey: string,
    work: () => Promise<T> | T,
    options: TurnAdmissionOptions = {},
  ): Promise<T> {
    const key = conversationKey.trim();
    if (!key) {
      return Promise.reject(new Error('conversationKey is required for turn admission'));
    }

    const deadlineAtMs = options.deadlineAtMs;
    if (
      deadlineAtMs !== undefined
      && (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 0)
    ) {
      return Promise.reject(new RangeError('deadlineAtMs must be a non-negative integer'));
    }

    const now = this.now();
    if (deadlineAtMs !== undefined && deadlineAtMs <= now) {
      return Promise.reject(this.createQueueTimeoutError(deadlineAtMs));
    }

    // The queue cap applies only when this item cannot start immediately. A
    // zero-cap configuration still permits work that has a free active slot.
    const canStartImmediately = this.active < this.maxConcurrent && !this.activeKeys.has(key);
    if (!canStartImmediately && this.queued >= this.maxQueued) {
      return Promise.reject(new TurnAdmissionRejectedError(
        'overloaded',
        `Turn admission queue is full (limit ${this.maxQueued})`,
      ));
    }

    return new Promise<T>((resolve, reject) => {
      let queue = this.queues.get(key);
      if (!queue) {
        queue = [];
        this.queues.set(key, queue);
        this.keyOrder.push(key);
      }

      const queuedWork: QueuedWork = {
        run: async () => work(),
        resolve: (value: unknown) => resolve(value as T),
        reject: (reason: unknown) => reject(reason),
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      };
      queue.push(queuedWork);
      this.queued += 1;
      this.armQueueTimeout(key, queuedWork);
      this.pump();
    });
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0 && this.queued === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private armQueueTimeout(key: string, work: QueuedWork): void {
    if (work.deadlineAtMs === undefined) {
      return;
    }

    const delay = work.deadlineAtMs - this.now();
    work.timeout = setTimeout(() => {
      // Long deadlines may exceed the host timer maximum. Re-arm until the
      // absolute deadline is reached rather than silently losing the timeout.
      if (work.deadlineAtMs !== undefined && work.deadlineAtMs - this.now() > 0) {
        this.armQueueTimeout(key, work);
        return;
      }
      this.expireQueuedWork(key, work);
    }, Math.min(Math.max(delay, 0), MAX_TIMER_DELAY_MS));
  }

  private expireQueuedWork(key: string, work: QueuedWork): void {
    const queue = this.queues.get(key);
    if (!queue) {
      return;
    }
    const index = queue.indexOf(work);
    if (index < 0) {
      return;
    }

    queue.splice(index, 1);
    this.queued -= 1;
    this.clearQueueTimeout(work);
    work.reject(this.createQueueTimeoutError(work.deadlineAtMs));
    if (queue.length === 0 && !this.activeKeys.has(key)) {
      this.removeKey(key);
    }
    this.pump();
    this.notifyIdleIfSettled();
  }

  private createQueueTimeoutError(deadlineAtMs: number | undefined): TurnAdmissionRejectedError {
    const suffix = deadlineAtMs === undefined ? '' : ` at ${deadlineAtMs}`;
    return new TurnAdmissionRejectedError(
      'queue_timeout',
      `Turn admission deadline expired before execution${suffix}`,
    );
  }

  private pump(): void {
    while (this.active < this.maxConcurrent) {
      const key = this.nextRunnableKey();
      if (!key) {
        return;
      }

      const queue = this.queues.get(key);
      const work = queue?.shift();
      if (!work) {
        continue;
      }

      this.queued -= 1;
      this.clearQueueTimeout(work);

      if (work.deadlineAtMs !== undefined && work.deadlineAtMs <= this.now()) {
        work.reject(this.createQueueTimeoutError(work.deadlineAtMs));
        if ((this.queues.get(key)?.length ?? 0) === 0 && !this.activeKeys.has(key)) {
          this.removeKey(key);
        }
        continue;
      }

      this.active += 1;
      this.activeKeys.add(key);

      void Promise.resolve()
        .then(work.run)
        .then(
          (value) => work.resolve(value),
          (error: unknown) => work.reject(error),
        )
        .finally(() => {
          this.active -= 1;
          this.activeKeys.delete(key);
          if ((this.queues.get(key)?.length ?? 0) === 0) {
            this.removeKey(key);
          }
          this.pump();
          this.notifyIdleIfSettled();
        });
    }
  }

  private nextRunnableKey(): string | undefined {
    const keyCount = this.keyOrder.length;
    if (keyCount === 0) {
      return undefined;
    }

    for (let attempts = 0; attempts < keyCount; attempts += 1) {
      if (this.cursor >= this.keyOrder.length) {
        this.cursor = 0;
      }
      const key = this.keyOrder[this.cursor];
      this.cursor = (this.cursor + 1) % this.keyOrder.length;
      if (key && !this.activeKeys.has(key) && (this.queues.get(key)?.length ?? 0) > 0) {
        return key;
      }
    }

    return undefined;
  }

  private clearQueueTimeout(work: QueuedWork): void {
    if (work.timeout !== undefined) {
      clearTimeout(work.timeout);
      work.timeout = undefined;
    }
  }

  private removeKey(key: string): void {
    const index = this.keyOrder.indexOf(key);
    if (index < 0) {
      return;
    }

    this.keyOrder.splice(index, 1);
    this.queues.delete(key);
    if (index < this.cursor) {
      this.cursor -= 1;
    }
    if (this.cursor >= this.keyOrder.length) {
      this.cursor = 0;
    }
  }

  private notifyIdleIfSettled(): void {
    if (this.active !== 0 || this.queued !== 0) {
      return;
    }

    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }
}
