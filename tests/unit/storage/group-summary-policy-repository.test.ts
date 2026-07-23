import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GroupSummaryPolicyError,
  GroupSummaryPolicyRepository,
} from '../../../src/storage/group-summary-policy-repository.js';
import {
  closeDatabase,
  initDatabase,
  runMigrations,
} from '../../../src/storage/database.js';
import { JobRepository } from '../../../src/storage/job-repository.js';

const BASE_TIME = 1_700_000_000_000;

describe('GroupSummaryPolicyRepository', () => {
  let root: string;
  let db: Database.Database;
  let policies: GroupSummaryPolicyRepository;
  let jobs: JobRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-group-summary-policy-'));
    db = initDatabase({ path: join(root, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    policies = new GroupSummaryPolicyRepository(db);
    jobs = new JobRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('defaults to off and requires bot-owner or exact current-group authority', () => {
    expect(policies.get('qq-group-alpha')).toBeNull();
    expect(policies.isEnabled('qq-group-alpha')).toBe(false);

    expect(() => policies.setEnabled({
      groupId: 'qq-group-alpha',
      enabled: true,
      now: BASE_TIME,
      authority: {
        kind: 'group_admin',
        actorUserId: 'user-admin',
        invocationContext: 'group_chat',
        currentGroupId: 'qq-group-other',
        sourceEventId: 'raw-cross-group-command',
      },
    })).toThrowError(expect.objectContaining<GroupSummaryPolicyError>({
      code: 'unauthorized',
    }));
    expect(policies.get('qq-group-alpha')).toBeNull();

    const enabled = policies.setEnabled({
      groupId: 'qq-group-alpha',
      enabled: true,
      now: BASE_TIME + 1,
      authority: {
        kind: 'group_owner',
        actorUserId: 'user-owner',
        invocationContext: 'group_chat',
        currentGroupId: 'qq-group-alpha',
        sourceEventId: 'raw-enable-command',
      },
    });
    expect(enabled).toMatchObject({
      changed: true,
      canceledJobCount: 0,
      policy: {
        groupId: 'qq-group-alpha',
        state: 'enabled',
        generation: 1,
        eligibleAfter: BASE_TIME + 2,
      },
    });
    expect(policies.isEnabled('qq-group-alpha')).toBe(true);

    const noOp = policies.setEnabled({
      groupId: 'qq-group-alpha',
      enabled: true,
      now: BASE_TIME + 2,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    expect(noOp).toMatchObject({
      changed: false,
      canceledJobCount: 0,
      policy: { generation: 1, eligibleAfter: BASE_TIME + 2 },
    });

    const auditRows = db.prepare(
      `SELECT event_type, actor_user_id, actor_class, invocation_context, details, redacted
         FROM audit_log WHERE event_type = 'group.summary_policy_changed'`,
    ).all() as Array<{
      event_type: string;
      actor_user_id: string;
      actor_class: string;
      invocation_context: string;
      details: string;
      redacted: number;
    }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor_user_id: 'user-owner',
      actor_class: 'owner',
      invocation_context: 'group_chat',
      redacted: 1,
    });
    expect(JSON.parse(auditRows[0]?.details ?? '{}')).toMatchObject({
      groupId: 'qq-group-alpha',
      oldState: 'disabled',
      newState: 'enabled',
      generation: 1,
      eligibleAfter: BASE_TIME + 2,
      authority: 'group_owner',
      sourceEventId: 'raw-enable-command',
      canceledJobCount: 0,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('atomically cancels only matching pending bindings and fences stale attempts', () => {
    enable('qq-group-alpha', BASE_TIME);
    enable('qq-group-beta', BASE_TIME);

    const runningAlpha = enqueueBound('running-alpha', 'qq-group-alpha', 'group:alpha', BASE_TIME + 10);
    const runningClaim = jobs.claimNext({
      workerId: 'summary-worker-running',
      types: ['summary'],
      now: BASE_TIME + 20,
      leaseMs: 1_000,
    });
    expect(runningClaim?.job.id).toBe(runningAlpha);

    const completedAlpha = enqueueBound('completed-alpha', 'qq-group-alpha', 'group:alpha', BASE_TIME + 21);

    db.prepare(
      `UPDATE jobs
          SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(BASE_TIME + 22, BASE_TIME + 22, completedAlpha);
    const pendingAlpha = enqueueBound('pending-alpha', 'qq-group-alpha', 'group:alpha', BASE_TIME + 23);
    const pendingBeta = enqueueBound(
      'pending-beta',
      'qq-group-beta',
      'group:beta',
      BASE_TIME + 24,
      BASE_TIME + 10_000,
    );
    const privateJob = jobs.enqueue({
      id: 'private-summary',
      type: 'summary',
      payload: { conversationId: 'private:user', conversationType: 'private' },
      now: BASE_TIME + 25,
      scheduledAt: BASE_TIME + 10_000,
    });

    const disabled = policies.setEnabled({
      groupId: 'qq-group-alpha',
      enabled: false,
      now: BASE_TIME + 100,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    expect(disabled).toMatchObject({
      changed: true,
      canceledJobCount: 1,
      policy: {
        state: 'disabled',
        generation: 2,
      },
    });
    expect(disabled.policy).not.toHaveProperty('eligibleAfter');
    expect(jobs.findById(pendingAlpha)).toMatchObject({
      status: 'failed',
      error: 'group_summary_policy_disabled',
      result: { code: 'group_summary_policy_disabled' },
    });
    expect(policies.getBinding(pendingAlpha)).toMatchObject({
      canceledAt: new Date(BASE_TIME + 101),
      cancellationCode: 'group_summary_policy_disabled',
    });
    expect(jobs.findById(runningAlpha)?.status).toBe('running');
    expect(policies.getBinding(runningAlpha)?.canceledAt).toBeUndefined();
    expect(jobs.findById(completedAlpha)?.status).toBe('completed');
    expect(jobs.findById(pendingBeta)?.status).toBe('pending');
    expect(jobs.findById(privateJob)?.status).toBe('pending');

    expect(() => policies.assertSummaryJobExecutionAllowed({
      jobId: runningAlpha,
      jobAttemptId: runningClaim?.attemptId ?? '',
      groupId: 'qq-group-alpha',
      conversationId: 'group:alpha',
      now: BASE_TIME + 101,
    })).toThrowError(expect.objectContaining<GroupSummaryPolicyError>({
      code: 'policy_disabled',
    }));

    const reenabled = policies.setEnabled({
      groupId: 'qq-group-alpha',
      enabled: true,
      now: BASE_TIME + 200,
      authority: {
        kind: 'group_admin',
        actorUserId: 'user-admin',
        invocationContext: 'group_chat',
        currentGroupId: 'qq-group-alpha',
      },
    });
    expect(reenabled.policy).toMatchObject({
      state: 'enabled',
      generation: 3,
      eligibleAfter: BASE_TIME + 201,
    });
    expect(() => policies.assertSummaryJobExecutionAllowed({
      jobId: runningAlpha,
      jobAttemptId: runningClaim?.attemptId ?? '',
      groupId: 'qq-group-alpha',
      conversationId: 'group:alpha',
      now: BASE_TIME + 201,
    })).toThrowError(expect.objectContaining<GroupSummaryPolicyError>({
      code: 'stale_policy_generation',
    }));

    const currentJob = enqueueBound(
      'current-alpha',
      'qq-group-alpha',
      'group:alpha',
      BASE_TIME + 210,
    );
    const currentClaim = jobs.claimNext({
      workerId: 'summary-worker-current',
      types: ['summary'],
      now: BASE_TIME + 220,
      leaseMs: 1_000,
    });
    expect(currentClaim?.job.id).toBe(currentJob);
    expect(policies.assertSummaryJobExecutionAllowed({
      jobId: currentJob,
      jobAttemptId: currentClaim?.attemptId ?? '',
      groupId: 'qq-group-alpha',
      conversationId: 'group:alpha',
      now: BASE_TIME + 221,
    })).toMatchObject({
      jobId: currentJob,
      groupId: 'qq-group-alpha',
      conversationId: 'group:alpha',
      generation: 3,
      eligibleAfter: BASE_TIME + 201,
    });
    expect(() => policies.assertSummaryJobExecutionAllowed({
      jobId: currentJob,
      jobAttemptId: currentClaim?.attemptId ?? '',
      groupId: 'qq-group-other',
      conversationId: 'group:alpha',
      now: BASE_TIME + 221,
    })).toThrowError(expect.objectContaining<GroupSummaryPolicyError>({
      code: 'job_binding_mismatch',
    }));
    expect(() => policies.assertSummaryJobExecutionAllowed({
      jobId: currentJob,
      jobAttemptId: currentClaim?.attemptId ?? '',
      groupId: 'qq-group-alpha',
      conversationId: 'group:alpha',
      now: BASE_TIME + 1_221,
    })).toThrowError(expect.objectContaining<GroupSummaryPolicyError>({
      code: 'job_attempt_not_authorized',
    }));
    expect(() => policies.assertSummaryJobExecutionAllowed({
      jobId: privateJob,
      jobAttemptId: 'missing-attempt',
      groupId: 'qq-group-alpha',
      conversationId: 'group:alpha',
      now: BASE_TIME + 221,
    })).toThrowError(expect.objectContaining<GroupSummaryPolicyError>({
      code: 'job_not_bound',
    }));

    const policyAudits = db.prepare(
      `SELECT details FROM audit_log
        WHERE event_type = 'group.summary_policy_changed'
          AND json_extract(details, '$.groupId') = 'qq-group-alpha'
        ORDER BY timestamp`,
    ).all() as Array<{ details: string }>;
    expect(policyAudits.map((row) => JSON.parse(row.details))).toEqual([
      expect.objectContaining({ oldState: 'disabled', newState: 'enabled', generation: 1 }),
      expect.objectContaining({ oldState: 'enabled', newState: 'disabled', generation: 2, canceledJobCount: 1 }),
      expect.objectContaining({ oldState: 'disabled', newState: 'enabled', generation: 3 }),
    ]);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('applies disable under clock rollback without moving later eligibility backward', () => {
    enable('qq-group-clock-rollback', BASE_TIME + 300);
    const pendingJobId = enqueueBound(
      'pending-clock-rollback',
      'qq-group-clock-rollback',
      'group:clock-rollback',
      BASE_TIME + 301,
      BASE_TIME + 1_000,
    );
    const disabled = policies.setEnabled({
      groupId: 'qq-group-clock-rollback',
      enabled: false,
      now: BASE_TIME + 200,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    expect(disabled).toMatchObject({
      changed: true,
      canceledJobCount: 1,
      policy: {
        state: 'disabled',
        generation: 2,
        updatedAt: new Date(BASE_TIME + 302),
      },
    });
    expect(jobs.findById(pendingJobId)).toMatchObject({
      status: 'failed',
      error: 'group_summary_policy_disabled',
    });

    const reenabled = policies.setEnabled({
      groupId: 'qq-group-clock-rollback',
      enabled: true,
      now: BASE_TIME + 250,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    expect(reenabled.policy).toMatchObject({
      state: 'enabled',
      generation: 3,
      eligibleAfter: BASE_TIME + 303,
      updatedAt: new Date(BASE_TIME + 303),
    });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'group.summary_policy_changed'
          AND json_extract(details, '$.groupId') = 'qq-group-clock-rollback'`,
    ).pluck().get()).toBe(3);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('advances enable boundaries beyond existing exact-group ingress under clock rollback', () => {
    const groupId = 'qq-group-ingress-ceiling';
    insertGroupIngress('future-exact', groupId, BASE_TIME + 1_000);
    insertGroupIngress('future-other', 'qq-group-other', BASE_TIME + 5_000);

    const enabled = policies.setEnabled({
      groupId,
      enabled: true,
      now: BASE_TIME,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    expect(enabled.policy).toMatchObject({
      state: 'enabled',
      generation: 1,
      eligibleAfter: BASE_TIME + 1_001,
      updatedAt: new Date(BASE_TIME + 1_001),
    });

    policies.setEnabled({
      groupId,
      enabled: false,
      now: BASE_TIME + 100,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    insertGroupIngress('disabled-interval', groupId, BASE_TIME + 1_100);
    const reenabled = policies.setEnabled({
      groupId,
      enabled: true,
      now: BASE_TIME + 50,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    expect(reenabled.policy).toMatchObject({
      state: 'enabled',
      generation: 3,
      eligibleAfter: BASE_TIME + 1_101,
      updatedAt: new Date(BASE_TIME + 1_101),
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects an enable boundary that cannot advance safely', () => {
    const groupId = 'qq-group-max-ingress';
    insertGroupIngress('max-safe-ingress', groupId, Number.MAX_SAFE_INTEGER);

    expect(() => policies.setEnabled({
      groupId,
      enabled: true,
      now: BASE_TIME,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    })).toThrowError(expect.objectContaining<GroupSummaryPolicyError>({
      code: 'invalid_input',
    }));
    expect(policies.get(groupId)).toBeNull();
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM audit_log
        WHERE event_type = 'group.summary_policy_changed'`,
    ).get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it.each([
    ['above the ULID clock', 0x1_0000_0000_0000 + 10],
    ['at the maximum safe integer', Number.MAX_SAFE_INTEGER],
  ])('still disables and cancels pending work %s', (_label, pendingAt) => {
    const groupId = `qq-group-disable-${pendingAt}`;
    enable(groupId, BASE_TIME);
    const jobId = enqueueBound(
      `pending-disable-${pendingAt}`,
      groupId,
      `group:disable-${pendingAt}`,
      pendingAt,
    );

    const disabled = policies.setEnabled({
      groupId,
      enabled: false,
      now: BASE_TIME + 1,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });

    const expectedTransition = pendingAt === Number.MAX_SAFE_INTEGER
      ? pendingAt
      : pendingAt + 1;
    expect(disabled).toMatchObject({
      changed: true,
      canceledJobCount: 1,
      policy: {
        state: 'disabled',
        generation: 2,
      },
    });
    expect(db.prepare(
      `SELECT state, generation, eligible_after, updated_at
         FROM group_summary_policies WHERE group_id = ?`,
    ).get(groupId)).toEqual({
      state: 'disabled',
      generation: 2,
      eligible_after: null,
      updated_at: expectedTransition,
    });
    expect(db.prepare(
      `SELECT status, error, completed_at, updated_at, heartbeat_at
         FROM jobs WHERE id = ?`,
    ).get(jobId)).toEqual({
      status: 'failed',
      error: 'group_summary_policy_disabled',
      completed_at: expectedTransition,
      updated_at: expectedTransition,
      heartbeat_at: expectedTransition,
    });
    expect(db.prepare(
      `SELECT canceled_at, cancellation_code
         FROM group_summary_job_bindings WHERE job_id = ?`,
    ).get(jobId)).toEqual({
      canceled_at: expectedTransition,
      cancellation_code: 'group_summary_policy_disabled',
    });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM audit_log
        WHERE event_type = 'group.summary_policy_changed'`,
    ).get()).toEqual({ count: 2 });
    if (pendingAt === Number.MAX_SAFE_INTEGER) {
      expect(() => policies.setEnabled({
        groupId,
        enabled: true,
        now: BASE_TIME + 2,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-bot-owner',
          invocationContext: 'admin_cli',
        },
      })).toThrowError(expect.objectContaining<GroupSummaryPolicyError>({
        code: 'invalid_input',
      }));
      expect(db.prepare(
        `SELECT state, generation, updated_at
           FROM group_summary_policies WHERE group_id = ?`,
      ).get(groupId)).toEqual({
        state: 'disabled',
        generation: 2,
        updated_at: Number.MAX_SAFE_INTEGER,
      });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM audit_log
          WHERE event_type = 'group.summary_policy_changed'`,
      ).get()).toEqual({ count: 2 });
    }
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('fences exact-group raw ingress that has not produced a chat row yet', () => {
    const groupId = 'qq-group-pending-normalization';
    const rawEventId = insertPendingGroupIngress(
      'pending-normalization',
      groupId,
      BASE_TIME + 2_000,
    );
    insertPendingGroupIngress(
      'pending-normalization-other',
      'qq-group-pending-other',
      BASE_TIME + 5_000,
    );

    const enabled = policies.setEnabled({
      groupId,
      enabled: true,
      now: BASE_TIME,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    expect(enabled.policy).toMatchObject({
      state: 'enabled',
      eligibleAfter: BASE_TIME + 2_001,
    });

    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, 'group', ?, 'user-fixture', 'fixture', ?)`,
    ).run(
      'chat-pending-normalization',
      rawEventId,
      'message-pending-normalization',
      `group:${groupId}`,
      groupId,
      BASE_TIME,
    );
    expect(db.prepare(
      `SELECT COUNT(*) AS count
         FROM raw_events
        WHERE id = ? AND created_at >= ?`,
    ).get(rawEventId, enabled.policy?.eligibleAfter)).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('advances a rollback-clock disable past pending binding timestamps', () => {
    const groupId = 'qq-group-late-binding';
    enable(groupId, BASE_TIME);
    const jobId = enqueueBound(
      'pending-late-binding',
      groupId,
      'group:late-binding',
      BASE_TIME + 1_000,
    );

    const disabled = policies.setEnabled({
      groupId,
      enabled: false,
      now: BASE_TIME + 10,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    expect(disabled).toMatchObject({
      changed: true,
      canceledJobCount: 1,
      policy: {
        state: 'disabled',
        updatedAt: new Date(BASE_TIME + 1_001),
      },
    });
    expect(policies.getBinding(jobId)).toMatchObject({
      canceledAt: new Date(BASE_TIME + 1_001),
      cancellationCode: 'group_summary_policy_disabled',
    });
    expect(jobs.findById(jobId)).toMatchObject({
      status: 'failed',
      completedAt: new Date(BASE_TIME + 1_001),
      updatedAt: new Date(BASE_TIME + 1_001),
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts caller-controlled identifiers from policy audit details', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const groupId = `qq-group-12345-${secret}`;
    const sourceEventId = `raw-qq-67890-${secret}`;
    const result = policies.setEnabled({
      groupId,
      enabled: true,
      now: BASE_TIME,
      authority: {
        kind: 'group_admin',
        actorUserId: 'user-admin',
        invocationContext: 'group_chat',
        currentGroupId: groupId,
        sourceEventId,
      },
    });

    const audit = db.prepare(
      `SELECT details, redacted
         FROM audit_log
        WHERE event_type = 'group.summary_policy_changed' AND event_id = ?`,
    ).get(result.auditId) as { details: string; redacted: number };
    const details = JSON.parse(audit.details) as {
      groupId: string;
      groupIdHash: string;
      sourceEventId: string;
    };
    expect(audit.redacted).toBe(1);
    expect(details.groupId).toContain('[REDACTED:platform_id]');
    expect(details.groupId).toContain('[REDACTED:openai_like_api_key]');
    expect(details.sourceEventId).toContain('[REDACTED:platform_id]');
    expect(details.sourceEventId).toContain('[REDACTED:openai_like_api_key]');
    expect(details.groupId).not.toContain(secret);
    expect(details.sourceEventId).not.toContain(secret);
    expect(details.groupIdHash).toMatch(/^[0-9a-f]{64}$/);

    const otherGroupId = `qq-group-54321-${secret}`;
    const other = policies.setEnabled({
      groupId: otherGroupId,
      enabled: true,
      now: BASE_TIME,
      authority: {
        kind: 'group_admin',
        actorUserId: 'user-admin',
        invocationContext: 'group_chat',
        currentGroupId: otherGroupId,
      },
    });
    const otherAudit = db.prepare(
      `SELECT details FROM audit_log
        WHERE event_type = 'group.summary_policy_changed' AND event_id = ?`,
    ).get(other.auditId) as { details: string };
    const otherDetails = JSON.parse(otherAudit.details) as { groupIdHash: string };
    expect(otherDetails.groupIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(otherDetails.groupIdHash).not.toBe(details.groupIdHash);
    expect(policies.get(groupId)).toMatchObject({ state: 'enabled' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rolls back the policy and cancellation when durable audit insertion fails', () => {
    enable('qq-group-rollback', BASE_TIME);
    const jobId = enqueueBound(
      'pending-rollback',
      'qq-group-rollback',
      'group:rollback',
      BASE_TIME + 1,
    );
    db.exec(
      `CREATE TRIGGER fail_group_summary_policy_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.event_type = 'group.summary_policy_changed'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic policy audit failure');
       END`,
    );

    expect(() => policies.setEnabled({
      groupId: 'qq-group-rollback',
      enabled: false,
      now: BASE_TIME + 2,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    })).toThrow(/synthetic policy audit failure/);

    expect(policies.get('qq-group-rollback')).toMatchObject({
      state: 'enabled',
      generation: 1,
      eligibleAfter: BASE_TIME + 1,
    });
    expect(jobs.findById(jobId)).toMatchObject({ status: 'pending' });
    expect(policies.getBinding(jobId)).not.toHaveProperty('canceledAt');
    expect(policies.getBinding(jobId)).not.toHaveProperty('cancellationCode');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  function enable(groupId: string, now: number): void {
    policies.setEnabled({
      groupId,
      enabled: true,
      now,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
  }

  function enqueueBound(
    id: string,
    groupId: string,
    conversationId: string,
    now: number,
    scheduledAt: number = now,
  ): string {
    const jobId = jobs.enqueue({
      id,
      type: 'summary',
      payload: { conversationId, conversationType: 'group', groupId },
      now,
      scheduledAt,
    });
    policies.bindSummaryJob({ jobId, groupId, conversationId, now });
    return jobId;
  }

  function insertGroupIngress(id: string, groupId: string, createdAt: number): void {
    const rawEventId = `raw-${id}`;
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
       VALUES (?, 'message.group', ?, 'gateway', '{}', ?)`,
    ).run(rawEventId, BASE_TIME, createdAt);
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, 'group', ?, 'user-fixture', 'fixture', ?)`,
    ).run(`chat-${id}`, rawEventId, `message-${id}`, `group:${groupId}`, groupId, BASE_TIME);
  }

  function insertPendingGroupIngress(id: string, groupId: string, createdAt: number): string {
    const rawEventId = `raw-${id}`;
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?)`,
    ).run(
      rawEventId,
      BASE_TIME,
      `group:${groupId}`,
      JSON.stringify({
        message: {
          conversationType: 'group',
          groupId,
        },
      }),
      createdAt,
    );
    return rawEventId;
  }
});
