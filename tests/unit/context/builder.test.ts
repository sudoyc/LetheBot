import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { ContextBuilder } from '../../../src/context/builder';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { IdentityRepository } from '../../../src/storage/identity-repository';

describe('ContextBuilder', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let builder: ContextBuilder;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    builder = new ContextBuilder(memoryRepo, identityRepo);

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

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-charlie',
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

  describe('buildContext', () => {
    it('should build basic context pack', async () => {
      const context = await builder.buildContext({
        turnId: 'turn-001',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'user-alice',
            text: '你好',
            timestamp: new Date(),
            senderDisplayName: 'Alice',
            isFromBot: false,
          },
        ],
      });

      expect(context.id).toBeDefined();
      expect(context.turnId).toBe('turn-001');
      expect(context.conversation.conversationId).toBe('private:user-alice');
      expect(context.recentMessages).toHaveLength(1);
      expect(context.tokenBudget.max).toBeGreaterThan(0);
    });

    it('should retrieve user memory with private_only visibility', async () => {
      // Create user memory
      await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'personal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Secret preference',
        content: 'I prefer dark mode',
        state: 'active',
        confidence: 0.9,
        importance: 0.5,
        sourceContext: 'private chat',
        sourceEventIds: [],
      });

      const context = await builder.buildContext({
        turnId: 'turn-002',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-alice',
      });

      expect(context.memory.retrievedFacts).toHaveLength(1);
      expect(context.memory.retrievedFacts[0].content).toContain('dark mode');
    });

    it('should NOT include private_only memory in group context', async () => {
      // Create private memory
      await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'personal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Secret',
        content: 'My password is secret123',
        state: 'active',
        confidence: 0.9,
        importance: 0.5,
        sourceContext: 'private chat',
        sourceEventIds: [],
      });

      const context = await builder.buildContext({
        turnId: 'turn-003',
        conversationId: 'group:tech-chat',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-alice',
      });

      // Private memory should be filtered out
      expect(context.memory.retrievedFacts.every((m) => !m.content.includes('secret123'))).toBe(true);
    });

    it('should include same_user_any_context memory in both private and group', async () => {
      await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-bob',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'preference',
        title: 'Language preference',
        content: 'Prefers English',
        state: 'active',
        confidence: 0.8,
        importance: 0.5,
        sourceContext: 'conversation',
        sourceEventIds: [],
      });

      // Private context
      const privateCtx = await builder.buildContext({
        turnId: 'turn-004',
        conversationId: 'private:user-bob',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-bob',
      });

      expect(privateCtx.memory.retrievedFacts.some((m) => m.content.includes('English'))).toBe(true);

      // Group context
      const groupCtx = await builder.buildContext({
        turnId: 'turn-005',
        conversationId: 'group:dev-team',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-bob',
      });

      expect(groupCtx.memory.retrievedFacts.some((m) => m.content.includes('English'))).toBe(true);
    });

    it('should exclude deleted memory', async () => {
      const memId = await memoryRepo.create({
        scope: 'user',
        canonicalUserId: 'user-charlie',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Fact',
        content: 'Important fact',
        state: 'active',
        confidence: 0.9,
        importance: 0.5,
        sourceContext: 'chat',
        sourceEventIds: [],
      });

      await memoryRepo.delete(memId);

      const context = await builder.buildContext({
        turnId: 'turn-006',
        conversationId: 'private:user-charlie',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-charlie',
      });

      expect(context.memory.retrievedFacts).toHaveLength(0);
    });

    it('should calculate token budget', async () => {
      const context = await builder.buildContext({
        turnId: 'turn-007',
        conversationId: 'private:user-dave',
        conversationType: 'private',
        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'user-dave',
            text: 'Hello world this is a test message',
            timestamp: new Date(),
            senderDisplayName: 'Dave',
            isFromBot: false,
          },
        ],
        targetUserId: 'user-dave',
      });

      expect(context.tokenBudget.used).toBeGreaterThan(0);
      expect(context.tokenBudget.breakdown.recentMessages).toBeGreaterThan(0);
      expect(context.tokenBudget.breakdown.system).toBeGreaterThan(0);
    });
  });
});
