import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GroupSummaryJobService,
  GroupSummaryWindowError,
  type GroupSummaryWindowPlan,
  type GroupSummaryWindowPlanner,
} from '../../../src/workers/group-summary-job-service.js';
import {
  GroupSummaryPolicyError,
  GroupSummaryPolicyRepository,
} from '../../../src/storage/group-summary-policy-repository.js';
import { JobRepository } from '../../../src/storage/job-repository.js';
import {
  closeDatabase,
  initDatabase,
  runMigrations,
} from '../../../src/storage/database.js';

const BASE_TIME = 1_700_000_000_000;

describe('GroupSummaryJobService', () => {
  let root: string;
  let db: Database.Database;
  let jobs: JobRepository;
  let policies: GroupSummaryPolicyRepository;
  let now: number;
  let planned: GroupSummaryWindowPlan | null;
  let planner: GroupSummaryWindowPlanner;
  let service: GroupSummaryJobService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-group-summary-jobs-'));
    db = initDatabase({ path: join(root, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    jobs = new JobRepository(db);
    policies = new GroupSummaryPolicyRepository(db);
    now = BASE_TIME + 100;
    planned = null;
    planner = vi.fn(async () => planned);
    service = createService(planner);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('enqueues private summaries with the caller idempotency key and no group planning', async () => {
    const jobId = await service.enqueueSummary({
      conversationId: 'private:user-alice',
      conversationType: 'private',
      payload: { source: 'test' },
      baseIdempotencyKey: 'summary:private:alice',
      maxAttempts: 2,
    });

    expect(jobs.findById(jobId)).toMatchObject({
      type: 'summary',
      payload: {
        source: 'test',
        conversationId: 'private:user-alice',
        conversationType: 'private',
      },
      idempotencyKey: 'summary:private:alice',
      maxAttempts: 2,
    });
    expect(planner).not.toHaveBeenCalled();
    expect(policies.getBinding(jobId)).toBeNull();
  });

  it('keeps group summaries default-off without planning or leaving a job row', async () => {
    await expect(service.enqueueSummary({
      conversationId: 'group:alpha',
      conversationType: 'group',
      groupId: 'group-alpha',
      payload: { source: 'test' },
    })).rejects.toMatchObject<GroupSummaryPolicyError>({ code: 'policy_disabled' });

    expect(planner).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_job_bindings').get())
      .toEqual({ count: 0 });
  });

  it('requires a configured planner for an enabled group', async () => {
    enable('group-alpha', BASE_TIME);
    const unplannedService = createService(undefined);

    await expect(unplannedService.enqueueSummary({
      conversationId: 'group:alpha',
      conversationType: 'group',
      groupId: 'group-alpha',
      payload: {},
    })).rejects.toMatchObject<GroupSummaryWindowError>({ code: 'source_window_invalid' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
  });

  it('freezes exact service-owned sources and converges route provenance on one job', async () => {
    enable('group-alpha', BASE_TIME);
    const sourceIds = insertGroupMessages({ count: 3 });
    planned = { sourceChatMessageIds: sourceIds, candidateCount: 7 };

    const firstId = await service.enqueueSummary({
      conversationId: 'group:alpha',
      conversationType: 'group',
      groupId: 'group-alpha',
      payload: {
        source: 'summary_discovery',
        conversationId: 'spoof-conversation',
        conversationType: 'private',
        groupId: 'spoof-group',
        sourceChatMessageIds: ['spoof-source'],
        candidateCount: 999,
        timeRange: { startTime: 1, endTime: 2 },
        taskPayload: {
          keep: 'nested-provenance',
          conversationId: 'nested-spoof-conversation',
          conversationType: 'private',
          groupId: 'nested-spoof-group',
          sourceChatMessageIds: ['nested-spoof-source'],
          messageRange: { start: 'a', end: 'z' },
        },
      },
      baseIdempotencyKey: 'route-specific-discovery-key',
      scheduledAt: BASE_TIME - 1_000,
      maxAttempts: 4,
    });
    const secondId = await service.enqueueSummary({
      conversationId: 'group:alpha',
      conversationType: 'group',
      groupId: 'group-alpha',
      payload: {
        source: 'action_executor',
        actionDecisionId: 'decision-route-convergence',
      },
      baseIdempotencyKey: 'route-specific-action-key',
    });

    expect(secondId).toBe(firstId);
    expect(planner).toHaveBeenCalledTimes(1);
    expect(planner).toHaveBeenCalledWith({
      conversationId: 'group:alpha',
      groupId: 'group-alpha',
      eligibleAfter: BASE_TIME + 1,
    });
    expect(jobs.findById(firstId)).toMatchObject({
      type: 'summary',
      payload: {
        source: 'summary_discovery',
        taskPayload: { keep: 'nested-provenance' },
        conversationId: 'group:alpha',
        conversationType: 'group',
        groupId: 'group-alpha',
        windowVersion: 1,
        sourceChatMessageIds: sourceIds,
        candidateCount: 7,
      },
      idempotencyKey: expect.stringMatching(/^summary:group-window:v1:[a-f0-9]{32}$/),
      scheduledAt: new Date(BASE_TIME + 1),
      maxAttempts: 4,
    });
    expect(policies.getBinding(firstId)).toMatchObject({
      jobId: firstId,
      groupId: 'group-alpha',
      conversationId: 'group:alpha',
      generation: 1,
      eligibleAfter: BASE_TIME + 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 });
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('creates distinct jobs for disjoint canonical windows and rejects reordered sources', async () => {
    enable('group-alpha', BASE_TIME);
    const sourceIds = insertGroupMessages({ count: 4 });
    planned = { sourceChatMessageIds: sourceIds.slice(0, 2), candidateCount: 2 };
    const firstId = await enqueueGroup();
    db.prepare(
      `UPDATE jobs
          SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, now, firstId);

    planned = { sourceChatMessageIds: sourceIds.slice(2), candidateCount: 2 };
    const secondId = await enqueueGroup();

    expect(secondId).not.toBe(firstId);
    expect(jobs.findById(firstId)?.idempotencyKey).not.toBe(jobs.findById(secondId)?.idempotencyKey);
    db.prepare(
      `UPDATE jobs
          SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, now, secondId);

    planned = { sourceChatMessageIds: [sourceIds[3] ?? '', sourceIds[2] ?? ''], candidateCount: 2 };
    await expect(enqueueGroup()).rejects.toMatchObject<GroupSummaryWindowError>({
      code: 'source_window_invalid',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 2 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('does not report a terminally failed exact window as newly scheduled', async () => {
    enable('group-alpha', BASE_TIME);
    const sourceIds = insertGroupMessages({ count: 3 });
    planned = { sourceChatMessageIds: sourceIds.slice(0, 2), candidateCount: 2 };
    const failedId = await enqueueGroup();
    db.prepare(
      `UPDATE jobs
          SET status = 'failed', completed_at = ?, updated_at = ?, error = 'terminal failure'
        WHERE id = ?`,
    ).run(now, now, failedId);

    await expect(enqueueGroup()).rejects.toMatchObject<GroupSummaryWindowError>({
      code: 'window_unavailable',
    });

    planned = { sourceChatMessageIds: sourceIds.slice(2), candidateCount: 1 };
    const nextId = await enqueueGroup();
    expect(nextId).not.toBe(failedId);
    expect(jobs.findById(nextId)).toMatchObject({
      status: 'pending',
      payload: { sourceChatMessageIds: sourceIds.slice(2) },
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('leaves no job or binding when policy changes while the planner is running', async () => {
    enable('group-alpha', BASE_TIME);
    const sourceIds = insertGroupMessages({ count: 2 });
    const racingPlanner: GroupSummaryWindowPlanner = vi.fn(async () => {
      setEnabled('group-alpha', false, BASE_TIME + 50);
      return { sourceChatMessageIds: sourceIds, candidateCount: 2 };
    });
    service = createService(racingPlanner);

    await expect(enqueueGroup()).rejects.toMatchObject<GroupSummaryPolicyError>({
      code: 'policy_disabled',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_job_bindings').get())
      .toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it.each([
    ['a null plan', null],
    ['an empty plan', { sourceChatMessageIds: [], candidateCount: 10 }],
  ] as const)('rejects %s as an unavailable window', async (_label, plan) => {
    enable('group-alpha', BASE_TIME);
    planned = plan;

    await expect(enqueueGroup()).rejects.toMatchObject<GroupSummaryWindowError>({
      code: 'window_unavailable',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
  });

  it('rejects invalid bounded source plans before persistence', async () => {
    enable('group-alpha', BASE_TIME);
    const sourceIds = insertGroupMessages({ count: 1 });
    planned = {
      sourceChatMessageIds: [sourceIds[0] ?? '', sourceIds[0] ?? ''],
      candidateCount: 2,
    };
    await expect(enqueueGroup()).rejects.toMatchObject<GroupSummaryWindowError>({
      code: 'source_window_invalid',
    });

    planned = {
      sourceChatMessageIds: Array.from({ length: 51 }, (_value, index) => `message-${index}`),
      candidateCount: 51,
    };
    await expect(enqueueGroup()).rejects.toMatchObject<GroupSummaryWindowError>({
      code: 'source_window_invalid',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
  });

  it('rejects sources already governed by a group summary memory', async () => {
    enable('group-alpha', BASE_TIME);
    const sourceIds = insertGroupMessages({ count: 1 });
    planned = { sourceChatMessageIds: sourceIds, candidateCount: 1 };
    db.prepare(
      `INSERT INTO memory_records (
         id, scope, group_id, conversation_id,
         visibility, sensitivity, authority, kind, title, content,
         state, confidence, importance, source_context, created_at, updated_at
       ) VALUES (
         'memory-existing-summary', 'group', 'group-alpha', 'group:alpha',
         'same_group_only', 'normal', 'tool_derived', 'summary', 'summary', 'content',
         'active', 0.9, 0.6, 'background_worker:summary', ?, ?
       )`,
    ).run(BASE_TIME + 1, BASE_TIME + 1);
    db.prepare(
      `INSERT INTO memory_sources (
         memory_id, source_type, source_id, source_timestamp, extracted_by
       ) VALUES ('memory-existing-summary', 'chat_message', ?, ?, 'worker')`,
    ).run(sourceIds[0], BASE_TIME + 1);

    await expect(enqueueGroup()).rejects.toMatchObject<GroupSummaryWindowError>({
      code: 'source_window_invalid',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects overlap with another active or completed durable group window', async () => {
    enable('group-alpha', BASE_TIME);
    const sourceIds = insertGroupMessages({ count: 1 });
    planned = { sourceChatMessageIds: sourceIds, candidateCount: 1 };
    const existingId = jobs.enqueue({
      type: 'summary',
      payload: {
        conversationId: 'group:alpha',
        conversationType: 'group',
        groupId: 'group-alpha',
        sourceChatMessageIds: sourceIds,
        candidateCount: 1,
      },
      idempotencyKey: 'legacy-route-specific-summary-key',
      now: BASE_TIME + 1,
    });
    policies.bindSummaryJob({
      jobId: existingId,
      groupId: 'group-alpha',
      conversationId: 'group:alpha',
      now: BASE_TIME + 1,
    });

    await expect(enqueueGroup()).rejects.toMatchObject<GroupSummaryWindowError>({
      code: 'source_window_invalid',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('detects a tampered existing idempotent window without rebinding it', async () => {
    enable('group-alpha', BASE_TIME);
    const sourceIds = insertGroupMessages({ count: 1 });
    planned = { sourceChatMessageIds: sourceIds, candidateCount: 1 };
    const jobId = await enqueueGroup();
    db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(JSON.stringify({
      conversationId: 'group:alpha',
      conversationType: 'group',
      groupId: 'group-alpha',
      windowVersion: 1,
      sourceChatMessageIds: ['tampered-source'],
      candidateCount: 1,
    }), jobId);

    await expect(enqueueGroup()).rejects.toMatchObject<GroupSummaryWindowError>({
      code: 'source_window_invalid',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 });
  });

  it('uses a new source-derived key after disable and re-enable', async () => {
    enable('group-alpha', BASE_TIME);
    const firstSources = insertGroupMessages({ count: 1, idPrefix: 'first' });
    planned = { sourceChatMessageIds: firstSources, candidateCount: 1 };
    const firstId = await enqueueGroup();

    setEnabled('group-alpha', false, BASE_TIME + 200);
    setEnabled('group-alpha', true, BASE_TIME + 300);
    const secondSources = insertGroupMessages({
      count: 1,
      idPrefix: 'second',
      rawCreatedAt: BASE_TIME + 301,
    });
    planned = { sourceChatMessageIds: secondSources, candidateCount: 1 };
    now = BASE_TIME + 400;
    const secondId = await enqueueGroup();

    expect(secondId).not.toBe(firstId);
    expect(jobs.findById(firstId)?.status).toBe('failed');
    expect(jobs.findById(secondId)?.idempotencyKey).not.toBe(jobs.findById(firstId)?.idempotencyKey);
    expect(policies.getBinding(secondId)).toMatchObject({
      generation: 3,
      eligibleAfter: BASE_TIME + 301,
    });
  });

  it('rolls back a newly inserted frozen job when binding fails', async () => {
    enable('group-alpha', BASE_TIME);
    const sourceIds = insertGroupMessages({ count: 1 });
    planned = { sourceChatMessageIds: sourceIds, candidateCount: 1 };
    vi.spyOn(policies, 'bindSummaryJob').mockImplementation(() => {
      throw new Error('simulated binding failure');
    });

    await expect(enqueueGroup()).rejects.toThrow('simulated binding failure');
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_job_bindings').get())
      .toEqual({ count: 0 });
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  function createService(
    windowPlanner: GroupSummaryWindowPlanner | undefined,
  ): GroupSummaryJobService {
    return new GroupSummaryJobService(db, {
      jobRepository: jobs,
      policyRepository: policies,
      planGroupSummaryWindow: windowPlanner,
      clock: () => now,
    });
  }

  function enqueueGroup(): Promise<string> {
    return service.enqueueSummary({
      conversationId: 'group:alpha',
      conversationType: 'group',
      groupId: 'group-alpha',
      payload: { source: 'test' },
      baseIdempotencyKey: 'ignored-group-base-key',
    });
  }

  function insertGroupMessages(options: {
    count: number;
    idPrefix?: string;
    rawCreatedAt?: number;
  }): string[] {
    const idPrefix = options.idPrefix ?? 'source';
    const rawCreatedAt = options.rawCreatedAt ?? BASE_TIME + 1;
    const sourceIds: string[] = [];
    for (let index = 0; index < options.count; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      const rawEventId = `event-${idPrefix}-${suffix}`;
      const chatMessageId = `message-${idPrefix}-${suffix}`;
      sourceIds.push(chatMessageId);
      db.prepare(
        `INSERT INTO raw_events (
           id, type, timestamp, source, platform, conversation_id, payload, created_at
         ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', 'group:alpha', '{}', ?)`,
      ).run(rawEventId, rawCreatedAt + index, rawCreatedAt + index);
      db.prepare(
        `INSERT INTO chat_messages (
           id, raw_event_id, message_id, conversation_id, conversation_type,
           group_id, sender_id, text, timestamp
         ) VALUES (?, ?, ?, 'group:alpha', 'group', 'group-alpha', ?, 'synthetic', ?)`,
      ).run(
        chatMessageId,
        rawEventId,
        `platform-${idPrefix}-${suffix}`,
        `user-${index % 2}`,
        rawCreatedAt + options.count - index,
      );
    }
    return sourceIds;
  }

  function enable(groupId: string, at: number): void {
    setEnabled(groupId, true, at);
  }

  function setEnabled(groupId: string, enabled: boolean, at: number): void {
    policies.setEnabled({
      groupId,
      enabled,
      now: at,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
  }
});
