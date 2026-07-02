/**
 * Memory Injection Integration Tests
 *
 * 测试记忆可见性过滤和上下文构建的集成行为
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../src/storage/database';
import { ContextBuilder } from '../../src/context/builder';
import { MemoryRepository } from '../../src/storage/memory-repository';
import { IdentityRepository } from '../../src/storage/identity-repository';

describe('Memory Injection Integration', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let builder: ContextBuilder;

  beforeEach(() => {
    // 创建临时目录和数据库
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-integration-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../../migrations/001_initial_schema.sql'));

    // 初始化仓储和构建器
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    builder = new ContextBuilder(memoryRepo, identityRepo);

    // 创建测试用户
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-alice',
      Date.now(),
      Date.now()
    );

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-bob',
      Date.now(),
      Date.now()
    );
  });

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Memory Visibility Filtering', () => {
    it('should filter out private_only memory in group chat context', async () => {
      // 创建 private_only 记忆
      await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'personal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Private API Key',
        content: 'My secret API key is sk-abc123',
        state: 'active',
        confidence: 0.95,
        importance: 0.8,
        sourceContext: 'private chat with bot',
      });

      // 构建群组上下文
      const groupContext = await builder.buildContext({
        turnId: 'turn-group-001',
        conversationId: 'group:dev-team',
        conversationType: 'group',
        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'user-alice',
            senderDisplayName: 'Alice',
            text: 'Hey everyone!',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
        targetUserId: 'user-alice',
        groupId: 'group-dev-team',
      });

      // 验证 private_only 记忆被过滤掉
      expect(groupContext.memory.retrievedFacts).toHaveLength(0);
      expect(groupContext.memory.selectedMemoryIds).toHaveLength(0);
    });

    it('should include private_only memory in private chat context', async () => {
      // 创建 private_only 记忆
      const memoryId = await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'personal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Work Hours',
        content: 'I work 9am-5pm EST and prefer async communication',
        state: 'active',
        confidence: 0.9,
        importance: 0.7,
        sourceContext: 'private conversation',
      });

      // 构建私聊上下文
      const privateContext = await builder.buildContext({
        turnId: 'turn-private-001',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [
          {
            messageId: 'msg-002',
            senderId: 'user-alice',
            senderDisplayName: 'Alice',
            text: 'What do you remember about me?',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
        targetUserId: 'user-alice',
      });

      // 验证 private_only 记忆被包含
      expect(privateContext.memory.retrievedFacts).toHaveLength(1);
      expect(privateContext.memory.retrievedFacts[0].memoryId).toBe(memoryId);
      expect(privateContext.memory.retrievedFacts[0].content).toContain('9am-5pm EST');
      expect(privateContext.memory.selectedMemoryIds).toContain(memoryId);
    });

    it('should filter same_group_only memory to correct group only', async () => {
      // 创建 same_group_only 记忆
      const memoryId = await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-bob',
        groupId: 'group-backend-team',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'fact',
        title: 'Team Role',
        content: 'Bob is the backend lead in this group',
        state: 'active',
        confidence: 0.85,
        importance: 0.6,
        sourceContext: 'group:backend-team conversation',
      });

      // 构建相同群组的上下文
      const sameGroupContext = await builder.buildContext({
        turnId: 'turn-group-002',
        conversationId: 'group:backend-team',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-bob',
        groupId: 'group-backend-team',
      });

      expect(sameGroupContext.memory.retrievedFacts).toHaveLength(1);
      expect(sameGroupContext.memory.retrievedFacts[0].memoryId).toBe(memoryId);

      // 构建不同群组的上下文
      const differentGroupContext = await builder.buildContext({
        turnId: 'turn-group-003',
        conversationId: 'group:frontend-team',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-bob',
        groupId: 'group-frontend-team',
      });

      // 验证在不同群组中被过滤掉
      expect(differentGroupContext.memory.retrievedFacts).toHaveLength(0);
    });
  });

  describe('Memory Recall in Context', () => {
    it('should include same_user_any_context memory in both private and group contexts', async () => {
      // 创建 same_user_any_context 记忆
      const memoryId = await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'preference',
        title: 'Language Preference',
        content: 'Alice prefers communication in Mandarin Chinese',
        state: 'active',
        confidence: 0.9,
        importance: 0.7,
        sourceContext: 'inferred from multiple conversations',
      });

      // 私聊上下文
      const privateContext = await builder.buildContext({
        turnId: 'turn-recall-001',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-alice',
      });

      expect(privateContext.memory.retrievedFacts).toHaveLength(1);
      expect(privateContext.memory.retrievedFacts[0].memoryId).toBe(memoryId);
      expect(privateContext.memory.retrievedFacts[0].content).toContain('Mandarin Chinese');

      // 群组上下文
      const groupContext = await builder.buildContext({
        turnId: 'turn-recall-002',
        conversationId: 'group:general',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-alice',
        groupId: 'group-general',
      });

      expect(groupContext.memory.retrievedFacts).toHaveLength(1);
      expect(groupContext.memory.retrievedFacts[0].memoryId).toBe(memoryId);
      expect(groupContext.memory.retrievedFacts[0].content).toContain('Mandarin Chinese');
    });

    it('should include public memory in all contexts', async () => {
      // 创建 public 记忆
      const memoryId = await memoryRepo.create({
        scope: 'global',
        visibility: 'public',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: 'System Capability',
        content: 'This bot supports multiple languages',
        state: 'active',
        confidence: 1.0,
        importance: 0.5,
        sourceContext: 'system initialization',
      });

      // 测试不同上下文
      const contexts = [
        {
          turnId: 'turn-public-001',
          conversationId: 'private:user-alice',
          conversationType: 'private' as const,
          targetUserId: 'user-alice',
        },
        {
          turnId: 'turn-public-002',
          conversationId: 'group:dev-team',
          conversationType: 'group' as const,
          targetUserId: 'user-alice',
          groupId: 'group-dev-team',
        },
      ];

      for (const contextInput of contexts) {
        const context = await builder.buildContext({
          ...contextInput,
          recentMessages: [],
        });

        // public 记忆应该在所有上下文中可见
        const publicMemory = context.memory.retrievedFacts.find((m) => m.memoryId === memoryId);
        expect(publicMemory).toBeDefined();
        expect(publicMemory?.content).toContain('multiple languages');
      }
    });

    it('should exclude owner_admin_only memory by default', async () => {
      // 创建 owner_admin_only 记忆
      await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-bob',
        visibility: 'owner_admin_only',
        sensitivity: 'sensitive',
        authority: 'system',
        kind: 'fact',
        title: 'Admin Note',
        content: 'User has admin privileges in system',
        state: 'active',
        confidence: 1.0,
        importance: 0.9,
        sourceContext: 'system audit',
      });

      // 构建上下文
      const context = await builder.buildContext({
        turnId: 'turn-admin-001',
        conversationId: 'private:user-bob',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-bob',
      });

      // owner_admin_only 默认应该被过滤掉
      expect(context.memory.retrievedFacts).toHaveLength(0);
    });

    it('should only include active state memories', async () => {
      // 创建不同状态的记忆
      const activeId = await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Active Memory',
        content: 'This memory is active',
        state: 'active',
        confidence: 0.9,
        importance: 0.7,
        sourceContext: 'conversation',
      });

      const disabledId = await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Disabled Memory',
        content: 'This memory is disabled',
        state: 'active',
        confidence: 0.9,
        importance: 0.7,
        sourceContext: 'conversation',
      });

      await memoryRepo.disable(disabledId);

      const deletedId = await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Deleted Memory',
        content: 'This memory is deleted',
        state: 'active',
        confidence: 0.9,
        importance: 0.7,
        sourceContext: 'conversation',
      });

      await memoryRepo.delete(deletedId);

      // 构建上下文
      const context = await builder.buildContext({
        turnId: 'turn-state-001',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-alice',
      });

      // 只应该包含 active 状态的记忆
      expect(context.memory.retrievedFacts).toHaveLength(1);
      expect(context.memory.retrievedFacts[0].memoryId).toBe(activeId);
      expect(context.memory.retrievedFacts[0].content).toContain('active');
    });
  });

  describe('Real MemoryRepository and ContextBuilder Integration', () => {
    it('should correctly integrate memory creation, retrieval, and context building', async () => {
      // 场景：用户在私聊中分享敏感信息，然后在群组中交互

      // 1. 在私聊中创建敏感记忆
      const privateMemoryId = await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'sensitive',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Birthday',
        content: 'Alice birthday is March 15, 1990',
        state: 'active',
        confidence: 1.0,
        importance: 0.8,
        sourceContext: 'private chat on 2026-01-01',
      });

      // 2. 创建通用偏好记忆
      const generalMemoryId = await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'preference',
        title: 'Timezone',
        content: 'Alice is in UTC+8 timezone',
        state: 'active',
        confidence: 0.9,
        importance: 0.6,
        sourceContext: 'inferred from conversation patterns',
      });

      // 3. 验证私聊上下文包含两个记忆
      const privateContext = await builder.buildContext({
        turnId: 'turn-integration-001',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [
          {
            messageId: 'msg-101',
            senderId: 'user-alice',
            senderDisplayName: 'Alice',
            text: 'What do you know about me?',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
        targetUserId: 'user-alice',
      });

      expect(privateContext.memory.retrievedFacts).toHaveLength(2);
      expect(privateContext.memory.selectedMemoryIds).toContain(privateMemoryId);
      expect(privateContext.memory.selectedMemoryIds).toContain(generalMemoryId);

      const privateFact = privateContext.memory.retrievedFacts.find(
        (f) => f.memoryId === privateMemoryId
      );
      expect(privateFact?.content).toContain('March 15');

      // 4. 验证群组上下文只包含通用记忆
      const groupContext = await builder.buildContext({
        turnId: 'turn-integration-002',
        conversationId: 'group:project-team',
        conversationType: 'group',
        recentMessages: [
          {
            messageId: 'msg-102',
            senderId: 'user-alice',
            senderDisplayName: 'Alice',
            text: 'Good morning team!',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
        targetUserId: 'user-alice',
        groupId: 'group-project-team',
      });

      expect(groupContext.memory.retrievedFacts).toHaveLength(1);
      expect(groupContext.memory.selectedMemoryIds).toContain(generalMemoryId);
      expect(groupContext.memory.selectedMemoryIds).not.toContain(privateMemoryId);

      const generalFact = groupContext.memory.retrievedFacts.find(
        (f) => f.memoryId === generalMemoryId
      );
      expect(generalFact?.content).toContain('UTC+8');

      // 验证敏感信息不在群组上下文中
      expect(groupContext.memory.retrievedFacts.every((f) => !f.content.includes('birthday'))).toBe(
        true
      );
      expect(groupContext.memory.retrievedFacts.every((f) => !f.content.includes('March 15'))).toBe(
        true
      );
    });

    it('should handle token budget calculation with memory injection', async () => {
      // 创建多个记忆
      await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-bob',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'preference',
        title: 'Coding Style',
        content: 'Bob prefers functional programming with TypeScript and comprehensive tests',
        state: 'active',
        confidence: 0.85,
        importance: 0.7,
        sourceContext: 'code review discussions',
      });

      await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-bob',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Framework',
        content: 'Bob likes React and Next.js for frontend work',
        state: 'active',
        confidence: 0.9,
        importance: 0.6,
        sourceContext: 'tech stack discussion',
      });

      // 构建带消息和记忆的上下文
      const context = await builder.buildContext({
        turnId: 'turn-budget-001',
        conversationId: 'private:user-bob',
        conversationType: 'private',
        recentMessages: [
          {
            messageId: 'msg-201',
            senderId: 'user-bob',
            senderDisplayName: 'Bob',
            text: 'Can you help me refactor this component?',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
        targetUserId: 'user-bob',
      });

      // 验证 token 预算计算
      expect(context.tokenBudget.max).toBeGreaterThan(0);
      expect(context.tokenBudget.used).toBeGreaterThan(0);
      expect(context.tokenBudget.breakdown.recentMessages).toBeGreaterThan(0);
      expect(context.tokenBudget.breakdown.memory).toBeGreaterThan(0);
      expect(context.tokenBudget.breakdown.system).toBeGreaterThan(0);

      // 验证记忆被包含
      expect(context.memory.retrievedFacts).toHaveLength(2);
    });
  });
});
