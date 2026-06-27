import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  initDatabase,
  getSchemaVersion,
  recordSchemaVersion,
  runMigration,
  closeDatabase,
} from '../../../src/storage/database';

describe('Database', () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-'));
  });

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('initDatabase', () => {
    it('should create database file', () => {
      const dbPath = join(testDir, 'test.db');
      db = initDatabase({ path: dbPath });

      expect(db).toBeDefined();
    });

    it('should enable foreign keys', () => {
      const dbPath = join(testDir, 'test.db');
      db = initDatabase({ path: dbPath });

      const result = db.pragma('foreign_keys', { simple: true });
      expect(result).toBe(1);
    });

    it('should enable WAL mode for writable databases', () => {
      const dbPath = join(testDir, 'test.db');
      db = initDatabase({ path: dbPath });

      const result = db.pragma('journal_mode', { simple: true });
      expect(result).toBe('wal');
    });

    it('should open in readonly mode when specified', () => {
      // Create database first
      const dbPath = join(testDir, 'test.db');
      const writeDb = initDatabase({ path: dbPath });
      writeDb.close();

      // Open readonly
      db = initDatabase({ path: dbPath, readonly: true });
      expect(db).toBeDefined();
    });
  });

  describe('Schema version tracking', () => {
    beforeEach(() => {
      const dbPath = join(testDir, 'test.db');
      db = initDatabase({ path: dbPath });
      // Create schema_version table
      db.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
      `);
    });

    it('should return 0 for new database', () => {
      const version = getSchemaVersion(db);
      expect(version).toBe(0);
    });

    it('should record schema version', () => {
      recordSchemaVersion(db, 1, 'Initial schema');

      const version = getSchemaVersion(db);
      expect(version).toBe(1);
    });

    it('should return latest version when multiple exist', () => {
      recordSchemaVersion(db, 1, 'Initial schema');
      recordSchemaVersion(db, 2, 'Add indexes');
      recordSchemaVersion(db, 3, 'Add FTS');

      const version = getSchemaVersion(db);
      expect(version).toBe(3);
    });
  });

  describe('runMigration', () => {
    beforeEach(() => {
      const dbPath = join(testDir, 'test.db');
      db = initDatabase({ path: dbPath });
    });

    it('should execute migration SQL from file', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      runMigration(db, migrationPath);

      // Verify tables exist
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('canonical_users');
      expect(tableNames).toContain('platform_accounts');
      expect(tableNames).toContain('memory_records');
      expect(tableNames).toContain('agent_turns');
      expect(tableNames).toContain('audit_log');
    });

    it('migration should be idempotent', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');

      // Run twice
      runMigration(db, migrationPath);

      // Should not throw on second run (IF NOT EXISTS)
      expect(() => runMigration(db, migrationPath)).not.toThrow();
    });
  });

  describe('Foreign key constraints', () => {
    beforeEach(() => {
      const dbPath = join(testDir, 'test.db');
      db = initDatabase({ path: dbPath });
      runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    });

    it('should enforce foreign key on platform_accounts', () => {
      // Try to insert platform_account without canonical_user
      expect(() => {
        db.prepare(
          `INSERT INTO platform_accounts (platform, platform_account_id, canonical_user_id, account_type, verified_level, status, first_seen_at, last_seen_at)
           VALUES ('qq', '12345', 'user-nonexistent', 'private', 'observed', 'active', ?, ?)`
        ).run(Date.now(), Date.now());
      }).toThrow();
    });

    it('should allow insert with valid foreign key', () => {
      const now = Date.now();

      // Insert canonical_user first
      db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
        'user-001',
        now,
        now
      );

      // Insert platform_account
      db.prepare(
        `INSERT INTO platform_accounts (platform, platform_account_id, canonical_user_id, account_type, verified_level, status, first_seen_at, last_seen_at)
         VALUES ('qq', '12345', 'user-001', 'private', 'observed', 'active', ?, ?)`
      ).run(now, now);

      const result = db
        .prepare('SELECT * FROM platform_accounts WHERE platform_account_id = ?')
        .get('12345') as any;

      expect(result).toBeDefined();
      expect(result.canonical_user_id).toBe('user-001');
    });
  });

  describe('Check constraints', () => {
    beforeEach(() => {
      const dbPath = join(testDir, 'test.db');
      db = initDatabase({ path: dbPath });
      runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    });

    it('should enforce platform CHECK constraint', () => {
      const now = Date.now();
      db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
        'user-001',
        now,
        now
      );

      expect(() => {
        db.prepare(
          `INSERT INTO platform_accounts (platform, platform_account_id, canonical_user_id, account_type, verified_level, status, first_seen_at, last_seen_at)
           VALUES ('invalid_platform', '12345', 'user-001', 'private', 'observed', 'active', ?, ?)`
        ).run(now, now);
      }).toThrow();
    });

    it('should enforce memory_records state CHECK constraint', () => {
      expect(() => {
        db.prepare(
          `INSERT INTO memory_records (id, scope, visibility, sensitivity, authority, kind, title, content, state, confidence, importance, created_at, updated_at)
           VALUES ('mem-001', 'user', 'private_only', 'normal', 'user_stated', 'preference', 'Test', 'Content', 'invalid_state', 0.5, 0.5, ?, ?)`
        ).run(Date.now(), Date.now());
      }).toThrow();
    });

    it('should enforce confidence range CHECK constraint', () => {
      expect(() => {
        db.prepare(
          `INSERT INTO memory_records (id, scope, visibility, sensitivity, authority, kind, title, content, state, confidence, importance, created_at, updated_at)
           VALUES ('mem-001', 'user', 'private_only', 'normal', 'user_stated', 'preference', 'Test', 'Content', 'active', 1.5, 0.5, ?, ?)`
        ).run(Date.now(), Date.now());
      }).toThrow();
    });
  });

  describe('Indexes', () => {
    beforeEach(() => {
      const dbPath = join(testDir, 'test.db');
      db = initDatabase({ path: dbPath });
      runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    });

    it('should create indexes for memory_records', () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_records' AND name NOT LIKE 'sqlite_%'"
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_memory_scope');
      expect(indexNames).toContain('idx_memory_user');
      expect(indexNames).toContain('idx_memory_state');
      expect(indexNames).toContain('idx_memory_active_user');
    });

    it('should create indexes for raw_events', () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='raw_events' AND name NOT LIKE 'sqlite_%'"
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_raw_events_type');
      expect(indexNames).toContain('idx_raw_events_timestamp');
      expect(indexNames).toContain('idx_raw_events_conversation');
    });
  });

  describe('FTS5 virtual table', () => {
    beforeEach(() => {
      const dbPath = join(testDir, 'test.db');
      db = initDatabase({ path: dbPath });
      runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    });

    it('should create memory_fts virtual table', () => {
      const result = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'")
        .get() as { name: string } | undefined;

      expect(result?.name).toBe('memory_fts');
    });

    it('should allow full-text search', () => {
      const now = Date.now();

      // Insert test memory
      db.prepare(
        `INSERT INTO memory_records (id, scope, visibility, sensitivity, authority, kind, title, content, state, confidence, importance, created_at, updated_at)
         VALUES ('mem-001', 'user', 'private_only', 'normal', 'user_stated', 'preference', 'Favorite color', 'User likes blue', 'active', 0.9, 0.7, ?, ?)`
      ).run(now, now);

      // Trigger FTS sync
      db.prepare("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')").run();

      // Search
      const results = db
        .prepare(
          "SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'blue' ORDER BY rank"
        )
        .all() as Array<{ rowid: number }>;

      expect(results.length).toBeGreaterThan(0);
    });
  });
});
