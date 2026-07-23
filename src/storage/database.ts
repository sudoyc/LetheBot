/**
 * Database Connection & Setup
 *
 * SQLite 数据库连接和初始化
 */

import Database from 'better-sqlite3';
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { redactSecretsInText } from '../memory/secret-scan.js';
import { readMigrationPlan } from './migration-plan.js';
import { CURRENT_SCHEMA_VERSION } from './schema-version.js';

const PRIVATE_DATABASE_MODE = 0o600;
const INITIAL_SCHEMA_VERSION = 1;
const INITIAL_SCHEMA_DESCRIPTION = 'Initial schema';

type SchemaVersionState =
  | { kind: 'absent' }
  | { kind: 'empty' }
  | { kind: 'versioned'; versions: number[] };

type SchemaVersionErrorCode =
  | 'malformed-schema-version'
  | 'future-schema-version'
  | 'incompatible-schema';

interface SchemaColumnShape {
  name: string;
  type: string;
  notnull: number;
  defaultValue: string;
  pk: number;
  hidden: number;
}

interface SchemaIndexShape {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  columns: Array<{
    name: string | null;
    desc: number;
    coll: string;
  }>;
  predicate: string;
}

class SchemaVersionError extends Error {
  constructor(readonly code: SchemaVersionErrorCode, message: string) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

export interface DatabaseConfig {
  path: string;
  readonly?: boolean;
  verbose?: boolean;
}

/**
 * 初始化数据库连接
 */
export function initDatabase(config: DatabaseConfig): Database.Database {
  const readonly = config.readonly ?? false;
  const privateDatabasePath = readonly
    ? undefined
    : preparePrivateDatabasePath(config.path);
  const db = new Database(config.path, {
    readonly,
    verbose: config.verbose ? logVerboseSql : undefined,
  });

  try {
    // 启用外键约束
    db.pragma('foreign_keys = ON');

    // 启用 WAL 模式以提高并发性能
    if (!readonly) {
      db.pragma('journal_mode = WAL');
      if (privateDatabasePath) {
        enforcePrivateDatabaseFiles(privateDatabasePath);
      }
    }

    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization failure that made the handle unusable.
    }
    throw error;
  }
}

function preparePrivateDatabasePath(path: string): string | undefined {
  if (process.platform === 'win32' || path === '' || path === ':memory:') {
    return undefined;
  }

  let fd: number;
  try {
    fd = openSync(path, 'a', PRIVATE_DATABASE_MODE);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error('Cannot open database because the directory does not exist', {
        cause: error,
      });
    }
    throw error;
  }
  closeSync(fd);

  const resolvedPath = realpathSync(path);
  enforcePrivateDatabaseFiles(resolvedPath);
  return resolvedPath;
}

function enforcePrivateDatabaseFiles(databasePath: string): void {
  chmodSync(databasePath, PRIVATE_DATABASE_MODE);
  chmodPrivateIfPresent(`${databasePath}-wal`);
  chmodPrivateIfPresent(`${databasePath}-shm`);
}

