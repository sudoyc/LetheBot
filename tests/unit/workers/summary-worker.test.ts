/**
 * Unit Tests: Summary Worker
 *
 * 测试会话摘要生成工作器
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SummaryWorker } from '../../../src/workers/summary-worker.js';
import type { PiAdapter, PiAdapterInput } from '../../../src/pi/pi-adapter.js';
import { ContextBuilder } from '../../../src/context/builder.js';
import { IdentityRepository } from '../../../src/storage/identity-repository.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';
import {
  GroupSummaryPolicyError,
  GroupSummaryPolicyRepository,
} from '../../../src/storage/group-summary-policy-repository.js';
import { JobRepository } from '../../../src/storage/job-repository.js';
import { initDatabase, runMigrations } from '../../../src/storage/database.js';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('SummaryWorker', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let groupSummaryPolicies: GroupSummaryPolicyRepository;
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
    runMigrations(db, join(__dirname, '../../../migrations'));

    // 初始化仓库
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    groupSummaryPolicies = new GroupSummaryPolicyRepository(db);

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

    summaryWorker = new SummaryWorker(
      db,
      mockPiAdapter,
      memoryRepo,
      new ContextBuilder(memoryRepo, identityRepo),
    );
  });

  function insertConversationMessages(options?: {
    conversationId?: string;
    conversationType?: 'private' | 'group';
    groupId?: string;
    count?: number;
    startTime?: number;
    rawCreatedAt?: number;
    idPrefix?: string;
    textPrefix?: string;
  }): void {
    const conversationId = options?.conversationId ?? 'conv-1';
    const conversationType = options?.conversationType ?? 'private';
    const count = options?.count ?? 15;
    const now = options?.startTime ?? Date.now();
    const rawCreatedAt = options?.rawCreatedAt ?? now;
    const idPrefix = options?.idPrefix ?? conversationId;
    const textPrefix = options?.textPrefix ?? 'Message';

    for (let i = 1; i <= count; i++) {
      const eventId = `evt-${idPrefix}-${i}`;
      const messageId = `msg-${idPrefix}-${i}`;
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        eventId,
        `message.${conversationType}`,
        now + i * 1000,
        'gateway',
        '{}',
        rawCreatedAt,
      );

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

  function enableGroupSummary(groupId: string, eligibleAfter = 0): void {
    db.prepare(
      `INSERT INTO group_summary_policies (
         group_id, state, generation, eligible_after, created_at, updated_at
       ) VALUES (?, 'enabled', 1, ?, ?, ?)`,
    ).run(groupId, eligibleAfter, eligibleAfter, eligibleAfter);
  }

  function setGroupSummaryEnabled(
    groupId: string,
    enabled: boolean,
    now: number,
  ): void {
    groupSummaryPolicies.setEnabled({
      groupId,
      enabled,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'test-bot-owner',
        invocationContext: 'admin_cli',
      },
      now,
    });
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
      enableGroupSummary('group-1', now);

      // 插入超过限制的消息
      for (let i = 1; i <= 60; i++) {
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(`evt-${i}`, 'message.group', now, 'gateway', '{}', now);

        db.prepare(
          `INSERT INTO chat_messages (
             id, raw_event_id, message_id, conversation_id, conversation_type,
             group_id, sender_id, text, timestamp
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

      expect(result).not.toBeNull();
      expect(result?.messageCount).toBeLessThanOrEqual(maxMessages);
    });

    it('keeps a frozen group source window unchanged when a later row has an in-range timestamp', async () => {
      const now = Date.now();
      const conversationId = 'conv-frozen-window';
      const groupId = 'group-frozen-window';
      enableGroupSummary(groupId, now);
      const sourceChatMessageIds: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const suffix = String(index + 1).padStart(2, '0');
        const rawEventId = `raw-frozen-${suffix}`;
        const chatMessageId = `chat-frozen-${suffix}`;
        sourceChatMessageIds.push(chatMessageId);
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, 'message.group', ?, 'gateway', '{}', ?)`,
        ).run(rawEventId, now + index, now + index);
        db.prepare(
          `INSERT INTO chat_messages (
             id, raw_event_id, message_id, conversation_id, conversation_type,
             group_id, sender_id, text, timestamp
           ) VALUES (?, ?, ?, ?, 'group', ?, ?, ?, ?)`,
        ).run(
          chatMessageId,
          rawEventId,
          `platform-frozen-${suffix}`,
          conversationId,
          groupId,
          `user-${index % 2}`,
          `Frozen source ${suffix}`,
          now + index,
        );
      }

      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
         VALUES ('raw-frozen-later', 'message.group', ?, 'gateway', '{}', ?)`,
      ).run(now + 5, now + 100);
      db.prepare(
        `INSERT INTO chat_messages (
           id, raw_event_id, message_id, conversation_id, conversation_type,
           group_id, sender_id, text, timestamp
         ) VALUES (
           'chat-frozen-later', 'raw-frozen-later', 'platform-frozen-later',
           ?, 'group', ?, 'user-later', 'Later in-range source', ?
         )`,
      ).run(conversationId, groupId, now + 5);

      let selectedMessageIds: string[] = [];
      mockPiAdapter.runTurn = async (input) => {
        selectedMessageIds = input.contextPack.recentMessages.map((message) => message.messageId);
        return {
          turnId: input.turnId,
          responseText: 'SUMMARY: Frozen exact window',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 100, output: 20, total: 120 },
          status: 'completed',
        };
      };

      const result = await summaryWorker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
        sourceChatMessageIds,
      } as Parameters<SummaryWorker['generateSummary']>[0] & {
        sourceChatMessageIds: string[];
      });

      expect(selectedMessageIds).toEqual(sourceChatMessageIds);
      expect(result?.messageCount).toBe(sourceChatMessageIds.length);
      expect(db.prepare(
        `SELECT source_id
           FROM memory_sources
          WHERE memory_id = ? AND source_type = 'chat_message'
          ORDER BY source_timestamp, source_id`,
      ).all(result?.summaryId)).toEqual(
        sourceChatMessageIds.map((sourceId) => ({ source_id: sourceId })),
      );
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
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
    it('should build bounded summary context with opaque participant and conversation references', async () => {
      const conversationId = 'qq-group-9876543210';
      const senderIds = ['qq-1234567890', 'qq-2234567890'];
      const now = Date.now();
      enableGroupSummary(conversationId, now);
      for (let index = 0; index < 15; index += 1) {
        const eventId = `evt-summary-context-${index}`;
        const messageId = `msg-summary-context-${index}`;
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(eventId, 'message.group', now + index, 'gateway', '{}', now);
        db.prepare(
          `INSERT INTO chat_messages (
             id, raw_event_id, message_id, conversation_id, conversation_type,
             group_id, sender_id, text, timestamp
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          messageId,
          eventId,
          `platform-message-${index}`,
          conversationId,
          'group',
          conversationId,
          senderIds[index % senderIds.length],
          `Launch planning message ${index + 1}`,
          now + index,
        );
      }

      let capturedInput: PiAdapterInput | undefined;
      mockPiAdapter.runTurn = async (input) => {
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
        conversationId,
        conversationType: 'group',
        groupId: conversationId,
      });

      expect(result).not.toBeNull();
      expect(capturedInput).toBeDefined();
      if (!capturedInput) {
        throw new Error('Expected SummaryWorker to invoke Pi');
      }

      const serializedInput = JSON.stringify(capturedInput);
      expect(serializedInput).not.toContain(conversationId);
      for (const senderId of senderIds) {
        expect(serializedInput).not.toContain(senderId);
      }
      expect(capturedInput.turnId).toBe(capturedInput.contextPack.turnId);
      expect(capturedInput.contextPack.conversation.groupId).toMatch(
        /^summary-group-[0-9a-f]{24}$/,
      );
      expect(capturedInput.contextPack.recentMessages).toHaveLength(15);
      expect(capturedInput.contextPack.recentMessages.map((message) => message.text)).toEqual(
        Array.from({ length: 15 }, (_, index) => `Launch planning message ${index + 1}`),
      );
      expect(new Set(
        capturedInput.contextPack.recentMessages.map((message) => message.senderDisplayName),
      )).toEqual(new Set(['participant_1', 'participant_2']));
      expect(capturedInput.contextPack.memory.retrievedFacts).toEqual([]);
      expect(capturedInput.contextPack.trace).toBeDefined();
      expect(capturedInput.contextPack.trace?.filtersApplied).toContain(
        'memory=excluded_by_caller',
      );
      expect(capturedInput.contextPack.trace?.filtersApplied).not.toContain('state=active');
      expect(capturedInput.contextPack.tokenBudget.used).toBeGreaterThan(0);
      expect(capturedInput.contextPack.tokenBudget.used).toBeLessThanOrEqual(
        capturedInput.contextPack.tokenBudget.max,
      );
      expect(capturedInput.contextPack.tokenBudget.promptLayers).toBeDefined();
      expect(capturedInput.systemPrompt).toContain('Summarize the following conversation');
      expect(capturedInput.systemPrompt).not.toContain('Launch planning message');
    });

    it('should redact secret and platform identifiers from summary message text before Pi', async () => {
      const conversationId = 'conv-summary-input-redaction';
      const rawAssignment = 'api_key=sk-summary-input-secret-qq-1234567890';
      const rawSecret = 'sk-summary-input-secret-qq-1234567890';
      const rawPlatformId = 'qq-1234567890';
      insertConversationMessages({ conversationId });
      db.prepare('UPDATE chat_messages SET text = ? WHERE id = ?').run(
        `Keep this private: ${rawAssignment}`,
        `msg-${conversationId}-15`,
      );

      let capturedInput: PiAdapterInput | undefined;
      mockPiAdapter.runTurn = async (input) => {
        capturedInput = input;
        return {
          turnId: input.turnId,
          responseText: 'SUMMARY: Redacted input stayed private',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 100, output: 50, total: 150 },
          status: 'completed',
        };
      };

      const result = await summaryWorker.generateSummary({
        conversationId,
        conversationType: 'private',
      });

      expect(result).not.toBeNull();
      expect(capturedInput).toBeDefined();
      if (!capturedInput) {
        throw new Error('Expected SummaryWorker to invoke Pi');
      }
      const serializedInput = JSON.stringify(capturedInput);
      expect(serializedInput).toContain('[REDACTED:api_key_assignment]');
      expect(serializedInput).toContain('[REDACTED:platform_id]');
      expect(serializedInput).not.toContain(rawAssignment);
      expect(serializedInput).not.toContain(rawSecret);
      expect(serializedInput).not.toContain(rawPlatformId);
      expect(serializedInput).not.toContain('1234567890');
      expect(
        (db.prepare('SELECT text FROM chat_messages WHERE id = ?').get(
          `msg-${conversationId}-15`,
        ) as { text: string }).text,
      ).toBe(`Keep this private: ${rawAssignment}`);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should reject a mismatched group boundary before Pi or memory writes', async () => {
      insertConversationMessages({
        conversationId: 'conv-group-boundary',
        conversationType: 'group',
        groupId: 'group-correct',
      });
      enableGroupSummary('group-wrong');
      let piCalls = 0;
      mockPiAdapter.runTurn = async () => {
        piCalls += 1;
        throw new Error('Pi must not run for a mismatched group boundary');
      };

      const result = await summaryWorker.generateSummary({
        conversationId: 'conv-group-boundary',
        conversationType: 'group',
        groupId: 'group-wrong',
      });

      expect(result).toBeNull();
      expect(piCalls).toBe(0);
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number }).count,
      ).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

      await expect(summaryWorker.generateSummary({
        conversationId: 'conv-group-boundary',
        conversationType: 'group',
      })).rejects.toThrow('Group summary requires a groupId');
      expect(piCalls).toBe(0);
    });

    it('should reject context messages that cannot be traced to loaded chat messages', async () => {
      const conversationId = 'conv-summary-untraceable-context';
      insertConversationMessages({ conversationId });
      const baseContextBuilder = new ContextBuilder(memoryRepo, identityRepo);
      let piCalls = 0;
      mockPiAdapter.runTurn = async () => {
        piCalls += 1;
        throw new Error('Pi must not run with an untraceable summary message');
      };
      const worker = new SummaryWorker(
        db,
        mockPiAdapter,
        memoryRepo,
        {
          async build(input) {
            const context = await baseContextBuilder.build(input);
            return {
              ...context,
              recentMessages: [
                ...context.recentMessages,
                {
                  messageId: 'chat-message-not-loaded',
                  senderId: 'participant_99',
                  senderDisplayName: 'participant_99',
                  text: 'Injected text must not reach Pi',
                  timestamp: new Date(),
                  isFromBot: false,
                },
              ],
            };
          },
        },
      );

      await expect(worker.generateSummary({
        conversationId,
        conversationType: 'private',
      })).rejects.toThrow('Summary context contains an untraceable source message');

      expect(piCalls).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should source a summary only from messages retained by the hard context budget', async () => {
      const conversationId = 'conv-summary-hard-budget';
      const now = Date.now();
      for (let index = 0; index < 15; index += 1) {
        const eventId = `evt-summary-hard-budget-${index}`;
        const messageId = `msg-summary-hard-budget-${index}`;
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(eventId, 'message.private', now + index, 'gateway', '{}', now);
        db.prepare(
          `INSERT INTO chat_messages (
             id, raw_event_id, message_id, conversation_id, conversation_type,
             sender_id, text, timestamp
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          messageId,
          eventId,
          `platform-hard-budget-${index}`,
          conversationId,
          'private',
          'user-hard-budget',
          `${'多字节上下文'.repeat(300)}-${index}`,
          now + index,
        );
      }

      let capturedInput: PiAdapterInput | undefined;
      mockPiAdapter.runTurn = async (input) => {
        capturedInput = input;
        return {
          turnId: input.turnId,
          responseText: 'SUMMARY: Bounded summary\nFACTS:\n- Only selected messages are sources',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 100, output: 50, total: 150 },
          status: 'completed',
        };
      };

      const result = await summaryWorker.generateSummary({
        conversationId,
        conversationType: 'private',
      });

      expect(result).not.toBeNull();
      expect(capturedInput).toBeDefined();
      if (!result || !capturedInput) {
        throw new Error('Expected bounded summary result and Pi input');
      }
      expect(result.messageCount).toBeLessThan(15);
      expect(capturedInput.contextPack.tokenBudget.used).toBeLessThanOrEqual(
        capturedInput.contextPack.tokenBudget.max,
      );
      const selectedMessageIds = capturedInput.contextPack.recentMessages
        .map((message) => message.messageId)
        .sort();
      const sourceIds = (db.prepare(
        `SELECT source_id
         FROM memory_sources
         WHERE memory_id = ? AND source_type = 'chat_message'
         ORDER BY source_id`,
      ).all(result.summaryId) as Array<{ source_id: string }>).map((row) => row.source_id);
      expect(sourceIds).toEqual(selectedMessageIds);
      expect(sourceIds).toHaveLength(result.messageCount);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
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
      enableGroupSummary('group-1', now);

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
      expect(memory?.visibility).toBe('private_only');
    });

    it('should set appropriate visibility for group conversation', async () => {
      const now = Date.now();
      enableGroupSummary('group-1', now);

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

  describe('Group summary policy', () => {
    it('keeps group summaries default-off without changing private summaries', async () => {
      const now = Date.now();
      insertConversationMessages({
        conversationId: 'conv-default-off-group',
        conversationType: 'group',
        groupId: 'group-default-off',
        startTime: now,
      });
      insertConversationMessages({
        conversationId: 'conv-private-unaffected',
        startTime: now,
      });
      let providerCalls = 0;
      mockPiAdapter.runTurn = async (input) => {
        providerCalls += 1;
        return {
          turnId: input.turnId,
          responseText: 'SUMMARY: Private summary remains enabled',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 10, output: 5, total: 15 },
          status: 'completed',
        };
      };

      await expect(summaryWorker.generateSummary({
        conversationId: 'conv-default-off-group',
        conversationType: 'group',
        groupId: 'group-default-off',
      })).rejects.toMatchObject<GroupSummaryPolicyError>({ code: 'policy_disabled' });

      const privateResult = await summaryWorker.generateSummary({
        conversationId: 'conv-private-unaffected',
        conversationType: 'private',
      });
      expect(privateResult).not.toBeNull();
      expect(providerCalls).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('discovers group work by local ingress time and only after the enabled epoch', async () => {
      const now = Date.now();
      const groupId = 'group-discovery-epoch';
      const conversationId = 'conv-discovery-epoch';
      enableGroupSummary(groupId, now);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        count: 15,
        idPrefix: 'discovery-before',
        startTime: now + 50_000,
        rawCreatedAt: now - 1,
      });
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        count: 15,
        idPrefix: 'discovery-after',
        startTime: 1_000,
        rawCreatedAt: now + 1,
      });
      insertConversationMessages({
        conversationId: 'conv-discovery-default-off',
        conversationType: 'group',
        groupId: 'group-discovery-default-off',
        startTime: now,
        rawCreatedAt: now,
      });

      const conversations = await summaryWorker.findConversationsNeedingSummary(60);
      const candidate = conversations.find((item) => item.conversationId === conversationId);
      expect(candidate).toEqual({
        conversationId,
        conversationType: 'group',
        groupId,
        timeRange: { startTime: 2_000, endTime: 16_000 },
      });
      expect(conversations.some(
        (item) => item.conversationId === 'conv-discovery-default-off',
      )).toBe(false);

      if (!candidate) {
        throw new Error('Expected enabled post-epoch group discovery candidate');
      }
      const result = await summaryWorker.generateSummary(candidate);
      expect(result?.messageCount).toBe(15);
      const sources = db.prepare(
        'SELECT source_id FROM memory_sources WHERE memory_id = ? ORDER BY source_id',
      ).all(result?.summaryId) as Array<{ source_id: string }>;
      expect(sources.every((row) => row.source_id.startsWith('msg-discovery-after-'))).toBe(true);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('excludes both earlier generations and the disabled interval after re-enable', async () => {
      const base = Date.now();
      const groupId = 'group-reenable-epoch';
      const conversationId = 'conv-reenable-epoch';
      setGroupSummaryEnabled(groupId, true, base);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        count: 10,
        idPrefix: 'reenable-first',
        startTime: base,
        rawCreatedAt: base,
      });
      setGroupSummaryEnabled(groupId, false, base + 100);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        count: 10,
        idPrefix: 'reenable-disabled',
        startTime: base + 200,
        rawCreatedAt: base + 200,
      });
      setGroupSummaryEnabled(groupId, true, base + 300);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        count: 10,
        idPrefix: 'reenable-current',
        startTime: base + 400,
        rawCreatedAt: base + 301,
      });

      const result = await summaryWorker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
        timeRange: { startTime: base, endTime: base + 20_000 },
      });
      expect(result?.messageCount).toBe(10);
      const sources = db.prepare(
        'SELECT source_id FROM memory_sources WHERE memory_id = ? ORDER BY source_id',
      ).all(result?.summaryId) as Array<{ source_id: string }>;
      expect(sources).toHaveLength(10);
      expect(sources.every((row) => row.source_id.startsWith('msg-reenable-current-'))).toBe(true);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it.each([
      ['unbound', 'job_not_bound'],
      ['disabled', 'policy_disabled'],
      ['stale', 'stale_policy_generation'],
    ] as const)('blocks %s durable group execution before Provider or worker writes', async (
      scenario,
      expectedCode,
    ) => {
      const base = Date.now();
      const groupId = `group-durable-${scenario}`;
      const conversationId = `conv-durable-${scenario}`;
      enableGroupSummary(groupId, base);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        startTime: base + 1,
        rawCreatedAt: base + 1,
      });
      const jobs = new JobRepository(db);
      const jobId = jobs.enqueue({
        id: `job-durable-${scenario}`,
        type: 'summary',
        payload: { conversationId, conversationType: 'group', groupId },
        now: base + 1,
      });
      if (scenario !== 'unbound') {
        groupSummaryPolicies.bindSummaryJob({
          jobId,
          groupId,
          conversationId,
          now: base + 1,
        });
      }
      const claimed = jobs.claimNext({
        workerId: `worker-${scenario}`,
        types: ['summary'],
        now: base + 2,
        leaseMs: 60_000,
      });
      expect(claimed?.job.id).toBe(jobId);
      if (scenario !== 'unbound') {
        setGroupSummaryEnabled(groupId, false, base + 3);
      }
      if (scenario === 'stale') {
        setGroupSummaryEnabled(groupId, true, base + 4);
      }
      let providerCalls = 0;
      mockPiAdapter.runTurn = async () => {
        providerCalls += 1;
        throw new Error('Provider must not run');
      };

      await expect(summaryWorker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
      }, {
        jobId,
        jobAttemptId: claimed?.attemptId ?? '',
        attemptNumber: claimed?.attemptNumber ?? 0,
        now: base + 5,
      })).rejects.toMatchObject<GroupSummaryPolicyError>({ code: expectedCode });

      expect(providerCalls).toBe(0);
      for (const table of [
        'memory_records',
        'memory_sources',
        'memory_revisions',
        'model_contexts',
        'model_invocations',
      ]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects invalid frozen sources for a valid durable binding before Provider access', async () => {
      const base = Date.now();
      const groupId = 'group-frozen-validation';
      const conversationId = 'conv-frozen-validation';
      enableGroupSummary(groupId, base);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        count: 10,
        idPrefix: 'frozen-validation',
        startTime: base + 1,
        rawCreatedAt: base + 1,
      });
      const sourceIds = db.prepare(
        `SELECT cm.id
           FROM chat_messages AS cm
           JOIN raw_events AS re ON re.id = cm.raw_event_id
          WHERE cm.conversation_id = ? AND cm.group_id = ?
          ORDER BY re.created_at, re.id, cm.id`,
      ).pluck().all(conversationId, groupId) as string[];

      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        count: 1,
        idPrefix: 'frozen-pre-epoch',
        startTime: base - 1,
        rawCreatedAt: base - 1,
      });
      insertConversationMessages({
        conversationId: 'conv-frozen-other',
        conversationType: 'group',
        groupId: 'group-frozen-other',
        count: 1,
        idPrefix: 'frozen-other',
        startTime: base + 1,
        rawCreatedAt: base + 1,
      });

      const jobs = new JobRepository(db);
      const jobId = jobs.enqueue({
        id: 'job-frozen-validation',
        type: 'summary',
        payload: {
          conversationId,
          conversationType: 'group',
          groupId,
          windowVersion: 1,
          sourceChatMessageIds: sourceIds,
          candidateCount: sourceIds.length,
        },
        now: base + 1,
      });
      groupSummaryPolicies.bindSummaryJob({
        jobId,
        groupId,
        conversationId,
        now: base + 1,
      });
      const claimed = jobs.claimNext({
        workerId: 'worker-frozen-validation',
        types: ['summary'],
        now: base + 2,
        leaseMs: 60_000,
      });
      expect(claimed?.job.id).toBe(jobId);

      let providerCalls = 0;
      mockPiAdapter.runTurn = async () => {
        providerCalls += 1;
        throw new Error('Provider must not run');
      };
      const execution = {
        jobId,
        jobAttemptId: claimed?.attemptId ?? '',
        attemptNumber: claimed?.attemptNumber ?? 0,
        now: base + 3,
      };
      const invalidSourceSets: Array<string[] | undefined> = [
        undefined,
        [],
        [sourceIds[0] ?? '', sourceIds[0] ?? '', ...sourceIds.slice(2)],
        [...sourceIds].reverse(),
        ['missing-frozen-source', ...sourceIds.slice(1)],
        ['msg-frozen-pre-epoch-1', ...sourceIds.slice(1)],
        [...sourceIds.slice(0, -1), 'msg-frozen-other-1'],
      ];

      for (const sourceChatMessageIds of invalidSourceSets) {
        await expect(summaryWorker.generateSummary({
          conversationId,
          conversationType: 'group',
          groupId,
          sourceChatMessageIds,
        }, execution)).rejects.toMatchObject<GroupSummaryPolicyError>({
          code: 'job_binding_mismatch',
        });
      }

      const baseBuilder = new ContextBuilder(memoryRepo, identityRepo);
      const omittingWorker = new SummaryWorker(db, mockPiAdapter, memoryRepo, {
        async build(input) {
          const contextPack = await baseBuilder.build(input);
          return {
            ...contextPack,
            recentMessages: contextPack.recentMessages.slice(1),
          };
        },
      });
      await expect(omittingWorker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
        sourceChatMessageIds: sourceIds,
      }, execution)).rejects.toMatchObject<GroupSummaryPolicyError>({
        code: 'job_binding_mismatch',
      });

      expect(providerCalls).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM model_contexts').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM model_invocations').get()).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rechecks policy before returning an existing group summary', async () => {
      const now = Date.now();
      const groupId = 'group-existing-recheck';
      const conversationId = 'conv-existing-recheck';
      enableGroupSummary(groupId, now);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        startTime: now,
        rawCreatedAt: now,
      });
      const baseBuilder = new ContextBuilder(memoryRepo, identityRepo);
      let buildCount = 0;
      const worker = new SummaryWorker(db, mockPiAdapter, memoryRepo, {
        async build(input) {
          const context = await baseBuilder.build(input);
          buildCount += 1;
          if (buildCount === 2) {
            setGroupSummaryEnabled(groupId, false, now + 1);
          }
          return context;
        },
      });
      let providerCalls = 0;
      mockPiAdapter.runTurn = async (input) => {
        providerCalls += 1;
        return {
          turnId: input.turnId,
          responseText: 'SUMMARY: Existing authorized summary',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 10, output: 5, total: 15 },
          status: 'completed',
        };
      };

      const first = await worker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
      });
      expect(first).not.toBeNull();
      await expect(worker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
      })).rejects.toMatchObject<GroupSummaryPolicyError>({ code: 'policy_disabled' });
      expect(providerCalls).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 1 });
    });

    it('revalidates every selected raw ingress timestamp in the atomic write gate', async () => {
      const now = Date.now();
      const groupId = 'group-source-epoch-recheck';
      const conversationId = 'conv-source-epoch-recheck';
      enableGroupSummary(groupId, now);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        startTime: now,
        rawCreatedAt: now,
      });
      let providerCalls = 0;
      mockPiAdapter.runTurn = async (input) => {
        providerCalls += 1;
        db.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(
          now - 1,
          `evt-${conversationId}-1`,
        );
        return {
          turnId: input.turnId,
          responseText: 'SUMMARY: Source epoch changed during Provider I/O',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 10, output: 5, total: 15 },
          status: 'completed',
        };
      };

      await expect(summaryWorker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
      })).rejects.toMatchObject<GroupSummaryPolicyError>({
        code: 'stale_policy_generation',
      });
      expect(providerCalls).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });
  });

  describe('Error Handling', () => {
    it('should reject secret-like model output before durable summary writes', async () => {
      insertConversationMessages({ conversationId: 'conv-secret-summary-output' });
      const secretLikeOutput = 'sk-summary-output-secret-should-never-persist';
      mockPiAdapter.runTurn = async (input) => ({
        turnId: input.turnId,
        responseText: `SUMMARY: api_key=${secretLikeOutput}\nFACTS:\n- confidential`,
        toolCallIds: [],
        events: [],
        tokensUsed: { input: 100, output: 50, total: 150 },
        status: 'completed',
      });

      await expect(summaryWorker.generateSummary({
        conversationId: 'conv-secret-summary-output',
        conversationType: 'private',
      })).rejects.toThrow('Memory content matched deterministic secret/prohibited policy');

      for (const table of [
        'memory_records',
        'memory_sources',
        'memory_revisions',
        'audit_log',
        'memory_fts',
      ]) {
        const count = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }).count;
        expect(count).toBe(0);
      }
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

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
      let piCalls = 0;
      mockPiAdapter.runTurn = async () => {
        piCalls += 1;
        return {
          turnId: 'test-turn',
          responseText: '  \n\t',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 0, output: 0, total: 0 },
          status: 'completed',
        };
      };

      await expect(
        summaryWorker.generateSummary({
          conversationId: 'conv-1',
          conversationType: 'private',
        })
      ).rejects.toThrow('LLM returned empty response');
      expect(piCalls).toBe(2);
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

      const capturedInputs: PiAdapterInput[] = [];
      mockPiAdapter.runTurn = async (input) => {
        capturedInputs.push(input);
        if (capturedInputs.length === 1) {
          return {
            turnId: input.turnId,
            responseText: '',
            errorMessage: 'Provider timeout',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 0, output: 0, total: 0 },
            status: 'failed',
          };
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
      expect(capturedInputs).toHaveLength(2);
      expect(capturedInputs[1]?.contextPack).toBe(capturedInputs[0]?.contextPack);
      expect(capturedInputs[1]?.turnId).toBe(capturedInputs[0]?.turnId);
      expect(capturedInputs[0]?.contextPack.trace).toBeDefined();
      expect(capturedInputs[0]?.contextPack.tokenBudget.used).toBeGreaterThan(0);
      expect(capturedInputs[0]?.turnId).toBe(capturedInputs[0]?.contextPack.turnId);
    });
  });

  describe('findConversationsNeedingSummary', () => {
    it('advances past sources owned by a terminally failed frozen window', async () => {
      const now = Date.now();
      const conversationId = 'conv-failed-window-advance';
      const groupId = 'group-failed-window-advance';
      enableGroupSummary(groupId, now);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        count: 20,
        idPrefix: 'failed-window-advance',
        startTime: now,
        rawCreatedAt: now,
      });
      const canonicalIds = db.prepare(
        `SELECT cm.id
           FROM chat_messages AS cm
           JOIN raw_events AS re ON re.id = cm.raw_event_id
          WHERE cm.conversation_id = ? AND cm.group_id = ?
          ORDER BY re.created_at, re.id, cm.id`,
      ).pluck().all(conversationId, groupId) as string[];
      const jobs = new JobRepository(db);
      const failedJobId = jobs.enqueue({
        type: 'summary',
        payload: {
          conversationId,
          conversationType: 'group',
          groupId,
          windowVersion: 1,
          sourceChatMessageIds: canonicalIds.slice(0, 10),
          candidateCount: 10,
        },
        idempotencyKey: 'summary:failed-window-advance',
        now: now + 1,
      });
      groupSummaryPolicies.bindSummaryJob({
        jobId: failedJobId,
        groupId,
        conversationId,
        now: now + 1,
      });
      db.prepare(
        `UPDATE jobs
            SET status = 'failed', completed_at = ?, updated_at = ?, error = 'terminal failure'
          WHERE id = ?`,
      ).run(now + 2, now + 2, failedJobId);
      const windowedWorker = new SummaryWorker(
        db,
        mockPiAdapter,
        memoryRepo,
        new ContextBuilder(memoryRepo, identityRepo),
        { maxMessagesToSummarize: 10, minMessagesToTrigger: 10 },
      );

      await expect(windowedWorker.planGroupSummaryWindow({
        conversationId,
        groupId,
        eligibleAfter: now,
      })).resolves.toEqual({
        sourceChatMessageIds: canonicalIds.slice(10),
        candidateCount: 10,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('freezes the exact canonical suffix retained by the context token budget', async () => {
      const now = Date.now();
      const conversationId = 'conv-post-budget-window';
      const groupId = 'group-post-budget-window';
      enableGroupSummary(groupId, now);
      insertConversationMessages({
        conversationId,
        conversationType: 'group',
        groupId,
        count: 10,
        idPrefix: 'post-budget-window',
        startTime: now,
        rawCreatedAt: now,
        textPrefix: 'x'.repeat(4_000),
      });
      const canonicalIds = db.prepare(
        `SELECT cm.id
           FROM chat_messages AS cm
           JOIN raw_events AS re ON re.id = cm.raw_event_id
          WHERE cm.conversation_id = ? AND cm.group_id = ?
          ORDER BY re.created_at, re.id, cm.id`,
      ).pluck().all(conversationId, groupId) as string[];
      const windowedWorker = new SummaryWorker(
        db,
        mockPiAdapter,
        memoryRepo,
        new ContextBuilder(memoryRepo, identityRepo),
        { maxMessagesToSummarize: 10, minMessagesToTrigger: 10 },
      );

      const plan = await windowedWorker.planGroupSummaryWindow({
        conversationId,
        groupId,
        eligibleAfter: now,
      });

      expect(plan?.candidateCount).toBe(10);
      expect(plan?.sourceChatMessageIds.length).toBeGreaterThan(0);
      expect(plan?.sourceChatMessageIds.length).toBeLessThan(10);
      expect(plan?.sourceChatMessageIds).toEqual(
        canonicalIds.slice(-(plan?.sourceChatMessageIds.length ?? 0)),
      );
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('plans disjoint completed group windows in raw ingress order', async () => {
      const now = Date.now();
      const conversationId = 'conv-disjoint-windows';
      const groupId = 'group-disjoint-windows';
      enableGroupSummary(groupId, now);
      const expectedIds = Array.from({ length: 25 }, (_, index) => {
        const suffix = String(index + 1).padStart(2, '0');
        const rawEventId = `raw-disjoint-${suffix}`;
        const chatMessageId = `chat-disjoint-${suffix}`;
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, 'message.group', ?, 'gateway', '{}', ?)`,
        ).run(rawEventId, now + 100 - index, now + index);
        db.prepare(
          `INSERT INTO chat_messages (
             id, raw_event_id, message_id, conversation_id, conversation_type,
             group_id, sender_id, text, timestamp
           ) VALUES (?, ?, ?, ?, 'group', ?, 'user-disjoint', ?, ?)`,
        ).run(
          chatMessageId,
          rawEventId,
          `platform-disjoint-${suffix}`,
          conversationId,
          groupId,
          `Disjoint source ${suffix}`,
          now + 100 - index,
        );
        return chatMessageId;
      });
      const windowedWorker = new SummaryWorker(
        db,
        mockPiAdapter,
        memoryRepo,
        new ContextBuilder(memoryRepo, identityRepo),
        { maxMessagesToSummarize: 10, minMessagesToTrigger: 10 },
      );

      const first = await windowedWorker.planGroupSummaryWindow({
        conversationId,
        groupId,
        eligibleAfter: now,
      });
      expect(first).toEqual({
        sourceChatMessageIds: expectedIds.slice(0, 10),
        candidateCount: 10,
      });
      if (!first) {
        throw new Error('Expected the first frozen group summary window');
      }
      await windowedWorker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
        sourceChatMessageIds: first.sourceChatMessageIds,
      });

      const second = await windowedWorker.planGroupSummaryWindow({
        conversationId,
        groupId,
        eligibleAfter: now,
      });
      expect(second).toEqual({
        sourceChatMessageIds: expectedIds.slice(10, 20),
        candidateCount: 10,
      });
      if (!second) {
        throw new Error('Expected the second frozen group summary window');
      }
      await windowedWorker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
        sourceChatMessageIds: second.sourceChatMessageIds,
      });

      expect(await windowedWorker.planGroupSummaryWindow({
        conversationId,
        groupId,
        eligibleAfter: now,
      })).toBeNull();
      const sourceRows = db.prepare(
        `SELECT source_id
           FROM memory_sources
          WHERE source_type = 'chat_message'
            AND source_id LIKE 'chat-disjoint-%'
          ORDER BY source_id`,
      ).all() as Array<{ source_id: string }>;
      expect(sourceRows.map((row) => row.source_id)).toEqual(expectedIds.slice(0, 20));
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

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
