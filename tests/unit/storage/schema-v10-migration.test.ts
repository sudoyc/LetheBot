import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryMaintenanceProposal } from '../../../src/memory/maintenance-proposal.js';
import { backupSqliteDatabase, restoreSqliteDatabase } from '../../../src/operations/sqlite-maintenance.js';
import { AuditRepository } from '../../../src/storage/audit-repository.js';
import { getSchemaVersion, initDatabase, recordSchemaVersion, runMigration, runMigrations } from '../../../src/storage/database.js';
import { MemoryMaintenanceProposalRepository } from '../../../src/storage/memory-maintenance-proposal-repository.js';
import { readMigrationPlan } from '../../../src/storage/migration-plan.js';
import { CURRENT_SCHEMA_VERSION } from '../../../src/storage/schema-version.js';

const migrations = join(process.cwd(), 'migrations');
const roots: string[] = [];
const now = 1_800_000_000_000;
const tables = ['memory_records', 'memory_sources', 'memory_revisions', 'audit_log',
  'raw_events', 'memory_maintenance_proposals', 'memory_maintenance_proposal_candidates',
  'memory_maintenance_proposal_reasons', 'memory_maintenance_proposal_revisions',
  'memory_maintenance_proposal_revision_effects'];

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'lethebot-schema-v10-'));
  roots.push(path);
  return path;
}

function v9(db: Database.Database): void {
  runMigration(db, join(migrations, '001_initial_schema.sql'));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const migration of readMigrationPlan(migrations, CURRENT_SCHEMA_VERSION).slice(1, 9)) {
        db.exec(readFileSync(migration.path, 'utf8'));
        recordSchemaVersion(db, migration.version, migration.description);
      }
    }).immediate();
  } finally { db.pragma('foreign_keys = ON'); }
}

function truth(db: Database.Database): unknown[] {
  return tables.map((table) => db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all());
}

async function seedAppliedDecay(db: Database.Database): Promise<void> {
  db.prepare(`INSERT INTO raw_events (id, type, timestamp, source, payload, created_at)
    VALUES ('v10-source', 'system.notice', ?, 'system', '{}', ?)`).run(now, now);
  db.prepare(`INSERT INTO memory_records
    (id, scope, visibility, sensitivity, authority, kind, title, content, state,
      confidence, importance, created_at, updated_at)
    VALUES ('v10-memory', 'system', 'owner_admin_only', 'normal', 'system', 'fact',
      'Synthetic maintenance', 'Preserve this evidence', 'active', 0.8, 0.4, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO memory_sources
    (memory_id, source_type, source_id, source_timestamp, extracted_by, resolution_state, raw_event_id)
    VALUES ('v10-memory', 'raw_event', 'v10-source', ?, 'system', 'internal', 'v10-source')`).run(now);
  const audit = new AuditRepository(db);
  const proposal = await createMemoryMaintenanceProposal(db, audit, {
    kind: 'decay', candidateMemoryIds: ['v10-memory'], reasonCodes: ['stale'],
    proposedEffect: { type: 'disable', memoryId: 'v10-memory' }, nowMs: now,
  });
  const repository = new MemoryMaintenanceProposalRepository(db, audit);
  const actor = { actorClass: 'admin', invocationContext: 'admin_cli' } as const;
  const common = { proposalId: proposal.proposalId, access: { kind: 'all' } as const,
    actor, authorityKind: 'local_admin' as const, reasonCode: 'schema_fixture', nowMs: now + 1 };
  expect(repository.transitionReview({ ...common, expectedState: 'pending_review',
    expectedRevisionNumber: 1, transition: 'approve' }).outcome).toBe('transitioned');
  expect(repository.applyApproved({ ...common, expectedState: 'approved',
    expectedRevisionNumber: 2 }).outcome).toBe('transitioned');
}

describe('schema v10 governed importance evidence', () => {
  it('creates the new evidence tables on a fresh database and reopens without writes', () => {
    const path = join(directory(), 'fresh.db');
    let db = initDatabase({ path });
    try {
      runMigrations(db, migrations);
      expect(getSchemaVersion(db)).toBe(10);
      expect(db.prepare('SELECT COUNT(*) FROM memory_importance_scores').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM memory_importance_sources').pluck().get()).toBe(0);
      db.close();
      db = initDatabase({ path });
      runMigrations(db, migrations);
      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(0);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('preserves populated v9 governance chains through upgrade, backup/restore and snapshot rollback', async () => {
    const root = directory();
    const path = join(root, 'upgrade.db');
    const prior = join(root, 'v9.db');
    const candidate = join(root, 'v10.db');
    const restored = join(root, 'restored.db');
    const db = initDatabase({ path });
    let before: unknown[];
    let ledger: unknown[];
    try {
      v9(db);
      await seedAppliedDecay(db);
      before = truth(db);
      ledger = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
      expect((await backupSqliteDatabase({ sourcePath: path, backupPath: prior })).integrityOk).toBe(true);
      runMigrations(db, migrations);
      expect(getSchemaVersion(db)).toBe(10);
      expect(truth(db)).toEqual(before);
      expect(db.prepare('SELECT * FROM schema_version WHERE version <= 9 ORDER BY version').all()).toEqual(ledger);
      expect((await backupSqliteDatabase({ sourcePath: path, backupPath: candidate })).integrityOk).toBe(true);
    } finally { db.close(); }
    expect(restoreSqliteDatabase({ backupPath: candidate, targetPath: restored }))
      .toMatchObject({ integrityOk: true, foreignKeyViolations: 0 });
    const copy = initDatabase({ path: restored });
    try {
      runMigrations(copy, migrations);
      expect(truth(copy)).toEqual(before);
      expect(copy.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { copy.close(); }
    expect(restoreSqliteDatabase({ backupPath: prior, targetPath: path, overwrite: true }))
      .toMatchObject({ integrityOk: true, foreignKeyViolations: 0 });
    const rollback = initDatabase({ path, readonly: true });
    try {
      expect(getSchemaVersion(rollback)).toBe(9);
      expect(truth(rollback)).toEqual(before);
      expect(rollback.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(ledger);
      expect(rollback.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'memory_importance_scores'").get()).toBeUndefined();
    } finally { rollback.close(); }
  });

  it('rolls back table rebuilds, rowids and ledger if the importance schema conflicts', async () => {
    const db = initDatabase({ path: join(directory(), 'conflict.db') });
    try {
      v9(db);
      await seedAppliedDecay(db);
      db.exec('CREATE TABLE memory_importance_scores (incompatible TEXT)');
      const before = truth(db);
      const schema = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
      expect(() => runMigrations(db, migrations)).toThrow();
      expect(getSchemaVersion(db)).toBe(9);
      expect(truth(db)).toEqual(before);
      expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(schema);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });
});