function chmodPrivateIfPresent(path: string): void {
  try {
    chmodSync(path, PRIVATE_DATABASE_MODE);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function logVerboseSql(message?: unknown, ...additionalArgs: unknown[]): void {
  const parts = [message, ...additionalArgs]
    .filter((part) => part !== undefined)
    .map((part) => redactSqlForDisplay(String(part)));
  console.log(parts.join(' '));
}

function redactSqlForDisplay(sql: string): string {
  const platformRedacted = redactPlatformIdentifiers(sql);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(sql: string): string {
  return sql
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

/**
 * 执行当前版本的有序迁移集合
 */
export function runMigrations(
  db: Database.Database,
  migrationDirectory: string,
  targetVersion = CURRENT_SCHEMA_VERSION,
): void {
  if (targetVersion !== CURRENT_SCHEMA_VERSION) {
    throw new RangeError('Migration target must match the current application schema version.');
  }

  const migrations = readMigrationPlan(migrationDirectory, targetVersion);
  if (
    migrations.length !== targetVersion
    || migrations[0]?.version !== INITIAL_SCHEMA_VERSION
    || migrations.at(-1)?.version !== CURRENT_SCHEMA_VERSION
  ) {
    throw new RangeError('This release does not implement the requested migration sequence.');
  }

  const migrationSql = migrations.map((migration) => readFileSync(migration.path, 'utf-8'));
  const initialSql = migrationSql[0];
  if (initialSql === undefined) {
    throw new RangeError('This release does not implement the requested migration sequence.');
  }
  const initialVersionState = inspectSchemaVersion(db);
  assertSupportedSchemaVersion(initialVersionState, targetVersion);

  if (isFinalizedSchemaVersion(initialVersionState, targetVersion)) {
    assertCurrentSchemaCompatible(db, migrationSql);
    assertEvaluatorDecisionObjectsMatch(db, migrationSql);
    return;
  }

  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    db.transaction(() => {
      const transactionVersionState = inspectSchemaVersion(db);
      assertSupportedSchemaVersion(transactionVersionState, targetVersion);
      if (isFinalizedSchemaVersion(transactionVersionState, targetVersion)) {
        assertCurrentSchemaCompatible(db, migrationSql);
        assertEvaluatorDecisionObjectsMatch(db, migrationSql);
        return;
      }

      let appliedVersion = transactionVersionState.kind === 'versioned'
        ? transactionVersionState.versions.at(-1) ?? 0
        : 0;

      if (appliedVersion <= INITIAL_SCHEMA_VERSION) {
        applyInitialSchemaMigration(db, initialSql);
        if (appliedVersion === 0) {
          recordSchemaVersion(
            db,
            INITIAL_SCHEMA_VERSION,
            migrations[0]?.description ?? INITIAL_SCHEMA_DESCRIPTION,
          );
        }
        assertFinalizedSchemaVersion(db, INITIAL_SCHEMA_VERSION);
        assertCurrentSchemaCompatible(db, initialSql);
        assertEvaluatorDecisionObjectsMatch(db, initialSql);
        appliedVersion = INITIAL_SCHEMA_VERSION;
      } else {
        const appliedSql = migrationSql.slice(0, appliedVersion);
        assertCurrentSchemaCompatible(db, appliedSql);
        assertEvaluatorDecisionObjectsMatch(db, appliedSql);
      }

      for (let version = appliedVersion + 1; version <= targetVersion; version += 1) {
        const sql = migrationSql[version - 1];
        const migration = migrations[version - 1];
        if (sql === undefined || migration?.version !== version) {
          throw new RangeError('This release does not implement the requested migration sequence.');
        }

        db.exec(sql);
        const expectedSql = migrationSql.slice(0, version);
        assertCurrentSchemaCompatible(db, expectedSql);
        assertEvaluatorDecisionObjectsMatch(db, expectedSql);
        recordSchemaVersion(db, version, migration.description);
        assertFinalizedSchemaVersion(db, version);
      }

      assertFinalizedSchemaVersion(db, targetVersion);
    }).immediate();
  } finally {
    if (foreignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }
}

/**
 * 执行 SQL 迁移
 */
export function runMigration(db: Database.Database, migrationPath: string): void {
  const sql = readFileSync(migrationPath, 'utf-8');
  const requiresMemoryConstraintRebuild = hasNonCurrentMemoryConstraint(db, sql);
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;

  if (requiresMemoryConstraintRebuild && foreignKeysEnabled) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    db.transaction(() => {
      const initialVersionState = inspectSchemaVersion(db);
      assertSupportedSchemaVersion(initialVersionState, INITIAL_SCHEMA_VERSION);

      applyInitialSchemaMigration(db, sql);

      if (initialVersionState.kind !== 'versioned') {
        recordSchemaVersion(db, INITIAL_SCHEMA_VERSION, INITIAL_SCHEMA_DESCRIPTION);
      }
      assertFinalizedSchemaVersion(db, INITIAL_SCHEMA_VERSION);
    }).immediate();
  } finally {
    if (requiresMemoryConstraintRebuild && foreignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }
}

function applyInitialSchemaMigration(db: Database.Database, sql: string): void {
  const memoryFtsWasMissing = !tableExists(db, 'memory_fts');
  applyPreMigrationCompatibleSchemaPatches(db);
  rebuildKnownLegacyMemoryConstraints(db, sql);
  db.exec(sql);
  applyCompatibleSchemaPatches(db);
  if (memoryFtsWasMissing) {
    rebuildMemoryFts(db);
  }
  assertCurrentSchemaCompatible(db, sql);
}

function inspectSchemaVersion(db: Database.Database): SchemaVersionState {
  const objects = db.prepare(
    'SELECT type FROM sqlite_schema WHERE name = ? ORDER BY type',
  ).all('schema_version') as Array<{ type: string }>;
  if (objects.length === 0) {
    return { kind: 'absent' };
  }
  if (objects.length !== 1 || objects[0]?.type !== 'table') {
    throwMalformedSchemaVersion();
  }

  const columns = db.prepare('PRAGMA table_info("schema_version")').all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }>;
  const expectedColumns = [
    { name: 'version', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'description', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'applied_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ];
  if (
    columns.length !== expectedColumns.length
    || columns.some((column, index) => {
      const expected = expectedColumns[index];
      return expected === undefined
        || column.name !== expected.name
        || column.type.toUpperCase() !== expected.type
        || column.notnull !== expected.notnull
        || column.pk !== expected.pk
        || column.dflt_value !== null;
    })
  ) {
    throwMalformedSchemaVersion();
  }

  const rows = db.prepare(`
    SELECT version, description, applied_at,
           typeof(version) AS version_type,
           typeof(description) AS description_type,
           typeof(applied_at) AS applied_at_type
      FROM schema_version
     ORDER BY version
  `).all() as Array<{
    version: unknown;
    description: unknown;
    applied_at: unknown;
    version_type: string;
    description_type: string;
    applied_at_type: string;
  }>;
  if (rows.length === 0) {
    return { kind: 'empty' };
  }

  const versions: number[] = [];
  for (const row of rows) {
    if (
      row.version_type !== 'integer'
      || typeof row.version !== 'number'
      || !Number.isSafeInteger(row.version)
      || row.version <= 0
      || row.description_type !== 'text'
      || typeof row.description !== 'string'
      || row.description.trim() === ''
      || row.applied_at_type !== 'integer'
      || typeof row.applied_at !== 'number'
      || !Number.isSafeInteger(row.applied_at)
      || row.applied_at < 0
    ) {
      throwMalformedSchemaVersion();
    }
    versions.push(row.version);
  }
  if (versions.some((version, index) => version !== index + 1)) {
    throwMalformedSchemaVersion();
  }

  return { kind: 'versioned', versions };
}

function assertSupportedSchemaVersion(
  state: SchemaVersionState,
  maximumVersion: number,
): void {
  if (state.kind !== 'versioned') {
    return;
  }

  const latestVersion = state.versions.at(-1);
  if (latestVersion !== undefined && latestVersion > maximumVersion) {
    throw new SchemaVersionError(
      'future-schema-version',
      'Database schema is newer than this LetheBot release.',
    );
  }
}

function isFinalizedSchemaVersion(state: SchemaVersionState, version: number): boolean {
  return state.kind === 'versioned'
    && state.versions.length === version
    && state.versions.at(-1) === version;
}

function assertFinalizedSchemaVersion(db: Database.Database, version: number): void {
  if (!isFinalizedSchemaVersion(inspectSchemaVersion(db), version)) {
    throw new SchemaVersionError(
      'malformed-schema-version',
      'Schema version metadata was not finalized by the migration.',
    );
  }
}

function throwMalformedSchemaVersion(): never {
  throw new SchemaVersionError(
    'malformed-schema-version',
    'Schema version metadata is malformed.',
  );
}

function applyPreMigrationCompatibleSchemaPatches(db: Database.Database): void {
  addLegacyJobColumns(db);

  if (tableExists(db, 'raw_events') && !columnExists(db, 'raw_events', 'platform_event_id')) {
    db.exec('ALTER TABLE raw_events ADD COLUMN platform_event_id TEXT');
  }

  if (tableExists(db, 'action_decisions') && !columnExists(db, 'action_decisions', 'evaluator_decision_id')) {
    db.exec(
      'ALTER TABLE action_decisions ADD COLUMN evaluator_decision_id TEXT REFERENCES evaluator_decisions(id)'
    );
  }

  if (tableExists(db, 'action_decisions') && !columnExists(db, 'action_decisions', 'execution_binding')) {
    db.exec('ALTER TABLE action_decisions ADD COLUMN execution_binding TEXT');
  }

  if (tableExists(db, 'evaluator_decisions') && !columnExists(db, 'evaluator_decisions', 'tool_name')) {
    db.exec('ALTER TABLE evaluator_decisions ADD COLUMN tool_name TEXT');
  }

  if (tableExists(db, 'tool_calls') && !columnExists(db, 'tool_calls', 'evaluator_decision_id')) {
    db.exec(
      `ALTER TABLE tool_calls
       ADD COLUMN evaluator_decision_id TEXT
       REFERENCES evaluator_decisions(id) ON DELETE RESTRICT`
    );
  }

  addMemorySourceResolutionColumns(db);
}

function addLegacyJobColumns(db: Database.Database): void {
  if (!tableExists(db, 'jobs')) {
    return;
  }

  const columns: ReadonlyArray<readonly [string, string]> = [
    ['idempotency_key', 'idempotency_key TEXT'],
    ['lease_owner', 'lease_owner TEXT'],
    ['lease_expires_at', 'lease_expires_at INTEGER'],
    ['heartbeat_at', 'heartbeat_at INTEGER'],
  ];
  for (const [columnName, definition] of columns) {
    if (!columnExists(db, 'jobs', columnName)) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${definition}`);
    }
  }

  const addCreatedAt = !columnExists(db, 'jobs', 'created_at');
  if (addCreatedAt) {
    db.exec('ALTER TABLE jobs ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE jobs
         SET created_at = COALESCE(scheduled_at, started_at, completed_at, 0)
    `);
  }

  const addUpdatedAt = !columnExists(db, 'jobs', 'updated_at');
  if (addUpdatedAt) {
    db.exec('ALTER TABLE jobs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE jobs
         SET updated_at = COALESCE(completed_at, heartbeat_at, started_at, scheduled_at, created_at, 0)
    `);
  }
}

function applyCompatibleSchemaPatches(db: Database.Database): void {
  if (tableExists(db, 'raw_events') && columnExists(db, 'raw_events', 'platform_event_id')) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_platform_event
       ON raw_events(platform, type, conversation_id, platform_event_id)
       WHERE source = 'gateway' AND platform_event_id IS NOT NULL AND conversation_id IS NOT NULL`
    );
  }

  applyMemorySourceResolutionPatch(db);

  if (
    tableExists(db, 'action_executions')
    && tableExists(db, 'jobs')
    && !columnExists(db, 'action_executions', 'executed_job_id')
  ) {
    db.exec('ALTER TABLE action_executions ADD COLUMN executed_job_id TEXT REFERENCES jobs(id)');
  }

  if (
    tableExists(db, 'action_executions')
    && tableExists(db, 'memory_records')
    && !columnExists(db, 'action_executions', 'executed_memory_id')
  ) {
    db.exec('ALTER TABLE action_executions ADD COLUMN executed_memory_id TEXT REFERENCES memory_records(id)');
  }

  if (tableExists(db, 'action_executions') && columnExists(db, 'action_executions', 'executed_memory_id')) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_action_executions_memory ON action_executions(executed_memory_id)'
    );
  }

  if (tableExists(db, 'action_executions') && columnExists(db, 'action_executions', 'executed_job_id')) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_action_executions_job ON action_executions(executed_job_id)'
    );
  }


  if (tableExists(db, 'action_decisions') && columnExists(db, 'action_decisions', 'evaluator_decision_id')) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_action_decisions_evaluator ON action_decisions(evaluator_decision_id)'
    );
  }

  if (tableExists(db, 'tool_calls') && columnExists(db, 'tool_calls', 'evaluator_decision_id')) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_tool_calls_evaluator ON tool_calls(evaluator_decision_id)'
    );
  }
}

