import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { GovernanceService } from '../../src/governance/service.js';
import { backupSqliteDatabase, restoreSqliteDatabase } from '../../src/operations/sqlite-maintenance.js';
import { AuditRepository } from '../../src/storage/audit-repository.js';
import { initDatabase, runMigrations } from '../../src/storage/database.js';
import { JobRepository } from '../../src/storage/job-repository.js';
import { MemoryMaintenanceProposalRepository } from '../../src/storage/memory-maintenance-proposal-repository.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import { PrivacyPreferenceRepository } from '../../src/storage/privacy-preference-repository.js';
import type { ChatMessageReceived } from '../../src/types/events.js';
import { MemoryImportanceWorker } from '../../src/workers/memory-importance.js';

const DAY = 86_400_000;

describe('DEL-V3 importance proposal governance', () => {
  let root: string;
  let db: Database.Database;
  let now: number;
  let sequence: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-importance-'));
    db = initDatabase({ path: join(root, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    now = Date.now();
    sequence = 0;
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run('importance-owner', now, now);
    db.prepare(`INSERT INTO platform_accounts (platform, platform_account_id, canonical_user_id,
      account_type, verified_level, status, first_seen_at, last_seen_at)
      VALUES ('qq', 'synthetic-owner', 'importance-owner', 'private', 'observed', 'active', ?, ?)`).run(now, now);
  });

  afterEach(() => {
    try {
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    } finally {
      vi.restoreAllMocks();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function source(text: string, ingressAt: number, groupId?: string) {
    const id = `importance-source-${++sequence}`;
    const conversationId = groupId ?? 'importance-private';
    const event: ChatMessageReceived = {
      id, type: 'chat.message.received', timestamp: new Date(ingressAt), source: 'gateway',
      platform: 'qq', conversationId, ingress: { transport: 'http', platformEventId: `message-${id}` },
      message: { messageId: `message-${id}`, conversationId, conversationType: groupId ? 'group' : 'private',
        ...(groupId ? { groupId } : {}), senderId: 'qq-synthetic-owner', content: { text }, mentionsBot: false },
      gatewayCapabilities: { platform: 'qq', reactions: { emojiLike: false, faceMessage: true },
        foldedForward: { groupForward: false, privateForward: false, customNode: false },
        platformAdmin: { kick: false, mute: false, setGroupCard: false } },
    };
    db.prepare(`INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id,
      platform_event_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, event.type, ingressAt, event.source, event.platform, conversationId,
        event.ingress.platformEventId, JSON.stringify(event), ingressAt);
    db.prepare(`INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id,
      conversation_type, group_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`chat-${id}`, id, event.message.messageId, conversationId, event.message.conversationType,
        groupId ?? null, event.message.senderId, text, ingressAt);
    return { rawEventId: id, chatMessageId: `chat-${id}`, conversationId };
  }

  async function seed(groupId?: string, text = 'I like green tea', memoryIds = ['importance-memory']) {
    const first = source(text, now - 6 * DAY, groupId);
    source(text, now - 3 * DAY, groupId);
    const last = source(text, now, groupId);
    for (const id of memoryIds) await new MemoryRepository(db).create({
      id, scope: 'user', canonicalUserId: 'importance-owner',
      conversationId: first.conversationId, groupId, visibility: groupId ? 'same_group_only' : 'private_only',
      sensitivity: 'normal', authority: 'user_stated', kind: 'preference', title: 'Tea preference',
      content: text, state: 'active', importance: 0.4, confidence: 0.9,
      actor: { actorClass: 'admin', context: 'admin_cli' },
      sources: [{ sourceType: 'chat_message', sourceId: first.chatMessageId, sourceTimestamp: now - 6 * DAY }],
    });
    return { first, last };
  }

  function learn(enabled = true) {
    const jobs = new JobRepository(db);
    jobs.enqueue({ type: 'importance', payload: {
      windowEndAt: now, windowEndOrder: db.prepare('SELECT MAX(rowid) FROM raw_events').pluck().get() ?? 0,
    } });
    const claim = jobs.claimNext({ workerId: 'importance-worker', types: ['importance'] });
    assert(claim);
    const worker = new MemoryImportanceWorker(db, enabled);
    const execution = { jobId: claim.job.id, jobAttemptId: claim.attemptId, attemptNumber: claim.attemptNumber, now: Date.now() };
    const result = worker.run(execution);
    expect(jobs.complete({ jobId: claim.job.id, attemptId: claim.attemptId, result })).toBe(true);
    return result;
  }

  function governance(enabled = true, connection = db) {
    return new GovernanceService(connection, undefined, undefined,
      new MemoryMaintenanceProposalRepository(connection, new AuditRepository(connection), {
        importanceApplicationEnabled: enabled,
      }));
  }

  function proposalId(): string {
    const id = db.prepare("SELECT id FROM memory_maintenance_proposals WHERE kind = 'importance'").pluck().get();
    assert(typeof id === 'string');
    return id;
  }

  function request(id = proposalId()) {
    return { authority: { kind: 'local_admin' } as const, proposalId: id, reasonCode: 'operator_review', nowMs: now + 1 };
  }

  function memoryTruth() {
    return ['memory_records', 'memory_sources', 'memory_revisions']
      .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  }

  function optOut() {
    new PrivacyPreferenceRepository(db).setOptOut({ canonicalUserId: 'importance-owner', preferenceType: 'memory_association',
      actor: { actorClass: 'admin', context: 'admin_cli' } });
  }

  function replaceSourceText(rawId: string, text: string) {
    const payload = db.prepare('SELECT payload FROM raw_events WHERE id = ?').pluck().get(rawId) as string;
    const event = JSON.parse(payload) as ChatMessageReceived;
    event.message.content.text = text;
    db.prepare('UPDATE raw_events SET payload = ? WHERE id = ?').run(JSON.stringify(event), rawId);
    db.prepare('UPDATE chat_messages SET text = ? WHERE raw_event_id = ?').run(text, rawId);
  }

  it('increases the versioned score with new days of evidence and caps it without mutating the active preference', async () => {
    await seed();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const before = memoryTruth();
    expect(learn()).toMatchObject({ proposed: 1 });
    now += DAY;
    source('I like green tea', now);
    expect(learn()).toMatchObject({ proposed: 1 });
    for (let day = 0; day < 8; day += 1) {
      now += DAY;
      source('I like green tea', now);
    }
    expect(learn()).toMatchObject({ proposed: 1 });
    expect(db.prepare(`SELECT scorer_version, observation_count, distinct_day_count, span_days, proposed_importance
      FROM memory_importance_scores ORDER BY window_end_at`).all()).toEqual([
      { scorer_version: 1, observation_count: 3, distinct_day_count: 3, span_days: 6, proposed_importance: 0.74 },
      { scorer_version: 1, observation_count: 4, distinct_day_count: 4, span_days: 7, proposed_importance: 0.85 },
      { scorer_version: 1, observation_count: 12, distinct_day_count: 12, span_days: 15, proposed_importance: 0.95 },
    ]);
    expect(memoryTruth()).toEqual(before);
  });

  it.each(['before_start', 'before_commit'])(
    'fences lease expiry %s and recovers the same durable job without partial proposal writes', async (point) => {
      await seed();
      let clock = now;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const jobs = new JobRepository(db);
      const jobId = jobs.enqueue({ type: 'importance', payload: { windowEndAt: now, windowEndOrder: 3 } });
      const claim = jobs.claimNext({ workerId: 'importance-expiring-worker', leaseMs: 1000 });
      assert(claim);
      const execution = { jobId, jobAttemptId: claim.attemptId, attemptNumber: claim.attemptNumber, now };
      if (point === 'before_start') clock += 1000;
      else {
        db.function('expire_importance_lease', () => { clock += 1000; return 1; });
        db.exec(`CREATE TRIGGER expire_importance_lease AFTER INSERT ON memory_importance_scores
          BEGIN SELECT expire_importance_lease(); END`);
      }
      const before = memoryTruth();
      const auditCount = db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get();
      expect(() => new MemoryImportanceWorker(db, true).run(execution)).toThrow('Importance job authority unavailable');
      expect(memoryTruth()).toEqual(before);
      for (const table of ['memory_maintenance_proposals', 'memory_importance_scores', 'memory_importance_sources']) {
        expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
      }
      expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(auditCount);
      db.exec('DROP TRIGGER IF EXISTS expire_importance_lease');
      db.close();
      db = initDatabase({ path: join(root, 'test.db') });
      const recoveredJobs = new JobRepository(db);
      const retry = recoveredJobs.claimNext({ workerId: 'importance-recovered-worker' });
      assert(retry);
      expect([retry.job.id, retry.attemptNumber]).toEqual([jobId, 2]);
      const worker = new MemoryImportanceWorker(db, true);
      expect(() => worker.run(execution)).toThrow('Importance job authority unavailable');
      const result = worker.run({ jobId, jobAttemptId: retry.attemptId, attemptNumber: retry.attemptNumber, now: clock });
      expect(result).toMatchObject({ proposed: 1 });
      expect(recoveredJobs.complete({ jobId, attemptId: retry.attemptId, result })).toBe(true);
      expect(memoryTruth()).toEqual(before);
    },
  );

  it('continues a bounded frozen window after restart and deduplicates a committed batch retried before job completion', async () => {
    await seed(undefined, undefined, Array.from({ length: 21 }, (_, index) => `importance-memory-${String(index).padStart(2, '0')}`));
    let clock = now;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const jobs = new JobRepository(db);
    const payload = { windowEndAt: now, windowEndOrder: 3 };
    const jobId = jobs.enqueue({ type: 'importance', payload });
    const claim = jobs.claimNext({ workerId: 'importance-first-worker' });
    assert(claim);
    clock += 1;
    const before = memoryTruth();
    const result = new MemoryImportanceWorker(db, true).run({
      jobId, jobAttemptId: claim.attemptId, attemptNumber: claim.attemptNumber, now: clock,
    });
    expect(result).toMatchObject({ scanned: 20, proposed: 20 });
    const continuation = db.prepare("SELECT id, payload FROM jobs WHERE status = 'pending'").get() as { id: string; payload: string };
    expect(JSON.parse(continuation.payload)).toEqual({ ...payload, afterMemoryId: 'importance-memory-19' });
    db.close();
    db = initDatabase({ path: join(root, 'test.db') });
    clock += 60_000;
    const recovered = new JobRepository(db);
    const retry = recovered.claimNext({ workerId: 'importance-second-worker' });
    assert(retry);
    expect(retry.job.id).toBe(jobId);
    const worker = new MemoryImportanceWorker(db, true);
    const retried = worker.run({ jobId, jobAttemptId: retry.attemptId, attemptNumber: retry.attemptNumber, now: clock });
    expect(retried).toMatchObject({ scanned: 20, proposed: 0, unchanged: 20 });
    expect(db.prepare('SELECT COUNT(*) FROM jobs').pluck().get()).toBe(2);
    expect(recovered.complete({ jobId, attemptId: retry.attemptId, result: retried })).toBe(true);
    const next = recovered.claimNext({ workerId: 'importance-second-worker' });
    assert(next);
    expect(next.job.id).toBe(continuation.id);
    const final = worker.run({ jobId: next.job.id, jobAttemptId: next.attemptId, attemptNumber: next.attemptNumber, now: clock });
    expect(final).toMatchObject({ scanned: 1, proposed: 1 });
    expect(recovered.complete({ jobId: next.job.id, attemptId: next.attemptId, result: final })).toBe(true);
    expect(recovered.claimNext({ workerId: 'importance-second-worker' })).toBeNull();
    expect(db.prepare('SELECT COUNT(*) FROM memory_maintenance_proposals').pluck().get()).toBe(21);
    expect(db.prepare('SELECT COUNT(*) FROM memory_maintenance_proposal_revisions').pluck().get()).toBe(21);
    expect(memoryTruth()).toEqual(before);
  });

  it.each(['same_day', 'third_party', 'conflicting', 'opted_out', 'deleted_source', 'invalid_raw', 'overflow', 'other_group'])(
    'does not learn from %s evidence', async (scenario) => {
      const { last } = await seed();
      if (scenario === 'same_day') db.prepare('UPDATE raw_events SET created_at = ?').run(now);
      if (scenario === 'third_party') replaceSourceText(last.rawEventId, 'Someone said I like green tea');
      if (scenario === 'conflicting') source('I do not like green tea', now);
      if (scenario === 'opted_out') optOut();
      if (scenario === 'deleted_source' || scenario === 'other_group') {
        db.prepare('DELETE FROM chat_messages WHERE id = ?').run(last.chatMessageId);
        if (scenario === 'other_group') source('I like green tea', now, 'importance-group');
      }
      if (scenario === 'invalid_raw') db.prepare("UPDATE raw_events SET payload = '{}' WHERE id = ?").run(last.rawEventId);
      if (scenario === 'overflow') for (let i = 0; i < 198; i += 1) source('Unrelated synthetic context', now);
      const before = memoryTruth();
      expect(learn()).toMatchObject({ proposed: 0, skipped: 1 });
      expect(memoryTruth()).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) FROM memory_maintenance_proposals').pluck().get()).toBe(0);
    },
  );

  it.each(['deleted_source', 'revoked_account', 'opted_out', 'new_revision', 'expired_proposal', 'expired_memory', 'late_conflict', 'changed_score'])(
    'revalidates %s after approval with no partial effects', async (scenario) => {
      const { last } = await seed();
      learn();
      const input = request();
      const service = governance();
      expect(service.reviewMemoryMaintenanceProposal({ ...input, expectedState: 'pending_review',
        expectedRevisionNumber: 1, transition: 'approve' }).outcome).toBe('transitioned');
      if (scenario === 'deleted_source') {
        db.prepare('DELETE FROM chat_messages WHERE id = ?').run(last.chatMessageId);
        db.prepare('DELETE FROM raw_events WHERE id = ?').run(last.rawEventId);
        expect(db.prepare('SELECT source_raw_event_id, raw_event_id, chat_message_id FROM memory_importance_sources WHERE source_ordinal = 2').get())
          .toEqual({ source_raw_event_id: last.rawEventId, raw_event_id: null, chat_message_id: null });
      }
      if (scenario === 'revoked_account') db.exec("UPDATE platform_accounts SET status = 'disabled'");
      if (scenario === 'opted_out') optOut();
      if (scenario === 'new_revision') db.exec(`INSERT INTO memory_revisions (id, memory_id, revision_number, change_type,
        new_state, actor, created_at) SELECT 'competing-revision', memory_id, 2, 'update', new_state, actor, created_at FROM memory_revisions`);
      if (scenario === 'expired_proposal') input.nowMs = now + 7 * DAY;
      if (scenario === 'expired_memory') db.prepare('UPDATE memory_records SET expires_at = ?').run(now);
      if (scenario === 'late_conflict') source('I do not like green tea', now - 4 * DAY);
      if (scenario === 'changed_score') db.exec('UPDATE memory_importance_scores SET proposed_importance = 0.95');
      const before = memoryTruth();
      const changes = db.prepare('SELECT total_changes()').pluck().get();
      expect(service.applyMemoryMaintenanceProposal({ ...input, expectedState: 'approved', expectedRevisionNumber: 2 }).outcome).toBe('stale');
      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes);
      expect(memoryTruth()).toEqual(before);
      expect(db.prepare('SELECT lifecycle_state FROM memory_maintenance_proposals').pluck().get()).toBe('approved');
    },
  );

  it('keeps learning/application controls independent and preserves rejected/expired review history', async () => {
    await seed();
    const before = memoryTruth();
    expect(learn(false)).toMatchObject({ status: 'disabled', proposed: 0 });
    expect(learn()).toMatchObject({ proposed: 1 });
    const input = request();
    const approve = { ...input, expectedState: 'pending_review' as const, expectedRevisionNumber: 1, transition: 'approve' as const };
    expect(governance(false).reviewMemoryMaintenanceProposal(approve).outcome).toBe('transitioned');
    expect(governance(false).applyMemoryMaintenanceProposal({ ...input, expectedState: 'approved', expectedRevisionNumber: 2 }).outcome).toBe('stale');
    const expire = { ...input, expectedState: 'approved' as const, expectedRevisionNumber: 2, transition: 'expire' as const };
    expect(governance().reviewMemoryMaintenanceProposal(expire).outcome).toBe('transitioned');
    expect(governance().reviewMemoryMaintenanceProposal(expire).outcome).toBe('unchanged');
    expect(learn()).toMatchObject({ proposed: 0, unchanged: 1 });
    expect(memoryTruth()).toEqual(before);
  });

  it('has one review winner across connections, with exact group authority and stable rejection on retry', async () => {
    await seed('qq-group-83333', '\u6211\u559c\u6b22\u7eff\u8336');
    learn();
    const id = proposalId();
    const other = initDatabase({ path: join(root, 'test.db') });
    try {
      const authority = { kind: 'user' as const, canonicalUserId: 'importance-owner',
        invocationContext: 'group_chat' as const, groupId: 'qq-group-83333', conversationId: 'qq-group-83333' };
      expect(governance().getMemoryMaintenanceProposal({ proposalId: id, authority })?.proposalId).toBe(id);
      expect(governance().getMemoryMaintenanceProposal({ proposalId: id, authority: { ...authority,
        groupId: 'qq-group-85555', conversationId: 'qq-group-85555' } })).toBeNull();
      expect(governance().getMemoryMaintenanceProposal({ proposalId: id,
        authority: { ...authority, canonicalUserId: 'another-user' } })).toBeNull();
      const review = { ...request(id), expectedState: 'pending_review' as const, expectedRevisionNumber: 1 };
      const rejected = governance().reviewMemoryMaintenanceProposal({ ...review, transition: 'reject' });
      const competing = governance(true, other).reviewMemoryMaintenanceProposal({ ...review, transition: 'approve' });
      expect([rejected.outcome, competing.outcome]).toEqual(['transitioned', 'stale']);
      expect(governance(true, other).reviewMemoryMaintenanceProposal({ ...review, transition: 'reject' }).outcome).toBe('unchanged');
      expect(learn()).toMatchObject({ proposed: 0, unchanged: 1 });
      expect(db.prepare('SELECT COUNT(*) FROM memory_maintenance_proposal_revisions').pluck().get()).toBe(2);
      expect(db.prepare('SELECT importance, visibility FROM memory_records').get()).toEqual({ importance: 0.4, visibility: 'same_group_only' });
    } finally { other.close(); }
  });

  it('rolls source-insert and effect-link failures back with all score, memory and audit writes', async () => {
    await seed();
    const original = memoryTruth();
    const auditCount = db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get();
    db.exec(`CREATE TRIGGER reject_importance_source BEFORE INSERT ON memory_importance_sources
      BEGIN SELECT RAISE(ABORT, 'synthetic source failure'); END`);
    expect(() => learn()).toThrow('synthetic source failure');
    expect(db.prepare('SELECT COUNT(*) FROM memory_maintenance_proposals').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM memory_importance_scores').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(auditCount);
    expect(memoryTruth()).toEqual(original);
    db.exec('DROP TRIGGER reject_importance_source');
    learn();
    const input = request();
    governance().reviewMemoryMaintenanceProposal({ ...input, expectedState: 'pending_review', expectedRevisionNumber: 1, transition: 'approve' });
    const before = memoryTruth();
    db.exec(`CREATE TRIGGER reject_importance_effect BEFORE INSERT ON memory_maintenance_proposal_revision_effects
      BEGIN SELECT RAISE(ABORT, 'synthetic effect failure'); END`);
    expect(() => governance().applyMemoryMaintenanceProposal({ ...input, expectedState: 'approved', expectedRevisionNumber: 2 }))
      .toThrow('synthetic effect failure');
    expect(memoryTruth()).toEqual(before);
    expect(db.prepare('SELECT lifecycle_state FROM memory_maintenance_proposals').pluck().get()).toBe('approved');
  });

  it('freezes explainable sources without changing memory and governs apply, backup/restore, retry and rollback', async () => {
    await seed();
    const before = memoryTruth();
    expect(learn()).toMatchObject({ proposed: 1 });
    const id = proposalId();
    const service = governance();
    const proposal = service.getMemoryMaintenanceProposal(request(id));
    expect(proposal).toMatchObject({ kind: 'importance', lifecycleState: 'pending_review',
      reasonCodes: ['repeated_first_party_evidence'], expiresAt: now + 7 * DAY,
      importance: { scorerVersion: 1, observationCount: 3, distinctDayCount: 3, spanDays: 6,
        previousImportance: 0.4, proposedImportance: 0.74, sourceCount: 3 } });
    expect(db.prepare('SELECT source_raw_event_id FROM memory_importance_sources ORDER BY source_ordinal').pluck().all())
      .toEqual(['importance-source-1', 'importance-source-2', 'importance-source-3']);
    expect(memoryTruth()).toEqual(before);
    expect(learn()).toMatchObject({ proposed: 0, unchanged: 1 });
    const approval = { ...request(id), expectedState: 'pending_review' as const, expectedRevisionNumber: 1, transition: 'approve' as const };
    expect(service.reviewMemoryMaintenanceProposal(approval).outcome).toBe('transitioned');
    expect(memoryTruth()).toEqual(before);
    const apply = { ...request(id), expectedState: 'approved' as const, expectedRevisionNumber: 2 };
    expect(service.applyMemoryMaintenanceProposal(apply).outcome).toBe('transitioned');
    expect(db.prepare('SELECT importance FROM memory_records').pluck().get()).toBe(0.74);
    const evidenceTables = ['memory_importance_scores', 'memory_importance_sources', 'memory_maintenance_proposals',
      'memory_maintenance_proposal_revisions', 'memory_maintenance_proposal_revision_effects', 'audit_log'];
    const evidence = evidenceTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const backupPath = join(root, 'importance.backup.db');
    expect(await backupSqliteDatabase({ sourcePath: join(root, 'test.db'), backupPath })).toMatchObject({ integrityOk: true });
    db.close();
    const restoredPath = join(root, 'importance.restored.db');
    expect(restoreSqliteDatabase({ backupPath, targetPath: restoredPath })).toMatchObject({ integrityOk: true, foreignKeyViolations: 0 });
    db = initDatabase({ path: restoredPath });
    expect(evidenceTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(evidence);
    const applied = memoryTruth();
    expect(governance().applyMemoryMaintenanceProposal(apply).outcome).toBe('unchanged');
    expect(memoryTruth()).toEqual(applied);
    const rollback = { ...request(id), expectedState: 'applied' as const, expectedRevisionNumber: 3 };
    expect(governance(false).rollbackMemoryMaintenanceProposal(rollback).outcome).toBe('transitioned');
    expect(governance().rollbackMemoryMaintenanceProposal(rollback).outcome).toBe('unchanged');
    expect(db.prepare('SELECT importance, state, visibility, content FROM memory_records').get())
      .toEqual({ importance: 0.4, state: 'active', visibility: 'private_only', content: 'I like green tea' });
    expect(db.prepare('SELECT change_type FROM memory_revisions ORDER BY revision_number').pluck().all())
      .toEqual(['create', 'update', 'restore']);
    expect(db.prepare('SELECT transition FROM memory_maintenance_proposal_revisions ORDER BY revision_number').pluck().all())
      .toEqual(['propose', 'approve', 'apply', 'rollback']);
  });
});
