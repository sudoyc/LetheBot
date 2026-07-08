/**
 * E2E Test: Full Memory Cycle
 *
 * 验证完整的记忆循环：用户陈述 → 提取 → 存储 → 检索 → 使用
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase } from '../../src/storage/database.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import { IdentityRepository } from '../../src/storage/identity-repository.js';
import { ContextBuilder } from '../../src/context/builder.js';
import { MemoryExtractionWorker } from '../../src/workers/memory-extraction.js';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('E2E: Full Memory Cycle', () => {
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let contextBuilder: ContextBuilder;
  let memoryExtractor: MemoryExtractionWorker;
  const testDbPath = join(__dirname, '../../data/test-e2e-memory-cycle.db');

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

    // 初始化组件
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    contextBuilder = new ContextBuilder(memoryRepo, identityRepo, db);
    memoryExtractor = new MemoryExtractionWorker(db);

    // 创建测试用户
    await identityRepo.ensureCanonicalUser('user-alice');
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  it('should complete full memory cycle: extract → store → retrieve → use', async () => {
    const userId = 'user-alice';
    const conversationId = 'conv-private-1';

    // 1. 用户陈述偏好
    const userMessage = '我喜欢喝咖啡';
    const botResponse = '知道了，你喜欢喝咖啡';

    // 2. 提取记忆
    await memoryExtractor.extractFromTurn({
      conversationId,
      userId,
      userMessage,
      botResponse,
    });

    // 3. 验证存储
    const storedMemories = await memoryRepo.retrieve({
      canonicalUserId: userId,
      state: 'active',
    });

    expect(storedMemories.length).toBeGreaterThan(0);
    expect(storedMemories[0].content).toBe(userMessage);

    // 4. 构建上下文（检索记忆）
    const context = await contextBuilder.buildContext({
      turnId: 'turn-2',
      conversationId,
      conversationType: 'private',
      recentMessages: [
        {
          messageId: 'msg-2',
          senderId: userId,
          text: '我喜欢什么饮料？',
          timestamp: Date.now(),
          senderDisplayName: 'Alice',
          isFromBot: false,
        },
      ],
      targetUserId: userId,
    });

    // 5. 验证记忆被检索
    expect(context.memory.retrievedFacts.length).toBeGreaterThan(0);
    expect(context.memory.retrievedFacts[0].content).toContain('咖啡');

    // 6. 验证记忆 ID 记录
    expect(context.memory.selectedMemoryIds.length).toBeGreaterThan(0);
  });

  it('should extract multiple preferences from conversation', async () => {
    const userId = 'user-bob';
    const conversationId = 'conv-2';

    await identityRepo.ensureCanonicalUser(userId);

    // 多轮对话
    const turns = [
      { user: '我叫 Bob', bot: '你好 Bob' },
      { user: '我喜欢编程', bot: '编程很有趣' },
      { user: '我需要学习 TypeScript', bot: '好的' },
    ];

    for (const turn of turns) {
      await memoryExtractor.extractFromTurn({
        conversationId,
        userId,
        userMessage: turn.user,
        botResponse: turn.bot,
      });
    }

    // 验证所有记忆
    const memories = await memoryRepo.retrieve({
      canonicalUserId: userId,
      state: 'active',
    });

    expect(memories.length).toBeGreaterThanOrEqual(3);

    const contents = memories.map(m => m.content);
    expect(contents.some(c => c.includes('Bob'))).toBe(true);
    expect(contents.some(c => c.includes('编程'))).toBe(true);
    expect(contents.some(c => c.includes('TypeScript'))).toBe(true);
  });

  it('should respect visibility rules in memory retrieval', async () => {
    const userId = 'user-charlie';
    const privateConvId = 'conv-private';
    const groupConvId = 'conv-group-1';

    await identityRepo.ensureCanonicalUser(userId);

    // 在私聊中陈述
    await memoryExtractor.extractFromTurn({
      conversationId: privateConvId,
      userId,
      userMessage: '我的生日是 1月1日',
      botResponse: '记住了',
    });

    // 手动设置为 private_only
    const privateMemory = await memoryRepo.retrieve({
      canonicalUserId: userId,
      state: 'active',
    });

    if (privateMemory[0]) {
      await db.prepare('UPDATE memory_records SET visibility = ? WHERE id = ?')
        .run('private_only', privateMemory[0].id);
    }

    // 在私聊中应该能检索到
    const privateContext = await contextBuilder.buildContext({
      turnId: 'turn-1',
      conversationId: privateConvId,
      conversationType: 'private',
      recentMessages: [],
      targetUserId: userId,
    });

    expect(privateContext.memory.retrievedFacts.length).toBeGreaterThan(0);

    // 在群聊中不应该检索到 private_only 记忆
    const groupContext = await contextBuilder.buildContext({
      turnId: 'turn-2',
      conversationId: groupConvId,
      conversationType: 'group',
      recentMessages: [],
      targetUserId: userId,
      groupId: 'group-1',
    });

    expect(groupContext.memory.retrievedFacts.length).toBe(0);
  });

  it('should complete governed proposal lifecycle with source/revision/audit and retrieval exclusion', async () => {
    const userId = 'user-elena';
    const groupId = 'group-governed';
    const conversationId = 'conv-group-governed';

    await identityRepo.ensureCanonicalUser(userId);

    const extraction = await memoryExtractor.extractFromTurn({
      conversationId,
      userId,
      userMessage: '我喜欢在群里讨论 Rust',
      botResponse: '收到',
      messageId: 'msg-rust-pref',
      timestamp: 123456,
      conversationType: 'group',
      groupId,
    });

    const proposalId = extraction.memoryIds[0];
    expect(proposalId).toBeDefined();

    const proposal = await memoryRepo.findById(proposalId);
    expect(proposal?.state).toBe('proposed');
    expect(proposal?.sourceContext).toBe('group_chat');

    const noActiveBeforeApproval = await memoryRepo.retrieve({ canonicalUserId: userId });
    expect(noActiveBeforeApproval.map((memory) => memory.id)).not.toContain(proposalId);

    await memoryRepo.approve(proposalId, {
      actor: { canonicalUserId: 'admin', actorClass: 'admin', context: 'admin_cli' },
      reason: 'E2E approve group proposal',
      auditSummary: `E2E approved ${proposalId}`,
    });

    const approvedContext = await contextBuilder.buildContext({
      turnId: 'turn-governed-approved',
      conversationId,
      conversationType: 'group',
      recentMessages: [],
      targetUserId: userId,
      groupId,
    });

    expect(approvedContext.memory.selectedMemoryIds).toContain(proposalId);

    await memoryRepo.disable(proposalId, {
      actor: { canonicalUserId: 'admin', actorClass: 'admin', context: 'admin_cli' },
      reason: 'E2E disable approved memory',
    });

    const disabledContext = await contextBuilder.buildContext({
      turnId: 'turn-governed-disabled',
      conversationId,
      conversationType: 'group',
      recentMessages: [],
      targetUserId: userId,
      groupId,
    });

    expect(disabledContext.memory.selectedMemoryIds).not.toContain(proposalId);

    await memoryRepo.restore(proposalId, {
      actor: { canonicalUserId: 'admin', actorClass: 'admin', context: 'admin_cli' },
      reason: 'E2E restore disabled memory',
    });

    const replacementId = await memoryRepo.create({
      scope: 'user',
      canonicalUserId: userId,
      groupId,
      conversationId,
      visibility: 'same_group_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'Updated Rust discussion preference',
      content: 'Elena prefers Rust async-runtime discussions in this group',
      state: 'active',
      confidence: 0.9,
      importance: 0.8,
      sourceContext: 'group_chat',
      sources: [
        {
          sourceType: 'chat_message',
          sourceId: 'msg-rust-pref-update',
          sourceTimestamp: 123999,
          extractedBy: 'worker',
        },
      ],
    });

    await memoryRepo.supersede(proposalId, {
      actor: { canonicalUserId: 'admin', actorClass: 'admin', context: 'admin_cli' },
      reason: `E2E superseded by ${replacementId}`,
    });

    const supersededContext = await contextBuilder.buildContext({
      turnId: 'turn-governed-superseded',
      conversationId,
      conversationType: 'group',
      recentMessages: [],
      targetUserId: userId,
      groupId,
    });

    expect(supersededContext.memory.selectedMemoryIds).not.toContain(proposalId);
    expect(supersededContext.memory.selectedMemoryIds).toContain(replacementId);

    await memoryRepo.delete(replacementId, {
      actor: { canonicalUserId: 'admin', actorClass: 'admin', context: 'admin_cli' },
      reason: 'E2E delete replacement memory',
    });

    const deletedContext = await contextBuilder.buildContext({
      turnId: 'turn-governed-deleted',
      conversationId,
      conversationType: 'group',
      recentMessages: [],
      targetUserId: userId,
      groupId,
    });

    expect(deletedContext.memory.selectedMemoryIds).not.toContain(replacementId);

    const sources = db
      .prepare('SELECT source_id FROM memory_sources WHERE memory_id = ? ORDER BY source_id ASC')
      .all(proposalId) as Array<{ source_id: string }>;
    const revisions = db
      .prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(proposalId) as Array<{ change_type: string }>;
    const auditRows = db
      .prepare("SELECT event_type FROM audit_log WHERE category = 'memory' AND event_id = ? ORDER BY timestamp ASC")
      .all(proposalId) as Array<{ event_type: string }>;
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();

    expect(sources.map((source) => source.source_id)).toEqual(['msg-rust-pref']);
    expect(revisions.map((revision) => revision.change_type)).toEqual([
      'create',
      'approve',
      'disable',
      'restore',
      'supersede',
    ]);
    expect(auditRows.map((audit) => audit.event_type)).toEqual([
      'memory.create',
      'memory.approve',
      'memory.disable',
      'memory.restore',
      'memory.supersede',
    ]);
    expect(fkCheck).toHaveLength(0);
  });

  it('should handle conversation history in context', async () => {
    const userId = 'user-diana';
    const conversationId = 'conv-3';

    await identityRepo.ensureCanonicalUser(userId);

    // 存储聊天消息
    const messages = [
      { id: 'msg-1', text: '你好', isBot: false },
      { id: 'msg-2', text: '你好！', isBot: true },
      { id: 'msg-3', text: '今天天气怎么样', isBot: false },
    ];

    // First, create raw events for each message
    const baseTime = Date.now();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTime = baseTime + i * 1000; // Each message 1 second apart
      const rawEventId = `raw-${msg.id}`;

      db.prepare(`
        INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawEventId,
        'chat.message.received',
        msgTime,
        'gateway',
        'qq',
        conversationId,
        JSON.stringify({ text: msg.text }),
        msgTime,
      );

      db.prepare(`
        INSERT INTO chat_messages (
          id, raw_event_id, conversation_id, conversation_type, message_id,
          sender_id, text, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        msg.id,
        rawEventId,
        conversationId,
        'private',
        msg.id,
        msg.isBot ? 'bot' : userId,
        msg.text,
        msgTime,
      );
    }

    // 构建上下文
    const context = await contextBuilder.buildContext({
      turnId: 'turn-1',
      conversationId,
      conversationType: 'private',
      recentMessages: [],
      targetUserId: userId,
    });

    // 验证历史消息
    expect(context.recentMessages.length).toBe(3);
    expect(context.recentMessages[0].text).toBe('你好');
    expect(context.recentMessages[2].text).toBe('今天天气怎么样');
  });
});