function addMemorySourceResolutionColumns(db: Database.Database): void {
  if (!tableExists(db, 'memory_sources')) {
    return;
  }

  const columns: ReadonlyArray<readonly [string, string]> = [
    [
      'resolution_state',
      `resolution_state TEXT NOT NULL DEFAULT 'legacy_unresolved'
       CHECK(resolution_state IN ('internal', 'external', 'legacy_unresolved'))`,
    ],
    ['raw_event_id', 'raw_event_id TEXT REFERENCES raw_events(id) ON DELETE RESTRICT'],
    ['chat_message_id', 'chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE RESTRICT'],
    ['tool_call_id', 'tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE RESTRICT'],
    ['job_id', 'job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT'],
    ['job_attempt_id', 'job_attempt_id TEXT REFERENCES job_attempts(id) ON DELETE RESTRICT'],
  ];

  for (const [columnName, definition] of columns) {
    if (!columnExists(db, 'memory_sources', columnName)) {
      db.exec(`ALTER TABLE memory_sources ADD COLUMN ${definition}`);
    }
  }
}

function applyMemorySourceResolutionPatch(db: Database.Database): void {
  const requiredColumns = [
    'resolution_state',
    'raw_event_id',
    'chat_message_id',
    'tool_call_id',
    'job_id',
    'job_attempt_id',
  ];
  if (
    !tableExists(db, 'memory_sources')
    || !requiredColumns.every((column) => columnExists(db, 'memory_sources', column))
  ) {
    return;
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_sources_resolution
      ON memory_sources(resolution_state, source_type, source_id, memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_sources_raw_event
      ON memory_sources(raw_event_id) WHERE raw_event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_sources_chat_message
      ON memory_sources(chat_message_id) WHERE chat_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_sources_tool_call
      ON memory_sources(tool_call_id) WHERE tool_call_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_sources_job
      ON memory_sources(job_id) WHERE job_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_sources_job_attempt
      ON memory_sources(job_attempt_id) WHERE job_attempt_id IS NOT NULL;
  `);

  const referenceTables = ['raw_events', 'chat_messages', 'tool_calls', 'jobs', 'job_attempts'];
  if (!referenceTables.every((table) => tableExists(db, table))) {
    return;
  }

  db.exec(`
    UPDATE memory_sources
       SET resolution_state = 'internal',
           raw_event_id = source_id
     WHERE resolution_state = 'legacy_unresolved'
       AND source_type = 'raw_event'
       AND raw_event_id IS NULL
       AND chat_message_id IS NULL
       AND tool_call_id IS NULL
       AND job_id IS NULL
       AND job_attempt_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM raw_events
          WHERE raw_events.id = memory_sources.source_id
       );

    UPDATE memory_sources
       SET resolution_state = 'internal',
           chat_message_id = source_id
     WHERE resolution_state = 'legacy_unresolved'
       AND source_type = 'chat_message'
       AND raw_event_id IS NULL
       AND chat_message_id IS NULL
       AND tool_call_id IS NULL
       AND job_id IS NULL
       AND job_attempt_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM chat_messages
          WHERE chat_messages.id = memory_sources.source_id
       );

    UPDATE memory_sources
       SET resolution_state = 'internal',
           chat_message_id = (
             SELECT chat_messages.id
               FROM chat_messages
              WHERE chat_messages.message_id = memory_sources.source_id
              LIMIT 1
           )
     WHERE resolution_state = 'legacy_unresolved'
       AND source_type = 'chat_message'
       AND raw_event_id IS NULL
       AND chat_message_id IS NULL
       AND tool_call_id IS NULL
       AND job_id IS NULL
       AND job_attempt_id IS NULL
       AND (
         SELECT COUNT(*)
           FROM chat_messages
          WHERE chat_messages.message_id = memory_sources.source_id
       ) = 1;

    UPDATE memory_sources
       SET resolution_state = 'internal',
           tool_call_id = source_id
     WHERE resolution_state = 'legacy_unresolved'
       AND source_type = 'tool_output'
       AND raw_event_id IS NULL
       AND chat_message_id IS NULL
       AND tool_call_id IS NULL
       AND job_id IS NULL
       AND job_attempt_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM tool_calls
          WHERE tool_calls.id = memory_sources.source_id
            AND tool_calls.status = 'success'
       );
  `);

  backfillLegacyWorkerSources(db);
}

interface LegacyWorkerSourceCandidate {
  memory_id: string;
  source_id: string;
  source_kind: 'job' | 'attempt';
  canonical_id: string;
  payload: string;
  result: string | null;
  attempt_result: string | null;
}

interface CanonicalMemorySourceEvidence {
  raw_event_id: string | null;
  chat_message_id: string | null;
}

function backfillLegacyWorkerSources(db: Database.Database): void {
  const candidates = db.prepare(
    `SELECT source.memory_id,
            source.source_id,
            'job' AS source_kind,
            jobs.id AS canonical_id,
            jobs.payload,
            jobs.result,
            NULL AS attempt_result
       FROM memory_sources AS source
       JOIN jobs ON jobs.id = source.source_id
      WHERE source.source_type = 'worker_extraction'
        AND source.resolution_state = 'legacy_unresolved'
        AND source.raw_event_id IS NULL
        AND source.chat_message_id IS NULL
        AND source.tool_call_id IS NULL
        AND source.job_id IS NULL
        AND source.job_attempt_id IS NULL
        AND jobs.type = 'extraction'
        AND jobs.status = 'completed'
      UNION ALL
     SELECT source.memory_id,
            source.source_id,
            'attempt' AS source_kind,
            job_attempts.id AS canonical_id,
            jobs.payload,
            jobs.result,
            job_attempts.result AS attempt_result
       FROM memory_sources AS source
       JOIN job_attempts ON job_attempts.id = source.source_id
       JOIN jobs ON jobs.id = job_attempts.job_id
      WHERE source.source_type = 'worker_extraction'
        AND source.resolution_state = 'legacy_unresolved'
        AND source.raw_event_id IS NULL
        AND source.chat_message_id IS NULL
        AND source.tool_call_id IS NULL
        AND source.job_id IS NULL
        AND source.job_attempt_id IS NULL
        AND job_attempts.status = 'completed'
        AND jobs.type = 'extraction'
        AND jobs.status = 'completed'
      ORDER BY memory_id, source_id, source_kind`,
  ).all() as LegacyWorkerSourceCandidate[];

  const candidatesBySource = new Map<string, LegacyWorkerSourceCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.memory_id}\u0000${candidate.source_id}`;
    const existing = candidatesBySource.get(key) ?? [];
    existing.push(candidate);
    candidatesBySource.set(key, existing);
  }

  const readEvidence = db.prepare(
    `SELECT raw_event_id, chat_message_id
       FROM memory_sources
      WHERE memory_id = ?
        AND resolution_state = 'internal'
        AND (
          (
            source_type = 'raw_event'
            AND raw_event_id IS NOT NULL
            AND chat_message_id IS NULL
            AND tool_call_id IS NULL
            AND job_id IS NULL
            AND job_attempt_id IS NULL
          )
          OR (
            source_type = 'chat_message'
            AND raw_event_id IS NULL
            AND chat_message_id IS NOT NULL
            AND tool_call_id IS NULL
            AND job_id IS NULL
            AND job_attempt_id IS NULL
          )
        )`,
  );
  const updateJobSource = db.prepare(
    `UPDATE memory_sources
        SET resolution_state = 'internal', job_id = ?
      WHERE memory_id = ?
        AND source_id = ?
        AND source_type = 'worker_extraction'
        AND resolution_state = 'legacy_unresolved'
        AND raw_event_id IS NULL
        AND chat_message_id IS NULL
        AND tool_call_id IS NULL
        AND job_id IS NULL
        AND job_attempt_id IS NULL`,
  );
  const updateAttemptSource = db.prepare(
    `UPDATE memory_sources
        SET resolution_state = 'internal', job_attempt_id = ?
      WHERE memory_id = ?
        AND source_id = ?
        AND source_type = 'worker_extraction'
        AND resolution_state = 'legacy_unresolved'
        AND raw_event_id IS NULL
        AND chat_message_id IS NULL
        AND tool_call_id IS NULL
        AND job_id IS NULL
        AND job_attempt_id IS NULL`,
  );

  for (const sourceCandidates of candidatesBySource.values()) {
    if (sourceCandidates.length !== 1) {
      continue;
    }
    const candidate = sourceCandidates[0];
    if (!candidate) {
      continue;
    }
    const evidence = readEvidence.all(candidate.memory_id) as CanonicalMemorySourceEvidence[];
    if (!workerCandidateReferencesEvidence(candidate, evidence)) {
      continue;
    }

    if (candidate.source_kind === 'job') {
      updateJobSource.run(candidate.canonical_id, candidate.memory_id, candidate.source_id);
    } else {
      updateAttemptSource.run(candidate.canonical_id, candidate.memory_id, candidate.source_id);
    }
  }
}

