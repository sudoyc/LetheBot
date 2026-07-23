import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { MemoryPolicyError, MemoryRepository } from '../../../src/storage/memory-repository';
import { AuditRepository } from '../../../src/storage/audit-repository';
import { PrivacyPreferenceRepository } from '../../../src/storage/privacy-preference-repository';
import { MemoryProposalService, type MemoryCandidateInput } from '../../../src/memory/proposal-service';
import { EvaluatorStub } from '../../../src/evaluator/evaluator-stub';
import type { MemoryEvaluationRequest, MemoryEvaluationResult } from '../../../src/types/evaluator';

const passthroughDecisionWriter = {
  runWithMemoryDecision<T>(_evidence: unknown, effect: () => T): T {
    return effect();
  },
};

function baseCandidate(overrides: Partial<MemoryCandidateInput> = {}): MemoryCandidateInput {
  return {
    jobAttemptId: 'attempt-extraction-1',
    sourceEventIds: ['raw-source-1'],
    scope: 'user',
    canonicalUserId: 'user-alice',
    conversationId: 'conv-private',
    visibility: 'private_only',
    sensitivity: 'normal',
    authority: 'user_stated',
    kind: 'preference',
    title: 'Favorite tea',
    content: 'Alice likes oolong tea',
    confidence: 0.9,
    importance: 0.7,
    sourceContext: 'private_chat',
    sources: [
      {
        sourceType: 'chat_message',
        sourceId: 'msg-source-1',
        sourceTimestamp: 1234,
        extractedBy: 'worker',
      },
    ],
    actor: {
      canonicalUserId: 'user-alice',
      actorClass: 'system_worker',
      context: 'background_worker',
    },
    ...overrides,
  };
}

