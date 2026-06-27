/**
 * Integration Test: Data Persistence Layer
 *
 * 验证 Raw Events 和 Chat Messages 持久化
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase } from '../../src/storage/database.js';
import type { Database } from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Data Persistence Layer', () => {
  let db: Database;
  const testDbPath = join(__dirname, '../../data/test-persistence.db');

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
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  it('should store raw event', () => {
    const eventId = `evt-${Date.now()}-test`;
    const event = {
      type: 'chat.message.received',
      timestamp: Date.now(),
      source: 'gateway',
      platform: 'qq',
      conversationId: 'qq-group-123456',
      payload: JSON.stringify({ text: 'Hello' }),
    };

    db.prepare(`
      INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      event.type,
      event.timestamp,
      event.source,
      event.platform,
      event.conversationId,
      event.payload,
      Date.now(),
    );

    const row = db.prepare('SELECT * FROM raw_events WHERE id = ?').get(eventId) as any;

    expect(row).toBeDefined();
    expect(row.id).toBe(eventId);
    expect(row.type).toBe('chat.message.received');
    expect(row.source).toBe('gateway');
    expect(row.platform).toBe('qq');
  });

  it('should store chat message', () => {
    const messageId = `msg-${Date.now()}-test`;
    const rawEventId = 'evt-test';

    // 先插入 raw_event (外键依赖)
    db.prepare(`
      INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rawEventId,
      'chat.message.received',
      Date.now(),
      'gateway',
      'qq',
      'qq-group-123456',
      JSON.stringify({ text: 'Hello' }),
      Date.now(),
    );

    // 然后插入 chat_message
    db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, sender_id, text,
        has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      rawEventId,
      'platform-msg-123',
      'qq-group-123456',
      'group',
      '123456',
      'Hello LetheBot',
      0,
      0,
      1,
      Date.now(),
    );

    const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as any;

    expect(row).toBeDefined();
    expect(row.id).toBe(messageId);
    expect(row.text).toBe('Hello LetheBot');
    expect(row.sender_id).toBe('123456');
    expect(row.mentions_bot).toBe(1);
  });

  it('should store bot response', () => {
    const messageId = `msg-bot-${Date.now()}-test`;
    const rawEventId = 'evt-bot-test';

    // 先插入 raw_event
    db.prepare(`
      INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rawEventId,
      'bot.response',
      Date.now(),
      'agent',
      'qq',
      'qq-group-123456',
      JSON.stringify({ text: 'I am LetheBot!' }),
      Date.now(),
    );

    db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, sender_id, text,
        has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      rawEventId,
      messageId,
      'qq-group-123456',
      'group',
      'bot-self',
      'I am LetheBot!',
      0,
      0,
      0,
      Date.now(),
    );

    const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as any;

    expect(row).toBeDefined();
    expect(row.sender_id).toBe('bot-self');
    expect(row.text).toBe('I am LetheBot!');
  });

  it('should count stored messages', () => {
    // 插入多条消息
    for (let i = 0; i < 5; i++) {
      const rawEventId = `evt-${i}`;

      // 先插入 raw_event
      db.prepare(`
        INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawEventId,
        'chat.message.received',
        Date.now() + i,
        'gateway',
        'qq',
        'qq-group-123456',
        JSON.stringify({ text: `Message ${i}` }),
        Date.now() + i,
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
        'qq-group-123456',
        'group',
        '123456',
        `Message ${i}`,
        0,
        0,
        0,
        Date.now() + i,
      );
    }

    const count = db.prepare('SELECT COUNT(*) as count FROM chat_messages').get() as any;
    expect(count.count).toBe(5);
  });

  it('should retrieve recent messages by conversation', () => {
    const conversationId = 'qq-group-123456';

    // 插入消息
    for (let i = 0; i < 3; i++) {
      const rawEventId = `evt-${i}`;

      // 先插入 raw_event
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

    const messages = db.prepare(`
      SELECT * FROM chat_messages
      WHERE conversation_id = ?
      ORDER BY timestamp DESC
      LIMIT 10
    `).all(conversationId) as any[];

    expect(messages).toHaveLength(3);
    expect(messages[0].text).toBe('Message 2'); // 最新的
  });
});