function workerCandidateReferencesEvidence(
  candidate: LegacyWorkerSourceCandidate,
  evidence: CanonicalMemorySourceEvidence[],
): boolean {
  const references = {
    rawEventIds: new Set<string>(),
    chatMessageIds: new Set<string>(),
  };
  for (const value of [candidate.payload, candidate.result, candidate.attempt_result]) {
    if (!value) {
      continue;
    }
    try {
      collectWorkerSourceReferences(JSON.parse(value) as unknown, references);
    } catch {
      continue;
    }
  }

  return evidence.some((source) =>
    (source.raw_event_id !== null && references.rawEventIds.has(source.raw_event_id))
    || (source.chat_message_id !== null && references.chatMessageIds.has(source.chat_message_id)),
  );
}

function collectWorkerSourceReferences(
  value: unknown,
  output: { rawEventIds: Set<string>; chatMessageIds: Set<string> },
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWorkerSourceReferences(item, output);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();
    if (normalizedKey === 'raweventid' || normalizedKey === 'sourceraweventid') {
      addWorkerSourceReference(output.rawEventIds, nestedValue);
    }
    if (normalizedKey === 'chatmessageid' || normalizedKey === 'sourcechatmessageid') {
      addWorkerSourceReference(output.chatMessageIds, nestedValue);
    }
    collectWorkerSourceReferences(nestedValue, output);
  }
}

