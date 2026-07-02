import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import {
  MemoryExtractionWorker,
  MemoryExtractionError,
  type ExtractionPattern,
} from '../../../src/workers/memory-extraction';
import { MemoryRepository } from '../../../src/storage/memory-repository';

describe('MemoryExtractionWorker', () => {
  let testDir: string;
  let db: Database.Database;
  let worker: MemoryExtractionWorker;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-extraction-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
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
      const result = await worker.extractFromTurn({
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
      const result = await worker.extractFromTurn({
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
      const result = await worker.extractFromTurn({
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
      const result = await worker.extractFromTurn({
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
      const result = await worker.extractFromTurn({
        conversationId: 'conv-005',
        userId: 'user-eve',
        userMessage: '今天天气不错',
        botResponse: '是的，阳光明媚',
      });

      expect(result.matched).toBe(false);
      expect(result.count).toBe(0);
      expect(result.memoryIds).toHaveLength(0);
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
      const result = await worker.extractFromTurn({
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
      const result = await worker.extractFromTurn({
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

    it('should set sourceContext without messageId', async () => {
      const result = await worker.extractFromTurn({
        conversationId: 'conv-008',
        userId: 'user-henry',
        userMessage: '我喜欢运动',
        botResponse: '很健康',
      });

      const memory = db
        .prepare('SELECT * FROM memory_records WHERE id = ?')
        .get(result.memoryIds[0]) as any;

      expect(memory.source_context).toBe('chat:conv-008');
    });
  });

  describe('extractBatch', () => {
    it('should process multiple turns', async () => {
      const result = await worker.extractBatch({
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
      // 创建一个会部分失败的场景
      const result = await worker.extractBatch({
        conversationId: 'conv-batch-002',
        turns: [
          {
            userId: 'user-dave',
            userMessage: '我叫Dave',
            botResponse: '你好',
          },
          {
            userId: 'user-eve',
            userMessage: '我喜欢编程',
            botResponse: '很好',
          },
        ],
      });

      expect(result.count).toBeGreaterThan(0);
    });

    it('should return empty result for empty turns array', async () => {
      const result = await worker.extractBatch({
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
      const result = await worker.extractBatch({
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

      const result = await worker.extractFromTurn({
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
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
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

      const result = await workerWithRepo.extractFromTurn({
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

    it('should keep group-chat-derived user memory as a proposal', async () => {
      const repo = new MemoryRepository(db);
      const workerWithRepo = new MemoryExtractionWorker(db, repo);

      const result = await workerWithRepo.extractFromTurn({
        conversationId: 'conv-group-governed',
        userId: 'user-group-governed',
        userMessage: '我喜欢群内技术讨论',
        botResponse: '收到',
        messageId: 'msg-group-governed',
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
  });
});
