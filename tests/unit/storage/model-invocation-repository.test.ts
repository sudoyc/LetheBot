import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextPack } from '../../../src/types/context';
import { closeDatabase, initDatabase, runMigration, runMigrations } from '../../../src/storage/database';
import {
  assertEvaluatorInvocationBinding,
  ModelInvocationRepository,
} from '../../../src/storage/model-invocation-repository';
import type { ToolEvaluationRequest, ToolEvaluationResult } from '../../../src/types/evaluator';

describe('ModelInvocationRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: ModelInvocationRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-model-invocation-repo-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigrations(db, join(__dirname, '../../../migrations'));
    repo = new ModelInvocationRepository(db);

    insertRunningAttempt('job-summary-1', 'attempt-summary-1');
    insertRawEvent('raw-summary-1');
    insertRawEvent('raw-summary-2');
    insertRawEvent('raw-summary-extra');
    insertChatMessage('chat-message-1', 'raw-summary-1', 1_700_000_000_000);
    insertChatMessage('chat-message-2', 'raw-summary-2', 1_700_000_000_100);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('persists a redacted context trace and completed call evidence without raw prompt or response text', () => {
    const context = buildContext();
    const contextId = repo.createContext(context, 'attempt-summary-1', 'summary');

    const invocationId = repo.startInvocation({
      id: 'invocation-summary-1',
      contextId,
      jobAttemptId: 'attempt-summary-1',
      purpose: 'summary',
      callNumber: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      rawEventIds: ['raw-summary-1', 'raw-summary-2'],
      startedAt: 1_700_000_001_000,
    });

    const rawResponse = 'SUMMARY: durable ledger response\nFACTS:\n- persisted only as a digest';
    repo.completeInvocation(
      invocationId,
      { input: 120, output: 30, total: 150 },
      rawResponse,
    );

    const storedContext = repo.findContextById(contextId);
    const invocation = repo.findInvocationById(invocationId);
    const sourceIds = repo.listSourceEventIds(invocationId);
    const rawContextRow = db.prepare('SELECT * FROM model_contexts WHERE id = ?')
      .get(contextId) as Record<string, unknown>;
    const serializedContext = JSON.stringify(rawContextRow);
    const invocationColumns = db.prepare('PRAGMA table_info(model_invocations)')
      .all() as Array<{ name: string }>;

    expect(storedContext).toMatchObject({
      id: context.id,
      jobAttemptId: 'attempt-summary-1',
      purpose: 'summary',
      conversationType: 'group',
      candidateMemoryIds: ['memory-candidate-1', 'memory-rejected-1'],
      selectedMemoryIds: ['memory-candidate-1'],
      recentMessageIds: ['chat-message-1', 'chat-message-2'],
    });
    expect(storedContext?.conversationRef).toMatch(/^ctxref-sha256:[a-f0-9]{64}$/);
    expect(storedContext?.groupRef).toMatch(/^groupref-sha256:[a-f0-9]{64}$/);
    expect(serializedContext).not.toContain('qq-group-9876543210');
    expect(serializedContext).not.toContain('Raw recent message must never be stored');
    expect(serializedContext).not.toContain('sk-context-ledger-secret-should-not-persist');
    expect(serializedContext).not.toContain('1234567890');
    expect(serializedContext).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedContext).toContain('[REDACTED:api_key_assignment]');
    expect(serializedContext).toContain('[REDACTED:platform_id]');

    expect(invocation).toMatchObject({
      id: invocationId,
      contextId,
      jobAttemptId: 'attempt-summary-1',
      purpose: 'summary',
      callNumber: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      status: 'completed',
      tokens: { input: 120, output: 30, total: 150 },
      responseSha256: createHash('sha256').update(rawResponse, 'utf8').digest('hex'),
      responseBytes: Buffer.byteLength(rawResponse, 'utf8'),
    });
    expect(invocation?.completedAt).toBeInstanceOf(Date);
    expect(invocation?.errorCode).toBeUndefined();
    expect(sourceIds).toEqual(['raw-summary-1', 'raw-summary-2']);
    expect(() => db.prepare('DELETE FROM raw_events WHERE id = ?').run('raw-summary-1'))
      .toThrow();
    expect(invocationColumns.map((column) => column.name)).not.toContain('response_text');
    expect(JSON.stringify(db.prepare('SELECT * FROM model_invocations').all()))
      .not.toContain(rawResponse);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('fails closed on duplicate calls and invalid terminal transitions', () => {
    const contextId = repo.createContext(buildContext(), 'attempt-summary-1', 'summary');
    const firstId = repo.startInvocation({
      id: 'invocation-failed-1',
      contextId,
      jobAttemptId: 'attempt-summary-1',
      purpose: 'summary',
      callNumber: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      rawEventIds: ['raw-summary-1', 'raw-summary-2'],
    });

    repo.failInvocation(firstId, 'provider_timeout', 'failed');

    expect(repo.findInvocationById(firstId)).toMatchObject({
      status: 'failed',
      errorCode: 'provider_timeout',
    });
    expect(() => repo.failInvocation(firstId, 'provider_timeout')).toThrow(
      'Invocation is not running',
    );
    expect(() => repo.completeInvocation(
      firstId,
      { input: 1, output: 1, total: 2 },
      'late response',
    )).toThrow('Invocation is not running');

    expect(() => repo.startInvocation({
      id: 'invocation-duplicate-call-number',
      contextId,
      jobAttemptId: 'attempt-summary-1',
      purpose: 'summary',
      callNumber: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      rawEventIds: ['raw-summary-1', 'raw-summary-2'],
    })).toThrow();
    expect(repo.listInvocationsForAttempt('attempt-summary-1')).toHaveLength(1);
    expect(() => repo.createContext(buildContext(), 'attempt-summary-1', 'summary')).toThrow();
  });

  it('aborts a running invocation when its owning job attempt leaves running', () => {
    const contextId = repo.createContext(buildContext(), 'attempt-summary-1', 'summary');
    const invocationId = repo.startInvocation({
      id: 'invocation-trigger-abort',
      contextId,
      jobAttemptId: 'attempt-summary-1',
      purpose: 'summary',
      callNumber: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      rawEventIds: ['raw-summary-1', 'raw-summary-2'],
      startedAt: 1_700_000_001_000,
    });

    db.prepare(
      `UPDATE job_attempts
       SET status = 'completed', completed_at = ?, heartbeat_at = ?
       WHERE id = ?`,
    ).run(1_700_000_002_000, 1_700_000_002_000, 'attempt-summary-1');

    expect(repo.findInvocationById(invocationId)).toMatchObject({
      status: 'aborted',
      completedAt: new Date(1_700_000_002_000),
      errorCode: 'job_attempt_ended',
    });
    expect(() => repo.completeInvocation(
      invocationId,
      { input: 1, output: 1, total: 2 },
      'response after cancellation',
    )).toThrow('Invocation is not running');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('does not block a legacy terminal attempt update with no completion and an older heartbeat', () => {
    const contextId = repo.createContext(buildContext(), 'attempt-summary-1', 'summary');
    const startedAt = 1_700_000_005_000;
    const invocationId = repo.startInvocation({
      id: 'invocation-legacy-trigger-abort',
      contextId,
      jobAttemptId: 'attempt-summary-1',
      purpose: 'summary',
      callNumber: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      rawEventIds: ['raw-summary-1', 'raw-summary-2'],
      startedAt,
    });

    expect(() => db.prepare(
      `UPDATE job_attempts
       SET status = 'failed', completed_at = NULL, heartbeat_at = ?
       WHERE id = ?`,
    ).run(startedAt - 10_000, 'attempt-summary-1')).not.toThrow();

    expect(repo.findInvocationById(invocationId)).toMatchObject({
      status: 'aborted',
      completedAt: new Date(startedAt),
      errorCode: 'job_attempt_ended',
    });
    expect(db.prepare('SELECT status, completed_at FROM job_attempts WHERE id = ?')
      .get('attempt-summary-1')).toEqual({ status: 'failed', completed_at: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects any missing, duplicate, reordered, extra, or wrong source without partial writes', () => {
    const contextId = repo.createContext(buildContext(), 'attempt-summary-1', 'summary');
    const mismatches = [
      { name: 'missing', rawEventIds: ['raw-summary-1'] },
      { name: 'duplicate', rawEventIds: ['raw-summary-1', 'raw-summary-1'] },
      { name: 'reordered', rawEventIds: ['raw-summary-2', 'raw-summary-1'] },
      {
        name: 'extra',
        rawEventIds: ['raw-summary-1', 'raw-summary-2', 'raw-summary-extra'],
      },
      { name: 'wrong-existing', rawEventIds: ['raw-summary-1', 'raw-summary-extra'] },
      { name: 'nonexistent', rawEventIds: ['raw-summary-1', 'raw-event-does-not-exist'] },
    ];

    for (const mismatch of mismatches) {
      const invocationId = `invocation-source-${mismatch.name}`;
      expect(() => repo.startInvocation({
        id: invocationId,
        contextId,
        jobAttemptId: 'attempt-summary-1',
        purpose: 'summary',
        callNumber: 1,
        provider: 'deepseek',
        model: 'deepseek-chat',
        rawEventIds: mismatch.rawEventIds,
      })).toThrow();
      expect(repo.findInvocationById(invocationId)).toBeNull();
      expect(db.prepare('SELECT * FROM model_invocation_sources').all()).toHaveLength(0);
    }

    db.prepare('DELETE FROM chat_messages WHERE id = ?').run('chat-message-2');
    expect(() => repo.startInvocation({
      id: 'invocation-source-missing-message',
      contextId,
      jobAttemptId: 'attempt-summary-1',
      purpose: 'summary',
      callNumber: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      rawEventIds: ['raw-summary-1', 'raw-summary-2'],
    })).toThrow('Invocation sources do not exactly match context messages');
    expect(repo.findInvocationById('invocation-source-missing-message')).toBeNull();
    expect(db.prepare('SELECT * FROM model_invocation_sources').all()).toHaveLength(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects mismatched or non-running attempt ownership before writing rows', () => {
    insertRunningAttempt('job-summary-2', 'attempt-summary-2');
    const contextId = repo.createContext(buildContext(), 'attempt-summary-1', 'summary');

    expect(() => repo.startInvocation({
      id: 'invocation-wrong-attempt',
      contextId,
      jobAttemptId: 'attempt-summary-2',
      purpose: 'summary',
      callNumber: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      rawEventIds: ['raw-summary-1', 'raw-summary-2'],
    })).toThrow('Context does not belong to the running attempt');

    db.prepare(
      `UPDATE job_attempts SET status = 'failed', completed_at = ?, heartbeat_at = ? WHERE id = ?`,
    ).run(Date.now(), Date.now(), 'attempt-summary-2');
    expect(() => repo.createContext(
      { ...buildContext(), id: 'context-non-running-attempt' },
      'attempt-summary-2',
      'summary',
    )).toThrow('Job attempt is not running');
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_invocations').get())
      .toEqual({ count: 0 });
  });

  it('bounds and redacts provider, model, and error metadata', () => {
    const rawSecret = 'sk-model-ledger-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';
    const contextId = repo.createContext(buildContext(), 'attempt-summary-1', 'summary');
    const invocationId = repo.startInvocation({
      id: 'invocation-redacted-metadata',
      contextId,
      jobAttemptId: 'attempt-summary-1',
      purpose: 'summary',
      callNumber: 1,
      provider: `provider api_key=${rawSecret}-${rawPlatformId} ${'p'.repeat(300)}`,
      model: `model ${rawSecret}-${rawPlatformId} ${'m'.repeat(300)}`,
      rawEventIds: ['raw-summary-1', 'raw-summary-2'],
    });

    repo.failInvocation(
      invocationId,
      `provider_error api_key=${rawSecret}-${rawPlatformId} ${'e'.repeat(700)}`,
    );

    const invocation = repo.findInvocationById(invocationId);
    const serialized = JSON.stringify(invocation);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawPlatformId);
    expect(serialized).not.toContain('1234567890');
    expect(serialized).toContain('[REDACTED:api_key_assignment]');
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(invocation?.provider.length).toBeLessThanOrEqual(128);
    expect(invocation?.model.length).toBeLessThanOrEqual(256);
    expect(invocation?.errorCode?.length).toBeLessThanOrEqual(256);
  });

  it('persists and validates one completed turn-owned evaluator invocation without content', () => {
    const requestCreatedAt = Date.now() - 1_000;
    insertRawEvent('raw-evaluator-trigger');
    insertRawEvent('raw-evaluator-related');
    insertRunningTurn('turn-evaluator-1', 'raw-evaluator-trigger', requestCreatedAt);
    const request = buildToolEvaluationRequest(requestCreatedAt);
    const invocationId = repo.startEvaluatorInvocation({
      id: 'invocation-evaluator-1',
      requestId: request.requestId,
      domain: request.domain,
      turnId: request.turnId,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
      startedAt: requestCreatedAt + 1,
    });
    const responseText = JSON.stringify({
      domain: 'tool',
      decision: 'approve',
      reason: 'Allowed without persisting this response',
      confidence: 0.9,
      riskLevel: 'medium',
    });
    repo.completeInvocation(
      invocationId,
      { input: 20, output: 10, total: 30 },
      responseText,
    );
    const result = buildToolEvaluationResult(invocationId, new Date(Date.now() + 1));

    expect(repo.findInvocationById(invocationId)).toMatchObject({
      id: invocationId,
      turnId: request.turnId,
      purpose: 'evaluator',
      callNumber: 1,
      evaluatorRequestId: request.requestId,
      evaluatorDomain: 'tool',
      promptVersion: 'governance-v1',
      provider: 'openai',
      model: 'gpt-4',
      status: 'completed',
      tokens: { input: 20, output: 10, total: 30 },
    });
    expect(repo.listSourceEventIds(invocationId)).toEqual(request.sourceEventIds);
    expect(() => assertEvaluatorInvocationBinding(db, request, result)).not.toThrow();
    expect(JSON.stringify(db.prepare('SELECT * FROM model_invocations WHERE id = ?').get(invocationId)))
      .not.toContain(responseText);

    insertToolEvaluatorDecision(request, result);
    expect(() => assertEvaluatorInvocationBinding(db, request, result)).toThrow(
      'Evaluator model invocation is already linked to a decision',
    );
    expect(() => repo.startEvaluatorInvocation({
      id: 'invocation-evaluator-private-id-version',
      requestId: 'request-evaluator-private-id-version',
      domain: 'tool',
      turnId: request.turnId,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: '123456789',
      rawEventIds: request.sourceEventIds,
    })).toThrow('Prompt version contains prohibited identity metadata');
    expect(repo.findInvocationById('invocation-evaluator-private-id-version')).toBeNull();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('persists and binds one correction only after matching invalid structured output', () => {
    const requestCreatedAt = Date.now() - 1_000;
    insertRawEvent('raw-evaluator-trigger');
    insertRawEvent('raw-evaluator-related');
    insertRunningTurn('turn-evaluator-1', 'raw-evaluator-trigger', requestCreatedAt);
    const request = buildToolEvaluationRequest(requestCreatedAt);
    const firstInvocationId = repo.startEvaluatorInvocation({
      id: 'invocation-evaluator-correction-1',
      requestId: request.requestId,
      domain: request.domain,
      turnId: request.turnId,
      callNumber: 1,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
      startedAt: requestCreatedAt + 1,
    });
    repo.failInvocation(firstInvocationId, 'invalid_structured_output');
    const firstCompletedAt = repo.findInvocationById(firstInvocationId)?.completedAt?.getTime();
    if (firstCompletedAt === undefined) {
      throw new Error('Expected a terminal first evaluator attempt');
    }

    const correctionInvocationId = repo.startEvaluatorInvocation({
      id: 'invocation-evaluator-correction-2',
      requestId: request.requestId,
      domain: request.domain,
      turnId: request.turnId,
      callNumber: 2,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
      startedAt: firstCompletedAt,
    });
    repo.completeInvocation(
      correctionInvocationId,
      { input: 22, output: 8, total: 30 },
      '{"domain":"tool","decision":"approve"}',
    );
    const result = buildToolEvaluationResult(
      correctionInvocationId,
      new Date(Date.now() + 1),
    );

    expect(db.prepare(
      `SELECT id, call_number, status, error_code
       FROM model_invocations
       WHERE evaluator_request_id = ?
       ORDER BY call_number`,
    ).all(request.requestId)).toEqual([
      {
        id: firstInvocationId,
        call_number: 1,
        status: 'failed',
        error_code: 'invalid_structured_output',
      },
      {
        id: correctionInvocationId,
        call_number: 2,
        status: 'completed',
        error_code: null,
      },
    ]);
    expect(() => assertEvaluatorInvocationBinding(db, request, result)).not.toThrow();
    db.prepare('UPDATE model_invocations SET started_at = ? WHERE id = ?').run(
      requestCreatedAt - 1,
      firstInvocationId,
    );
    expect(() => assertEvaluatorInvocationBinding(db, request, result)).toThrow(
      'Evaluator model invocation does not match evaluator evidence',
    );
    expect(() => repo.startEvaluatorInvocation({
      id: 'invocation-evaluator-correction-3',
      requestId: request.requestId,
      domain: request.domain,
      turnId: request.turnId,
      callNumber: 3 as 2,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
    })).toThrow('Evaluator call number must be 1 or 2');
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects a correction unless every first-attempt binding field matches', () => {
    const requestCreatedAt = Date.now() - 1_000;
    insertRawEvent('raw-evaluator-trigger');
    insertRawEvent('raw-evaluator-related');
    insertRunningTurn('turn-evaluator-1', 'raw-evaluator-trigger', requestCreatedAt);
    insertRunningTurn('turn-evaluator-2', 'raw-evaluator-trigger', requestCreatedAt);
    const request = buildToolEvaluationRequest(requestCreatedAt);

    expect(() => repo.startEvaluatorInvocation({
      id: 'invocation-correction-without-first',
      requestId: request.requestId,
      domain: request.domain,
      turnId: request.turnId,
      callNumber: 2,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
    })).toThrow('Evaluator correction requires matching invalid structured output');

    const firstInvocationId = repo.startEvaluatorInvocation({
      id: 'invocation-correction-binding-first',
      requestId: request.requestId,
      domain: request.domain,
      turnId: request.turnId,
      callNumber: 1,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
    });
    repo.failInvocation(firstInvocationId, 'invalid_structured_output');

    const mismatches = [
      { label: 'domain', domain: 'social' as const },
      { label: 'owner', turnId: 'turn-evaluator-2' },
      { label: 'provider', provider: 'deepseek' },
      { label: 'model', model: 'other-model' },
      { label: 'prompt', promptVersion: 'governance-v2' },
      { label: 'sources', rawEventIds: [...request.sourceEventIds].reverse() },
    ];
    for (const mismatch of mismatches) {
      expect(() => repo.startEvaluatorInvocation({
        id: `invocation-correction-mismatch-${mismatch.label}`,
        requestId: request.requestId,
        domain: mismatch.domain ?? request.domain,
        turnId: mismatch.turnId ?? request.turnId,
        callNumber: 2,
        provider: mismatch.provider ?? 'openai',
        model: mismatch.model ?? 'gpt-4',
        promptVersion: mismatch.promptVersion ?? 'governance-v1',
        rawEventIds: mismatch.rawEventIds ?? request.sourceEventIds,
      })).toThrow('Evaluator correction requires matching invalid structured output');
    }

    const otherRequestId = 'request-evaluator-non-correctable';
    const nonCorrectableId = repo.startEvaluatorInvocation({
      id: 'invocation-correction-non-correctable-first',
      requestId: otherRequestId,
      domain: request.domain,
      turnId: request.turnId,
      callNumber: 1,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
    });
    repo.failInvocation(nonCorrectableId, 'provider_failed');
    expect(() => repo.startEvaluatorInvocation({
      id: 'invocation-correction-after-provider-failure',
      requestId: otherRequestId,
      domain: request.domain,
      turnId: request.turnId,
      callNumber: 2,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
    })).toThrow('Evaluator correction requires matching invalid structured output');

    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM model_invocations WHERE call_number = 2',
    ).get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects mismatched evaluator invocation bindings and terminal failure evidence', () => {
    const requestCreatedAt = Date.now() - 1_000;
    insertRawEvent('raw-evaluator-trigger');
    insertRawEvent('raw-evaluator-related');
    insertRunningTurn('turn-evaluator-1', 'raw-evaluator-trigger', requestCreatedAt);
    const request = buildToolEvaluationRequest(requestCreatedAt);
    const invocationId = repo.startEvaluatorInvocation({
      id: 'invocation-evaluator-mismatch',
      requestId: request.requestId,
      domain: request.domain,
      turnId: request.turnId,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
    });
    repo.completeInvocation(invocationId, { input: 1, output: 1, total: 2 }, '{}');
    const result = buildToolEvaluationResult(invocationId, new Date(Date.now() + 1));

    expect(() => assertEvaluatorInvocationBinding(db, {
      ...request,
      sourceEventIds: [...request.sourceEventIds].reverse(),
    }, result)).toThrow('Evaluator model invocation sources do not match evaluator evidence');
    expect(() => assertEvaluatorInvocationBinding(db, request, {
      ...result,
      evaluatorVersion: 'openai/other/governance-v1',
    })).toThrow('Evaluator model invocation does not match evaluator evidence');
    expect(() => assertEvaluatorInvocationBinding(db, {
      ...request,
      turnId: 'different-turn',
    }, result)).toThrow('Evaluator model invocation does not match evaluator evidence');

    const failedId = repo.startEvaluatorInvocation({
      id: 'invocation-evaluator-failed',
      requestId: 'request-evaluator-failed',
      domain: 'tool',
      turnId: request.turnId,
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: request.sourceEventIds,
    });
    repo.failInvocation(failedId, 'invalid_structured_output');
    expect(repo.findInvocationById(failedId)).toMatchObject({
      status: 'failed',
      errorCode: 'invalid_structured_output',
    });
    expect(() => assertEvaluatorInvocationBinding(db, request, {
      ...result,
      modelInvocationId: failedId,
    })).toThrow('Evaluator model invocation does not match evaluator evidence');
    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get())
      .toEqual({ count: 0 });

    db.prepare(
      "UPDATE agent_turns SET status = 'completed', completed_at = ? WHERE id = ?",
    ).run(Date.now() + 1, request.turnId);
    expect(() => assertEvaluatorInvocationBinding(db, request, result)).toThrow(
      'Evaluator model invocation owner is no longer active',
    );
  });

  it('requires active extraction lease authority for job-owned evaluator invocations', () => {
    const now = Date.now();
    insertRawEvent('raw-evaluator-memory');
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        lease_owner, lease_expires_at, heartbeat_at,
        created_at, updated_at, scheduled_at, started_at
      ) VALUES (?, 'extraction', '{}', 'running', 1, 3, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'job-evaluator-memory',
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
      ) VALUES (?, ?, 1, ?, 'running', ?, ?)`,
    ).run(
      'attempt-evaluator-memory',
      'job-evaluator-memory',
      'worker-evaluator-memory',
      now,
      now,
    );

    const invocationId = repo.startEvaluatorInvocation({
      id: 'invocation-evaluator-memory',
      requestId: 'request-evaluator-memory',
      domain: 'memory',
      jobAttemptId: 'attempt-evaluator-memory',
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: ['raw-evaluator-memory'],
      startedAt: now + 1,
    });
    expect(repo.findInvocationById(invocationId)).toMatchObject({
      jobAttemptId: 'attempt-evaluator-memory',
      purpose: 'evaluator',
      evaluatorDomain: 'memory',
    });

    const expiredClockRepo = new ModelInvocationRepository(db, () => now + 120_000);
    expect(() => expiredClockRepo.startEvaluatorInvocation({
      id: 'invocation-evaluator-expired-before-lock',
      requestId: 'request-evaluator-expired-before-lock',
      domain: 'memory',
      jobAttemptId: 'attempt-evaluator-memory',
      provider: 'openai',
      model: 'gpt-4',
      promptVersion: 'governance-v1',
      rawEventIds: ['raw-evaluator-memory'],
      startedAt: now + 2,
    })).toThrow('Evaluator invocation requires an active extraction job attempt');

    db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?')
      .run(now, 'job-evaluator-memory');
    expect(() => repo.completeInvocation(
      invocationId,
      { input: 1, output: 1, total: 2 },
      '{}',
    )).toThrow('Invocation is not running');
    repo.failInvocation(invocationId, 'authority_lost', 'aborted');
    expect(repo.findInvocationById(invocationId)).toMatchObject({
      status: 'aborted',
      errorCode: 'authority_lost',
    });
  });

  it('adds all ledger tables and the abort trigger when upgrading an existing schema', () => {
    const legacyDb = initDatabase({ path: join(testDir, 'legacy-v1.db') });
    try {
      const initialMigration = join(__dirname, '../../../migrations/001_initial_schema.sql');
      runMigration(legacyDb, initialMigration);
      legacyDb.exec(`
        DROP TRIGGER trg_abort_running_model_invocations_after_attempt;
        DROP TABLE model_invocation_sources;
        DROP TABLE model_invocations;
        DROP TABLE model_contexts;
      `);

      runMigration(legacyDb, initialMigration);

      const objects = legacyDb.prepare(
        `SELECT type, name
         FROM sqlite_master
         WHERE name IN (
           'model_contexts',
           'model_invocations',
           'model_invocation_sources',
           'trg_abort_running_model_invocations_after_attempt'
         )
         ORDER BY type, name`,
      ).all();
      expect(objects).toEqual([
        { type: 'table', name: 'model_contexts' },
        { type: 'table', name: 'model_invocation_sources' },
        { type: 'table', name: 'model_invocations' },
        { type: 'trigger', name: 'trg_abort_running_model_invocations_after_attempt' },
      ]);
      expect(legacyDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(legacyDb);
    }
  });

  function insertRunningAttempt(jobId: string, attemptId: string): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at, started_at
      ) VALUES (?, 'summary', '{}', 'running', 1, 3, ?, ?, ?, ?)`,
    ).run(jobId, now, now, now, now);
    db.prepare(
      `INSERT INTO job_attempts (
        id, job_id, attempt_number, worker_id, status, started_at, heartbeat_at
      ) VALUES (?, ?, 1, 'summary-worker-test', 'running', ?, ?)`,
    ).run(attemptId, jobId, now, now);
  }

  function insertRawEvent(id: string): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, 'message.group', ?, 'gateway', 'qq', 'private-db-conversation', '{}', ?)`,
    ).run(id, now, now);
  }

  function insertChatMessage(id: string, rawEventId: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, timestamp
      ) VALUES (?, ?, ?, 'private-db-conversation', 'group',
        'private-db-group', 'private-db-sender', 'fixture text', ?)`,
    ).run(id, rawEventId, `platform-${id}`, timestamp);
  }

  function insertRunningTurn(turnId: string, triggerEventId: string, startedAt: number): void {
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
      ) VALUES (?, 'evaluator-conversation', ?, 'test-model', 'test-provider', 'running', ?)`,
    ).run(turnId, triggerEventId, startedAt);
  }

  function insertToolEvaluatorDecision(
    request: ToolEvaluationRequest,
    result: ToolEvaluationResult,
  ): void {
    db.prepare(
      `INSERT INTO evaluator_decisions (
        id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
        evaluator_version, tool_name, actor_user_id, actor_class,
        invocation_context, source_event_ids, request_created_at, decided_at,
        model_invocation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      result.decisionId,
      result.requestId,
      request.domain,
      request.turnId,
      result.decision,
      result.reason,
      result.confidence,
      result.riskLevel,
      result.evaluatorVersion,
      request.toolName,
      request.actor.canonicalUserId ?? null,
      request.actor.actorClass,
      request.context,
      JSON.stringify(request.sourceEventIds),
      request.createdAt.getTime(),
      result.decidedAt.getTime(),
      result.modelInvocationId ?? null,
    );
  }
});