function addWorkerSourceReference(target: Set<string>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      addWorkerSourceReference(target, item);
    }
    return;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    target.add(value.trim());
  }
}

const MEMORY_CONSTRAINT_TABLES = [
  'memory_records',
  'memory_revisions',
  'memory_sources',
] as const;

type MemoryConstraintTable = typeof MEMORY_CONSTRAINT_TABLES[number];

function hasNonCurrentMemoryConstraint(
  db: Database.Database,
  migrationSql: string,
): boolean {
  const expected = createExpectedSchemaDatabase(migrationSql);
  try {
    return MEMORY_CONSTRAINT_TABLES.some((tableName) => {
      const actualTable = readSchemaObject(db, 'table', tableName);
      const expectedTable = readSchemaObject(expected, 'table', tableName);
      return actualTable !== undefined
        && expectedTable !== undefined
        && JSON.stringify(extractCheckExpressions(actualTable.sql))
          !== JSON.stringify(extractCheckExpressions(expectedTable.sql));
    });
  } finally {
    expected.close();
  }
}

function rebuildKnownLegacyMemoryConstraints(
  db: Database.Database,
  migrationSql: string,
): void {
  const expected = createExpectedSchemaDatabase(migrationSql);
  try {
    for (const tableName of MEMORY_CONSTRAINT_TABLES) {
      const actualTable = readSchemaObject(db, 'table', tableName);
      const expectedTable = readSchemaObject(expected, 'table', tableName);
      if (!actualTable || !expectedTable) {
        continue;
      }

      if (
        normalizeCreateTableSql(actualTable.sql, tableName)
        === normalizeCreateTableSql(expectedTable.sql, tableName)
      ) {
        continue;
      }
      if (
        normalizeCreateTableSql(actualTable.sql, tableName)
        !== knownLegacyTableSql(tableName, expectedTable.sql)
      ) {
        continue;
      }
      if (db.pragma('foreign_keys', { simple: true }) !== 0) {
        throwIncompatibleSchema();
      }

      rebuildTableFromReference(db, expected, tableName, expectedTable.sql);
    }
  } finally {
    expected.close();
  }
}

