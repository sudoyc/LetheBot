import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { GovernanceCLI } from '../../../src/cli/governance';

describe('GovernanceCLI', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let cli: GovernanceCLI;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    memoryRepo = new MemoryRepository(db);
    cli = new GovernanceCLI(memoryRepo);

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

  describe('listMemory', () => {
    it('should list all active memory', async () => {
      await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'user_stated',
        kind: 'preference',
        title: 'TypeScript preference',
        content: 'Alice prefers TypeScript',
        canonicalUserId: 'user-alice',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      await memoryRepo.create({
        scope: 'group',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'inferred',
        kind: 'summary',
        title: 'Rust discussion',
        content: 'Group dev discusses Rust',
        groupId: 'group-dev',
        confidence: 0.85,
        importance: 0.7,
        sourceContext: 'group_chat',
      });

      const result = await cli.listMemory({});
      expect(result).toHaveLength(2);
      expect(result[0].content).toContain('TypeScript');
      expect(result[1].content).toContain('Rust');
    });

    it('should filter by user', async () => {
      await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'user_stated',
        kind: 'preference',
        title: 'TypeScript preference',
        content: 'Alice prefers TypeScript',
        canonicalUserId: 'user-alice',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      const result = await cli.listMemory({ userId: 'user-alice' });
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('TypeScript');
    });

    it('should filter by state', async () => {
      await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'user_stated',
        kind: 'preference',
        title: 'TypeScript preference',
        content: 'Alice prefers TypeScript',
        canonicalUserId: 'user-alice',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'proposed',
        authority: 'inferred',
        kind: 'preference',
        title: 'Python preference',
        content: 'Bob prefers Python',
        canonicalUserId: 'user-bob',
        confidence: 0.7,
        importance: 0.6,
        sourceContext: 'private_chat',
      });

      const active = await cli.listMemory({ state: 'active' });
      expect(active).toHaveLength(1);

      const proposed = await cli.listMemory({ state: 'proposed' });
      expect(proposed).toHaveLength(1);
      expect(proposed[0].content).toContain('Python');
    });
  });

  describe('deleteMemory', () => {
    it('should mark memory as deleted', async () => {
      const memoryId = await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'user_stated',
        kind: 'preference',
        title: 'TypeScript preference',
        content: 'Alice prefers TypeScript',
        canonicalUserId: 'user-alice',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      const result = await cli.deleteMemory(memoryId);
      expect(result.success).toBe(true);

      const memory = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });
      expect(memory).toHaveLength(0);
    });

    it('should fail for nonexistent memory', async () => {
      const result = await cli.deleteMemory('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('disableMemory', () => {
    it('should mark memory as disabled', async () => {
      const memoryId = await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'user_stated',
        kind: 'preference',
        title: 'TypeScript preference',
        content: 'Alice prefers TypeScript',
        canonicalUserId: 'user-alice',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      const result = await cli.disableMemory(memoryId);
      expect(result.success).toBe(true);

      const memory = await memoryRepo.retrieve({ canonicalUserId: 'user-alice', state: 'disabled' });
      expect(memory).toHaveLength(1);
      expect(memory[0].state).toBe('disabled');
    });
  });

  describe('enableMemory', () => {
    it('should restore disabled memory', async () => {
      const memoryId = await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'user_stated',
        kind: 'preference',
        title: 'TypeScript preference',
        content: 'Alice prefers TypeScript',
        canonicalUserId: 'user-alice',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      await cli.disableMemory(memoryId);

      const result = await cli.enableMemory(memoryId);
      expect(result.success).toBe(true);

      const memory = await memoryRepo.retrieve({ canonicalUserId: 'user-alice', state: 'active' });
      expect(memory).toHaveLength(1);
      expect(memory[0].state).toBe('active');
    });
  });
});
