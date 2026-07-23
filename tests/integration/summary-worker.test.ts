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
import { GroupSummaryPolicyRepository } from '../../src/storage/group-summary-policy-repository.js';
import { JobRepository } from '../../src/storage/job-repository.js';
import { initDatabase, runMigrations } from '../../src/storage/database.js';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('SummaryWorker Integration', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let groupSummaryPolicies: GroupSummaryPolicyRepository;
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
    runMigrations(db, join(__dirname, '../../migrations'));

    // 初始化仓库
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    groupSummaryPolicies = new GroupSummaryPolicyRepository(db);

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

    summaryWorker = new SummaryWorker(
      db,
      mockPiAdapter,
      memoryRepo,
      new ContextBuilder(memoryRepo, identityRepo),
    );
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
      if (!result) {
        throw new Error('Expected summary generation result');
      }
      expect(result?.summaryId).toBeTruthy();
      expect(result?.summary).toContain('project');
      expect(result?.messageCount).toBe(messages.length);
      expect(result?.extractedFacts.length).toBeGreaterThan(0);

      // 验证摘要已存储
      const memory = await memoryRepo.findById(result.summaryId);
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
      if (!result) {
        throw new Error('Expected summary generation result');
      }

      // 检查源链接
      const sources = db
        .prepare('SELECT * FROM memory_sources WHERE memory_id = ?')
        .all(result.summaryId) as Array<{
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

    it('does not commit a durable group summary when policy is disabled during Provider I/O', async () => {
      const base = Date.now();
      const groupId = 'group-disable-during-provider';
      const conversationId = 'conv-disable-during-provider';
      const sourceChatMessageIds: string[] = [];
      enableGroupSummary(groupId, base);
      for (let index = 0; index < 15; index += 1) {
        const rawEventId = `evt-disable-during-provider-${index}`;
        const chatMessageId = `msg-disable-during-provider-${index}`;
        sourceChatMessageIds.push(chatMessageId);
        db.prepare(
          `INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
           VALUES (?, 'message.group', ?, 'gateway', '{}', ?)`,
        ).run(rawEventId, base + index, base + index + 1);
        db.prepare(
          `INSERT INTO chat_messages (
             id, raw_event_id, message_id, conversation_id, conversation_type,
             group_id, sender_id, text, timestamp
           ) VALUES (?, ?, ?, ?, 'group', ?, ?, ?, ?)`,
        ).run(
          chatMessageId,
          rawEventId,
          `platform-disable-during-provider-${index}`,
          conversationId,
          groupId,
          `user-${index % 3}`,
          `Message ${index}`,
          base + index,
        );
      }
      const jobs = new JobRepository(db);
      const jobId = jobs.enqueue({
        id: 'job-disable-during-provider',
        type: 'summary',
        payload: {
          conversationId,
          conversationType: 'group',
          groupId,
          windowVersion: 1,
          sourceChatMessageIds,
          candidateCount: sourceChatMessageIds.length,
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
        workerId: 'summary-worker-provider-race',
        types: ['summary'],
        now: base + 2,
        leaseMs: 60_000,
      });
      expect(claimed?.job.id).toBe(jobId);
      let providerCalls = 0;
      mockPiAdapter.runTurn = async (input) => {
        providerCalls += 1;
        setGroupSummaryEnabled(groupId, false, base + 3);
        return {
          turnId: input.turnId,
          responseText: 'SUMMARY: This result must not be committed',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 20, output: 10, total: 30 },
          status: 'completed',
        };
      };
      const durableWorker = new SummaryWorker(
        db,
        mockPiAdapter,
        memoryRepo,
        new ContextBuilder(memoryRepo, identityRepo),
        {
          requireDurableExecution: true,
          piProvider: 'test-provider',
          piModel: 'test-model',
        },
      );

      await expect(durableWorker.generateSummary({
        conversationId,
        conversationType: 'group',
        groupId,
        sourceChatMessageIds,
      }, {
        jobId,
        jobAttemptId: claimed?.attemptId ?? '',
        attemptNumber: claimed?.attemptNumber ?? 0,
        now: base + 4,
      })).rejects.toMatchObject({ code: 'policy_disabled' });

      expect(providerCalls).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT status FROM model_invocations').all()).toEqual([
        { status: 'completed' },
      ]);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
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
      enableGroupSummary('group-1', now);

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
      if (!privateResult || !groupResult) {
        throw new Error('Expected private and group summary generation results');
      }

      // 验证私聊摘要的可见性
      const privateMemory = await memoryRepo.findById(privateResult.summaryId);
      expect(privateMemory?.visibility).toBe('private_only');

      // 验证群聊摘要的可见性
      const groupMemory = await memoryRepo.findById(groupResult.summaryId);
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
        groupId: 'group-1',
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
