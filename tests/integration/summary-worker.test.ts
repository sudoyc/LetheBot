/**
 * Integration Tests: Summary Worker
 *
 * 端到端测试摘要生成流程
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SummaryWorker } from '../../src/workers/summary-worker.js';
import { BackgroundWorker } from '../../src/workers/background.js';
import type { PiAdapter } from '../../src/pi/pi-adapter.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import { ContextBuilder } from '../../src/context/builder.js';
import { IdentityRepository } from '../../src/storage/identity-repository.js';
import { initDatabase } from '../../src/storage/database.js';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('SummaryWorker Integration', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let contextBuilder: ContextBuilder;
  let summaryWorker: SummaryWorker;
  let backgroundWorker: BackgroundWorker;
  let mockPiAdapter: PiAdapter;
  const testDbPath = join(__dirname, '../../data/test-summary-integration.db');

  beforeEach(async () => {
    // 清理测试数据库
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }

    // 确保目录存在
    const dataDir = dirname(testDbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // 初始化数据库
    db = initDatabase({ path: testDbPath });

    // 运行迁移
    const migrationPath = join(__dirname, '../../migrations/001_initial_schema.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    db.exec(sql);

    // 初始化仓库
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);

    // 创建 mock PiAdapter
    mockPiAdapter = {
      runTurn: async () => ({
        turnId: 'test-turn',
        responseText:
          'SUMMARY: Users discussed the upcoming project launch and agreed on a timeline. The team will finalize requirements by Friday and start development next week.\nFACTS:\n- Project launch scheduled for next month\n- Requirements deadline is Friday\n- Development starts next week\n- Team has 3 members assigned',
        toolCallIds: [],
        events: [],
        tokensUsed: { input: 200, output: 100, total: 300 },
        status: 'completed' as const,
      }),
    } as any;

    summaryWorker = new SummaryWorker(db, mockPiAdapter, memoryRepo);
    backgroundWorker = new BackgroundWorker();

    // 初始化 ContextBuilder
    contextBuilder = new ContextBuilder(db, memoryRepo, identityRepo);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  describe('End-to-End Summary Flow', () => {
    it('should generate and store summary for real conversation', async () => {
      const now = Date.now();
      const conversationId = 'conv-integration-test';

      // 创建用户
      const userId = await identityRepo.getOrCreateCanonicalUser('qq', 'user-123');

      // 插入真实会话数据
      const messages = [
        'Hey, when should we launch the project?',
        'I think next month would be ideal',
        'Agreed. When do we need to finalize requirements?',
        'Lets aim for Friday',
        'Sounds good. When can we start development?',
        'We can start next week',
        'Great! How many team members do we have?',
        'Three people are assigned to this project',
        'Perfect, lets get started!',
        'Looking forward to it',
        'Me too!',
        'Lets schedule a kickoff meeting',
        'How about Monday morning?',
        'Works for me',
        'See you then!',
      ];

      for (let i = 0; i < messages.length; i++) {
        const eventId = `evt-${i}`;
        const msgId = `msg-${i}`;

        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(eventId, 'message.private', now + i * 60000, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          msgId,
          eventId,
          `m${i}`,
          conversationId,
          'private',
          userId,
          messages[i],
          now + i * 60000
        );
      }

      // 生成摘要
      const result = await summaryWorker.generateSummary({
        conversationId,
        conversationType: 'private',
      });

      expect(result).not.toBeNull();
      expect(result?.summaryId).toBeTruthy();
      expect(result?.summary).toContain('project');
      expect(result?.messageCount).toBe(messages.length);
      expect(result?.extractedFacts.length).toBeGreaterThan(0);

      // 验证摘要已存储
      const memory = await memoryRepo.findById(result!.summaryId);
      expect(memory).not.toBeNull();
      expect(memory?.kind).toBe('summary');
      expect(memory?.content).toContain('project');
    });

    it('should be retrievable via MemoryRepository', async () => {
      const now = Date.now();
      const conversationId = 'conv-retrieval-test';

      // 插入消息
      for (let i = 0; i < 15; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.private', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-${i}`,
          `evt-${i}`,
          `m${i}`,
          conversationId,
          'private',
          'user-1',
          `Test message ${i}`,
          now + i * 1000
        );
      }

      // 生成摘要
      const result = await summaryWorker.generateSummary({
        conversationId,
        conversationType: 'private',
      });

      expect(result).not.toBeNull();

      // 使用 MemoryRepository 检索
      const memories = await memoryRepo.retrieve({
        conversationId,
        state: 'active',
        contextType: 'private',
      });

      expect(memories.length).toBeGreaterThan(0);
      const summary = memories.find((m) => m.kind === 'summary');
      expect(summary).toBeDefined();
      expect(summary?.id).toBe(result?.summaryId);
    });

    it('should link to source messages correctly', async () => {
      const now = Date.now();
      const conversationId = 'conv-source-test';

      // 插入消息
      const messageIds: string[] = [];
      for (let i = 0; i < 15; i++) {
        const msgId = `msg-${i}`;
        messageIds.push(msgId);

        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.private', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          msgId,
          `evt-${i}`,
          `m${i}`,
          conversationId,
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      // 生成摘要
      const result = await summaryWorker.generateSummary({
        conversationId,
        conversationType: 'private',
      });

      expect(result).not.toBeNull();

      // 检查源链接
      const sources = db
        .prepare('SELECT * FROM memory_sources WHERE memory_id = ?')
        .all(result!.summaryId) as Array<{
        memory_id: string;
        source_type: string;
        source_id: string;
      }>;

      expect(sources.length).toBe(messageIds.length);

      // 验证所有源消息都已链接
      const linkedMessageIds = sources.map((s) => s.source_id);
      for (const msgId of messageIds) {
        expect(linkedMessageIds).toContain(msgId);
      }
    });
  });

  describe('BackgroundWorker Integration', () => {
    it('should process summary task from queue', async () => {
      const now = Date.now();
      const conversationId = 'conv-bg-test';

      // 插入消息
      for (let i = 0; i < 15; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.private', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-${i}`,
          `evt-${i}`,
          `m${i}`,
          conversationId,
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      // 入队任务
      const taskId = backgroundWorker.enqueue({
        type: 'summary',
        payload: {
          conversationId,
          conversationType: 'private',
        } as any,
      });

      expect(backgroundWorker.getStatus(taskId)).toBe('pending');

      // 处理任务（注意：这是 stub 实现，不会实际调用 SummaryWorker）
      const result = await backgroundWorker.processNext();

      expect(result).not.toBeNull();
      expect(result?.taskId).toBe(taskId);
      expect(backgroundWorker.getStatus(taskId)).toBe('completed');
    });

    it('should update task status correctly', async () => {
      const taskId = backgroundWorker.enqueue({
        type: 'summary',
        payload: {
          conversationId: 'test-conv',
          conversationType: 'private',
        } as any,
      });

      expect(backgroundWorker.getStatus(taskId)).toBe('pending');

      await backgroundWorker.processNext();

      expect(backgroundWorker.getStatus(taskId)).toBe('completed');
    });
  });

  describe('ContextBuilder Integration', () => {
    it('generated summary should appear in ContextPack when queried', async () => {
      const now = Date.now();
      const conversationId = 'conv-context-test';

      // 创建用户和会话
      const userId = await identityRepo.getOrCreateCanonicalUser('qq', 'user-456');

      // 插入消息
      for (let i = 0; i < 15; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.private', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-${i}`,
          `evt-${i}`,
          `m${i}`,
          conversationId,
          'private',
          userId,
          `Context test message ${i}`,
          now + i * 1000
        );
      }

      // 生成摘要
      const result = await summaryWorker.generateSummary({
        conversationId,
        conversationType: 'private',
      });

      expect(result).not.toBeNull();

      // 使用 ContextBuilder 构建上下文
      const contextPack = await contextBuilder.build({
        conversationId,
        conversationType: 'private',
        canonicalUserId: userId,
        messageLimit: 10,
      });

      // 验证摘要出现在检索到的记忆中
      const summaryMemory = contextPack.memory.retrievedFacts.find(
        (fact) => fact.kind === 'summary'
      );

      expect(summaryMemory).toBeDefined();
      expect(summaryMemory?.id).toBe(result?.summaryId);
      expect(summaryMemory?.content).toContain('project');
    });

    it('summary visibility rules should be respected', async () => {
      const now = Date.now();
      const privateConvId = 'conv-private';
      const groupConvId = 'conv-group';

      // 创建私聊摘要
      for (let i = 0; i < 15; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-priv-${i}`, 'message.private', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-priv-${i}`,
          `evt-priv-${i}`,
          `m${i}`,
          privateConvId,
          'private',
          'user-1',
          `Private message ${i}`,
          now + i * 1000
        );
      }

      const privateResult = await summaryWorker.generateSummary({
        conversationId: privateConvId,
        conversationType: 'private',
      });

      // 创建群聊摘要
      for (let i = 0; i < 15; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-group-${i}`, 'message.group', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, group_id, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-group-${i}`,
          `evt-group-${i}`,
          `m${i}`,
          groupConvId,
          'group',
          'group-1',
          'user-1',
          `Group message ${i}`,
          now + i * 1000
        );
      }

      const groupResult = await summaryWorker.generateSummary({
        conversationId: groupConvId,
        conversationType: 'group',
        groupId: 'group-1',
      });

      // 验证私聊摘要的可见性
      const privateMemory = await memoryRepo.findById(privateResult!.summaryId);
      expect(privateMemory?.visibility).toBe('same_user_any_context');

      // 验证群聊摘要的可见性
      const groupMemory = await memoryRepo.findById(groupResult!.summaryId);
      expect(groupMemory?.visibility).toBe('same_group_only');

      // 尝试在错误的上下文中检索
      const privateContextMemories = await memoryRepo.retrieve({
        conversationId: privateConvId,
        contextType: 'private',
        state: 'active',
      });

      const groupContextMemories = await memoryRepo.retrieve({
        conversationId: groupConvId,
        contextType: 'group',
        state: 'active',
      });

      // 私聊上下文应该能看到私聊摘要
      expect(
        privateContextMemories.some((m) => m.id === privateResult?.summaryId)
      ).toBe(true);

      // 群聊上下文应该能看到群聊摘要
      expect(groupContextMemories.some((m) => m.id === groupResult?.summaryId)).toBe(
        true
      );

      // 群聊上下文不应该看到私聊摘要（不同会话）
      expect(
        groupContextMemories.some((m) => m.id === privateResult?.summaryId)
      ).toBe(false);
    });
  });
});
