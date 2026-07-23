import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { closeDatabase, initDatabase, runMigrations } from '../../../src/storage/database';
import {
  EvaluatorDecisionRepository,
  type MemoryEvaluatorEvidence,
  type ToolEvaluatorEvidence,
} from '../../../src/storage/evaluator-decision-repository';
import { AuditRepository } from '../../../src/storage/audit-repository';
import { MemoryRepository } from '../../../src/storage/memory-repository';

describe('EvaluatorDecisionRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: EvaluatorDecisionRepository;
  let fixtureNow: number;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-evaluator-decision-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigrations(db, join(__dirname, '../../../migrations'));
    repo = new EvaluatorDecisionRepository(db);

    const now = Date.now();
    fixtureNow = now;
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-evaluator-tool', 'message.private', now, 'gateway', 'qq', 'conv-evaluator-tool', '{}', now);
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-evaluator-related', 'tool.requested', now, 'agent', null, 'conv-evaluator-tool', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-evaluator-tool', 'conv-evaluator-tool', 'evt-evaluator-tool', 'mock', 'mock', 'running', now);

    db.prepare(
      'INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)'
    ).run('user-evaluator-memory', now, now);
    db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id, account_type,
        verified_level, status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'qq',
      'source-user-evaluator-memory',
      'user-evaluator-memory',
      'private',
      'observed',
      'active',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-evaluator-memory',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:qq-1234567890',
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-evaluator-memory',
      'evt-evaluator-memory',
      'platform-msg-evaluator-memory',
      'private:qq-1234567890',
      'private',
      'qq-source-user-evaluator-memory',
      'Synthetic memory evaluator source',
      now,
    );
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        lease_owner, lease_expires_at, heartbeat_at,
        created_at, updated_at, scheduled_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'job-evaluator-memory',
      'extraction',
      JSON.stringify({
        sourceChatMessageId: 'msg-evaluator-memory',
        targetUserId: 'user-evaluator-memory',
      }),
      'running',
      1,
      3,
      'worker-evaluator-memory',
      now + 60_000,
      now,
      now,
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO job_attempts (
        id, job_id, attempt_number, worker_id, status, started_at, heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'attempt-evaluator-memory',
      'job-evaluator-memory',
      1,
      'worker-evaluator-memory',
      'running',
      now,
      now,
    );
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeEvidence(suffix = 'valid'): ToolEvaluatorEvidence {
    return {
      request: {
        requestId: `request-${suffix}`,
        domain: 'tool',
        turnId: 'turn-evaluator-tool',
        actor: { canonicalUserId: 'user-evaluator-tool', actorClass: 'user' },
        context: 'private_chat',
        sourceEventIds: ['evt-evaluator-tool', 'evt-evaluator-related'],
        contextSummary: 'context sk-evaluator-context-must-not-persist',
        toolName: 'search',
        capabilities: ['network'],
        toolInput: { token: 'sk-evaluator-input-must-not-persist' },
        proposedReason: 'proposal sk-evaluator-proposal-must-not-persist',
        createdAt: new Date('2026-07-11T01:02:03.000Z'),
      },
      result: {
        decisionId: `decision-${suffix}`,
        requestId: `request-${suffix}`,
        domain: 'tool',
        decision: 'approve',
        reason: `approved api_key=sk-evaluator-reason-must-not-persist for qq-1234567890 ${'x'.repeat(2200)}`,
        confidence: 0.83,
        riskLevel: 'medium',
        decidedAt: new Date('2026-07-11T01:02:04.000Z'),
        evaluatorVersion: 'test-evaluator-v1',
      },
    };
  }

  function makeMemoryEvidence(suffix = 'valid'): MemoryEvaluatorEvidence {
    return {
      request: {
        requestId: `memory-request-${suffix}`,
        domain: 'memory',
        jobAttemptId: 'attempt-evaluator-memory',
        actor: {
          canonicalUserId: 'user-evaluator-memory',
          actorClass: 'system_worker',
        },
        context: 'background_worker',
        sourceEventIds: ['evt-evaluator-memory'],
        contextSummary: 'context sk-memory-evaluator-context-must-not-persist',
        createdAt: new Date(fixtureNow + 1),
        memoryCandidate: {
          scope: 'user',
          canonicalUserId: 'user-evaluator-memory',
          kind: 'preference',
          title: 'Favorite tea',
          content: 'The user likes oolong tea',
          confidence: 0.9,
          sourceContext: 'chat:private:qq-1234567890:msg-evaluator-memory',
        },
        initialRiskLevel: 'low',
      },
      result: {
        decisionId: `memory-decision-${suffix}`,
        requestId: `memory-request-${suffix}`,
        domain: 'memory',
        decision: 'approve',
        reason: 'approved api_key=sk-memory-evaluator-reason-must-not-persist',
        confidence: 0.91,
        riskLevel: 'low',
        decidedAt: new Date(fixtureNow + 2),
        evaluatorVersion: 'test-memory-evaluator-v1',
        recommendedState: 'active',
        recommendedVisibility: 'private_only',
        recommendedSensitivity: 'normal',
      },
    };
  }

  function insertCompletedEvaluatorInvocation(input: {
    id: string;
    requestId: string;
    domain: 'tool' | 'memory' | 'social';
    turnId?: string;
    jobAttemptId?: string;
    sourceEventIds: string[];
    provider: string;
    model: string;
    promptVersion: string;
    startedAt: number;
    completedAt: number;
  }): void {
    db.prepare(
      `INSERT INTO model_invocations (
        id, turn_id, job_attempt_id, context_id, purpose, evaluator_request_id,
        evaluator_domain, prompt_version, call_number, provider, model, status,
        started_at, completed_at, tokens_input, tokens_output, tokens_total,
        response_sha256, response_bytes
      ) VALUES (?, ?, ?, NULL, 'evaluator', ?, ?, ?, 1, ?, ?, 'completed',
                ?, ?, 10, 5, 15, ?, 32)`
    ).run(
      input.id,
      input.turnId ?? null,
      input.jobAttemptId ?? null,
      input.requestId,
      input.domain,
      input.promptVersion,
      input.provider,
      input.model,
      input.startedAt,
      input.completedAt,
      'a'.repeat(64),
    );
    const insertSource = db.prepare(
      `INSERT INTO model_invocation_sources (
        model_invocation_id, raw_event_id, source_ordinal
      ) VALUES (?, ?, ?)`
    );
    input.sourceEventIds.forEach((sourceEventId, ordinal) => {
      insertSource.run(input.id, sourceEventId, ordinal);
    });
  }

  function createMemoryEffect(evidence: MemoryEvaluatorEvidence, id = 'memory-evaluator-atomic'): () => string {
    return () => new MemoryRepository(db).createSync({
      id,
      scope: 'user',
      canonicalUserId: 'user-evaluator-memory',
      conversationId: 'private:qq-1234567890',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'Favorite tea',
      content: 'The user likes oolong tea',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'chat:private:qq-1234567890:msg-evaluator-memory',
      evaluatorDecisionId: evidence.result.decisionId,
      sources: [{
        sourceType: 'chat_message',
        sourceId: 'msg-evaluator-memory',
        sourceTimestamp: fixtureNow,
        extractedBy: 'worker',
      }],
      actor: {
        canonicalUserId: 'user-evaluator-memory',
        actorClass: 'system_worker',
        context: 'background_worker',
      },
    });
  }

  function expectNoMemoryDecisionEffect(decisionId: string, memoryId: string): void {
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id = ?`
    ).get(decisionId)).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_records WHERE id = ?`
    ).get(memoryId)).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_sources WHERE memory_id = ?`
    ).get(memoryId)).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?`
    ).get(memoryId)).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM audit_log WHERE event_id = ?`
    ).get(memoryId)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_fts').get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  }

  it('persists source-bound tool evaluator evidence without request input or context', async () => {
    const evidence = makeEvidence();

    await expect(repo.createToolDecision(evidence)).resolves.toBe('decision-valid');

    const row = db.prepare('SELECT * FROM evaluator_decisions WHERE id = ?').get('decision-valid') as {
      id: string;
      request_id: string;
      domain: string;
      turn_id: string;
      tool_name: string | null;
      reason: string;
      confidence: number;
      source_event_ids: string;
      request_created_at: number;
      decided_at: number;
    };
    const serialized = JSON.stringify(row);

    expect(row).toMatchObject({
      id: 'decision-valid',
      request_id: 'request-valid',
      domain: 'tool',
      turn_id: 'turn-evaluator-tool',
      tool_name: 'search',
      confidence: 0.83,
      request_created_at: evidence.request.createdAt.getTime(),
      decided_at: evidence.result.decidedAt.getTime(),
    });
    expect(JSON.parse(row.source_event_ids)).toEqual(['evt-evaluator-tool', 'evt-evaluator-related']);
    expect((row as Record<string, unknown>).model_invocation_id).toBeNull();
    expect(row.reason).toHaveLength(2048);
    expect(row.reason).toContain('[REDACTED:api_key_assignment]');
    expect(row.reason).toContain('[REDACTED:platform_id]');
    expect(row.reason).toMatch(/ \[TRUNCATED\]$/);
    expect(serialized).not.toContain('sk-evaluator-reason-must-not-persist');
    expect(serialized).not.toContain('sk-evaluator-context-must-not-persist');
    expect(serialized).not.toContain('sk-evaluator-input-must-not-persist');
    expect(serialized).not.toContain('sk-evaluator-proposal-must-not-persist');
    expect(serialized).not.toContain('1234567890');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('links exact completed Provider invocation evidence to a tool decision', async () => {
    const evidence = makeEvidence('provider-link');
    const requestCreatedAt = evidence.request.createdAt.getTime();
    const decidedAt = evidence.result.decidedAt.getTime();
    evidence.result = {
      ...evidence.result,
      evaluatorVersion: 'openai/gpt-4/tool-prompt-v1',
      modelInvocationId: 'invocation-tool-provider-link',
    };
    insertCompletedEvaluatorInvocation({
      id: 'invocation-tool-provider-link',
      requestId: evidence.request.requestId,
      domain: 'tool',
      turnId: evidence.request.turnId,
      sourceEventIds: evidence.request.sourceEventIds,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'tool-prompt-v1',
      startedAt: requestCreatedAt + 100,
      completedAt: decidedAt - 100,
    });

    await expect(repo.createToolDecision(evidence)).resolves.toBe(evidence.result.decisionId);
    expect(db.prepare(
      'SELECT model_invocation_id FROM evaluator_decisions WHERE id = ?'
    ).get(evidence.result.decisionId)).toEqual({
      model_invocation_id: 'invocation-tool-provider-link',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects incoherent, untraceable, or non-finite tool evaluator evidence', async () => {
    const cases: Array<{
      suffix: string;
      expected: string;
      change: (evidence: ToolEvaluatorEvidence) => ToolEvaluatorEvidence;
    }> = [
      {
        suffix: 'request-domain',
        expected: 'domain',
        change: (evidence) => ({
          ...evidence,
          request: { ...evidence.request, domain: 'social' } as unknown as ToolEvaluatorEvidence['request'],
        }),
      },
      {
        suffix: 'result-domain',
        expected: 'domain',
        change: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, domain: 'memory' } as unknown as ToolEvaluatorEvidence['result'],
        }),
      },
      {
        suffix: 'request-binding',
        expected: 'request',
        change: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, requestId: 'another-request' },
        }),
      },
      {
        suffix: 'turn',
        expected: 'turn',
        change: (evidence) => ({
          ...evidence,
          request: { ...evidence.request, turnId: 'missing-turn' },
        }),
      },
      {
        suffix: 'trigger',
        expected: 'trigger event',
        change: (evidence) => ({
          ...evidence,
          request: { ...evidence.request, sourceEventIds: ['evt-evaluator-related'] },
        }),
      },
      {
        suffix: 'source',
        expected: 'source event',
        change: (evidence) => ({
          ...evidence,
          request: { ...evidence.request, sourceEventIds: ['evt-evaluator-tool', 'missing-event'] },
        }),
      },
      {
        suffix: 'confidence-nan',
        expected: 'confidence',
        change: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, confidence: Number.NaN },
        }),
      },
      {
        suffix: 'confidence-range',
        expected: 'confidence',
        change: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, confidence: 1.1 },
        }),
      },
      {
        suffix: 'constraint-infinity',
        expected: 'constraint',
        change: (evidence) => ({
          ...evidence,
          result: {
            ...evidence.result,
            additionalConstraints: { maxRuntimeMs: Number.POSITIVE_INFINITY },
          },
        }),
      },
      {
        suffix: 'request-time',
        expected: 'timestamp',
        change: (evidence) => ({
          ...evidence,
          request: { ...evidence.request, createdAt: new Date(Number.NaN) },
        }),
      },
      {
        suffix: 'decision-time',
        expected: 'timestamp',
        change: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, decidedAt: new Date(Number.NaN) },
        }),
      },
      {
        suffix: 'time-order',
        expected: 'timestamp',
        change: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, decidedAt: new Date('2026-07-11T01:02:02.000Z') },
        }),
      },
    ];

    for (const testCase of cases) {
      const evidence = testCase.change(makeEvidence(testCase.suffix));
      await expect(repo.createToolDecision(evidence)).rejects.toThrow(testCase.expected);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id = ?')
          .get(evidence.result.decisionId)
      ).toEqual({ count: 0 });
    }

    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('atomically persists a job-attempt-owned memory decision and governed memory effect', () => {
    const evidence = makeMemoryEvidence();
    evidence.result = {
      ...evidence.result,
      evaluatorVersion: 'openai/gpt-4/memory-prompt-v1',
      modelInvocationId: 'invocation-memory-provider-link',
    };
    insertCompletedEvaluatorInvocation({
      id: 'invocation-memory-provider-link',
      requestId: evidence.request.requestId,
      domain: 'memory',
      jobAttemptId: evidence.request.jobAttemptId,
      sourceEventIds: evidence.request.sourceEventIds,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'memory-prompt-v1',
      startedAt: evidence.request.createdAt.getTime(),
      completedAt: evidence.result.decidedAt.getTime(),
    });

    expect(repo.runWithMemoryDecision(evidence, createMemoryEffect(evidence)))
      .toBe('memory-evaluator-atomic');

    const decision = db.prepare(
      `SELECT id, request_id, domain, turn_id, job_attempt_id, model_invocation_id, tool_name,
              actor_user_id, actor_class, invocation_context, source_event_ids,
              reason, confidence, request_created_at, decided_at
         FROM evaluator_decisions WHERE id = ?`
    ).get(evidence.result.decisionId) as Record<string, unknown>;
    expect(decision).toMatchObject({
      id: 'memory-decision-valid',
      request_id: 'memory-request-valid',
      domain: 'memory',
      turn_id: null,
      job_attempt_id: 'attempt-evaluator-memory',
      model_invocation_id: 'invocation-memory-provider-link',
      tool_name: null,
      actor_user_id: 'user-evaluator-memory',
      actor_class: 'system_worker',
      invocation_context: 'background_worker',
      confidence: 0.91,
      request_created_at: evidence.request.createdAt.getTime(),
      decided_at: evidence.result.decidedAt.getTime(),
    });
    expect(JSON.parse(String(decision.source_event_ids))).toEqual(['evt-evaluator-memory']);
    expect(decision.reason).toContain('[REDACTED:api_key_assignment]');
    expect(JSON.stringify(decision)).not.toContain('sk-memory-evaluator-reason-must-not-persist');

    expect(db.prepare(
      `SELECT evaluator_decision_id FROM memory_records WHERE id = ?`
    ).get('memory-evaluator-atomic')).toEqual({ evaluator_decision_id: evidence.result.decisionId });
    expect(db.prepare(
      `SELECT source_type, source_id, chat_message_id
         FROM memory_sources WHERE memory_id = ?`
    ).get('memory-evaluator-atomic')).toEqual({
      source_type: 'chat_message',
      source_id: 'msg-evaluator-memory',
      chat_message_id: 'msg-evaluator-memory',
    });
    expect(db.prepare(
      `SELECT evaluator_decision_id FROM memory_revisions WHERE memory_id = ?`
    ).get('memory-evaluator-atomic')).toEqual({ evaluator_decision_id: evidence.result.decisionId });
    expect(db.prepare(
      `SELECT evaluator_decision_id FROM audit_log
        WHERE event_type = 'memory.create' AND event_id = ?`
    ).get('memory-evaluator-atomic')).toEqual({ evaluator_decision_id: evidence.result.decisionId });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects a mismatched memory invocation before running the governed effect', () => {
    const evidence = makeMemoryEvidence('invocation-mismatch');
    evidence.result = {
      ...evidence.result,
      evaluatorVersion: 'openai/gpt-4/memory-prompt-v1',
      modelInvocationId: 'invocation-memory-mismatch',
    };
    insertCompletedEvaluatorInvocation({
      id: 'invocation-memory-mismatch',
      requestId: 'another-memory-request',
      domain: 'memory',
      jobAttemptId: evidence.request.jobAttemptId,
      sourceEventIds: evidence.request.sourceEventIds,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'memory-prompt-v1',
      startedAt: evidence.request.createdAt.getTime(),
      completedAt: evidence.result.decidedAt.getTime(),
    });
    let effectCalled = false;

    expect(() => repo.runWithMemoryDecision(evidence, () => {
      effectCalled = true;
      return 'unreachable-memory';
    })).toThrow('invocation');

    expect(effectCalled).toBe(false);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id = ?'
    ).get(evidence.result.decisionId)).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rolls back the evaluator decision and all nested memory effects when the effect fails', () => {
    const evidence = makeMemoryEvidence('rollback');
    const create = createMemoryEffect(evidence, 'memory-evaluator-rollback');

    expect(() => repo.runWithMemoryDecision(evidence, () => {
      create();
      throw new Error('forced terminal effect failure');
    })).toThrow('forced terminal effect failure');

    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id = ?`
    ).get(evidence.result.decisionId)).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_records WHERE id = ?`
    ).get('memory-evaluator-rollback')).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_sources WHERE memory_id = ?`
    ).get('memory-evaluator-rollback')).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?`
    ).get('memory-evaluator-rollback')).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM audit_log WHERE event_id = ?`
    ).get('memory-evaluator-rollback')).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_fts').get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('atomically persists a job-attempt-owned decision with its evaluated rejection audit', () => {
    const evidence = makeMemoryEvidence('rejected-audit');
    evidence.result = {
      ...evidence.result,
      decision: 'reject',
      riskLevel: 'prohibited',
    };

    expect(repo.runWithMemoryDecision(evidence, () => {
      new AuditRepository(db).createSync({
        timestamp: new Date(fixtureNow + 3),
        category: 'memory',
        level: 'summary',
        eventType: 'memory.candidate_rejected',
        eventId: 'memory-candidate-rejected-audit',
        actor: {
          canonicalUserId: 'user-evaluator-memory',
          actorClass: 'system_worker',
          context: 'background_worker',
        },
        summary: 'Rejected by deterministic post-evaluator policy',
        details: {
          requestId: evidence.request.requestId,
          sourceContext: 'chat:private:qq-1234567890:msg-evaluator-memory',
          sourceIds: ['msg-evaluator-memory'],
        },
        redacted: true,
        riskLevel: 'prohibited',
        evaluatorDecisionId: evidence.result.decisionId,
      });
    })).toBeUndefined();

    expect(db.prepare(
      `SELECT job_attempt_id FROM evaluator_decisions WHERE id = ?`
    ).get(evidence.result.decisionId)).toEqual({ job_attempt_id: 'attempt-evaluator-memory' });
    expect(db.prepare(
      `SELECT evaluator_decision_id FROM audit_log WHERE event_id = ?`
    ).get('memory-candidate-rejected-audit')).toEqual({
      evaluator_decision_id: evidence.result.decisionId,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects memory evidence that is not bound to the running extraction authority', () => {
    const cases: Array<{
      suffix: string;
      expected: string;
      change: (evidence: MemoryEvaluatorEvidence) => MemoryEvaluatorEvidence;
    }> = [
      {
        suffix: 'turn-owner',
        expected: 'job attempt',
        change: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            turnId: 'turn-evaluator-tool',
            jobAttemptId: undefined,
          } as unknown as MemoryEvaluatorEvidence['request'],
        }),
      },
      {
        suffix: 'request-binding',
        expected: 'request',
        change: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, requestId: 'another-memory-request' },
        }),
      },
      {
        suffix: 'actor-class',
        expected: 'actor',
        change: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            actor: { ...evidence.request.actor, actorClass: 'user' },
          },
        }),
      },
      {
        suffix: 'actor-user',
        expected: 'target user',
        change: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            actor: { ...evidence.request.actor, canonicalUserId: 'another-user' },
          },
        }),
      },
      {
        suffix: 'context',
        expected: 'background_worker',
        change: (evidence) => ({
          ...evidence,
          request: { ...evidence.request, context: 'private_chat' },
        }),
      },
      {
        suffix: 'candidate-scope',
        expected: 'user scope',
        change: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            memoryCandidate: { ...evidence.request.memoryCandidate, scope: 'group' },
          },
        }),
      },
      {
        suffix: 'candidate-target',
        expected: 'target user',
        change: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            memoryCandidate: {
              ...evidence.request.memoryCandidate,
              canonicalUserId: 'another-user',
            },
          },
        }),
      },
      {
        suffix: 'chat-id-source',
        expected: 'raw event',
        change: (evidence) => ({
          ...evidence,
          request: { ...evidence.request, sourceEventIds: ['msg-evaluator-memory'] },
        }),
      },
      {
        suffix: 'additional-source',
        expected: 'exactly one',
        change: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            sourceEventIds: ['evt-evaluator-memory', 'evt-evaluator-related'],
          },
        }),
      },
      {
        suffix: 'source-context',
        expected: 'source context',
        change: (evidence) => ({
          ...evidence,
          request: {
            ...evidence.request,
            memoryCandidate: {
              ...evidence.request.memoryCandidate,
              sourceContext: 'private_chat',
            },
          },
        }),
      },
      {
        suffix: 'result-domain',
        expected: 'domain',
        change: (evidence) => ({
          ...evidence,
          result: {
            ...evidence.result,
            domain: 'tool',
          } as unknown as MemoryEvaluatorEvidence['result'],
        }),
      },
      {
        suffix: 'confidence',
        expected: 'confidence',
        change: (evidence) => ({
          ...evidence,
          result: { ...evidence.result, confidence: Number.NaN },
        }),
      },
      {
        suffix: 'timestamp',
        expected: 'timestamp',
        change: (evidence) => ({
          ...evidence,
          result: {
            ...evidence.result,
            decidedAt: new Date(fixtureNow),
          },
        }),
      },
    ];

    for (const testCase of cases) {
      const evidence = testCase.change(makeMemoryEvidence(testCase.suffix));
      let effectCalled = false;
      expect(() => repo.runWithMemoryDecision(evidence, () => {
        effectCalled = true;
        return 'unreachable-memory';
      })).toThrow(testCase.expected);
      expect(effectCalled).toBe(false);
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id = ?`
      ).get(evidence.result.decisionId)).toEqual({ count: 0 });
    }

    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects memory evidence when the extraction attempt is no longer running', () => {
    db.prepare(
      `UPDATE job_attempts SET status = 'failed', completed_at = ? WHERE id = ?`
    ).run(Date.now(), 'attempt-evaluator-memory');
    const evidence = makeMemoryEvidence('ended-attempt');

    expect(() => repo.runWithMemoryDecision(evidence, () => 'unreachable-memory'))
      .toThrow('running extraction');
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id = ?`
    ).get(evidence.result.decisionId)).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects an evaluator memory effect after its extraction lease expires', () => {
    const commitNow = fixtureNow + 20_000;
    repo = new EvaluatorDecisionRepository(db, () => commitNow);
    db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?')
      .run(commitNow, 'job-evaluator-memory');
    const evidence = makeMemoryEvidence('expired-lease');
    const memoryId = 'memory-evaluator-expired-lease';

    expect(() => repo.runWithMemoryDecision(
      evidence,
      createMemoryEffect(evidence, memoryId),
    )).toThrow('running extraction lease authority');

    expectNoMemoryDecisionEffect(evidence.result.decisionId, memoryId);
  });

  it('rolls back an evaluator memory effect when its lease expires during the effect', () => {
    let commitNow = fixtureNow + 10_000;
    repo = new EvaluatorDecisionRepository(db, () => commitNow);
    db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?')
      .run(fixtureNow + 20_000, 'job-evaluator-memory');
    const evidence = makeMemoryEvidence('lease-expired-during-effect');
    const memoryId = 'memory-evaluator-lease-expired-during-effect';
    const create = createMemoryEffect(evidence, memoryId);

    expect(() => repo.runWithMemoryDecision(evidence, () => {
      const createdMemoryId = create();
      commitNow = fixtureNow + 20_000;
      return createdMemoryId;
    })).toThrow('running extraction lease authority');

    expectNoMemoryDecisionEffect(evidence.result.decisionId, memoryId);
  });
});
