import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackgroundWorker,
  NonRetryableBackgroundTaskError,
  type BackgroundTaskExecutionContext,
} from '../../../src/workers/background';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { JobRepository } from '../../../src/storage/job-repository';

describe('BackgroundWorker', () => {
  const worker = new BackgroundWorker();

  describe('enqueue', () => {
    it('should enqueue summary task', () => {
      const taskId = worker.enqueue({
        type: 'summary',
        payload: {
          conversationId: 'conv-001',
          messageRange: { start: 'msg-001', end: 'msg-010' },
        },
      });

      expect(taskId).toBeDefined();
      expect(taskId).toMatch(/^task-/);
    });

    it('should enqueue extraction task', () => {
      const taskId = worker.enqueue({
        type: 'extraction',
        payload: {
          conversationId: 'conv-002',
          targetUserId: 'user-alice',
          extractionHint: 'user preferences',
        },
      });

      expect(taskId).toBeDefined();
    });
  });

  describe('getStatus', () => {
    it('should return pending status for new task', () => {
      const taskId = worker.enqueue({
        type: 'summary',
        payload: { conversationId: 'conv-003', messageRange: { start: 'msg-001', end: 'msg-002' } },
      });

      const status = worker.getStatus(taskId);
      expect(status).toBe('pending');
    });

    it('should return undefined for unknown task', () => {
      const status = worker.getStatus('nonexistent-task');
      expect(status).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should list all tasks', () => {
      const worker2 = new BackgroundWorker();

      worker2.enqueue({
        type: 'summary',
        payload: { conversationId: 'conv-004', messageRange: { start: 'msg-001', end: 'msg-005' } },
      });

      worker2.enqueue({
        type: 'extraction',
        payload: { conversationId: 'conv-005', targetUserId: 'user-bob', extractionHint: 'facts' },
      });

      const tasks = worker2.list();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].type).toBe('summary');
      expect(tasks[1].type).toBe('extraction');
    });

    it('should redact diagnostic payloads and idempotency keys when listing in-memory tasks', () => {
      const rawSecret = 'sk-background-worker-list-secret-should-not-return';
      const rawPlatformId = 'qq-1234567890';
      const worker2 = new BackgroundWorker();

      worker2.enqueue({
        type: 'summary',
        payload: {
          conversationId: `private:${rawPlatformId}`,
          targetUserId: 1234567890,
          nested: {
            [`api_key=${rawSecret}`]: `target=${rawPlatformId}`,
          },
        },
        idempotencyKey: `summary:${rawPlatformId}:api_key=${rawSecret}`,
      });

      const [task] = worker2.list();
      const serialized = JSON.stringify(task);

      expect(task?.idempotencyKey).toContain('[REDACTED:platform_id]');
      expect(task?.idempotencyKey).toContain('[REDACTED:api_key_assignment]');
      expect(task?.payload.targetUserId).toBe('[REDACTED:platform_id]');
      expect(serialized).toContain('[REDACTED:platform_id]');
      expect(serialized).toContain('[REDACTED:api_key_assignment]');
      expect(serialized).not.toContain(rawSecret);
      expect(serialized).not.toContain(rawPlatformId);
      expect(serialized).not.toContain('1234567890');
    });
  });

  describe('processNext', () => {
    it('should process summary task', async () => {
      const worker3 = new BackgroundWorker();

      const taskId = worker3.enqueue({
        type: 'summary',
        payload: { conversationId: 'conv-006', messageRange: { start: 'msg-001', end: 'msg-003' } },
      });

      const result = await worker3.processNext();

      expect(result).toBeDefined();
      expect(result?.taskId).toBe(taskId);
      expect(result?.status).toBe('completed');
      expect(worker3.getStatus(taskId)).toBe('completed');
    });

    it('should return null when queue is empty', async () => {
      const worker4 = new BackgroundWorker();
      const result = await worker4.processNext();
      expect(result).toBeNull();
    });

    it('should pass undefined execution context to in-memory handlers without leaking metadata', async () => {
      const observedContexts: Array<BackgroundTaskExecutionContext | undefined> = [];
      const payload = { conversationId: 'conv-in-memory-execution-context', marker: 'unchanged' };
      const worker5 = new BackgroundWorker({
        handlers: {
          summary: async (task, executionContext) => {
            observedContexts.push(executionContext);
            expect(task.payload).toEqual(payload);
            return { handled: true };
          },
        },
      });

      const taskId = worker5.enqueue({ type: 'summary', payload });
      const result = await worker5.processNext();
      const [listedTask] = worker5.list();

      expect(observedContexts).toEqual([undefined]);
      expect(payload).toEqual({
        conversationId: 'conv-in-memory-execution-context',
        marker: 'unchanged',
      });
      expect(listedTask?.payload).toEqual(payload);
      expect(result).toEqual({
        taskId,
        status: 'completed',
        output: { handled: true },
      });
      expect(JSON.stringify({ payload, listedTask, result })).not.toMatch(
        /"(?:jobId|jobAttemptId|attemptNumber)":/,
      );
    });

    it('should redact legacy in-memory task errors before returning', async () => {
      const rawSecret = 'sk-background-worker-legacy-error-secret-should-not-return';
      const rawPlatformId = 'qq-1234567890';
      const worker5 = new BackgroundWorker({
        handlers: {
          conflict: async () => {
            throw new Error(`legacy worker failure api_key=${rawSecret} target=${rawPlatformId}`);
          },
        },
      });

      const taskId = worker5.enqueue({
        type: 'conflict',
        payload: { conversationId: 'conv-legacy-error' },
      });

      const result = await worker5.processNext();

      expect(result).toMatchObject({
        taskId,
        status: 'failed',
      });
      expect(result?.error).toContain('legacy worker failure');
      expect(result?.error).toContain('[REDACTED:api_key_assignment]');
      expect(result?.error).toContain('[REDACTED:platform_id]');
      expect(result?.error).not.toContain(rawSecret);
      expect(result?.error).not.toContain(rawPlatformId);
      expect(worker5.getStatus(taskId)).toBe('failed');
    });
  });

  describe('durable job repository integration', () => {
    it('recognizes a scheduled attention recheck and does not claim it before its due time', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-attention-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const handled: string[] = [];
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-attention',
          handlers: {
            attention_recheck: async (task) => {
              handled.push(String(task.payload.candidateId));
              return { candidateId: task.payload.candidateId, outcome: 'suppress' };
            },
          },
        });
        const dueAt = Date.now() + 15_000;
        const taskId = durableWorker.enqueue({
          type: 'attention_recheck',
          payload: { candidateId: 'candidate-synthetic-attention' },
          scheduledAt: dueAt,
        });

        expect(await durableWorker.processNext(dueAt - 1, ['attention_recheck'])).toBeNull();
        expect(handled).toEqual([]);
        expect(durableWorker.getStatus(taskId)).toBe('pending');

        const result = await durableWorker.processNext(dueAt, ['attention_recheck']);

        expect(result).toEqual({
          taskId,
          status: 'completed',
          output: {
            candidateId: 'candidate-synthetic-attention',
            outcome: 'suppress',
          },
        });
        expect(handled).toEqual(['candidate-synthetic-attention']);
        expect(durableWorker.getStatus(taskId)).toBe('completed');
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('terminally rejects an attention recheck when its required handler is absent', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-attention-handler-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-attention-handler',
        });
        const now = Date.now();
        const taskId = durableWorker.enqueue({
          type: 'attention_recheck',
          payload: { candidateId: 'candidate-missing-handler' },
          scheduledAt: now,
          maxAttempts: 3,
        });

        const result = await durableWorker.processNext(now, ['attention_recheck']);

        expect(result).toMatchObject({
          taskId,
          status: 'failed',
          error: expect.stringContaining('requires a registered handler'),
        });
        expect(jobRepository.findById(taskId)).toMatchObject({
          status: 'failed',
          attempts: 1,
          maxAttempts: 3,
        });
        expect(db.prepare(
          'SELECT status FROM job_attempts WHERE job_id = ?',
        ).get(taskId)).toEqual({ status: 'failed' });
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('terminally fails an explicitly non-retryable durable task', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-non-retryable-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-non-retryable',
          handlers: {
            summary: async () => {
              throw new NonRetryableBackgroundTaskError('deterministic task rejection');
            },
          },
        });
        const taskId = durableWorker.enqueue({
          type: 'summary',
          payload: { conversationId: 'conv-non-retryable' },
          maxAttempts: 3,
        });

        const failed = await durableWorker.processNext();
        const laterPoll = await durableWorker.processNext();

        expect(failed).toEqual({
          taskId,
          status: 'failed',
          error: 'deterministic task rejection',
        });
        expect(laterPoll).toBeNull();
        expect(jobRepository.findById(taskId)).toMatchObject({
          status: 'failed',
          attempts: 1,
          maxAttempts: 3,
          error: 'deterministic task rejection',
        });
        expect(db.prepare(
          'SELECT attempt_number, status, error FROM job_attempts WHERE job_id = ?',
        ).all(taskId)).toEqual([{
          attempt_number: 1,
          status: 'failed',
          error: 'deterministic task rejection',
        }]);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should pass exact claimed execution metadata without persisting it in task data', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-execution-context-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const observedContexts: Array<BackgroundTaskExecutionContext | undefined> = [];
        const payload = { conversationId: 'conv-durable-execution-context', marker: 'unchanged' };
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-execution-context',
          handlers: {
            summary: async (task, executionContext) => {
              observedContexts.push(executionContext);
              expect(task.payload).toEqual(payload);

              if (observedContexts.length === 1) {
                throw new Error('retry once');
              }

              return { handled: true };
            },
          },
        });

        const taskId = durableWorker.enqueue({ type: 'summary', payload });
        const firstAttemptAt = Date.now() + 1_000;
        const secondAttemptAt = firstAttemptAt + 1;
        const firstResult = await durableWorker.processNext(firstAttemptAt);
        const result = await durableWorker.processNext(secondAttemptAt);
        const attempts = db
          .prepare(
            'SELECT id, attempt_number, started_at FROM job_attempts WHERE job_id = ? ORDER BY attempt_number',
          )
          .all(taskId) as Array<{ id: string; attempt_number: number; started_at: number }>;
        const job = db.prepare('SELECT payload, result FROM jobs WHERE id = ?').get(taskId) as {
          payload: string;
          result: string;
        };
        const [listedTask] = durableWorker.list();

        expect(observedContexts).toEqual(
          attempts.map((attempt) => ({
            jobId: taskId,
            jobAttemptId: attempt.id,
            attemptNumber: attempt.attempt_number,
            now: attempt.started_at,
          })),
        );
        expect(attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2]);
        expect(observedContexts[0]?.jobAttemptId).not.toBe(observedContexts[1]?.jobAttemptId);
        expect(payload).toEqual({
          conversationId: 'conv-durable-execution-context',
          marker: 'unchanged',
        });
        expect(JSON.parse(job.payload)).toEqual(payload);
        expect(listedTask?.payload).toEqual(payload);
        expect(JSON.parse(job.result)).toEqual({ handled: true });
        expect(firstResult).toEqual({
          taskId,
          status: 'failed',
          error: 'retry once',
        });
        expect(result).toEqual({
          taskId,
          status: 'completed',
          output: { handled: true },
        });
        expect(
          JSON.stringify({
            payload,
            listedTask,
            persistedPayload: JSON.parse(job.payload),
            persistedResult: JSON.parse(job.result),
            firstResult,
            result,
          }),
        ).not.toMatch(/"(?:jobId|jobAttemptId|attemptNumber)":/);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should read fresh execution time from an injected clock on every access', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-fresh-execution-time-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const claimedAt = Date.now();
        const firstReadAt = claimedAt + 10_000;
        const secondReadAt = claimedAt + 20_000;
        const completedAt = claimedAt + 30_000;
        const times = [claimedAt, firstReadAt, secondReadAt, completedAt];
        const clock = vi.fn(() => times.shift() ?? completedAt);
        const observedTimes: number[] = [];
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-fresh-execution-time',
          clock,
          handlers: {
            attention_recheck: async (_task, executionContext) => {
              if (!executionContext) {
                throw new Error('Expected durable execution context');
              }
              observedTimes.push(executionContext.now);
              await new Promise<void>((resolve) => setImmediate(resolve));
              observedTimes.push(executionContext.now);
              return { handled: true };
            },
          },
        });
        const taskId = durableWorker.enqueue({
          type: 'attention_recheck',
          payload: { candidateId: 'candidate-fresh-execution-time' },
          scheduledAt: claimedAt,
        });

        const result = await durableWorker.processNext(undefined, ['attention_recheck']);
        const attempt = db.prepare(
          'SELECT started_at, completed_at FROM job_attempts WHERE job_id = ?',
        ).get(taskId) as { started_at: number; completed_at: number };

        expect(observedTimes).toEqual([firstReadAt, secondReadAt]);
        expect(attempt.started_at).toBe(claimedAt);
        expect(attempt.completed_at).toBe(completedAt);
        expect(clock).toHaveBeenCalledTimes(4);
        expect(result).toEqual({
          taskId,
          status: 'completed',
          output: { handled: true },
        });
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should keep execution time and durable timestamps fixed when process time is explicit', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-fixed-execution-time-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const fixedNow = Date.now() + 1_000;
        const clock = vi.fn(() => fixedNow + 30_000);
        const observedTimes: number[] = [];
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-fixed-execution-time',
          clock,
          handlers: {
            attention_recheck: async (_task, executionContext) => {
              if (!executionContext) {
                throw new Error('Expected durable execution context');
              }
              observedTimes.push(executionContext.now);
              await new Promise<void>((resolve) => setImmediate(resolve));
              observedTimes.push(executionContext.now);
              return { handled: true };
            },
          },
        });
        const taskId = durableWorker.enqueue({
          type: 'attention_recheck',
          payload: { candidateId: 'candidate-fixed-execution-time' },
          scheduledAt: fixedNow,
        });

        const result = await durableWorker.processNext(fixedNow, ['attention_recheck']);
        const job = db.prepare(
          `SELECT scheduled_at, started_at, completed_at, updated_at, heartbeat_at
             FROM jobs WHERE id = ?`,
        ).get(taskId) as Record<string, number>;
        const attempt = db.prepare(
          `SELECT started_at, completed_at, heartbeat_at
             FROM job_attempts WHERE job_id = ?`,
        ).get(taskId) as Record<string, number>;
        const heartbeat = db.prepare(
          'SELECT heartbeat_at FROM worker_heartbeats WHERE worker_id = ?',
        ).get('worker-bg-fixed-execution-time') as { heartbeat_at: number };

        expect(observedTimes).toEqual([fixedNow, fixedNow]);
        expect(Object.values(job)).toEqual(Array(5).fill(fixedNow));
        expect(Object.values(attempt)).toEqual(Array(3).fill(fixedNow));
        expect(heartbeat.heartbeat_at).toBe(fixedNow);
        expect(clock).not.toHaveBeenCalled();
        expect(result).toEqual({
          taskId,
          status: 'completed',
          output: { handled: true },
        });
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should enqueue idempotently and process with job/attempt/heartbeat rows', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-1',
          handlers: {
            summary: async (task) => ({ summaryId: `summary:${task.payload.conversationId}` }),
          },
        });

        const firstTaskId = durableWorker.enqueue({
          type: 'summary',
          payload: { conversationId: 'conv-durable' },
          idempotencyKey: 'summary:conv-durable:window-1',
        });
        const duplicateTaskId = durableWorker.enqueue({
          type: 'summary',
          payload: { conversationId: 'conv-durable', duplicate: true },
          idempotencyKey: 'summary:conv-durable:window-1',
        });

        expect(duplicateTaskId).toBe(firstTaskId);
        expect(durableWorker.getStatus(firstTaskId)).toBe('pending');

        const result = await durableWorker.processNext();
        expect(result).toEqual({
          taskId: firstTaskId,
          status: 'completed',
          output: { summaryId: 'summary:conv-durable' },
        });
        expect(durableWorker.getStatus(firstTaskId)).toBe('completed');

        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(firstTaskId) as {
          status: string;
          attempts: number;
          result: string;
        };
        const attempts = db.prepare('SELECT * FROM job_attempts WHERE job_id = ?').all(firstTaskId) as Array<{
          status: string;
          worker_id: string;
          result: string;
        }>;
        const heartbeat = db.prepare('SELECT * FROM worker_heartbeats WHERE worker_id = ?').get('worker-bg-1') as {
          status: string;
          current_job_id: string | null;
        };
        const fkCheck = db.prepare('PRAGMA foreign_key_check').all();

        expect(job.status).toBe('completed');
        expect(job.attempts).toBe(1);
        expect(JSON.parse(job.result)).toEqual({ summaryId: 'summary:conv-durable' });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          status: 'completed',
          worker_id: 'worker-bg-1',
        });
        expect(JSON.parse(attempts[0].result)).toEqual({ summaryId: 'summary:conv-durable' });
        expect(heartbeat).toMatchObject({
          status: 'idle',
          current_job_id: null,
        });
        expect(fkCheck).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should redact durable completed outputs before returning and persisting job results', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-result-redaction-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const rawSecret = 'sk-background-worker-result-secret-should-not-persist';
        const rawKeySecret = 'sk-background-worker-result-key-secret-should-not-persist';
        const rawPlatformId = 'qq-1234567890';
        const rawSecretKey = `api_key=${rawKeySecret}`;
        const rawPlatformKey = `target-${rawPlatformId}`;
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-result-redaction',
          handlers: {
            admin_digest: async () => ({
              digestId: 'digest-result-redaction',
              diagnostic: `completed with api_key=${rawSecret}`,
              targets: [rawPlatformId],
              [rawSecretKey]: 'secret-shaped object keys should be redacted',
              nestedKeys: {
                [rawPlatformKey]: 'platform-shaped object keys should be redacted',
              },
            }),
          },
        });

        const taskId = durableWorker.enqueue({
          type: 'admin_digest',
          payload: { conversationId: 'conv-result-redaction' },
        });

        const result = await durableWorker.processNext();
        const resultText = JSON.stringify(result?.output);

        expect(result).toMatchObject({
          taskId,
          status: 'completed',
        });
        expect(resultText).toContain('digest-result-redaction');
        expect(resultText).toContain('[REDACTED:api_key_assignment]');
        expect(resultText).toContain('[REDACTED:platform_id]');
        expect(resultText).not.toContain(rawSecret);
        expect(resultText).not.toContain(rawKeySecret);
        expect(resultText).not.toContain(rawPlatformId);
        expect(resultText).not.toContain(rawSecretKey);
        expect(resultText).not.toContain(rawPlatformKey);

        const output = result?.output as { nestedKeys?: Record<string, unknown> };
        expect(Object.keys(output)).toContain('[REDACTED:api_key_assignment]');
        expect(Object.keys(output)).not.toContain(rawSecretKey);
        expect(Object.keys(output.nestedKeys ?? {})).toContain('target-[REDACTED:platform_id]');
        expect(Object.keys(output.nestedKeys ?? {})).not.toContain(rawPlatformKey);

        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(taskId) as {
          status: string;
          result: string;
        };
        const attempt = db.prepare('SELECT * FROM job_attempts WHERE job_id = ?').get(taskId) as {
          status: string;
          result: string;
        };

        expect(job.status).toBe('completed');
        expect(JSON.parse(job.result)).toEqual(result?.output);
        expect(job.result).not.toContain(rawSecret);
        expect(job.result).not.toContain(rawKeySecret);
        expect(job.result).not.toContain(rawPlatformId);
        expect(job.result).not.toContain(rawSecretKey);
        expect(job.result).not.toContain(rawPlatformKey);
        expect(attempt.status).toBe('completed');
        expect(attempt.result).toBe(job.result);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should redact numeric platform identifiers in durable completed outputs before returning', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-numeric-result-redaction-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const rawUserId = 1234567890;
        const rawGroupId = 2345678901;
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-numeric-result-redaction',
          handlers: {
            admin_digest: async () => ({
              digestId: 'digest-numeric-result-redaction',
              userId: rawUserId,
              nested: {
                groupIds: [rawGroupId],
                ordinaryCount: 42,
              },
            }),
          },
        });

        const taskId = durableWorker.enqueue({
          type: 'admin_digest',
          payload: { conversationId: 'conv-numeric-result-redaction' },
        });

        const result = await durableWorker.processNext();
        const output = result?.output as {
          userId?: unknown;
          nested?: { groupIds?: unknown[]; ordinaryCount?: number };
        };

        expect(result).toMatchObject({
          taskId,
          status: 'completed',
        });
        expect(output.userId).toBe('[REDACTED:platform_id]');
        expect(output.nested?.groupIds).toEqual(['[REDACTED:platform_id]']);
        expect(output.nested?.ordinaryCount).toBe(42);
        expect(JSON.stringify(result?.output)).not.toContain(String(rawUserId));
        expect(JSON.stringify(result?.output)).not.toContain(String(rawGroupId));

        const job = db.prepare('SELECT status, result FROM jobs WHERE id = ?').get(taskId) as {
          status: string;
          result: string;
        };
        const attempt = db.prepare('SELECT status, result FROM job_attempts WHERE job_id = ?').get(taskId) as {
          status: string;
          result: string;
        };

        expect(job.status).toBe('completed');
        expect(JSON.parse(job.result)).toEqual(result?.output);
        expect(job.result).not.toContain(String(rawUserId));
        expect(job.result).not.toContain(String(rawGroupId));
        expect(attempt.status).toBe('completed');
        expect(attempt.result).toBe(job.result);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should preserve markers for adjacent secret/platform durable completed outputs', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-adjacent-result-redaction-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const adjacentSecretPlatform =
          'sk-background-worker-adjacent-result-secret-should-not-persist-qq-12345678911';
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-adjacent-result-redaction',
          handlers: {
            admin_digest: async () => ({
              digestId: 'digest-adjacent-result-redaction',
              diagnostic: adjacentSecretPlatform,
              nested: {
                [`key-${adjacentSecretPlatform}`]: adjacentSecretPlatform,
              },
            }),
          },
        });

        const taskId = durableWorker.enqueue({
          type: 'admin_digest',
          payload: { conversationId: 'conv-adjacent-result-redaction' },
        });

        const result = await durableWorker.processNext();
        const resultText = JSON.stringify(result?.output);

        expect(result).toMatchObject({
          taskId,
          status: 'completed',
        });
        expect(resultText).toContain('digest-adjacent-result-redaction');
        expect(resultText).toContain('[REDACTED:openai_like_api_key]');
        expect(resultText).toContain('[REDACTED:platform_id]');
        expect(resultText).not.toContain('sk-background-worker-adjacent');
        expect(resultText).not.toContain('qq-12345678911');
        expect(resultText).not.toContain('12345678911');

        const job = db.prepare('SELECT status, result FROM jobs WHERE id = ?').get(taskId) as {
          status: string;
          result: string;
        };
        const attempt = db.prepare('SELECT status, result FROM job_attempts WHERE job_id = ?').get(taskId) as {
          status: string;
          result: string;
        };

        expect(job.status).toBe('completed');
        expect(JSON.parse(job.result)).toEqual(result?.output);
        expect(job.result).toContain('[REDACTED:openai_like_api_key]');
        expect(job.result).toContain('[REDACTED:platform_id]');
        expect(job.result).not.toContain('sk-background-worker-adjacent');
        expect(job.result).not.toContain('qq-12345678911');
        expect(job.result).not.toContain('12345678911');
        expect(attempt.status).toBe('completed');
        expect(attempt.result).toBe(job.result);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should preserve markers for assignment-shaped adjacent durable completed outputs', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-assignment-result-redaction-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const assignmentAdjacentSecretPlatform =
          'api_key=sk-background-worker-assignment-result-secret-should-not-persist-qq-12345678911';
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-assignment-result-redaction',
          handlers: {
            admin_digest: async () => ({
              digestId: 'digest-assignment-result-redaction',
              diagnostic: assignmentAdjacentSecretPlatform,
              nested: {
                [`key-${assignmentAdjacentSecretPlatform}`]: assignmentAdjacentSecretPlatform,
              },
            }),
          },
        });

        const taskId = durableWorker.enqueue({
          type: 'admin_digest',
          payload: { conversationId: 'conv-assignment-result-redaction' },
        });

        const result = await durableWorker.processNext();
        const resultText = JSON.stringify(result?.output);

        expect(result).toMatchObject({
          taskId,
          status: 'completed',
        });
        expect(resultText).toContain('digest-assignment-result-redaction');
        expect(resultText).toContain('[REDACTED:api_key_assignment]');
        expect(resultText).toContain('[REDACTED:platform_id]');
        expect(resultText).not.toContain('sk-background-worker-assignment');
        expect(resultText).not.toContain('qq-12345678911');
        expect(resultText).not.toContain('12345678911');

        const job = db.prepare('SELECT status, result FROM jobs WHERE id = ?').get(taskId) as {
          status: string;
          result: string;
        };
        const attempt = db.prepare('SELECT status, result FROM job_attempts WHERE job_id = ?').get(taskId) as {
          status: string;
          result: string;
        };

        expect(job.status).toBe('completed');
        expect(JSON.parse(job.result)).toEqual(result?.output);
        expect(job.result).toContain('[REDACTED:api_key_assignment]');
        expect(job.result).toContain('[REDACTED:platform_id]');
        expect(job.result).not.toContain('sk-background-worker-assignment');
        expect(job.result).not.toContain('qq-12345678911');
        expect(job.result).not.toContain('12345678911');
        expect(attempt.status).toBe('completed');
        expect(attempt.result).toBe(job.result);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should record failed attempts and retry pending durable jobs', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-fail-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        let calls = 0;
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-fail',
          handlers: {
            extraction: async () => {
              calls += 1;
              if (calls === 1) {
                throw new Error('extract failed once');
              }
              return { extracted: 1 };
            },
          },
        });

        const taskId = durableWorker.enqueue({
          type: 'extraction',
          payload: { conversationId: 'conv-fail', targetUserId: 'user-a' },
          maxAttempts: 2,
        });

        const failed = await durableWorker.processNext();
        expect(failed).toMatchObject({
          taskId,
          status: 'failed',
          error: 'extract failed once',
        });
        expect(durableWorker.getStatus(taskId)).toBe('pending');

        const completed = await durableWorker.processNext();
        expect(completed).toMatchObject({
          taskId,
          status: 'completed',
          output: { extracted: 1 },
        });

        const attempts = db
          .prepare('SELECT status FROM job_attempts WHERE job_id = ? ORDER BY attempt_number ASC')
          .all(taskId) as Array<{ status: string }>;
        const job = jobRepository.findById(taskId);

        expect(attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed']);
        expect(job).toMatchObject({
          status: 'completed',
          attempts: 2,
          result: { extracted: 1 },
        });
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should extend durable leases while a long handler is running to prevent duplicate claims', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-06T00:00:00.000Z'));

      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-lease-heartbeat-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });
      let resolveStarted: (() => void) | undefined;
      let releaseHandler: (() => void) | undefined;
      const handlerStarted = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const handlerRelease = new Promise<{ worker: string }>((resolve) => {
        releaseHandler = () => resolve({ worker: 'a' });
      });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const workerA = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-long-a',
          leaseMs: 100,
          handlers: {
            summary: async () => {
              resolveStarted?.();
              return handlerRelease;
            },
          },
        });
        const workerB = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-long-b',
          leaseMs: 100,
          handlers: {
            summary: async () => ({ worker: 'b' }),
          },
        });

        const taskId = workerA.enqueue({
          type: 'summary',
          payload: { conversationId: 'conv-long-lease' },
          maxAttempts: 2,
        });

        const firstRun = workerA.processNext();
        await handlerStarted;
        await vi.advanceTimersByTimeAsync(120);

        const runningJob = db.prepare('SELECT status, attempts, lease_owner, lease_expires_at FROM jobs WHERE id = ?').get(
          taskId,
        ) as {
          status: string;
          attempts: number;
          lease_owner: string | null;
          lease_expires_at: number | null;
        };
        const secondClaim = await workerB.processNext();
        releaseHandler?.();
        const firstResult = await firstRun;

        expect(runningJob).toMatchObject({
          status: 'running',
          attempts: 1,
          lease_owner: 'worker-bg-long-a',
        });
        expect(runningJob.lease_expires_at).toEqual(expect.any(Number));
        expect(runningJob.lease_expires_at).toBeGreaterThan(Date.now());
        expect(secondClaim).toBeNull();
        expect(firstResult).toEqual({
          taskId,
          status: 'completed',
          output: { worker: 'a' },
        });

        const job = db.prepare('SELECT status, attempts, result FROM jobs WHERE id = ?').get(taskId) as {
          status: string;
          attempts: number;
          result: string;
        };
        const attempts = db
          .prepare('SELECT attempt_number, worker_id, status FROM job_attempts WHERE job_id = ? ORDER BY attempt_number')
          .all(taskId) as Array<{ attempt_number: number; worker_id: string; status: string }>;

        expect(job).toEqual({
          status: 'completed',
          attempts: 1,
          result: JSON.stringify({ worker: 'a' }),
        });
        expect(attempts).toEqual([
          {
            attempt_number: 1,
            worker_id: 'worker-bg-long-a',
            status: 'completed',
          },
        ]);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        releaseHandler?.();
        vi.useRealTimers();
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('does not report completion after the durable attempt loses lease authority', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-lost-lease-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-lost-lease',
          leaseMs: 60_000,
          handlers: {
            summary: async (task) => {
              db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?')
                .run(Date.now(), task.id);
              return { summary: 'handler finished after lease expiry' };
            },
          },
        });
        const taskId = durableWorker.enqueue({
          type: 'summary',
          payload: { conversationId: 'conv-lost-lease' },
          maxAttempts: 2,
        });

        const result = await durableWorker.processNext();
        const job = db.prepare(
          `SELECT status, attempts, completed_at, error, result
             FROM jobs WHERE id = ?`
        ).get(taskId);
        const attempt = db.prepare(
          `SELECT status, completed_at, error, result
             FROM job_attempts WHERE job_id = ?`
        ).get(taskId);

        expect(result).toMatchObject({
          taskId,
          status: 'failed',
          error: expect.stringContaining('lost lease authority'),
        });
        expect(job).toEqual({
          status: 'running',
          attempts: 1,
          completed_at: null,
          error: null,
          result: null,
        });
        expect(attempt).toEqual({
          status: 'running',
          completed_at: null,
          error: null,
          result: null,
        });
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should keep max-attempt failures visible and redacted in job, attempt, and heartbeat rows', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-final-fail-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const rawSecret = 'sk-background-worker-error-secret-should-not-persist';
        const rawPlatformId = 'qq-1234567890';
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-final-fail',
          handlers: {
            conflict: async () => {
              throw new Error(`final conflict worker failure api_key=${rawSecret} target=${rawPlatformId}`);
            },
          },
        });

        const taskId = durableWorker.enqueue({
          type: 'conflict',
          payload: { conversationId: 'conv-final-fail' },
          maxAttempts: 1,
        });

        const failed = await durableWorker.processNext();

        expect(failed).toMatchObject({
          taskId,
          status: 'failed',
        });
        expect(failed?.error).toContain('final conflict worker failure');
        expect(failed?.error).toContain('[REDACTED:api_key_assignment]');
        expect(failed?.error).toContain('[REDACTED:platform_id]');
        expect(failed?.error).not.toContain(rawSecret);
        expect(failed?.error).not.toContain(rawPlatformId);
        expect(durableWorker.getStatus(taskId)).toBe('failed');

        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(taskId) as {
          status: string;
          attempts: number;
          lease_owner: string | null;
          lease_expires_at: number | null;
          completed_at: number | null;
          error: string;
        };
        const attempt = db.prepare('SELECT * FROM job_attempts WHERE job_id = ?').get(taskId) as {
          status: string;
          worker_id: string;
          completed_at: number | null;
          error: string;
        };
        const heartbeat = db
          .prepare('SELECT * FROM worker_heartbeats WHERE worker_id = ?')
          .get('worker-bg-final-fail') as {
          status: string;
          current_job_id: string | null;
          details: string;
        };

        expect(job).toMatchObject({
          status: 'failed',
          attempts: 1,
          lease_owner: null,
          lease_expires_at: null,
        });
        expect(job.error).toContain('final conflict worker failure');
        expect(job.error).toContain('[REDACTED:api_key_assignment]');
        expect(job.error).toContain('[REDACTED:platform_id]');
        expect(job.error).not.toContain(rawSecret);
        expect(job.error).not.toContain(rawPlatformId);
        expect(job.completed_at).toEqual(expect.any(Number));
        expect(attempt).toMatchObject({
          status: 'failed',
          worker_id: 'worker-bg-final-fail',
        });
        expect(attempt.error).toBe(job.error);
        expect(attempt.completed_at).toEqual(expect.any(Number));
        expect(heartbeat).toMatchObject({
          status: 'error',
          current_job_id: taskId,
        });
        const heartbeatDetails = JSON.parse(heartbeat.details) as { jobId: string; error: string };
        expect(heartbeatDetails.jobId).toBe(taskId);
        expect(heartbeatDetails.error).toBe(job.error);
        expect(heartbeat.details).not.toContain(rawSecret);
        expect(heartbeat.details).not.toContain(rawPlatformId);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should preserve final failure heartbeat evidence after a later empty durable poll', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-final-fail-empty-poll-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const rawSecret = 'sk-background-worker-empty-poll-secret-should-not-persist';
        const rawPlatformId = 'qq-1234567890';
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-empty-after-error',
          handlers: {
            conflict: async () => {
              throw new Error(`empty poll conflict failure api_key=${rawSecret} target=${rawPlatformId}`);
            },
          },
        });

        const taskId = durableWorker.enqueue({
          type: 'conflict',
          payload: { conversationId: 'conv-empty-after-error' },
          maxAttempts: 1,
        });

        const failed = await durableWorker.processNext();
        const empty = await durableWorker.processNext();

        expect(failed).toMatchObject({
          taskId,
          status: 'failed',
        });
        expect(empty).toBeNull();
        expect(durableWorker.getStatus(taskId)).toBe('failed');

        const heartbeat = db
          .prepare('SELECT status, current_job_id, details FROM worker_heartbeats WHERE worker_id = ?')
          .get('worker-bg-empty-after-error') as {
          status: string;
          current_job_id: string | null;
          details: string | null;
        };
        const details = JSON.parse(heartbeat.details ?? '{}') as { jobId?: string; error?: string };
        const job = db.prepare('SELECT status, attempts, error FROM jobs WHERE id = ?').get(taskId) as {
          status: string;
          attempts: number;
          error: string;
        };

        expect(heartbeat).toMatchObject({
          status: 'error',
          current_job_id: taskId,
        });
        expect(details.jobId).toBe(taskId);
        expect(details.error).toBe(job.error);
        expect(heartbeat.details).toContain('[REDACTED:api_key_assignment]');
        expect(heartbeat.details).toContain('[REDACTED:platform_id]');
        expect(heartbeat.details).not.toContain(rawSecret);
        expect(heartbeat.details).not.toContain(rawPlatformId);
        expect(job).toMatchObject({
          status: 'failed',
          attempts: 1,
        });
        expect(job.error).toContain('empty poll conflict failure');
        expect(job.error).toContain('[REDACTED:api_key_assignment]');
        expect(job.error).toContain('[REDACTED:platform_id]');
        expect(job.error).not.toContain(rawSecret);
        expect(job.error).not.toContain(rawPlatformId);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should clear a retained error heartbeat after successfully processing later durable work', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-error-recovery-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-error-recovery',
          handlers: {
            conflict: async () => {
              throw new Error('planned conflict failure before later success');
            },
            summary: async (task) => ({ summaryId: `summary:${task.payload.conversationId}` }),
          },
        });

        const failedTaskId = durableWorker.enqueue({
          type: 'conflict',
          payload: { conversationId: 'conv-error-recovery' },
          maxAttempts: 1,
        });

        const failed = await durableWorker.processNext();
        const empty = await durableWorker.processNext();
        const retainedHeartbeat = db
          .prepare('SELECT status, current_job_id, details FROM worker_heartbeats WHERE worker_id = ?')
          .get('worker-bg-error-recovery') as {
          status: string;
          current_job_id: string | null;
          details: string | null;
        };

        const successfulTaskId = durableWorker.enqueue({
          type: 'summary',
          payload: { conversationId: 'conv-error-recovery' },
          maxAttempts: 1,
        });
        const completed = await durableWorker.processNext();

        const finalHeartbeat = db
          .prepare('SELECT status, current_job_id, details FROM worker_heartbeats WHERE worker_id = ?')
          .get('worker-bg-error-recovery') as {
          status: string;
          current_job_id: string | null;
          details: string | null;
        };
        const jobs = db
          .prepare('SELECT id, status, attempts, result FROM jobs WHERE id IN (?, ?) ORDER BY id ASC')
          .all(failedTaskId, successfulTaskId) as Array<{
          id: string;
          status: string;
          attempts: number;
          result: string | null;
        }>;
        const attempts = db
          .prepare('SELECT job_id, status FROM job_attempts WHERE job_id IN (?, ?) ORDER BY job_id ASC')
          .all(failedTaskId, successfulTaskId) as Array<{ job_id: string; status: string }>;

        expect(failed).toMatchObject({
          taskId: failedTaskId,
          status: 'failed',
        });
        expect(empty).toBeNull();
        expect(retainedHeartbeat).toMatchObject({
          status: 'error',
          current_job_id: failedTaskId,
        });
        expect(completed).toEqual({
          taskId: successfulTaskId,
          status: 'completed',
          output: { summaryId: 'summary:conv-error-recovery' },
        });
        expect(finalHeartbeat).toEqual({
          status: 'idle',
          current_job_id: null,
          details: null,
        });
        expect(jobs).toEqual([
          {
            id: failedTaskId,
            status: 'failed',
            attempts: 1,
            result: null,
          },
          {
            id: successfulTaskId,
            status: 'completed',
            attempts: 1,
            result: JSON.stringify({ summaryId: 'summary:conv-error-recovery' }),
          },
        ]);
        expect(attempts).toEqual([
          {
            job_id: failedTaskId,
            status: 'failed',
          },
          {
            job_id: successfulTaskId,
            status: 'completed',
          },
        ]);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should fail unsupported durable job types instead of silently coercing them to summary jobs', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-unsupported-type-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const rawSecret = 'sk-background-worker-unsupported-type-secret-should-not-persist';
        const rawPlatformId = 'qq-1234567890';
        const rawType = `unexpected_${rawPlatformId}_api_key=${rawSecret}`;
        let summaryCalls = 0;
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-unsupported-type',
          handlers: {
            summary: async () => {
              summaryCalls += 1;
              return { summaryId: 'should-not-run' };
            },
          },
        });

        const taskId = jobRepository.enqueue({
          type: rawType,
          payload: { conversationId: 'conv-unsupported-type' },
          maxAttempts: 1,
        });

        const failed = await durableWorker.processNext();

        expect(summaryCalls).toBe(0);
        expect(failed).toMatchObject({
          taskId,
          status: 'failed',
        });
        expect(failed?.error).toContain('Unsupported background job type');
        expect(failed?.error).toContain('[REDACTED:');
        expect(failed?.error).toContain('[REDACTED:platform_id]');
        expect(failed?.error).not.toContain(rawSecret);
        expect(failed?.error).not.toContain(rawPlatformId);
        expect(durableWorker.getStatus(taskId)).toBe('failed');

        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(taskId) as {
          type: string;
          status: string;
          attempts: number;
          result: string | null;
          error: string;
        };
        const attempt = db.prepare('SELECT * FROM job_attempts WHERE job_id = ?').get(taskId) as {
          status: string;
          result: string | null;
          error: string;
        };
        const heartbeat = db
          .prepare('SELECT * FROM worker_heartbeats WHERE worker_id = ?')
          .get('worker-bg-unsupported-type') as {
          status: string;
          current_job_id: string | null;
          details: string;
        };

        expect(job).toMatchObject({
          type: rawType,
          status: 'failed',
          attempts: 1,
          result: null,
        });
        expect(job.error).toBe(failed?.error);
        expect(job.error).not.toContain(rawSecret);
        expect(job.error).not.toContain(rawPlatformId);
        expect(attempt).toMatchObject({
          status: 'failed',
          result: null,
          error: job.error,
        });
        expect(heartbeat).toMatchObject({
          status: 'error',
          current_job_id: taskId,
        });
        const heartbeatDetails = JSON.parse(heartbeat.details) as {
          jobId: string;
          error: string;
          type: string;
        };
        expect(heartbeatDetails.jobId).toBe(taskId);
        expect(heartbeatDetails.error).toBe(job.error);
        expect(heartbeatDetails.type).toContain('[REDACTED:');
        expect(heartbeatDetails.type).toContain('[REDACTED:platform_id]');
        expect(heartbeat.details).not.toContain(rawSecret);
        expect(heartbeat.details).not.toContain(rawPlatformId);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should fail unsupported durable job types terminally without retry churn', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-terminal-unsupported-type-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const rawSecret = 'sk-background-worker-terminal-unsupported-type-secret-should-not-persist';
        const rawPlatformId = 'qq-2233445566';
        const unsupportedType = `terminal_${rawPlatformId}_api_key=${rawSecret}`;
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-terminal-unsupported-type',
        });

        const taskId = jobRepository.enqueue({
          type: unsupportedType,
          payload: { conversationId: 'conv-terminal-unsupported-type' },
          maxAttempts: 3,
        });

        const failed = await durableWorker.processNext();
        const laterPoll = await durableWorker.processNext();

        expect(failed).toMatchObject({
          taskId,
          status: 'failed',
        });
        expect(failed?.error).toContain('Unsupported background job type');
        expect(failed?.error).toContain('[REDACTED:api_key_assignment]');
        expect(failed?.error).toContain('[REDACTED:platform_id]');
        expect(failed?.error).not.toContain(rawSecret);
        expect(failed?.error).not.toContain(rawPlatformId);
        expect(laterPoll).toBeNull();
        expect(durableWorker.getStatus(taskId)).toBe('failed');

        const job = db.prepare('SELECT status, attempts, max_attempts, error FROM jobs WHERE id = ?').get(taskId) as {
          status: string;
          attempts: number;
          max_attempts: number;
          error: string;
        };
        const attempts = db
          .prepare('SELECT attempt_number, status, error FROM job_attempts WHERE job_id = ? ORDER BY attempt_number')
          .all(taskId) as Array<{ attempt_number: number; status: string; error: string }>;
        const heartbeat = db
          .prepare('SELECT status, current_job_id, details FROM worker_heartbeats WHERE worker_id = ?')
          .get('worker-bg-terminal-unsupported-type') as {
          status: string;
          current_job_id: string | null;
          details: string;
        };

        expect(job).toMatchObject({
          status: 'failed',
          attempts: 1,
          max_attempts: 3,
        });
        expect(job.error).toBe(failed?.error);
        expect(attempts).toEqual([
          {
            attempt_number: 1,
            status: 'failed',
            error: job.error,
          },
        ]);
        expect(heartbeat).toMatchObject({
          status: 'error',
          current_job_id: taskId,
        });
        expect(heartbeat.details).toContain('[REDACTED:api_key_assignment]');
        expect(heartbeat.details).toContain('[REDACTED:platform_id]');
        expect(heartbeat.details).not.toContain(rawSecret);
        expect(heartbeat.details).not.toContain(rawPlatformId);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should preserve unsupported durable job types in list output before processing', () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-list-unsupported-type-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-list-unsupported-type',
        });
        const unsupportedType = 'unexpected_review_worker';
        const taskId = jobRepository.enqueue({
          type: unsupportedType,
          payload: { conversationId: 'conv-list-unsupported-type' },
          maxAttempts: 1,
        });

        const tasks = durableWorker.list();

        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
          id: taskId,
          type: unsupportedType,
          status: 'pending',
        });
        expect(tasks[0].type).not.toBe('summary');
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should redact sensitive unsupported durable job types in list output without mutating raw rows', () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-list-sensitive-type-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-list-sensitive-type',
        });
        const rawSecret = 'sk-background-worker-list-type-secret-should-not-return';
        const rawPlatformId = 'qq-3456789012';
        const unsupportedType = `unexpected-${rawPlatformId}-api_key=${rawSecret}`;
        const taskId = jobRepository.enqueue({
          type: unsupportedType,
          payload: { conversationId: 'conv-list-sensitive-type' },
          maxAttempts: 1,
        });

        const [task] = durableWorker.list();
        const serialized = JSON.stringify(task);

        expect(task).toMatchObject({
          id: taskId,
          status: 'pending',
        });
        expect(task?.type).toContain('[REDACTED:platform_id]');
        expect(task?.type).toContain('[REDACTED:api_key_assignment]');
        expect(serialized).toContain('[REDACTED:platform_id]');
        expect(serialized).toContain('[REDACTED:api_key_assignment]');
        expect(serialized).not.toContain(rawSecret);
        expect(serialized).not.toContain(rawPlatformId);
        expect(serialized).not.toContain('3456789012');
        expect(serialized).not.toContain('api_key=');

        const job = db.prepare('SELECT type FROM jobs WHERE id = ?').get(taskId) as { type: string };
        expect(job.type).toBe(unsupportedType);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should redact diagnostic payloads and idempotency keys when listing durable jobs', () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-bg-worker-list-redaction-'));
      const db = initDatabase({ path: join(testDir, 'test.db') });

      try {
        runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
        const jobRepository = new JobRepository(db);
        const durableWorker = new BackgroundWorker({
          jobRepository,
          workerId: 'worker-bg-list-redaction',
        });
        const rawSecret = 'sk-background-worker-durable-list-secret-should-not-return';
        const rawPlatformId = 'qq-2345678901';
        const idempotencyKey = `summary:${rawPlatformId}:api_key=${rawSecret}`;
        const taskId = durableWorker.enqueue({
          type: 'summary',
          payload: {
            conversationId: `group:${rawPlatformId}`,
            groupIds: [2345678901],
            nested: {
              [`api_key=${rawSecret}`]: `target=${rawPlatformId}`,
            },
          },
          idempotencyKey,
        });

        const [task] = durableWorker.list();
        const serialized = JSON.stringify(task);

        expect(task).toMatchObject({
          id: taskId,
          type: 'summary',
          status: 'pending',
        });
        expect(task?.idempotencyKey).toContain('[REDACTED:platform_id]');
        expect(task?.idempotencyKey).toContain('[REDACTED:api_key_assignment]');
        expect(task?.payload.groupIds).toEqual(['[REDACTED:platform_id]']);
        expect(serialized).toContain('[REDACTED:platform_id]');
        expect(serialized).toContain('[REDACTED:api_key_assignment]');
        expect(serialized).not.toContain(rawSecret);
        expect(serialized).not.toContain(rawPlatformId);
        expect(serialized).not.toContain('2345678901');

        const job = db.prepare('SELECT payload, idempotency_key FROM jobs WHERE id = ?').get(taskId) as {
          payload: string;
          idempotency_key: string;
        };
        expect(job.idempotency_key).toBe(idempotencyKey);
        expect(job.payload).toContain(rawSecret);
        expect(job.payload).toContain(rawPlatformId);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});
