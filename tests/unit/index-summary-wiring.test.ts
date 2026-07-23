import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../src/config/index.js';
import { LetheBotApp } from '../../src/index.js';
import { GroupSummaryPolicyRepository } from '../../src/storage/group-summary-policy-repository.js';
import type { GroupSummaryJobService } from '../../src/workers/group-summary-job-service.js';
import type { ConversationSummaryInput } from '../../src/workers/summary-worker.js';

describe('group summary application wiring', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let testDir: string;
  let app: LetheBotApp;

  beforeEach(() => {
    originalEnv = process.env;
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-summary-wiring-'));
    process.env = {
      ...originalEnv,
      LETHEBOT_TEST: 'true',
      LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
      LOG_LEVEL: 'fatal',
      ONEBOT_TRANSPORT: 'http',
      PI_PROVIDER: 'mock',
      PI_MODEL: 'mock',
      EVALUATOR_PROVIDER: 'mock',
      EVALUATOR_MODEL: 'mock',
    };
    delete process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED;
    resetConfig();
    app = new LetheBotApp();
  });

  afterEach(async () => {
    await app.stop();
    process.env = originalEnv;
    resetConfig();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('shares one governed enqueuer across action execution and summary discovery', async () => {
    const db = app.getDatabase();
    const summaryJobs = Reflect.get(app, 'groupSummaryJobService') as GroupSummaryJobService;
    const jobRepository = Reflect.get(app, 'jobRepo') as object;
    const initialExecutor = Reflect.get(app, 'actionExecutor') as object;

    expect(Reflect.get(summaryJobs, 'jobs')).toBe(jobRepository);
    expect(Reflect.get(initialExecutor, 'options')).toMatchObject({
      jobRepository,
      summaryJobService: summaryJobs,
    });

    app.setMessageSenderForTesting({
      sendMessage: vi.fn(async () => 'synthetic-message-id'),
    });
    const replacementExecutor = Reflect.get(app, 'actionExecutor') as object;
    expect(Reflect.get(replacementExecutor, 'options')).toMatchObject({
      jobRepository,
      summaryJobService: summaryJobs,
    });

    let candidates: ConversationSummaryInput[] = [
      {
        conversationId: 'conversation-disabled-group',
        conversationType: 'group',
        groupId: 'group-disabled',
      },
      {
        conversationId: 'conversation-private',
        conversationType: 'private',
      },
    ];
    let plannedSourceIds: string[] = [];
    Reflect.set(app, 'createSummaryWorker', () => ({
      findConversationsNeedingSummary: async () => candidates,
      planGroupSummaryWindow: async () => plannedSourceIds.length === 0
        ? null
        : {
            sourceChatMessageIds: plannedSourceIds,
            candidateCount: plannedSourceIds.length,
          },
    }));
    const enqueueSummaryJobs = Reflect.get(app, 'enqueueSummaryJobs') as () => Promise<void>;

    await enqueueSummaryJobs.call(app);

    const privateJobs = db.prepare(
      'SELECT id, payload, idempotency_key FROM jobs WHERE type = ? ORDER BY id',
    ).all('summary') as Array<{
      id: string;
      payload: string;
      idempotency_key: string | null;
    }>;
    expect(privateJobs).toHaveLength(1);
    expect(JSON.parse(privateJobs[0]?.payload ?? '{}')).toEqual({
      conversationId: 'conversation-private',
      conversationType: 'private',
    });
    expect(privateJobs[0]?.idempotency_key).toMatch(/^summary:v1:/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_job_bindings').get())
      .toEqual({ count: 0 });

    const now = Date.now();
    new GroupSummaryPolicyRepository(db).setEnabled({
      groupId: 'group-enabled',
      enabled: true,
      now,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'synthetic-owner',
        invocationContext: 'admin_cli',
      },
    });
    candidates = [{
      conversationId: 'conversation-enabled-group',
      conversationType: 'group',
      groupId: 'group-enabled',
      timeRange: { startTime: now, endTime: now + 1 },
    }];
    plannedSourceIds = insertGroupMessages(db, {
      conversationId: 'conversation-enabled-group',
      groupId: 'group-enabled',
      prefix: 'enabled-discovery',
      count: 10,
      startTime: now + 1,
    });

    await enqueueSummaryJobs.call(app);

    const binding = db.prepare(
      `SELECT binding.job_id, binding.group_id, binding.conversation_id, binding.generation,
              jobs.payload, jobs.idempotency_key
         FROM group_summary_job_bindings AS binding
         JOIN jobs ON jobs.id = binding.job_id`,
    ).get() as {
      job_id: string;
      group_id: string;
      conversation_id: string;
      generation: number;
      payload: string;
      idempotency_key: string;
    };
    expect(binding).toMatchObject({
      group_id: 'group-enabled',
      conversation_id: 'conversation-enabled-group',
      generation: 1,
    });
    expect(binding.idempotency_key).toMatch(
      /^summary:group-window:v1:[a-f0-9]{32}$/,
    );
    expect(JSON.parse(binding.payload)).toEqual({
      source: 'summary_discovery',
      conversationId: 'conversation-enabled-group',
      conversationType: 'group',
      groupId: 'group-enabled',
      windowVersion: 1,
      sourceChatMessageIds: plannedSourceIds,
      candidateCount: plannedSourceIds.length,
    });

    db.prepare(
      `UPDATE jobs
          SET status = 'failed', completed_at = ?, updated_at = ?, error = 'terminal failure'
        WHERE id = ?`,
    ).run(now + 1, now + 1, binding.job_id);
    await expect(enqueueSummaryJobs.call(app)).resolves.toBeUndefined();
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(binding.job_id))
      .toEqual({ status: 'failed' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE type = ?').get('summary'))
      .toEqual({ count: 2 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects a group binding changed to private payload scope before Provider access', async () => {
    const db = app.getDatabase();
    const summaryJobs = Reflect.get(app, 'groupSummaryJobService') as GroupSummaryJobService;
    const now = Date.now() - 100;
    new GroupSummaryPolicyRepository(db).setEnabled({
      groupId: 'group-bound',
      enabled: true,
      now,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'synthetic-owner',
        invocationContext: 'admin_cli',
      },
    });
    insertGroupMessages(db, {
      conversationId: 'conversation-bound-group',
      groupId: 'group-bound',
      prefix: 'binding-tamper',
      count: 10,
      startTime: now + 1,
    });
    const jobId = await summaryJobs.enqueueSummary({
      conversationId: 'conversation-bound-group',
      conversationType: 'group',
      groupId: 'group-bound',
      payload: {},
      baseIdempotencyKey: 'summary:binding-tamper',
      maxAttempts: 3,
    });
    db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        conversationId: 'conversation-private-tamper',
        conversationType: 'private',
      }),
      jobId,
    );
    const piRunTurn = vi.fn(async () => {
      throw new Error('Provider must not run for a mismatched summary binding');
    });
    app.setPiRuntimeForTesting({ runTurn: piRunTurn });

    const result = await app.processNextBackgroundJobForTesting(undefined, ['summary']);
    const laterPoll = await app.processNextBackgroundJobForTesting(undefined, ['summary']);

    expect(result).toMatchObject({
      taskId: jobId,
      status: 'failed',
      error: 'Group summary job binding does not match the task payload.',
    });
    expect(laterPoll).toBeNull();
    expect(piRunTurn).not.toHaveBeenCalled();
    expect(db.prepare(
      'SELECT status, attempts, max_attempts FROM jobs WHERE id = ?',
    ).get(jobId)).toEqual({ status: 'failed', attempts: 1, max_attempts: 3 });
    expect(db.prepare(
      'SELECT attempt_number, status FROM job_attempts WHERE job_id = ?',
    ).all(jobId)).toEqual([{ attempt_number: 1, status: 'failed' }]);
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_records) AS memories,
         (SELECT COUNT(*) FROM model_contexts) AS contexts,
         (SELECT COUNT(*) FROM model_invocations) AS invocations`,
    ).get()).toEqual({ memories: 0, contexts: 0, invocations: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it.each([
    {
      scenario: 'disabled',
      reenable: false,
      expectedError: 'Group summary policy is disabled.',
    },
    {
      scenario: 'generation-changed',
      reenable: true,
      expectedError: 'Group summary job is bound to a stale policy generation.',
    },
  ])('terminally fails a running summary when policy is $scenario during Provider I/O', async ({
    reenable,
    expectedError,
  }) => {
    const db = app.getDatabase();
    const summaryJobs = Reflect.get(app, 'groupSummaryJobService') as GroupSummaryJobService;
    const policies = new GroupSummaryPolicyRepository(db);
    const base = Date.now() - 1_000;
    const groupId = 'group-disable-during-provider';
    const conversationId = 'conversation-disable-during-provider';
    policies.setEnabled({
      groupId,
      enabled: true,
      now: base,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'synthetic-owner',
        invocationContext: 'admin_cli',
      },
    });
    for (let index = 0; index < 15; index += 1) {
      const rawEventId = `event-disable-during-provider-${index}`;
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
         VALUES (?, 'message.group', ?, 'gateway', '{}', ?)`,
      ).run(rawEventId, base + index, base + 1);
      db.prepare(
        `INSERT INTO chat_messages (
           id, raw_event_id, message_id, conversation_id, conversation_type,
           group_id, sender_id, text, timestamp
         ) VALUES (?, ?, ?, ?, 'group', ?, ?, ?, ?)`,
      ).run(
        `message-disable-during-provider-${index}`,
        rawEventId,
        `platform-message-disable-during-provider-${index}`,
        conversationId,
        groupId,
        `user-${index % 3}`,
        `Synthetic message ${index}`,
        base + index,
      );
    }
    const jobId = await summaryJobs.enqueueSummary({
      conversationId,
      conversationType: 'group',
      groupId,
      payload: {},
      baseIdempotencyKey: 'summary:disable-during-provider',
      maxAttempts: 3,
    });
    const provider = vi.fn(async (input) => {
      policies.setEnabled({
        groupId,
        enabled: false,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'synthetic-owner',
          invocationContext: 'admin_cli',
        },
      });
      if (reenable) {
        policies.setEnabled({
          groupId,
          enabled: true,
          authority: {
            kind: 'bot_owner',
            actorUserId: 'synthetic-owner',
            invocationContext: 'admin_cli',
          },
        });
      }
      return {
        turnId: input.turnId,
        responseText: 'SUMMARY: This result must not be committed',
        toolCallIds: [],
        events: [],
        tokensUsed: { input: 20, output: 10, total: 30 },
        status: 'completed' as const,
      };
    });
    app.setPiRuntimeForTesting({ runTurn: provider });

    const result = await app.processNextBackgroundJobForTesting(undefined, ['summary']);
    const laterPoll = await app.processNextBackgroundJobForTesting(undefined, ['summary']);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      taskId: jobId,
      status: 'failed',
      error: expectedError,
    });
    expect(laterPoll).toBeNull();
    expect(db.prepare(
      'SELECT status, attempts, max_attempts, completed_at, error FROM jobs WHERE id = ?',
    ).get(jobId)).toMatchObject({
      status: 'failed',
      attempts: 1,
      max_attempts: 3,
      completed_at: expect.any(Number),
      error: expectedError,
    });
    expect(db.prepare(
      `SELECT attempt_number, status, completed_at, error
         FROM job_attempts WHERE job_id = ?`,
    ).get(jobId)).toMatchObject({
      attempt_number: 1,
      status: 'failed',
      completed_at: expect.any(Number),
      error: expectedError,
    });
    expect(db.prepare(
      `SELECT model_invocations.status
         FROM model_invocations
         JOIN job_attempts ON job_attempts.id = model_invocations.job_attempt_id
        WHERE job_attempts.job_id = ?`,
    ).all(jobId)).toEqual([{ status: 'completed' }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});

function insertGroupMessages(
  db: Database.Database,
  input: {
    conversationId: string;
    groupId: string;
    prefix: string;
    count: number;
    startTime: number;
  },
): string[] {
  return Array.from({ length: input.count }, (_value, index) => {
    const suffix = String(index).padStart(2, '0');
    const rawEventId = `event-${input.prefix}-${suffix}`;
    const chatMessageId = `message-${input.prefix}-${suffix}`;
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
       VALUES (?, 'message.group', ?, 'gateway', '{}', ?)`,
    ).run(rawEventId, input.startTime + index, input.startTime + index);
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, 'group', ?, ?, ?, ?)`,
    ).run(
      chatMessageId,
      rawEventId,
      `platform-${input.prefix}-${suffix}`,
      input.conversationId,
      input.groupId,
      `user-${index % 3}`,
      `Synthetic source ${index}`,
      input.startTime + index,
    );
    return chatMessageId;
  });
}