function buildToolEvaluationRequest(createdAt: number): ToolEvaluationRequest {
  return {
    requestId: 'request-evaluator-1',
    domain: 'tool',
    turnId: 'turn-evaluator-1',
    actor: { canonicalUserId: 'user-evaluator-1', actorClass: 'user' },
    context: 'private_chat',
    sourceEventIds: ['raw-evaluator-trigger', 'raw-evaluator-related'],
    contextSummary: 'bounded evaluator context',
    createdAt: new Date(createdAt),
    toolName: 'memory.propose',
    capabilities: ['modifies_memory'],
    toolInput: {},
    proposedReason: 'test evaluator invocation evidence',
  };
}

function buildToolEvaluationResult(
  modelInvocationId: string,
  decidedAt: Date,
): ToolEvaluationResult {
  return {
    decisionId: 'decision-evaluator-1',
    requestId: 'request-evaluator-1',
    domain: 'tool',
    decision: 'approve',
    reason: 'Approved by model evaluator',
    confidence: 0.9,
    riskLevel: 'medium',
    decidedAt,
    evaluatorVersion: 'openai/gpt-4/governance-v1',
    modelInvocationId,
  };
}

function buildContext(): ContextPack {
  return {
    id: 'model-context-summary-1',
    turnId: 'summary-turn-opaque-1',
    createdAt: new Date(1_700_000_000_000),
    conversation: {
      conversationId: 'qq-group-9876543210',
      conversationType: 'group',
      groupId: 'qq-group-9876543210',
    },
    recentMessages: [
      {
        messageId: 'chat-message-1',
        senderId: 'participant_1',
        senderDisplayName: 'participant_1',
        text: 'Raw recent message must never be stored',
        timestamp: new Date(1_700_000_000_000),
        isFromBot: false,
      },
      {
        messageId: 'chat-message-2',
        senderId: 'bot',
        senderDisplayName: 'bot',
        text: 'Raw bot response must never be stored',
        timestamp: new Date(1_700_000_000_100),
        isFromBot: true,
      },
    ],
    memory: {
      retrievedFacts: [
        {
          memoryId: 'memory-candidate-1',
          scope: 'group',
          kind: 'fact',
          title: 'title sk-context-ledger-secret-should-not-persist qq-1234567890',
          content: 'Raw memory content must never be stored',
          confidence: 0.9,
          sourceContext:
            'background api_key=sk-context-ledger-assignment-should-not-persist-qq-1234567890',
        },
      ],
      selectedMemoryIds: ['memory-candidate-1'],
    },
    participants: [],
    injectedIdentityFields: [
      'conversation_id',
      'identity api_key=sk-context-ledger-identity-should-not-persist qq-1234567890',
    ],
    trace: {
      candidateMemoryIds: ['memory-candidate-1', 'memory-rejected-1'],
      selectedMemoryIds: ['memory-candidate-1'],
      rejectedMemories: [
        {
          memoryId: 'memory-rejected-1',
          reason: 'filtered token=sk-context-ledger-token-should-not-persist qq-1234567890',
        },
      ],
      filtersApplied: [
        'state=active',
        'filter sk-context-ledger-filter-should-not-persist qq-1234567890',
      ],
    },
    tokenBudget: {
      max: 8_000,
      used: 200,
      breakdown: {
        recentMessages: 100,
        memory: 40,
        identity: 20,
        system: 40,
      },
      promptLayers: [
        {
          name: 'recent_messages sk-context-ledger-layer-should-not-persist',
          version: 'summary-v1 qq-1234567890',
          tokens: 100,
        },
      ],
    },
  };
}
