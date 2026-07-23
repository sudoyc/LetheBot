import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigrations, closeDatabase } from '../../../src/storage/database';
import {
  isAutomaticExtractionCandidate,
  MemoryExtractionWorker,
  MemoryExtractionError,
  type ExtractionPattern,
} from '../../../src/workers/memory-extraction';
import { MemoryRepository, type MemoryRecordInput } from '../../../src/storage/memory-repository';
import { PrivacyPreferenceRepository } from '../../../src/storage/privacy-preference-repository';
import { AuditRepository } from '../../../src/storage/audit-repository';
import { EvaluatorDecisionRepository } from '../../../src/storage/evaluator-decision-repository';
import { JobRepository } from '../../../src/storage/job-repository';
import { MemoryProposalService } from '../../../src/memory/proposal-service';
import type { MemoryEvaluationRequest, MemoryEvaluationResult } from '../../../src/types/evaluator';
import { getLogger } from '../../../src/logger';

describe('isAutomaticExtractionCandidate', () => {
  it.each([
    '你好，我叫 合成用户',
    '我是 合成工程师',
    '我的 爱好 是 合成阅读',
    '我喜欢 合成测试',
    '我不喜欢 合成噪声',
    '我想要 合成工具',
    '我需要 合成帮助',
  ])('preserves the existing private extraction pattern for %s', (text) => {
    expect(isAutomaticExtractionCandidate({
      text,
      conversationType: 'private',
    })).toBe(true);
  });

  it.each([
    '我叫 合成用户',
    '我的 爱好 是 合成阅读',
    '我喜欢 合成测试',
    '我不喜欢 合成噪声。',
    '我喜欢 我的工作',
    '我喜欢我的猫',
  ])('accepts an exact high-precision group statement for %s', (text) => {
    expect(isAutomaticExtractionCandidate({
      text,
      conversationType: 'group',
    })).toBe(true);
  });

  it.each([
    ['ordinary chatter', '今天天气不错'],
    ['ambiguous identity', '我是 合成工程师'],
    ['embedded self-report', '会议记录：我喜欢 合成测试'],
    ['third-party report', '他说我喜欢 合成测试'],
    ['question', '我喜欢 合成测试吗？'],
    ['hypothetical', '如果我喜欢 合成测试，就参加活动'],
    ['transient want', '我想要 合成工具'],
    ['transient need', '我需要 合成帮助'],
    ['nested third-party report', '我的备注是他说我喜欢 合成测试'],
    ['nested hypothetical', '我的假设是如果我喜欢 合成测试就参加'],
    ['hypothetical suffix', '我喜欢 合成测试的话就参加'],
    ['nested transient want', '我的愿望是我想要 合成工具'],
    ['question asking name', '我叫谁'],
    ['question asking attribute', '我的爱好是什么'],
    ['question challenging attribute', '我的爱好是不是合成阅读'],
    ['question asking preference', '我喜欢什么'],
    ['question confirmation suffix', '我喜欢 合成测试对不对'],
    ['alternative name question', '我叫合成用户还是合成成员'],
    ['alternative attribute question', '我的爱好是合成阅读还是合成测试'],
    ['alternative preference question', '我喜欢合成阅读还是合成测试'],
    ['A-not-A name question', '我叫不叫合成用户'],
    ['A-not-A preference question', '我喜欢不喜欢合成测试'],
    ['repeated negative preference form', '我不喜欢不喜欢合成测试'],
    ['conditional suffix', '我喜欢 合成测试才会参加'],
    ['named report suffix', '我喜欢 合成测试是合成成员说的'],
  ])('rejects %s in group chat', (_caseName, text) => {
    expect(isAutomaticExtractionCandidate({
      text,
      conversationType: 'group',
    })).toBe(false);
  });
});

