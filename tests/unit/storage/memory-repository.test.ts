import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { MemoryRepository } from '../../../src/storage/memory-repository';

describe('MemoryRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    repo = new MemoryRepository(db);

    // 创建测试用户
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-alice',
      Date.now(),
      Date.now()
    );
  });

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('create and findById', () => {
    it('should create memory record', async () => {
      const id = await repo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Favorite color',
        content: 'User likes blue',
        state: 'active',
        confidence: 0.9,
        importance: 0.7,
      });

      expect(id).toBeDefined();
      expect(id.length).toBeGreaterThan(0);
    });

    it('should find memory by ID', async () => {
      const id = await repo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Test memory',
        content: 'Test content',
        state: 'active',
        confidence: 0.8,
        importance: 0.5,
      });

      const record = await repo.findById(id);

      expect(record).not.toBeNull();
      expect(record?.id).toBe(id);
      expect(record?.title).toBe('Test memory');
      expect(record?.content).toBe('Test content');
      expect(record?.canonicalUserId).toBe('user-alice');
      expect(record?.confidence).toBe(0.8);
    });

    it('should return null for non-existent ID', async () => {
      const record = await repo.findById('non-existent-id');
      expect(record).toBeNull();
    });
  });

  describe('retrieve with filters', () => {
    beforeEach(async () => {
      // 创建测试数据
      await repo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Private memory',
        content: 'Private content',
        state: 'active',
        confidence: 0.9,
        importance: 0.8,
      });

      await repo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Shared memory',
        content: 'Shared content',
        state: 'active',
        confidence: 0.85,
        importance: 0.7,
      });

      await repo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Deleted memory',
        content: 'Should not appear',
        state: 'deleted',
        confidence: 0.5,
        importance: 0.5,
      });
    });

    it('should retrieve active memories only', async () => {
      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.state === 'active')).toBe(true);
    });

    it('should filter by canonicalUserId', async () => {
      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });

      expect(results.every((r) => r.canonicalUserId === 'user-alice')).toBe(true);
    });

    it('should apply visibility filter for private context', async () => {
      const results = await repo.retrieve({
        canonicalUserId: 'user-alice',
        contextType: 'private',
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => ['private_only', 'same_user_any_context', 'public'].includes(r.visibility))).toBe(
        true
      );
    });

    it('should apply visibility filter for group context', async () => {
      const results = await repo.retrieve({
        canonicalUserId: 'user-alice',
        contextType: 'group',
      });

      // 只有 same_user_any_context，不包括 private_only
      expect(results).toHaveLength(1);
      expect(results[0].visibility).toBe('same_user_any_context');
      expect(results.every((r) => r.visibility !== 'private_only')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const results = await repo.retrieve({
        canonicalUserId: 'user-alice',
        limit: 1,
      });

      expect(results).toHaveLength(1);
    });

    it('should order by importance DESC', async () => {
      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });

      expect(results[0].importance).toBeGreaterThanOrEqual(results[1].importance);
    });
  });

  describe('state management', () => {
    let memoryId: string;

    beforeEach(async () => {
      memoryId = await repo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Test',
        content: 'Content',
        state: 'active',
        confidence: 0.5,
        importance: 0.5,
      });
    });

    it('should delete memory (soft delete)', async () => {
      await repo.delete(memoryId);

      const record = await repo.findById(memoryId);
      expect(record?.state).toBe('deleted');
    });

    it('should disable memory', async () => {
      await repo.disable(memoryId);

      const record = await repo.findById(memoryId);
      expect(record?.state).toBe('disabled');
    });

    it('deleted memories excluded from retrieval', async () => {
      await repo.delete(memoryId);

      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });
      expect(results.every((r) => r.id !== memoryId)).toBe(true);
    });

    it('disabled memories excluded from retrieval', async () => {
      await repo.disable(memoryId);

      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });
      expect(results.every((r) => r.id !== memoryId)).toBe(true);
    });
  });

  describe('full-text search', () => {
    beforeEach(async () => {
      await repo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Favorite color',
        content: 'User likes blue and green',
        state: 'active',
        confidence: 0.9,
        importance: 0.8,
      });

      await repo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Programming language',
        content: 'User knows TypeScript and Python',
        state: 'active',
        confidence: 0.85,
        importance: 0.7,
      });

      // Rebuild FTS index
      db.prepare("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')").run();
    });

    it('should search by content', async () => {
      const results = await repo.search('blue');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('blue');
    });

    it('should search by title', async () => {
      const results = await repo.search('color');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toContain('color');
    });

    it('should return empty for no match', async () => {
      const results = await repo.search('nonexistent');
      expect(results).toHaveLength(0);
    });

    it('should only return active memories', async () => {
      const results = await repo.search('User');

      expect(results.every((r) => r.state === 'active')).toBe(true);
    });
  });
});
