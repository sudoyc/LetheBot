import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { GovernanceCLI } from '../../src/cli/governance.js';
import { ContextBuilder } from '../../src/context/builder.js';
import { EvaluatorStub } from '../../src/evaluator/evaluator-stub.js';
import { ModelEvaluator } from '../../src/evaluator/model-evaluator.js';
import { GovernanceService } from '../../src/governance/service.js';
import { MemoryProposalService } from '../../src/memory/proposal-service.js';
import { AuditRepository } from '../../src/storage/audit-repository.js';
import { initDatabase, runMigrations } from '../../src/storage/database.js';
import { EvaluatorDecisionRepository } from '../../src/storage/evaluator-decision-repository.js';
import { IdentityRepository } from '../../src/storage/identity-repository.js';
import { JobRepository } from '../../src/storage/job-repository.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import { ModelInvocationRepository } from '../../src/storage/model-invocation-repository.js';
import { PrivacyPreferenceRepository } from '../../src/storage/privacy-preference-repository.js';
import { MemoryExtractionWorker } from '../../src/workers/memory-extraction.js';
import { MemoryConflictWorker } from '../../src/workers/memory-conflict.js';

describe('DEL-V1 explicit procedure teaching', () => {
  let directory: string;
  let db: Database.Database;
  let memories: MemoryRepository;
  let jobs: JobRepository;
  let worker: MemoryExtractionWorker;
  let governance: GovernanceCLI;
  let context: ContextBuilder;
  let evaluator: EvaluatorStub;
  let sequence: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'lethebot-procedures-'));
    db = initDatabase({ path: join(directory, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    memories = new MemoryRepository(db);
    jobs = new JobRepository(db);
    evaluator = new EvaluatorStub();
    vi.spyOn(evaluator, 'evaluateMemory');
    worker = new MemoryExtractionWorker(db, memories, undefined, new MemoryProposalService(memories, {
      evaluator,
      evaluatorDecisionWriter: new EvaluatorDecisionRepository(db),
      auditRepository: new AuditRepository(db),
      privacyPreferences: new PrivacyPreferenceRepository(db),
    }));
    governance = new GovernanceCLI(memories, { db });
    context = new ContextBuilder(db, memories, new IdentityRepository(db));
    sequence = 0;
  });

  afterEach(() => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    db.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function source(text: string, userId: string, groupId?: string, conversation = 'teaching') {
    const id = `procedure-source-${++sequence}`;
    const rawEventId = `raw-${id}`;
    const timestamp = Date.now();
    const conversationId = `${conversation}:${groupId ?? userId}`;
    const conversationType = groupId ? 'group' : 'private';
    db.prepare('INSERT OR IGNORE INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run(userId, timestamp, timestamp);
    db.prepare(`INSERT OR IGNORE INTO platform_accounts (
      platform, platform_account_id, canonical_user_id, account_type, verified_level,
      status, first_seen_at, last_seen_at
    ) VALUES ('qq', ?, ?, 'private', 'observed', 'active', ?, ?)`)
      .run(userId, userId, timestamp, timestamp);
    db.prepare(`INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, '{}', ?)`)
      .run(rawEventId, timestamp, conversationId, timestamp);
    db.prepare(`INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id, conversation_type, group_id, sender_id, text, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, rawEventId, id, conversationId, conversationType, groupId ?? null, `qq-${userId}`, text, timestamp);
    return { id, rawEventId, conversationId, conversationType, timestamp } as const;
  }

  async function recall(userId: string, groupId?: string) {
    const message = source('Summarize files using the procedure.', userId, groupId, 'recall');
    const turnId = `turn-${message.id}`;
    db.prepare(`INSERT INTO agent_turns (
      id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
    ) VALUES (?, ?, ?, 'mock', 'mock', 'running', ?)`)
      .run(turnId, message.conversationId, message.rawEventId, message.timestamp);
    return context.buildContext({
      turnId,
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      targetUserId: userId,
      groupId,
      currentMessageId: message.id,
    });
  }

  function extraction(messageId: string) {
    const payload = { sourceChatMessageId: messageId, targetUserId: 'procedure-owner' };
    const jobId = jobs.enqueue({ type: 'extraction', payload, maxAttempts: 3 });
    const attempt = jobs.claimNext({ workerId: 'procedure-worker', types: ['extraction'] });
    assert(attempt);
    return { jobId, attemptId: attempt.attemptId, payload };
  }

  function reopen() {
    db.close();
    db = initDatabase({ path: join(directory, 'test.db') });
    memories = new MemoryRepository(db);
    jobs = new JobRepository(db);
    governance = new GovernanceCLI(memories, { db });
    context = new ContextBuilder(db, memories, new IdentityRepository(db));
    worker = new MemoryExtractionWorker(db, memories, undefined, new MemoryProposalService(memories, {
      evaluator, evaluatorDecisionWriter: new EvaluatorDecisionRepository(db),
      auditRepository: new AuditRepository(db), privacyPreferences: new PrivacyPreferenceRepository(db),
    }));
  }

  it('preserves a rejected teaching across restart and retry until an explicit restore', async () => {
    const message = source('Remember this procedure: summarize files with conclusions, then risks.',
      'procedure-owner', 'synthetic-group');
    const task = extraction(message.id);
    const result = await worker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId });
    const memoryId = result.memoryIds[0];
    assert(memoryId);
    expect(await governance.rejectMemory(memoryId)).toMatchObject({ success: true });
    expect(jobs.fail({ ...task, error: 'synthetic interruption after commit' })).toBe(true);
    reopen();
    const retry = jobs.claimNext({ workerId: 'procedure-worker', types: ['extraction'] });
    assert(retry);
    expect(await worker.extractFromChatMessage({ ...task.payload, jobAttemptId: retry.attemptId }))
      .toMatchObject({ memoryIds: [memoryId] });
    expect(await memories.findById(memoryId)).toMatchObject({ state: 'rejected' });
    expect((await recall('procedure-owner', 'synthetic-group')).memory.selectedMemoryIds).not.toContain(memoryId);
    expect(await governance.approveMemory(memoryId)).toMatchObject({ success: false });
    expect(db.prepare('SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?').pluck().get(memoryId)).toBe(2);
    expect(evaluator.evaluateMemory).toHaveBeenCalledTimes(1);
    expect(await governance.restoreMemory(memoryId)).toMatchObject({ success: true });
    expect((await recall('procedure-owner', 'synthetic-group')).memory.selectedMemoryIds).toContain(memoryId);
  });

  it('reviews, replaces and rolls back a revised procedure without losing either teaching source', async () => {
    const prefix = `Remember this procedure: summarize files using ${'the documented format '.repeat(6)}`;
    const ids: string[] = [];
    const sources: string[] = [];
    for (const ending of ['conclusions then risks.', 'risks then conclusions.']) {
      const message = source(prefix + ending, 'procedure-owner');
      sources.push(message.id);
      const task = extraction(message.id);
      const result = await worker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId });
      const memoryId = result.memoryIds[0];
      assert(memoryId);
      ids.push(memoryId);
      jobs.complete({ ...task, result });
    }
    const originalId = ids[0];
    const replacementId = ids[1];
    assert(originalId && replacementId);
    const scan = await new MemoryConflictWorker(db, new AuditRepository(db)).detect({ jobId: 'procedure-revision-scan' });
    const proposalId = scan.proposals[0]?.proposalId;
    assert(proposalId);
    let service = new GovernanceService(db, memories);
    const authority = { kind: 'local_admin' as const };
    const review = {
      authority, proposalId, expectedState: 'pending_review' as const, expectedRevisionNumber: 1,
      transition: 'approve' as const, reasonCode: 'procedure_revision_review',
    };
    expect(service.reviewMemoryMaintenanceProposal({
      ...review,
      authority: { kind: 'user', canonicalUserId: 'another-owner', invocationContext: 'private_chat', conversationId: 'another-thread' },
    })).toEqual({ outcome: 'not_found_or_denied' });
    expect(service.reviewMemoryMaintenanceProposal(review)).toMatchObject({ outcome: 'transitioned' });
    const apply = {
      authority, proposalId, expectedState: 'approved' as const, expectedRevisionNumber: 2,
      retainedMemoryId: replacementId, reasonCode: 'procedure_revision_apply',
    };
    expect(service.applyMemoryMaintenanceProposal(apply)).toMatchObject({ outcome: 'transitioned' });
    expect((await recall('procedure-owner')).memory.selectedMemoryIds).toEqual([replacementId]);
    expect(await memories.findById(originalId)).toMatchObject({ state: 'superseded', content: prefix + 'conclusions then risks.' });
    reopen();
    service = new GovernanceService(db, memories);
    expect(service.applyMemoryMaintenanceProposal(apply)).toMatchObject({ outcome: 'unchanged' });
    const rollback = {
      authority, proposalId, expectedState: 'applied' as const, expectedRevisionNumber: 3,
      reasonCode: 'procedure_revision_rollback',
    };
    expect(service.rollbackMemoryMaintenanceProposal(rollback)).toMatchObject({ outcome: 'transitioned' });
    expect(service.rollbackMemoryMaintenanceProposal(rollback)).toMatchObject({ outcome: 'unchanged' });
    expect(await governance.disableMemory(replacementId)).toMatchObject({ success: true });
    expect((await recall('procedure-owner')).memory.selectedMemoryIds).toEqual([originalId]);
    expect(db.prepare('SELECT source_id FROM memory_sources ORDER BY rowid').pluck().all()).toEqual(sources);
    expect(db.prepare('SELECT COUNT(*) FROM memory_records').pluck().get()).toBe(2);
    expect(db.prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number')
      .pluck().all(originalId)).toEqual(['create', 'supersede', 'restore']);
  });

  it('excludes an expired governed procedure from repository, FTS and context after reopen', async () => {
    const message = source('Remember this procedure: summarize syntheticfiles with conclusions, then risks.', 'procedure-owner');
    const expiry = Date.now() + 60_000;
    const memoryId = await memories.create({
      scope: 'user', canonicalUserId: 'procedure-owner', conversationId: message.conversationId,
      kind: 'procedure', title: 'Synthetic procedure', content: 'Summarize syntheticfiles with conclusions, then risks.',
      state: 'active', visibility: 'private_only', sensitivity: 'normal', authority: 'user_stated',
      confidence: 0.9, importance: 0.7, sourceContext: 'admin_cli', expiresAt: new Date(expiry),
      actor: { actorClass: 'admin', context: 'admin_cli' },
      sources: [{ sourceType: 'chat_message', sourceId: message.id, sourceTimestamp: message.timestamp, extractedBy: 'user' }],
    });
    expect((await recall('procedure-owner')).memory.selectedMemoryIds).toContain(memoryId);
    reopen();
    vi.spyOn(Date, 'now').mockReturnValue(expiry);
    expect(await memories.retrieve({ canonicalUserId: 'procedure-owner', contextType: 'private' })).toEqual([]);
    expect(await memories.search('syntheticfiles', { canonicalUserId: 'procedure-owner', contextType: 'private' })).toEqual([]);
    expect((await recall('procedure-owner')).memory.selectedMemoryIds).not.toContain(memoryId);
    expect(await governance.showMemory(memoryId)).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?').pluck().get(memoryId)).toBe(1);
  });

  it.each([
    { procedureWritesEnabled: false, procedureRetrievalEnabled: true },
    { procedureWritesEnabled: true, procedureRetrievalEnabled: false },
  ])('independently rolls back procedure writing and retrieval: %j', async (controls) => {
    const teaching = source(`Remember this procedure: summarize ${'syntheticfiles '.repeat(35)}with conclusions, then risks.`, 'procedure-owner');
    const task = extraction(teaching.id);
    const result = await worker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId });
    const memoryId = result.memoryIds[0];
    assert(memoryId);
    jobs.complete({ ...task, result });
    const fact = source('我喜欢 syntheticfiles', 'procedure-owner');
    const factTask = extraction(fact.id);
    const factResult = await worker.extractFromChatMessage({ ...factTask.payload, jobAttemptId: factTask.attemptId });
    const factId = factResult.memoryIds[0];
    assert(factId);
    jobs.complete({ ...factTask, result: factResult });
    const controlsRepo = new MemoryRepository(db, controls);
    context = new ContextBuilder(db, controlsRepo, new IdentityRepository(db));
    const filters = { canonicalUserId: 'procedure-owner', contextType: 'private' as const, limit: 1 };
    expect((await memories.retrieve(filters))[0]?.id).toBe(memoryId);
    expect((await memories.search('syntheticfiles', filters))[0]?.id).toBe(memoryId);
    expect((await controlsRepo.retrieve(filters))[0]?.id)
      .toBe(controls.procedureRetrievalEnabled ? memoryId : factId);
    expect((await controlsRepo.search('syntheticfiles', filters))[0]?.id)
      .toBe(controls.procedureRetrievalEnabled ? memoryId : factId);
    const recalled = await recall('procedure-owner');
    expect(recalled.memory.selectedMemoryIds.includes(memoryId)).toBe(controls.procedureRetrievalEnabled);
    if (!controls.procedureRetrievalEnabled) {
      expect(recalled.trace?.filtersApplied).toContain('procedure_retrieval=disabled');
    }

    const next = source('Remember this procedure: summarize reports with conclusions, then risks.', 'procedure-owner');
    const nextTask = extraction(next.id);
    vi.mocked(evaluator.evaluateMemory).mockClear();
    const controlledWorker = new MemoryExtractionWorker(db, controlsRepo, undefined, new MemoryProposalService(controlsRepo, {
      evaluator, evaluatorDecisionWriter: new EvaluatorDecisionRepository(db),
      auditRepository: new AuditRepository(db), privacyPreferences: new PrivacyPreferenceRepository(db),
    }));
    const nextResult = await controlledWorker.extractFromChatMessage({ ...nextTask.payload, jobAttemptId: nextTask.attemptId });
    expect(nextResult.count).toBe(controls.procedureWritesEnabled ? 1 : 0);
    expect(evaluator.evaluateMemory).toHaveBeenCalledTimes(controls.procedureWritesEnabled ? 1 : 0);
    const stored = await memories.findById(memoryId);
    assert(stored);
    if (!controls.procedureWritesEnabled) {
      await expect(controlsRepo.create({ ...stored, id: 'blocked-procedure' })).rejects.toThrow('Procedure writes are disabled');
    }
    const controlledGovernance = new GovernanceCLI(controlsRepo, { db });
    expect(await controlledGovernance.showMemory(memoryId)).not.toBeNull();
    expect(await controlledGovernance.deleteMemory(memoryId)).toMatchObject({ success: true });
    expect(await controlledGovernance.restoreMemory(memoryId)).toMatchObject({ success: true });
    context = new ContextBuilder(db, new MemoryRepository(db), new IdentityRepository(db));
    expect((await recall('procedure-owner')).memory.selectedMemoryIds).toContain(memoryId);
    expect(db.prepare('SELECT source_id FROM memory_sources WHERE memory_id = ?').all(memoryId))
      .toEqual([{ source_id: teaching.id }]);
  });

  it('can learn after writes resume and keeps the stable workflow tombstone thereafter', async () => {
    const text = '帮我总结文件：先列结论，再列风险。';
    source(text, 'procedure-owner');
    source(text, 'procedure-owner');
    const third = source(text, 'procedure-owner');
    const skipped = extraction(third.id);
    const disabledWorker = new MemoryExtractionWorker(db, new MemoryRepository(db, { procedureWritesEnabled: false }));
    expect(await disabledWorker.extractFromChatMessage({ ...skipped.payload, jobAttemptId: skipped.attemptId }))
      .toMatchObject({ count: 0 });
    jobs.complete({ ...skipped });
    const fourth = source(text, 'procedure-owner');
    const resumed = extraction(fourth.id);
    const result = await worker.extractFromChatMessage({ ...resumed.payload, jobAttemptId: resumed.attemptId });
    expect(result.count).toBe(1);
    const memoryId = result.memoryIds[0];
    assert(memoryId);
    jobs.complete({ ...resumed, result });
    expect(await governance.deleteMemory(memoryId)).toMatchObject({ success: true });
    const fifth = source(text, 'procedure-owner');
    const later = extraction(fifth.id);
    expect(await worker.extractFromChatMessage({ ...later.payload, jobAttemptId: later.attemptId }))
      .toMatchObject({ memoryIds: [memoryId] });
    expect(await memories.findById(memoryId)).toMatchObject({ state: 'deleted' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 1 });
    expect(evaluator.evaluateMemory).toHaveBeenCalledTimes(1);
  });

  it('converges overlapping repetition jobs onto one immutable candidate', async () => {
    const text = '帮我总结文件：先列结论，再列风险。';
    source(text, 'procedure-owner');
    source(text, 'procedure-owner');
    const third = source(text, 'procedure-owner');
    const fourth = source(text, 'procedure-owner');
    const left = extraction(third.id);
    const right = extraction(fourth.id);
    const results = await Promise.all([left, right].map((task) =>
      worker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId })));
    expect(results[0]?.count).toBe(1);
    expect(results[1]?.memoryIds).toEqual(results[0]?.memoryIds);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 3 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get()).toEqual({ count: 1 });
  });

  it.each([undefined, 'synthetic-group'])('requires three exact scoped events and never relearns a deleted workflow in group %s', async (groupId) => {
    const text = '帮我总结文件：先列结论，再列风险。';
    source(text, 'another-owner', groupId);
    source(text, 'procedure-owner', 'another-group');
    source('帮我总结文件：先列风险，再列结论。', 'procedure-owner', groupId);
    const first = source(text, 'procedure-owner', groupId, 'teaching-one');
    const second = source(text, 'procedure-owner', groupId, 'teaching-two');
    const third = source(text, 'procedure-owner', groupId, 'teaching-three');
    for (const message of [first, second]) {
      const task = extraction(message.id);
      for (let replay = 0; replay < 2; replay++) {
        expect(await worker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId }))
          .toMatchObject({ count: 0 });
      }
      jobs.complete({ ...task });
    }
    expect(evaluator.evaluateMemory).not.toHaveBeenCalled();
    const task = extraction(third.id);
    const result = await worker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId });
    expect(result).toMatchObject({ count: 1 });
    const memoryId = result.memoryIds[0];
    assert(memoryId);
    expect(await memories.findById(memoryId)).toMatchObject({
      kind: 'procedure', content: text, state: 'proposed', authority: 'inferred',
      scope: 'user', canonicalUserId: 'procedure-owner',
      visibility: groupId ? 'same_group_only' : 'private_only',
    });
    const sourceIds = [first.id, second.id, third.id];
    expect(db.prepare('SELECT source_id FROM memory_sources WHERE memory_id = ? ORDER BY rowid').all(memoryId))
      .toEqual(sourceIds.map((source_id) => ({ source_id })));
    expect(evaluator.evaluateMemory).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventIds: [first.rawEventId, second.rawEventId, third.rawEventId], jobAttemptId: task.attemptId,
    }));
    expect((await recall('procedure-owner', groupId)).memory.selectedMemoryIds).not.toContain(memoryId);
    expect(await governance.approveMemory(memoryId)).toMatchObject({ success: true });
    expect((await recall('procedure-owner', groupId)).memory.selectedMemoryIds).toContain(memoryId);
    expect(await governance.deleteMemory(memoryId)).toMatchObject({ success: true });
    jobs.fail({ ...task, error: 'synthetic completion failure' });
    const retry = jobs.claimNext({ workerId: 'procedure-worker', types: ['extraction'] });
    assert(retry);
    expect(await worker.extractFromChatMessage({ ...task.payload, jobAttemptId: retry.attemptId }))
      .toMatchObject({ memoryIds: [memoryId] });
    jobs.complete({ jobId: task.jobId, attemptId: retry.attemptId });
    const fourth = source(text, 'procedure-owner', groupId, 'teaching-four');
    const laterTask = extraction(fourth.id);
    expect(await worker.extractFromChatMessage({ ...laterTask.payload, jobAttemptId: laterTask.attemptId }))
      .toMatchObject({ memoryIds: [memoryId] });
    expect(evaluator.evaluateMemory).toHaveBeenCalledTimes(1);
    expect(await memories.findById(memoryId)).toMatchObject({ state: 'deleted' });
    expect((await recall('procedure-owner', groupId)).memory.selectedMemoryIds).not.toContain(memoryId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 1 });
  });

  it('binds all repeated sources through the model invocation ledger with a synthetic completion client', async () => {
    const text = '帮我总结文件：先列结论，再列风险。';
    const messages = Array.from({ length: 3 }, () => source(text, 'procedure-owner'));
    const third = messages.at(-1);
    assert(third);
    const task = extraction(third.id);
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        domain: 'memory', decision: 'approve', confidence: 0.95, riskLevel: 'high',
        reason: 'Repeated scoped evidence requires review', recommendedState: 'proposed',
      }),
      tokens: { input: 20, output: 10, total: 30 },
    }));
    const modelEvaluator = new ModelEvaluator({
      provider: 'synthetic', model: 'synthetic', timeoutMs: 1000, maxRetries: 0,
      temperature: 0, promptVersion: 'procedure-test-v1',
    }, { complete }, new ModelInvocationRepository(db));
    const modelWorker = new MemoryExtractionWorker(db, memories, undefined, new MemoryProposalService(memories, {
      evaluator: modelEvaluator,
      evaluatorDecisionWriter: new EvaluatorDecisionRepository(db),
      auditRepository: new AuditRepository(db),
      privacyPreferences: new PrivacyPreferenceRepository(db),
    }));
    expect(await modelWorker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId }))
      .toMatchObject({ count: 1 });
    expect(complete).toHaveBeenCalledTimes(1);
    const invocation = db.prepare(`SELECT invocation.status, invocation.job_attempt_id
      FROM evaluator_decisions decision JOIN model_invocations invocation ON invocation.id = decision.model_invocation_id`).get();
    expect(invocation).toEqual({ status: 'completed', job_attempt_id: task.attemptId });
    expect(db.prepare('SELECT raw_event_id FROM model_invocation_sources ORDER BY source_ordinal').all())
      .toEqual(messages.map((message) => ({ raw_event_id: message.rawEventId })));
  });

  it.each(['duplicate_evidence', 'source_mutated_in_effect'])('rolls back invalid repeated procedure effects: %s', async (failure) => {
    const text = '帮我总结文件：先列结论，再列风险。';
    const first = source(text, 'procedure-owner');
    source(text, 'procedure-owner');
    const third = source(text, 'procedure-owner');
    const task = extraction(third.id);
    if (failure === 'duplicate_evidence') {
      vi.mocked(evaluator.evaluateMemory).mockImplementationOnce(async (request) => {
        request.sourceEventIds[1] = request.sourceEventIds[0] ?? '';
        return new EvaluatorStub().evaluateMemory(request);
      });
    } else {
      db.exec(`CREATE TEMP TRIGGER mutate_procedure_source AFTER INSERT ON memory_records
        WHEN NEW.kind = 'procedure' BEGIN UPDATE chat_messages SET text = 'Changed source'; END`);
    }
    await expect(worker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId }))
      .rejects.toThrow('Transient memory extraction');
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT text FROM chat_messages WHERE id = ?').get(first.id)).toEqual({ text });
  });

  it.each([1, 3])('does not widen procedure visibility when the evaluator recommends public activation (%s sources)', async (count) => {
    const text = count === 1 ? 'Remember this procedure: summarize files.' : '帮我总结文件：先列结论，再列风险。';
    const messages = Array.from({ length: count }, () => source(text, 'procedure-owner'));
    const message = messages.at(-1);
    assert(message);
    const task = extraction(message.id);
    vi.mocked(evaluator.evaluateMemory).mockImplementationOnce(async (request) => ({
      ...await new EvaluatorStub().evaluateMemory(request),
      decision: 'approve', confidence: 1, riskLevel: 'low',
      recommendedState: 'active', recommendedVisibility: 'public',
    }));
    const result = await worker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId });
    const memoryId = result.memoryIds[0];
    assert(memoryId);
    expect(await memories.findById(memoryId)).toMatchObject({
      state: count === 1 ? 'active' : 'proposed', visibility: 'private_only',
    });
  });

  it('revalidates all repeated sources in the evaluator/effect transaction', async () => {
    const text = '帮我总结文件：先列结论，再列风险。';
    const first = source(text, 'procedure-owner');
    source(text, 'procedure-owner');
    const third = source(text, 'procedure-owner');
    const task = extraction(third.id);
    vi.mocked(evaluator.evaluateMemory).mockImplementationOnce(async (request) => {
      const decision = await new EvaluatorStub().evaluateMemory(request);
      db.prepare('UPDATE chat_messages SET text = ? WHERE id = ?').run('Changed source', first.id);
      return decision;
    });
    await expect(worker.extractFromChatMessage({ ...task.payload, jobAttemptId: task.attemptId }))
      .rejects.toThrow('Transient memory extraction');
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
  });

  it.each([undefined, 'synthetic-group'])('governs teaching, recall and retry in group %s', async (groupId) => {
    const content = 'Remember this procedure: summarize files with conclusions, then risks.';
    const message = source(content, 'procedure-owner', groupId);
    const payload = { sourceChatMessageId: message.id, targetUserId: 'procedure-owner' };
    const jobId = jobs.enqueue({ type: 'extraction', payload, maxAttempts: 3 });
    const attempt = jobs.claimNext({ workerId: 'procedure-worker', types: ['extraction'] });
    assert(attempt);
    const result = await worker.extractFromChatMessage({ ...payload, jobAttemptId: attempt.attemptId });
    expect(result).toMatchObject({ matched: true, count: 1 });
    const memoryId = result.memoryIds[0];
    assert(memoryId);
    expect(await memories.findById(memoryId)).toMatchObject({
      kind: 'procedure', content, scope: 'user', canonicalUserId: 'procedure-owner',
      authority: 'user_stated', state: groupId ? 'proposed' : 'active',
      visibility: groupId ? 'same_group_only' : 'private_only',
    });
    const decision = db.prepare(`SELECT id, job_attempt_id, source_event_ids
      FROM evaluator_decisions WHERE domain = 'memory'`).get() as {
      id: string; job_attempt_id: string; source_event_ids: string;
    };
    expect(decision.job_attempt_id).toBe(attempt.attemptId);
    expect(JSON.parse(decision.source_event_ids)).toEqual([message.rawEventId]);
    expect(db.prepare('SELECT evaluator_decision_id FROM memory_revisions WHERE memory_id = ?').get(memoryId))
      .toEqual({ evaluator_decision_id: decision.id });
    expect(db.prepare('SELECT evaluator_decision_id FROM audit_log WHERE event_id = ?').get(memoryId))
      .toEqual({ evaluator_decision_id: decision.id });
    expect(await governance.showMemory(memoryId)).not.toBeNull();

    if (groupId) {
      expect((await recall('procedure-owner', groupId)).memory.selectedMemoryIds).not.toContain(memoryId);
      expect(await governance.approveMemory(memoryId)).toMatchObject({ success: true });
    }
    const recalled = await recall('procedure-owner', groupId);
    expect(recalled.memory.selectedMemoryIds).toContain(memoryId);
    expect(recalled.trace?.memorySelections).toEqual(expect.arrayContaining([
      expect.objectContaining({ memoryId, retrievalMethods: expect.arrayContaining(['fts']) }),
    ]));
    expect((await recall('another-owner', groupId)).memory.selectedMemoryIds).not.toContain(memoryId);
    expect((await recall('procedure-owner', 'another-group')).memory.selectedMemoryIds).not.toContain(memoryId);
    if (groupId) {
      expect((await recall('procedure-owner')).memory.selectedMemoryIds).not.toContain(memoryId);
    }

    expect(await governance.disableMemory(memoryId)).toMatchObject({ success: true });
    expect((await recall('procedure-owner', groupId)).memory.selectedMemoryIds).not.toContain(memoryId);
    expect(await governance.enableMemory(memoryId)).toMatchObject({ success: true });
    expect((await recall('procedure-owner', groupId)).memory.selectedMemoryIds).toContain(memoryId);
    expect(await governance.deleteMemory(memoryId)).toMatchObject({ success: true });
    expect((await recall('procedure-owner', groupId)).memory.selectedMemoryIds).not.toContain(memoryId);

    // The effect committed before the job result: a retry must preserve the owner's deletion.
    expect(jobs.fail({ jobId, attemptId: attempt.attemptId, error: 'synthetic completion failure' })).toBe(true);
    const retry = jobs.claimNext({ workerId: 'procedure-worker', types: ['extraction'] });
    assert(retry);
    expect(await worker.extractFromChatMessage({ ...payload, jobAttemptId: retry.attemptId }))
      .toMatchObject({ memoryIds: [memoryId] });
    expect(evaluator.evaluateMemory).toHaveBeenCalledTimes(1);
    expect(await memories.findById(memoryId)).toMatchObject({ state: 'deleted' });
    expect((await recall('procedure-owner', groupId)).memory.selectedMemoryIds).not.toContain(memoryId);
    expect(jobs.complete({ jobId, attemptId: retry.attemptId, result })).toBe(true);
    expect(await governance.restoreMemory(memoryId)).toMatchObject({ success: true });
    expect((await recall('procedure-owner', groupId)).memory.selectedMemoryIds).toContain(memoryId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT change_type FROM memory_revisions WHERE memory_id = ?
      ORDER BY revision_number`).all(memoryId)).toEqual(
      ['create', ...(groupId ? ['approve'] : []), 'disable', 'restore', 'delete', 'restore']
        .map((change_type) => ({ change_type })),
    );
  });

  it.each(['opt-out', 'secret'])('rejects procedure teaching at the %s boundary', async (boundary) => {
    const message = source(boundary === 'secret'
      ? 'Remember this procedure: use api_key=sk-synthetic123456789012345678901234567890.'
      : 'Remember this procedure: summarize files with conclusions, then risks.', 'procedure-owner');
    if (boundary === 'opt-out') {
      new PrivacyPreferenceRepository(db).setOptOut({
        canonicalUserId: 'procedure-owner', preferenceType: 'memory_association',
        actor: { actorClass: 'admin', context: 'admin_cli' },
      });
    }
    const payload = { sourceChatMessageId: message.id, targetUserId: 'procedure-owner' };
    jobs.enqueue({ type: 'extraction', payload });
    const attempt = jobs.claimNext({ workerId: 'procedure-worker', types: ['extraction'] });
    assert(attempt);
    expect(await worker.extractFromChatMessage({ ...payload, jobAttemptId: attempt.attemptId }))
      .toMatchObject({ matched: false, count: 0 });
    expect(evaluator.evaluateMemory).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'memory.candidate_rejected'").get())
      .toEqual({ count: 1 });
  });
});