describe('MemoryExtractionWorker', () => {
  let testDir: string;
  let db: Database.Database;
  let worker: MemoryExtractionWorker;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-extraction-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigrations(db, join(__dirname, '../../../migrations'));
    worker = new MemoryExtractionWorker(db);
  });

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Constructor', () => {
    it('should initialize with db parameter only', () => {
      const w = new MemoryExtractionWorker(db);
      expect(w).toBeDefined();
      expect(w.getPatterns().length).toBeGreaterThan(0);
    });

    it('should initialize with memoryRepo parameter', () => {
      const repo = new MemoryRepository(db);
      const w = new MemoryExtractionWorker(db, repo);
      expect(w).toBeDefined();
    });

    it('should initialize with custom patterns', () => {
      const customPatterns: ExtractionPattern[] = [
        {
          regex: /test pattern/,
          type: 'preference',
          sensitivity: 'normal',
          confidence: 0.5,
          importance: 0.5,
        },
      ];
      const w = new MemoryExtractionWorker(db, undefined, customPatterns);
      expect(w.getPatterns()).toHaveLength(1);
    });

    it('should throw error when db is null', () => {
      expect(() => new MemoryExtractionWorker(null as any)).toThrow('Database instance is required');
    });
  });

  describe('extractFromTurn', () => {
    it('should successfully extract name', async () => {
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-001',
        userId: 'user-alice',
        userMessage: '你好，我叫Alice',
        botResponse: '你好Alice',
      });

      expect(result.matched).toBe(true);
      expect(result.count).toBe(1);
      expect(result.memoryIds).toHaveLength(1);

      // 验证数据库中的记录
      const memory = db
        .prepare('SELECT * FROM memory_records WHERE id = ?')
        .get(result.memoryIds[0]) as any;

      expect(memory).toBeDefined();
      expect(memory.title).toContain('name');
      expect(memory.title).toContain('Alice');
      expect(memory.canonical_user_id).toBe('user-alice');
      expect(memory.sensitivity).toBe('personal');
    });

    it('should successfully extract preference', async () => {
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-002',
        userId: 'user-bob',
        userMessage: '我喜欢编程',
        botResponse: '编程是很有趣的活动',
      });

      expect(result.matched).toBe(true);
      expect(result.count).toBe(1);

      const memory = db
        .prepare('SELECT * FROM memory_records WHERE id = ?')
        .get(result.memoryIds[0]) as any;

      expect(memory.content).toBe('我喜欢编程');
      expect(memory.sensitivity).toBe('normal');
    });

    it('should successfully extract attribute', async () => {
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-003',
        userId: 'user-charlie',
        userMessage: '我的爱好是阅读',
        botResponse: '阅读是很好的习惯',
      });

      expect(result.matched).toBe(true);
      expect(result.count).toBe(1);

      const memory = db
        .prepare('SELECT * FROM memory_records WHERE id = ?')
        .get(result.memoryIds[0]) as any;

      expect(memory.title).toContain('attribute');
    });

    it('should match multiple patterns in single message', async () => {
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-004',
        userId: 'user-dave',
        userMessage: '我叫Dave，我喜欢音乐',
        botResponse: '很高兴认识你',
      });

      expect(result.matched).toBe(true);
      expect(result.count).toBe(2);
      expect(result.memoryIds).toHaveLength(2);
    });

    it('should return empty result when no match', async () => {
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-005',
        userId: 'user-eve',
        userMessage: '今天天气不错',
        botResponse: '是的，阳光明媚',
      });

      expect(result.matched).toBe(false);
      expect(result.count).toBe(0);
      expect(result.memoryIds).toHaveLength(0);
    });

    it.each([
      '我的备注是他说我喜欢 合成测试',
      '我的假设是如果我喜欢 合成测试就参加',
      '我喜欢 合成测试的话就参加',
      '我的愿望是我想要 合成工具',
      '我叫谁',
      '我的爱好是什么',
      '我的爱好是不是合成阅读',
      '我喜欢什么',
      '我喜欢 合成测试对不对',
      '我叫合成用户还是合成成员',
      '我的爱好是合成阅读还是合成测试',
      '我喜欢合成阅读还是合成测试',
      '我叫不叫合成用户',
      '我喜欢不喜欢合成测试',
      '我不喜欢不喜欢合成测试',
      '我喜欢 合成测试才会参加',
      '我喜欢 合成测试是合成成员说的',
    ])('should not extract nested or hypothetical group clauses from %s', async (userMessage) => {
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-group-nested-rejection',
        userId: 'user-group-nested-rejection',
        userMessage,
        botResponse: '',
        conversationType: 'group',
        groupId: 'group-nested-rejection',
      });

      expect(result).toEqual({
        matched: false,
        count: 0,
        memoryIds: [],
        errors: undefined,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get())
        .toEqual({ count: 0 });
    });

    it('should throw error when conversationId is missing', async () => {
      await expect(
        worker.extractFromTurn({
          conversationId: '',
          userId: 'user-test',
          userMessage: 'test',
          botResponse: 'test',
        })
      ).rejects.toThrow(MemoryExtractionError);
    });

    it('should throw error when userId is missing', async () => {
      await expect(
        worker.extractFromTurn({
          conversationId: 'conv-test',
          userId: '',
          userMessage: 'test',
          botResponse: 'test',
        })
      ).rejects.toThrow(MemoryExtractionError);
    });

    it('should throw error when userMessage is missing', async () => {
      await expect(
        worker.extractFromTurn({
          conversationId: 'conv-test',
          userId: 'user-test',
          userMessage: '',
          botResponse: 'test',
        })
      ).rejects.toThrow(MemoryExtractionError);
    });

    it('should correctly set sensitivity level', async () => {
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-006',
        userId: 'user-frank',
        userMessage: '我叫Frank',
        botResponse: '你好',
      });

      const memory = db
        .prepare('SELECT * FROM memory_records WHERE id = ?')
        .get(result.memoryIds[0]) as any;

      expect(memory.sensitivity).toBe('personal');
    });

    it('should correctly set sourceContext format', async () => {
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-007',
        userId: 'user-grace',
        userMessage: '我喜欢画画',
        botResponse: '很好',
        messageId: 'msg-123',
      });

      const memory = db
        .prepare('SELECT * FROM memory_records WHERE id = ?')
        .get(result.memoryIds[0]) as any;

      expect(memory.source_context).toBe('chat:conv-007:msg-123');
    });

    it('should reject matched extraction without a canonical message source', async () => {
      const result = await worker.extractFromTurn({
        conversationId: 'conv-008',
        userId: 'user-henry',
        userMessage: '我喜欢运动',
        botResponse: '很健康',
      });

      expect(result).toMatchObject({ matched: false, count: 0, memoryIds: [] });
      expect(result.errors).toHaveLength(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });
  });

  describe('extractBatch', () => {
    it('should process multiple turns', async () => {
      const result = await extractCanonicalBatch(db, worker, {
        conversationId: 'conv-batch-001',
        turns: [
          {
            userId: 'user-alice',
            userMessage: '我叫Alice',
            botResponse: '你好',
          },
          {
            userId: 'user-bob',
            userMessage: '我喜欢音乐',
            botResponse: '很好',
          },
          {
            userId: 'user-charlie',
            userMessage: '今天天气不错',
            botResponse: '是的',
          },
        ],
      });

      expect(result.matched).toBe(true);
      expect(result.count).toBe(2); // Alice的name和Bob的preference
      expect(result.memoryIds).toHaveLength(2);
    });

    it('should continue processing after partial failure', async () => {
      insertExtractionSource(db, {
        rawEventId: 'raw-batch-partial-valid',
        chatMessageId: 'chat-batch-partial-valid',
        targetUserId: 'user-dave',
        text: '我叫Dave',
        timestamp: 2001,
        conversationId: 'conv-batch-002',
      });
      const result = await worker.extractBatch({
        conversationId: 'conv-batch-002',
        turns: [
          {
            userId: 'user-dave',
            userMessage: '我叫Dave',
            botResponse: '你好',
            messageId: 'chat-batch-partial-valid',
            timestamp: 2001,
          },
          {
            userId: 'user-eve',
            userMessage: '我喜欢编程',
            botResponse: '很好',
            messageId: 'chat-batch-partial-missing',
          },
        ],
      });

      expect(result.count).toBe(1);
      expect(result.errors).toHaveLength(1);
    });

    it('should return empty result for empty turns array', async () => {
      const result = await extractCanonicalBatch(db, worker, {
        conversationId: 'conv-batch-003',
        turns: [],
      });

      expect(result.matched).toBe(false);
      expect(result.count).toBe(0);
      expect(result.memoryIds).toHaveLength(0);
    });

    it('should throw error when conversationId is missing', async () => {
      await expect(
        worker.extractBatch({
          conversationId: '',
          turns: [
            {
              userId: 'user-test',
              userMessage: 'test',
              botResponse: 'test',
            },
          ],
        })
      ).rejects.toThrow(MemoryExtractionError);
    });

    it('should aggregate all memoryIds and errors', async () => {
      const result = await extractCanonicalBatch(db, worker, {
        conversationId: 'conv-batch-004',
        turns: [
          {
            userId: 'user-frank',
            userMessage: '我叫Frank，我喜欢阅读',
            botResponse: '你好',
          },
          {
            userId: 'user-grace',
            userMessage: '我喜欢旅行',
            botResponse: '很好',
          },
        ],
      });

      expect(result.count).toBe(3); // Frank的name和preference，Grace的preference
      expect(result.memoryIds).toHaveLength(3);
    });
  });

  describe('getPatterns and setPatterns', () => {
    it('should return current patterns', () => {
      const patterns = worker.getPatterns();
      expect(patterns).toBeInstanceOf(Array);
      expect(patterns.length).toBeGreaterThan(0);
    });

    it('should update patterns and affect extraction', async () => {
      const customPatterns: ExtractionPattern[] = [
        {
          regex: /测试模式/,
          type: 'preference',
          sensitivity: 'normal',
          confidence: 0.9,
          importance: 0.8,
        },
      ];

      worker.setPatterns(customPatterns);

      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-009',
        userId: 'user-test',
        userMessage: '这是测试模式',
        botResponse: '收到',
      });

      expect(result.matched).toBe(true);
      expect(result.count).toBe(1);
    });

    it('should return empty result when patterns are empty', async () => {
      worker.setPatterns([]);

      const result = await worker.extractFromTurn({
        conversationId: 'conv-010',
        userId: 'user-test',
        userMessage: '我叫Test',
        botResponse: '你好',
      });

      expect(result.matched).toBe(false);
      expect(result.count).toBe(0);
    });
  });

  describe('Error handling', () => {
    it('should collect errors in result when memory creation fails', async () => {
      // 关闭数据库以触发错误
      closeDatabase(db);

      const result = await worker.extractFromTurn({
        conversationId: 'conv-error',
        userId: 'user-error',
        userMessage: '我叫Error',
        botResponse: 'test',
      });

      // 错误被收集而不是抛出
      expect(result.matched).toBe(false);
      expect(result.count).toBe(0);
      expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    });

    it('should include error code and context', async () => {
      try {
        await worker.extractFromTurn({
          conversationId: '',
          userId: 'user-test',
          userMessage: 'test',
          botResponse: 'test',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryExtractionError);
        const memError = error as MemoryExtractionError;
        expect(memError.code).toBe('INVALID_INPUT');
        expect(memError.context).toBeDefined();
      }
    });

    it('should reject secret-like extracted facts without durable memory rows', async () => {
      const result = await worker.extractFromTurn({
        conversationId: 'conv-secret',
        userId: 'user-secret',
        userMessage: '我的密钥是 sk-abcdefghijklmnopqrstuvwxyz123456',
        botResponse: '收到',
      });

      const rows = db
        .prepare('SELECT * FROM memory_records WHERE canonical_user_id = ?')
        .all('user-secret') as any[];

      expect(result.matched).toBe(false);
      expect(result.count).toBe(0);
      expect(result.errors).toBeDefined();
      expect(rows).toHaveLength(0);
    });
  });

  describe('Integration with MemoryRepository', () => {
    it('should use MemoryRepository when provided', async () => {
      const repo = new MemoryRepository(db);
      const workerWithRepo = new MemoryExtractionWorker(db, repo);

      const result = await extractCanonicalTurn(db, workerWithRepo, {
        conversationId: 'conv-repo-001',
        userId: 'user-repo',
        userMessage: '我叫RepoUser',
        botResponse: '你好',
      });

      expect(result.matched).toBe(true);
      expect(result.memoryIds).toHaveLength(1);

      // 验证记录可以通过repository查询到
      const memory = await repo.findById(result.memoryIds[0]);
      expect(memory).toBeDefined();
      expect(memory?.canonicalUserId).toBe('user-repo');
    });

    it('should create source, revision, and audit rows through the repository path', async () => {
      const workerWithInternalRepo = new MemoryExtractionWorker(db);

      insertExtractionSource(db, {
        rawEventId: 'raw-governed',
        chatMessageId: 'msg-governed',
        targetUserId: 'user-governed',
        text: '我喜欢测试治理链路',
        timestamp: 123456,
        conversationId: 'conv-governed',
      });

      const result = await workerWithInternalRepo.extractFromTurn({
        conversationId: 'conv-governed',
        userId: 'user-governed',
        userMessage: '我喜欢测试治理链路',
        botResponse: '好的',
        messageId: 'msg-governed',
        timestamp: 123456,
      });

      const memoryId = result.memoryIds[0];
      const sources = db
        .prepare('SELECT * FROM memory_sources WHERE memory_id = ?')
        .all(memoryId) as any[];
      const revisions = db
        .prepare('SELECT * FROM memory_revisions WHERE memory_id = ?')
        .all(memoryId) as any[];
      const auditRows = db
        .prepare("SELECT * FROM audit_log WHERE category = 'memory' AND event_id = ?")
        .all(memoryId) as any[];

      expect(sources).toHaveLength(1);
      expect(sources[0].source_id).toBe('msg-governed');
      expect(revisions).toHaveLength(1);
      expect(revisions[0].change_type).toBe('create');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].event_type).toBe('memory.create');
    });

    it('uses local L0 policy without manufacturing an orphan evaluator decision', async () => {
      const result = await extractCanonicalTurn(db, new MemoryExtractionWorker(db), {
        conversationId: 'conv-local-policy',
        userId: 'user-local-policy',
        userMessage: '我喜欢本地策略',
        botResponse: '收到',
      });
      const memory = db
        .prepare('SELECT evaluator_decision_id FROM memory_records WHERE id = ?')
        .get(result.memoryIds[0]) as { evaluator_decision_id: string };

      expect(memory.evaluator_decision_id).toBe(
        `policy:l0:active:${result.memoryIds[0]}`,
      );
      expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get())
        .toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('binds configured evaluation to raw-event and job-attempt authority and reuses it on retry', async () => {
      const now = 1_700_000_100_000;
      insertExtractionSource(db, {
        rawEventId: 'raw-configured-evaluator',
        chatMessageId: 'chat-configured-evaluator',
        targetUserId: 'user-configured-evaluator',
        text: '我喜欢原子评估链路',
        timestamp: now,
        conversationId: 'conv-configured-evaluator',
      });
      const jobRepo = new JobRepository(db);
      const jobId = jobRepo.enqueue({
        id: 'job-configured-evaluator',
        type: 'extraction',
        payload: {
          sourceChatMessageId: 'chat-configured-evaluator',
          targetUserId: 'user-configured-evaluator',
        },
        maxAttempts: 3,
        now,
      });
      const firstAttempt = jobRepo.claimNext({
        workerId: 'worker-configured-evaluator',
        now: now + 1,
        types: ['extraction'],
      });
      expect(firstAttempt).not.toBeNull();

      const evaluateMemory = vi.fn(
        async (request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> => ({
          domain: 'memory',
          decisionId: `decision-${request.requestId}`,
          requestId: request.requestId,
          decision: 'approve',
          reason: 'Approved with insufficient confidence for automatic activation',
          confidence: 0.84,
          riskLevel: 'low',
          decidedAt: new Date(request.createdAt.getTime() + 1),
          evaluatorVersion: 'worker-test-v1',
          recommendedState: 'active',
          recommendedVisibility: 'private_only',
          recommendedSensitivity: 'normal',
        }),
      );
      const memoryRepo = new MemoryRepository(db);
      const proposalService = new MemoryProposalService(memoryRepo, {
        evaluator: { evaluateMemory },
        evaluatorDecisionWriter: new EvaluatorDecisionRepository(db, () => now + 2),
        auditRepository: new AuditRepository(db),
        privacyPreferences: new PrivacyPreferenceRepository(db),
        now: () => now + 2,
      });
      const configuredWorker = new MemoryExtractionWorker(
        db,
        memoryRepo,
        undefined,
        proposalService,
      );

      const first = await configuredWorker.extractFromChatMessage({
        sourceChatMessageId: 'chat-configured-evaluator',
        targetUserId: 'user-configured-evaluator',
        jobAttemptId: firstAttempt?.attemptId,
      });
      const memoryId = first.memoryIds[0];
      const request = evaluateMemory.mock.calls[0]?.[0];
      const decision = db.prepare(
        `SELECT id, turn_id, job_attempt_id, source_event_ids, invocation_context
           FROM evaluator_decisions
          WHERE id = ?`,
      ).get(`decision-${request?.requestId}`) as {
        id: string;
        turn_id: string | null;
        job_attempt_id: string;
        source_event_ids: string;
        invocation_context: string;
      };

      expect(evaluateMemory).toHaveBeenCalledTimes(1);
      expect(request).toMatchObject({
        domain: 'memory',
        jobAttemptId: firstAttempt?.attemptId,
        actor: {
          canonicalUserId: 'user-configured-evaluator',
          actorClass: 'system_worker',
        },
        context: 'background_worker',
        sourceEventIds: ['raw-configured-evaluator'],
        memoryCandidate: {
          sourceContext: 'chat:conv-configured-evaluator:chat-configured-evaluator',
        },
      });
      expect('turnId' in (request ?? {})).toBe(false);
      expect(decision).toMatchObject({
        turn_id: null,
        job_attempt_id: firstAttempt?.attemptId,
        invocation_context: 'background_worker',
      });
      expect(JSON.parse(decision.source_event_ids)).toEqual(['raw-configured-evaluator']);
      expect(db.prepare(
        'SELECT state, source_context, evaluator_decision_id FROM memory_records WHERE id = ?',
      ).get(memoryId)).toEqual({
        state: 'proposed',
        source_context: 'chat:conv-configured-evaluator:chat-configured-evaluator',
        evaluator_decision_id: decision.id,
      });
      expect(db.prepare(
        'SELECT evaluator_decision_id FROM memory_revisions WHERE memory_id = ? AND revision_number = 1',
      ).get(memoryId)).toEqual({ evaluator_decision_id: decision.id });
      expect(db.prepare(
        "SELECT evaluator_decision_id FROM audit_log WHERE event_type = 'memory.create' AND event_id = ?",
      ).get(memoryId)).toEqual({ evaluator_decision_id: decision.id });

      await memoryRepo.approve(memoryId, {
        actor: {
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'admin approved extracted proposal before job retry',
      });
      const approvalPolicyId = `policy:l0:active:${memoryId}`;
      expect(db.prepare(
        'SELECT state, evaluator_decision_id FROM memory_records WHERE id = ?',
      ).get(memoryId)).toEqual({
        state: 'active',
        evaluator_decision_id: approvalPolicyId,
      });
      expect(db.prepare(
        `SELECT revision_number, change_type, evaluator_decision_id
           FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC`,
      ).all(memoryId)).toEqual([
        {
          revision_number: 1,
          change_type: 'create',
          evaluator_decision_id: decision.id,
        },
        {
          revision_number: 2,
          change_type: 'approve',
          evaluator_decision_id: approvalPolicyId,
        },
      ]);
      expect(db.prepare(
        `SELECT event_type, evaluator_decision_id
           FROM audit_log WHERE event_id = ? ORDER BY rowid ASC`,
      ).all(memoryId)).toEqual([
        { event_type: 'memory.create', evaluator_decision_id: decision.id },
        { event_type: 'memory.approve', evaluator_decision_id: approvalPolicyId },
      ]);

      jobRepo.fail({
        jobId,
        attemptId: firstAttempt?.attemptId ?? '',
        error: 'induced completion failure',
        now: now + 3,
      });
      const retryAttempt = jobRepo.claimNext({
        workerId: 'worker-configured-evaluator',
        now: now + 4,
        types: ['extraction'],
      });
      expect(retryAttempt).not.toBeNull();
      const replay = await configuredWorker.extractFromChatMessage({
        sourceChatMessageId: 'chat-configured-evaluator',
        targetUserId: 'user-configured-evaluator',
        jobAttemptId: retryAttempt?.attemptId,
      });

      expect(replay.memoryIds).toEqual([memoryId]);
      expect(evaluateMemory).toHaveBeenCalledTimes(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get())
        .toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get(memoryId))
        .toEqual({ count: 2 });
      expect(db.prepare('SELECT state, evaluator_decision_id FROM memory_records WHERE id = ?')
        .get(memoryId)).toEqual({ state: 'active', evaluator_decision_id: approvalPolicyId });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should keep group-chat-derived user memory as a proposal', async () => {
      const repo = new MemoryRepository(db);
      const workerWithRepo = new MemoryExtractionWorker(db, repo);

      insertExtractionSource(db, {
        rawEventId: 'raw-group-governed',
        chatMessageId: 'msg-group-governed',
        targetUserId: 'user-group-governed',
        text: '我喜欢群内技术讨论',
        timestamp: 123457,
        conversationId: 'conv-group-governed',
        conversationType: 'group',
        groupId: 'group-governed',
      });

      const result = await workerWithRepo.extractFromTurn({
        conversationId: 'conv-group-governed',
        userId: 'user-group-governed',
        userMessage: '我喜欢群内技术讨论',
        botResponse: '收到',
        messageId: 'msg-group-governed',
        timestamp: 123457,
        conversationType: 'group',
        groupId: 'group-governed',
      });

      const memory = db
        .prepare('SELECT * FROM memory_records WHERE id = ?')
        .get(result.memoryIds[0]) as any;
      const activeMemories = await repo.retrieve({
        canonicalUserId: 'user-group-governed',
      });

      expect(memory.state).toBe('proposed');
      expect(memory.source_context).toBe('group_chat');
      expect(memory.visibility).toBe('same_group_only');
      expect(activeMemories).toHaveLength(0);
    });

    it('should enforce memory-association opt-out through the default proposal service', async () => {
      const privacyRepo = new PrivacyPreferenceRepository(db);
      db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
        .run('user-optout', Date.now(), Date.now());
      privacyRepo.setOptOut({
        canonicalUserId: 'user-optout',
        preferenceType: 'memory_association',
        reason: 'User requested no memory association',
        actor: {
          actorClass: 'admin',
          context: 'admin_cli',
        },
      });

      const result = await worker.extractFromTurn({
        conversationId: 'conv-optout',
        userId: 'user-optout',
        userMessage: '我喜欢不会被记住',
        botResponse: '收到',
        messageId: 'msg-optout',
      });

      const memoryRows = db
        .prepare('SELECT * FROM memory_records WHERE canonical_user_id = ?')
        .all('user-optout');
      const rejectionAudit = db
        .prepare("SELECT * FROM audit_log WHERE event_type = 'memory.candidate_rejected'")
        .get() as { summary: string; details: string };

      expect(result.matched).toBe(false);
      expect(result.count).toBe(0);
      expect(result.memoryIds).toHaveLength(0);
      expect(result.errors?.[0]?.message).toBe('Memory candidate rejected by memory-association opt-out');
      expect(memoryRows).toHaveLength(0);
      expect(rejectionAudit.summary).toBe('Memory candidate rejected by memory-association opt-out');
      expect(rejectionAudit.details).not.toContain('不会被记住');
    });

    it('loads canonical chat provenance and reuses deterministic memory effects', async () => {
      insertExtractionSource(db, {
        rawEventId: 'raw-deterministic-source-1',
        chatMessageId: 'chat-deterministic-source-1',
        targetUserId: 'user-deterministic-source',
        text: '我喜欢确定性任务',
        timestamp: 123456789,
      });

      const [first, second] = await Promise.all([
        worker.extractFromChatMessage({
          sourceChatMessageId: 'chat-deterministic-source-1',
          targetUserId: 'user-deterministic-source',
        }),
        worker.extractFromChatMessage({
          sourceChatMessageId: 'chat-deterministic-source-1',
          targetUserId: 'user-deterministic-source',
        }),
      ]);
      const memoryId = first.memoryIds[0];

      expect(first).toMatchObject({ matched: true, count: 1 });
      expect(second.memoryIds).toEqual(first.memoryIds);
      expect(memoryId).toMatch(/^extraction-v1-[a-f0-9]{64}$/);
      expect(
        db.prepare('SELECT source_type, source_id, source_timestamp FROM memory_sources WHERE memory_id = ?')
          .get(memoryId)
      ).toEqual({
        source_type: 'chat_message',
        source_id: 'chat-deterministic-source-1',
        source_timestamp: 123456789,
      });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE id = ?').get(memoryId)
      ).toEqual({ count: 1 });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get(memoryId)
      ).toEqual({ count: 1 });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'memory.create' AND event_id = ?")
          .get(memoryId)
      ).toEqual({ count: 1 });

      const repo = new MemoryRepository(db);
      await repo.disable(memoryId, { reason: 'test replay must not reactivate' });
      const countsBeforeReplay = {
        revisions: db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get(memoryId),
        audits: db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_id = ?").get(memoryId),
      };
      const afterDisable = await worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-deterministic-source-1',
        targetUserId: 'user-deterministic-source',
      });

      expect(afterDisable.memoryIds).toEqual([memoryId]);
      expect(db.prepare('SELECT state FROM memory_records WHERE id = ?').get(memoryId)).toEqual({ state: 'disabled' });
      expect({
        revisions: db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get(memoryId),
        audits: db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_id = ?").get(memoryId),
      }).toEqual(countsBeforeReplay);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('keeps identical facts from different canonical chat sources distinct', async () => {
      insertExtractionSource(db, {
        rawEventId: 'raw-distinct-source-1',
        chatMessageId: 'chat-distinct-source-1',
        targetUserId: 'user-distinct-source',
        text: '我喜欢来源区分',
        timestamp: 1001,
      });
      insertExtractionSource(db, {
        rawEventId: 'raw-distinct-source-2',
        chatMessageId: 'chat-distinct-source-2',
        targetUserId: 'user-distinct-source',
        text: '我喜欢来源区分',
        timestamp: 1002,
      });

      const first = await worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-distinct-source-1',
        targetUserId: 'user-distinct-source',
      });
      const second = await worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-distinct-source-2',
        targetUserId: 'user-distinct-source',
      });

      expect(first.memoryIds[0]).not.toBe(second.memoryIds[0]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE canonical_user_id = ?')
        .get('user-distinct-source')).toEqual({ count: 2 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects non-inbound, mismatched, and inactive canonical source identities', async () => {
      insertExtractionSource(db, {
        rawEventId: 'raw-invalid-bot-source',
        chatMessageId: 'chat-invalid-bot-source',
        targetUserId: 'user-invalid-source',
        text: '我喜欢不可信来源',
        timestamp: 1501,
        rawEventType: 'bot.response',
        rawEventSource: 'agent',
      });
      await expect(worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-invalid-bot-source',
        targetUserId: 'user-invalid-source',
      })).rejects.toMatchObject({ code: 'SOURCE_CHAT_MESSAGE_NOT_USABLE' });

      insertExtractionSource(db, {
        rawEventId: 'raw-mismatched-user',
        chatMessageId: 'chat-mismatched-user',
        targetUserId: 'user-source-owner',
        text: '我喜欢不能归给别人',
        timestamp: 1502,
      });
      await expect(worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-mismatched-user',
        targetUserId: 'user-wrong-target',
      })).rejects.toMatchObject({ code: 'SOURCE_IDENTITY_MISMATCH' });

      insertExtractionSource(db, {
        rawEventId: 'raw-disabled-source',
        chatMessageId: 'chat-disabled-source',
        targetUserId: 'user-disabled-source',
        text: '我喜欢解绑后不应写入',
        timestamp: 1503,
      });
      db.prepare(
        "UPDATE platform_accounts SET status = 'disabled' WHERE canonical_user_id = ?"
      ).run('user-disabled-source');
      await expect(worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-disabled-source',
        targetUserId: 'user-disabled-source',
      })).rejects.toMatchObject({ code: 'SOURCE_IDENTITY_MISMATCH' });

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('fails closed when a deterministic effect ID resolves to different stored content', async () => {
      insertExtractionSource(db, {
        rawEventId: 'raw-conflicting-effect',
        chatMessageId: 'chat-conflicting-effect',
        targetUserId: 'user-conflicting-effect',
        text: '我喜欢完整效果校验',
        timestamp: 1601,
      });
      const first = await worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-conflicting-effect',
        targetUserId: 'user-conflicting-effect',
      });
      db.prepare('UPDATE memory_records SET content = ? WHERE id = ?')
        .run('tampered content', first.memoryIds[0]);

      await expect(worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-conflicting-effect',
        targetUserId: 'user-conflicting-effect',
      })).rejects.toMatchObject({ code: 'TRANSIENT_EXTRACTION_FAILURE' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('fails closed when an exact deterministic effect references an orphan evaluator decision', async () => {
      insertExtractionSource(db, {
        rawEventId: 'raw-orphan-evaluator-effect',
        chatMessageId: 'chat-orphan-evaluator-effect',
        targetUserId: 'user-orphan-evaluator-effect',
        text: '我喜欢评估证据完整',
        timestamp: 1602,
      });
      const first = await worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-orphan-evaluator-effect',
        targetUserId: 'user-orphan-evaluator-effect',
      });
      const memoryId = first.memoryIds[0];
      db.prepare('UPDATE memory_records SET evaluator_decision_id = ? WHERE id = ?')
        .run('orphan-evaluator-decision', memoryId);
      db.prepare('UPDATE memory_revisions SET evaluator_decision_id = ? WHERE memory_id = ?')
        .run('orphan-evaluator-decision', memoryId);
      db.prepare(
        "UPDATE audit_log SET evaluator_decision_id = ? WHERE event_type = 'memory.create' AND event_id = ?",
      ).run('orphan-evaluator-decision', memoryId);

      await expect(worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-orphan-evaluator-effect',
        targetUserId: 'user-orphan-evaluator-effect',
      })).rejects.toMatchObject({ code: 'TRANSIENT_EXTRACTION_FAILURE' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get())
        .toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects durable extraction when the canonical chat source is missing', async () => {
      await expect(worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-source-does-not-exist',
        targetUserId: 'user-missing-source',
      })).rejects.toMatchObject({
        code: 'SOURCE_CHAT_MESSAGE_NOT_FOUND',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('retries transient partial candidates without duplicating the committed prefix', async () => {
      class FailPreferenceOnceRepository extends MemoryRepository {
        private failed = false;

        override createSync(input: MemoryRecordInput): string {
          if (!this.failed && input.kind === 'preference') {
            this.failed = true;
            throw new Error('induced transient preference failure');
          }
          return super.createSync(input);
        }
      }

      insertExtractionSource(db, {
        rawEventId: 'raw-partial-retry',
        chatMessageId: 'chat-partial-retry',
        targetUserId: 'user-partial-retry',
        text: '我叫重试用户，我喜欢重试恢复',
        timestamp: 2001,
      });
      const retryWorker = new MemoryExtractionWorker(db, new FailPreferenceOnceRepository(db));

      await expect(retryWorker.extractFromChatMessage({
        sourceChatMessageId: 'chat-partial-retry',
        targetUserId: 'user-partial-retry',
      })).rejects.toMatchObject({
        code: 'TRANSIENT_EXTRACTION_FAILURE',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 1 });

      const completed = await retryWorker.extractFromChatMessage({
        sourceChatMessageId: 'chat-partial-retry',
        targetUserId: 'user-partial-retry',
      });
      expect(completed).toMatchObject({ matched: true, count: 2 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 2 });
      for (const memoryId of completed.memoryIds) {
        expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get(memoryId))
          .toEqual({ count: 1 });
        expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'memory.create' AND event_id = ?")
          .get(memoryId)).toEqual({ count: 1 });
      }
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('completes repeated privacy rejections with one bounded rejection audit', async () => {
      const privacyRepo = new PrivacyPreferenceRepository(db);
      db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
        .run('user-rejection-replay', Date.now(), Date.now());
      privacyRepo.setOptOut({
        canonicalUserId: 'user-rejection-replay',
        preferenceType: 'memory_association',
        actor: { actorClass: 'admin', context: 'admin_cli' },
      });
      insertExtractionSource(db, {
        rawEventId: 'raw-rejection-replay',
        chatMessageId: 'chat-rejection-replay',
        targetUserId: 'user-rejection-replay',
        text: '我喜欢不应重复审计',
        timestamp: 3001,
      });

      const [first, second] = await Promise.all([
        worker.extractFromChatMessage({
          sourceChatMessageId: 'chat-rejection-replay',
          targetUserId: 'user-rejection-replay',
        }),
        worker.extractFromChatMessage({
          sourceChatMessageId: 'chat-rejection-replay',
          targetUserId: 'user-rejection-replay',
        }),
      ]);

      expect(first).toMatchObject({ matched: false, count: 0 });
      expect(first.errors?.[0]?.code).toBe('MEMORY_REJECTED');
      expect(second.errors?.[0]?.code).toBe('MEMORY_REJECTED');
      const replay = await worker.extractFromChatMessage({
        sourceChatMessageId: 'chat-rejection-replay',
        targetUserId: 'user-rejection-replay',
      });
      expect(replay.errors?.[0]?.code).toBe('MEMORY_REJECTED_REPLAY');
      expect(JSON.stringify({ first, second })).not.toContain('不应重复审计');
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'memory.candidate_rejected'").get())
        .toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('does not log ordinary matched chat text echoed by a persistence failure', async () => {
      const sourceText = '我喜欢日志中绝不能出现的普通事实';
      class EchoingFailureRepository extends MemoryRepository {
        override createSync(): string {
          throw new Error(`downstream echoed ${sourceText}`);
        }
      }
      insertExtractionSource(db, {
        rawEventId: 'raw-log-privacy',
        chatMessageId: 'chat-log-privacy',
        targetUserId: 'user-log-privacy',
        text: sourceText,
        timestamp: 4001,
      });
      const errorLog = vi.spyOn(getLogger(), 'error').mockImplementation(() => undefined);

      try {
        await expect(new MemoryExtractionWorker(db, new EchoingFailureRepository(db))
          .extractFromChatMessage({
            sourceChatMessageId: 'chat-log-privacy',
            targetUserId: 'user-log-privacy',
          })).rejects.toMatchObject({ code: 'TRANSIENT_EXTRACTION_FAILURE' });

        const loggedEcho = errorLog.mock.calls.some(([fields]) => {
          if (!fields || typeof fields !== 'object') {
            return false;
          }
          const record = fields as { err?: Error; error?: Error };
          return record.err?.message.includes(sourceText) === true
            || record.error?.message.includes(sourceText) === true;
        });
        expect(loggedEcho).toBe(false);
      } finally {
        errorLog.mockRestore();
      }
    });
  });
});

