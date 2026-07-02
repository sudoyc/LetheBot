import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../src/storage/database';
import { MemoryExtractionWorker } from '../../src/workers/memory-extraction';
import { MemoryRepository } from '../../src/storage/memory-repository';

describe('MemoryExtractionWorker - Integration Tests', () => {
  let testDir: string;
  let db: Database.Database;
  let worker: MemoryExtractionWorker;
  let memoryRepo: MemoryRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-integration-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../../migrations/001_initial_schema.sql'));

    memoryRepo = new MemoryRepository(db);
    worker = new MemoryExtractionWorker(db, memoryRepo);
  });

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Database integration', () => {
    it('should create memory records that can be queried from memory_records table', async () => {
      const result = await worker.extractFromTurn({
        conversationId: 'conv-db-001',
        userId: 'user-alice',
        userMessage: '我叫Alice，我喜欢编程',
        botResponse: '很高兴认识你',
      });

      expect(result.count).toBe(2);

      // 直接查询数据库验证记录
      const memories = db
        .prepare('SELECT * FROM memory_records WHERE canonical_user_id = ?')
        .all('user-alice') as any[];

      expect(memories).toHaveLength(2);
      expect(memories[0].scope).toBe('user');
      expect(memories[0].visibility).toBe('private_only');
      expect(memories[0].state).toBe('active');
    });

    it('should automatically create canonical_users record', async () => {
      const result = await worker.extractFromTurn({
        conversationId: 'conv-db-002',
        userId: 'user-newuser',
        userMessage: '我喜欢音乐',
        botResponse: '很好',
      });

      expect(result.matched).toBe(true);

      // 验证用户记录被创建
      const user = db
        .prepare('SELECT * FROM canonical_users WHERE id = ?')
        .get('user-newuser') as any;

      expect(user).toBeDefined();
      expect(user.id).toBe('user-newuser');
      expect(user.created_at).toBeDefined();
      expect(user.last_seen_at).toBeDefined();
    });

    it('should store sourceContext correctly', async () => {
      const result = await worker.extractFromTurn({
        conversationId: 'conv-db-003',
        userId: 'user-bob',
        userMessage: '我喜欢阅读',
        botResponse: '很好',
        messageId: 'msg-xyz',
      });

      const memory = db
        .prepare('SELECT * FROM memory_records WHERE id = ?')
        .get(result.memoryIds[0]) as any;

      expect(memory.source_context).toBe('chat:conv-db-003:msg-xyz');
    });

    it('should handle multiple extractions for same user independently', async () => {
      // 第一次提取
      await worker.extractFromTurn({
        conversationId: 'conv-db-004',
        userId: 'user-charlie',
        userMessage: '我喜欢游泳',
        botResponse: '很好',
      });

      // 第二次提取
      await worker.extractFromTurn({
        conversationId: 'conv-db-005',
        userId: 'user-charlie',
        userMessage: '我喜欢跑步',
        botResponse: '很健康',
      });

      // 验证两条记录都独立存在
      const memories = db
        .prepare('SELECT * FROM memory_records WHERE canonical_user_id = ?')
        .all('user-charlie') as any[];

      expect(memories).toHaveLength(2);
      expect(memories[0].content).not.toBe(memories[1].content);
    });
  });

  describe('Repository integration', () => {
    it('should use MemoryRepository.create() for memory creation', async () => {
      const result = await worker.extractFromTurn({
        conversationId: 'conv-repo-001',
        userId: 'user-dave',
        userMessage: '我叫Dave',
        botResponse: '你好',
      });

      expect(result.memoryIds).toHaveLength(1);

      // 通过Repository查询验证
      const memory = await memoryRepo.findById(result.memoryIds[0]);
      expect(memory).toBeDefined();
      expect(memory?.canonicalUserId).toBe('user-dave');
      expect(memory?.title).toContain('name');
    });

    it('should return correct memory ID from Repository', async () => {
      const result = await worker.extractFromTurn({
        conversationId: 'conv-repo-002',
        userId: 'user-eve',
        userMessage: '我喜欢画画',
        botResponse: '很好',
      });

      const memoryId = result.memoryIds[0];

      // 验证ID格式（ULID）
      expect(memoryId).toMatch(/^[0-9A-Z]{26}$/);

      // 验证可以通过Repository查询
      const memory = await memoryRepo.findById(memoryId);
      expect(memory?.id).toBe(memoryId);
    });

    it('should collect errors when Repository operations fail', async () => {
      // 关闭数据库触发Repository错误
      closeDatabase(db);

      const result = await worker.extractFromTurn({
        conversationId: 'conv-repo-error',
        userId: 'user-error',
        userMessage: '我喜欢测试',
        botResponse: '很好',
      });

      // 错误被收集而不是抛出
      expect(result.matched).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  describe('Batch processing integration', () => {
    it('should create all memories in batch processing', async () => {
      const result = await worker.extractBatch({
        conversationId: 'conv-batch-int-001',
        turns: [
          {
            userId: 'user-frank',
            userMessage: '我叫Frank',
            botResponse: '你好',
          },
          {
            userId: 'user-grace',
            userMessage: '我叫Grace',
            botResponse: '你好',
          },
          {
            userId: 'user-frank',
            userMessage: '我喜欢编程',
            botResponse: '很好',
          },
        ],
      });

      expect(result.count).toBe(3);

      // 验证所有记录都在数据库中
      for (const memoryId of result.memoryIds) {
        const memory = await memoryRepo.findById(memoryId);
        expect(memory).toBeDefined();
      }
    });

    it('should create users for all unique userIds in batch', async () => {
      await worker.extractBatch({
        conversationId: 'conv-batch-int-002',
        turns: [
          {
            userId: 'user-henry',
            userMessage: '我喜欢音乐',
            botResponse: '很好',
          },
          {
            userId: 'user-iris',
            userMessage: '我喜欢舞蹈',
            botResponse: '很好',
          },
        ],
      });

      // 验证两个用户都被创建
      const users = db
        .prepare('SELECT * FROM canonical_users WHERE id IN (?, ?)')
        .all('user-henry', 'user-iris') as any[];

      expect(users).toHaveLength(2);
    });
  });

  describe('Custom patterns integration', () => {
    it('should use custom patterns with database integration', async () => {
      const customWorker = new MemoryExtractionWorker(db, memoryRepo, [
        {
          regex: /项目名称是(.+)/,
          type: 'attribute',
          sensitivity: 'normal',
          confidence: 0.8,
          importance: 0.7,
        },
      ]);

      const result = await customWorker.extractFromTurn({
        conversationId: 'conv-custom-001',
        userId: 'user-jack',
        userMessage: '项目名称是LetheBot',
        botResponse: '了解',
      });

      expect(result.matched).toBe(true);

      const memory = await memoryRepo.findById(result.memoryIds[0]);
      expect(memory?.title).toContain('attribute');
      expect(memory?.content).toContain('项目名称是LetheBot');
    });
  });

  describe('Memory retrieval integration', () => {
    it('should allow retrieving extracted memories for a user', async () => {
      // 提取多条记忆
      await worker.extractFromTurn({
        conversationId: 'conv-retrieve-001',
        userId: 'user-kate',
        userMessage: '我叫Kate，我喜欢旅行',
        botResponse: '很好',
      });

      // 通过Repository检索
      const memories = await memoryRepo.retrieve({
        canonicalUserId: 'user-kate',
        state: 'active',
      });

      expect(memories.length).toBe(2);
      expect(memories[0].canonicalUserId).toBe('user-kate');
      expect(memories[0].state).toBe('active');
    });

    it('should filter memories by scope correctly', async () => {
      await worker.extractFromTurn({
        conversationId: 'conv-retrieve-002',
        userId: 'user-leo',
        userMessage: '我喜欢足球',
        botResponse: '很好',
      });

      const memories = await memoryRepo.retrieve({
        canonicalUserId: 'user-leo',
        scope: 'user',
        state: 'active',
      });

      expect(memories.length).toBeGreaterThan(0);
      expect(memories[0].scope).toBe('user');
    });
  });

  describe('Transaction and consistency', () => {
    it('should maintain data consistency across multiple operations', async () => {
      const conversationId = 'conv-consistency-001';
      const userId = 'user-mike';

      // 执行多次提取
      for (let i = 0; i < 5; i++) {
        await worker.extractFromTurn({
          conversationId,
          userId,
          userMessage: `我喜欢活动${i}`,
          botResponse: '很好',
        });
      }

      // 验证所有记录都正确创建
      const memories = await memoryRepo.retrieve({
        canonicalUserId: userId,
        state: 'active',
      });

      expect(memories).toHaveLength(5);

      // 验证canonical_users表只有一条记录
      const users = db
        .prepare('SELECT * FROM canonical_users WHERE id = ?')
        .all(userId) as any[];

      expect(users).toHaveLength(1);
    });
  });

  describe('Error recovery integration', () => {
    it('should handle partial batch failure gracefully', async () => {
      const result = await worker.extractBatch({
        conversationId: 'conv-error-recovery-001',
        turns: [
          {
            userId: 'user-nancy',
            userMessage: '我喜欢绘画',
            botResponse: '很好',
          },
          {
            userId: 'user-nancy',
            userMessage: '没有匹配内容',
            botResponse: '好的',
          },
          {
            userId: 'user-nancy',
            userMessage: '我喜欢摄影',
            botResponse: '很好',
          },
        ],
      });

      // 应该成功提取2条（第2条无匹配）
      expect(result.count).toBe(2);

      const memories = await memoryRepo.retrieve({
        canonicalUserId: 'user-nancy',
        state: 'active',
      });

      expect(memories).toHaveLength(2);
    });
  });
});