function knownLegacyTableSql(
  tableName: MemoryConstraintTable,
  expectedSql: string | null,
): string {
  if (expectedSql === null) {
    throwIncompatibleSchema();
  }
  if (tableName === 'memory_sources') {
    return createLegacyMemorySourcesTableSql();
  }

  const current = tableName === 'memory_records'
    ? "state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'rejected', 'superseded', 'disabled', 'deleted'))"
    : "change_type TEXT NOT NULL CHECK(change_type IN ('create', 'update', 'approve', 'reject', 'supersede', 'disable', 'delete', 'restore'))";
  const legacy = tableName === 'memory_records'
    ? "state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'superseded', 'disabled', 'deleted'))"
    : "change_type TEXT NOT NULL CHECK(change_type IN ('create', 'update', 'supersede', 'disable', 'delete', 'restore'))";
  const legacySql = expectedSql.replace(current, legacy);
  if (legacySql === expectedSql) {
    throwIncompatibleSchema();
  }
  return normalizeCreateTableSql(legacySql, tableName);
}

function createLegacyMemorySourcesTableSql(): string {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`
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
      )
    `);
    addMemorySourceResolutionColumns(legacy);
    const table = readSchemaObject(legacy, 'table', 'memory_sources');
    if (!table) {
      throwIncompatibleSchema();
    }
    return normalizeCreateTableSql(table.sql, 'memory_sources');
  } finally {
    legacy.close();
  }
}

function normalizeCreateTableSql(
  sql: string | null,
  tableName: MemoryConstraintTable,
): string {
  const normalized = normalizeSql(sql);
  const prefixes = [
    `createtableifnotexists${tableName}`,
    `createtableifnotexists"${tableName}"`,
    `createtableifnotexists\`${tableName}\``,
    `createtableifnotexists[${tableName}]`,
    `createtable${tableName}`,
    `createtable"${tableName}"`,
    `createtable\`${tableName}\``,
    `createtable[${tableName}]`,
  ];
  const prefix = prefixes.find((candidate) => normalized.startsWith(candidate));
  if (!prefix) {
    return normalized;
  }
  return `createtable<${tableName}>${normalized.slice(prefix.length)}`;
}

function rebuildTableFromReference(
  db: Database.Database,
  expected: Database.Database,
  tableName: MemoryConstraintTable,
  expectedSql: string | null,
): void {
  const openingParenthesis = expectedSql?.indexOf('(') ?? -1;
  if (expectedSql === null || openingParenthesis < 0) {
    throwIncompatibleSchema();
  }

  const temporaryTable = `__lethebot_rebuild_${tableName}`;
  const dependentSql = (db.prepare(
    `SELECT sql
       FROM sqlite_schema
      WHERE tbl_name = ?
        AND type IN ('index', 'trigger')
        AND sql IS NOT NULL
      ORDER BY type, name`,
  ).all(tableName) as Array<{ sql: string }>).map((object) => object.sql);
  const columns = readVisibleColumnNames(expected, tableName);
  const quotedColumns = columns.map(quoteIdentifier).join(', ');

  db.exec(
    `CREATE TABLE ${quoteIdentifier(temporaryTable)} ${expectedSql.slice(openingParenthesis)}`,
  );
  db.exec(
    `INSERT INTO ${quoteIdentifier(temporaryTable)} (rowid, ${quotedColumns})
     SELECT rowid, ${quotedColumns} FROM ${quoteIdentifier(tableName)}`,
  );
  db.exec(`DROP TABLE ${quoteIdentifier(tableName)}`);
  db.exec(
    `ALTER TABLE ${quoteIdentifier(temporaryTable)} RENAME TO ${quoteIdentifier(tableName)}`,
  );
  for (const sql of dependentSql) {
    db.exec(sql);
  }
}

function readVisibleColumnNames(db: Database.Database, tableName: string): string[] {
  return (db.prepare(
    `PRAGMA table_xinfo(${quoteIdentifier(tableName)})`,
  ).all() as Array<{ cid: number; name: string; hidden: number }>)
    .filter((column) => column.hidden === 0)
    .sort((left, right) => left.cid - right.cid)
    .map((column) => column.name);
}

function createExpectedSchemaDatabase(
  migrationSql: string | readonly string[],
): Database.Database {
  const expected = new Database(':memory:');
  try {
    const migrations = typeof migrationSql === 'string' ? [migrationSql] : migrationSql;
    const initialSql = migrations[0];
    if (initialSql === undefined) {
      throw new Error('Expected schema requires at least one migration.');
    }

    expected.pragma('foreign_keys = OFF');
    applyPreMigrationCompatibleSchemaPatches(expected);
    expected.exec(initialSql);
    applyCompatibleSchemaPatches(expected);
    for (const sql of migrations.slice(1)) {
      expected.exec(sql);
    }
    expected.pragma('foreign_keys = ON');
    return expected;
  } catch (error) {
    expected.close();
    throw error;
  }
}