function insertExtractionSource(
  db: Database.Database,
  input: {
    rawEventId: string;
    chatMessageId: string;
    targetUserId: string;
    text: string;
    timestamp: number;
    rawEventType?: string;
    rawEventSource?: 'gateway' | 'agent';
    conversationId?: string;
    conversationType?: 'private' | 'group';
    groupId?: string;
  },
): void {
  const senderId = `qq-source-${input.targetUserId}`;
  const platformAccountId = senderId.replace(/^qq-/, '');
  const conversationId = input.conversationId ?? 'private:extraction-source';
  const conversationType = input.conversationType ?? 'private';
  db.prepare(
    'INSERT OR IGNORE INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)'
  ).run(input.targetUserId, input.timestamp, input.timestamp);
  db.prepare(
    `INSERT OR REPLACE INTO platform_accounts (
      platform, platform_account_id, canonical_user_id, account_type,
      verified_level, status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'qq',
    platformAccountId,
    input.targetUserId,
    'private',
    'observed',
    'active',
    input.timestamp,
    input.timestamp,
  );
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.rawEventId,
    input.rawEventType ?? 'chat.message.received',
    input.timestamp,
    input.rawEventSource ?? 'gateway',
    'qq',
    conversationId,
    '{}',
    input.timestamp,
  );
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id, conversation_type,
      group_id, sender_id, text, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.chatMessageId,
    input.rawEventId,
    `platform-${input.chatMessageId}`,
    conversationId,
    conversationType,
    input.groupId ?? null,
    senderId,
    input.text,
    input.timestamp,
  );
}

async function extractCanonicalTurn(
  db: Database.Database,
  worker: MemoryExtractionWorker,
  input: Parameters<MemoryExtractionWorker['extractFromTurn']>[0],
) {
  const messageId = input.messageId ?? `chat-source-${input.conversationId}-${input.userId}`;
  const timestamp = input.timestamp ?? 1_700_000_000_000;
  insertExtractionSource(db, {
    rawEventId: `raw-source-${messageId}`,
    chatMessageId: messageId,
    targetUserId: input.userId,
    text: input.userMessage,
    timestamp,
    conversationId: input.conversationId,
    conversationType: input.conversationType,
    groupId: input.groupId,
  });
  return worker.extractFromTurn({ ...input, messageId, timestamp });
}

async function extractCanonicalBatch(
  db: Database.Database,
  worker: MemoryExtractionWorker,
  input: Parameters<MemoryExtractionWorker['extractBatch']>[0],
) {
  const turns = input.turns.map((turn, index) => {
    const messageId = turn.messageId
      ?? `chat-source-${input.conversationId}-${turn.userId}-${index}`;
    const timestamp = turn.timestamp ?? 1_700_000_000_000 + index;
    insertExtractionSource(db, {
      rawEventId: `raw-source-${messageId}`,
      chatMessageId: messageId,
      targetUserId: turn.userId,
      text: turn.userMessage,
      timestamp,
      conversationId: input.conversationId,
      conversationType: turn.conversationType,
      groupId: turn.groupId,
    });
    return { ...turn, messageId, timestamp };
  });
  return worker.extractBatch({ ...input, turns });
}
