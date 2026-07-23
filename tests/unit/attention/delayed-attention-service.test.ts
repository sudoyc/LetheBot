import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DELAYED_ATTENTION_JOB_TYPE,
  DelayedAttentionService,
  parseDelayedAttentionTaskPayload,
} from '../../../src/attention/delayed-attention-service';
import { closeDatabase, initDatabase, runMigrations } from '../../../src/storage/database';
import { JobRepository, type ClaimedJob } from '../../../src/storage/job-repository';

const BASE_TIME = 1_800_000_000_000;
const GROUP_ID = 'qq-group-synthetic-delayed';
const CONVERSATION_ID = 'group:synthetic-delayed';

describe('DelayedAttentionService', () => {
  let root: string;
  let db: Database.Database;
  let jobs: JobRepository;
  let service: DelayedAttentionService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-delayed-attention-'));
    db = initDatabase({ path: join(root, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    jobs = new JobRepository(db);
    service = new DelayedAttentionService(db, jobs);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts only the exact bounded candidate task payload', () => {
    expect(parseDelayedAttentionTaskPayload({ candidateId: 'candidate-1' })).toEqual({
      candidateId: 'candidate-1',
    });
    expect(() => parseDelayedAttentionTaskPayload(null)).toThrow(/exactly/);
    expect(() => parseDelayedAttentionTaskPayload([])).toThrow(/exactly/);
    expect(() => parseDelayedAttentionTaskPayload({ candidateId: '' })).toThrow(/exactly/);
    expect(() => parseDelayedAttentionTaskPayload({ candidateId: 'candidate-1', extra: true }))
      .toThrow(/exactly/);
    expect(() => parseDelayedAttentionTaskPayload({ candidateId: 'x'.repeat(129) }))
      .toThrow(/exactly/);
  });

  it('persists one source-bound candidate and delayed job without copying message text', () => {
    const source = seedQuestion('candidate', BASE_TIME);

    const first = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: BASE_TIME + 5,
    });
    const second = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: BASE_TIME + 10,
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      sourceRawEventId: source.rawEventId,
      sourceChatMessageId: source.chatMessageId,
      conversationId: CONVERSATION_ID,
      groupId: GROUP_ID,
      candidateKind: 'unmentioned_question',
      policyVersion: 'delayed-attention-v1',
      observedAt: BASE_TIME,
      notBeforeAt: BASE_TIME + 15_000,
      expiresAt: BASE_TIME + 120_000,
    });
    const job = jobs.findById(first.jobId);
    expect(job).toMatchObject({
      type: DELAYED_ATTENTION_JOB_TYPE,
      payload: { candidateId: first.id },
      idempotencyKey: `attention:deferred:v1:${source.rawEventId}`,
      status: 'pending',
      maxAttempts: 3,
    });
    expect(job?.scheduledAt.getTime()).toBe(BASE_TIME + 15_000);
    expect(JSON.stringify(job?.payload)).not.toContain(source.text);
    expect(db.prepare('SELECT COUNT(*) FROM attention_candidates').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM jobs WHERE type = ?').pluck().get(
      DELAYED_ATTENTION_JOB_TYPE,
    )).toBe(1);
    expectCleanDatabase();
  });

  it('cannot be claimed or decided before the locked 15-second recheck', () => {
    const source = seedQuestion('not-before', BASE_TIME);
    const candidate = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: BASE_TIME,
    });

    expect(jobs.claimNext({
      workerId: 'attention-worker',
      types: [DELAYED_ATTENTION_JOB_TYPE],
      now: candidate.notBeforeAt - 1,
    })).toBeNull();
    expect(db.prepare('SELECT COUNT(*) FROM attention_decisions').pluck().get()).toBe(0);
    expectCleanDatabase();
  });

  it('reserves one respond decision at 15 seconds and returns it idempotently', () => {
    const source = seedQuestion('respond', BASE_TIME);
    const candidate = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: BASE_TIME,
    });
    const claim = claimCandidate(candidate.id, candidate.notBeforeAt);

    const first = service.decide({
      candidateId: candidate.id,
      jobId: candidate.jobId,
      jobAttemptId: claim.attemptId,
      now: candidate.notBeforeAt,
    });
    const second = service.decide({
      candidateId: candidate.id,
      jobId: candidate.jobId,
      jobAttemptId: claim.attemptId,
      now: candidate.notBeforeAt,
    });

    expect(first).toMatchObject({ outcome: 'respond', suppressors: [] });
    expect(second).toEqual(first);
    expect(db.prepare('SELECT COUNT(*) FROM attention_decisions').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM attention_suppressors').pluck().get()).toBe(0);
    expectCleanDatabase();
  });

  it('suppresses a candidate at the 120-second thread boundary', () => {
    const source = seedQuestion('expired', BASE_TIME);
    const candidate = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: BASE_TIME,
    });
    const claim = claimCandidate(candidate.id, candidate.expiresAt);

    const decision = service.decide({
      candidateId: candidate.id,
      jobId: candidate.jobId,
      jobAttemptId: claim.attemptId,
      now: candidate.expiresAt,
    });

    expect(decision).toMatchObject({
      outcome: 'suppress',
      suppressors: [{ code: 'thread_expired' }],
    });
    expectCleanDatabase();
  });

  it('suppresses after a later human explicitly answers the candidate', () => {
    const source = seedQuestion('answered', BASE_TIME);
    const candidate = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: BASE_TIME,
    });
    const answer = seedLaterMessage('answer', BASE_TIME + 10_000, {
      replyToMessageId: source.platformMessageId,
      text: 'Synthetic human answer.',
    });
    const claim = claimCandidate(candidate.id, candidate.notBeforeAt);

    const decision = service.decide({
      candidateId: candidate.id,
      jobId: candidate.jobId,
      jobAttemptId: claim.attemptId,
      now: candidate.notBeforeAt,
    });

    expect(decision).toMatchObject({
      outcome: 'suppress',
      suppressors: [{
        code: 'human_answer',
        evidenceChatMessageId: answer.chatMessageId,
      }],
    });
    expectCleanDatabase();
  });

  it('suppresses when six human messages arrive in the trailing ten seconds', () => {
    const source = seedQuestion('traffic', BASE_TIME);
    const candidate = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: BASE_TIME,
    });
    for (let index = 0; index < 6; index += 1) {
      seedLaterMessage(`traffic-${index}`, BASE_TIME + 6_000 + index * 1_000);
    }
    const claim = claimCandidate(candidate.id, candidate.notBeforeAt);

    const decision = service.decide({
      candidateId: candidate.id,
      jobId: candidate.jobId,
      jobAttemptId: claim.attemptId,
      now: candidate.notBeforeAt,
    });

    expect(decision).toMatchObject({
      outcome: 'suppress',
      suppressors: [{
        code: 'high_traffic',
        observedCount: 6,
        windowMs: 10_000,
      }],
    });
    expectCleanDatabase();
  });

  it('suppresses the third reserved response in one group within ten minutes', () => {
    reserveResponse('budget-first', BASE_TIME - 60_000, GROUP_ID);
    reserveResponse('budget-other-group', BASE_TIME - 45_000, 'qq-group-other-delayed');
    reserveResponse('budget-second', BASE_TIME - 30_000, GROUP_ID);
    const source = seedQuestion('budget-third', BASE_TIME, { groupId: GROUP_ID });
    const candidate = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: BASE_TIME,
    });
    const claim = claimCandidate(candidate.id, candidate.notBeforeAt);

    const decision = service.decide({
      candidateId: candidate.id,
      jobId: candidate.jobId,
      jobAttemptId: claim.attemptId,
      now: candidate.notBeforeAt,
    });

    expect(decision).toMatchObject({
      outcome: 'suppress',
      suppressors: [{
        code: 'group_budget_exhausted',
        observedCount: 2,
        windowMs: 600_000,
      }],
    });
    expectCleanDatabase();
  });

  it('rejects a stale attempt and permits one lease-fenced retry decision', () => {
    const source = seedQuestion('retry', BASE_TIME);
    const candidate = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: BASE_TIME,
    });
    const stale = claimCandidate(candidate.id, candidate.notBeforeAt, 1);

    expect(() => service.decide({
      candidateId: candidate.id,
      jobId: candidate.jobId,
      jobAttemptId: stale.attemptId,
      now: candidate.notBeforeAt + 1,
    })).toThrow(/lease authority/i);
    expect(db.prepare('SELECT COUNT(*) FROM attention_decisions').pluck().get()).toBe(0);

    const retry = claimCandidate(candidate.id, candidate.notBeforeAt + 1);
    expect(retry.attemptNumber).toBe(2);
    expect(service.decide({
      candidateId: candidate.id,
      jobId: candidate.jobId,
      jobAttemptId: retry.attemptId,
      now: candidate.notBeforeAt + 1,
    }).outcome).toBe('respond');
    expect(db.prepare('SELECT COUNT(*) FROM attention_decisions').pluck().get()).toBe(1);
    expectCleanDatabase();
  });

  function seedQuestion(
    label: string,
    observedAt: number,
    options: { groupId?: string; conversationId?: string } = {},
  ): SeededMessage {
    return seedInboundMessage(label, observedAt, {
      groupId: options.groupId,
      conversationId: options.conversationId,
      text: 'Synthetic unanswered question?',
      admissionState: 'processing',
    });
  }

  function seedLaterMessage(
    label: string,
    observedAt: number,
    options: { replyToMessageId?: string; text?: string } = {},
  ): SeededMessage {
    return seedInboundMessage(label, observedAt, {
      text: options.text ?? 'Synthetic group activity.',
      replyToMessageId: options.replyToMessageId,
      admissionState: 'completed',
    });
  }

  function seedInboundMessage(
    label: string,
    observedAt: number,
    options: {
      groupId?: string;
      conversationId?: string;
      text: string;
      replyToMessageId?: string;
      admissionState: 'processing' | 'completed';
    },
  ): SeededMessage {
    const rawEventId = `raw-delayed-${label}`;
    const chatMessageId = `chat-delayed-${label}`;
    const platformMessageId = `message-delayed-${label}`;
    const groupId = options.groupId ?? GROUP_ID;
    const conversationId = options.conversationId ?? (
      groupId === GROUP_ID ? CONVERSATION_ID : `group:${groupId}`
    );
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, '{}', ?)`,
    ).run(rawEventId, observedAt, conversationId, observedAt);
    db.prepare(
      `INSERT INTO event_ingress_receipts (
         id, raw_event_id, transport, disposition, received_at
       ) VALUES (?, ?, 'http', 'accepted', ?)`,
    ).run(`receipt-delayed-${label}`, rawEventId, observedAt);
    db.prepare(
      `INSERT INTO event_processing_admissions (
         raw_event_id, state, accepted_at, processing_started_at, finished_at, reason_code
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      rawEventId,
      options.admissionState,
      observedAt,
      observedAt,
      options.admissionState === 'completed' ? observedAt : null,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, sender_role, text, has_media, has_quote,
         mentions_bot, reply_to_message_id, timestamp
       ) VALUES (?, ?, ?, ?, 'group', ?, ?, 'member', ?, 0, ?, 0, ?, ?)`,
    ).run(
      chatMessageId,
      rawEventId,
      platformMessageId,
      conversationId,
      groupId,
      `qq-synthetic-${label}`,
      options.text,
      options.replyToMessageId ? 1 : 0,
      options.replyToMessageId ?? null,
      observedAt,
    );
    return {
      rawEventId,
      chatMessageId,
      platformMessageId,
      text: options.text,
    };
  }

  function claimCandidate(candidateId: string, now: number, leaseMs = 60_000): ClaimedJob {
    const claim = jobs.claimNext({
      workerId: 'attention-worker',
      types: [DELAYED_ATTENTION_JOB_TYPE],
      now,
      leaseMs,
    });
    expect(claim?.job.payload).toEqual({ candidateId });
    if (!claim) {
      throw new Error('Expected delayed Attention job claim');
    }
    return claim;
  }

  function reserveResponse(label: string, observedAt: number, groupId: string): void {
    const source = seedQuestion(label, observedAt, { groupId });
    const candidate = service.enqueueCandidate({
      sourceRawEventId: source.rawEventId,
      createdAt: observedAt,
    });
    const claim = claimCandidate(candidate.id, candidate.notBeforeAt);
    const decision = service.decide({
      candidateId: candidate.id,
      jobId: candidate.jobId,
      jobAttemptId: claim.attemptId,
      now: candidate.notBeforeAt,
    });
    expect(decision.outcome).toBe('respond');
    expect(jobs.complete({
      jobId: candidate.jobId,
      attemptId: claim.attemptId,
      now: candidate.notBeforeAt,
      result: { candidateId: candidate.id, decisionId: decision.id, outcome: decision.outcome },
    })).toBe(true);
  }

  function expectCleanDatabase(): void {
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }
});

interface SeededMessage {
  rawEventId: string;
  chatMessageId: string;
  platformMessageId: string;
  text: string;
}