function rebuildMemoryFts(db: Database.Database): void {
  if (!tableExists(db, 'memory_records') || !tableExists(db, 'memory_fts')) {
    throwIncompatibleSchema();
  }
  db.prepare("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')").run();
  db.prepare(
    "INSERT INTO memory_fts(memory_fts, rank) VALUES ('integrity-check', 1)",
  ).run();
}

function assertCurrentSchemaCompatible(
  db: Database.Database,
  migrationSql: string | readonly string[],
): void {
  const expected = createExpectedSchemaDatabase(migrationSql);
  try {
    const expectedTables = readSchemaObjects(expected, 'table');
    for (const expectedTable of expectedTables) {
      const actualTable = readSchemaObject(db, 'table', expectedTable.name);
      if (!actualTable) {
        throwIncompatibleSchema();
      }

      if (
        JSON.stringify(readColumnShapes(db, expectedTable.name))
        !== JSON.stringify(readColumnShapes(expected, expectedTable.name))
        || JSON.stringify(readForeignKeyShapes(db, expectedTable.name))
        !== JSON.stringify(readForeignKeyShapes(expected, expectedTable.name))
        || !hasRequiredIndexes(db, expected, expectedTable.name)
        || !hasCompatibleChecks(actualTable.sql, expectedTable.sql)
      ) {
        throwIncompatibleSchema();
      }

      if (
        expectedTable.sql !== null
        && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(expectedTable.sql)
        && normalizeSql(actualTable.sql) !== normalizeSql(expectedTable.sql)
      ) {
        throwIncompatibleSchema();
      }
    }

    const expectedTriggers = readSchemaObjects(expected, 'trigger');
    for (const expectedTrigger of expectedTriggers) {
      const actualTrigger = readSchemaObject(db, 'trigger', expectedTrigger.name);
      if (
        !actualTrigger
        || actualTrigger.tblName !== expectedTrigger.tblName
        || normalizeSql(actualTrigger.sql) !== normalizeSql(expectedTrigger.sql)
      ) {
        throwIncompatibleSchema();
      }
    }

    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throwIncompatibleSchema();
    }
  } finally {
    expected.close();
  }
}

function assertEvaluatorDecisionObjectsMatch(
  db: Database.Database,
  migrationSql: string | readonly string[],
): void {
  const expected = createExpectedSchemaDatabase(migrationSql);
  try {
    const actualTable = readSchemaObject(db, 'table', 'evaluator_decisions');
    const expectedTable = readSchemaObject(expected, 'table', 'evaluator_decisions');
    if (
      !actualTable
      || !expectedTable
      || normalizeSql(actualTable.sql) !== normalizeSql(expectedTable.sql)
    ) {
      throwIncompatibleSchema();
    }

    const actualObjects = readEvaluatorDecisionDependentObjects(db);
    const expectedObjects = readEvaluatorDecisionDependentObjects(expected);
    if (JSON.stringify(actualObjects) !== JSON.stringify(expectedObjects)) {
      throwIncompatibleSchema();
    }
  } finally {
    expected.close();
  }
}

