/**
 * Unit Tests: Summary Worker
 *
 * 测试会话摘要生成工作器
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SummaryWorker } from '../../../src/workers/summary-worker.js';
import type { PiAdapter } from '../../../src/pi/pi-adapter.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';
import { initDatabase } from '../../../src/storage/database.js';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('SummaryWorker', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let summaryWorker: SummaryWorker;
  let mockPiAdapter: PiAdapter;
  const testDbPath = join(__dirname, '../../../data/test-summary-worker.db');

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
    const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    db.exec(sql);

    // 初始化仓库
    memoryRepo = new MemoryRepository(db);

    // 创建 mock PiAdapter
    mockPiAdapter = {
      runTurn: async () => ({
        turnId: 'test-turn',
        responseText:
          'SUMMARY: This is a test conversation about project planning.\nFACTS:\n- User discussed project timeline\n- Deadline is next week',
        toolCallIds: [],
        events: [],
        tokensUsed: { input: 100, output: 50, total: 150 },
        status: 'completed' as const,
      }),
    } as any;

    summaryWorker = new SummaryWorker(db, mockPiAdapter, memoryRepo);
  });

  function insertConversationMessages(options?: {
    conversationId?: string;
    conversationType?: 'private' | 'group';
    groupId?: string;
    count?: number;
    startTime?: number;
    textPrefix?: string;
  }): void {
    const conversationId = options?.conversationId ?? 'conv-1';
    const conversationType = options?.conversationType ?? 'private';
    const count = options?.count ?? 15;
    const now = options?.startTime ?? Date.now();
    const textPrefix = options?.textPrefix ?? 'Message';

    for (let i = 1; i <= count; i++) {
      const eventId = `evt-${conversationId}-${i}`;
      const messageId = `msg-${conversationId}-${i}`;
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(eventId, `message.${conversationType}`, now + i * 1000, 'gateway', '{}', now);

      if (conversationType === 'group') {
        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, group_id, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          messageId,
          eventId,
          `m${i}`,
          conversationId,
          conversationType,
          options?.groupId ?? 'group-1',
          `user-${i % 3}`,
          `${textPrefix} ${i}`,
          now + i * 1000
        );
        continue;
      }

      db.prepare(
        `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        eventId,
        `m${i}`,
        conversationId,
        conversationType,
        'user-1',
        `${textPrefix} ${i}`,
        now + i * 1000
      );
    }
  }

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  describe('Message Loading', () => {
    it('should load messages within time range', async () => {
      // 插入测试消息
      const now = Date.now();
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('evt-1', 'message.group', now, 'gateway', '{}', now);

      db.prepare(
        `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg-1',
        'evt-1',
        'm1',
        'conv-1',
        'private',
        'user-1',
        'Hello',
        now - 5000
      );

      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('evt-2', 'message.group', now, 'gateway', '{}', now);

      db.prepare(
        `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('msg-2', 'evt-2', 'm2', 'conv-1', 'private', 'user-1', 'World', now);

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'private',
        timeRange: { startTime: now - 10000, endTime: now + 1000 },
      });

      expect(result).not.toBeNull();
      expect(result?.messageCount).toBe(2);
    });

    it('should load messages within message ID range', async () => {
      const now = Date.now();

      for (let i = 1; i <= 3; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.group', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-${i}`,
          `evt-${i}`,
          `m${i}`,
          'conv-1',
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'private',
        messageRange: { start: 'msg-1', end: 'msg-2' },
      });

      expect(result).not.toBeNull();
      expect(result?.messageCount).toBe(2);
    });

    it('should respect maxMessagesToSummarize limit', async () => {
      const now = Date.now();
      const maxMessages = 50;

      // 插入超过限制的消息
      for (let i = 1; i <= 60; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.group', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-${i}`,
          `evt-${i}`,
          `m${i}`,
          'conv-1',
          'group',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'group',
      });

      expect(result).not.toBeNull();
      expect(result?.messageCount).toBeLessThanOrEqual(maxMessages);
    });

    it('should return null for empty message list', async () => {
      const result = await summaryWorker.generateSummary({
        conversationId: 'non-existent',
        conversationType: 'private',
      });

      expect(result).toBeNull();
    });

    it('should skip when message count below threshold', async () => {
      const now = Date.now();

      // 只插入 5 条消息（低于默认阈值 10）
      for (let i = 1; i <= 5; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.group', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-${i}`,
          `evt-${i}`,
          `m${i}`,
          'conv-1',
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'private',
      });

      expect(result).toBeNull();
    });
  });

  describe('Summary Generation', () => {
    it('should send real conversation messages in summarizer prompt', async () => {
      insertConversationMessages({
        conversationId: 'conv-prompt',
        textPrefix: 'Launch planning message',
      });

      let capturedInput: any;
      mockPiAdapter.runTurn = async (input: any) => {
        capturedInput = input;
        return {
          turnId: 'test-turn',
          responseText: 'SUMMARY: Prompt included real messages\nFACTS:\n- Prompt checked',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 100, output: 50, total: 150 },
          status: 'completed',
        };
      };

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-prompt',
        conversationType: 'private',
      });

      expect(result).not.toBeNull();
      const prompt = capturedInput.contextPack.recentMessages[0].text;
      expect(prompt).toContain('Message Count: 15');
      expect(prompt).toContain('Messages:');
      expect(prompt).toContain('Launch planning message 1');
      expect(prompt).toContain('Launch planning message 15');
      expect(prompt).toContain('Please provide:');
    });

    it('should generate summary for private conversation', async () => {
      const now = Date.now();

      // 插入足够的消息
      for (let i = 1; i <= 15; i++) {
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
          'conv-1',
          'private',
          'user-1',
          `Test message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'private',
      });

      expect(result).not.toBeNull();
      expect(result?.summaryId).toBeTruthy();
      expect(result?.summary).toContain('test conversation');
      expect(result?.conversationId).toBe('conv-1');
    });

    it('should generate summary for group conversation', async () => {
      const now = Date.now();

      for (let i = 1; i <= 15; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.group', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, group_id, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-${i}`,
          `evt-${i}`,
          `m${i}`,
          'conv-group-1',
          'group',
          'group-1',
          `user-${i % 3}`,
          `Group message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-group-1',
        conversationType: 'group',
        groupId: 'group-1',
      });

      expect(result).not.toBeNull();
      expect(result?.conversationId).toBe('conv-group-1');
    });

    it('should extract key facts from conversation', async () => {
      const now = Date.now();

      for (let i = 1; i <= 15; i++) {
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
          'conv-1',
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'private',
      });

      expect(result).not.toBeNull();
      expect(result?.extractedFacts).toBeInstanceOf(Array);
      expect(result?.extractedFacts.length).toBeGreaterThan(0);
    });
  });

  describe('Memory Storage', () => {
    it('should be idempotent for the same message window', async () => {
      insertConversationMessages({
        conversationId: 'conv-idempotent',
        textPrefix: 'Idempotent message',
      });

      let callCount = 0;
      mockPiAdapter.runTurn = async () => {
        callCount++;
        return {
          turnId: 'test-turn',
          responseText:
            'SUMMARY: Idempotent summary\nFACTS:\n- Only one summary should be stored',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 100, output: 50, total: 150 },
          status: 'completed',
        };
      };

      const first = await summaryWorker.generateSummary({
        conversationId: 'conv-idempotent',
        conversationType: 'private',
      });
      const second = await summaryWorker.generateSummary({
        conversationId: 'conv-idempotent',
        conversationType: 'private',
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      if (!first || !second) {
        throw new Error('Expected summary generation to return results');
      }

      expect(second?.summaryId).toBe(first?.summaryId);
      expect(second?.summary).toBe('Idempotent summary');
      expect(second?.extractedFacts).toEqual(['Only one summary should be stored']);
      expect(callCount).toBe(1);

      const memoryRows = db
        .prepare('SELECT COUNT(*) as count FROM memory_records WHERE id = ?')
        .get(first.summaryId) as { count: number };
      const sourceRows = db
        .prepare('SELECT COUNT(*) as count FROM memory_sources WHERE memory_id = ?')
        .get(first.summaryId) as { count: number };
      const revisionRows = db
        .prepare('SELECT COUNT(*) as count FROM memory_revisions WHERE memory_id = ?')
        .get(first.summaryId) as { count: number };
      const auditRows = db
        .prepare("SELECT COUNT(*) as count FROM audit_log WHERE category = 'memory' AND event_id = ?")
        .get(first.summaryId) as { count: number };

      expect(memoryRows.count).toBe(1);
      expect(sourceRows.count).toBe(15);
      expect(revisionRows.count).toBe(1);
      expect(auditRows.count).toBe(1);
    });

    it('should create memory_record with correct fields', async () => {
      const now = Date.now();

      for (let i = 1; i <= 15; i++) {
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
          'conv-1',
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'private',
      });

      expect(result).not.toBeNull();

      // 验证记忆记录已创建
      const memory = await memoryRepo.findById(result.summaryId);
      expect(memory).not.toBeNull();
      expect(memory?.kind).toBe('summary');
      expect(memory?.state).toBe('active');
      expect(memory?.authority).toBe('tool_derived');
      expect(memory?.sourceContext).toBe('background_worker:summary');
    });

    it('should set appropriate visibility for private conversation', async () => {
      const now = Date.now();

      for (let i = 1; i <= 15; i++) {
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
          'conv-1',
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'private',
      });

      const memory = await memoryRepo.findById(result.summaryId);
      expect(memory?.visibility).toBe('same_user_any_context');
    });

    it('should set appropriate visibility for group conversation', async () => {
      const now = Date.now();

      for (let i = 1; i <= 15; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.group', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, group_id, sender_id, text, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `msg-${i}`,
          `evt-${i}`,
          `m${i}`,
          'conv-1',
          'group',
          'group-1',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'group',
        groupId: 'group-1',
      });

      const memory = await memoryRepo.findById(result.summaryId);
      expect(memory?.visibility).toBe('same_group_only');
    });

    it('should link source messages in memory_sources', async () => {
      const now = Date.now();

      for (let i = 1; i <= 15; i++) {
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
          'conv-1',
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'private',
      });

      // 验证源链接
      const sources = db
        .prepare('SELECT * FROM memory_sources WHERE memory_id = ?')
        .all(result.summaryId) as Array<{
        memory_id: string;
        source_type: string;
        source_id: string;
        extracted_by: string;
      }>;

      expect(sources.length).toBe(15);
      expect(sources[0]?.source_type).toBe('chat_message');
      expect(sources[0]?.extracted_by).toBe('worker');

      const revisions = db
        .prepare('SELECT * FROM memory_revisions WHERE memory_id = ?')
        .all(result.summaryId) as any[];
      const auditRows = db
        .prepare("SELECT * FROM audit_log WHERE category = 'memory' AND event_id = ?")
        .all(result.summaryId) as any[];

      expect(revisions).toHaveLength(1);
      expect(revisions[0].change_type).toBe('create');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].event_type).toBe('memory.create');
    });

    it('should calculate confidence based on message count', async () => {
      const now = Date.now();

      // 测试不同消息数量的置信度
      const testCases = [
        { count: 15, expectedMin: 0.6, expectedMax: 0.75 },
        { count: 35, expectedMin: 0.75, expectedMax: 0.85 },
        { count: 55, expectedMin: 0.85, expectedMax: 1.0 },
      ];

      for (const testCase of testCases) {
        const convId = `conv-${testCase.count}`;

        for (let i = 1; i <= testCase.count; i++) {
          db.prepare(
            `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(`evt-${convId}-${i}`, 'message.private', now, 'gateway', '{}', now);

          db.prepare(
            `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            `msg-${convId}-${i}`,
            `evt-${convId}-${i}`,
            `m${i}`,
            convId,
            'private',
            'user-1',
            `Message ${i}`,
            now + i * 1000
          );
        }

        const result = await summaryWorker.generateSummary({
          conversationId: convId,
          conversationType: 'private',
        });

        expect(result?.confidence).toBeGreaterThanOrEqual(testCase.expectedMin);
        expect(result?.confidence).toBeLessThanOrEqual(testCase.expectedMax);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      // 关闭数据库以模拟错误
      db.close();

      await expect(
        summaryWorker.generateSummary({
          conversationId: 'conv-1',
          conversationType: 'private',
        })
      ).rejects.toThrow();
    });

    it('should handle empty LLM response', async () => {
      const now = Date.now();

      for (let i = 1; i <= 15; i++) {
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
          'conv-1',
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      // Mock 空响应
      mockPiAdapter.runTurn = async () => ({
        turnId: 'test-turn',
        responseText: '',
        toolCallIds: [],
        events: [],
        tokensUsed: { input: 0, output: 0, total: 0 },
        status: 'completed',
      });

      await expect(
        summaryWorker.generateSummary({
          conversationId: 'conv-1',
          conversationType: 'private',
        })
      ).rejects.toThrow('LLM returned empty response');
    });

    it('should retry on LLM timeout', async () => {
      const now = Date.now();

      for (let i = 1; i <= 15; i++) {
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
          'conv-1',
          'private',
          'user-1',
          `Message ${i}`,
          now + i * 1000
        );
      }

      let callCount = 0;
      mockPiAdapter.runTurn = async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Timeout');
        }
        return {
          turnId: 'test-turn',
          responseText: 'SUMMARY: Retry succeeded',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 100, output: 50, total: 150 },
          status: 'completed',
        };
      };

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-1',
        conversationType: 'private',
      });

      expect(result).not.toBeNull();
      expect(callCount).toBe(2);
    });
  });

  describe('findConversationsNeedingSummary', () => {
    it('should not return an already summarized message window', async () => {
      insertConversationMessages({
        conversationId: 'conv-already-summarized',
        textPrefix: 'Already summarized message',
      });

      const before = await summaryWorker.findConversationsNeedingSummary(60);
      expect(before.some((c) => c.conversationId === 'conv-already-summarized')).toBe(true);

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-already-summarized',
        conversationType: 'private',
      });
      expect(result).not.toBeNull();

      const after = await summaryWorker.findConversationsNeedingSummary(60);
      expect(after.some((c) => c.conversationId === 'conv-already-summarized')).toBe(false);
    });

    it('should find conversations with enough messages', async () => {
      const now = Date.now();

      // 创建两个会话
      for (let convIdx = 1; convIdx <= 2; convIdx++) {
        for (let i = 1; i <= 15; i++) {
          db.prepare(
            `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(`evt-${convIdx}-${i}`, 'message.private', now, 'gateway', '{}', now);

          db.prepare(
            `INSERT INTO chat_messages (id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, text, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            `msg-${convIdx}-${i}`,
            `evt-${convIdx}-${i}`,
            `m${i}`,
            `conv-${convIdx}`,
            'private',
            'user-1',
            `Message ${i}`,
            now - 1000 * i
          );
        }
      }

      const conversations = await summaryWorker.findConversationsNeedingSummary(60);

      expect(conversations.length).toBeGreaterThanOrEqual(2);
      expect(conversations[0]?.conversationId).toBeTruthy();
    });

    it('should not return conversations with too few messages', async () => {
      const now = Date.now();

      // 只插入 5 条消息
      for (let i = 1; i <= 5; i++) {
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
          'conv-1',
          'private',
          'user-1',
          `Message ${i}`,
          now - 1000 * i
        );
      }

      const conversations = await summaryWorker.findConversationsNeedingSummary(60);

      expect(conversations.length).toBe(0);
    });
  });
});
