import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupSqliteDatabase, restoreSqliteDatabase } from '../../../src/operations/sqlite-maintenance.js';
import {
  getSchemaVersion, initDatabase, recordSchemaVersion, runMigration, runMigrations,
} from '../../../src/storage/database.js';
import { readMigrationPlan } from '../../../src/storage/migration-plan.js';
import { CURRENT_SCHEMA_VERSION } from '../../../src/storage/schema-version.js';

const migrations = join(process.cwd(), 'migrations');
const roots: string[] = [];
const now = 1_700_000_000_000;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lethebot-schema-v9-'));
  roots.push(directory);
  return directory;
}

function migrateToV8(db: Database.Database): void {
  runMigration(db, join(migrations, '001_initial_schema.sql'));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const migration of readMigrationPlan(migrations, CURRENT_SCHEMA_VERSION).slice(1, 8)) {
        db.exec(readFileSync(migration.path, 'utf8'));
        recordSchemaVersion(db, migration.version, migration.description);
      }
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seedMemory(db: Database.Database): void {
  db.prepare(`INSERT INTO raw_events
    (id, type, timestamp, source, platform, conversation_id, payload, created_at)
    VALUES ('embedding-source', 'chat.message.received', ?, 'gateway', 'qq',
      'group:embedding', '{}', ?)`).run(now, now);
  db.prepare(`INSERT INTO memory_records
    (id, scope, group_id, visibility, sensitivity, authority, kind, title, content,
      state, confidence, importance, created_at, updated_at)
    VALUES ('embedding-memory', 'group', 'embedding-group', 'same_group_only',
      'normal', 'user_stated', 'fact', 'Test workflow', 'Review before publishing',
      'active', 0.8, 0.7, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO memory_sources
    (memory_id, source_type, source_id, source_timestamp, extracted_by, resolution_state, raw_event_id)
    VALUES ('embedding-memory', 'raw_event', 'embedding-source', ?, 'user', 'internal',
      'embedding-source')`).run(now);
  db.prepare(`INSERT INTO memory_revisions
    (id, memory_id, revision_number, change_type, new_state, actor, created_at)
    VALUES ('embedding-revision', 'embedding-memory', 1, 'create', '{}', 'user', ?)`).run(now);
}

function truth(db: Database.Database): unknown[] {
  return ['memory_records', 'memory_sources', 'memory_revisions', 'audit_log', 'raw_events']
    .map((table) => db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all());
}

function insertEmbedding(db: Database.Database, overrides: Record<string, unknown> = {}): void {
  db.prepare(`INSERT INTO memory_embeddings
    (memory_id, provider, model, model_revision, dimensions, index_version,
      content_fingerprint, memory_revision, vector, generated_at)
    VALUES (@memoryId, @provider, @model, @modelRevision, @dimensions, @indexVersion,
      @fingerprint, @memoryRevision, @vector, @generatedAt)`).run({
    memoryId: 'embedding-memory', provider: 'local_transformers',
    model: 'synthetic/model', modelRevision: 'a'.repeat(64), dimensions: 3,
    indexVersion: 1, fingerprint: 'b'.repeat(64), memoryRevision: 1,
    vector: Buffer.from(new Float32Array([1, 0, 0]).buffer), generatedAt: now + 1,
    ...overrides,
  });
}

