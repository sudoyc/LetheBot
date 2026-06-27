/**
 * Integration Test: Context History Loading
 *
 * 验证 Context Builder 能从数据库加载历史消息
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase } from '../../src/storage/database.js';
import { ContextBuilder } from '../../src/context/builder.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import { IdentityRepository } from '../../src/storage/identity-repository.js';
import type { Database } from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Context History Loading', () => {
  let db: Database;
  let contextBuilder: ContextBuilder;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  const testDbPath = join(__dirname, '../../data/test-context-history.db');

  beforeEach(() => {
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
    contextBuilder = new ContextBuilder(memoryRepo, identityRepo, db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  it('should load recent messages from database', async () => {
    const conversationId = 'qq-group-123456';

    // 插入历史消息
    for (let i = 0; i < 3; i++) {
      const rawEventId = `evt-${i}`;

      db.prepare(`
        INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawEventId,
        'chat.message.received',
        Date.now() + i * 1000,
        'gateway',
        'qq',
        conversationId,
        JSON.stringify({ text: `Message ${i}` }),
        Date.now() + i * 1000,
      );

      db.prepare(`
        INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id,
          conversation_type, sender_id, text,
          has_media, has_quote, mentions_bot, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `msg-${i}`,
        rawEventId,
        `platform-msg-${i}`,
        conversationId,
        'group',
        '123456',
        `Message ${i}`,
        0,
        0,
        0,
        Date.now() + i * 1000,
      );
    }

    // 构建上下文
    const context = await contextBuilder.buildContext({
      turnId: 'turn-test',
      conversationId,
      conversationType: 'group',
      recentMessages: [], // 应该从数据库加载，而不是使用这个空数组
      targetUserId: '123456',
    });

    expect(context.recentMessages).toHaveLength(3);
    expect(context.recentMessages[0].text).toBe('Message 0'); // 最旧的
    expect(context.recentMessages[2].text).toBe('Message 2'); // 最新的
  });

  it('should include bot responses in history', async () => {
    const conversationId = 'qq-private-123456';

    // 用户消息
    const userEventId = 'evt-user';
    db.prepare(`
      INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userEventId,
      'chat.message.received',
      Date.now(),
      'gateway',
      'qq',
      conversationId,
      JSON.stringify({ text: 'Hello' }),
      Date.now(),
    );

    db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, sender_id, text,
        has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-user',
      userEventId,
      'platform-msg-1',
      conversationId,
      'private',
      '123456',
      'Hello',
      0,
      0,
      0,
      Date.now(),
    );

    // Bot 回复
    const botEventId = 'evt-bot';
    db.prepare(`
      INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      botEventId,
      'bot.response',
      Date.now() + 1000,
      'agent',
      'qq',
      conversationId,
      JSON.stringify({ text: 'Hi there!' }),
      Date.now() + 1000,
    );

    db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, sender_id, text,
        has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-bot',
      botEventId,
      'msg-bot',
      conversationId,
      'private',
      'bot-self',
      'Hi there!',
      0,
      0,
      0,
      Date.now() + 1000,
    );

    // 构建上下文
    const context = await contextBuilder.buildContext({
      turnId: 'turn-test',
      conversationId,
      conversationType: 'private',
      recentMessages: [],
      targetUserId: '123456',
    });

    expect(context.recentMessages).toHaveLength(2);
    expect(context.recentMessages[0].text).toBe('Hello');
    expect(context.recentMessages[0].isFromBot).toBe(false);
    expect(context.recentMessages[1].text).toBe('Hi there!');
    expect(context.recentMessages[1].isFromBot).toBe(true);
  });

  it('should fall back to input messages when database is empty', async () => {
    const conversationId = 'qq-group-empty';

    // 构建上下文（数据库中没有消息）
    const context = await contextBuilder.buildContext({
      turnId: 'turn-test',
      conversationId,
      conversationType: 'group',
      recentMessages: [
        {
          messageId: 'msg-fallback',
          senderId: 'qq-123456',
          senderDisplayName: 'User',
          text: 'Fallback message',
          timestamp: new Date(),
          isFromBot: false,
        },
      ],
      targetUserId: '123456',
    });

    expect(context.recentMessages).toHaveLength(1);
    expect(context.recentMessages[0].text).toBe('Fallback message');
  });

  it('should limit messages to specified count', async () => {
    const conversationId = 'qq-group-many';

    // 插入 25 条消息
    for (let i = 0; i < 25; i++) {
      const rawEventId = `evt-${i}`;

      db.prepare(`
        INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawEventId,
        'chat.message.received',
        Date.now() + i * 1000,
        'gateway',
        'qq',
        conversationId,
        JSON.stringify({ text: `Message ${i}` }),
        Date.now() + i * 1000,
      );

      db.prepare(`
        INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id,
          conversation_type, sender_id, text,
          has_media, has_quote, mentions_bot, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `msg-${i}`,
        rawEventId,
        `platform-msg-${i}`,
        conversationId,
        'group',
        '123456',
        `Message ${i}`,
        0,
        0,
        0,
        Date.now() + i * 1000,
      );
    }

    // 构建上下文（默认限制 20 条）
    const context = await contextBuilder.buildContext({
      turnId: 'turn-test',
      conversationId,
      conversationType: 'group',
      recentMessages: [],
      targetUserId: '123456',
    });

    expect(context.recentMessages).toHaveLength(20);
    expect(context.recentMessages[0].text).toBe('Message 5'); // 最旧的（跳过前 5 条）
    expect(context.recentMessages[19].text).toBe('Message 24'); // 最新的
  });
});
