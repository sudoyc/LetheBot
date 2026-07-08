import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { AuditRepository } from '../../../src/storage/audit-repository';
import { PrivacyPreferenceRepository } from '../../../src/storage/privacy-preference-repository';
import { MemoryProposalService, type MemoryCandidateInput } from '../../../src/memory/proposal-service';
import { EvaluatorStub } from '../../../src/evaluator/evaluator-stub';
import type { MemoryEvaluationRequest, MemoryEvaluationResult } from '../../../src/types/evaluator';

function baseCandidate(overrides: Partial<MemoryCandidateInput> = {}): MemoryCandidateInput {
  return {
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
      context: 'private_chat',
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
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run('user-alice', Date.now(), Date.now());
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('routes low-risk candidates through evaluator and creates active source-linked memory', async () => {
    const evaluator = new EvaluatorStub();
    const service = new MemoryProposalService(memoryRepo, { evaluator, auditRepository: auditRepo });

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

  it('forces group-chat-derived user memory to proposed even if evaluator recommends active', async () => {
    const evaluator = new EvaluatorStub();
    const service = new MemoryProposalService(memoryRepo, { evaluator, auditRepository: auditRepo });

    const outcome = await service.processCandidate(baseCandidate({
      sourceContext: 'group_chat',
      groupId: 'group-dev',
      conversationId: 'conv-group',
      visibility: 'same_group_only',
      actor: {
        canonicalUserId: 'user-alice',
        actorClass: 'system_worker',
        context: 'group_chat',
      },
    }));

    const memory = await memoryRepo.findById(outcome.memoryId ?? '');
    const active = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });

    expect(outcome.status).toBe('proposed');
    expect(memory?.state).toBe('proposed');
    expect(memory?.sourceContext).toBe('group_chat');
    expect(active).toHaveLength(0);
  });

  it('rejects secret-like candidates before durable memory write and audits without content', async () => {
    const service = new MemoryProposalService(memoryRepo, {
      evaluator: new EvaluatorStub(),
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
      auditRepository: auditRepo,
      privacyPreferences: privacyRepo,
    });

    const outcome = await service.processCandidate(baseCandidate({
      content: 'Alice prefers privacy-first behavior',
    }));

    const memoryRows = db.prepare('SELECT * FROM memory_records').all();
    const audit = db
      .prepare("SELECT summary, details FROM audit_log WHERE event_type = 'memory.candidate_rejected'")
      .get() as { summary: string; details: string };

    expect(outcome).toMatchObject({
      status: 'rejected',
      riskLevel: 'high',
      reason: 'Memory candidate rejected by memory-association opt-out',
    });
    expect(outcome.memoryId).toBeUndefined();
    expect(memoryRows).toHaveLength(0);
    expect(audit.summary).toBe('Memory candidate rejected by memory-association opt-out');
    expect(audit.details).not.toContain('privacy-first behavior');
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
    const service = new MemoryProposalService(memoryRepo, { evaluator, auditRepository: auditRepo });

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
