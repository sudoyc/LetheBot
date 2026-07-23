import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initDatabase,
  closeDatabase,
  runMigration,
  runMigrations,
} from '../../../src/storage/database.js';
import {
  applyRetentionPolicy,
  backupSqliteDatabase,
  collectOperationsMetrics,
  formatOperationsMetricsPrometheus,
  restoreSqliteDatabase,
} from '../../../src/operations/sqlite-maintenance.js';

const migrationPath = join(process.cwd(), 'migrations/001_initial_schema.sql');
const migrationDirectory = join(process.cwd(), 'migrations');

describe('SQLite operations maintenance', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lethebot-ops-'));
    tempDirs.push(dir);
    return dir;
  }

  it('backs up and restores a temp SQLite database', async () => {
    const dir = createTempDir();
    const sourcePath = join(dir, 'source.db');
    const backupPath = join(dir, 'backups', 'source.backup.db');
    const restoredPath = join(dir, 'restored.db');
    const db = initDatabase({ path: sourcePath });

    try {
      runMigration(db, migrationPath);
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'evt-backup-1',
        'chat.message.received',
        1782970000000,
        'gateway',
        'qq',
        'private:qq-1',
        '{}',
        1782970000000,
      );

      const backup = await backupSqliteDatabase({ sourcePath, backupPath });
      expect(backup.integrityOk).toBe(true);
      expect(backup.backupSizeBytes).toBeGreaterThan(0);

      const restore = restoreSqliteDatabase({ backupPath, targetPath: restoredPath });
      expect(restore.integrityOk).toBe(true);
      expect(restore.foreignKeyViolations).toBe(0);
      expect(readdirSync(dir).filter((entry) => entry.startsWith('.lethebot-restore-'))).toEqual([]);

      const restored = initDatabase({ path: restoredPath, readonly: true });
      try {
        const row = restored
          .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE id = ?')
          .get('evt-backup-1') as { count: number };
        expect(row.count).toBe(1);
      } finally {
        closeDatabase(restored);
      }
    } finally {
      closeDatabase(db);
    }
  });

  it('creates online backups with a private mode under a permissive umask', () => {
    const dir = createTempDir();
    const sourcePath = join(dir, 'private-backup-source.db');
    const backupPath = join(dir, 'backups', 'private-backup.db');
    const db = initDatabase({ path: sourcePath });

    try {
      runMigration(db, migrationPath);
      const script = [
        "import { backupSqliteDatabase } from './src/operations/sqlite-maintenance.ts';",
        'process.umask(0o000);',
        'await backupSqliteDatabase({ sourcePath: process.argv[1], backupPath: process.argv[2] });',
      ].join('\n');
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script, sourcePath, backupPath],
        { cwd: process.cwd(), encoding: 'utf8' },
      );

      expect(child.status).toBe(0);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    } finally {
      closeDatabase(db);
    }
  });

  it('refuses to replace an existing backup destination', async () => {
    const dir = createTempDir();
    const sourcePath = join(dir, 'backup-source.db');
    const backupPath = join(dir, 'existing-backup.db');
    const sourceDb = initDatabase({ path: sourcePath });
    const existingBackupDb = initDatabase({ path: backupPath });

    try {
      runMigration(sourceDb, migrationPath);
      runMigration(existingBackupDb, migrationPath);
      existingBackupDb.exec(`
        CREATE TABLE existing_backup_sentinel (value TEXT NOT NULL);
        INSERT INTO existing_backup_sentinel (value) VALUES ('must-survive');
      `);
    } finally {
      closeDatabase(sourceDb);
      closeDatabase(existingBackupDb);
    }
    const backupBefore = readFileSync(backupPath);

    await expect(backupSqliteDatabase({ sourcePath, backupPath }))
      .rejects.toThrow(/Backup database already exists/);

    expect(readFileSync(backupPath)).toEqual(backupBefore);
    expect(readdirSync(dir).filter((entry) => entry.startsWith('.lethebot-backup-'))).toEqual([]);
  });

  it('does not publish a backup candidate that fails its integrity check', async () => {
    const dir = createTempDir();
    const sourcePath = join(dir, 'integrity-invalid-source.db');
    const backupPath = join(dir, 'must-not-publish.db');
    const sourceDb = initDatabase({ path: sourcePath });
    try {
      sourceDb.exec(`
        CREATE TABLE integrity_probe (id INTEGER PRIMARY KEY, value TEXT);
        CREATE INDEX idx_integrity_probe_value ON integrity_probe(value);
        INSERT INTO integrity_probe(value) VALUES ('c'), ('a'), ('b');
      `);
      sourceDb.unsafeMode(true);
      sourceDb.exec('PRAGMA writable_schema = ON');
      sourceDb.prepare(
        `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_integrity_probe_value ON integrity_probe(id)'
          WHERE type = 'index' AND name = 'idx_integrity_probe_value'`,
      ).run();
      sourceDb.exec('PRAGMA writable_schema = OFF');
      sourceDb.pragma('schema_version = 99');
    } finally {
      closeDatabase(sourceDb);
    }

    await expect(backupSqliteDatabase({ sourcePath, backupPath }))
      .rejects.toThrow(/Backup integrity check failed/);

    expect(existsSync(backupPath)).toBe(false);
    expect(readdirSync(dir).filter((entry) => entry.startsWith('.lethebot-backup-'))).toEqual([]);
  });

  it('publishes restored databases with a private mode from a permissive backup', () => {
    const dir = createTempDir();
    const backupPath = join(dir, 'permissive-backup.db');
    const targetPath = join(dir, 'private-restored.db');
    const backupDb = initDatabase({ path: backupPath });

    try {
      runMigration(backupDb, migrationPath);
    } finally {
      closeDatabase(backupDb);
    }
    chmodSync(backupPath, 0o666);

    restoreSqliteDatabase({ backupPath, targetPath });

    expect(statSync(targetPath).mode & 0o777).toBe(0o600);
  });

  it('rejects an FK-invalid backup before replacing an overwrite target', () => {
    const dir = createTempDir();
    const backupPath = join(dir, 'invalid-fk.backup.db');
    const targetPath = join(dir, 'target.db');
    const backupDb = initDatabase({ path: backupPath });
    const targetDb = initDatabase({ path: targetPath });

    try {
      runMigration(backupDb, migrationPath);
      backupDb.pragma('foreign_keys = OFF');
      backupDb.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id,
          conversation_type, sender_id, text, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'orphan-chat-message',
        'missing-raw-event',
        'orphan-platform-message',
        'private:test',
        'private',
        'test-user',
        'orphan',
        1782970000000,
      );

      runMigration(targetDb, migrationPath);
      targetDb.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'target-must-survive',
        'chat.message.received',
        1782970000000,
        'gateway',
        'qq',
        'private:test',
        '{}',
        1782970000000,
      );
    } finally {
      closeDatabase(backupDb);
      closeDatabase(targetDb);
    }

    const targetBefore = readFileSync(targetPath);

    expect(() => restoreSqliteDatabase({ backupPath, targetPath, overwrite: true }))
      .toThrow(/foreign key check failed: 1 violation/);
    expect(readFileSync(targetPath)).toEqual(targetBefore);
    expect(readdirSync(dir).filter((entry) => entry.startsWith('.lethebot-restore-'))).toEqual([]);

    const preserved = initDatabase({ path: targetPath, readonly: true });
    try {
      expect(
        preserved.prepare('SELECT COUNT(*) AS count FROM raw_events WHERE id = ?').get('target-must-survive')
      ).toEqual({ count: 1 });
      expect(preserved.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(preserved);
    }
  });

  it('rejects backup and overwrite target aliases without deleting the database', () => {
    const dir = createTempDir();
    const backupPath = join(dir, 'alias-source.db');
    const db = initDatabase({ path: backupPath });

    try {
      runMigration(db, migrationPath);
    } finally {
      closeDatabase(db);
    }

    const backupBefore = readFileSync(backupPath);
    expect(() => restoreSqliteDatabase({
      backupPath,
      targetPath: backupPath,
      overwrite: true,
    })).toThrow(/must be different files/);
    expect(readFileSync(backupPath)).toEqual(backupBefore);

    const aliases = [
      { path: join(dir, 'hardlink-target.db'), create: linkSync },
      { path: join(dir, 'symlink-target.db'), create: symlinkSync },
    ];

    for (const alias of aliases) {
      alias.create(backupPath, alias.path);

      expect(() => restoreSqliteDatabase({
        backupPath,
        targetPath: alias.path,
        overwrite: true,
      })).toThrow(/must be different files/);
      expect(readFileSync(backupPath)).toEqual(backupBefore);
      expect(existsSync(alias.path)).toBe(true);

      rmSync(alias.path);
    }

    expect(readdirSync(dir).filter((entry) => entry.startsWith('.lethebot-restore-'))).toEqual([]);
  });

  it.each(['-wal', '-shm'])('refuses overwrite when the target has a %s sidecar', (suffix) => {
    const dir = createTempDir();
    const backupPath = join(dir, 'sidecar.backup.db');
    const targetPath = join(dir, 'sidecar-target.db');
    const sidecarPath = `${targetPath}${suffix}`;
    const backupDb = initDatabase({ path: backupPath });
    const targetDb = initDatabase({ path: targetPath });

    try {
      runMigration(backupDb, migrationPath);
      runMigration(targetDb, migrationPath);
    } finally {
      closeDatabase(backupDb);
      closeDatabase(targetDb);
    }

    const targetBefore = readFileSync(targetPath);
    writeFileSync(sidecarPath, 'sidecar-must-survive');

    expect(() => restoreSqliteDatabase({ backupPath, targetPath, overwrite: true }))
      .toThrow(/sidecar exists/);
    expect(readFileSync(targetPath)).toEqual(targetBefore);
    expect(readFileSync(sidecarPath, 'utf8')).toBe('sidecar-must-survive');
    expect(readdirSync(dir).filter((entry) => entry.startsWith('.lethebot-restore-'))).toEqual([]);
  });

  it('does not replace a dangling target entry without explicit overwrite', () => {
    const dir = createTempDir();
    const backupPath = join(dir, 'dangling-target.backup.db');
    const targetPath = join(dir, 'dangling-target.db');
    const missingLinkTarget = join(dir, 'missing.db');
    const backupDb = initDatabase({ path: backupPath });

    try {
      runMigration(backupDb, migrationPath);
    } finally {
      closeDatabase(backupDb);
    }
    symlinkSync(missingLinkTarget, targetPath);
    expect(existsSync(targetPath)).toBe(false);

    expect(() => restoreSqliteDatabase({ backupPath, targetPath }))
      .toThrow(/Target database already exists/);

    expect(readlinkSync(targetPath)).toBe(missingLinkTarget);
    expect(existsSync(missingLinkTarget)).toBe(false);
    expect(readdirSync(dir).filter((entry) => entry.startsWith('.lethebot-restore-'))).toEqual([]);
  });

  it('preserves the target and cleans the candidate when publish rename fails', () => {
    const dir = createTempDir();
    const backupPath = join(dir, 'rename-failure.backup.db');
    const targetPath = join(dir, 'rename-failure-target.db');
    const targetMarkerPath = join(targetPath, 'marker.txt');
    const backupDb = initDatabase({ path: backupPath });

    try {
      runMigration(backupDb, migrationPath);
    } finally {
      closeDatabase(backupDb);
    }

    mkdirSync(targetPath);
    writeFileSync(targetMarkerPath, 'target-must-survive-rename-failure');

    expect(() => restoreSqliteDatabase({ backupPath, targetPath, overwrite: true })).toThrow();
    expect(readFileSync(targetMarkerPath, 'utf8')).toBe('target-must-survive-rename-failure');
    expect(readdirSync(dir).filter((entry) => entry.startsWith('.lethebot-restore-'))).toEqual([]);
  });

  it('applies retention without breaking foreign keys', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'retention.db') });
    const now = Date.UTC(2026, 6, 2);
    const old = now - 40 * 24 * 60 * 60 * 1000;
    const recent = now - 5 * 24 * 60 * 60 * 1000;

    try {
      runMigration(db, migrationPath);
      insertRawEvent(db, 'evt-old-chat-row-source', old);
      insertRawEvent(db, 'evt-old-chat-platform-source', old);
      insertRawEvent(db, 'evt-old-raw-source', old);
      insertRawEvent(db, 'evt-old-unreferenced', old);
      insertRawEvent(db, 'evt-old-pending-extraction', old);
      insertRawEvent(db, 'evt-old-running-extraction', old);
      insertRawEvent(db, 'evt-old-completed-extraction', old);
      insertRawEvent(db, 'evt-old-malformed-extraction', old);
      insertRawEvent(db, 'evt-recent-chat', recent);
      insertRawEvent(db, 'evt-memory-action', recent);
      insertChatMessage(db, 'msg-old-chat-row-source', 'evt-old-chat-row-source', old);
      insertChatMessage(
        db,
        'msg-old-chat-platform-source',
        'evt-old-chat-platform-source',
        old,
        'platform-old-chat-platform-source',
      );
      insertChatMessage(db, 'msg-old-raw-source', 'evt-old-raw-source', old);
      insertChatMessage(
        db,
        'msg-old-unreferenced',
        'evt-old-unreferenced',
        old,
        'platform-old-unreferenced',
      );
      insertChatMessage(
        db,
        'msg-old-pending-extraction',
        'evt-old-pending-extraction',
        old,
        'platform-old-pending-extraction',
      );
      insertChatMessage(db, 'msg-old-running-extraction', 'evt-old-running-extraction', old);
      insertChatMessage(db, 'msg-old-completed-extraction', 'evt-old-completed-extraction', old);
      insertChatMessage(db, 'msg-old-malformed-extraction', 'evt-old-malformed-extraction', old);
      insertChatMessage(db, 'msg-recent', 'evt-recent-chat', recent);
      insertExtractionJob(db, {
        id: 'job-old-pending-extraction',
        status: 'pending',
        sourceChatMessageId: 'msg-old-pending-extraction',
        timestamp: old,
      });
      insertExtractionJob(db, {
        id: 'job-old-running-extraction',
        status: 'running',
        sourceChatMessageId: 'msg-old-running-extraction',
        timestamp: old,
      });
      insertExtractionJob(db, {
        id: 'job-old-completed-extraction',
        status: 'completed',
        sourceChatMessageId: 'msg-old-completed-extraction',
        timestamp: old,
      });
      insertExtractionJob(db, {
        id: 'job-old-malformed-extraction',
        status: 'pending',
        sourceChatMessageId: 'ignored-malformed-source',
        timestamp: old,
        payload: '{not-json',
      });
      insertExtractionJob(db, {
        id: 'job-old-failed-extraction',
        status: 'failed',
        sourceChatMessageId: 'msg-old-unreferenced',
        timestamp: old,
      });
      insertEventProcessingFailure(db, 'failure-old', 'evt-old-unreferenced', undefined, old);
      insertEventProcessingFailure(db, 'failure-recent', 'evt-recent-chat', undefined, recent);
      insertAudit(db, 'audit-old', old);
      insertMemory(db, 'mem-old-deleted', 'deleted', old);
      insertMemory(db, 'mem-old-active-chat-row', 'active', old);
      insertMemory(db, 'mem-old-active-chat-platform', 'active', old);
      insertMemory(db, 'mem-old-active-raw', 'active', old);
      insertMemory(db, 'mem-old-active-tool-collision', 'active', old);
      insertMemorySource(db, 'mem-old-deleted', 'raw_event', 'evt-old-unreferenced', old);
      insertMemorySource(
        db,
        'mem-old-active-chat-row',
        'chat_message',
        'msg-old-chat-row-source',
        old,
      );
      insertMemorySource(
        db,
        'mem-old-active-chat-platform',
        'chat_message',
        'platform-old-chat-platform-source',
        old,
      );
      insertMemorySource(db, 'mem-old-active-raw', 'raw_event', 'evt-old-raw-source', old);
      insertMemorySource(
        db,
        'mem-old-active-tool-collision',
        'tool_output',
        'platform-old-unreferenced',
        old,
      );
      insertMemoryActionExecution(db, 'mem-old-deleted', 'evt-memory-action', recent);
      db.prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type, previous_state, new_state,
          reason, actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('rev-old-deleted', 'mem-old-deleted', 1, 'delete', null, '{}', 'test', 'admin', old);

      const result = applyRetentionPolicy(db, {
        rawEventsDays: 30,
        chatMessagesDays: 30,
        auditLogDays: 30,
        disabledDeletedMemoryDays: 30,
        eventProcessingFailuresDays: 30,
      }, now);

      expect(result.chatMessagesDeleted).toBe(3);
      expect(result.rawEventsDeleted).toBe(3);
      expect(result.auditLogDeleted).toBe(1);
      expect(result.eventProcessingFailuresDeleted).toBe(1);
      expect(result.memoriesPurged).toBe(1);
      expect(result.actionMemoryLinksCleared).toBe(1);
      expect(result.memorySourcesDeleted).toBe(1);
      expect(result.memoryRevisionsDeleted).toBe(1);

      expect(count(db, 'chat_messages', 'id', 'msg-old-unreferenced')).toBe(0);
      expect(count(db, 'raw_events', 'id', 'evt-old-unreferenced')).toBe(0);
      expect(count(db, 'chat_messages', 'id', 'msg-old-pending-extraction')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-old-pending-extraction')).toBe(1);
      expect(count(db, 'chat_messages', 'id', 'msg-old-running-extraction')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-old-running-extraction')).toBe(1);
      expect(count(db, 'chat_messages', 'id', 'msg-old-completed-extraction')).toBe(0);
      expect(count(db, 'raw_events', 'id', 'evt-old-completed-extraction')).toBe(0);
      expect(count(db, 'chat_messages', 'id', 'msg-old-malformed-extraction')).toBe(0);
      expect(count(db, 'raw_events', 'id', 'evt-old-malformed-extraction')).toBe(0);
      expect(count(db, 'chat_messages', 'id', 'msg-old-chat-row-source')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-old-chat-row-source')).toBe(1);
      expect(count(db, 'chat_messages', 'id', 'msg-old-chat-platform-source')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-old-chat-platform-source')).toBe(1);
      expect(count(db, 'chat_messages', 'id', 'msg-old-raw-source')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-old-raw-source')).toBe(1);
      expect(count(db, 'chat_messages', 'id', 'msg-recent')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-recent-chat')).toBe(1);
      expect(count(db, 'event_processing_failures', 'id', 'failure-old')).toBe(0);
      expect(count(db, 'event_processing_failures', 'id', 'failure-recent')).toBe(1);
      expect(count(db, 'memory_records', 'id', 'mem-old-deleted')).toBe(0);
      expect(count(db, 'memory_records', 'id', 'mem-old-active-chat-row')).toBe(1);
      expect(count(db, 'memory_records', 'id', 'mem-old-active-chat-platform')).toBe(1);
      expect(count(db, 'memory_records', 'id', 'mem-old-active-raw')).toBe(1);
      expect(count(db, 'memory_sources', 'memory_id', 'mem-old-active-tool-collision')).toBe(1);
      expect(count(db, 'memory_sources', 'memory_id', 'mem-old-active-chat-row')).toBe(1);
      expect(count(db, 'memory_sources', 'memory_id', 'mem-old-active-chat-platform')).toBe(1);
      expect(count(db, 'memory_sources', 'memory_id', 'mem-old-active-raw')).toBe(1);
      expect(
        db.prepare(
          'SELECT executed_memory_id FROM action_executions WHERE id = ?'
        ).get('execution-memory-retention')
      ).toEqual({ executed_memory_id: null });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('pins only pending and running frozen summary sources without overriding memory provenance', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'active-summary-retention.db') });
    const now = Date.UTC(2026, 6, 2);
    const old = now - 40 * 24 * 60 * 60 * 1000;
    const conversationId = 'group:summary-retention';
    const groupId = 'group-summary-retention';

    try {
      runMigrations(db, migrationDirectory);
      for (const [key, status, payloadKind] of [
        ['pending', 'pending', 'array'],
        ['running', 'running', 'array'],
        ['completed', 'completed', 'array'],
        ['failed', 'failed', 'array'],
        ['malformed', 'pending', 'malformed'],
        ['non-array', 'pending', 'non-array'],
        ['provenance', 'completed', 'array'],
      ] as const) {
        const rawEventId = `evt-summary-${key}`;
        const chatMessageId = `msg-summary-${key}`;
        db.prepare(
          `INSERT INTO raw_events (
            id, type, timestamp, source, platform,
            conversation_id, payload, created_at
          ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, '{}', ?)`,
        ).run(rawEventId, old, conversationId, old);
        db.prepare(
          `INSERT INTO chat_messages (
            id, raw_event_id, message_id, conversation_id,
            conversation_type, group_id, sender_id, text, timestamp
          ) VALUES (?, ?, ?, ?, 'group', ?, 'user-summary-retention', 'summary source', ?)`,
        ).run(
          chatMessageId,
          rawEventId,
          `platform-summary-${key}`,
          conversationId,
          groupId,
          old,
        );
        const payload = payloadKind === 'malformed'
          ? '{not-json'
          : JSON.stringify({
              conversationId,
              conversationType: 'group',
              groupId,
              sourceChatMessageIds: payloadKind === 'non-array'
                ? chatMessageId
                : [chatMessageId],
            });
        db.prepare(
          `INSERT INTO jobs (
            id, type, payload, status, attempts, max_attempts,
            created_at, updated_at, scheduled_at
          ) VALUES (?, 'summary', ?, ?, ?, 3, ?, ?, ?)`,
        ).run(
          `job-summary-${key}`,
          payload,
          status,
          status === 'pending' ? 0 : 1,
          old,
          old,
          old,
        );
      }

      insertMemory(db, 'mem-summary-provenance', 'active', old);
      db.prepare(
        `UPDATE memory_records
            SET scope = 'group', group_id = ?, visibility = 'same_group_only',
                authority = 'tool_derived', kind = 'summary',
                source_context = 'background_worker:summary'
          WHERE id = 'mem-summary-provenance'`,
      ).run(groupId);
      insertInternalMemorySource(
        db,
        'mem-summary-provenance',
        'chat_message',
        'msg-summary-provenance',
        old,
        { chatMessageId: 'msg-summary-provenance' },
      );

      const result = applyRetentionPolicy(db, {
        rawEventsDays: 30,
        chatMessagesDays: 30,
      }, now);

      expect(result.chatMessagesDeleted).toBe(4);
      expect(result.rawEventsDeleted).toBe(4);
      for (const key of ['pending', 'running', 'provenance']) {
        expect(count(db, 'chat_messages', 'id', `msg-summary-${key}`)).toBe(1);
        expect(count(db, 'raw_events', 'id', `evt-summary-${key}`)).toBe(1);
      }
      for (const key of ['completed', 'failed', 'malformed', 'non-array']) {
        expect(count(db, 'chat_messages', 'id', `msg-summary-${key}`)).toBe(0);
        expect(count(db, 'raw_events', 'id', `evt-summary-${key}`)).toBe(0);
      }
      expect(count(db, 'memory_sources', 'memory_id', 'mem-summary-provenance')).toBe(1);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('pins sources until delayed Attention jobs are terminal', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'active-attention-retention.db') });
    const now = Date.UTC(2026, 6, 2);
    const old = now - 40 * 24 * 60 * 60 * 1000;

    try {
      runMigrations(db, migrationDirectory);
      for (const [key, status] of [
        ['pending', 'pending'],
        ['running', 'running'],
        ['terminal', 'completed'],
      ] as const) {
        const rawEventId = `evt-attention-${key}`;
        const chatMessageId = `msg-attention-${key}`;
        const candidateId = `candidate-attention-${key}`;
        const jobId = `job-attention-${key}`;
        const conversationId = `group:attention-${key}`;
        const groupId = `qq-group-attention-${key}`;

        db.prepare(
          `INSERT INTO raw_events (
            id, type, timestamp, source, platform,
            conversation_id, payload, created_at
          ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, '{}', ?)`,
        ).run(rawEventId, old, conversationId, old);
        db.prepare(
          `INSERT INTO chat_messages (
            id, raw_event_id, message_id, conversation_id,
            conversation_type, group_id, sender_id, text, timestamp
          ) VALUES (?, ?, ?, ?, 'group', ?, ?, 'question?', ?)`,
        ).run(
          chatMessageId,
          rawEventId,
          `platform-attention-${key}`,
          conversationId,
          groupId,
          `qq-user-attention-${key}`,
          old,
        );
        db.prepare(
          `INSERT INTO jobs (
            id, type, payload, status, attempts, max_attempts,
            created_at, updated_at, scheduled_at, started_at, completed_at
          ) VALUES (?, 'attention_recheck', ?, ?, ?, 3, ?, ?, ?, ?, ?)`,
        ).run(
          jobId,
          JSON.stringify({ candidateId }),
          status,
          status === 'pending' ? 0 : 1,
          old,
          old,
          old + 15_000,
          status === 'pending' ? null : old + 15_000,
          status === 'completed' ? old + 20_000 : null,
        );
        db.prepare(
          `INSERT INTO attention_candidates (
            id, source_raw_event_id, source_chat_message_id, job_id,
            conversation_id, conversation_type, group_id,
            candidate_kind, policy_version,
            observed_at, created_at, not_before_at, expires_at
          ) VALUES (
            ?, ?, ?, ?, ?, 'group', ?,
            'unmentioned_question', 'delayed-attention-v1',
            ?, ?, ?, ?
          )`,
        ).run(
          candidateId,
          rawEventId,
          chatMessageId,
          jobId,
          conversationId,
          groupId,
          old,
          old,
          old + 15_000,
          old + 120_000,
        );

        if (status !== 'pending') {
          const attemptId = `attempt-attention-${key}`;
          db.prepare(
            `INSERT INTO job_attempts (
              id, job_id, attempt_number, worker_id, status,
              started_at, completed_at, heartbeat_at
            ) VALUES (?, ?, 1, 'attention-worker', ?, ?, ?, ?)`,
          ).run(
            attemptId,
            jobId,
            status === 'running' ? 'running' : 'completed',
            old + 15_000,
            status === 'completed' ? old + 20_000 : null,
            old + 15_000,
          );
          if (status === 'running' || status === 'completed') {
            db.prepare(
              `INSERT INTO attention_decisions (
                id, candidate_id, job_id, job_attempt_id, outcome, decided_at
              ) VALUES (?, ?, ?, ?, 'respond', ?)`,
            ).run(
              `decision-attention-${key}`,
              candidateId,
              jobId,
              attemptId,
              old + 20_000,
            );
          }
        }
      }

      const result = applyRetentionPolicy(db, {
        rawEventsDays: 30,
        chatMessagesDays: 30,
      }, now);

      expect(result.chatMessagesDeleted).toBe(1);
      expect(result.rawEventsDeleted).toBe(1);
      for (const key of ['pending', 'running']) {
        expect(count(db, 'chat_messages', 'id', `msg-attention-${key}`)).toBe(1);
        expect(count(db, 'raw_events', 'id', `evt-attention-${key}`)).toBe(1);
        expect(count(db, 'attention_candidates', 'id', `candidate-attention-${key}`)).toBe(1);
      }
      expect(count(db, 'chat_messages', 'id', 'msg-attention-terminal')).toBe(0);
      expect(count(db, 'raw_events', 'id', 'evt-attention-terminal')).toBe(0);
      expect(count(db, 'attention_candidates', 'id', 'candidate-attention-terminal')).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('uses canonical internal memory sources and releases evidence after memory purge', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'canonical-memory-source-retention.db') });
    const now = Date.UTC(2026, 6, 2);
    const old = now - 40 * 24 * 60 * 60 * 1000;

    try {
      runMigration(db, migrationPath);
      insertRawEvent(db, 'evt-old-internal-chat', old);
      insertRawEvent(db, 'evt-old-internal-raw', old);
      insertRawEvent(db, 'evt-old-source-id-collision', old);
      insertRawEvent(db, 'evt-old-purged-source', old);
      insertChatMessage(db, 'msg-old-internal-chat', 'evt-old-internal-chat', old);
      insertChatMessage(db, 'msg-old-internal-raw', 'evt-old-internal-raw', old);
      insertChatMessage(db, 'msg-old-source-id-collision', 'evt-old-source-id-collision', old);
      insertChatMessage(db, 'msg-old-purged-source', 'evt-old-purged-source', old);

      insertMemory(db, 'mem-old-internal-chat', 'active', old);
      insertMemory(db, 'mem-old-internal-raw', 'active', old);
      insertMemory(db, 'mem-old-purged-source', 'deleted', old);
      insertInternalMemorySource(
        db,
        'mem-old-internal-chat',
        'chat_message',
        'noncanonical-chat-source-id',
        old,
        { chatMessageId: 'msg-old-internal-chat' },
      );
      insertInternalMemorySource(
        db,
        'mem-old-internal-raw',
        'raw_event',
        'evt-old-source-id-collision',
        old,
        { rawEventId: 'evt-old-internal-raw' },
      );
      insertInternalMemorySource(
        db,
        'mem-old-purged-source',
        'raw_event',
        'noncanonical-purged-source-id',
        old,
        { rawEventId: 'evt-old-purged-source' },
      );

      const result = applyRetentionPolicy(db, {
        rawEventsDays: 30,
        chatMessagesDays: 30,
        disabledDeletedMemoryDays: 30,
      }, now);

      expect(result.memoriesPurged).toBe(1);
      expect(result.memorySourcesDeleted).toBe(1);
      expect(result.chatMessagesDeleted).toBe(2);
      expect(result.rawEventsDeleted).toBe(2);
      expect(count(db, 'memory_records', 'id', 'mem-old-purged-source')).toBe(0);
      expect(count(db, 'memory_sources', 'memory_id', 'mem-old-purged-source')).toBe(0);
      expect(count(db, 'chat_messages', 'id', 'msg-old-purged-source')).toBe(0);
      expect(count(db, 'raw_events', 'id', 'evt-old-purged-source')).toBe(0);
      expect(count(db, 'chat_messages', 'id', 'msg-old-internal-chat')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-old-internal-chat')).toBe(1);
      expect(count(db, 'chat_messages', 'id', 'msg-old-internal-raw')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-old-internal-raw')).toBe(1);
      expect(count(db, 'chat_messages', 'id', 'msg-old-source-id-collision')).toBe(0);
      expect(count(db, 'raw_events', 'id', 'evt-old-source-id-collision')).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('expires eligible summary sources with raw evidence while preserving pinned ledger metadata', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'model-source-retention.db') });
    const now = Date.UTC(2026, 6, 2);
    const old = now - 40 * 24 * 60 * 60 * 1000;

    try {
      runMigration(db, migrationPath);
      insertRawEvent(db, 'evt-ledger-expiring', old);
      insertRawEvent(db, 'evt-ledger-pinned', old);
      insertChatMessage(db, 'msg-ledger-expiring', 'evt-ledger-expiring', old);
      insertChatMessage(db, 'msg-ledger-pinned', 'evt-ledger-pinned', old);

      insertMemory(db, 'mem-ledger-pin', 'active', old);
      insertInternalMemorySource(
        db,
        'mem-ledger-pin',
        'raw_event',
        'evt-ledger-pinned',
        old,
        { rawEventId: 'evt-ledger-pinned' },
      );

      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          created_at, updated_at, scheduled_at, started_at, completed_at, result
        ) VALUES (?, 'summary', '{}', 'completed', 1, 3, ?, ?, ?, ?, ?, '{}')`,
      ).run('job-ledger-retention', old, old, old, old, old);
      db.prepare(
        `INSERT INTO job_attempts (
          id, job_id, attempt_number, worker_id, status,
          started_at, completed_at, heartbeat_at, result
        ) VALUES (?, ?, 1, 'summary-worker-test', 'completed', ?, ?, ?, '{}')`,
      ).run('attempt-ledger-retention', 'job-ledger-retention', old, old, old);
      db.prepare(
        `INSERT INTO model_contexts (
          id, job_attempt_id, purpose,
          conversation_ref, conversation_type, group_ref,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (
          ?, ?, 'summary', ?, 'private', NULL,
          '[]', '[]', '[]',
          '[]', '[]', ?,
          '{}', '[]', ?
        )`,
      ).run(
        'context-ledger-retention',
        'attempt-ledger-retention',
        `ctxref-sha256:${'0'.repeat(64)}`,
        JSON.stringify(['msg-ledger-expiring', 'msg-ledger-pinned']),
        old,
      );
      db.prepare(
        `INSERT INTO model_invocations (
          id, job_attempt_id, context_id, purpose, call_number,
          provider, model, status, started_at, completed_at,
          tokens_input, tokens_output, tokens_total,
          response_sha256, response_bytes
        ) VALUES (
          ?, ?, ?, 'summary', 1,
          'test-provider', 'test-model', 'completed', ?, ?,
          1, 1, 2,
          ?, 8
        )`,
      ).run(
        'invocation-ledger-retention',
        'attempt-ledger-retention',
        'context-ledger-retention',
        old,
        old,
        '0'.repeat(64),
      );
      db.prepare(
        `INSERT INTO model_invocation_sources (
          model_invocation_id, raw_event_id, source_ordinal
        ) VALUES (?, ?, 0), (?, ?, 1)`,
      ).run(
        'invocation-ledger-retention',
        'evt-ledger-expiring',
        'invocation-ledger-retention',
        'evt-ledger-pinned',
      );

      db.exec(
        `CREATE TRIGGER fail_eligible_raw_retention
         BEFORE DELETE ON raw_events
         WHEN OLD.id = 'evt-ledger-expiring'
         BEGIN
           SELECT RAISE(ABORT, 'synthetic raw retention failure');
         END`,
      );

      expect(() => applyRetentionPolicy(db, {
        rawEventsDays: 30,
        chatMessagesDays: 30,
      }, now)).toThrow('synthetic raw retention failure');
      expect(count(db, 'chat_messages', 'id', 'msg-ledger-expiring')).toBe(1);
      expect(count(db, 'model_invocation_sources', 'raw_event_id', 'evt-ledger-expiring')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-ledger-expiring')).toBe(1);

      db.exec('DROP TRIGGER fail_eligible_raw_retention');
      const result = applyRetentionPolicy(db, {
        rawEventsDays: 30,
        chatMessagesDays: 30,
      }, now);

      expect(result.modelInvocationSourcesDeleted).toBe(1);
      expect(result.chatMessagesDeleted).toBe(1);
      expect(result.rawEventsDeleted).toBe(1);
      expect(count(db, 'model_invocation_sources', 'raw_event_id', 'evt-ledger-expiring')).toBe(0);
      expect(count(db, 'chat_messages', 'id', 'msg-ledger-expiring')).toBe(0);
      expect(count(db, 'raw_events', 'id', 'evt-ledger-expiring')).toBe(0);
      expect(count(db, 'model_invocation_sources', 'raw_event_id', 'evt-ledger-pinned')).toBe(1);
      expect(count(db, 'chat_messages', 'id', 'msg-ledger-pinned')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-ledger-pinned')).toBe(1);
      expect(count(db, 'model_contexts', 'id', 'context-ledger-retention')).toBe(1);
      expect(
        db.prepare('SELECT status FROM model_invocations WHERE id = ?')
          .get('invocation-ledger-retention'),
      ).toEqual({ status: 'completed' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('pins old raw events while their admission is accepted or processing', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'active-admission-retention.db') });
    const now = Date.UTC(2026, 6, 2);
    const old = now - 40 * 24 * 60 * 60 * 1000;

    try {
      runMigration(db, migrationPath);
      insertRawEvent(db, 'evt-admission-accepted', old);
      insertRawEvent(db, 'evt-admission-processing', old);
      insertAdmission(db, 'evt-admission-accepted', 'accepted', old);
      insertAdmission(db, 'evt-admission-processing', 'processing', old);

      const result = applyRetentionPolicy(db, { rawEventsDays: 30 }, now);

      expect(result.rawEventsDeleted).toBe(0);
      expect(count(db, 'raw_events', 'id', 'evt-admission-accepted')).toBe(1);
      expect(count(db, 'raw_events', 'id', 'evt-admission-processing')).toBe(1);
      expect(count(db, 'event_processing_admissions', 'raw_event_id', 'evt-admission-accepted')).toBe(1);
      expect(count(db, 'event_processing_admissions', 'raw_event_id', 'evt-admission-processing')).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('purges old raw events for terminal admissions and cascades linked evidence', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'terminal-admission-retention.db') });
    const now = Date.UTC(2026, 6, 2);
    const old = now - 40 * 24 * 60 * 60 * 1000;
    const terminalStates = ['completed', 'failed', 'interrupted_review'] as const;

    try {
      runMigration(db, migrationPath);
      for (const state of terminalStates) {
        const rawEventId = `evt-admission-${state}`;
        insertRawEvent(db, rawEventId, old);
        insertAdmission(db, rawEventId, state, old);
        db.prepare(
          `INSERT INTO event_ingress_receipts (
            id, raw_event_id, transport, disposition, received_at
          ) VALUES (?, ?, ?, ?, ?)`,
        ).run(`receipt-admission-${state}`, rawEventId, 'http', 'accepted', old);
      }

      const result = applyRetentionPolicy(db, { rawEventsDays: 30 }, now);

      expect(result.rawEventsDeleted).toBe(terminalStates.length);
      for (const state of terminalStates) {
        expect(count(db, 'raw_events', 'id', `evt-admission-${state}`)).toBe(0);
        expect(count(db, 'event_processing_admissions', 'raw_event_id', `evt-admission-${state}`)).toBe(0);
        expect(count(db, 'event_ingress_receipts', 'id', `receipt-admission-${state}`)).toBe(0);
      }
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('collects operations metrics for turns, memory writes, policy audit, and tools', () => {
    const dir = createTempDir();
    const db = initDatabase({ path: join(dir, 'metrics.db') });
    const now = Date.UTC(2026, 6, 2);

    try {
      runMigration(db, migrationPath);
      insertRawEvent(db, 'evt-metrics', now);
      insertChatMessage(db, 'msg-metrics', 'evt-metrics', now);
      db.prepare(
        `INSERT INTO event_ingress_receipts (
          id, raw_event_id, transport, disposition, received_at
        ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
      ).run(
        'receipt-metrics-accepted',
        'evt-metrics',
        'http',
        'accepted',
        now,
        'receipt-metrics-duplicate',
        'evt-metrics',
        'ws',
        'duplicate',
        now,
      );
      insertAdmission(db, 'evt-metrics', 'completed', now);
      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, pi_model, pi_provider,
          response_text, status, tokens_input, tokens_output, tokens_total,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'turn-metrics',
        'private:qq-1',
        'evt-metrics',
        'mock',
        'mock',
        'ok',
        'completed',
        3,
        4,
        7,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO context_traces (
          id, turn_id, conversation_id, conversation_type, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'ctx-metrics',
        'turn-metrics',
        'private:qq-1',
        'private',
        null,
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        JSON.stringify({ max: 8000, used: 0, breakdown: { recentMessages: 0, memory: 0, identity: 0, system: 0 } }),
        '[]',
        now,
      );
      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-metrics',
        'turn-metrics',
        'evaluator',
        'medium',
        0.9,
        1,
        1,
        '[]',
        '[]',
        '[]',
        now,
      );
      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status,
          audit_level, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'execution-metrics',
        'decision-metrics',
        'reply_full',
        'success',
        'summary',
        now,
      );
      insertMemory(db, 'mem-metrics', 'active', now);
      insertAudit(db, 'audit-metrics', now);
      db.prepare(
        `INSERT INTO tool_calls (
          id, turn_id, tool_name, input, output, requested_by,
          actor_class, invocation_context, status,
          execution_time_ms, secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'tool-metrics',
        'turn-metrics',
        'test.tool',
        '{}',
        '{}',
        'pi',
        'user',
        'private_chat',
        'success',
        12,
        1,
        now,
      );
      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          lease_owner, lease_expires_at,
          created_at, updated_at, scheduled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'job-metrics',
        'summary',
        '{}',
        'running',
        1,
        3,
        'worker-metrics',
        now - 1,
        now,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO job_attempts (
          id, job_id, attempt_number, worker_id, status,
          started_at, completed_at, heartbeat_at, result
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'attempt-metrics',
        'job-metrics',
        1,
        'worker-metrics',
        'running',
        now,
        null,
        now,
        null,
      );
      db.prepare(
        `INSERT INTO worker_heartbeats (
          worker_id, worker_type, status, heartbeat_at, details
        ) VALUES (?, ?, ?, ?, ?)`
      ).run(
        'worker-metrics',
        'background',
        'idle',
        now,
        '{}',
      );
      insertEventProcessingFailure(db, 'failure-metrics', 'evt-metrics', 'turn-metrics', now);

      const metrics = collectOperationsMetrics(db, now - 1000, now);

      expect(metrics.rawEvents.total).toBe(1);
      expect(metrics.eventIngressReceipts.total).toBe(2);
      expect(metrics.eventIngressReceipts.byDisposition.accepted).toBe(1);
      expect(metrics.eventIngressReceipts.byDisposition.duplicate).toBe(1);
      expect(metrics.eventProcessingAdmissions.total).toBe(1);
      expect(metrics.eventProcessingAdmissions.byState.completed).toBe(1);
      expect(metrics.chatMessages.total).toBe(1);
      expect(metrics.agentTurns.total).toBe(1);
      expect(metrics.agentTurns.byStatus.completed).toBe(1);
      expect(metrics.agentTurns.tokensTotal).toBe(7);
      expect(metrics.contextTraces.total).toBe(1);
      expect(metrics.actionDecisions.total).toBe(1);
      expect(metrics.actionDecisions.byDecidedBy.evaluator).toBe(1);
      expect(metrics.actionDecisions.byRiskLevel.medium).toBe(1);
      expect(metrics.actionDecisions.evaluatorRequired).toBe(1);
      expect(metrics.actionExecutions.total).toBe(1);
      expect(metrics.actionExecutions.byStatus.success).toBe(1);
      expect(metrics.actionExecutions.byActionType.reply_full).toBe(1);
      expect(metrics.memoryWrites.total).toBe(1);
      expect(metrics.memoryWrites.byState.active).toBe(1);
      expect(metrics.policyAuditEvents.total).toBe(1);
      expect(metrics.policyAuditEvents.byCategory.system).toBe(1);
      expect(metrics.toolCalls.total).toBe(1);
      expect(metrics.toolCalls.byStatus.success).toBe(1);
      expect(metrics.toolCalls.secretsRedacted).toBe(1);
      expect(metrics.jobs.total).toBe(1);
      expect(metrics.jobs.byStatus.running).toBe(1);
      expect(metrics.jobs.byType.summary).toBe(1);
      expect(metrics.jobs.pending).toBe(0);
      expect(metrics.jobs.running).toBe(1);
      expect(metrics.jobs.failed).toBe(0);
      expect(metrics.jobs.expiredRunningLeases).toBe(1);
      expect(metrics.jobAttempts.total).toBe(1);
      expect(metrics.jobAttempts.byStatus.running).toBe(1);
      expect(metrics.workerHeartbeats.total).toBe(1);
      expect(metrics.workerHeartbeats.byStatus.idle).toBe(1);
      expect(metrics.workerHeartbeats.byWorkerType.background).toBe(1);
      expect(metrics.eventProcessingFailures.total).toBe(1);
      expect(metrics.eventProcessingFailures.byStage.pi_inference).toBe(1);
      expect(metrics.eventProcessingFailures.byConversationType.private).toBe(1);

      const prometheus = formatOperationsMetricsPrometheus({
        ...metrics,
        jobs: {
          ...metrics.jobs,
          byType: {
            ...metrics.jobs.byType,
            'qq-12345678': 2,
          },
        },
        workerHeartbeats: {
          ...metrics.workerHeartbeats,
          byWorkerType: {
            ...metrics.workerHeartbeats.byWorkerType,
            'sk-abcdefghijklmnopqrstuvwxyz123456': 3,
          },
        },
        eventProcessingFailures: {
          ...metrics.eventProcessingFailures,
          byStage: {
            ...metrics.eventProcessingFailures.byStage,
            'custom-stage-qq-87654321': 4,
          },
        },
      });
      expect(prometheus).toContain('lethebot_raw_events_total 1');
      expect(prometheus).toContain('lethebot_event_ingress_receipts_total 2');
      expect(prometheus).toContain('lethebot_event_ingress_receipts_disposition_total{disposition="accepted"} 1');
      expect(prometheus).toContain('lethebot_event_ingress_receipts_disposition_total{disposition="duplicate"} 1');
      expect(prometheus).toContain('lethebot_event_processing_admissions_total 1');
      expect(prometheus).toContain('lethebot_event_processing_admissions_state_total{state="completed"} 1');
      expect(prometheus).toContain('lethebot_agent_turns_status_total{status="completed"} 1');
      expect(prometheus).toContain('lethebot_jobs_type_total{type="summary"} 1');
      expect(prometheus).toContain('lethebot_jobs_type_total{type="other"} 2');
      expect(prometheus).toContain('lethebot_worker_heartbeats_type_total{worker_type="other"} 3');
      expect(prometheus).toContain('lethebot_event_processing_failures_stage_total{stage="other"} 4');
      expect(prometheus).not.toContain('qq-12345678');
      expect(prometheus).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
      expect(prometheus).not.toContain('custom-stage-qq-87654321');
      expect(prometheus).not.toContain('private:qq-1');
      expect(prometheus).not.toContain('job-metrics');
    } finally {
      closeDatabase(db);
    }
  });
});

function insertRawEvent(db: ReturnType<typeof initDatabase>, id: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform,
      conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    'chat.message.received',
    timestamp,
    'gateway',
    'qq',
    'private:qq-1',
    '{}',
    timestamp,
  );
}

function insertChatMessage(
  db: ReturnType<typeof initDatabase>,
  id: string,
  rawEventId: string,
  timestamp: number,
  messageId: string = id,
): void {
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id,
      conversation_type, sender_id, text, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, rawEventId, messageId, 'private:qq-1', 'private', 'qq-1', 'hello', timestamp);
}

function insertAdmission(
  db: ReturnType<typeof initDatabase>,
  rawEventId: string,
  state: 'accepted' | 'processing' | 'completed' | 'failed' | 'interrupted_review',
  timestamp: number,
): void {
  const processingStartedAt = state === 'accepted' ? null : timestamp + 1;
  const finishedAt = state === 'accepted' || state === 'processing' ? null : timestamp + 2;
  const reasonCode = state === 'failed'
    ? 'handler_failed'
    : state === 'interrupted_review'
      ? 'stale_processing'
      : null;

  db.prepare(
    `INSERT INTO event_processing_admissions (
      raw_event_id, state, accepted_at, processing_started_at, finished_at, reason_code
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(rawEventId, state, timestamp, processingStartedAt, finishedAt, reasonCode);
}

function insertAudit(db: ReturnType<typeof initDatabase>, id: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO audit_log (
      id, timestamp, category, level, event_type, event_id,
      actor_class, invocation_context, summary, redacted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    timestamp,
    'system',
    'summary',
    'policy.test',
    id,
    'system',
    'system',
    'test audit',
    0,
  );
}

function insertEventProcessingFailure(
  db: ReturnType<typeof initDatabase>,
  id: string,
  rawEventId: string,
  turnId: string | undefined,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO event_processing_failures (
      id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
      error_name, error_message_hash, message_id_hash, sender_id_hash,
      conversation_id_hash, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    rawEventId,
    turnId ?? null,
    timestamp,
    'pi_inference',
    'private',
    'Error',
    'a'.repeat(64),
    'b'.repeat(64),
    'c'.repeat(64),
    'd'.repeat(64),
    JSON.stringify({ redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error' }),
  );
}

function insertMemory(
  db: ReturnType<typeof initDatabase>,
  id: string,
  state: 'active' | 'deleted',
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO memory_records (
      id, scope, visibility, sensitivity, authority,
      kind, title, content, state, confidence, importance,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    'system',
    'owner_admin_only',
    'normal',
    'system',
    'fact',
    id,
    'content',
    state,
    0.9,
    0.5,
    timestamp,
    timestamp,
  );
}

function insertMemorySource(
  db: ReturnType<typeof initDatabase>,
  memoryId: string,
  sourceType: 'raw_event' | 'chat_message' | 'tool_output',
  sourceId: string,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO memory_sources (
      memory_id, source_type, source_id, source_timestamp, extracted_by
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(memoryId, sourceType, sourceId, timestamp, 'test');
}

function insertInternalMemorySource(
  db: ReturnType<typeof initDatabase>,
  memoryId: string,
  sourceType: 'raw_event' | 'chat_message',
  sourceId: string,
  timestamp: number,
  reference: {
    rawEventId?: string;
    chatMessageId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO memory_sources (
      memory_id, source_type, source_id, source_timestamp, extracted_by,
      resolution_state, raw_event_id, chat_message_id
    ) VALUES (?, ?, ?, ?, ?, 'internal', ?, ?)`
  ).run(
    memoryId,
    sourceType,
    sourceId,
    timestamp,
    'test',
    reference.rawEventId ?? null,
    reference.chatMessageId ?? null,
  );
}

function insertExtractionJob(
  db: ReturnType<typeof initDatabase>,
  input: {
    id: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    sourceChatMessageId: string;
    timestamp: number;
    payload?: string;
  },
): void {
  db.prepare(
    `INSERT INTO jobs (
      id, type, payload, status, attempts, max_attempts,
      created_at, updated_at, scheduled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    'extraction',
    input.payload ?? JSON.stringify({
      sourceChatMessageId: input.sourceChatMessageId,
      targetUserId: 'user-retention-source',
    }),
    input.status,
    input.status === 'pending' ? 0 : 1,
    3,
    input.timestamp,
    input.timestamp,
    input.timestamp,
  );
}

function insertMemoryActionExecution(
  db: ReturnType<typeof initDatabase>,
  memoryId: string,
  rawEventId: string,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO agent_turns (
      id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'turn-memory-retention',
    'private:qq-1',
    rawEventId,
    'mock',
    'mock',
    'completed',
    timestamp,
    timestamp,
  );
  db.prepare(
    `INSERT INTO action_decisions (
      id, turn_id, decided_by, risk_level, confidence,
      evaluator_required, actions, reasons, suppressors, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'decision-memory-retention',
    'turn-memory-retention',
    'evaluator',
    'medium',
    0.9,
    1,
    '[]',
    '[]',
    '[]',
    timestamp,
  );
  db.prepare(
    `INSERT INTO action_executions (
      id, action_decision_id, action_type, status,
      executed_memory_id, audit_level, executed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'execution-memory-retention',
    'decision-memory-retention',
    'propose_memory',
    'success',
    memoryId,
    'summary',
    timestamp,
  );
}

function count(db: ReturnType<typeof initDatabase>, table: string, column: string, value: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(value) as { count: number };
  return row.count;
}
