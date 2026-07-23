import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { JobRepository } from '../../../src/storage/job-repository';

describe('JobRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: JobRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-job-repo-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    repo = new JobRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('enqueue is idempotent by idempotency key', () => {
    const first = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-1' },
      idempotencyKey: 'summary:conv-1:0-10',
      now: 1000,
    });
    const second = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-1', duplicate: true },
      idempotencyKey: 'summary:conv-1:0-10',
      now: 2000,
    });

    const rows = db.prepare('SELECT * FROM jobs').all();
    const job = repo.findById(first);

    expect(second).toBe(first);
    expect(rows).toHaveLength(1);
    expect(job).toMatchObject({
      id: first,
      status: 'pending',
      attempts: 0,
      payload: { conversationId: 'conv-1' },
      idempotencyKey: 'summary:conv-1:0-10',
    });
  });

  it('claimNext creates attempt row, lease, heartbeat, and valid FK', () => {
    const jobId = repo.enqueue({
      type: 'extraction',
      payload: { conversationId: 'conv-2' },
      now: 1000,
    });

    const claimed = repo.claimNext({ workerId: 'worker-a', now: 1500, leaseMs: 5000 });
    const job = repo.findById(jobId);
    const attempts = db
      .prepare('SELECT * FROM job_attempts WHERE job_id = ?')
      .all(jobId) as Array<{ attempt_number: number; worker_id: string; status: string }>;
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();

    expect(claimed?.job.id).toBe(jobId);
    expect(claimed?.attemptNumber).toBe(1);
    expect(job).toMatchObject({
      status: 'running',
      attempts: 1,
      leaseOwner: 'worker-a',
    });
    expect(job?.leaseExpiresAt?.getTime()).toBe(6500);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt_number: 1,
      worker_id: 'worker-a',
      status: 'running',
    });
    expect(fkCheck).toHaveLength(0);
  });

  it('reclaims expired leases by failing stale attempts before retry', () => {
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-expired-lease' },
      maxAttempts: 3,
      now: 1000,
    });
    const first = repo.claimNext({ workerId: 'worker-a', now: 1000, leaseMs: 500 });
    if (!first) {
      throw new Error('Expected first lease claim');
    }

    const beforeExpiry = repo.claimNext({ workerId: 'worker-b', now: 1499, leaseMs: 500 });
    expect(beforeExpiry).toBeNull();

    const retry = repo.claimNext({ workerId: 'worker-b', now: 1501, leaseMs: 1000 });
    const job = repo.findById(jobId);
    const attempts = db
      .prepare(
        `SELECT attempt_number, worker_id, status, completed_at, heartbeat_at, error
         FROM job_attempts
         WHERE job_id = ?
         ORDER BY attempt_number ASC`
      )
      .all(jobId) as Array<{
      attempt_number: number;
      worker_id: string;
      status: string;
      completed_at: number | null;
      heartbeat_at: number;
      error: string | null;
    }>;

    expect(retry?.attemptNumber).toBe(2);
    expect(retry?.job.id).toBe(jobId);
    expect(job).toMatchObject({
      status: 'running',
      attempts: 2,
      leaseOwner: 'worker-b',
    });
    expect(job?.leaseExpiresAt?.getTime()).toBe(2501);
    expect(attempts).toEqual([
      {
        attempt_number: 1,
        worker_id: 'worker-a',
        status: 'failed',
        completed_at: 1501,
        heartbeat_at: 1501,
        error: 'Lease expired before retry by worker-b',
      },
      {
        attempt_number: 2,
        worker_id: 'worker-b',
        status: 'running',
        completed_at: null,
        heartbeat_at: 1501,
        error: null,
      },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts sensitive worker identifiers from stale lease retry diagnostics while preserving raw local keys', () => {
    const rawSecret = 'sk-lease-reclaim-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';
    const sensitiveWorkerId = `worker api_key=${rawSecret} ${rawPlatformId}`;
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-expired-sensitive-worker' },
      maxAttempts: 3,
      now: 1000,
    });
    const first = repo.claimNext({ workerId: 'worker-a', now: 1000, leaseMs: 500 });
    if (!first) {
      throw new Error('Expected first lease claim');
    }

    const retry = repo.claimNext({ workerId: sensitiveWorkerId, now: 1501, leaseMs: 1000 });
    const attempts = db
      .prepare(
        `SELECT attempt_number, worker_id, status, error
         FROM job_attempts
         WHERE job_id = ?
         ORDER BY attempt_number ASC`
      )
      .all(jobId) as Array<{
      attempt_number: number;
      worker_id: string;
      status: string;
      error: string | null;
    }>;

    expect(retry?.attemptNumber).toBe(2);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      attempt_number: 1,
      worker_id: 'worker-a',
      status: 'failed',
    });
    expect(attempts[0].error).toContain('Lease expired before retry by');
    expect(attempts[0].error).toContain('[REDACTED:api_key_assignment]');
    expect(attempts[0].error).toContain('[REDACTED:platform_id]');
    expect(attempts[0].error).not.toContain(rawSecret);
    expect(attempts[0].error).not.toContain(rawPlatformId);
    expect(attempts[1]).toMatchObject({
      attempt_number: 2,
      worker_id: sensitiveWorkerId,
      status: 'running',
      error: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('fails expired running jobs that already reached max attempts', () => {
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-expired-final' },
      maxAttempts: 1,
      now: 1000,
    });
    const first = repo.claimNext({ workerId: 'worker-a', now: 1000, leaseMs: 500 });
    if (!first) {
      throw new Error('Expected first lease claim');
    }

    const retry = repo.claimNext({ workerId: 'worker-b', now: 1501, leaseMs: 1000 });
    const job = repo.findById(jobId);
    const attempts = db
      .prepare(
        `SELECT attempt_number, worker_id, status, completed_at, heartbeat_at, error
         FROM job_attempts
         WHERE job_id = ?
         ORDER BY attempt_number ASC`
      )
      .all(jobId) as Array<{
      attempt_number: number;
      worker_id: string;
      status: string;
      completed_at: number | null;
      heartbeat_at: number;
      error: string | null;
    }>;

    expect(retry).toBeNull();
    expect(job).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'Lease expired after max attempts',
    });
    expect(job?.leaseOwner).toBeUndefined();
    expect(job?.leaseExpiresAt).toBeUndefined();
    expect(job?.completedAt?.getTime()).toBe(1501);
    expect(attempts).toEqual([
      {
        attempt_number: 1,
        worker_id: 'worker-a',
        status: 'failed',
        completed_at: 1501,
        heartbeat_at: 1501,
        error: 'Lease expired after max attempts',
      },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('keeps type-filtered claim polling from mutating unrelated expired max-attempt jobs', () => {
    const expiredExtractionJobId = repo.enqueue({
      type: 'extraction',
      payload: { conversationId: 'conv-type-filter-expired', targetUserId: 'user-type-filter' },
      maxAttempts: 1,
      now: 1000,
    });
    const expiredExtractionClaim = repo.claimNext({
      workerId: 'worker-extraction-a',
      now: 1000,
      leaseMs: 100,
      types: ['extraction'],
    });
    if (!expiredExtractionClaim) {
      throw new Error('Expected extraction job to be claimed');
    }

    const summaryJobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-type-filter-summary' },
      now: 1001,
    });

    const summaryClaim = repo.claimNext({
      workerId: 'worker-summary',
      now: 1200,
      leaseMs: 500,
      types: ['summary'],
    });
    const extractionAfterSummaryPoll = repo.findById(expiredExtractionJobId);
    const extractionAttemptAfterSummaryPoll = db
      .prepare('SELECT status, error FROM job_attempts WHERE id = ?')
      .get(expiredExtractionClaim.attemptId) as { status: string; error: string | null };

    expect(summaryClaim?.job.id).toBe(summaryJobId);
    expect(summaryClaim?.attemptNumber).toBe(1);
    expect(extractionAfterSummaryPoll).toMatchObject({
      id: expiredExtractionJobId,
      type: 'extraction',
      status: 'running',
      attempts: 1,
      leaseOwner: 'worker-extraction-a',
    });
    expect(extractionAttemptAfterSummaryPoll).toEqual({
      status: 'running',
      error: null,
    });

    const extractionRetry = repo.claimNext({
      workerId: 'worker-extraction-b',
      now: 1201,
      leaseMs: 500,
      types: ['extraction'],
    });
    const extractionAfterExtractionPoll = repo.findById(expiredExtractionJobId);
    const extractionAttemptAfterExtractionPoll = db
      .prepare('SELECT status, completed_at, error FROM job_attempts WHERE id = ?')
      .get(expiredExtractionClaim.attemptId) as {
      status: string;
      completed_at: number | null;
      error: string | null;
    };
    const summaryJob = repo.findById(summaryJobId);

    expect(extractionRetry).toBeNull();
    expect(extractionAfterExtractionPoll).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'Lease expired after max attempts',
    });
    expect(extractionAfterExtractionPoll?.leaseOwner).toBeUndefined();
    expect(extractionAfterExtractionPoll?.leaseExpiresAt).toBeUndefined();
    expect(extractionAttemptAfterExtractionPoll).toEqual({
      status: 'failed',
      completed_at: 1201,
      error: 'Lease expired after max attempts',
    });
    expect(summaryJob).toMatchObject({
      status: 'running',
      attempts: 1,
      leaseOwner: 'worker-summary',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('complete records result on job and attempt', () => {
    const jobId = repo.enqueue({ type: 'summary', payload: { conversationId: 'conv-3' }, now: 1000 });
    const claimed = repo.claimNext({ workerId: 'worker-a', now: 1000 });
    if (!claimed) {
      throw new Error('Expected job to be claimed');
    }

    repo.complete({
      jobId,
      attemptId: claimed.attemptId,
      result: { summaryId: 'summary-1' },
      now: 2000,
    });

    const job = repo.findById(jobId);
    const attempt = db
      .prepare('SELECT * FROM job_attempts WHERE id = ?')
      .get(claimed.attemptId) as { status: string; result: string; completed_at: number };

    expect(job).toMatchObject({
      status: 'completed',
      result: { summaryId: 'summary-1' },
    });
    expect(job?.completedAt?.getTime()).toBe(2000);
    expect(attempt.status).toBe('completed');
    expect(JSON.parse(attempt.result)).toEqual({ summaryId: 'summary-1' });
    expect(attempt.completed_at).toBe(2000);
  });

  it('redacts secret-like and platform identifiers before persisting completed job results', () => {
    const rawSecret = 'sk-job-repository-result-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-redacted-result' },
      now: 1000,
    });
    const claimed = repo.claimNext({ workerId: 'worker-result-redaction', now: 1000 });
    if (!claimed) {
      throw new Error('Expected job to be claimed');
    }

    repo.complete({
      jobId,
      attemptId: claimed.attemptId,
      result: {
        summaryId: 'summary-redacted-result',
        diagnostic: `completed with api_key=${rawSecret}`,
        targets: [rawPlatformId],
      },
      now: 2000,
    });

    const job = db.prepare('SELECT status, result FROM jobs WHERE id = ?').get(jobId) as {
      status: string;
      result: string;
    };
    const attempt = db
      .prepare('SELECT status, result FROM job_attempts WHERE id = ?')
      .get(claimed.attemptId) as {
      status: string;
      result: string;
    };

    const jobResultText = job.result;
    const attemptResultText = attempt.result;

    expect(job.status).toBe('completed');
    expect(jobResultText).toContain('summary-redacted-result');
    expect(jobResultText).toContain('[REDACTED:api_key_assignment]');
    expect(jobResultText).toContain('[REDACTED:platform_id]');
    expect(jobResultText).not.toContain(rawSecret);
    expect(jobResultText).not.toContain(rawPlatformId);
    expect(attempt.status).toBe('completed');
    expect(attemptResultText).toBe(jobResultText);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts sensitive object keys before persisting structured job diagnostics', () => {
    const rawSecret = 'sk-job-repository-key-secret-should-not-persist';
    const rawToken = 'token-key-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-redacted-result-key' },
      now: 1000,
    });
    const claimed = repo.claimNext({ workerId: 'worker-result-key-redaction', now: 1000 });
    if (!claimed) {
      throw new Error('Expected job to be claimed');
    }

    repo.complete({
      jobId,
      attemptId: claimed.attemptId,
      result: {
        [`api_key=${rawSecret}`]: 'diagnostic-key-value',
        nested: {
          [`platform ${rawPlatformId}`]: 'platform-key-value',
          list: [{ [`access_token=${rawToken}`]: 'token-key-value' }],
        },
      },
      now: 2000,
    });

    const job = db.prepare('SELECT result FROM jobs WHERE id = ?').get(jobId) as {
      result: string;
    };
    const attempt = db
      .prepare('SELECT result FROM job_attempts WHERE id = ?')
      .get(claimed.attemptId) as {
      result: string;
    };

    expect(job.result).toContain('[REDACTED:api_key_assignment]');
    expect(job.result).toContain('[REDACTED:token_assignment]');
    expect(job.result).toContain('[REDACTED:platform_id]');
    expect(job.result).not.toContain(rawSecret);
    expect(job.result).not.toContain(rawToken);
    expect(job.result).not.toContain(rawPlatformId);
    expect(attempt.result).toBe(job.result);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts numeric platform identifiers before persisting structured job diagnostics while preserving counters', () => {
    const rawSenderId = 1234567890;
    const rawGroupId = 998877665;
    const rawMessageId = 1122334455;
    const rawTargetUserId = 2233445566;
    const rawRecipientGroupId = 3344556677;
    const rawOwnerMessageId = 4455667788;
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-redacted-numeric-job-diagnostics' },
      now: 1000,
    });
    const claimed = repo.claimNext({ workerId: 'worker-numeric-diagnostics', now: 1000 });
    if (!claimed) {
      throw new Error('Expected job to be claimed');
    }

    repo.complete({
      jobId,
      attemptId: claimed.attemptId,
      result: {
        senderId: rawSenderId,
        targetUserId: rawTargetUserId,
        group_ids: [rawGroupId],
        nested: {
          recipientGroupIds: [rawRecipientGroupId],
          messageId: rawMessageId,
          ownerMessageId: rawOwnerMessageId,
          processedCount: 42,
          durationMs: 9001,
        },
      },
      now: 2000,
    });
    repo.heartbeat({
      workerId: 'worker-numeric-diagnostics',
      workerType: 'background',
      status: 'idle',
      details: {
        senderId: rawSenderId,
        targetUserId: rawTargetUserId,
        group_ids: [rawGroupId],
        nested: {
          recipientGroupIds: [rawRecipientGroupId],
          messageId: rawMessageId,
          ownerMessageId: rawOwnerMessageId,
          processedCount: 42,
          durationMs: 9001,
        },
      },
      now: 2100,
    });

    const row = db.prepare('SELECT result FROM jobs WHERE id = ?').get(jobId) as { result: string };
    const attempt = db
      .prepare('SELECT result FROM job_attempts WHERE id = ?')
      .get(claimed.attemptId) as { result: string };
    const heartbeat = db
      .prepare('SELECT details FROM worker_heartbeats WHERE worker_id = ?')
      .get('worker-numeric-diagnostics') as { details: string };

    const result = JSON.parse(row.result) as {
      senderId: string;
      targetUserId: string;
      group_ids: string[];
      nested: {
        recipientGroupIds: string[];
        messageId: string;
        ownerMessageId: string;
        processedCount: number;
        durationMs: number;
      };
    };
    const heartbeatDetails = JSON.parse(heartbeat.details) as typeof result;
    const serialized = `${row.result}\n${attempt.result}\n${heartbeat.details}`;

    expect(result.senderId).toBe('[REDACTED:platform_id]');
    expect(result.targetUserId).toBe('[REDACTED:platform_id]');
    expect(result.group_ids).toEqual(['[REDACTED:platform_id]']);
    expect(result.nested.recipientGroupIds).toEqual(['[REDACTED:platform_id]']);
    expect(result.nested.messageId).toBe('[REDACTED:platform_id]');
    expect(result.nested.ownerMessageId).toBe('[REDACTED:platform_id]');
    expect(result.nested.processedCount).toBe(42);
    expect(result.nested.durationMs).toBe(9001);
    expect(heartbeatDetails).toEqual(result);
    expect(attempt.result).toBe(row.result);
    expect(serialized).not.toContain(String(rawSenderId));
    expect(serialized).not.toContain(String(rawGroupId));
    expect(serialized).not.toContain(String(rawMessageId));
    expect(serialized).not.toContain(String(rawTargetUserId));
    expect(serialized).not.toContain(String(rawRecipientGroupId));
    expect(serialized).not.toContain(String(rawOwnerMessageId));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for adjacent secret/platform durable job diagnostics', () => {
    const adjacentSecretPlatform =
      'sk-job-adjacent-secret-should-not-persist-qq-12345678911';
    const completedJobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-adjacent-result' },
      now: 1000,
    });
    const completedClaim = repo.claimNext({ workerId: 'worker-adjacent-result', now: 1000 });
    if (!completedClaim) {
      throw new Error('Expected completed job claim');
    }

    repo.complete({
      jobId: completedJobId,
      attemptId: completedClaim.attemptId,
      result: {
        diagnostic: `completed ${adjacentSecretPlatform}`,
        nested: {
          [`diagnostic ${adjacentSecretPlatform}`]: 'key-value',
        },
      },
      now: 1100,
    });

    const failedJobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-adjacent-failure' },
      maxAttempts: 1,
      now: 1200,
    });
    const failedClaim = repo.claimNext({ workerId: 'worker-adjacent-failure', now: 1200 });
    if (!failedClaim) {
      throw new Error('Expected failed job claim');
    }

    repo.fail({
      jobId: failedJobId,
      attemptId: failedClaim.attemptId,
      error: `failed ${adjacentSecretPlatform}`,
      now: 1300,
    });

    repo.heartbeat({
      workerId: 'worker-adjacent-heartbeat',
      workerType: 'background',
      status: 'error',
      currentJobId: failedJobId,
      details: {
        message: `heartbeat ${adjacentSecretPlatform}`,
      },
      now: 1400,
    });

    const completedJob = db.prepare('SELECT result FROM jobs WHERE id = ?').get(completedJobId) as {
      result: string;
    };
    const completedAttempt = db
      .prepare('SELECT result FROM job_attempts WHERE id = ?')
      .get(completedClaim.attemptId) as {
      result: string;
    };
    const failedJob = db.prepare('SELECT error FROM jobs WHERE id = ?').get(failedJobId) as {
      error: string;
    };
    const failedAttempt = db
      .prepare('SELECT error FROM job_attempts WHERE id = ?')
      .get(failedClaim.attemptId) as {
      error: string;
    };
    const heartbeat = db
      .prepare('SELECT details FROM worker_heartbeats WHERE worker_id = ?')
      .get('worker-adjacent-heartbeat') as {
      details: string;
    };
    const serialized = [
      completedJob.result,
      completedAttempt.result,
      failedJob.error,
      failedAttempt.error,
      heartbeat.details,
    ].join('\n');

    expect(completedAttempt.result).toBe(completedJob.result);
    expect(failedAttempt.error).toBe(failedJob.error);
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain('sk-job-adjacent');
    expect(serialized).not.toContain('qq-12345678911');
    expect(serialized).not.toContain('12345678911');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for assignment-shaped adjacent durable job diagnostics', () => {
    const assignmentAdjacentSecretPlatform =
      'api_key=sk-job-assignment-secret-should-not-persist-qq-12345678911';
    const completedJobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-assignment-adjacent-result' },
      now: 1000,
    });
    const completedClaim = repo.claimNext({
      workerId: 'worker-assignment-adjacent-result',
      now: 1000,
    });
    if (!completedClaim) {
      throw new Error('Expected completed job claim');
    }

    repo.complete({
      jobId: completedJobId,
      attemptId: completedClaim.attemptId,
      result: {
        diagnostic: `completed ${assignmentAdjacentSecretPlatform}`,
        nested: {
          [`diagnostic ${assignmentAdjacentSecretPlatform}`]: 'key-value',
        },
      },
      now: 1100,
    });

    const failedJobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-assignment-adjacent-failure' },
      maxAttempts: 1,
      now: 1200,
    });
    const failedClaim = repo.claimNext({
      workerId: 'worker-assignment-adjacent-failure',
      now: 1200,
    });
    if (!failedClaim) {
      throw new Error('Expected failed job claim');
    }

    repo.fail({
      jobId: failedJobId,
      attemptId: failedClaim.attemptId,
      error: `failed ${assignmentAdjacentSecretPlatform}`,
      now: 1300,
    });

    repo.heartbeat({
      workerId: 'worker-assignment-adjacent-heartbeat',
      workerType: 'background',
      status: 'error',
      currentJobId: failedJobId,
      details: {
        message: `heartbeat ${assignmentAdjacentSecretPlatform}`,
      },
      now: 1400,
    });

    const completedJob = db.prepare('SELECT result FROM jobs WHERE id = ?').get(completedJobId) as {
      result: string;
    };
    const completedAttempt = db
      .prepare('SELECT result FROM job_attempts WHERE id = ?')
      .get(completedClaim.attemptId) as {
      result: string;
    };
    const failedJob = db.prepare('SELECT error FROM jobs WHERE id = ?').get(failedJobId) as {
      error: string;
    };
    const failedAttempt = db
      .prepare('SELECT error FROM job_attempts WHERE id = ?')
      .get(failedClaim.attemptId) as {
      error: string;
    };
    const heartbeat = db
      .prepare('SELECT details FROM worker_heartbeats WHERE worker_id = ?')
      .get('worker-assignment-adjacent-heartbeat') as {
      details: string;
    };
    const serialized = [
      completedJob.result,
      completedAttempt.result,
      failedJob.error,
      failedAttempt.error,
      heartbeat.details,
    ].join('\n');

    expect(completedAttempt.result).toBe(completedJob.result);
    expect(failedAttempt.error).toBe(failedJob.error);
    expect(serialized).toContain('[REDACTED:api_key_assignment]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain('sk-job-assignment');
    expect(serialized).not.toContain('qq-12345678911');
    expect(serialized).not.toContain('12345678911');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('failed attempts retry until max attempts then mark job failed', () => {
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-4' },
      maxAttempts: 2,
      now: 1000,
    });

    const first = repo.claimNext({ workerId: 'worker-a', now: 1000 });
    expect(first).not.toBeNull();
    if (!first) {
      throw new Error('Expected first attempt');
    }
    repo.fail({ jobId, attemptId: first.attemptId, error: 'timeout', retryDelayMs: 100, now: 1100 });

    const retryReady = repo.findById(jobId);
    expect(retryReady).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: 'timeout',
    });
    expect(retryReady?.scheduledAt.getTime()).toBe(1200);

    const second = repo.claimNext({ workerId: 'worker-b', now: 1200 });
    expect(second?.attemptNumber).toBe(2);
    if (!second) {
      throw new Error('Expected second attempt');
    }
    repo.fail({ jobId, attemptId: second.attemptId, error: 'still failing', now: 1300 });

    const failed = repo.findById(jobId);
    const attempts = db
      .prepare('SELECT status FROM job_attempts WHERE job_id = ? ORDER BY attempt_number ASC')
      .all(jobId) as Array<{ status: string }>;

    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 2,
      error: 'still failing',
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed', 'failed']);
  });

  it('terminal failures skip retry scheduling while preserving redacted DB evidence', () => {
    const rawSecret = 'sk-job-repository-terminal-secret-should-not-persist';
    const rawPlatformId = 'qq-5678901234';
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-terminal-failure' },
      maxAttempts: 3,
      now: 1000,
    });

    const claimed = repo.claimNext({ workerId: 'worker-terminal', now: 1000, leaseMs: 5000 });
    expect(claimed).not.toBeNull();
    if (!claimed) {
      throw new Error('Expected terminal failure attempt');
    }

    repo.fail({
      jobId,
      attemptId: claimed.attemptId,
      error: `permanent bad input api_key=${rawSecret} target=${rawPlatformId}`,
      retryDelayMs: 10_000,
      terminal: true,
      now: 1100,
    });

    const laterClaim = repo.claimNext({ workerId: 'worker-terminal-later', now: 11_100 });
    const job = repo.findById(jobId);
    const attempts = db
      .prepare(
        `SELECT attempt_number, worker_id, status, completed_at, error
         FROM job_attempts
         WHERE job_id = ?
         ORDER BY attempt_number ASC`
      )
      .all(jobId) as Array<{
      attempt_number: number;
      worker_id: string;
      status: string;
      completed_at: number | null;
      error: string | null;
    }>;

    expect(laterClaim).toBeNull();
    expect(job).toMatchObject({
      status: 'failed',
      attempts: 1,
      maxAttempts: 3,
    });
    expect(job?.leaseOwner).toBeUndefined();
    expect(job?.leaseExpiresAt).toBeUndefined();
    expect(job?.completedAt?.getTime()).toBe(1100);
    expect(job?.scheduledAt.getTime()).toBe(1100);
    expect(job?.error).toContain('permanent bad input');
    expect(job?.error).toContain('[REDACTED:api_key_assignment]');
    expect(job?.error).toContain('[REDACTED:platform_id]');
    expect(job?.error).not.toContain(rawSecret);
    expect(job?.error).not.toContain(rawPlatformId);
    expect(attempts).toEqual([
      {
        attempt_number: 1,
        worker_id: 'worker-terminal',
        status: 'failed',
        completed_at: 1100,
        error: job?.error ?? null,
      },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('honors retry delay before reclaiming failed jobs while allowing other ready work', () => {
    const delayedJobId = repo.enqueue({
      type: 'extraction',
      payload: { conversationId: 'conv-retry-delay', targetUserId: 'user-a' },
      maxAttempts: 3,
      now: 1000,
    });
    const first = repo.claimNext({ workerId: 'worker-a', now: 1000, leaseMs: 1000 });
    if (!first) {
      throw new Error('Expected delayed retry seed job to be claimed');
    }

    repo.fail({
      jobId: delayedJobId,
      attemptId: first.attemptId,
      error: 'transient extraction failure',
      retryDelayMs: 5000,
      now: 1100,
    });

    const readyJobId = repo.enqueue({
      type: 'extraction',
      payload: { conversationId: 'conv-ready-work', targetUserId: 'user-b' },
      now: 1200,
    });

    const beforeDelay = repo.claimNext({ workerId: 'worker-b', now: 6099, leaseMs: 1000 });
    const delayedBeforeReadyTime = repo.findById(delayedJobId);
    const delayedAttemptsBeforeReadyTime = db
      .prepare('SELECT attempt_number, status FROM job_attempts WHERE job_id = ? ORDER BY attempt_number ASC')
      .all(delayedJobId) as Array<{ attempt_number: number; status: string }>;

    expect(beforeDelay?.job.id).toBe(readyJobId);
    expect(beforeDelay?.attemptNumber).toBe(1);
    expect(delayedBeforeReadyTime).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: 'transient extraction failure',
    });
    expect(delayedBeforeReadyTime?.scheduledAt.getTime()).toBe(6100);
    expect(delayedBeforeReadyTime?.leaseOwner).toBeUndefined();
    expect(delayedBeforeReadyTime?.leaseExpiresAt).toBeUndefined();
    expect(delayedAttemptsBeforeReadyTime).toEqual([
      { attempt_number: 1, status: 'failed' },
    ]);

    const afterDelay = repo.claimNext({ workerId: 'worker-c', now: 6100, leaseMs: 1000 });
    const delayedAfterReadyTime = repo.findById(delayedJobId);
    const delayedAttemptsAfterReadyTime = db
      .prepare('SELECT attempt_number, worker_id, status FROM job_attempts WHERE job_id = ? ORDER BY attempt_number ASC')
      .all(delayedJobId) as Array<{ attempt_number: number; worker_id: string; status: string }>;
    const readyJob = repo.findById(readyJobId);

    expect(afterDelay?.job.id).toBe(delayedJobId);
    expect(afterDelay?.attemptNumber).toBe(2);
    expect(delayedAfterReadyTime).toMatchObject({
      status: 'running',
      attempts: 2,
      leaseOwner: 'worker-c',
    });
    expect(delayedAfterReadyTime?.leaseExpiresAt?.getTime()).toBe(7100);
    expect(delayedAttemptsAfterReadyTime).toEqual([
      { attempt_number: 1, worker_id: 'worker-a', status: 'failed' },
      { attempt_number: 2, worker_id: 'worker-c', status: 'running' },
    ]);
    expect(readyJob).toMatchObject({
      status: 'running',
      attempts: 1,
      leaseOwner: 'worker-b',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts secret-like and platform identifiers before persisting job failure errors', () => {
    const rawSecret = 'sk-job-repository-error-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-redacted-failure' },
      maxAttempts: 1,
      now: 1000,
    });
    const claimed = repo.claimNext({ workerId: 'worker-redaction', now: 1000 });
    if (!claimed) {
      throw new Error('Expected job to be claimed');
    }

    repo.fail({
      jobId,
      attemptId: claimed.attemptId,
      error: `summary failed api_key=${rawSecret} target=${rawPlatformId}`,
      now: 1100,
    });

    const job = db.prepare('SELECT status, error FROM jobs WHERE id = ?').get(jobId) as {
      status: string;
      error: string;
    };
    const attempt = db
      .prepare('SELECT status, error FROM job_attempts WHERE id = ?')
      .get(claimed.attemptId) as {
      status: string;
      error: string;
    };

    expect(job.status).toBe('failed');
    expect(job.error).toContain('summary failed');
    expect(job.error).toContain('[REDACTED:api_key_assignment]');
    expect(job.error).toContain('[REDACTED:platform_id]');
    expect(job.error).not.toContain(rawSecret);
    expect(job.error).not.toContain(rawPlatformId);
    expect(attempt.status).toBe('failed');
    expect(attempt.error).toBe(job.error);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects terminal and renewal writes after the current attempt lease expires', () => {
    for (const operation of ['complete', 'fail', 'extendLease'] as const) {
      const jobId = repo.enqueue({
        type: 'summary',
        payload: { conversationId: `conv-expired-${operation}` },
        maxAttempts: 3,
        now: 1000,
      });
      const claimed = repo.claimNext({
        workerId: `worker-expired-${operation}`,
        now: 1000,
        leaseMs: 500,
      });
      if (!claimed) {
        throw new Error(`Expected ${operation} attempt to be claimed`);
      }

      const accepted = operation === 'complete'
        ? repo.complete({
            jobId,
            attemptId: claimed.attemptId,
            result: { stale: operation },
            now: 1500,
          })
        : operation === 'fail'
          ? repo.fail({
              jobId,
              attemptId: claimed.attemptId,
              error: 'stale failure after lease expiry',
              now: 1500,
            })
          : repo.extendLease({
              jobId,
              attemptId: claimed.attemptId,
              workerId: `worker-expired-${operation}`,
              leaseMs: 1000,
              now: 1500,
            });

      const job = db.prepare(
        `SELECT status, attempts, lease_owner, lease_expires_at, heartbeat_at,
                completed_at, error, result
           FROM jobs WHERE id = ?`
      ).get(jobId);
      const attempt = db.prepare(
        `SELECT status, completed_at, heartbeat_at, error, result
           FROM job_attempts WHERE id = ?`
      ).get(claimed.attemptId);

      expect(accepted).toBe(false);
      expect(job).toEqual({
        status: 'running',
        attempts: 1,
        lease_owner: `worker-expired-${operation}`,
        lease_expires_at: 1500,
        heartbeat_at: 1000,
        completed_at: null,
        error: null,
        result: null,
      });
      expect(attempt).toEqual({
        status: 'running',
        completed_at: null,
        heartbeat_at: 1000,
        error: null,
        result: null,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    }
  });

  it('ignores stale attempt completion, failure, and lease extension after retry claim', () => {
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-stale-attempt' },
      maxAttempts: 3,
      now: 1000,
    });
    const first = repo.claimNext({ workerId: 'worker-a', now: 1000, leaseMs: 500 });
    if (!first) {
      throw new Error('Expected first attempt');
    }

    const second = repo.claimNext({ workerId: 'worker-b', now: 1600, leaseMs: 1000 });
    if (!second) {
      throw new Error('Expected retry attempt');
    }

    repo.complete({
      jobId,
      attemptId: first.attemptId,
      result: { stale: 'complete' },
      now: 1700,
    });
    repo.fail({
      jobId,
      attemptId: first.attemptId,
      error: 'stale failure',
      now: 1800,
    });
    repo.extendLease({
      jobId,
      attemptId: first.attemptId,
      workerId: 'worker-a',
      leaseMs: 10_000,
      now: 1900,
    });

    const jobAfterStaleUpdates = repo.findById(jobId);
    const attemptsAfterStaleUpdates = db
      .prepare(
        `SELECT attempt_number, worker_id, status, completed_at, heartbeat_at, error, result
         FROM job_attempts
         WHERE job_id = ?
         ORDER BY attempt_number ASC`
      )
      .all(jobId) as Array<{
      attempt_number: number;
      worker_id: string;
      status: string;
      completed_at: number | null;
      heartbeat_at: number;
      error: string | null;
      result: string | null;
    }>;

    expect(jobAfterStaleUpdates).toMatchObject({
      status: 'running',
      attempts: 2,
      leaseOwner: 'worker-b',
    });
    expect(jobAfterStaleUpdates?.leaseExpiresAt?.getTime()).toBe(2600);
    expect(jobAfterStaleUpdates?.result).toBeUndefined();
    expect(jobAfterStaleUpdates?.error).toBeUndefined();
    expect(attemptsAfterStaleUpdates).toEqual([
      {
        attempt_number: 1,
        worker_id: 'worker-a',
        status: 'failed',
        completed_at: 1600,
        heartbeat_at: 1600,
        error: 'Lease expired before retry by worker-b',
        result: null,
      },
      {
        attempt_number: 2,
        worker_id: 'worker-b',
        status: 'running',
        completed_at: null,
        heartbeat_at: 1600,
        error: null,
        result: null,
      },
    ]);

    repo.complete({
      jobId,
      attemptId: second.attemptId,
      result: { ok: true },
      now: 2000,
    });

    const completed = repo.findById(jobId);
    expect(completed).toMatchObject({
      status: 'completed',
      result: { ok: true },
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('records worker heartbeat and extends lease', () => {
    const jobId = repo.enqueue({ type: 'summary', payload: { conversationId: 'conv-5' }, now: 1000 });
    const claimed = repo.claimNext({ workerId: 'worker-a', now: 1000, leaseMs: 1000 });
    if (!claimed) {
      throw new Error('Expected job to be claimed');
    }

    repo.heartbeat({
      workerId: 'worker-a',
      workerType: 'background',
      status: 'running',
      currentJobId: jobId,
      details: { attemptId: claimed.attemptId },
      now: 1500,
    });
    repo.extendLease({
      jobId,
      attemptId: claimed.attemptId,
      workerId: 'worker-a',
      leaseMs: 2000,
      now: 1500,
    });

    const heartbeat = db.prepare('SELECT * FROM worker_heartbeats WHERE worker_id = ?').get('worker-a') as {
      status: string;
      current_job_id: string;
      heartbeat_at: number;
      details: string;
    };
    const job = repo.findById(jobId);

    expect(heartbeat).toMatchObject({
      status: 'running',
      current_job_id: jobId,
      heartbeat_at: 1500,
    });
    expect(JSON.parse(heartbeat.details)).toEqual({ attemptId: claimed.attemptId });
    expect(job?.leaseExpiresAt?.getTime()).toBe(3500);
  });

  it('redacts sensitive object keys before persisting worker heartbeat details', () => {
    const rawSecret = 'sk-worker-heartbeat-key-secret-should-not-persist';
    const rawToken = 'worker-heartbeat-token-should-not-persist';
    const rawPlatformId = 'qq-1234567890';
    const jobId = repo.enqueue({
      type: 'summary',
      payload: { conversationId: 'conv-redacted-heartbeat-key' },
      now: 1000,
    });
    const claimed = repo.claimNext({ workerId: 'worker-heartbeat-key-redaction', now: 1000 });
    if (!claimed) {
      throw new Error('Expected job to be claimed');
    }

    repo.heartbeat({
      workerId: 'worker-heartbeat-key-redaction',
      workerType: 'background',
      status: 'running',
      currentJobId: jobId,
      details: {
        attemptId: claimed.attemptId,
        [`api_key=${rawSecret}`]: 'heartbeat-key-value',
        nested: {
          [`platform ${rawPlatformId}`]: 'platform-key-value',
          list: [{ [`access_token=${rawToken}`]: 'token-key-value' }],
        },
      },
      now: 1500,
    });

    const heartbeat = db
      .prepare('SELECT details FROM worker_heartbeats WHERE worker_id = ?')
      .get('worker-heartbeat-key-redaction') as {
      details: string;
    };

    expect(heartbeat.details).toContain('[REDACTED:api_key_assignment]');
    expect(heartbeat.details).toContain('[REDACTED:token_assignment]');
    expect(heartbeat.details).toContain('[REDACTED:platform_id]');
    expect(heartbeat.details).not.toContain(rawSecret);
    expect(heartbeat.details).not.toContain(rawToken);
    expect(heartbeat.details).not.toContain(rawPlatformId);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