describe('MemoryProposalService', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let auditRepo: AuditRepository;
  let privacyRepo: PrivacyPreferenceRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-memory-proposal-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    memoryRepo = new MemoryRepository(db);
    auditRepo = new AuditRepository(db);
    privacyRepo = new PrivacyPreferenceRepository(db);
    const now = Date.now();
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run('user-alice', now, now);
    db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id, account_type,
        verified_level, status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'qq', 'qq-user-alice', 'user-alice', 'private', 'observed', 'active', now, now,
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-source-1',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'conv-private',
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-source-group',
      'chat.message.received',
      now + 1,
      'gateway',
      'qq',
      'conv-group',
      '{}',
      now + 1,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-source-group',
      'raw-source-group',
      'platform-msg-source-group',
      'conv-group',
      'group',
      'group-dev',
      'qq-user-alice',
      'Alice discussed a preference in the group',
      now + 1,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-source-1',
      'raw-source-1',
      'platform-msg-source-1',
      'conv-private',
      'private',
      'qq-user-alice',
      'Alice likes oolong tea',
      now,
    );
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('routes low-risk candidates through evaluator and creates active source-linked memory', async () => {
    const evaluator = new EvaluatorStub();
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const outcome = await service.processCandidate(baseCandidate());

    expect(outcome.status).toBe('active');
    expect(outcome.memoryId).toBeDefined();
    expect(outcome.evaluatorDecisionId).toBeDefined();

    const memory = await memoryRepo.findById(outcome.memoryId ?? '');
    const sources = db.prepare('SELECT * FROM memory_sources WHERE memory_id = ?').all(outcome.memoryId) as Array<{ source_id: string }>;
    const revisions = db.prepare('SELECT * FROM memory_revisions WHERE memory_id = ?').all(outcome.memoryId) as Array<{ change_type: string; evaluator_decision_id: string | null }>;
    const auditRows = db.prepare("SELECT * FROM audit_log WHERE category = 'memory' AND event_id = ?").all(outcome.memoryId) as Array<{ event_type: string; evaluator_decision_id: string | null }>;

    expect(memory?.state).toBe('active');
    expect(memory?.sourceEventIds).toEqual(['msg-source-1']);
    expect(sources).toHaveLength(1);
    expect(sources[0].source_id).toBe('msg-source-1');
    expect(revisions).toHaveLength(1);
    expect(revisions[0].change_type).toBe('create');
    expect(revisions[0].evaluator_decision_id).toBe(outcome.evaluatorDecisionId);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event_type).toBe('memory.create');
    expect(auditRows[0].evaluator_decision_id).toBe(outcome.evaluatorDecisionId);
  });

  it('keeps evaluator request identity separate from a deterministic memory effect ID', async () => {
    const memoryEffectId = `extraction-v1-${'a'.repeat(64)}`;
    const evaluator = {
      evaluateMemory: vi.fn(async (request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => ({
        domain: 'memory',
        decisionId: 'eval-separated-request-id',
        requestId: request.requestId,
        decision: 'approve',
        reason: 'approved',
        confidence: 0.9,
        riskLevel: 'low',
        decidedAt: new Date(),
        evaluatorVersion: 'test',
      })),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const outcome = await service.processCandidate(baseCandidate({ id: memoryEffectId }));
    const request = evaluator.evaluateMemory.mock.calls[0]?.[0];

    expect(request?.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(request?.requestId).not.toBe(memoryEffectId);
    expect(outcome.requestId).toBe(request?.requestId);
    expect(outcome.memoryId).toBe(memoryEffectId);
  });

  it('uses the durable job attempt and raw event as evaluator authority', async () => {
    const evaluator = {
      evaluateMemory: vi.fn(async (request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => ({
        domain: 'memory',
        decisionId: 'eval-job-authority',
        requestId: request.requestId,
        decision: 'approve',
        reason: 'approved',
        confidence: 0.9,
        riskLevel: 'low',
        decidedAt: new Date(),
        evaluatorVersion: 'test',
      })),
    };
    const decisionWriter = {
      runWithMemoryDecision: vi.fn(<T>(_evidence: unknown, effect: () => T): T => effect()),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: decisionWriter,
      auditRepository: auditRepo,
    });

    await service.processCandidate(baseCandidate());

    const request = evaluator.evaluateMemory.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      domain: 'memory',
      jobAttemptId: 'attempt-extraction-1',
      context: 'background_worker',
      sourceEventIds: ['raw-source-1'],
    });
    expect(request).not.toHaveProperty('turnId');
    expect(decisionWriter.runWithMemoryDecision).toHaveBeenCalledOnce();
    expect(decisionWriter.runWithMemoryDecision.mock.calls[0]?.[0]).toEqual({
      request,
      result: expect.objectContaining({ decisionId: 'eval-job-authority' }),
    });
  });

  it('fails before evaluator invocation when no atomic decision writer is configured', async () => {
    const evaluator = {
      evaluateMemory: vi.fn(async (_request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => {
        throw new Error('Evaluator must not be invoked');
      }),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      auditRepository: auditRepo,
    });

    await expect(service.processCandidate(baseCandidate()))
      .rejects.toThrow('Memory evaluator decision writer is required');
    expect(evaluator.evaluateMemory).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
  });

  it('persists one bounded idempotent rejection audit when memory evaluation throws', async () => {
    const providerDiagnostic = 'api_key=sk-memory-evaluator-diagnostic-must-not-persist';
    const evaluator = {
      evaluateMemory: vi.fn(async (): Promise<MemoryEvaluationResult> => {
        throw new Error(providerDiagnostic);
      }),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });
    const candidate = baseCandidate({ id: 'candidate-memory-evaluator-failure' });

    const first = await service.processCandidate(candidate);
    const second = await service.processCandidate(candidate);

    expect(first).toMatchObject({
      status: 'rejected',
      riskLevel: 'high',
      reason: 'Memory candidate rejected because evaluator review failed',
    });
    expect(second).toMatchObject({
      status: 'rejected',
      riskLevel: 'high',
      reason: first.reason,
    });
    expect(first.memoryId).toBeUndefined();
    expect(second.memoryId).toBeUndefined();
    expect(evaluator.evaluateMemory).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM memory_sources').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM memory_revisions').all()).toHaveLength(0);

    const audits = db.prepare(
      `SELECT event_id, summary, details, risk_level, evaluator_decision_id
       FROM audit_log
       WHERE event_type = 'memory.candidate_rejected'`
    ).all() as Array<{
      event_id: string;
      summary: string;
      details: string;
      risk_level: string;
      evaluator_decision_id: string | null;
    }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event_id: expect.stringMatching(/^memory-candidate-v1-[a-f0-9]{64}$/),
      summary: 'Memory candidate rejected because evaluator review failed',
      risk_level: 'high',
      evaluator_decision_id: null,
    });
    expect(audits[0]?.details).not.toContain(providerDiagnostic);
    expect(audits[0]?.details).not.toContain('sk-memory-evaluator-diagnostic');
    expect(JSON.parse(audits[0]?.details ?? '{}')).toMatchObject({
      scope: candidate.scope,
      sourceContext: candidate.sourceContext,
      sourceIds: ['msg-source-1'],
      findings: [],
    });
  });

  it('does not convert memory evaluator authority validation errors into rejection audits', async () => {
    const evaluator = {
      evaluateMemory: vi.fn(async (): Promise<MemoryEvaluationResult> => {
        throw new Error('Evaluator must not be invoked');
      }),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    await expect(service.processCandidate(baseCandidate({ turnId: 'turn-conflicting-authority' })))
      .rejects.toThrow('Memory evaluator requires exactly one turn or job-attempt authority');
    expect(evaluator.evaluateMemory).not.toHaveBeenCalled();
    expect(db.prepare(
      "SELECT * FROM audit_log WHERE event_type = 'memory.candidate_rejected'"
    ).all()).toHaveLength(0);
  });

  it('keeps private evaluator-approved memory proposed below the 0.85 confidence threshold', async () => {
    const evaluator = {
      evaluateMemory: vi.fn(async (request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => ({
        domain: 'memory',
        decisionId: 'eval-low-confidence-private',
        requestId: request.requestId,
        decision: 'approve',
        reason: 'uncertain approval',
        confidence: 0.84,
        riskLevel: 'low',
        decidedAt: new Date(),
        evaluatorVersion: 'test',
        recommendedState: 'active',
      })),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const outcome = await service.processCandidate(baseCandidate());

    expect(outcome.status).toBe('proposed');
    expect(await memoryRepo.findById(outcome.memoryId ?? '')).toMatchObject({ state: 'proposed' });
  });

  it('forces group-chat-derived user memory to proposed even if evaluator recommends active', async () => {
    const evaluator = new EvaluatorStub();
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const outcome = await service.processCandidate(baseCandidate({
      sourceContext: 'group_chat',
      groupId: 'group-dev',
      conversationId: 'conv-group',
      visibility: 'same_group_only',
      actor: {
        canonicalUserId: 'user-alice',
        actorClass: 'system_worker',
        context: 'background_worker',
      },
      sources: [
        {
          sourceType: 'chat_message',
          sourceId: 'msg-source-group',
          sourceTimestamp: 1234,
          extractedBy: 'worker',
        },
      ],
    }));

    const memory = await memoryRepo.findById(outcome.memoryId ?? '');
    const active = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });

    expect(outcome.status).toBe('proposed');
    expect(memory?.state).toBe('proposed');
    expect(memory?.sourceContext).toBe('group_chat');
    expect(active).toHaveLength(0);
  });

  it('does not let evaluator output lower a high-risk candidate into active memory', async () => {
    const evaluator = {
      evaluateMemory: vi.fn(async (request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => ({
        domain: 'memory',
        decisionId: 'eval-high-risk-downgrade-attempt',
        requestId: request.requestId,
        decision: 'approve',
        reason: 'Unsafe evaluator recommendation',
        confidence: 0.99,
        riskLevel: 'low',
        decidedAt: new Date(),
        evaluatorVersion: 'test',
        recommendedState: 'active',
        recommendedVisibility: 'public',
      })),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const outcome = await service.processCandidate(baseCandidate({
      initialRiskLevel: 'high',
    }));
    const memory = await memoryRepo.findById(outcome.memoryId ?? '');

    expect(outcome).toMatchObject({ status: 'proposed', riskLevel: 'high' });
    expect(memory?.state).toBe('proposed');
    expect(await memoryRepo.retrieve({ canonicalUserId: 'user-alice' })).toHaveLength(0);
  });

  it('keeps evaluator-approved medium-risk active memory on conservative visibility', async () => {
    const evaluator = {
      evaluateMemory: vi.fn(async (request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => ({
        domain: 'memory',
        decisionId: 'eval-medium-public-attempt',
        requestId: request.requestId,
        decision: 'approve',
        reason: 'Active but over-broad visibility recommendation',
        confidence: 0.9,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'test',
        recommendedState: 'active',
        recommendedVisibility: 'public',
      })),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const outcome = await service.processCandidate(baseCandidate({
      initialRiskLevel: 'medium',
      visibility: 'private_only',
    }));
    const memory = await memoryRepo.findById(outcome.memoryId ?? '');

    expect(outcome).toMatchObject({ status: 'active', riskLevel: 'medium' });
    expect(memory).toMatchObject({ state: 'active', visibility: 'private_only' });
  });

  it('classifies equivalent conservative visibility consistently before and after clamping', async () => {
    const evaluator = {
      evaluateMemory: vi.fn(async (request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => ({
        domain: 'memory',
        decisionId: `eval-visibility-${request.memoryCandidate.title}`,
        requestId: request.requestId,
        decision: 'approve',
        reason: 'Conservative visibility recommendation',
        confidence: 0.9,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'test',
        recommendedState: 'active',
        recommendedVisibility: request.memoryCandidate.title === 'Direct visibility'
          ? 'owner_admin_only'
          : 'public',
      })),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const direct = await service.processCandidate(baseCandidate({
      scope: 'global',
      canonicalUserId: undefined,
      conversationId: undefined,
      visibility: 'public',
      initialRiskLevel: 'medium',
      title: 'Direct visibility',
    }));
    const clamped = await service.processCandidate(baseCandidate({
      scope: 'global',
      canonicalUserId: undefined,
      conversationId: undefined,
      visibility: 'public',
      initialRiskLevel: 'medium',
      title: 'Clamped visibility',
    }));

    expect(direct).toMatchObject({ status: 'active', riskLevel: 'medium' });
    expect(clamped).toMatchObject({ status: 'active', riskLevel: 'medium' });
    expect(await memoryRepo.findById(direct.memoryId ?? '')).toMatchObject({
      state: 'active',
      visibility: 'owner_admin_only',
    });
    expect(await memoryRepo.findById(clamped.memoryId ?? '')).toMatchObject({
      state: 'active',
      visibility: 'owner_admin_only',
    });
  });

  it('rejects prohibited evaluator outcomes without creating memory', async () => {
    const evaluator = {
      evaluateMemory: vi.fn(async (request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => ({
        domain: 'memory',
        decisionId: 'eval-prohibited-active-attempt',
        requestId: request.requestId,
        decision: 'approve',
        reason: 'Evaluator identified prohibited risk',
        confidence: 0.95,
        riskLevel: 'prohibited',
        decidedAt: new Date(),
        evaluatorVersion: 'test',
        recommendedState: 'active',
        recommendedVisibility: 'public',
      })),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const outcome = await service.processCandidate(baseCandidate());
    const audit = db
      .prepare(
        `SELECT risk_level, evaluator_decision_id
         FROM audit_log
         WHERE event_type = 'memory.candidate_rejected'`
      )
      .get() as { risk_level: string; evaluator_decision_id: string | null };

    expect(outcome).toMatchObject({
      status: 'rejected',
      riskLevel: 'prohibited',
      evaluatorDecisionId: 'eval-prohibited-active-attempt',
    });
    expect(outcome.memoryId).toBeUndefined();
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);
    expect(audit).toEqual({
      risk_level: 'prohibited',
      evaluator_decision_id: 'eval-prohibited-active-attempt',
    });
  });

  it('retains evaluator identity when repository policy rejects the governed write', async () => {
    const evaluator = new EvaluatorStub();
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });
    vi.spyOn(memoryRepo, 'createSync').mockImplementationOnce(() => {
      throw new MemoryPolicyError(
      'Synthetic repository policy rejection',
      'SECRET_OR_PROHIBITED_MEMORY',
      [{ kind: 'secret', pattern: 'repository_only_test' }],
      );
    });

    const outcome = await service.processCandidate(baseCandidate());
    const audit = db
      .prepare(
        `SELECT risk_level, evaluator_decision_id
         FROM audit_log
         WHERE event_type = 'memory.candidate_rejected'`
      )
      .get() as { risk_level: string; evaluator_decision_id: string | null };

    expect(outcome).toMatchObject({
      status: 'rejected',
      riskLevel: 'prohibited',
      evaluatorDecisionId: expect.any(String),
    });
    expect(audit).toEqual({
      risk_level: 'prohibited',
      evaluator_decision_id: outcome.evaluatorDecisionId,
    });
  });

  it('rejects secret-like candidates before durable memory write and audits without content', async () => {
    const service = new MemoryProposalService(memoryRepo, {
      evaluator: new EvaluatorStub(),
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const outcome = await service.processCandidate(baseCandidate({
      title: 'Temporary token',
      content: 'api_key = sk-abcdefghijklmnopqrstuvwxyz123456',
    }));

    const memoryRows = db.prepare('SELECT * FROM memory_records').all();
    const audit = db.prepare("SELECT summary, details FROM audit_log WHERE event_type = 'memory.candidate_rejected'").get() as { summary: string; details: string };

    expect(outcome.status).toBe('rejected');
    expect(outcome.riskLevel).toBe('prohibited');
    expect(outcome.memoryId).toBeUndefined();
    expect(memoryRows).toHaveLength(0);
    expect(audit.summary).toContain('secret/prohibited scan');
    expect(audit.details).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(JSON.parse(audit.details)).toMatchObject({
      scope: 'user',
      sourceContext: 'private_chat',
    });
  });

  it('rejects user memory candidates when memory association is opted out', async () => {
    const unsafeCandidateId = 'api_key=sk-candidate-id-secret-qq-1234567890';
    privacyRepo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'memory_association',
      reason: 'User opted out of memory association',
      actor: {
        canonicalUserId: 'admin',
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });

    const service = new MemoryProposalService(memoryRepo, {
      evaluator: new EvaluatorStub(),
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
      privacyPreferences: privacyRepo,
    });

    const outcome = await service.processCandidate(baseCandidate({
      id: unsafeCandidateId,
      content: 'Alice prefers privacy-first behavior',
    }));

    const memoryRows = db.prepare('SELECT * FROM memory_records').all();
    const audit = db
      .prepare("SELECT event_id, summary, details FROM audit_log WHERE event_type = 'memory.candidate_rejected'")
      .get() as { event_id: string; summary: string; details: string };

    expect(outcome).toMatchObject({
      status: 'rejected',
      riskLevel: 'high',
      reason: 'Memory candidate rejected by memory-association opt-out',
    });
    expect(outcome.memoryId).toBeUndefined();
    expect(memoryRows).toHaveLength(0);
    expect(audit.summary).toBe('Memory candidate rejected by memory-association opt-out');
    expect(outcome.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(audit.event_id).toMatch(/^memory-candidate-v1-[a-f0-9]{64}$/);
    expect(audit.event_id).not.toContain(unsafeCandidateId);
    expect(audit.details).not.toContain('privacy-first behavior');
    expect(audit.details).not.toContain(unsafeCandidateId);
    expect(JSON.parse(audit.details)).toMatchObject({
      scope: 'user',
      sourceContext: 'private_chat',
      sourceIds: ['msg-source-1'],
    });
  });

  it('persists evaluator-rejected non-secret candidates as rejected records for governance audit', async () => {
    const evaluator = {
      evaluateMemory: vi.fn(async (request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => ({
        domain: 'memory',
        decisionId: 'eval-memory-reject',
        requestId: request.requestId,
        decision: 'reject',
        reason: 'Unverified third-party claim',
        confidence: 0.8,
        riskLevel: 'high',
        decidedAt: new Date(),
        evaluatorVersion: 'test',
      })),
    };
    const service = new MemoryProposalService(memoryRepo, {
      evaluator,
      evaluatorDecisionWriter: passthroughDecisionWriter,
      auditRepository: auditRepo,
    });

    const outcome = await service.processCandidate(baseCandidate({
      authority: 'inferred',
      sensitivity: 'personal',
      content: 'Someone else says Alice hates Bob',
    }));

    const memory = await memoryRepo.findById(outcome.memoryId ?? '');
    const retrieved = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });

    expect(evaluator.evaluateMemory).toHaveBeenCalledOnce();
    expect(outcome.status).toBe('rejected');
    expect(memory?.state).toBe('rejected');
    expect(memory?.evaluatorDecisionId).toBe('eval-memory-reject');
    expect(retrieved).toHaveLength(0);
  });
});