describe('schema v9 derived memory embeddings', () => {
  it('creates a bounded empty index on a fresh database and validates repeats without writes', () => {
    const db = initDatabase({ path: join(root(), 'fresh.db') });
    try {
      runMigrations(db, migrations);
      expect(getSchemaVersion(db)).toBe(10);
      expect(db.prepare('SELECT COUNT(*) FROM memory_embeddings').pluck().get()).toBe(0);
      const before = db.prepare('SELECT total_changes()').pluck().get();
      runMigrations(db, migrations);
      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(before);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('upgrades populated v8 without changing truth, rowids, FTS or existing ledger timestamps', () => {
    const db = initDatabase({ path: join(root(), 'upgrade.db') });
    try {
      migrateToV8(db);
      seedMemory(db);
      const before = truth(db);
      const ledger = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
      const fts = db.prepare('SELECT rowid, * FROM memory_fts').all();
      runMigrations(db, migrations);
      insertEmbedding(db);
      expect(getSchemaVersion(db)).toBe(10);
      expect(truth(db)).toEqual(before);
      expect(db.prepare('SELECT * FROM schema_version WHERE version <= 8 ORDER BY version').all()).toEqual(ledger);
      expect(db.prepare('SELECT rowid, * FROM memory_fts').all()).toEqual(fts);
      db.exec('DELETE FROM memory_embeddings');
      expect(truth(db)).toEqual(before);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('rejects malformed vectors, versions and orphaned memory references', () => {
    const db = initDatabase({ path: join(root(), 'bounds.db') });
    try {
      runMigrations(db, migrations);
      seedMemory(db);
      for (const invalid of [
        { memoryId: 'missing' }, { provider: 'remote_unapproved' },
        { model: '' }, { model: 'a'.repeat(257) }, { modelRevision: 'not-a-digest' },
        { dimensions: 0 }, { dimensions: 4097 }, { dimensions: 2.5 },
        { dimensions: 4 }, { indexVersion: 0 }, { indexVersion: 1.5 },
        { fingerprint: 'g'.repeat(64) }, { memoryRevision: 0 },
        { generatedAt: -1 }, { vector: 'not-a-blob' },
      ]) {
        expect(() => insertEmbedding(db, invalid)).toThrow();
      }
      expect(db.prepare('SELECT COUNT(*) FROM memory_embeddings').pluck().get()).toBe(0);
      insertEmbedding(db);
      expect(() => insertEmbedding(db)).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('rolls back all migration writes when a pre-existing index has an incompatible shape', () => {
    const db = initDatabase({ path: join(root(), 'conflict.db') });
    try {
      migrateToV8(db);
      seedMemory(db);
      db.exec('CREATE TABLE memory_embeddings (legacy TEXT)');
      const before = truth(db);
      const schema = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
      const ledger = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
      expect(() => runMigrations(db, migrations)).toThrow();
      expect(getSchemaVersion(db)).toBe(8);
      expect(truth(db)).toEqual(before);
      expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(schema);
      expect(db.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(ledger);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('preserves a v9 vector through backup/restore and restores the exact pre-v9 snapshot for rollback', async () => {
    const directory = root();
    const databasePath = join(directory, 'candidate.db');
    const priorBackup = join(directory, 'prior.db');
    const candidateBackup = join(directory, 'backup.db');
    const restoredPath = join(directory, 'restored.db');
    const db = initDatabase({ path: databasePath });
    let priorTruth: unknown[];
    let vectorRows: unknown[];
    try {
      migrateToV8(db);
      seedMemory(db);
      priorTruth = truth(db);
      expect((await backupSqliteDatabase({ sourcePath: databasePath, backupPath: priorBackup })).integrityOk).toBe(true);
      runMigrations(db, migrations);
      insertEmbedding(db);
      vectorRows = db.prepare('SELECT * FROM memory_embeddings').all();
      expect((await backupSqliteDatabase({ sourcePath: databasePath, backupPath: candidateBackup })).integrityOk).toBe(true);
    } finally { db.close(); }
    expect(restoreSqliteDatabase({ backupPath: candidateBackup, targetPath: restoredPath }))
      .toMatchObject({ integrityOk: true, foreignKeyViolations: 0 });
    const restored = initDatabase({ path: restoredPath });
    try {
      runMigrations(restored, migrations);
      expect(restored.prepare('SELECT * FROM memory_embeddings').all()).toEqual(vectorRows);
      expect(truth(restored)).toEqual(priorTruth);
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { restored.close(); }
    expect(restoreSqliteDatabase({ backupPath: priorBackup, targetPath: databasePath, overwrite: true }))
      .toMatchObject({ integrityOk: true, foreignKeyViolations: 0 });
    const rolledBack = initDatabase({ path: databasePath, readonly: true });
    try {
      expect(getSchemaVersion(rolledBack)).toBe(8);
      expect(truth(rolledBack)).toEqual(priorTruth);
      expect(rolledBack.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'memory_embeddings'").get()).toBeUndefined();
      expect(rolledBack.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { rolledBack.close(); }
  });
});