function readEvaluatorDecisionDependentObjects(
  db: Database.Database,
): Array<{ type: string; name: string; sql: string }> {
  return (db.prepare(
    `SELECT type, name, sql
       FROM sqlite_schema
      WHERE tbl_name = 'evaluator_decisions'
        AND type IN ('index', 'trigger')
      ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string; sql: string | null }>).map((object) => ({
    type: object.type,
    name: object.name,
    sql: normalizeSql(object.sql),
  }));
}

interface SchemaObjectShape {
  name: string;
  tblName: string;
  sql: string | null;
}

function readSchemaObjects(
  db: Database.Database,
  type: 'table' | 'trigger',
): SchemaObjectShape[] {
  return (db.prepare(
    `SELECT name, tbl_name, sql
       FROM sqlite_schema
      WHERE type = ?
      ORDER BY name`,
  ).all(type) as Array<{ name: string; tbl_name: string; sql: string | null }>)
    .filter((object) => !object.name.startsWith('sqlite_'))
    .map((object) => ({
      name: object.name,
      tblName: object.tbl_name,
      sql: object.sql,
    }));
}

function readSchemaObject(
  db: Database.Database,
  type: 'table' | 'trigger',
  name: string,
): SchemaObjectShape | undefined {
  const object = db.prepare(
    `SELECT name, tbl_name, sql
       FROM sqlite_schema
      WHERE type = ? AND name = ?`,
  ).get(type, name) as
    | { name: string; tbl_name: string; sql: string | null }
    | undefined;
  return object
    ? { name: object.name, tblName: object.tbl_name, sql: object.sql }
    : undefined;
}

function readColumnShapes(db: Database.Database, tableName: string): SchemaColumnShape[] {
  const columns = db.prepare(
    `PRAGMA table_xinfo(${quoteIdentifier(tableName)})`,
  ).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
    hidden: number;
  }>;
  return columns
    .map((column) => ({
      name: column.name,
      type: column.type.trim().toUpperCase(),
      notnull: column.notnull,
      defaultValue: normalizeColumnDefault(tableName, column.name, column.dflt_value),
      pk: column.pk,
      hidden: column.hidden,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeColumnDefault(
  tableName: string,
  columnName: string,
  value: unknown,
): string {
  if (
    tableName === 'jobs'
    && (columnName === 'created_at' || columnName === 'updated_at')
  ) {
    return '<legacy-compatible>';
  }
  return value === null ? '<none>' : normalizeSql(String(value));
}

function readForeignKeyShapes(db: Database.Database, tableName: string): string[] {
  const rows = db.prepare(
    `PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`,
  ).all() as Array<{
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }>;
  return rows
    .map((row) => JSON.stringify([
      row.seq,
      row.table,
      row.from,
      row.to,
      row.on_update,
      row.on_delete,
      row.match,
    ]))
    .sort();
}

function hasRequiredIndexes(
  actual: Database.Database,
  expected: Database.Database,
  tableName: string,
): boolean {
  const actualIndexes = readIndexShapes(actual, tableName);
  const expectedIndexes = readIndexShapes(expected, tableName);
  if (!expectedIndexes.every((expectedIndex) =>
    actualIndexes.some((actualIndex) => indexesMatch(expectedIndex, actualIndex)))) {
    return false;
  }

  const restrictive = (index: SchemaIndexShape): boolean =>
    index.origin !== 'c' || index.unique === 1;
  return JSON.stringify(actualIndexes.filter(restrictive).map(indexContractKey).sort())
    === JSON.stringify(expectedIndexes.filter(restrictive).map(indexContractKey).sort());
}

function readIndexShapes(db: Database.Database, tableName: string): SchemaIndexShape[] {
  const indexes = db.prepare(
    `PRAGMA index_list(${quoteIdentifier(tableName)})`,
  ).all() as Array<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>;
  return indexes.map((index) => {
    const columns = (db.prepare(
      `PRAGMA index_xinfo(${quoteIdentifier(index.name)})`,
    ).all() as Array<{
      seqno: number;
      cid: number;
      name: string | null;
      desc: number;
      coll: string | null;
      key: number;
    }>)
      .filter((column) => column.key === 1)
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => ({
        name: column.name,
        desc: column.desc,
        coll: column.coll ?? '',
      }));
    const schema = db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
    ).get(index.name) as { sql: string | null } | undefined;
    return {
      name: index.name,
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
      columns,
      predicate: extractIndexPredicate(schema?.sql ?? null),
    };
  });
}

function indexesMatch(expected: SchemaIndexShape, actual: SchemaIndexShape): boolean {
  return (expected.origin !== 'c' || expected.name === actual.name)
    && indexContractKey(expected) === indexContractKey(actual);
}

function indexContractKey(index: SchemaIndexShape): string {
  return JSON.stringify({
    name: index.origin === 'c' ? index.name : undefined,
    unique: index.unique,
    origin: index.origin,
    partial: index.partial,
    columns: index.columns,
    predicate: index.predicate,
  });
}

function extractIndexPredicate(sql: string | null): string {
  if (sql === null) {
    return '';
  }
  const match = /\bWHERE\b([\s\S]*)$/i.exec(sql);
  return match?.[1] ? normalizeSql(match[1]) : '';
}

function hasCompatibleChecks(
  actualSql: string | null,
  expectedSql: string | null,
): boolean {
  const actualChecks = extractCheckExpressions(actualSql);
  const expectedChecks = extractCheckExpressions(expectedSql);
  return JSON.stringify(actualChecks) === JSON.stringify(expectedChecks);
}

function extractCheckExpressions(sql: string | null): string[] {
  if (sql === null) {
    return [];
  }
  const checks: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const quote = sql[index];
    if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
      index = skipQuotedSql(sql, index);
      continue;
    }
    if (
      sql.slice(index, index + 5).toLowerCase() !== 'check'
      || isSqlWordCharacter(sql[index - 1])
      || isSqlWordCharacter(sql[index + 5])
    ) {
      index += 1;
      continue;
    }

    let open = index + 5;
    while (/\s/.test(sql[open] ?? '')) {
      open += 1;
    }
    if (sql[open] !== '(') {
      index += 5;
      continue;
    }

    let depth = 1;
    let cursor = open + 1;
    while (cursor < sql.length && depth > 0) {
      const character = sql[cursor];
      if (
        character === "'"
        || character === '"'
        || character === '`'
        || character === '['
      ) {
        cursor = skipQuotedSql(sql, cursor);
        continue;
      }
      if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
      }
      cursor += 1;
    }
    if (depth !== 0) {
      throwIncompatibleSchema();
    }
    checks.push(normalizeSql(sql.slice(open + 1, cursor - 1)));
    index = cursor;
  }
  return checks.sort();
}

function skipQuotedSql(sql: string, start: number): number {
  const opening = sql[start];
  const closing = opening === '[' ? ']' : opening;
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === closing) {
      if (closing !== ']' && sql[index + 1] === closing) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function isSqlWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function normalizeSql(sql: string | null): string {
  if (sql === null) {
    return '';
  }
  let normalized = '';
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (/\s/.test(character ?? '')) {
      index += 1;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1;
      }
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      const commentEnd = sql.indexOf('*/', index + 2);
      index = commentEnd === -1 ? sql.length : commentEnd + 2;
      continue;
    }
    if (
      character === "'"
      || character === '"'
      || character === '`'
      || character === '['
    ) {
      const quotedEnd = skipQuotedSql(sql, index);
      normalized += sql.slice(index, quotedEnd);
      index = quotedEnd;
      continue;
    }
    normalized += character?.toLowerCase() ?? '';
    index += 1;
  }
  return normalized;
}

function throwIncompatibleSchema(): never {
  throw new SchemaVersionError(
    'incompatible-schema',
    'Database schema is incompatible with this LetheBot release.',
  );
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;

  return row !== undefined;
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * 获取当前 schema 版本
 */
export function getSchemaVersion(db: Database.Database): number {
  const state = inspectSchemaVersion(db);
  return state.kind === 'versioned' ? state.versions.at(-1) ?? 0 : 0;
}

/**
 * 记录 schema 版本
 */
export function recordSchemaVersion(db: Database.Database, version: number, description: string): void {
  db.prepare('INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)').run(
    version,
    description,
    Date.now()
  );
}

/**
 * 关闭数据库连接
 */
export function closeDatabase(db: Database.Database): void {
  db.close();
}
