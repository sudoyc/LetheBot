/**
 * Integration Test: Context History Loading
 *
 * 验证 Context Builder 能从数据库加载历史消息
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase } from '../../src/storage/database.js';
import { ContextBuilder, type BuildContextInput } from '../../src/context/builder.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import { IdentityRepository } from '../../src/storage/identity-repository.js';
import type {
  ContextPack,
  ParticipantContext,
  RecentMessage,
} from '../../src/types/context.js';
import type { Database } from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type MessageRef = `message_${number}`;
type SpeakerRef = `speaker_${number}`;

type ReliabilityRecentMessage = RecentMessage & {
  messageRef: MessageRef;
  speakerRef: SpeakerRef;
  isCurrent: boolean;
};

type ReliabilityParticipantContext = Omit<ParticipantContext, 'displayName'> & {
  speakerRef: SpeakerRef;
  displayName?: string;
};

interface ReliabilityReplyReference {
  status: 'resolved' | 'unresolved';
  sourceMessageRef: MessageRef;
  targetMessageRef?: MessageRef;
  targetSpeakerRef?: SpeakerRef;
  targetRole?: 'human' | 'bot';
  targetInRollingWindow?: boolean;
}

type ReliabilityContextPack = Omit<ContextPack, 'recentMessages' | 'participants'> & {
  recentMessages: ReliabilityRecentMessage[];
  participants: ReliabilityParticipantContext[];
  currentMessageRef: MessageRef;
  replyReference?: ReliabilityReplyReference;
};

type ReliabilityBuildContextInput = BuildContextInput & {
  currentMessageId: string;
  replyToMessageId?: string;
};

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
    expect(context.recentMessages[1].senderId).toBe('bot-self');
  });

  it('should not double-prefix already normalized QQ sender IDs', async () => {
    const conversationId = 'qq-private-prefixed';
    const now = Date.now();

    db.prepare(`
      INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'evt-prefixed',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      conversationId,
      JSON.stringify({ text: 'Hello' }),
      now,
    );

    db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, sender_id, text,
        has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg-prefixed',
      'evt-prefixed',
      'platform-prefixed',
      conversationId,
      'private',
      'qq-123456',
      'Hello',
      0,
      0,
      0,
      now,
    );

    const context = await contextBuilder.buildContext({
      turnId: 'turn-prefixed',
      conversationId,
      conversationType: 'private',
      recentMessages: [],
      targetUserId: 'qq-123456',
    });

    expect(context.recentMessages[0].senderId).toBe('qq-123456');
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

  it('REL-CTX-01 assigns opaque stable refs to selected speakers and marks the current message', async () => {
    const conversationId = 'group:synthetic-context-ref';
    const groupId = 'group-synthetic-context-ref';
    const baseTimestamp = Date.UTC(2026, 6, 11);

    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-account-alpha',
      canonicalUserId: 'synthetic-user-alpha',
      groupId,
      displayName: 'Shared Label',
    });
    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-account-beta',
      canonicalUserId: 'synthetic-user-beta',
      groupId,
      displayName: 'Shared Label',
    });
    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-account-gamma',
      canonicalUserId: 'synthetic-user-gamma',
      groupId,
    });

    seedSyntheticChatMessage(db, {
      id: 'ctx-alpha-first',
      platformMessageId: 'platform-ctx-alpha-first',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-account-alpha',
      text: 'a0',
      timestamp: baseTimestamp,
    });
    seedSyntheticChatMessage(db, {
      id: 'ctx-beta',
      platformMessageId: 'platform-ctx-beta',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-account-beta',
      text: 'b0',
      timestamp: baseTimestamp + 2_000,
    });
    seedSyntheticChatMessage(db, {
      id: 'ctx-gamma',
      platformMessageId: 'platform-ctx-gamma',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-account-gamma',
      text: 'c0',
      timestamp: baseTimestamp + 3_000,
    });
    seedSyntheticChatMessage(db, {
      id: 'ctx-alpha-current',
      platformMessageId: 'platform-ctx-alpha-current',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-account-alpha',
      text: 'a1',
      timestamp: baseTimestamp + 1_000,
    });

    const input: ReliabilityBuildContextInput = {
      turnId: 'turn-rel-ctx-01',
      conversationId,
      conversationType: 'group',
      groupId,
      targetUserId: 'synthetic-user-alpha',
      currentMessageId: 'ctx-alpha-current',
    };
    const context = await contextBuilder.buildContext(input) as ReliabilityContextPack;

    expect(context.recentMessages.map((message) => message.messageRef)).toEqual([
      'message_1',
      'message_2',
      'message_3',
      'message_4',
    ]);

    const alphaFirst = context.recentMessages.find((message) => message.messageId === 'ctx-alpha-first');
    const alphaCurrent = context.recentMessages.find((message) => message.messageId === 'ctx-alpha-current');
    const beta = context.recentMessages.find((message) => message.messageId === 'ctx-beta');
    const gamma = context.recentMessages.find((message) => message.messageId === 'ctx-gamma');

    expect(alphaFirst?.speakerRef).toBe('speaker_1');
    expect(alphaCurrent?.speakerRef).toBe(alphaFirst?.speakerRef);
    expect(beta?.speakerRef).toBe('speaker_2');
    expect(gamma?.speakerRef).toBe('speaker_3');
    expect(new Set(context.recentMessages.map((message) => message.speakerRef)).size).toBe(3);
    expect(context.currentMessageRef).toBe(alphaCurrent?.messageRef);
    expect(alphaCurrent?.isCurrent).toBe(true);
    expect(context.recentMessages.filter((message) => message.isCurrent)).toHaveLength(1);

    expect(context.participants).toHaveLength(3);
    expect(context.participants.map((participant) => ({
      speakerRef: participant.speakerRef,
      displayName: participant.displayName,
    }))).toEqual([
      { speakerRef: 'speaker_1', displayName: 'Shared Label' },
      { speakerRef: 'speaker_2', displayName: 'Shared Label' },
      { speakerRef: 'speaker_3', displayName: 'unknown' },
    ]);

    for (const reference of [
      ...context.recentMessages.map((message) => message.messageRef),
      ...context.recentMessages.map((message) => message.speakerRef),
      ...context.participants.map((participant) => participant.speakerRef),
    ]) {
      expect(reference).toMatch(/^(?:message|speaker)_\d+$/);
      expect(reference).not.toMatch(/synthetic-(?:account|user)/);
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('REL-CTX-02 keeps speaker identity stable when display metadata changes or disappears', async () => {
    const conversationId = 'group:synthetic-display-change';
    const groupId = 'group-synthetic-display-change';
    const canonicalUserId = 'synthetic-user-display-change';
    const baseTimestamp = Date.UTC(2026, 6, 11, 0, 30);

    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-account-display-change',
      canonicalUserId,
      groupId,
      displayName: 'Initial Label',
    });
    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-account-display-peer',
      canonicalUserId: 'synthetic-user-display-peer',
      groupId,
      displayName: 'Peer Label',
    });
    seedSyntheticChatMessage(db, {
      id: 'ctx-display-first',
      platformMessageId: 'platform-ctx-display-first',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-account-display-change',
      text: 'first',
      timestamp: baseTimestamp,
    });
    seedSyntheticChatMessage(db, {
      id: 'ctx-display-peer',
      platformMessageId: 'platform-ctx-display-peer',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-account-display-peer',
      text: 'peer',
      timestamp: baseTimestamp + 500,
    });
    seedSyntheticChatMessage(db, {
      id: 'ctx-display-current',
      platformMessageId: 'platform-ctx-display-current',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-account-display-change',
      text: 'current',
      timestamp: baseTimestamp + 1_000,
    });

    const input: ReliabilityBuildContextInput = {
      turnId: 'turn-rel-ctx-02-initial',
      conversationId,
      conversationType: 'group',
      groupId,
      targetUserId: canonicalUserId,
      currentMessageId: 'ctx-display-current',
    };
    const initial = await contextBuilder.buildContext(input) as ReliabilityContextPack;
    expect(initial.recentMessages.map((message) => message.speakerRef)).toEqual(
      ['speaker_1', 'speaker_2', 'speaker_1'],
    );
    expect(initial.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ speakerRef: 'speaker_1', displayName: 'Initial Label' }),
      expect.objectContaining({ speakerRef: 'speaker_2', displayName: 'Peer Label' }),
    ]));
    expect(initial.participants).toHaveLength(2);

    await identityRepo.upsertDisplayProfile({
      canonicalUserId,
      sourceGroupId: groupId,
      currentDisplayName: 'Changed Label',
      trust: 'platform_provided',
    });
    const changed = await contextBuilder.buildContext({
      ...input,
      turnId: 'turn-rel-ctx-02-changed',
    }) as ReliabilityContextPack;
    expect(changed.recentMessages.map((message) => message.speakerRef)).toEqual(
      ['speaker_1', 'speaker_2', 'speaker_1'],
    );
    expect(changed.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ speakerRef: 'speaker_1', displayName: 'Changed Label' }),
      expect.objectContaining({ speakerRef: 'speaker_2', displayName: 'Peer Label' }),
    ]));
    expect(changed.participants).toHaveLength(2);

    db.prepare(
      'DELETE FROM display_profiles WHERE canonical_user_id = ? AND source_group_id = ?',
    ).run(canonicalUserId, groupId);
    const unavailable = await contextBuilder.buildContext({
      ...input,
      turnId: 'turn-rel-ctx-02-unavailable',
    }) as ReliabilityContextPack;
    expect(unavailable.recentMessages.map((message) => message.speakerRef)).toEqual(
      ['speaker_1', 'speaker_2', 'speaker_1'],
    );
    expect(unavailable.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ speakerRef: 'speaker_1', displayName: 'unknown' }),
      expect.objectContaining({ speakerRef: 'speaker_2', displayName: 'Peer Label' }),
    ]));
    expect(unavailable.participants).toHaveLength(2);
    expect(JSON.stringify(unavailable)).not.toContain('Initial Label');
    expect(JSON.stringify(unavailable)).not.toContain('Changed Label');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('REL-QUOTE-01 resolves an in-window same-conversation quote through pack-local refs', async () => {
    const conversationId = 'group:synthetic-quote-inside';
    const groupId = 'group-synthetic-quote-inside';
    const baseTimestamp = Date.UTC(2026, 6, 11, 1);

    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-quote-source',
      canonicalUserId: 'synthetic-quote-source-user',
      groupId,
      displayName: 'Source',
    });
    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-quote-target',
      canonicalUserId: 'synthetic-quote-target-user',
      groupId,
      displayName: 'Target',
    });

    seedSyntheticChatMessage(db, {
      id: 'quote-inside-target',
      platformMessageId: 'platform-quote-inside-target',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-quote-target',
      text: 'target',
      timestamp: baseTimestamp,
    });
    seedSyntheticChatMessage(db, {
      id: 'quote-inside-current',
      platformMessageId: 'platform-quote-inside-current',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-quote-source',
      text: 'current',
      replyToMessageId: 'platform-quote-inside-target',
      timestamp: baseTimestamp + 1_000,
    });

    const input: ReliabilityBuildContextInput = {
      turnId: 'turn-rel-quote-01',
      conversationId,
      conversationType: 'group',
      groupId,
      targetUserId: 'synthetic-quote-source-user',
      currentMessageId: 'quote-inside-current',
      replyToMessageId: 'platform-quote-inside-target',
      messageLimit: 5,
    };
    const context = await contextBuilder.buildContext(input) as ReliabilityContextPack;
    const current = context.recentMessages.find((message) => message.messageId === 'quote-inside-current');
    const target = context.recentMessages.find((message) => message.messageId === 'quote-inside-target');

    expect(current?.isCurrent).toBe(true);
    expect(context.currentMessageRef).toBe(current?.messageRef);
    expect(target?.messageRef).toMatch(/^message_\d+$/);
    expect(target?.speakerRef).toMatch(/^speaker_\d+$/);
    expect(context.replyReference).toMatchObject({
      status: 'resolved',
      sourceMessageRef: current?.messageRef,
      targetMessageRef: target?.messageRef,
      targetSpeakerRef: target?.speakerRef,
      targetRole: 'human',
      targetInRollingWindow: true,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('REL-QUOTE-02/REL-SCOPE-01 bounds quote, history, and participants to the exact conversation', async () => {
    const conversationId = 'group:synthetic-quote-outside';
    const groupId = 'group-synthetic-quote-outside';
    const otherConversationId = 'group:synthetic-quote-other';
    const otherGroupId = 'group-synthetic-quote-other';
    const unresolvedConversationId = 'group:synthetic-quote-unresolved';
    const unresolvedGroupId = 'group-synthetic-quote-unresolved';
    const sharedPlatformMessageId = 'platform-shared-quote-target';
    const baseTimestamp = Date.UTC(2026, 6, 11, 2);

    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-outside-source',
      canonicalUserId: 'synthetic-outside-source-user',
      groupId,
      displayName: 'Source',
    });
    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-outside-target',
      canonicalUserId: 'synthetic-outside-target-user',
      groupId,
      displayName: 'Target',
    });
    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-outside-history',
      canonicalUserId: 'synthetic-outside-history-user',
      groupId,
      displayName: 'History',
    });
    await seedSyntheticIdentity(identityRepo, {
      platformAccountId: 'synthetic-outside-foreign',
      canonicalUserId: 'synthetic-outside-foreign-user',
      groupId: otherGroupId,
      displayName: 'Foreign',
    });

    seedSyntheticChatMessage(db, {
      id: 'quote-outside-correct-target',
      platformMessageId: sharedPlatformMessageId,
      conversationId,
      groupId,
      senderId: 'qq-synthetic-outside-target',
      text: 'old-target',
      timestamp: baseTimestamp,
    });
    for (let index = 1; index <= 4; index += 1) {
      seedSyntheticChatMessage(db, {
        id: `quote-outside-history-${index}`,
        platformMessageId: `platform-quote-outside-history-${index}`,
        conversationId,
        groupId,
        senderId: 'qq-synthetic-outside-history',
        text: `h${index}`,
        timestamp: baseTimestamp + index * 1_000,
      });
    }
    seedSyntheticChatMessage(db, {
      id: 'quote-outside-current',
      platformMessageId: 'platform-quote-outside-current',
      conversationId,
      groupId,
      senderId: 'qq-synthetic-outside-source',
      text: 'current',
      replyToMessageId: sharedPlatformMessageId,
      timestamp: baseTimestamp + 5_000,
    });
    seedSyntheticChatMessage(db, {
      id: 'quote-outside-foreign-collision',
      platformMessageId: sharedPlatformMessageId,
      conversationId: otherConversationId,
      groupId: otherGroupId,
      senderId: 'qq-synthetic-outside-foreign',
      text: 'foreign-target',
      timestamp: baseTimestamp + 6_000,
    });

    const resolvedInput: ReliabilityBuildContextInput = {
      turnId: 'turn-rel-quote-02-resolved',
      conversationId,
      conversationType: 'group',
      groupId,
      targetUserId: 'synthetic-outside-source-user',
      currentMessageId: 'quote-outside-current',
      replyToMessageId: sharedPlatformMessageId,
      messageLimit: 3,
    };
    const resolvedContext = await contextBuilder.buildContext(resolvedInput) as ReliabilityContextPack;
    const resolvedCurrent = resolvedContext.recentMessages.find(
      (message) => message.messageId === 'quote-outside-current'
    );
    const resolvedTarget = resolvedContext.recentMessages.find(
      (message) => message.messageId === 'quote-outside-correct-target'
    );

    expect(resolvedTarget).toBeDefined();
    expect(resolvedContext.recentMessages.map((message) => message.messageId)).toEqual([
      'quote-outside-correct-target',
      'quote-outside-history-3',
      'quote-outside-history-4',
      'quote-outside-current',
    ]);
    expect(resolvedContext.recentMessages.some(
      (message) => message.messageId === 'quote-outside-foreign-collision'
    )).toBe(false);
    expect(resolvedContext.participants.some(
      (participant) => participant.displayName === 'Foreign'
    )).toBe(false);
    expect(resolvedContext.replyReference).toMatchObject({
      status: 'resolved',
      sourceMessageRef: resolvedCurrent?.messageRef,
      targetMessageRef: resolvedTarget?.messageRef,
      targetSpeakerRef: resolvedTarget?.speakerRef,
      targetRole: 'human',
      targetInRollingWindow: false,
    });

    seedSyntheticChatMessage(db, {
      id: 'quote-unresolved-current',
      platformMessageId: 'platform-quote-unresolved-current',
      conversationId: unresolvedConversationId,
      groupId: unresolvedGroupId,
      senderId: 'qq-synthetic-outside-source',
      text: 'unresolved',
      replyToMessageId: sharedPlatformMessageId,
      timestamp: baseTimestamp + 7_000,
    });
    const unresolvedInput: ReliabilityBuildContextInput = {
      turnId: 'turn-rel-quote-02-unresolved',
      conversationId: unresolvedConversationId,
      conversationType: 'group',
      groupId: unresolvedGroupId,
      targetUserId: 'synthetic-outside-source-user',
      currentMessageId: 'quote-unresolved-current',
      replyToMessageId: sharedPlatformMessageId,
      messageLimit: 3,
    };
    const unresolvedContext = await contextBuilder.buildContext(unresolvedInput) as ReliabilityContextPack;
    const unresolvedCurrent = unresolvedContext.recentMessages.find(
      (message) => message.messageId === 'quote-unresolved-current'
    );

    expect(unresolvedContext.replyReference).toMatchObject({
      status: 'unresolved',
      sourceMessageRef: unresolvedCurrent?.messageRef,
    });
    expect(unresolvedContext.replyReference?.targetMessageRef).toBeUndefined();
    expect(unresolvedContext.replyReference?.targetSpeakerRef).toBeUndefined();
    expect(unresolvedContext.recentMessages.some(
      (message) => message.messageId === 'quote-outside-correct-target'
        || message.messageId === 'quote-outside-foreign-collision'
    )).toBe(false);
    expect(unresolvedContext.participants.some(
      (participant) => participant.displayName === 'Target'
        || participant.displayName === 'Foreign'
    )).toBe(false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('should retain the newest contiguous mixed-role history under the hard token budget', async () => {
    const conversationId = 'qq-group-hard-token-budget';
    const groupId = 'qq-group-765432';
    const timestamp = Date.UTC(2026, 6, 10);
    const allMessageIds: string[] = [];

    for (let index = 0; index < 12; index += 1) {
      const rawEventId = `evt-hard-budget-${index}`;
      const messageId = `msg-hard-budget-${index}`;
      const isFromBot = index % 2 === 0;
      allMessageIds.push(messageId);

      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        rawEventId,
        isFromBot ? 'bot.response' : 'chat.message.received',
        timestamp,
        isFromBot ? 'agent' : 'gateway',
        'qq',
        conversationId,
        '{}',
        timestamp,
      );
      db.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id,
          conversation_type, group_id, sender_id, text,
          has_media, has_quote, mentions_bot, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        rawEventId,
        `platform-hard-budget-${index}`,
        conversationId,
        'group',
        groupId,
        isFromBot ? 'bot-self' : `qq-user-${index}`,
        `${isFromBot ? 'B' : 'U'}${String(index).padStart(2, '0')}:${'x'.repeat(1_800)}`,
        0,
        0,
        0,
        timestamp,
      );
    }

    const context = await contextBuilder.buildContext({
      turnId: 'turn-hard-history-budget',
      conversationId,
      conversationType: 'group',
      groupId,
      targetUserId: 'user-hard-budget',
    });

    const retainedIds = context.recentMessages.map((message) => message.messageId);
    expect(context.tokenBudget.used).toBeLessThanOrEqual(context.tokenBudget.max);
    expect(retainedIds.length).toBeGreaterThan(1);
    expect(retainedIds.length).toBeLessThan(allMessageIds.length);
    expect(retainedIds).toEqual(allMessageIds.slice(-retainedIds.length));
    expect(retainedIds.at(-1)).toBe('msg-hard-budget-11');
    expect(context.recentMessages.at(-1)?.text).not.toMatch(/ \[truncated\]$/);
    expect(context.recentMessages.some((message) => message.isFromBot)).toBe(true);
    expect(context.recentMessages.some((message) => !message.isFromBot)).toBe(true);
    expect(context.trace?.filtersApplied).toContain(
      `token_budget:recent_messages_omitted=${allMessageIds.length - retainedIds.length}`
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('should retain an explicitly supplied current input outside the DB history window', async () => {
    const conversationId = 'qq-private-skewed-current-input';
    const baseTimestamp = Date.UTC(2026, 6, 10);

    for (let index = 0; index < 6; index += 1) {
      const rawEventId = `evt-skewed-current-${index}`;
      const messageId = index === 0
        ? 'msg-skewed-current-input'
        : `msg-newer-history-${index}`;
      const timestamp = baseTimestamp + index * 1_000;
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        rawEventId,
        'chat.message.received',
        timestamp,
        'gateway',
        'qq',
        conversationId,
        '{}',
        timestamp,
      );
      db.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id,
          conversation_type, sender_id, text,
          has_media, has_quote, mentions_bot, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        rawEventId,
        `platform-skewed-current-${index}`,
        conversationId,
        'private',
        'qq-user-skewed-current',
        index === 0 ? 'persisted skewed current input' : `newer history ${index}`,
        0,
        0,
        0,
        timestamp,
      );
    }

    const context = await contextBuilder.buildContext({
      turnId: 'turn-skewed-current-input',
      conversationId,
      conversationType: 'private',
      targetUserId: 'user-skewed-current',
      messageLimit: 5,
      recentMessages: [
        {
          messageId: 'msg-skewed-current-input',
          senderId: 'qq-user-skewed-current',
          senderDisplayName: 'Skewed Current User',
          text: 'current-input-'.repeat(1_500),
          timestamp: new Date(baseTimestamp),
          isFromBot: false,
        },
      ],
    });

    expect(context.tokenBudget.used).toBeLessThanOrEqual(context.tokenBudget.max);
    expect(context.recentMessages.at(-1)?.messageId).toBe('msg-skewed-current-input');
    expect(context.recentMessages.at(-1)?.text).toMatch(/ \[truncated\]$/);
    expect(context.trace?.filtersApplied).toContain(
      'token_budget:latest_user_message_truncated'
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});

async function seedSyntheticIdentity(
  identityRepo: IdentityRepository,
  input: {
    platformAccountId: string;
    canonicalUserId: string;
    groupId: string;
    displayName?: string;
  },
): Promise<void> {
  await identityRepo.createPlatformAccount({
    platform: 'qq',
    platformAccountId: input.platformAccountId,
    canonicalUserId: input.canonicalUserId,
    accountType: 'group_member',
    verifiedLevel: 'observed',
    status: 'active',
  });

  if (input.displayName !== undefined) {
    await identityRepo.upsertDisplayProfile({
      canonicalUserId: input.canonicalUserId,
      sourceGroupId: input.groupId,
      currentDisplayName: input.displayName,
      trust: 'platform_provided',
    });
  }
}

function seedSyntheticChatMessage(
  db: Database,
  input: {
    id: string;
    platformMessageId: string;
    conversationId: string;
    groupId: string;
    senderId: string;
    text: string;
    timestamp: number;
    senderRole?: 'member' | 'admin' | 'owner';
    replyToMessageId?: string;
  },
): void {
  const rawEventId = `raw-${input.id}`;
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform,
      conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rawEventId,
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
      id, raw_event_id, message_id, conversation_id,
      conversation_type, group_id, sender_id, sender_role, text,
      has_media, has_quote, mentions_bot, reply_to_message_id, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    rawEventId,
    input.platformMessageId,
    input.conversationId,
    'group',
    input.groupId,
    input.senderId,
    input.senderRole ?? 'member',
    input.text,
    0,
    input.replyToMessageId === undefined ? 0 : 1,
    0,
    input.replyToMessageId ?? null,
    input.timestamp,
  );
}
