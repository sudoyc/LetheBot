import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backupSqliteDatabase,
  restoreSqliteDatabase,
} from '../../../src/operations/sqlite-maintenance.js';
import {
  closeDatabase,
  getSchemaVersion,
  initDatabase,
  recordSchemaVersion,
  runMigration,
  runMigrations,
} from '../../../src/storage/database.js';

const BASE_TIME = 1_700_000_000_000;
const migrationDirectory = join(process.cwd(), 'migrations');
const temporaryRoots: string[] = [];

type ProposalKind = 'conflict' | 'consolidation' | 'decay';
type CandidateRole =
  | 'conflict_candidate'
  | 'retained'
  | 'supersede'
  | 'disable_target';

interface ProposalCandidateFixture {
  memoryId: string;
  role: CandidateRole;
  recordFingerprint: string;
  sourceCount?: number;
  sourceFingerprint: string;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('schema v8 memory maintenance proposal migration', () => {
  it('creates the normalized v8 contract on a fresh database and repeats without writes', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);

      expect(getSchemaVersion(db)).toBe(8);
      expect(db.prepare(
        'SELECT version, description FROM schema_version ORDER BY version',
      ).all()).toEqual([
        { version: 1, description: 'Initial schema' },
        { version: 2, description: 'Evaluator authority ownership' },
        { version: 3, description: 'Evaluator model invocations' },
        { version: 4, description: 'Evaluator correction attempts' },
        { version: 5, description: 'Delayed attention' },
        { version: 6, description: 'Group summary policy' },
        { version: 7, description: 'Pi turn model invocations' },
        { version: 8, description: 'Memory maintenance proposals' },
      ]);
      expect(db.prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name LIKE 'memory_maintenance_%'
          ORDER BY name`,
      ).all()).toEqual([
        { name: 'memory_maintenance_proposal_candidates' },
        { name: 'memory_maintenance_proposal_reasons' },
        { name: 'memory_maintenance_proposal_revision_effects' },
        { name: 'memory_maintenance_proposal_revisions' },
        { name: 'memory_maintenance_proposals' },
      ]);
      expect(db.prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'trigger'
            AND name = 'trg_validate_memory_maintenance_proposal_revision'`,
      ).get()).toEqual({
        name: 'trg_validate_memory_maintenance_proposal_revision',
      });

      const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
      runMigrations(db, migrationDirectory);
      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('upgrades populated v7 data without backfilling executable proposal state', () => {
    const db = openDatabase();
    try {
      migrateToV7(db);
      seedMemory(db, 'memory-v7-preserved', { sourceSuffix: 'preserved' });
      seedAudit(db, 'audit-v7-proposal-json', 'memory.maintenance.proposed');
      const recordRowId = db.prepare(
        `SELECT rowid FROM memory_records WHERE id = 'memory-v7-preserved'`,
      ).pluck().get();
      const sourceRowId = db.prepare(
        `SELECT rowid FROM memory_sources WHERE memory_id = 'memory-v7-preserved'`,
      ).pluck().get();
      const revisionRowId = db.prepare(
        `SELECT rowid FROM memory_revisions WHERE memory_id = 'memory-v7-preserved'`,
      ).pluck().get();

      runMigrations(db, migrationDirectory);

      expect(getSchemaVersion(db)).toBe(8);
      expect(db.prepare(
        `SELECT rowid FROM memory_records WHERE id = 'memory-v7-preserved'`,
      ).pluck().get()).toBe(recordRowId);
      expect(db.prepare(
        `SELECT rowid FROM memory_sources WHERE memory_id = 'memory-v7-preserved'`,
      ).pluck().get()).toBe(sourceRowId);
      expect(db.prepare(
        `SELECT rowid FROM memory_revisions WHERE memory_id = 'memory-v7-preserved'`,
      ).pluck().get()).toBe(revisionRowId);
      for (const table of [
        'memory_maintenance_proposals',
        'memory_maintenance_proposal_candidates',
        'memory_maintenance_proposal_reasons',
        'memory_maintenance_proposal_revisions',
        'memory_maintenance_proposal_revision_effects',
      ]) {
        expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
      }
      expect(db.prepare(
        `SELECT COUNT(*) FROM audit_log
          WHERE event_type = 'memory.maintenance.proposed'`,
      ).pluck().get()).toBe(1);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('stores conflict, consolidation, and decay shapes without content or source IDs', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      for (const [id, suffix] of [
        ['memory-conflict-a', 'conflict-a'],
        ['memory-conflict-b', 'conflict-b'],
        ['memory-consolidate-a', 'consolidate-a'],
        ['memory-consolidate-b', 'consolidate-b'],
        ['memory-decay-a', 'decay-a'],
      ] as const) {
        seedMemory(db, id, { sourceSuffix: suffix });
      }

      insertProposal(db, {
        id: 'proposal-conflict',
        kind: 'conflict',
        candidates: [
          candidate('memory-conflict-a', 'conflict_candidate', 'a', '1'),
          candidate('memory-conflict-b', 'conflict_candidate', 'b', '2'),
        ],
        reasons: ['same_boundary_title_different_content'],
      });
      insertProposal(db, {
        id: 'proposal-consolidation',
        kind: 'consolidation',
        effectMemoryId: 'memory-consolidate-a',
        effectMemoryRole: 'retained',
        candidates: [
          candidate('memory-consolidate-a', 'retained', 'c', '3'),
          candidate('memory-consolidate-b', 'supersede', 'd', '4'),
        ],
        reasons: ['same_boundary_title_and_content'],
      });
      insertProposal(db, {
        id: 'proposal-decay',
        kind: 'decay',
        effectMemoryId: 'memory-decay-a',
        effectMemoryRole: 'disable_target',
        candidates: [candidate('memory-decay-a', 'disable_target', 'e', '5')],
        reasons: ['stale', 'low_confidence', 'low_importance'],
      });

      expect(db.prepare(
        `SELECT id, kind, effect_type, lifecycle_state, effect_memory_id,
                effect_memory_role, current_revision_number
           FROM memory_maintenance_proposals ORDER BY id`,
      ).all()).toEqual([
        {
          id: 'proposal-conflict',
          kind: 'conflict',
          effect_type: 'resolve_conflict',
          lifecycle_state: 'pending_review',
          effect_memory_id: null,
          effect_memory_role: null,
          current_revision_number: 1,
        },
        {
          id: 'proposal-consolidation',
          kind: 'consolidation',
          effect_type: 'consolidate',
          lifecycle_state: 'pending_review',
          effect_memory_id: 'memory-consolidate-a',
          effect_memory_role: 'retained',
          current_revision_number: 1,
        },
        {
          id: 'proposal-decay',
          kind: 'decay',
          effect_type: 'disable',
          lifecycle_state: 'pending_review',
          effect_memory_id: 'memory-decay-a',
          effect_memory_role: 'disable_target',
          current_revision_number: 1,
        },
      ]);
      expect(db.prepare(
        `SELECT proposal_id, candidate_ordinal, memory_id, effect_role,
                source_count, expected_state
           FROM memory_maintenance_proposal_candidates
          ORDER BY proposal_id, candidate_ordinal`,
      ).all()).toEqual([
        {
          proposal_id: 'proposal-conflict',
          candidate_ordinal: 0,
          memory_id: 'memory-conflict-a',
          effect_role: 'conflict_candidate',
          source_count: 1,
          expected_state: 'active',
        },
        {
          proposal_id: 'proposal-conflict',
          candidate_ordinal: 1,
          memory_id: 'memory-conflict-b',
          effect_role: 'conflict_candidate',
          source_count: 1,
          expected_state: 'active',
        },
        {
          proposal_id: 'proposal-consolidation',
          candidate_ordinal: 0,
          memory_id: 'memory-consolidate-a',
          effect_role: 'retained',
          source_count: 1,
          expected_state: 'active',
        },
        {
          proposal_id: 'proposal-consolidation',
          candidate_ordinal: 1,
          memory_id: 'memory-consolidate-b',
          effect_role: 'supersede',
          source_count: 1,
          expected_state: 'active',
        },
        {
          proposal_id: 'proposal-decay',
          candidate_ordinal: 0,
          memory_id: 'memory-decay-a',
          effect_role: 'disable_target',
          source_count: 1,
          expected_state: 'active',
        },
      ]);
      expect(db.prepare(
        `SELECT proposal_id, reason_ordinal, reason_code
           FROM memory_maintenance_proposal_reasons
          ORDER BY proposal_id, reason_ordinal`,
      ).all()).toHaveLength(5);

      const proposalColumns = db.prepare(
        `SELECT name FROM pragma_table_info('memory_maintenance_proposals')`,
      ).pluck().all() as string[];
      const candidateColumns = db.prepare(
        `SELECT name FROM pragma_table_info('memory_maintenance_proposal_candidates')`,
      ).pluck().all() as string[];
      expect([...proposalColumns, ...candidateColumns]).not.toEqual(
        expect.arrayContaining(['title', 'content', 'source_id', 'source_ids']),
      );
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('links governed apply evidence to exact proposal and memory revisions', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      seedCanonicalUser(db, 'user-reviewer');
      seedMemory(db, 'memory-decay-link', { sourceSuffix: 'decay-link' });
      insertProposal(db, {
        id: 'proposal-decay-link',
        kind: 'decay',
        effectMemoryId: 'memory-decay-link',
        effectMemoryRole: 'disable_target',
        candidates: [candidate('memory-decay-link', 'disable_target', 'a', 'b')],
        reasons: ['stale'],
      });

      advanceProposal(db, {
        proposalId: 'proposal-decay-link',
        kind: 'decay',
        revisionNumber: 2,
        transition: 'approve',
        previousState: 'pending_review',
        newState: 'approved',
        actorUserId: 'user-reviewer',
        actorClass: 'owner',
        invocationContext: 'admin_cli',
        reasonCode: 'reviewer_approved',
      });

      const applyAuditId = seedAudit(
        db,
        'audit-proposal-decay-link-apply',
        'memory.maintenance.applied',
      );
      db.transaction(() => {
        db.prepare(
          `UPDATE memory_maintenance_proposals
              SET lifecycle_state = 'applied', current_revision_number = 3,
                  updated_at = ?
            WHERE id = 'proposal-decay-link'
              AND lifecycle_state = 'approved'
              AND current_revision_number = 2`,
        ).run(BASE_TIME + 20);
        db.prepare(
          `INSERT INTO memory_revisions (
             id, memory_id, revision_number, change_type, previous_state,
             new_state, reason, actor, created_at
           ) VALUES ('memory-revision-decay-link-disable', 'memory-decay-link',
             2, 'disable', '{}', '{}', 'maintenance_apply', 'owner', ?)`,
        ).run(BASE_TIME + 20);
        db.prepare(
          `INSERT INTO memory_maintenance_proposal_revisions (
             id, proposal_id, proposal_kind, revision_number, transition,
             previous_state, new_state, actor_user_id, actor_class,
             invocation_context, reason_code, audit_id, created_at
           ) VALUES ('proposal-revision-decay-link-3', 'proposal-decay-link',
             'decay', 3, 'apply', 'approved', 'applied', 'user-reviewer',
             'owner', 'admin_cli', 'effect_applied', ?, ?)`,
        ).run(applyAuditId, BASE_TIME + 20);
        db.prepare(
          `INSERT INTO memory_maintenance_proposal_revision_effects (
             proposal_revision_id, proposal_id, proposal_kind, transition,
             memory_id, effect_role, memory_revision_id
           ) VALUES ('proposal-revision-decay-link-3', 'proposal-decay-link',
             'decay', 'apply', 'memory-decay-link', 'disabled',
             'memory-revision-decay-link-disable')`,
        ).run();
      }).immediate();

      expect(db.prepare(
        `SELECT p.lifecycle_state, p.current_revision_number, r.transition,
                e.memory_id, e.effect_role, e.memory_revision_id
           FROM memory_maintenance_proposals p
           JOIN memory_maintenance_proposal_revisions r
             ON r.proposal_id = p.id AND r.revision_number = p.current_revision_number
           JOIN memory_maintenance_proposal_revision_effects e
             ON e.proposal_revision_id = r.id
          WHERE p.id = 'proposal-decay-link'`,
      ).get()).toEqual({
        lifecycle_state: 'applied',
        current_revision_number: 3,
        transition: 'apply',
        memory_id: 'memory-decay-link',
        effect_role: 'disabled',
        memory_revision_id: 'memory-revision-decay-link-disable',
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects malformed boundaries, effects, candidates, reasons, and revisions atomically', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      seedMemory(db, 'memory-invalid-a', { sourceSuffix: 'invalid-a' });
      seedMemory(db, 'memory-invalid-b', { sourceSuffix: 'invalid-b' });

      expect(() => insertProposal(db, {
        id: 'proposal-invalid-owner',
        kind: 'decay',
        scope: 'user',
        groupId: null,
        effectMemoryId: 'memory-invalid-a',
        effectMemoryRole: 'disable_target',
        candidates: [candidate('memory-invalid-a', 'disable_target', 'a', '1')],
        reasons: ['stale'],
      })).toThrow();
      expect(() => insertProposal(db, {
        id: 'proposal-invalid-effect',
        kind: 'conflict',
        effectMemoryId: 'memory-invalid-a',
        effectMemoryRole: 'retained',
        candidates: [candidate('memory-invalid-a', 'conflict_candidate', 'a', '1')],
        reasons: ['same_boundary_title_different_content'],
      })).toThrow();
      expect(() => insertProposal(db, {
        id: 'proposal-invalid-target',
        kind: 'consolidation',
        effectMemoryId: 'memory-invalid-b',
        effectMemoryRole: 'retained',
        candidates: [candidate('memory-invalid-a', 'retained', 'a', '1')],
        reasons: ['same_boundary_title_and_content'],
      })).toThrow();
      expect(() => insertProposal(db, {
        id: 'proposal-invalid-role',
        kind: 'decay',
        effectMemoryId: 'memory-invalid-a',
        effectMemoryRole: 'disable_target',
        candidates: [candidate('memory-invalid-a', 'conflict_candidate', 'a', '1')],
        reasons: ['stale'],
      })).toThrow();
      expect(() => insertProposal(db, {
        id: 'proposal-invalid-reason',
        kind: 'decay',
        effectMemoryId: 'memory-invalid-a',
        effectMemoryRole: 'disable_target',
        candidates: [candidate('memory-invalid-a', 'disable_target', 'a', '1')],
        reasons: ['same_boundary_title_and_content'],
      })).toThrow();
      expect(() => insertProposal(db, {
        id: 'proposal-invalid-hash',
        kind: 'decay',
        effectMemoryId: 'memory-invalid-a',
        effectMemoryRole: 'disable_target',
        candidates: [{
          ...candidate('memory-invalid-a', 'disable_target', 'a', '1'),
          recordFingerprint: 'not-a-sha256',
        }],
        reasons: ['stale'],
      })).toThrow();

      insertProposal(db, {
        id: 'proposal-valid-before-invalid-transition',
        kind: 'decay',
        effectMemoryId: 'memory-invalid-a',
        effectMemoryRole: 'disable_target',
        candidates: [candidate('memory-invalid-a', 'disable_target', 'a', '1')],
        reasons: ['stale'],
      });
      const invalidAuditId = seedAudit(
        db,
        'audit-invalid-transition',
        'memory.maintenance.applied',
      );
      expect(() => db.prepare(
        `INSERT INTO memory_maintenance_proposal_revisions (
           id, proposal_id, proposal_kind, revision_number, transition,
           previous_state, new_state, actor_class, invocation_context,
           reason_code, audit_id, created_at
         ) VALUES ('invalid-transition', 'proposal-valid-before-invalid-transition',
           'decay', 2, 'apply', 'pending_review', 'applied', 'owner',
           'admin_cli', 'invalid_direct_apply', ?, ?)`,
      ).run(invalidAuditId, BASE_TIME + 10)).toThrow();

      expect(db.prepare(
        `SELECT id FROM memory_maintenance_proposals
          WHERE id LIKE 'proposal-invalid-%' ORDER BY id`,
      ).all()).toEqual([]);
      expect(db.prepare(
        `SELECT lifecycle_state, current_revision_number
           FROM memory_maintenance_proposals
          WHERE id = 'proposal-valid-before-invalid-transition'`,
      ).get()).toEqual({
        lifecycle_state: 'pending_review',
        current_revision_number: 1,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('rolls the v8 migration back to the exact populated v7 input on object conflict', () => {
    const db = openDatabase();
    try {
      migrateToV7(db);
      seedMemory(db, 'memory-v7-atomic', { sourceSuffix: 'atomic' });
      db.exec('CREATE TABLE memory_maintenance_proposals (legacy_value TEXT)');
      const ledgerBefore = db.prepare(
        `SELECT version, description, applied_at
           FROM schema_version ORDER BY version`,
      ).all();
      const schemaBefore = db.prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      ).all();

      expect(() => runMigrations(db, migrationDirectory)).toThrow();

      expect(getSchemaVersion(db)).toBe(7);
      expect(db.prepare(
        `SELECT version, description, applied_at
           FROM schema_version ORDER BY version`,
      ).all()).toEqual(ledgerBefore);
      expect(db.prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      ).all()).toEqual(schemaBefore);
      expect(db.prepare(
        `SELECT id FROM memory_records WHERE id = 'memory-v7-atomic'`,
      ).get()).toEqual({ id: 'memory-v7-atomic' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('restores an immutable populated v7 snapshot after a disposable v8 upgrade', async () => {
    const root = createTemporaryRoot();
    const databasePath = join(root, 'shared.db');
    const backupPath = join(root, 'pre-v8.backup.db');
    const source = initDatabase({ path: databasePath });
    try {
      migrateToV7(source);
      seedMemory(source, 'memory-v7-rollback', { sourceSuffix: 'rollback' });
      const backup = await backupSqliteDatabase({ sourcePath: databasePath, backupPath });
      expect(backup).toMatchObject({ integrityOk: true, remainingPages: 0 });
    } finally {
      closeDatabase(source);
    }

    const candidate = initDatabase({ path: databasePath });
    try {
      runMigrations(candidate, migrationDirectory);
      expect(getSchemaVersion(candidate)).toBe(8);
      seedAudit(candidate, 'audit-v8-rollback-proposal', 'memory.maintenance.proposed');
      insertProposal(candidate, {
        id: 'proposal-v8-rollback',
        kind: 'decay',
        effectMemoryId: 'memory-v7-rollback',
        effectMemoryRole: 'disable_target',
        candidates: [candidateFixture(
          'memory-v7-rollback',
          'disable_target',
          'a',
          '1',
        )],
        reasons: ['stale'],
      });
    } finally {
      closeDatabase(candidate);
    }

    const restore = restoreSqliteDatabase({
      backupPath,
      targetPath: databasePath,
      overwrite: true,
    });
    expect(restore).toMatchObject({ integrityOk: true, foreignKeyViolations: 0 });

    const rolledBack = initDatabase({ path: databasePath, readonly: true });
    try {
      expect(getSchemaVersion(rolledBack)).toBe(7);
      expect(rolledBack.prepare(
        `SELECT id FROM memory_records WHERE id = 'memory-v7-rollback'`,
      ).get()).toEqual({ id: 'memory-v7-rollback' });
      expect(rolledBack.prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name LIKE 'memory_maintenance_%'`,
      ).all()).toEqual([]);
      expect(rolledBack.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(rolledBack.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(rolledBack);
    }
  });
});

function openDatabase(): Database.Database {
  const root = createTemporaryRoot();
  return initDatabase({ path: join(root, 'test.db') });
}

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-schema-v8-'));
  temporaryRoots.push(root);
  return root;
}

function migrateToV7(db: Database.Database): void {
  runMigration(db, join(migrationDirectory, '001_initial_schema.sql'));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const [version, fileName, description] of [
        [2, '002_evaluator_authority_ownership.sql', 'Evaluator authority ownership'],
        [3, '003_evaluator_model_invocations.sql', 'Evaluator model invocations'],
        [4, '004_evaluator_correction_attempts.sql', 'Evaluator correction attempts'],
        [5, '005_delayed_attention.sql', 'Delayed attention'],
        [6, '006_group_summary_policy.sql', 'Group summary policy'],
        [7, '007_pi_turn_model_invocations.sql', 'Pi turn model invocations'],
      ] as const) {
        db.exec(readFileSync(join(migrationDirectory, fileName), 'utf8'));
        recordSchemaVersion(db, version, description);
      }
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seedCanonicalUser(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO canonical_users (id, created_at, last_seen_at)
     VALUES (?, ?, ?)`,
  ).run(id, BASE_TIME, BASE_TIME);
}

function seedMemory(
  db: Database.Database,
  id: string,
  input: { sourceSuffix: string },
): void {
  const rawEventId = `raw-${input.sourceSuffix}`;
  db.prepare(
    `INSERT INTO raw_events (
       id, type, timestamp, source, platform, conversation_id, payload, created_at
     ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq',
       'group:maintenance', '{}', ?)`,
  ).run(rawEventId, BASE_TIME, BASE_TIME);
  db.prepare(
    `INSERT INTO memory_records (
       id, scope, group_id, conversation_id, visibility, sensitivity,
       authority, kind, title, content, state, confidence, importance,
       created_at, updated_at
     ) VALUES (?, 'group', 'group-maintenance', 'group:maintenance',
       'same_group_only', 'normal', 'user_stated', 'fact', 'fixture title',
       'fixture content', 'active', 0.8, 0.7, ?, ?)`,
  ).run(id, BASE_TIME, BASE_TIME);
  db.prepare(
    `INSERT INTO memory_sources (
       memory_id, source_type, source_id, source_timestamp, extracted_by,
       resolution_state, raw_event_id
     ) VALUES (?, 'raw_event', ?, ?, 'fixture', 'internal', ?)`,
  ).run(id, rawEventId, BASE_TIME, rawEventId);
  db.prepare(
    `INSERT INTO memory_revisions (
       id, memory_id, revision_number, change_type, previous_state, new_state,
       reason, actor, created_at
     ) VALUES (?, ?, 1, 'create', NULL, '{}', 'fixture_create', 'system_worker', ?)`,
  ).run(`revision-${id}-1`, id, BASE_TIME);
}

function seedAudit(db: Database.Database, id: string, eventType: string): string {
  db.prepare(
    `INSERT INTO audit_log (
       id, timestamp, category, level, event_type, event_id, actor_class,
       invocation_context, summary, details, redacted, risk_level
     ) VALUES (?, ?, 'memory', 'redacted_full', ?, ?, 'system_worker',
       'background_worker', 'fixture audit', '{}', 1, 'medium')`,
  ).run(id, BASE_TIME, eventType, id);
  return id;
}

function candidate(
  memoryId: string,
  role: CandidateRole,
  recordHashCharacter: string,
  sourceHashCharacter: string,
): ProposalCandidateFixture {
  return candidateFixture(
    memoryId,
    role,
    recordHashCharacter,
    sourceHashCharacter,
  );
}

function candidateFixture(
  memoryId: string,
  role: CandidateRole,
  recordHashCharacter: string,
  sourceHashCharacter: string,
): ProposalCandidateFixture {
  return {
    memoryId,
    role,
    recordFingerprint: recordHashCharacter.repeat(64),
    sourceCount: 1,
    sourceFingerprint: sourceHashCharacter.repeat(64),
  };
}

function insertProposal(db: Database.Database, input: {
  id: string;
  kind: ProposalKind;
  scope?: string;
  canonicalUserId?: string | null;
  groupId?: string | null;
  conversationId?: string | null;
  effectMemoryId?: string | null;
  effectMemoryRole?: CandidateRole | null;
  candidates: ProposalCandidateFixture[];
  reasons: string[];
}): void {
  const auditId = `audit-${input.id}`;
  const effectType = input.kind === 'conflict'
    ? 'resolve_conflict'
    : input.kind === 'consolidation'
      ? 'consolidate'
      : 'disable';

  db.transaction(() => {
    seedAudit(db, auditId, 'memory.maintenance.proposed');
    db.prepare(
      `INSERT INTO memory_maintenance_proposals (
         id, kind, effect_type, lifecycle_state, scope, canonical_user_id,
         group_id, conversation_id, subject_user_id, candidate_fingerprint,
         confidence, effect_memory_id, effect_memory_role,
         current_revision_number, created_at, updated_at, expires_at,
         created_audit_id
       ) VALUES (?, ?, ?, 'pending_review', ?, ?, ?, ?, NULL, ?, 0.8, ?, ?,
         1, ?, ?, NULL, ?)`,
    ).run(
      input.id,
      input.kind,
      effectType,
      input.scope ?? 'group',
      input.canonicalUserId ?? null,
      input.groupId === undefined ? 'group-maintenance' : input.groupId,
      input.conversationId === undefined ? 'group:maintenance' : input.conversationId,
      'f'.repeat(64),
      input.effectMemoryId ?? null,
      input.effectMemoryRole ?? null,
      BASE_TIME,
      BASE_TIME,
      auditId,
    );
    for (const [ordinal, fixture] of input.candidates.entries()) {
      db.prepare(
        `INSERT INTO memory_maintenance_proposal_candidates (
           proposal_id, proposal_kind, candidate_ordinal, memory_id,
           effect_role, expected_state, record_fingerprint, source_count,
           source_fingerprint
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).run(
        input.id,
        input.kind,
        ordinal,
        fixture.memoryId,
        fixture.role,
        fixture.recordFingerprint,
        fixture.sourceCount ?? 0,
        fixture.sourceFingerprint,
      );
    }
    for (const [ordinal, reason] of input.reasons.entries()) {
      db.prepare(
        `INSERT INTO memory_maintenance_proposal_reasons (
           proposal_id, proposal_kind, reason_ordinal, reason_code
         ) VALUES (?, ?, ?, ?)`,
      ).run(input.id, input.kind, ordinal, reason);
    }
    db.prepare(
      `INSERT INTO memory_maintenance_proposal_revisions (
         id, proposal_id, proposal_kind, revision_number, transition,
         previous_state, new_state, actor_user_id, actor_class,
         invocation_context, reason_code, audit_id, created_at
       ) VALUES (?, ?, ?, 1, 'propose', NULL, 'pending_review', NULL,
         'system_worker', 'background_worker', 'scan_detected', ?, ?)`,
    ).run(`proposal-revision-${input.id}-1`, input.id, input.kind, auditId, BASE_TIME);
  }).immediate();
}

function advanceProposal(db: Database.Database, input: {
  proposalId: string;
  kind: ProposalKind;
  revisionNumber: number;
  transition: string;
  previousState: string;
  newState: string;
  actorUserId: string | null;
  actorClass: string;
  invocationContext: string;
  reasonCode: string;
}): void {
  const auditId = seedAudit(
    db,
    `audit-${input.proposalId}-${input.revisionNumber}`,
    `memory.maintenance.${input.transition}`,
  );
  db.transaction(() => {
    db.prepare(
      `UPDATE memory_maintenance_proposals
          SET lifecycle_state = ?, current_revision_number = ?, updated_at = ?
        WHERE id = ? AND lifecycle_state = ?
          AND current_revision_number = ?`,
    ).run(
      input.newState,
      input.revisionNumber,
      BASE_TIME + input.revisionNumber,
      input.proposalId,
      input.previousState,
      input.revisionNumber - 1,
    );
    db.prepare(
      `INSERT INTO memory_maintenance_proposal_revisions (
         id, proposal_id, proposal_kind, revision_number, transition,
         previous_state, new_state, actor_user_id, actor_class,
         invocation_context, reason_code, audit_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `proposal-revision-${input.proposalId}-${input.revisionNumber}`,
      input.proposalId,
      input.kind,
      input.revisionNumber,
      input.transition,
      input.previousState,
      input.newState,
      input.actorUserId,
      input.actorClass,
      input.invocationContext,
      input.reasonCode,
      auditId,
      BASE_TIME + input.revisionNumber,
    );
  }).immediate();
}
