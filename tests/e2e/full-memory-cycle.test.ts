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

    for (const msg of messages) {
      db.prepare(`
        INSERT INTO chat_messages (
          id, conversation_id, sender_id, sender_display_name,
          content_text, is_from_bot, timestamp, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        msg.id,
        conversationId,
        msg.isBot ? 'bot' : userId,
        msg.isBot ? 'LetheBot' : 'Diana',
        msg.text,
        msg.isBot ? 1 : 0,
        Date.now(),
        Date.now(),
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
