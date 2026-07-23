/**
 * Integration Test: Memory Retrieval
 *
 * 验证记忆检索和可见性规则
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

describe('Memory Retrieval', () => {
  let db: Database;
  let contextBuilder: ContextBuilder;
  let memoryRepo: MemoryRepository;
  let createMemory: MemoryRepository['create'];
  let identityRepo: IdentityRepository;
  const testDbPath = join(__dirname, '../../data/test-memory-retrieval.db');

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
    contextBuilder = new ContextBuilder(memoryRepo, identityRepo, db);

    const now = Date.now();
    createMemory = (input) => memoryRepo.create({
      ...input,
      sources: input.sources ?? [
        {
          sourceType: 'raw_event',
          sourceId: 'raw-memory-retrieval-source',
          sourceTimestamp: now,
          extractedBy: 'user',
        },
      ],
    });

    // 创建测试用户
    await identityRepo.ensureCanonicalUser('user-123');
    seedActiveQqAccount(db, 'user-123', 'qq-user-123', now);
    seedMemoryEvidence(db, {
      rawEventId: 'raw-memory-retrieval-source',
      chatMessageId: 'msg-memory-retrieval-source',
      conversationId: 'private:user-123',
      conversationType: 'private',
      senderId: 'qq-user-123',
      timestamp: now,
    });
    seedMemoryEvidence(db, {
      rawEventId: 'raw-memory-retrieval-group-source',
      chatMessageId: 'msg-memory-retrieval-group-source',
      conversationId: 'conv-group-456',
      conversationType: 'group',
      groupId: 'group-456',
      senderId: 'qq-user-123',
      timestamp: now + 1,
    });
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  it('should retrieve user memories in private chat', async () => {
    // 创建用户记忆
    await createMemory({
      id: 'mem-1',
      scope: 'user',
      canonicalUserId: 'user-123',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'favorite color',
      content: '我喜欢红色',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'chat',
    });

    // 构建上下文
    const context = await contextBuilder.buildContext({
      turnId: 'turn-1',
      conversationId: 'conv-private',
      conversationType: 'private',
      recentMessages: [],
      targetUserId: 'user-123',
    });

    expect(context.memory.retrievedFacts).toHaveLength(1);
    expect(context.memory.retrievedFacts[0].content).toBe('我喜欢红色');
  });

  it('should not retrieve private_only memories in group chat', async () => {
    // 创建 private_only 记忆
    await createMemory({
      id: 'mem-1',
      scope: 'user',
      canonicalUserId: 'user-123',
      visibility: 'private_only',
      sensitivity: 'personal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'secret',
      content: '这是私密信息',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'private_chat',
    });

    // 在群聊中构建上下文
    const context = await contextBuilder.buildContext({
      turnId: 'turn-1',
      conversationId: 'conv-group',
      conversationType: 'group',
      recentMessages: [],
      targetUserId: 'user-123',
      groupId: 'group-456',
    });

    // 不应该包含 private_only 记忆
    expect(context.memory.retrievedFacts).toHaveLength(0);
  });

  it('should retrieve same_user_any_context memories in both private and group', async () => {
    await createMemory({
      id: 'mem-1',
      scope: 'user',
      canonicalUserId: 'user-123',
      visibility: 'same_user_any_context',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'general preference',
      content: '我喜欢编程',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'chat',
    });

    // 私聊
    const privateContext = await contextBuilder.buildContext({
      turnId: 'turn-1',
      conversationId: 'conv-private',
      conversationType: 'private',
      recentMessages: [],
      targetUserId: 'user-123',
    });

    expect(privateContext.memory.retrievedFacts).toHaveLength(1);

    // 群聊
    const groupContext = await contextBuilder.buildContext({
      turnId: 'turn-2',
      conversationId: 'conv-group',
      conversationType: 'group',
      recentMessages: [],
      targetUserId: 'user-123',
      groupId: 'group-456',
    });

    expect(groupContext.memory.retrievedFacts).toHaveLength(1);
  });

  it('should only retrieve same_group_only memories in the same group', async () => {
    await createMemory({
      id: 'mem-1',
      scope: 'user',
      canonicalUserId: 'user-123',
      groupId: 'group-456',
      visibility: 'same_group_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'group context',
      content: '在这个群里我喜欢聊技术',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'group_chat',
      sources: [{
        sourceType: 'raw_event',
        sourceId: 'raw-memory-retrieval-group-source',
      }],
    });

    // 相同群组
    const sameGroupContext = await contextBuilder.buildContext({
      turnId: 'turn-1',
      conversationId: 'conv-group-456',
      conversationType: 'group',
      recentMessages: [],
      targetUserId: 'user-123',
      groupId: 'group-456',
    });

    expect(sameGroupContext.memory.retrievedFacts).toHaveLength(1);

    // 不同群组
    const differentGroupContext = await contextBuilder.buildContext({
      turnId: 'turn-2',
      conversationId: 'conv-group-789',
      conversationType: 'group',
      recentMessages: [],
      targetUserId: 'user-123',
      groupId: 'group-789',
    });

    expect(differentGroupContext.memory.retrievedFacts).toHaveLength(0);
  });

  it('should not retrieve disabled or deleted memories', async () => {
    // Active 记忆
    await createMemory({
      id: 'mem-active',
      scope: 'user',
      canonicalUserId: 'user-123',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'active',
      content: 'Active memory',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'chat',
    });

    // Disabled 记忆
    await createMemory({
      id: 'mem-disabled',
      scope: 'user',
      canonicalUserId: 'user-123',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'disabled',
      content: 'Disabled memory',
      state: 'disabled',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'chat',
    });

    const context = await contextBuilder.buildContext({
      turnId: 'turn-1',
      conversationId: 'conv-private',
      conversationType: 'private',
      recentMessages: [],
      targetUserId: 'user-123',
    });

    expect(context.memory.retrievedFacts).toHaveLength(1);
    expect(context.memory.retrievedFacts[0].content).toBe('Active memory');
  });

  it('should retrieve public memories for any user', async () => {
    await identityRepo.ensureCanonicalUser('user-456');

    await createMemory({
      id: 'mem-1',
      scope: 'global',
      visibility: 'public',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: 'public fact',
      content: 'This is public knowledge',
      state: 'active',
      confidence: 1.0,
      importance: 0.5,
      sourceContext: 'system',
    });

    // 用户 123
    const context1 = await contextBuilder.buildContext({
      turnId: 'turn-1',
      conversationId: 'conv-1',
      conversationType: 'private',
      recentMessages: [],
      targetUserId: 'user-123',
    });

    // 用户 456
    const context2 = await contextBuilder.buildContext({
      turnId: 'turn-2',
      conversationId: 'conv-2',
      conversationType: 'private',
      recentMessages: [],
      targetUserId: 'user-456',
    });

    expect(context1.memory.retrievedFacts).toHaveLength(1);
    expect(context2.memory.retrievedFacts).toHaveLength(1);
    expect(context1.memory.retrievedFacts[0].content).toBe('This is public knowledge');
  });

  it('should include memory IDs in selectedMemoryIds', async () => {
    const memoryId = await createMemory({
      id: 'mem-1',
      scope: 'user',
      canonicalUserId: 'user-123',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'test',
      content: 'Test memory',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'chat',
    });

    const context = await contextBuilder.buildContext({
      turnId: 'turn-1',
      conversationId: 'conv-private',
      conversationType: 'private',
      recentMessages: [],
      targetUserId: 'user-123',
    });

    expect(context.memory.selectedMemoryIds).toContain(memoryId);
  });
});

function seedActiveQqAccount(
  db: Database,
  canonicalUserId: string,
  platformAccountId: string,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO platform_accounts (
      platform, platform_account_id, canonical_user_id, account_type,
      verified_level, status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'qq',
    platformAccountId,
    canonicalUserId,
    'private',
    'observed',
    'active',
    timestamp,
    timestamp,
  );
}

function seedMemoryEvidence(db: Database, input: {
  rawEventId: string;
  chatMessageId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId?: string;
  senderId: string;
  timestamp: number;
}): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.chatMessageId,
    input.rawEventId,
    `platform-${input.chatMessageId}`,
    input.conversationId,
    input.conversationType,
    input.groupId ?? null,
    input.senderId,
    'Synthetic memory provenance',
    input.timestamp,
  );
}
