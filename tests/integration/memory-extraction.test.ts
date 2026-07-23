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
      const result = await extractCanonicalTurn(db, worker, {
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
      expect(memories.every((memory) => memory.scope === 'user')).toBe(true);
      expect(memories.every((memory) => memory.visibility === 'private_only')).toBe(true);
      expect(memories.map((memory) => ({ kind: memory.kind, state: memory.state })))
        .toEqual(expect.arrayContaining([
          { kind: 'fact', state: 'proposed' },
          { kind: 'preference', state: 'active' },
        ]));
    });

    it('should persist memory through an active canonical QQ source identity', async () => {
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-db-002',
        userId: 'user-newuser',
        userMessage: '我喜欢音乐',
        botResponse: '很好',
      });

      expect(result.matched).toBe(true);

      const provenance = db.prepare(
        `SELECT mr.canonical_user_id, pa.status, ms.source_type, ms.chat_message_id
           FROM memory_records mr
           JOIN platform_accounts pa
             ON pa.platform = 'qq' AND pa.canonical_user_id = mr.canonical_user_id
           JOIN memory_sources ms ON ms.memory_id = mr.id
          WHERE mr.id = ?`
      ).get(result.memoryIds[0]);

      expect(provenance).toEqual({
        canonical_user_id: 'user-newuser',
        status: 'active',
        source_type: 'chat_message',
        chat_message_id: 'chat-source-conv-db-002-user-newuser',
      });
    });

    it('should store sourceContext correctly', async () => {
      const result = await extractCanonicalTurn(db, worker, {
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
      await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-db-004',
        userId: 'user-charlie',
        userMessage: '我喜欢游泳',
        botResponse: '很好',
      });

      // 第二次提取
      await extractCanonicalTurn(db, worker, {
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
      const result = await extractCanonicalTurn(db, worker, {
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
      const result = await extractCanonicalTurn(db, worker, {
        conversationId: 'conv-repo-002',
        userId: 'user-eve',
        userMessage: '我喜欢画画',
        botResponse: '很好',
      });

      const memoryId = result.memoryIds[0];

      // Extraction effects use a deterministic, versioned identity for safe retries.
      expect(memoryId).toMatch(/^extraction-v1-[a-f0-9]{64}$/);

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
      expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    });
  });

  describe('Batch processing integration', () => {
    it('should create all memories in batch processing', async () => {
      const result = await extractCanonicalBatch(db, worker, {
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

    it('should preserve active canonical QQ source identities for all unique users in batch', async () => {
      await extractCanonicalBatch(db, worker, {
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

      const users = db
        .prepare(
          `SELECT canonical_user_id, status
             FROM platform_accounts
            WHERE platform = 'qq' AND canonical_user_id IN (?, ?)
            ORDER BY canonical_user_id`
        )
        .all('user-henry', 'user-iris') as any[];

      expect(users).toEqual([
        { canonical_user_id: 'user-henry', status: 'active' },
        { canonical_user_id: 'user-iris', status: 'active' },
      ]);
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

      const result = await extractCanonicalTurn(db, customWorker, {
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
      await extractCanonicalTurn(db, worker, {
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

      expect(memories).toHaveLength(1);
      expect(memories[0].canonicalUserId).toBe('user-kate');
      expect(memories[0].state).toBe('active');
      expect(memories[0].kind).toBe('preference');

      const proposals = await memoryRepo.retrieve({
        canonicalUserId: 'user-kate',
        state: 'proposed',
      });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ kind: 'fact', state: 'proposed' });
    });

    it('should filter memories by scope correctly', async () => {
      await extractCanonicalTurn(db, worker, {
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
        await extractCanonicalTurn(db, worker, {
          conversationId,
          userId,
          userMessage: `我喜欢活动${i}`,
          botResponse: '很好',
          messageId: `msg-consistency-${i}`,
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
      const conversationId = 'conv-error-recovery-001';
      const validMessageId = 'msg-error-recovery-valid';
      const timestamp = 1_700_000_000_000;
      insertCanonicalChatSource(db, {
        rawEventId: 'raw-error-recovery-valid',
        chatMessageId: validMessageId,
        conversationId,
        userId: 'user-nancy',
        text: '我喜欢绘画',
        timestamp,
      });

      const result = await worker.extractBatch({
        conversationId,
        turns: [
          {
            userId: 'user-nancy',
            userMessage: '我喜欢绘画',
            botResponse: '很好',
            messageId: validMessageId,
            timestamp,
          },
          {
            userId: 'user-nancy',
            userMessage: '我喜欢摄影',
            botResponse: '很好',
            messageId: 'msg-error-recovery-missing',
            timestamp: timestamp + 1,
          },
        ],
      });

      expect(result.count).toBe(1);
      expect(result.errors).toHaveLength(1);

      const memories = await memoryRepo.retrieve({
        canonicalUserId: 'user-nancy',
        state: 'active',
      });

      expect(memories).toHaveLength(1);
    });
  });
});

function insertCanonicalChatSource(
  db: Database.Database,
  input: {
    rawEventId: string;
    chatMessageId: string;
    conversationId: string;
    userId: string;
    text: string;
    timestamp: number;
    conversationType?: 'private' | 'group';
    groupId?: string;
  },
): void {
  const conversationType = input.conversationType ?? 'private';
  const senderId = `qq-source-${input.userId}`;
  const platformAccountId = senderId.replace(/^qq-/, '');
  db.prepare(
    'INSERT OR IGNORE INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)'
  ).run(input.userId, input.timestamp, input.timestamp);
  db.prepare(
    `INSERT OR REPLACE INTO platform_accounts (
      platform, platform_account_id, canonical_user_id, account_type,
      verified_level, status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'qq',
    platformAccountId,
    input.userId,
    conversationType === 'group' ? 'group_member' : 'private',
    'observed',
    'active',
    input.timestamp,
    input.timestamp,
  );
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.rawEventId,
    'chat.message.received',
    input.timestamp,
    'gateway',
    'qq',
    input.conversationId,
    '{}',
    input.timestamp,
  );
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id, conversation_type,
      group_id, sender_id, text, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.chatMessageId,
    input.rawEventId,
    `platform-${input.chatMessageId}`,
    input.conversationId,
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
  insertCanonicalChatSource(db, {
    rawEventId: `raw-source-${messageId}`,
    chatMessageId: messageId,
    conversationId: input.conversationId,
    userId: input.userId,
    text: input.userMessage,
    timestamp,
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
    const messageId = turn.messageId ?? `chat-source-${input.conversationId}-${turn.userId}-${index}`;
    const timestamp = turn.timestamp ?? 1_700_000_000_000 + index;
    insertCanonicalChatSource(db, {
      rawEventId: `raw-source-${messageId}`,
      chatMessageId: messageId,
      conversationId: input.conversationId,
      userId: turn.userId,
      text: turn.userMessage,
      timestamp,
      conversationType: turn.conversationType,
      groupId: turn.groupId,
    });
    return { ...turn, messageId, timestamp };
  });
  return worker.extractBatch({ ...input, turns });
}
