import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
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

interface MemorySourceResolutionRow {
  memory_id: string;
  source_type: string;
  source_id: string;
  resolution_state: string;
  raw_event_id: string | null;
  chat_message_id: string | null;
  tool_call_id: string | null;
  job_id: string | null;
  job_attempt_id: string | null;
}

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

    it.skipIf(process.platform === 'win32')(
      'should create the database and live WAL sidecars with private modes under a permissive umask',
      () => {
        const dbPath = join(testDir, 'private-fresh.db');
        const script = [
          "import { statSync } from 'node:fs';",
          "import { initDatabase, closeDatabase } from './src/storage/database.ts';",
          'process.umask(0o000);',
          'const dbPath = process.argv[1];',
          'const db = initDatabase({ path: dbPath });',
          "db.exec('CREATE TABLE permission_probe (value TEXT)');",
          "db.prepare('INSERT INTO permission_probe VALUES (?)').run('ok');",
          'const mode = (path) => statSync(path).mode & 0o777;',
          "console.log(JSON.stringify({ main: mode(dbPath), wal: mode(`${dbPath}-wal`), shm: mode(`${dbPath}-shm`) }));",
          'closeDatabase(db);',
        ].join('\n');
        const child = spawnSync(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', script, dbPath],
          { cwd: process.cwd(), encoding: 'utf8' },
        );

        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({
          main: 0o600,
          wal: 0o600,
          shm: 0o600,
        });
      },
    );

    it.skipIf(process.platform === 'win32')(
      'should remediate existing writable database and sidecar modes without truncating data',
      () => {
        const dbPath = join(testDir, 'private-existing.db');
        db = initDatabase({ path: dbPath });
        db.exec('CREATE TABLE permission_probe (value TEXT)');
        db.prepare('INSERT INTO permission_probe VALUES (?)').run('kept');
        const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
        paths.forEach((path) => chmodSync(path, 0o666));

        const secondHandle = initDatabase({ path: dbPath });
        try {
          expect(paths.map((path) => statSync(path).mode & 0o777))
            .toEqual([0o600, 0o600, 0o600]);
          expect(
            secondHandle.prepare('SELECT value FROM permission_probe').pluck().get(),
          ).toBe('kept');
        } finally {
          closeDatabase(secondHandle);
        }
      },
    );

    it.skipIf(process.platform === 'win32')(
      'should preserve existing database and sidecar modes when opened readonly',
      () => {
        const dbPath = join(testDir, 'readonly-permissions.db');
        db = initDatabase({ path: dbPath });
        db.exec('CREATE TABLE permission_probe (value TEXT)');
        db.prepare('INSERT INTO permission_probe VALUES (?)').run('kept');
        const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
        paths.forEach((path) => chmodSync(path, 0o666));

        const readonlyDb = initDatabase({ path: dbPath, readonly: true });
        try {
          expect(readonlyDb.prepare('SELECT value FROM permission_probe').pluck().get()).toBe('kept');
          expect(paths.map((path) => statSync(path).mode & 0o777))
            .toEqual([0o666, 0o666, 0o666]);
        } finally {
          closeDatabase(readonlyDb);
        }
      },
    );

    it.skipIf(process.platform === 'win32')(
      'should remediate the real database and sidecars when opened through a symlink',
      () => {
        const targetPath = join(testDir, 'symlink-target.db');
        const linkPath = join(testDir, 'symlink-entry.db');
        db = initDatabase({ path: targetPath });
        db.exec('CREATE TABLE permission_probe (value TEXT)');
        db.prepare('INSERT INTO permission_probe VALUES (?)').run('kept');
        symlinkSync(targetPath, linkPath);
        const targetPaths = [targetPath, `${targetPath}-wal`, `${targetPath}-shm`];
        targetPaths.forEach((path) => chmodSync(path, 0o666));

        const symlinkHandle = initDatabase({ path: linkPath });
        try {
          expect(targetPaths.map((path) => statSync(path).mode & 0o777))
            .toEqual([0o600, 0o600, 0o600]);
          expect(
            symlinkHandle.prepare('SELECT value FROM permission_probe').pluck().get(),
          ).toBe('kept');
        } finally {
          closeDatabase(symlinkHandle);
        }
      },
    );

    it('should not create a missing database when opened readonly', () => {
      const dbPath = join(testDir, 'missing-readonly.db');

      expect(() => initDatabase({ path: dbPath, readonly: true })).toThrow();
      expect(existsSync(dbPath)).toBe(false);
    });

    it('should keep missing writable parent diagnostics bounded', () => {
      const dbPath = join(testDir, 'missing-parent', 'test.db');

      expect(() => initDatabase({ path: dbPath }))
        .toThrow('Cannot open database because the directory does not exist');
      expect(existsSync(dbPath)).toBe(false);
    });

    it.each(['', ':memory:'])('should preserve anonymous database behavior for %j', (path) => {
      db = initDatabase({ path });

      expect(db.memory).toBe(true);
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

    it('should redact verbose SQL console output', () => {
      const dbPath = join(testDir, 'test.db');
      const rawSecret = 'sk-database-verbose-secret-should-not-leak';
      const rawPlatformId = 'qq-1234567890';
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        db = initDatabase({ path: dbPath, verbose: true });
        db.exec(`
          CREATE TABLE verbose_redaction_probe (value TEXT);
          INSERT INTO verbose_redaction_probe (value)
          VALUES ('api_key=${rawSecret} target=${rawPlatformId}');
        `);

        const output = consoleLog.mock.calls
          .map((call) => call.map((value) => String(value)).join(' '))
          .join('\n');

        expect(output).toContain('[REDACTED:api_key_assignment]');
        expect(output).toContain('[REDACTED:platform_id]');
        expect(output).not.toContain(rawSecret);
        expect(output).not.toContain(rawPlatformId);
      } finally {
        consoleLog.mockRestore();
      }
    });

    it('should preserve both markers for adjacent secret/platform verbose SQL output', () => {
      const dbPath = join(testDir, 'test.db');
      const rawAdjacent = 'sk-database-verbose-adjacent-secret-qq-1234567890';
      const rawPlatformId = 'qq-1234567890';
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        db = initDatabase({ path: dbPath, verbose: true });
        db.exec(`
          CREATE TABLE verbose_adjacent_redaction_probe (value TEXT);
          INSERT INTO verbose_adjacent_redaction_probe (value)
          VALUES ('target=${rawAdjacent}');
        `);

        const output = consoleLog.mock.calls
          .map((call) => call.map((value) => String(value)).join(' '))
          .join('\n');

        expect(output).toContain('[REDACTED:openai_like_api_key]');
        expect(output).toContain('[REDACTED:platform_id]');
        expect(output).not.toContain(rawAdjacent);
        expect(output).not.toContain(rawPlatformId);
        expect(output).not.toContain('1234567890');
      } finally {
        consoleLog.mockRestore();
      }
    });

    it('should preserve both markers for assignment-shaped adjacent verbose SQL output', () => {
      const dbPath = join(testDir, 'test.db');
      const rawAdjacent = 'api_key=sk-database-verbose-assignment-secret-qq-1234567890';
      const rawPlatformId = 'qq-1234567890';
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        db = initDatabase({ path: dbPath, verbose: true });
        db.exec(`
          CREATE TABLE verbose_assignment_adjacent_redaction_probe (value TEXT);
          INSERT INTO verbose_assignment_adjacent_redaction_probe (value)
          VALUES ('target=${rawAdjacent}');
        `);

        const output = consoleLog.mock.calls
          .map((call) => call.map((value) => String(value)).join(' '))
          .join('\n');

        expect(output).toContain('[REDACTED:api_key_assignment]');
        expect(output).toContain('[REDACTED:platform_id]');
        expect(output).not.toContain(rawAdjacent);
        expect(output).not.toContain(rawPlatformId);
        expect(output).not.toContain('1234567890');
      } finally {
        consoleLog.mockRestore();
      }
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
    const createVersionLedger = (): void => {
      db.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
      `);
    };

    const createLegacyRawEvents = (): void => {
      db.exec(`
        CREATE TABLE raw_events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('gateway', 'agent', 'tool', 'worker', 'system')),
          platform TEXT,
          conversation_id TEXT,
          correlation_id TEXT,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    };

    const expectSchemaVersionError = (
      action: () => void,
      code: 'malformed-schema-version' | 'future-schema-version' | 'incompatible-schema',
    ): void => {
      let error: unknown;
      try {
        action();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ name: 'SchemaVersionError', code });
    };

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
      expect(tableNames).toContain('privacy_preferences');
      expect(tableNames).toContain('memory_records');
      expect(tableNames).toContain('agent_turns');
      expect(tableNames).toContain('context_traces');
      expect(tableNames).toContain('evaluator_decisions');
      expect(tableNames).toContain('action_decisions');
      expect(tableNames).toContain('audit_log');
      expect(tableNames).toContain('event_processing_failures');
      expect(tableNames).toContain('event_processing_admissions');
      expect(tableNames).toContain('event_ingress_receipts');
      expect(tableNames).toContain('jobs');
      expect(tableNames).toContain('job_attempts');
      expect(tableNames).toContain('worker_heartbeats');

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        'idx_raw_events_platform_event',
        'idx_event_ingress_receipts_raw_event',
        'idx_event_ingress_receipts_disposition',
        'idx_event_processing_admissions_state',
        'idx_memory_sources_source',
        'idx_memory_sources_resolution',
        'idx_memory_sources_raw_event',
        'idx_memory_sources_chat_message',
        'idx_memory_sources_tool_call',
        'idx_memory_sources_job',
        'idx_memory_sources_job_attempt',
        'idx_chat_messages_raw_event',
        'idx_agent_turns_trigger_event',
        'idx_evaluator_decisions_turn',
        'idx_evaluator_decisions_request',
        'idx_action_decisions_evaluator',
        'idx_tool_calls_evaluator',
      ]));

      const rawEventColumns = db.prepare('PRAGMA table_info(raw_events)').all() as Array<{ name: string }>;
      expect(rawEventColumns.map((column) => column.name)).toContain('platform_event_id');

      const admissionColumns = db
        .prepare('PRAGMA table_info(event_processing_admissions)')
        .all() as Array<{ name: string; notnull: number; pk: number }>;
      expect(admissionColumns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'raw_event_id', notnull: 1, pk: 1 }),
        expect.objectContaining({ name: 'state', notnull: 1 }),
        expect.objectContaining({ name: 'accepted_at', notnull: 1 }),
        expect.objectContaining({ name: 'processing_started_at', notnull: 0 }),
        expect.objectContaining({ name: 'finished_at', notnull: 0 }),
        expect.objectContaining({ name: 'reason_code', notnull: 0 }),
      ]));

      const admissionForeignKeys = db
        .prepare('PRAGMA foreign_key_list(event_processing_admissions)')
        .all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
      expect(admissionForeignKeys).toEqual([
        expect.objectContaining({
          table: 'raw_events',
          from: 'raw_event_id',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      ]);

      const actionDecisionColumns = db.prepare('PRAGMA table_info(action_decisions)').all() as Array<{ name: string }>;
      expect(actionDecisionColumns.map((column) => column.name)).toContain('evaluator_decision_id');
      expect(actionDecisionColumns.map((column) => column.name)).toContain('execution_binding');

      const evaluatorDecisionColumns = db
        .prepare('PRAGMA table_info(evaluator_decisions)')
        .all() as Array<{ name: string; notnull: number }>;
      expect(evaluatorDecisionColumns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'tool_name', notnull: 0 }),
      ]));

      const actionDecisionForeignKeys = db.prepare('PRAGMA foreign_key_list(action_decisions)').all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      expect(actionDecisionForeignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'evaluator_decisions',
          from: 'evaluator_decision_id',
          to: 'id',
        }),
      ]));

      const toolCallColumns = db.prepare('PRAGMA table_info(tool_calls)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      expect(toolCallColumns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'evaluator_decision_id', notnull: 0 }),
      ]));

      const toolCallForeignKeys = db.prepare('PRAGMA foreign_key_list(tool_calls)').all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      expect(toolCallForeignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'evaluator_decisions',
          from: 'evaluator_decision_id',
          to: 'id',
          on_delete: 'RESTRICT',
        }),
      ]));

      const memorySourceColumns = db.prepare('PRAGMA table_info(memory_sources)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      expect(memorySourceColumns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'resolution_state',
          notnull: 1,
          dflt_value: "'legacy_unresolved'",
        }),
        expect.objectContaining({ name: 'raw_event_id', notnull: 0 }),
        expect.objectContaining({ name: 'chat_message_id', notnull: 0 }),
        expect.objectContaining({ name: 'tool_call_id', notnull: 0 }),
        expect.objectContaining({ name: 'job_id', notnull: 0 }),
        expect.objectContaining({ name: 'job_attempt_id', notnull: 0 }),
      ]));

      const memorySourceForeignKeys = db.prepare('PRAGMA foreign_key_list(memory_sources)').all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      expect(memorySourceForeignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'raw_events',
          from: 'raw_event_id',
          to: 'id',
          on_delete: 'RESTRICT',
        }),
        expect.objectContaining({
          table: 'chat_messages',
          from: 'chat_message_id',
          to: 'id',
          on_delete: 'RESTRICT',
        }),
        expect.objectContaining({
          table: 'tool_calls',
          from: 'tool_call_id',
          to: 'id',
          on_delete: 'RESTRICT',
        }),
        expect.objectContaining({
          table: 'jobs',
          from: 'job_id',
          to: 'id',
          on_delete: 'RESTRICT',
        }),
        expect.objectContaining({
          table: 'job_attempts',
          from: 'job_attempt_id',
          to: 'id',
          on_delete: 'RESTRICT',
        }),
      ]));
    });

    it('migration should be idempotent', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');

      runMigration(db, migrationPath);
      const firstLedger = db.prepare(
        'SELECT version, description, applied_at FROM schema_version ORDER BY version',
      ).all();
      expect(firstLedger).toEqual([
        expect.objectContaining({
          version: 1,
          description: 'Initial schema',
          applied_at: expect.any(Number),
        }),
      ]);

      expect(() => runMigration(db, migrationPath)).not.toThrow();
      expect(db.prepare(
        'SELECT version, description, applied_at FROM schema_version ORDER BY version',
      ).all()).toEqual(firstLedger);
    });

    it('adopts a legacy database without schema metadata and preserves its data', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      db.exec(`
        CREATE TABLE legacy_sentinel (value TEXT NOT NULL);
        INSERT INTO legacy_sentinel (value) VALUES ('preserved');
      `);

      runMigration(db, migrationPath);

      expect(getSchemaVersion(db)).toBe(1);
      expect(db.prepare('SELECT value FROM legacy_sentinel').get()).toEqual({ value: 'preserved' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('adopts a valid empty schema ledger after all migration work succeeds', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      createVersionLedger();

      runMigration(db, migrationPath);

      expect(db.prepare(
        'SELECT version, description FROM schema_version ORDER BY version',
      ).all()).toEqual([{ version: 1, description: 'Initial schema' }]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rebuilds only known legacy memory constraints and preserves linked rows', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const currentSql = readFileSync(migrationPath, 'utf8');
      const legacySql = currentSql
        .replace(
          "state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'rejected', 'superseded', 'disabled', 'deleted'))",
          "state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'superseded', 'disabled', 'deleted'))",
        )
        .replace(
          "change_type TEXT NOT NULL CHECK(change_type IN ('create', 'update', 'approve', 'reject', 'supersede', 'disable', 'delete', 'restore'))",
          "change_type TEXT NOT NULL CHECK(change_type IN ('create', 'update', 'supersede', 'disable', 'delete', 'restore'))",
        );
      expect(legacySql).not.toBe(currentSql);
      db.exec(legacySql);

      const insertMemory = db.prepare(
        `INSERT INTO memory_records (
          id, scope, visibility, sensitivity, authority, kind,
          title, content, state, confidence, importance, created_at, updated_at
        ) VALUES (?, 'system', 'owner_admin_only', 'normal', 'system', 'fact',
                  ?, ?, ?, 1, 1, 1, 1)`,
      );
      insertMemory.run('legacy-memory', 'legacy title', 'legacy content', 'active');
      const legacyRowId = (db.prepare(
        'SELECT rowid FROM memory_records WHERE id = ?',
      ).get('legacy-memory') as { rowid: number }).rowid;
      db.prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type, new_state, actor, created_at
        ) VALUES (?, ?, 1, 'create', 'active', 'system', 1)`,
      ).run('legacy-revision', 'legacy-memory');
      db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by,
          resolution_state
        ) VALUES (?, 'user_command', 'legacy-command', 1, 'system', 'legacy_unresolved')`,
      ).run('legacy-memory');
      db.prepare(
        'INSERT INTO memory_fts(rowid, title, content) VALUES (?, ?, ?)',
      ).run(legacyRowId, 'legacy title', 'legacy content');

      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE memory_sources_legacy (
          memory_id TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK(source_type IN ('raw_event', 'chat_message', 'tool_output', 'worker_extraction', 'user_command')),
          source_id TEXT NOT NULL,
          source_timestamp INTEGER NOT NULL,
          extracted_by TEXT,
          PRIMARY KEY (memory_id, source_id),
          FOREIGN KEY (memory_id) REFERENCES memory_records(id)
        );
        INSERT INTO memory_sources_legacy (
          memory_id, source_type, source_id, source_timestamp, extracted_by
        )
        SELECT memory_id, source_type, source_id, source_timestamp, extracted_by
          FROM memory_sources;
        DROP TABLE memory_sources;
        ALTER TABLE memory_sources_legacy RENAME TO memory_sources;
      `);
      db.pragma('foreign_keys = ON');

      expect(() => runMigration(db, migrationPath)).not.toThrow();

      expect(getSchemaVersion(db)).toBe(1);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.prepare(
        'SELECT rowid, state FROM memory_records WHERE id = ?',
      ).get('legacy-memory')).toEqual({ rowid: legacyRowId, state: 'active' });
      expect(db.prepare(
        'SELECT change_type FROM memory_revisions WHERE id = ?',
      ).get('legacy-revision')).toEqual({ change_type: 'create' });
      expect(db.prepare(
        `SELECT resolution_state, raw_event_id, chat_message_id, tool_call_id,
                job_id, job_attempt_id
           FROM memory_sources
          WHERE memory_id = ? AND source_id = ?`,
      ).get('legacy-memory', 'legacy-command')).toEqual({
        resolution_state: 'legacy_unresolved',
        raw_event_id: null,
        chat_message_id: null,
        tool_call_id: null,
        job_id: null,
        job_attempt_id: null,
      });
      expect(db.prepare(
        "SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'legacy'",
      ).all()).toEqual([{ rowid: legacyRowId }]);

      expect(() => insertMemory.run(
        'rejected-memory',
        'rejected title',
        'rejected content',
        'rejected',
      )).not.toThrow();
      expect(() => db.prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type, new_state, actor, created_at
        ) VALUES (?, ?, 1, 'reject', 'rejected', 'system', 2)`,
      ).run('rejected-revision', 'rejected-memory')).not.toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects unknown memory constraint drift without leaving foreign keys disabled', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const currentSql = readFileSync(migrationPath, 'utf8');
      const incompatibleSql = currentSql.replace(
        "state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'rejected', 'superseded', 'disabled', 'deleted'))",
        "state TEXT NOT NULL CHECK(state IN ('proposed', 'Active', 'superseded', 'disabled', 'deleted'))",
      );
      expect(incompatibleSql).not.toBe(currentSql);
      db.exec(incompatibleSql);
      const before = db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all();

      expectSchemaVersionError(
        () => runMigration(db, migrationPath),
        'incompatible-schema',
      );

      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(getSchemaVersion(db)).toBe(0);
      expect(db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all()).toEqual(before);
    });

    it('does not erase extra table semantics from a legacy-looking memory table', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const currentSql = readFileSync(migrationPath, 'utf8');
      const legacyWithUniqueTitle = currentSql
        .replace(
          "state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'rejected', 'superseded', 'disabled', 'deleted'))",
          "state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'superseded', 'disabled', 'deleted'))",
        )
        .replace(
          `expires_at INTEGER,

  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)`,
          `expires_at INTEGER,

           UNIQUE(title),
           FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)`,
        );
      expect(legacyWithUniqueTitle).not.toBe(currentSql);
      db.exec(legacyWithUniqueTitle);
      const before = db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all();

      expectSchemaVersionError(
        () => runMigration(db, migrationPath),
        'incompatible-schema',
      );

      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(getSchemaVersion(db)).toBe(0);
      expect(db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all()).toEqual(before);
      expect(db.prepare(
        `SELECT COUNT(*) AS count
           FROM pragma_index_list('memory_records')
          WHERE origin = 'u' AND "unique" = 1`,
      ).get()).toEqual({ count: 1 });
    });

    it('rebuilds a newly created FTS index from existing memory rows', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      db.exec(readFileSync(migrationPath, 'utf8'));
      db.prepare(
        `INSERT INTO memory_records (
          id, scope, visibility, sensitivity, authority, kind,
          title, content, state, confidence, importance, created_at, updated_at
        ) VALUES (?, 'system', 'owner_admin_only', 'normal', 'system', 'fact',
                  ?, ?, 'active', 1, 1, 1, 1)`,
      ).run('pre-fts-memory', 'searchable legacy title', 'searchable legacy content');
      const rowId = (db.prepare(
        'SELECT rowid FROM memory_records WHERE id = ?',
      ).get('pre-fts-memory') as { rowid: number }).rowid;
      db.exec('DROP TABLE memory_fts');

      expect(() => runMigration(db, migrationPath)).not.toThrow();

      expect(getSchemaVersion(db)).toBe(1);
      expect(db.prepare(
        "SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'searchable'",
      ).all()).toEqual([{ rowid: rowId }]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects a future schema before compatibility patches or migration writes', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const now = Date.now();
      createVersionLedger();
      recordSchemaVersion(db, 1, 'Initial schema');
      recordSchemaVersion(db, 2, 'Future schema');
      createLegacyRawEvents();
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('future-sentinel', 'message.private', now, 'gateway', 'qq', 'private:future', '{}', now);

      expectSchemaVersionError(
        () => runMigration(db, migrationPath),
        'future-schema-version',
      );

      const columns = db.prepare('PRAGMA table_info(raw_events)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('platform_event_id');
      expect(db.prepare('SELECT id FROM raw_events').all()).toEqual([{ id: 'future-sentinel' }]);
      expect(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canonical_users'",
      ).get()).toBeUndefined();
      expect(getSchemaVersion(db)).toBe(2);
    });

    it('rejects malformed schema metadata before changing the database', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      db.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          description TEXT NOT NULL
        );
        CREATE TABLE legacy_sentinel (value TEXT NOT NULL);
        INSERT INTO legacy_sentinel (value) VALUES ('unchanged');
      `);
      const before = db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all();

      expectSchemaVersionError(
        () => runMigration(db, migrationPath),
        'malformed-schema-version',
      );

      expect(db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all()).toEqual(before);
      expect(db.prepare('SELECT value FROM legacy_sentinel').get()).toEqual({ value: 'unchanged' });
    });

    it('rejects an incompatible LetheBot-owned legacy table before v1 adoption', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      db.exec(`
        CREATE TABLE raw_events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('gateway', 'agent', 'tool', 'worker', 'system')),
          platform TEXT,
          conversation_id TEXT,
          correlation_id TEXT,
          platform_event_id TEXT,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO raw_events (
          id, type, timestamp, source, payload, created_at
        ) VALUES ('legacy-shape', 'message.private', 'invalid-type', 'gateway', '{}', 1);
      `);
      const before = db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all();

      expectSchemaVersionError(
        () => runMigration(db, migrationPath),
        'incompatible-schema',
      );

      expect(db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all()).toEqual(before);
      expect(db.prepare('SELECT timestamp FROM raw_events').get()).toEqual({
        timestamp: 'invalid-type',
      });
      expect(getSchemaVersion(db)).toBe(0);
    });

    it('rejects an incompatible pre-existing migration index and rolls back', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      createLegacyRawEvents();
      db.exec(`
        ALTER TABLE raw_events ADD COLUMN platform_event_id TEXT;
        CREATE INDEX idx_raw_events_type ON raw_events(timestamp);
      `);
      const before = db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all();

      expectSchemaVersionError(
        () => runMigration(db, migrationPath),
        'incompatible-schema',
      );

      expect(db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all()).toEqual(before);
      expect(getSchemaVersion(db)).toBe(0);
    });

    it('rejects existing foreign-key violations before recording v1', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      runMigration(db, migrationPath);
      db.prepare('DELETE FROM schema_version').run();
      db.pragma('foreign_keys = OFF');
      db.prepare(
        `INSERT INTO event_ingress_receipts (
          id, raw_event_id, transport, disposition, received_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run('invalid-receipt', 'missing-event', 'http', 'accepted', 1);
      db.pragma('foreign_keys = ON');

      expectSchemaVersionError(
        () => runMigration(db, migrationPath),
        'incompatible-schema',
      );

      expect(getSchemaVersion(db)).toBe(0);
      expect(db.prepare('SELECT id FROM event_ingress_receipts').all()).toEqual([
        { id: 'invalid-receipt' },
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(1);
    });

    it('rolls back compatibility patches and migration DDL when v1 adoption fails', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      createVersionLedger();
      createLegacyRawEvents();
      db.exec(`
        CREATE TRIGGER reject_schema_adoption
        BEFORE INSERT ON schema_version
        BEGIN
          SELECT RAISE(ABORT, 'synthetic schema adoption failure');
        END
      `);
      const before = db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all();

      expect(() => runMigration(db, migrationPath)).toThrow('synthetic schema adoption failure');

      expect(db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all()).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_version').get()).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('upgrades an existing raw event schema before creating ingress replay indexes', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const now = Date.now();
      db.exec(`
        CREATE TABLE raw_events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('gateway', 'agent', 'tool', 'worker', 'system')),
          platform TEXT,
          conversation_id TEXT,
          correlation_id TEXT,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('legacy-ingress-event', 'chat.message.received', now, 'gateway', 'qq', 'private:legacy', '{}', now);

      expect(() => runMigration(db, migrationPath)).not.toThrow();
      expect(() => runMigration(db, migrationPath)).not.toThrow();

      const columns = db.prepare('PRAGMA table_info(raw_events)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('platform_event_id');
      expect(
        db.prepare('SELECT platform_event_id FROM raw_events WHERE id = ?').get('legacy-ingress-event')
      ).toEqual({ platform_event_id: null });

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='raw_events'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain('idx_raw_events_platform_event');

      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id,
          platform_event_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'canonical-ingress-event',
        'chat.message.received',
        now,
        'gateway',
        'qq',
        'private:qq-812345101',
        'qq-812345001',
        '{}',
        now,
      );
      expect(() => db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id,
          platform_event_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'duplicate-ingress-event',
        'chat.message.received',
        now,
        'gateway',
        'qq',
        'private:qq-812345101',
        'qq-812345001',
        '{}',
        now,
      )).toThrow();

      expect(() => db.prepare(
        `INSERT INTO event_ingress_receipts (
          id, raw_event_id, transport, disposition, received_at
        ) VALUES (?, ?, ?, ?, ?)`
      ).run('missing-event-receipt', 'missing-event', 'http', 'accepted', now)).toThrow();
      db.prepare(
        `INSERT INTO event_ingress_receipts (
          id, raw_event_id, transport, disposition, received_at
        ) VALUES (?, ?, ?, ?, ?)`
      ).run('canonical-event-receipt', 'canonical-ingress-event', 'http', 'accepted', now);

      db.prepare('DELETE FROM raw_events WHERE id = ?').run('canonical-ingress-event');
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM event_ingress_receipts WHERE id = ?')
          .get('canonical-event-receipt')
      ).toEqual({ count: 0 });
      expect(() => db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id,
          platform_event_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'reclaimed-ingress-event',
        'chat.message.received',
        now,
        'gateway',
        'qq',
        'private:qq-812345101',
        'qq-812345001',
        '{}',
        now,
      )).not.toThrow();

      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('upgrades the legacy jobs schema before creating current worker indexes', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const scheduledAt = 1_700_000_000_000;
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          scheduled_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          error TEXT,
          result TEXT
        );
      `);
      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          scheduled_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('legacy-job', 'summary', '{}', 'pending', 0, 3, scheduledAt, null, null);
      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          scheduled_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'legacy-completed-job',
        'summary',
        '{}',
        'completed',
        1,
        3,
        scheduledAt,
        scheduledAt + 100,
        scheduledAt + 200,
      );

      expect(() => runMigration(db, migrationPath)).not.toThrow();
      expect(() => runMigration(db, migrationPath)).not.toThrow();

      const columns = db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'idempotency_key',
        'lease_owner',
        'lease_expires_at',
        'heartbeat_at',
        'created_at',
        'updated_at',
      ]));
      expect(
        db.prepare(
          `SELECT id, status, idempotency_key, lease_owner, lease_expires_at,
                  heartbeat_at, created_at, updated_at
             FROM jobs
            WHERE id = ?`
        ).get('legacy-job')
      ).toEqual({
        id: 'legacy-job',
        status: 'pending',
        idempotency_key: null,
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        created_at: scheduledAt,
        updated_at: scheduledAt,
      });
      expect(
        db.prepare(
          `SELECT created_at, updated_at
             FROM jobs
            WHERE id = ?`
        ).get('legacy-completed-job')
      ).toEqual({
        created_at: scheduledAt,
        updated_at: scheduledAt + 200,
      });
      expect(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_idempotency_key'"
        ).get()
      ).toEqual({ name: 'idx_jobs_idempotency_key' });
      expect(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('job_attempts', 'worker_heartbeats') ORDER BY name"
        ).all()
      ).toEqual([
        { name: 'job_attempts' },
        { name: 'worker_heartbeats' },
      ]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });

    it('adds admission storage without backfilling a realistic legacy database', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const now = Date.now();
      runMigration(db, migrationPath);

      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id,
          platform_event_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'legacy-admission-raw-event',
        'chat.message.received',
        now,
        'gateway',
        'qq',
        'private:legacy-admission',
        'qq-legacy-admission-event',
        '{}',
        now,
      );
      db.prepare(
        `INSERT INTO event_ingress_receipts (
          id, raw_event_id, transport, disposition, received_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'legacy-admission-receipt',
        'legacy-admission-raw-event',
        'http',
        'accepted',
        now,
      );
      db.exec('DROP TABLE event_processing_admissions');

      expect(() => runMigration(db, migrationPath)).not.toThrow();
      expect(() => runMigration(db, migrationPath)).not.toThrow();

      expect(
        db.prepare('SELECT COUNT(*) AS count FROM event_processing_admissions').get(),
      ).toEqual({ count: 0 });
      expect(
        db.prepare('SELECT raw_event_id, disposition FROM event_ingress_receipts WHERE id = ?')
          .get('legacy-admission-receipt'),
      ).toEqual({ raw_event_id: 'legacy-admission-raw-event', disposition: 'accepted' });
      expect(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_event_processing_admissions_state'",
        ).get(),
      ).toEqual({ name: 'idx_event_processing_admissions_state' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should add action execution job and memory linkage when rerun on an existing v1 schema', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      runMigration(db, migrationPath);

      db.exec(`
        ALTER TABLE action_executions RENAME TO action_executions_with_job_link;
        DROP TABLE action_executions_with_job_link;
        CREATE TABLE action_executions (
          id TEXT PRIMARY KEY,
          action_decision_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('success', 'downgraded', 'failed', 'rejected')),
          executed_message_id TEXT,
          downgraded_from TEXT,
          downgraded_reason TEXT,
          error_code TEXT,
          error_message TEXT,
          audit_level TEXT NOT NULL CHECK(audit_level IN ('none', 'summary', 'redacted_full', 'full')),
          audit_entry TEXT,
          executed_at INTEGER NOT NULL,
          FOREIGN KEY (action_decision_id) REFERENCES action_decisions(id)
        );
        CREATE INDEX idx_action_executions_decision ON action_executions(action_decision_id);
      `);

      const beforeColumns = db.prepare('PRAGMA table_info(action_executions)').all() as Array<{ name: string }>;
      expect(beforeColumns.map((column) => column.name)).not.toContain('executed_job_id');
      expect(beforeColumns.map((column) => column.name)).not.toContain('executed_memory_id');

      expect(() => runMigration(db, migrationPath)).not.toThrow();

      const afterColumns = db.prepare('PRAGMA table_info(action_executions)').all() as Array<{ name: string }>;
      expect(afterColumns.map((column) => column.name)).toContain('executed_job_id');
      expect(afterColumns.map((column) => column.name)).toContain('executed_memory_id');

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='action_executions' AND name NOT LIKE 'sqlite_%'"
        )
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain('idx_action_executions_job');
      expect(indexes.map((index) => index.name)).toContain('idx_action_executions_memory');

      const now = Date.now();
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('evt-job-link-migration', 'message.private', now, 'gateway', 'qq', 'private:migration', '{}', now);
      db.prepare(
        `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('turn-job-link-migration', 'private:migration', 'evt-job-link-migration', 'mock', 'mock', 'completed', now);
      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-job-link-migration',
        'turn-job-link-migration',
        'pi',
        'low',
        0.9,
        0,
        '[]',
        '[]',
        '[]',
        now
      );
      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts, created_at, updated_at, scheduled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('job-link-migration', 'admin_digest', '{}', 'pending', 0, 2, now, now, now);
      db.prepare(
        `INSERT INTO memory_records (
          id, scope, visibility, sensitivity, authority, kind, title, content,
          state, confidence, importance, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'mem-link-migration',
        'global',
        'owner_admin_only',
        'normal',
        'inferred',
        'summary',
        'Migration linked memory',
        'Migration linked proposed memory',
        'proposed',
        0.8,
        0.5,
        now,
        now
      );
      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status,
          executed_memory_id, executed_job_id, audit_level, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'execution-link-migration',
        'decision-job-link-migration',
        'admin_digest',
        'success',
        'mem-link-migration',
        'job-link-migration',
        'summary',
        now
      );

      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('adds evaluator decision linkage idempotently to an existing action schema', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const now = Date.now();
      runMigration(db, migrationPath);

      db.exec(`
        DROP TABLE action_executions;
        ALTER TABLE action_decisions RENAME TO action_decisions_with_evaluator_link;
        DROP TABLE action_decisions_with_evaluator_link;
        DROP TABLE evaluator_decisions;
        CREATE TABLE action_decisions (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          decided_by TEXT NOT NULL CHECK(decided_by IN ('attention', 'pi', 'evaluator')),
          risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'prohibited')),
          confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
          evaluator_required INTEGER NOT NULL DEFAULT 0,
          evaluator_passed INTEGER,
          actions TEXT NOT NULL,
          reasons TEXT,
          suppressors TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
        );
        CREATE INDEX idx_action_decisions_turn ON action_decisions(turn_id);
        CREATE TABLE action_executions (
          id TEXT PRIMARY KEY,
          action_decision_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('success', 'downgraded', 'failed', 'rejected')),
          executed_message_id TEXT,
          downgraded_from TEXT,
          downgraded_reason TEXT,
          error_code TEXT,
          error_message TEXT,
          audit_level TEXT NOT NULL CHECK(audit_level IN ('none', 'summary', 'redacted_full', 'full')),
          audit_entry TEXT,
          executed_at INTEGER NOT NULL,
          FOREIGN KEY (action_decision_id) REFERENCES action_decisions(id)
        );
        CREATE INDEX idx_action_executions_decision ON action_executions(action_decision_id);
      `);
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('evt-evaluator-link-migration', 'message.private', now, 'gateway', 'qq', 'private:migration', '{}', now);
      db.prepare(
        `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('turn-evaluator-link-migration', 'private:migration', 'evt-evaluator-link-migration', 'mock', 'mock', 'completed', now);
      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-evaluator-link-migration',
        'turn-evaluator-link-migration',
        'pi',
        'low',
        0.9,
        0,
        '[]',
        '[]',
        '[]',
        now,
      );
      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status, executed_message_id,
          audit_level, audit_entry, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'execution-evaluator-link-migration',
        'decision-evaluator-link-migration',
        'reply_short',
        'success',
        'legacy-message-id',
        'summary',
        'legacy execution preserved',
        now,
      );

      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evaluator_decisions'").get()
      ).toBeUndefined();

      expect(() => runMigration(db, migrationPath)).not.toThrow();
      expect(() => runMigration(db, migrationPath)).not.toThrow();

      const columns = db.prepare('PRAGMA table_info(action_decisions)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('evaluator_decision_id');
      expect(columns.map((column) => column.name)).toContain('execution_binding');
      expect(
        db.prepare('SELECT evaluator_decision_id, execution_binding FROM action_decisions WHERE id = ?')
          .get('decision-evaluator-link-migration')
      ).toEqual({ evaluator_decision_id: null, execution_binding: null });
      expect(
        db.prepare('SELECT status, executed_message_id FROM action_executions WHERE id = ?')
          .get('execution-evaluator-link-migration')
      ).toEqual({ status: 'success', executed_message_id: 'legacy-message-id' });

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='action_decisions'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain('idx_action_decisions_evaluator');

      const foreignKeys = db.prepare('PRAGMA foreign_key_list(action_decisions)').all() as Array<{
        table: string;
        from: string;
      }>;
      expect(foreignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'evaluator_decisions', from: 'evaluator_decision_id' }),
      ]));

      expect(() => db.prepare(
        'UPDATE action_decisions SET evaluator_decision_id = ? WHERE id = ?'
      ).run('missing-evaluator-decision', 'decision-evaluator-link-migration')).toThrow();

      db.prepare(
        `INSERT INTO evaluator_decisions (
          id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
          evaluator_version, actor_user_id, actor_class, invocation_context,
          source_event_ids, request_created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'eval-evaluator-link-migration',
        'request-evaluator-link-migration',
        'social',
        'turn-evaluator-link-migration',
        'approve',
        'approved',
        0.9,
        'low',
        'migration-test',
        null,
        'user',
        'private_chat',
        JSON.stringify(['evt-evaluator-link-migration']),
        now,
        now,
      );
      expect(() => db.prepare(
        'UPDATE action_decisions SET evaluator_decision_id = ? WHERE id = ?'
      ).run('eval-evaluator-link-migration', 'decision-evaluator-link-migration')).not.toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('adds restrictive evaluator linkage idempotently to an existing tool call schema', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const now = Date.now();
      db.exec(`
        CREATE TABLE raw_events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('gateway', 'agent', 'tool', 'worker', 'system')),
          platform TEXT,
          conversation_id TEXT,
          correlation_id TEXT,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE agent_turns (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          trigger_event_id TEXT NOT NULL,
          context_pack_id TEXT,
          pi_model TEXT NOT NULL,
          pi_provider TEXT NOT NULL,
          action_decision_id TEXT,
          response_text TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'aborted')),
          tokens_input INTEGER,
          tokens_output INTEGER,
          tokens_total INTEGER,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          FOREIGN KEY (trigger_event_id) REFERENCES raw_events(id)
        );
        CREATE TABLE tool_calls (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          input TEXT NOT NULL,
          output TEXT,
          requested_by TEXT NOT NULL CHECK(requested_by IN ('pi', 'evaluator', 'user', 'system')),
          actor_user_id TEXT,
          actor_class TEXT NOT NULL,
          invocation_context TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('success', 'error', 'timeout', 'rejected')),
          error_code TEXT,
          error_message TEXT,
          execution_time_ms INTEGER,
          secrets_redacted INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
        );
      `);
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('evt-tool-link-migration', 'message.private', now, 'gateway', 'qq', 'private:migration', '{}', now);
      db.prepare(
        `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('turn-tool-link-migration', 'private:migration', 'evt-tool-link-migration', 'mock', 'mock', 'completed', now);
      db.prepare(
        `INSERT INTO tool_calls (
          id, turn_id, tool_name, input, output, requested_by, actor_class,
          invocation_context, status, execution_time_ms, secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'tool-call-link-migration',
        'turn-tool-link-migration',
        'legacy.tool',
        '{}',
        '{"ok":true}',
        'pi',
        'user',
        'private_chat',
        'success',
        10,
        0,
        now,
      );

      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evaluator_decisions'").get()
      ).toBeUndefined();

      expect(() => runMigration(db, migrationPath)).not.toThrow();
      expect(() => runMigration(db, migrationPath)).not.toThrow();

      expect(
        db.prepare('SELECT status, output, evaluator_decision_id FROM tool_calls WHERE id = ?')
          .get('tool-call-link-migration')
      ).toEqual({ status: 'success', output: '{"ok":true}', evaluator_decision_id: null });
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_calls'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain('idx_tool_calls_evaluator');

      const foreignKeys = db.prepare('PRAGMA foreign_key_list(tool_calls)').all() as Array<{
        table: string;
        from: string;
        on_delete: string;
      }>;
      expect(foreignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'evaluator_decisions',
          from: 'evaluator_decision_id',
          on_delete: 'RESTRICT',
        }),
      ]));
      expect(() => db.prepare(
        'UPDATE tool_calls SET evaluator_decision_id = ? WHERE id = ?'
      ).run('missing-evaluator-decision', 'tool-call-link-migration')).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('backfills resolvable legacy memory sources without discarding unresolved provenance', () => {
      const migrationPath = join(__dirname, '../../../migrations/001_initial_schema.sql');
      const now = Date.now();
      runMigration(db, migrationPath);

      db.exec(`
        DROP TABLE memory_sources;
        CREATE TABLE memory_sources (
          memory_id TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK(source_type IN (
            'raw_event', 'chat_message', 'tool_output', 'worker_extraction', 'user_command'
          )),
          source_id TEXT NOT NULL,
          source_timestamp INTEGER NOT NULL,
          extracted_by TEXT,
          PRIMARY KEY (memory_id, source_id),
          FOREIGN KEY (memory_id) REFERENCES memory_records(id)
        );
      `);

      for (const id of [
        'raw-source-id',
        'raw-chat-exact',
        'raw-chat-alias',
        'raw-chat-ambiguous-a',
        'raw-chat-ambiguous-b',
        'raw-tool-turn',
        'raw-tool-unsuccessful',
        'raw-unrelated-id',
      ]) {
        insertMemorySourceRawEvent(db, id, now);
      }

      insertMemorySourceChatMessage(db, 'chat-source-id', 'raw-chat-exact', 'platform-chat-exact', now);
      insertMemorySourceChatMessage(db, 'chat-alias-id', 'raw-chat-alias', 'platform-chat-alias', now);
      for (const suffix of ['a', 'b']) {
        insertMemorySourceChatMessage(
          db,
          `chat-ambiguous-${suffix}`,
          `raw-chat-ambiguous-${suffix}`,
          'platform-chat-ambiguous',
          now,
        );
      }

      insertMemorySourceToolCall(db, 'tool-source-id', 'raw-tool-turn', now);
      insertMemorySourceToolCall(db, 'tool-unsuccessful-id', 'raw-tool-unsuccessful', now);
      db.prepare('UPDATE tool_calls SET status = ? WHERE id = ?').run('error', 'tool-unsuccessful-id');
      for (const id of [
        'job-source-id',
        'attempt-parent-job',
        'worker-collision',
        'collision-attempt-parent',
        'job-wrong-type',
        'job-wrong-status',
        'job-worker-only',
        'job-unrelated-evidence',
        'attempt-wrong-status-parent',
        'attempt-parent-wrong-status',
      ]) {
        insertMemorySourceJob(db, id, now);
      }
      insertMemorySourceJobAttempt(db, 'attempt-source-id', 'attempt-parent-job', now);
      insertMemorySourceJobAttempt(db, 'worker-collision', 'collision-attempt-parent', now);
      insertMemorySourceJobAttempt(db, 'attempt-wrong-status', 'attempt-wrong-status-parent', now);
      insertMemorySourceJobAttempt(db, 'attempt-parent-failed', 'attempt-parent-wrong-status', now);

      const updateJob = db.prepare('UPDATE jobs SET type = ?, status = ?, payload = ?, result = ? WHERE id = ?');
      updateJob.run(
        'extraction',
        'completed',
        JSON.stringify({ nested: { sourceRawEventId: 'raw-source-id' } }),
        null,
        'job-source-id',
      );
      updateJob.run('extraction', 'completed', '{}', null, 'attempt-parent-job');
      updateJob.run('summary', 'completed', JSON.stringify({ sourceRawEventId: 'raw-source-id' }), null, 'job-wrong-type');
      updateJob.run('extraction', 'failed', JSON.stringify({ sourceRawEventId: 'raw-source-id' }), null, 'job-wrong-status');
      updateJob.run('extraction', 'completed', JSON.stringify({ sourceRawEventId: 'raw-source-id' }), null, 'job-worker-only');
      updateJob.run(
        'extraction',
        'completed',
        JSON.stringify({ sourceRawEventId: 'raw-source-id' }),
        null,
        'job-unrelated-evidence',
      );
      updateJob.run(
        'extraction',
        'completed',
        JSON.stringify({ sourceRawEventId: 'raw-source-id' }),
        null,
        'attempt-wrong-status-parent',
      );
      updateJob.run(
        'extraction',
        'failed',
        JSON.stringify({ sourceRawEventId: 'raw-source-id' }),
        null,
        'attempt-parent-wrong-status',
      );
      db.prepare('UPDATE job_attempts SET result = ? WHERE id = ?').run(
        JSON.stringify({ nested: { sourceChatMessageId: ['chat-alias-id'] } }),
        'attempt-source-id',
      );
      db.prepare('UPDATE job_attempts SET status = ?, result = ? WHERE id = ?').run(
        'failed',
        JSON.stringify({ sourceRawEventId: 'raw-source-id' }),
        'attempt-wrong-status',
      );
      db.prepare('UPDATE job_attempts SET result = ? WHERE id = ?').run(
        JSON.stringify({ sourceRawEventId: 'raw-source-id' }),
        'attempt-parent-failed',
      );

      const legacySources: Array<[string, string, string]> = [
        ['mem-legacy-raw', 'raw_event', 'raw-source-id'],
        ['mem-legacy-chat-exact', 'chat_message', 'chat-source-id'],
        ['mem-legacy-chat-alias', 'chat_message', 'platform-chat-alias'],
        ['mem-legacy-chat-ambiguous', 'chat_message', 'platform-chat-ambiguous'],
        ['mem-legacy-tool', 'tool_output', 'tool-source-id'],
        ['mem-tool-unsuccessful', 'tool_output', 'tool-unsuccessful-id'],
        ['mem-legacy-job', 'worker_extraction', 'job-source-id'],
        ['mem-legacy-job', 'raw_event', 'raw-source-id'],
        ['mem-legacy-attempt', 'worker_extraction', 'attempt-source-id'],
        ['mem-legacy-attempt', 'chat_message', 'platform-chat-alias'],
        ['mem-legacy-worker-collision', 'worker_extraction', 'worker-collision'],
        ['mem-worker-wrong-type', 'worker_extraction', 'job-wrong-type'],
        ['mem-worker-wrong-type', 'raw_event', 'raw-source-id'],
        ['mem-worker-wrong-status', 'worker_extraction', 'job-wrong-status'],
        ['mem-worker-wrong-status', 'raw_event', 'raw-source-id'],
        ['mem-worker-only', 'worker_extraction', 'job-worker-only'],
        ['mem-worker-unrelated', 'worker_extraction', 'job-unrelated-evidence'],
        ['mem-worker-unrelated', 'raw_event', 'raw-unrelated-id'],
        ['mem-attempt-wrong-status', 'worker_extraction', 'attempt-wrong-status'],
        ['mem-attempt-wrong-status', 'raw_event', 'raw-source-id'],
        ['mem-attempt-parent-wrong-status', 'worker_extraction', 'attempt-parent-failed'],
        ['mem-attempt-parent-wrong-status', 'raw_event', 'raw-source-id'],
        ['mem-legacy-missing', 'raw_event', 'missing-source-id'],
        ['mem-legacy-user-command', 'user_command', 'admin-command-id'],
        ['mem-post-upgrade-unresolved', 'raw_event', 'missing-post-upgrade'],
      ];
      for (const memoryId of new Set(legacySources.map(([id]) => id))) {
        insertMemorySourceRecord(db, memoryId, now);
      }
      const insertLegacySource = db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [memoryId, sourceType, sourceId] of legacySources.slice(0, -1)) {
        insertLegacySource.run(memoryId, sourceType, sourceId, now, 'legacy-writer');
      }

      expect(() => runMigration(db, migrationPath)).not.toThrow();
      insertLegacySource.run(
        'mem-post-upgrade-unresolved',
        'raw_event',
        'missing-post-upgrade',
        now,
        'legacy-writer',
      );

      const readSources = (): MemorySourceResolutionRow[] => db.prepare(
        `SELECT memory_id, source_type, source_id, resolution_state,
                raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
           FROM memory_sources
          ORDER BY memory_id, source_type, source_id`,
      ).all() as MemorySourceResolutionRow[];
      const afterFirstUpgrade = readSources();
      const sourcesByKey = new Map(
        afterFirstUpgrade.map((row) => [`${row.memory_id}:${row.source_type}`, row]),
      );
      const resolvedSources: Array<[string, string, Partial<MemorySourceResolutionRow>]> = [
        ['mem-legacy-raw', 'raw_event', { resolution_state: 'internal', raw_event_id: 'raw-source-id' }],
        [
          'mem-legacy-chat-exact',
          'chat_message',
          { resolution_state: 'internal', chat_message_id: 'chat-source-id' },
        ],
        [
          'mem-legacy-chat-alias',
          'chat_message',
          {
            resolution_state: 'internal',
            source_id: 'platform-chat-alias',
            chat_message_id: 'chat-alias-id',
          },
        ],
        ['mem-legacy-tool', 'tool_output', { resolution_state: 'internal', tool_call_id: 'tool-source-id' }],
        ['mem-legacy-job', 'worker_extraction', { resolution_state: 'internal', job_id: 'job-source-id' }],
        [
          'mem-legacy-attempt',
          'worker_extraction',
          { resolution_state: 'internal', job_attempt_id: 'attempt-source-id' },
        ],
      ];
      for (const [memoryId, sourceType, expected] of resolvedSources) {
        expect(sourcesByKey.get(`${memoryId}:${sourceType}`)).toMatchObject(expected);
      }
      const unresolvedSourceKeys: Array<[string, string]> = [
        ['mem-legacy-chat-ambiguous', 'chat_message'],
        ['mem-legacy-missing', 'raw_event'],
        ['mem-legacy-user-command', 'user_command'],
        ['mem-legacy-worker-collision', 'worker_extraction'],
        ['mem-tool-unsuccessful', 'tool_output'],
        ['mem-worker-wrong-type', 'worker_extraction'],
        ['mem-worker-wrong-status', 'worker_extraction'],
        ['mem-worker-only', 'worker_extraction'],
        ['mem-worker-unrelated', 'worker_extraction'],
        ['mem-attempt-wrong-status', 'worker_extraction'],
        ['mem-attempt-parent-wrong-status', 'worker_extraction'],
        ['mem-post-upgrade-unresolved', 'raw_event'],
      ];
      for (const [memoryId, sourceType] of unresolvedSourceKeys) {
        const source = sourcesByKey.get(`${memoryId}:${sourceType}`);
        expect(source?.resolution_state).toBe('legacy_unresolved');
        expect([
          source?.raw_event_id,
          source?.chat_message_id,
          source?.tool_call_id,
          source?.job_id,
          source?.job_attempt_id,
        ]).toEqual([null, null, null, null, null]);
      }

      expect(() => runMigration(db, migrationPath)).not.toThrow();
      expect(readSources()).toEqual(afterFirstUpgrade);

      const unresolvedSources = db.prepare(
        `SELECT memory_id, source_type, source_id
           FROM memory_sources
          WHERE resolution_state = 'legacy_unresolved'
          ORDER BY source_type, source_id, memory_id
          LIMIT ?`,
      ).all(100) as Array<{ memory_id: string; source_type: string; source_id: string }>;
      expect(unresolvedSources).toEqual(expect.arrayContaining([
        {
          memory_id: 'mem-legacy-chat-ambiguous',
          source_type: 'chat_message',
          source_id: 'platform-chat-ambiguous',
        },
        {
          memory_id: 'mem-post-upgrade-unresolved',
          source_type: 'raw_event',
          source_id: 'missing-post-upgrade',
        },
        {
          memory_id: 'mem-legacy-missing',
          source_type: 'raw_event',
          source_id: 'missing-source-id',
        },
        {
          memory_id: 'mem-legacy-user-command',
          source_type: 'user_command',
          source_id: 'admin-command-id',
        },
        {
          memory_id: 'mem-legacy-worker-collision',
          source_type: 'worker_extraction',
          source_id: 'worker-collision',
        },
      ]));
      expect(db.prepare(
        `SELECT memory_id
           FROM memory_sources
          WHERE resolution_state = 'legacy_unresolved'
          ORDER BY source_type, source_id, memory_id
          LIMIT ?`,
      ).all(2)).toHaveLength(2);
      const queryPlan = db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT memory_id
           FROM memory_sources
          WHERE resolution_state = 'legacy_unresolved'
          ORDER BY source_type, source_id, memory_id
          LIMIT ?`,
      ).all(2) as Array<{ detail: string }>;
      expect(queryPlan.map((row) => row.detail).join('\n')).toContain('idx_memory_sources_resolution');

      const foreignKeys = db.prepare('PRAGMA foreign_key_list(memory_sources)').all() as Array<{
        table: string;
        from: string;
        on_delete: string;
      }>;
      expect(foreignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'raw_events', from: 'raw_event_id', on_delete: 'RESTRICT' }),
        expect.objectContaining({ table: 'chat_messages', from: 'chat_message_id', on_delete: 'RESTRICT' }),
        expect.objectContaining({ table: 'tool_calls', from: 'tool_call_id', on_delete: 'RESTRICT' }),
        expect.objectContaining({ table: 'jobs', from: 'job_id', on_delete: 'RESTRICT' }),
        expect.objectContaining({ table: 'job_attempts', from: 'job_attempt_id', on_delete: 'RESTRICT' }),
      ]));
      expect(() => db.prepare('DELETE FROM raw_events WHERE id = ?').run('raw-source-id')).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
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

    it('should enforce evaluator decision linkage on action decisions', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('evt-evaluator-fk', 'message.private', now, 'gateway', 'qq', 'private:evaluator-fk', '{}', now);
      db.prepare(
        `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('turn-evaluator-fk', 'private:evaluator-fk', 'evt-evaluator-fk', 'mock', 'mock', 'running', now);

      expect(() => db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, evaluator_passed, evaluator_decision_id,
          actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-missing-evaluator-fk',
        'turn-evaluator-fk',
        'evaluator',
        'medium',
        0.8,
        1,
        1,
        'missing-evaluator-fk',
        '[]',
        '[]',
        '[]',
        now,
      )).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should enforce execution, action, evaluator, then turn deletion order', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('evt-evaluator-delete-order', 'message.private', now, 'gateway', 'qq', 'private:delete-order', '{}', now);
      db.prepare(
        `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'turn-evaluator-delete-order',
        'private:delete-order',
        'evt-evaluator-delete-order',
        'mock',
        'mock',
        'completed',
        now,
      );
      db.prepare(
        `INSERT INTO evaluator_decisions (
          id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
          evaluator_version, actor_class, invocation_context,
          source_event_ids, request_created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'eval-evaluator-delete-order',
        'request-evaluator-delete-order',
        'social',
        'turn-evaluator-delete-order',
        'approve',
        'approved',
        0.9,
        'medium',
        'delete-order-test',
        'user',
        'private_chat',
        JSON.stringify(['evt-evaluator-delete-order']),
        now,
        now,
      );
      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, evaluator_passed, evaluator_decision_id,
          actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-evaluator-delete-order',
        'turn-evaluator-delete-order',
        'evaluator',
        'medium',
        0.9,
        1,
        1,
        'eval-evaluator-delete-order',
        '[]',
        '[]',
        '[]',
        now,
      );
      db.prepare(
        'UPDATE agent_turns SET action_decision_id = ? WHERE id = ?'
      ).run('decision-evaluator-delete-order', 'turn-evaluator-delete-order');
      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status, audit_level, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'execution-evaluator-delete-order',
        'decision-evaluator-delete-order',
        'reply_short',
        'success',
        'summary',
        now,
      );

      expect(() => db.prepare('DELETE FROM action_decisions WHERE id = ?')
        .run('decision-evaluator-delete-order')).toThrow();
      expect(() => db.prepare('DELETE FROM evaluator_decisions WHERE id = ?')
        .run('eval-evaluator-delete-order')).toThrow();
      expect(() => db.prepare('DELETE FROM agent_turns WHERE id = ?')
        .run('turn-evaluator-delete-order')).toThrow();

      db.prepare('DELETE FROM action_executions WHERE id = ?').run('execution-evaluator-delete-order');
      db.prepare('DELETE FROM action_decisions WHERE id = ?').run('decision-evaluator-delete-order');
      db.prepare('DELETE FROM evaluator_decisions WHERE id = ?').run('eval-evaluator-delete-order');
      db.prepare('DELETE FROM agent_turns WHERE id = ?').run('turn-evaluator-delete-order');

      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should enforce action execution memory and job linkage foreign keys', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('evt-action-link-fk', 'message.private', now, 'gateway', 'qq', 'private:action-link-fk', '{}', now);
      db.prepare(
        `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('turn-action-link-fk', 'private:action-link-fk', 'evt-action-link-fk', 'mock', 'mock', 'completed', now);
      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'decision-action-link-fk',
        'turn-action-link-fk',
        'pi',
        'low',
        0.8,
        0,
        '[]',
        '[]',
        '[]',
        now,
      );

      expect(() => {
        db.prepare(
          `INSERT INTO action_executions (
            id, action_decision_id, action_type, status,
            executed_job_id, audit_level, executed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'execution-missing-job-link',
          'decision-action-link-fk',
          'admin_digest',
          'success',
          'job-does-not-exist',
          'summary',
          now,
        );
      }).toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO action_executions (
            id, action_decision_id, action_type, status,
            executed_memory_id, audit_level, executed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'execution-missing-memory-link',
          'decision-action-link-fk',
          'propose_memory',
          'success',
          'memory-does-not-exist',
          'summary',
          now,
        );
      }).toThrow();

      expect(
        db.prepare('SELECT COUNT(*) AS count FROM action_executions').get(),
      ).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should enforce canonical memory source foreign keys and deletion restrictions', () => {
      const now = Date.now();
      for (const id of ['raw-source-parent', 'raw-chat-source-parent', 'raw-tool-source-parent']) {
        insertMemorySourceRawEvent(db, id, now);
      }
      insertMemorySourceChatMessage(
        db,
        'chat-source-parent',
        'raw-chat-source-parent',
        'platform-chat-source-parent',
        now,
      );
      insertMemorySourceToolCall(db, 'tool-source-parent', 'raw-tool-source-parent', now);
      insertMemorySourceJob(db, 'job-source-parent', now);
      insertMemorySourceJob(db, 'attempt-job-parent', now);
      insertMemorySourceJobAttempt(db, 'attempt-source-parent', 'attempt-job-parent', now);

      const memoryIds = [
        'mem-source-fk-raw',
        'mem-source-fk-chat',
        'mem-source-fk-tool',
        'mem-source-fk-job',
        'mem-source-fk-attempt',
        'mem-source-fk-missing',
      ];
      for (const memoryId of memoryIds) {
        insertMemorySourceRecord(db, memoryId, now);
      }

      const insertSource = db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by,
          resolution_state, raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const validSources: Array<[string, string, string, Array<string | null>]> = [
        ['mem-source-fk-raw', 'raw_event', 'raw-source-parent', ['raw-source-parent', null, null, null, null]],
        ['mem-source-fk-chat', 'chat_message', 'chat-source-parent', [null, 'chat-source-parent', null, null, null]],
        ['mem-source-fk-tool', 'tool_output', 'tool-source-parent', [null, null, 'tool-source-parent', null, null]],
        ['mem-source-fk-job', 'worker_extraction', 'job-source-parent', [null, null, null, 'job-source-parent', null]],
        [
          'mem-source-fk-attempt',
          'worker_extraction',
          'attempt-source-parent',
          [null, null, null, null, 'attempt-source-parent'],
        ],
      ];
      for (const [memoryId, sourceType, sourceId, references] of validSources) {
        insertSource.run(
          memoryId,
          sourceType,
          sourceId,
          now,
          'source-fk-test',
          'internal',
          ...references,
        );
      }

      const missingReferences: Array<[string, string]> = [
        ['raw_event', 'raw_event_id'],
        ['chat_message', 'chat_message_id'],
        ['tool_output', 'tool_call_id'],
        ['worker_extraction', 'job_id'],
        ['worker_extraction', 'job_attempt_id'],
      ];
      for (const [sourceType, referenceColumn] of missingReferences) {
        expect(() => db.prepare(
          `INSERT INTO memory_sources (
            memory_id, source_type, source_id, source_timestamp, extracted_by,
            resolution_state, ${referenceColumn}
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'mem-source-fk-missing',
          sourceType,
          `missing-${referenceColumn}`,
          now,
          'source-fk-test',
          'internal',
          `missing-${referenceColumn}`,
        )).toThrow();
      }

      const restrictedParents: Array<[string, string]> = [
        ['raw_events', 'raw-source-parent'],
        ['chat_messages', 'chat-source-parent'],
        ['tool_calls', 'tool-source-parent'],
        ['jobs', 'job-source-parent'],
        ['job_attempts', 'attempt-source-parent'],
      ];
      for (const [table, id] of restrictedParents) {
        expect(() => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)).toThrow();
      }

      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should enforce admission raw-event linkage and cascade deletion', () => {
      const now = Date.now();

      expect(() => db.prepare(
        `INSERT INTO event_processing_admissions (
          raw_event_id, state, accepted_at
        ) VALUES (?, ?, ?)`,
      ).run(null, 'accepted', now)).toThrow();
      expect(() => db.prepare(
        `INSERT INTO event_processing_admissions (
          raw_event_id, state, accepted_at
        ) VALUES (?, ?, ?)`,
      ).run('missing-admission-raw-event', 'accepted', now)).toThrow();

      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'admission-cascade-raw-event',
        'chat.message.received',
        now,
        'gateway',
        'qq',
        'private:admission-cascade',
        '{}',
        now,
      );
      db.prepare(
        `INSERT INTO event_processing_admissions (
          raw_event_id, state, accepted_at
        ) VALUES (?, ?, ?)`,
      ).run('admission-cascade-raw-event', 'accepted', now);
      expect(() => db.prepare(
        `INSERT INTO event_processing_admissions (
          raw_event_id, state, accepted_at
        ) VALUES (?, ?, ?)`,
      ).run('admission-cascade-raw-event', 'accepted', now)).toThrow();

      db.prepare('DELETE FROM raw_events WHERE id = ?').run('admission-cascade-raw-event');

      expect(
        db.prepare('SELECT COUNT(*) AS count FROM event_processing_admissions').get(),
      ).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
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

    it('should enforce memory source resolution state and compatible reference shape', () => {
      const now = Date.now();
      insertMemorySourceRawEvent(db, 'shape-ref', now);
      insertMemorySourceChatMessage(db, 'shape-ref', 'shape-ref', 'platform-shape-ref', now);
      insertMemorySourceToolCall(db, 'shape-ref', 'shape-ref', now);
      insertMemorySourceJob(db, 'shape-ref', now);
      insertMemorySourceJob(db, 'shape-attempt-parent', now);
      insertMemorySourceJobAttempt(db, 'shape-ref', 'shape-attempt-parent', now);
      insertMemorySourceRecord(db, 'mem-source-shape', now);

      const insertSource = db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by,
          resolution_state, raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const validShapes: Array<[string, string, string, Array<string | null>]> = [
        ['internal', 'raw_event', 'valid-raw', ['shape-ref', null, null, null, null]],
        ['internal', 'chat_message', 'valid-chat', [null, 'shape-ref', null, null, null]],
        ['internal', 'tool_output', 'valid-tool', [null, null, 'shape-ref', null, null]],
        ['internal', 'worker_extraction', 'valid-job', [null, null, null, 'shape-ref', null]],
        ['internal', 'worker_extraction', 'valid-attempt', [null, null, null, null, 'shape-ref']],
        ['external', 'user_command', 'valid-external', [null, null, null, null, null]],
        ['legacy_unresolved', 'raw_event', 'valid-legacy', [null, null, null, null, null]],
      ];
      for (const [resolutionState, sourceType, sourceId, references] of validShapes) {
        expect(() => insertSource.run(
          'mem-source-shape',
          sourceType,
          sourceId,
          now,
          'source-shape-test',
          resolutionState,
          ...references,
        )).not.toThrow();
      }

      const invalidShapes: Array<[string, string, string, Array<string | null>]> = [
        ['unknown', 'raw_event', 'invalid-state', ['shape-ref', null, null, null, null]],
        ['internal', 'raw_event', 'internal-without-ref', [null, null, null, null, null]],
        ['internal', 'raw_event', 'raw-with-chat-ref', [null, 'shape-ref', null, null, null]],
        ['internal', 'chat_message', 'chat-with-two-refs', ['shape-ref', 'shape-ref', null, null, null]],
        ['internal', 'tool_output', 'tool-with-job-ref', [null, null, null, 'shape-ref', null]],
        ['internal', 'worker_extraction', 'worker-without-ref', [null, null, null, null, null]],
        ['internal', 'worker_extraction', 'worker-with-two-refs', [null, null, null, 'shape-ref', 'shape-ref']],
        ['internal', 'user_command', 'internal-user-command', [null, null, null, null, null]],
        ['external', 'raw_event', 'external-raw', [null, null, null, null, null]],
        ['external', 'user_command', 'external-with-ref', ['shape-ref', null, null, null, null]],
        ['legacy_unresolved', 'raw_event', 'legacy-with-ref', ['shape-ref', null, null, null, null]],
      ];
      for (const [resolutionState, sourceType, sourceId, references] of invalidShapes) {
        expect(() => insertSource.run(
          'mem-source-shape',
          sourceType,
          sourceId,
          now,
          'source-shape-test',
          resolutionState,
          ...references,
        )).toThrow();
      }

      expect(
        db.prepare('SELECT COUNT(*) AS count FROM memory_sources WHERE memory_id = ?')
          .get('mem-source-shape'),
      ).toEqual({ count: validShapes.length });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should enforce admission state, timestamp, and reason consistency', () => {
      const acceptedAt = Date.now();
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'admission-shape-raw-event',
        'chat.message.received',
        acceptedAt,
        'gateway',
        'qq',
        'private:admission-shape',
        '{}',
        acceptedAt,
      );

      const insertAdmission = db.prepare(
        `INSERT INTO event_processing_admissions (
          raw_event_id, state, accepted_at, processing_started_at, finished_at, reason_code
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const impossibleShapes: Array<[string, number | null, number | null, string | null]> = [
        ['unknown', null, null, null],
        ['accepted', acceptedAt + 1, null, null],
        ['accepted', null, acceptedAt + 1, null],
        ['accepted', null, null, 'handler_failed'],
        ['processing', null, null, null],
        ['processing', acceptedAt + 1, acceptedAt + 2, null],
        ['completed', acceptedAt + 1, null, null],
        ['completed', acceptedAt + 1, acceptedAt + 2, 'handler_failed'],
        ['failed', acceptedAt + 1, acceptedAt + 2, null],
        ['failed', acceptedAt + 1, acceptedAt + 2, 'stale_processing'],
        ['interrupted_review', null, acceptedAt + 1, 'stale_processing'],
        ['interrupted_review', acceptedAt + 1, acceptedAt + 2, 'started_evidence'],
        ['interrupted_review', null, acceptedAt + 1, 'handler_failed'],
        ['processing', acceptedAt - 1, null, null],
        ['completed', acceptedAt + 2, acceptedAt + 1, null],
        ['interrupted_review', null, acceptedAt - 1, 'invalid_stored_event'],
      ];

      for (const [state, processingStartedAt, finishedAt, reasonCode] of impossibleShapes) {
        expect(() => insertAdmission.run(
          'admission-shape-raw-event',
          state,
          acceptedAt,
          processingStartedAt,
          finishedAt,
          reasonCode,
        )).toThrow();
      }

      expect(
        db.prepare('SELECT COUNT(*) AS count FROM event_processing_admissions').get(),
      ).toEqual({ count: 0 });
    });

    it('should allow every valid admission lifecycle shape', () => {
      const acceptedAt = Date.now();
      const validShapes: Array<[
        string,
        number | null,
        number | null,
        string | null,
      ]> = [
        ['accepted', null, null, null],
        ['processing', acceptedAt + 1, null, null],
        ['completed', acceptedAt + 1, acceptedAt + 2, null],
        ['failed', acceptedAt + 1, acceptedAt + 2, 'handler_failed'],
        ['interrupted_review', acceptedAt + 1, acceptedAt + 2, 'stale_processing'],
        ['interrupted_review', null, acceptedAt + 1, 'started_evidence'],
        ['interrupted_review', null, acceptedAt + 1, 'invalid_stored_event'],
      ];
      const insertRawEvent = db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertAdmission = db.prepare(
        `INSERT INTO event_processing_admissions (
          raw_event_id, state, accepted_at, processing_started_at, finished_at, reason_code
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );

      for (const [index, [state, processingStartedAt, finishedAt, reasonCode]] of validShapes.entries()) {
        const rawEventId = `valid-admission-shape-${index}`;
        insertRawEvent.run(
          rawEventId,
          'chat.message.received',
          acceptedAt,
          'gateway',
          'qq',
          `private:valid-admission-${index}`,
          '{}',
          acceptedAt,
        );
        expect(() => insertAdmission.run(
          rawEventId,
          state,
          acceptedAt,
          processingStartedAt,
          finishedAt,
          reasonCode,
        )).not.toThrow();
      }

      expect(
        db.prepare('SELECT COUNT(*) AS count FROM event_processing_admissions').get(),
      ).toEqual({ count: validShapes.length });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
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

    it('should create indexes for event_processing_failures', () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='event_processing_failures' AND name NOT LIKE 'sqlite_%'"
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_event_processing_failures_occurred');
      expect(indexNames).toContain('idx_event_processing_failures_stage');
      expect(indexNames).toContain('idx_event_processing_failures_raw_event');
      expect(indexNames).toContain('idx_event_processing_failures_turn');
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

function insertMemorySourceRawEvent(db: Database.Database, id: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'chat.message.received', timestamp, 'gateway', 'qq', 'private:memory-source-test', '{}', timestamp);
}

function insertMemorySourceChatMessage(
  db: Database.Database,
  id: string,
  rawEventId: string,
  messageId: string,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id, conversation_type,
      sender_id, text, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    rawEventId,
    messageId,
    'private:memory-source-test',
    'private',
    'sender-memory-source-test',
    'synthetic memory source evidence',
    timestamp,
  );
}

function insertMemorySourceToolCall(
  db: Database.Database,
  id: string,
  rawEventId: string,
  timestamp: number,
): void {
  const turnId = `turn-${id}`;
  db.prepare(
    `INSERT INTO agent_turns (
      id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(turnId, 'private:memory-source-test', rawEventId, 'mock', 'mock', 'completed', timestamp);
  db.prepare(
    `INSERT INTO tool_calls (
      id, turn_id, tool_name, input, output, requested_by,
      actor_class, invocation_context, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, turnId, 'memory.propose', '{}', '{}', 'pi', 'user', 'private_chat', 'success', timestamp);
}

function insertMemorySourceJob(db: Database.Database, id: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO jobs (
      id, type, payload, status, attempts, max_attempts,
      created_at, updated_at, scheduled_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'extraction', '{}', 'completed', 1, 3, timestamp, timestamp, timestamp, timestamp);
}

function insertMemorySourceJobAttempt(
  db: Database.Database,
  id: string,
  jobId: string,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO job_attempts (
      id, job_id, attempt_number, worker_id, status, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, jobId, 1, 'worker-memory-source-test', 'completed', timestamp, timestamp);
}

function insertMemorySourceRecord(db: Database.Database, id: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO memory_records (
      id, scope, visibility, sensitivity, authority, kind, title, content,
      state, confidence, importance, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'global',
    'owner_admin_only',
    'normal',
    'system',
    'fact',
    'Memory source test',
    'Synthetic memory source test evidence',
    'active',
    0.8,
    0.5,
    timestamp,
    timestamp,
  );
}
