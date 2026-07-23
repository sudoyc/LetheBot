/**
 * Local operations helper for SQLite backup/restore/retention/metrics.
 */

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { initDatabase, closeDatabase, runMigrations } from '../storage/database.js';
import { loadConfig, type Config } from '../config/index.js';
import { redactSecretsInText } from '../memory/secret-scan.js';
import {
  applyRetentionPolicy,
  backupSqliteDatabase,
  collectOperationsMetrics,
  formatOperationsMetricsPrometheus,
  restoreSqliteDatabase,
  type RetentionPolicy,
} from '../operations/sqlite-maintenance.js';
import { runWorkerSchedulerSoak } from '../operations/worker-soak.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REQUIRED_TABLES = [
  'schema_version',
  'canonical_users',
  'platform_accounts',
  'platform_groups',
  'display_profiles',
  'nickname_history',
  'privacy_preferences',
  'raw_events',
  'event_ingress_receipts',
  'event_processing_admissions',
  'chat_messages',
  'event_processing_failures',
  'memory_records',
  'memory_sources',
  'memory_revisions',
  'memory_fts',
  'agent_turns',
  'context_traces',
  'action_decisions',
  'action_executions',
  'tool_calls',
  'audit_log',
  'jobs',
  'job_attempts',
  'worker_heartbeats',
] as const;

const DOCTOR_COUNT_TABLES = [
  'raw_events',
  'event_ingress_receipts',
  'event_processing_admissions',
  'chat_messages',
  'event_processing_failures',
  'agent_turns',
  'context_traces',
  'action_decisions',
  'action_executions',
  'memory_records',
  'memory_sources',
  'memory_revisions',
  'tool_calls',
  'audit_log',
  'jobs',
  'job_attempts',
  'worker_heartbeats',
] as const;

const REHEARSAL_COUNT_TABLES = [
  'raw_events',
  'chat_messages',
  'event_processing_failures',
  'audit_log',
  'memory_records',
  'memory_sources',
  'memory_revisions',
] as const;

const REHEARSAL_RETENTION_DAYS = 30;

const REHEARSAL_FINGERPRINT_QUERIES = {
  raw_events: `
    SELECT id, type, timestamp, source, platform, conversation_id, created_at
    FROM raw_events
    ORDER BY id
  `,
  chat_messages: `
    SELECT id, raw_event_id, message_id, conversation_id, conversation_type, sender_id, timestamp
    FROM chat_messages
    ORDER BY id
  `,
  event_processing_failures: `
    SELECT id, raw_event_id, occurred_at, stage, conversation_type,
           error_name, error_message_hash, message_id_hash, sender_id_hash, conversation_id_hash
    FROM event_processing_failures
    ORDER BY id
  `,
  audit_log: `
    SELECT id, timestamp, category, level, event_type, event_id, actor_class, invocation_context, redacted
    FROM audit_log
    ORDER BY id
  `,
  memory_records: `
    SELECT id, scope, visibility, sensitivity, authority, kind, state, confidence, importance, created_at, updated_at
    FROM memory_records
    ORDER BY id
  `,
  memory_sources: `
    SELECT memory_id, source_type, source_id, source_timestamp, extracted_by,
           resolution_state, raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
    FROM memory_sources
    ORDER BY memory_id, source_id
  `,
  memory_revisions: `
    SELECT id, memory_id, revision_number, change_type, actor, created_at
    FROM memory_revisions
    ORDER BY id
  `,
} satisfies Record<typeof REHEARSAL_COUNT_TABLES[number], string>;

interface ParsedArgs {
  command: string;
  values: Record<string, string>;
  flags: Set<string>;
}

interface CommandSpec {
  values: readonly string[];
  flags: readonly string[];
}

const COMMAND_SPECS = {
  backup: {
    values: ['db', 'out'],
    flags: [],
  },
  restore: {
    values: ['backup', 'db'],
    flags: ['overwrite'],
  },
  retention: {
    values: ['db', 'raw-days', 'chat-days', 'audit-days', 'memory-days', 'event-failure-days'],
    flags: [],
  },
  metrics: {
    values: ['db', 'since', 'format'],
    flags: [],
  },
  doctor: {
    values: ['db'],
    flags: [],
  },
  'rehearse-maintenance': {
    values: ['db'],
    flags: [],
  },
  'rehearse-rollback': {
    values: ['db'],
    flags: [],
  },
  'worker-soak': {
    values: ['db', 'duration-ms', 'interval-ms', 'worker-id'],
    flags: [],
  },
} satisfies Record<string, CommandSpec>;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === 'backup') {
    const config = loadConfig();
    const sourcePath = parsed.values.db ?? config.dbPath;
    const backupPath = requireValue(parsed.values.out, '--out');
    const result = await backupSqliteDatabase({ sourcePath, backupPath });
    printJson(result);
    return;
  }

  if (parsed.command === 'restore') {
    const config = loadConfig();
    const backupPath = requireValue(parsed.values.backup, '--backup');
    const targetPath = parsed.values.db ?? config.dbPath;
    const result = restoreSqliteDatabase({
      backupPath,
      targetPath,
      overwrite: parsed.flags.has('overwrite'),
    });
    printJson(result);
    return;
  }

  if (parsed.command === 'retention') {
    const config = loadConfig();
    const db = initDatabase({ path: parsed.values.db ?? config.dbPath });
    try {
      const policy: RetentionPolicy = {
        rawEventsDays: parseOptionalDays(parsed.values['raw-days'], '--raw-days') ?? config.rawEventRetentionDays,
        chatMessagesDays: parseOptionalDays(parsed.values['chat-days'], '--chat-days') ?? config.chatMessageRetentionDays,
        auditLogDays: parseOptionalDays(parsed.values['audit-days'], '--audit-days') ?? config.auditLogRetentionDays,
        disabledDeletedMemoryDays: parseOptionalDays(parsed.values['memory-days'], '--memory-days')
          ?? config.disabledDeletedMemoryRetentionDays,
        eventProcessingFailuresDays: parseOptionalDays(
          parsed.values['event-failure-days'],
          '--event-failure-days',
        )
          ?? config.eventProcessingFailureRetentionDays,
      };
      const result = applyRetentionPolicy(db, policy);
      printJson({ policy, result });
    } finally {
      closeDatabase(db);
    }
    return;
  }

  if (parsed.command === 'metrics') {
    const config = loadConfig();
    const db = initDatabase({ path: parsed.values.db ?? config.dbPath, readonly: true });
    try {
      const sinceMs = parseSinceMs(parsed.values.since);
      const format = parseMetricsFormat(parsed.values.format);
      const metrics = collectOperationsMetrics(db, sinceMs);
      if (format === 'prometheus') {
        process.stdout.write(formatOperationsMetricsPrometheus(metrics));
        return;
      }
      printJson(metrics);
    } finally {
      closeDatabase(db);
    }
    return;
  }

  if (parsed.command === 'doctor') {
    const config = loadConfig();
    const dbPath = parsed.values.db ?? config.dbPath;
    const db = initDatabase({ path: dbPath, readonly: true });
    try {
      const result = runDoctor(db, dbPath, config);
      printJson(result);
      if (result.overall !== 'ok') {
        process.exitCode = 1;
      }
    } finally {
      closeDatabase(db);
    }
    return;
  }

  if (parsed.command === 'rehearse-maintenance') {
    const config = loadConfig();
    const result = await runMaintenanceRehearsal(parsed.values.db, config);
    printJson(result);
    if (!result.success) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.command === 'rehearse-rollback') {
    const config = loadConfig();
    const result = await runRollbackRehearsal(parsed.values.db, config);
    printJson(result);
    if (!result.success) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.command === 'worker-soak') {
    const durationMs = parseOptionalPositiveInteger(parsed.values['duration-ms'], '--duration-ms') ?? 15_000;
    const intervalMs = parseOptionalPositiveInteger(parsed.values['interval-ms'], '--interval-ms') ?? 1_000;
    const tempDir = parsed.values.db ? undefined : mkdtempSync(join(tmpdir(), 'lethebot-worker-soak-'));
    const dbPath = parsed.values.db ?? join(tempDir ?? tmpdir(), 'worker-soak.db');
    const db = initDatabase({ path: dbPath });
    try {
      runMigrations(db, join(__dirname, '../../migrations'));
      const result = await runWorkerSchedulerSoak({
        db,
        durationMs,
        intervalMs,
        workerId: parsed.values['worker-id'],
      });
      printJson({
        dbPath,
        temporary: parsed.values.db === undefined,
        ...result,
      });
      if (!result.success) {
        process.exitCode = 1;
      }
    } finally {
      closeDatabase(db);
    }
    return;
  }

  printUsage();
  process.exit(parsed.command ? 1 : 0);
}

function parseArgs(args: string[]): ParsedArgs {
  const [command = '', ...rest] = args;
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const commandSpec = getCommandSpec(command);

  if (command && commandSpec === undefined) {
    throw new Error(`Unknown command: ${command}`);
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const withoutPrefix = arg.slice(2);
    const eqIndex = withoutPrefix.indexOf('=');
    const name = eqIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, eqIndex);

    if (!name) {
      throw new Error('Invalid empty option');
    }

    if (commandSpec && !commandSpec.values.includes(name) && !commandSpec.flags.includes(name)) {
      throw new Error(`Unknown option --${name}`);
    }

    if (commandSpec?.flags.includes(name)) {
      if (eqIndex !== -1) {
        throw new Error(`Option --${name} does not take a value`);
      }
      flags.add(name);
      continue;
    }

    if (eqIndex === -1) {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for --${name}`);
      }
      values[name] = next;
      index += 1;
      continue;
    }

    const value = withoutPrefix.slice(eqIndex + 1);
    if (!value) {
      throw new Error(`Missing value for --${name}`);
    }
    values[name] = value;
  }

  return { command, values, flags };
}

function getCommandSpec(command: string): CommandSpec | undefined {
  if (Object.prototype.hasOwnProperty.call(COMMAND_SPECS, command)) {
    return COMMAND_SPECS[command as keyof typeof COMMAND_SPECS];
  }
  return undefined;
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required ${name}`);
  }
  return value;
}

function parseOptionalDays(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const days = Number(value);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return days;
}

function parseSinceMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const sinceMs = Date.parse(value);
  if (Number.isNaN(sinceMs)) {
    throw new Error(`Invalid --since date: ${value}`);
  }
  return sinceMs;
}

function parseMetricsFormat(value: string | undefined): 'json' | 'prometheus' {
  if (value === undefined || value === 'json') {
    return 'json';
  }

  if (value === 'prometheus') {
    return 'prometheus';
  }

  throw new Error(`Invalid --format: ${value}`);
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(redactJsonForDisplay(value), null, 2));
}

function redactForDisplay(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function redactJsonForDisplay(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactForDisplay(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJsonForDisplay(item));
  }

  if (isPlainRecord(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      redacted[key] = redactJsonForDisplay(nestedValue);
    }
    return redacted;
  }

  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm ops:backup -- --db=./data/lethebot.db --out=./backups/lethebot.db
  pnpm ops:restore -- --backup=./backups/lethebot.db --db=./data/lethebot.db --overwrite
  pnpm ops:retention -- --raw-days=30 --chat-days=90 --audit-days=90 --memory-days=365 --event-failure-days=90
  pnpm ops:metrics -- --since=2026-07-01T00:00:00Z
  pnpm ops:metrics -- --format=prometheus
  pnpm ops:doctor -- --db=./data/lethebot.db
  pnpm ops:rehearse-maintenance
  pnpm ops:rehearse-rollback
  pnpm ops:worker-soak -- --duration-ms=15000 --interval-ms=1000
`);
}

function runDoctor(db: Database.Database, dbPath: string, config: Config): {
  generatedAt: string;
  overall: 'ok' | 'attention_required';
  database: {
    dbPath: string;
    open: boolean;
    readonly: boolean;
    integrityOk: boolean;
    integrityResult: string;
    foreignKeyViolations: number;
  };
  schema: {
    ready: boolean;
    requiredTablesPresent: number;
    requiredTablesTotal: number;
    missingTables: string[];
  };
  counts: Record<typeof DOCTOR_COUNT_TABLES[number], number>;
  configuration: {
    oneBot: {
      transport: Config['onebotTransport'];
      httpUrlConfigured: boolean;
      wsUrlConfigured: boolean;
      tokenConfigured: boolean;
      botIdConfigured: boolean;
    };
    server: {
      hostConfigured: boolean;
      portConfigured: boolean;
      healthPathConfigured: boolean;
      readinessPathConfigured: boolean;
      metricsPathConfigured: boolean;
      eventPathConfigured: boolean;
    };
    retentionDays: {
      rawEvents: number;
      chatMessages: number;
      auditLog: number;
      disabledDeletedMemory: number;
      eventProcessingFailures: number;
    };
  };
} {
  const integrityResult = readIntegrityResult(db);
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  const existingTables = readExistingTables(db);
  const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table));
  const counts = readDoctorCounts(db, existingTables);
  const integrityOk = integrityResult === 'ok';
  const schemaReady = missingTables.length === 0;
  const foreignKeyClean = foreignKeyViolations === 0;

  return {
    generatedAt: new Date().toISOString(),
    overall: integrityOk && schemaReady && foreignKeyClean ? 'ok' : 'attention_required',
    database: {
      dbPath,
      open: db.open,
      readonly: true,
      integrityOk,
      integrityResult,
      foreignKeyViolations,
    },
    schema: {
      ready: schemaReady,
      requiredTablesPresent: REQUIRED_TABLES.length - missingTables.length,
      requiredTablesTotal: REQUIRED_TABLES.length,
      missingTables,
    },
    counts,
    configuration: {
      oneBot: {
        transport: config.onebotTransport,
        httpUrlConfigured: Boolean(config.onebotHttpUrl),
        wsUrlConfigured: Boolean(config.onebotWsUrl),
        tokenConfigured: Boolean(config.onebotToken),
        botIdConfigured: Boolean(config.onebotBotQqId),
      },
      server: {
        hostConfigured: Boolean(config.lethebotHost),
        portConfigured: Number.isInteger(config.lethebotPort),
        healthPathConfigured: Boolean(config.lethebotHealthPath),
        readinessPathConfigured: Boolean(config.lethebotReadinessPath),
        metricsPathConfigured: Boolean(config.lethebotMetricsPath),
        eventPathConfigured: Boolean(config.lethebotEventPath),
      },
      retentionDays: {
        rawEvents: config.rawEventRetentionDays,
        chatMessages: config.chatMessageRetentionDays,
        auditLog: config.auditLogRetentionDays,
        disabledDeletedMemory: config.disabledDeletedMemoryRetentionDays,
        eventProcessingFailures: config.eventProcessingFailureRetentionDays,
      },
    },
  };
}

function readIntegrityResult(db: Database.Database): string {
  const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
  return row?.integrity_check ?? 'unknown';
}

function readExistingTables(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function readDoctorCounts(
  db: Database.Database,
  existingTables: Set<string>,
): Record<typeof DOCTOR_COUNT_TABLES[number], number> {
  const counts = {} as Record<typeof DOCTOR_COUNT_TABLES[number], number>;

  for (const table of DOCTOR_COUNT_TABLES) {
    counts[table] = existingTables.has(table) ? countTableRows(db, table) : 0;
  }

  return counts;
}

function countTableRows(db: Database.Database, tableName: typeof DOCTOR_COUNT_TABLES[number]): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

async function runMaintenanceRehearsal(
  explicitDbPath: string | undefined,
  config: Config,
): Promise<{
  generatedAt: string;
  success: boolean;
  dbPath: string;
  temporary: boolean;
  backup: {
    backupPath: string;
    integrityOk: boolean;
    backupSizeBytes: number;
  };
  restore: {
    targetPath: string;
    integrityOk: boolean;
    foreignKeyViolations: number;
    restoredSizeBytes: number;
  };
  doctor: {
    beforeRetention: {
      overall: 'ok' | 'attention_required';
      schemaReady: boolean;
      foreignKeyViolations: number;
    };
    afterRetention: {
      overall: 'ok' | 'attention_required';
      schemaReady: boolean;
      foreignKeyViolations: number;
    };
  };
  retention: {
    policy: Required<RetentionPolicy>;
    result: ReturnType<typeof applyRetentionPolicy>;
  };
  counts: {
    sourceBefore: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
    restoredBefore: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
    restoredAfter: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
  };
}> {
  const tempDir = explicitDbPath ? undefined : mkdtempSync(join(tmpdir(), 'lethebot-maintenance-rehearsal-'));
  const dbPath = explicitDbPath ?? join(tempDir ?? tmpdir(), 'maintenance-rehearsal.db');
  const baseDir = dirname(dbPath);
  const backupPath = join(baseDir, 'maintenance-rehearsal.backup.db');
  const restoredPath = join(baseDir, 'maintenance-rehearsal.restored.db');

  if (existsSync(dbPath)) {
    throw new Error(`Rehearsal database already exists: ${dbPath}`);
  }
  if (existsSync(backupPath)) {
    throw new Error(`Rehearsal backup already exists: ${backupPath}`);
  }
  if (existsSync(restoredPath)) {
    throw new Error(`Rehearsal restore target already exists: ${restoredPath}`);
  }

  mkdirSync(baseDir, { recursive: true });

  const nowMs = Date.now();
  const sourceDb = initDatabase({ path: dbPath });
  let sourceBefore: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
  try {
    runMigrations(sourceDb, join(__dirname, '../../migrations'));
    seedMaintenanceRehearsalRows(sourceDb, nowMs);
    sourceBefore = readRehearsalCounts(sourceDb);
  } finally {
    closeDatabase(sourceDb);
  }

  const backup = await backupSqliteDatabase({ sourcePath: dbPath, backupPath });
  const restore = restoreSqliteDatabase({ backupPath, targetPath: restoredPath });

  const doctorBefore = runReadOnlyDoctor(restoredPath, config);
  const restoredBefore = doctorBefore.counts;
  const policy: Required<RetentionPolicy> = {
    rawEventsDays: REHEARSAL_RETENTION_DAYS,
    chatMessagesDays: REHEARSAL_RETENTION_DAYS,
    auditLogDays: REHEARSAL_RETENTION_DAYS,
    disabledDeletedMemoryDays: REHEARSAL_RETENTION_DAYS,
    eventProcessingFailuresDays: REHEARSAL_RETENTION_DAYS,
  };

  const restoredDb = initDatabase({ path: restoredPath });
  let retentionResult: ReturnType<typeof applyRetentionPolicy>;
  try {
    retentionResult = applyRetentionPolicy(restoredDb, policy, nowMs);
  } finally {
    closeDatabase(restoredDb);
  }

  const doctorAfter = runReadOnlyDoctor(restoredPath, config);
  const restoredAfter = doctorAfter.counts;
  const success =
    backup.integrityOk
    && restore.integrityOk
    && doctorBefore.summary.overall === 'ok'
    && doctorAfter.summary.overall === 'ok'
    && retentionResult.rawEventsDeleted >= 1
    && retentionResult.chatMessagesDeleted >= 1
    && retentionResult.eventProcessingFailuresDeleted >= 1
    && retentionResult.auditLogDeleted >= 1
    && retentionResult.memoriesPurged >= 1
    && restoredAfter.raw_events < restoredBefore.raw_events
    && restoredAfter.chat_messages < restoredBefore.chat_messages
    && restoredAfter.event_processing_failures < restoredBefore.event_processing_failures
    && restoredAfter.audit_log < restoredBefore.audit_log
    && restoredAfter.memory_records < restoredBefore.memory_records;

  return {
    generatedAt: new Date().toISOString(),
    success,
    dbPath,
    temporary: explicitDbPath === undefined,
    backup: {
      backupPath: backup.backupPath,
      integrityOk: backup.integrityOk,
      backupSizeBytes: backup.backupSizeBytes,
    },
    restore: {
      targetPath: restore.targetPath,
      integrityOk: restore.integrityOk,
      foreignKeyViolations: restore.foreignKeyViolations,
      restoredSizeBytes: restore.restoredSizeBytes,
    },
    doctor: {
      beforeRetention: doctorBefore.summary,
      afterRetention: doctorAfter.summary,
    },
    retention: {
      policy,
      result: retentionResult,
    },
    counts: {
      sourceBefore,
      restoredBefore,
      restoredAfter,
    },
  };
}

async function runRollbackRehearsal(
  explicitDbPath: string | undefined,
  config: Config,
): Promise<{
  generatedAt: string;
  success: boolean;
  dbPath: string;
  temporary: boolean;
  backup: {
    backupPath: string;
    integrityOk: boolean;
    backupSizeBytes: number;
  };
  restore: {
    targetPath: string;
    overwrite: true;
    integrityOk: boolean;
    foreignKeyViolations: number;
    restoredSizeBytes: number;
  };
  doctor: {
    afterRollback: {
      overall: 'ok' | 'attention_required';
      schemaReady: boolean;
      foreignKeyViolations: number;
    };
  };
  rollback: {
    restoredMatchesBackup: boolean;
    syntheticRowsRemoved: boolean;
  };
  fingerprints: {
    beforeUpdate: string;
    afterSyntheticUpdate: string;
    afterRollback: string;
  };
  counts: {
    beforeUpdate: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
    afterSyntheticUpdate: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
    afterRollback: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
  };
}> {
  const tempDir = explicitDbPath ? undefined : mkdtempSync(join(tmpdir(), 'lethebot-rollback-rehearsal-'));
  const dbPath = explicitDbPath ?? join(tempDir ?? tmpdir(), 'rollback-rehearsal.db');
  const baseDir = dirname(dbPath);
  const backupPath = join(baseDir, 'rollback-rehearsal.backup.db');

  if (existsSync(dbPath)) {
    throw new Error(`Rollback rehearsal database already exists: ${dbPath}`);
  }
  if (existsSync(backupPath)) {
    throw new Error(`Rollback rehearsal backup already exists: ${backupPath}`);
  }

  mkdirSync(baseDir, { recursive: true });

  const nowMs = Date.now();
  const db = initDatabase({ path: dbPath });
  let beforeUpdate: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
  let beforeFingerprint: string;
  try {
    runMigrations(db, join(__dirname, '../../migrations'));
    seedMaintenanceRehearsalRows(db, nowMs);
    beforeUpdate = readRehearsalCounts(db);
    beforeFingerprint = readRehearsalFingerprint(db);
  } finally {
    closeDatabase(db);
  }

  const backup = await backupSqliteDatabase({ sourcePath: dbPath, backupPath });

  const updateDb = initDatabase({ path: dbPath });
  let afterSyntheticUpdate: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
  let afterSyntheticUpdateFingerprint: string;
  try {
    insertRollbackMutationRows(updateDb, nowMs + 1);
    afterSyntheticUpdate = readRehearsalCounts(updateDb);
    afterSyntheticUpdateFingerprint = readRehearsalFingerprint(updateDb);
  } finally {
    closeDatabase(updateDb);
  }

  const restore = restoreSqliteDatabase({
    backupPath,
    targetPath: dbPath,
    overwrite: true,
  });

  const doctorAfter = runReadOnlyDoctor(dbPath, config);
  const rollbackDb = initDatabase({ path: dbPath, readonly: true });
  let afterRollback: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
  let afterRollbackFingerprint: string;
  try {
    afterRollback = readRehearsalCounts(rollbackDb);
    afterRollbackFingerprint = readRehearsalFingerprint(rollbackDb);
  } finally {
    closeDatabase(rollbackDb);
  }

  const restoredMatchesBackup =
    beforeFingerprint === afterRollbackFingerprint
    && rehearsalCountsEqual(beforeUpdate, afterRollback);
  const syntheticRowsRemoved =
    rehearsalCountsIncreased(beforeUpdate, afterSyntheticUpdate)
    && rehearsalCountsEqual(beforeUpdate, afterRollback);
  const success =
    backup.integrityOk
    && restore.integrityOk
    && doctorAfter.summary.overall === 'ok'
    && restoredMatchesBackup
    && syntheticRowsRemoved;

  return {
    generatedAt: new Date().toISOString(),
    success,
    dbPath,
    temporary: explicitDbPath === undefined,
    backup: {
      backupPath: backup.backupPath,
      integrityOk: backup.integrityOk,
      backupSizeBytes: backup.backupSizeBytes,
    },
    restore: {
      targetPath: restore.targetPath,
      overwrite: true,
      integrityOk: restore.integrityOk,
      foreignKeyViolations: restore.foreignKeyViolations,
      restoredSizeBytes: restore.restoredSizeBytes,
    },
    doctor: {
      afterRollback: doctorAfter.summary,
    },
    rollback: {
      restoredMatchesBackup,
      syntheticRowsRemoved,
    },
    fingerprints: {
      beforeUpdate: beforeFingerprint,
      afterSyntheticUpdate: afterSyntheticUpdateFingerprint,
      afterRollback: afterRollbackFingerprint,
    },
    counts: {
      beforeUpdate,
      afterSyntheticUpdate,
      afterRollback,
    },
  };
}

function runReadOnlyDoctor(
  dbPath: string,
  config: Config,
): {
  summary: {
    overall: 'ok' | 'attention_required';
    schemaReady: boolean;
    foreignKeyViolations: number;
  };
  counts: Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
} {
  const db = initDatabase({ path: dbPath, readonly: true });
  try {
    const doctor = runDoctor(db, dbPath, config);
    return {
      summary: {
        overall: doctor.overall,
        schemaReady: doctor.schema.ready,
        foreignKeyViolations: doctor.database.foreignKeyViolations,
      },
      counts: readRehearsalCounts(db),
    };
  } finally {
    closeDatabase(db);
  }
}

function readRehearsalCounts(db: Database.Database): Record<typeof REHEARSAL_COUNT_TABLES[number], number> {
  const counts = {} as Record<typeof REHEARSAL_COUNT_TABLES[number], number>;
  for (const table of REHEARSAL_COUNT_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    counts[table] = row.count;
  }
  return counts;
}

function readRehearsalFingerprint(db: Database.Database): string {
  const hash = createHash('sha256');
  for (const table of REHEARSAL_COUNT_TABLES) {
    const rows = db.prepare(REHEARSAL_FINGERPRINT_QUERIES[table]).all() as unknown[];
    hash.update(table);
    hash.update('\0');
    hash.update(JSON.stringify(rows));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function rehearsalCountsEqual(
  left: Record<typeof REHEARSAL_COUNT_TABLES[number], number>,
  right: Record<typeof REHEARSAL_COUNT_TABLES[number], number>,
): boolean {
  return REHEARSAL_COUNT_TABLES.every((table) => left[table] === right[table]);
}

function rehearsalCountsIncreased(
  before: Record<typeof REHEARSAL_COUNT_TABLES[number], number>,
  after: Record<typeof REHEARSAL_COUNT_TABLES[number], number>,
): boolean {
  return REHEARSAL_COUNT_TABLES.every((table) => after[table] > before[table]);
}

function seedMaintenanceRehearsalRows(db: Database.Database, nowMs: number): void {
  const old = nowMs - 45 * 24 * 60 * 60 * 1000;
  const recent = nowMs - 2 * 24 * 60 * 60 * 1000;

  insertRehearsalRawEvent(db, 'rehearsal-raw-old', old);
  insertRehearsalRawEvent(db, 'rehearsal-raw-recent', recent);
  insertRehearsalChatMessage(db, 'rehearsal-chat-old', 'rehearsal-raw-old', old);
  insertRehearsalChatMessage(db, 'rehearsal-chat-recent', 'rehearsal-raw-recent', recent);
  insertRehearsalEventFailure(db, 'rehearsal-failure-old', 'rehearsal-raw-old', old);
  insertRehearsalEventFailure(db, 'rehearsal-failure-recent', 'rehearsal-raw-recent', recent);
  insertRehearsalAudit(db, 'rehearsal-audit-old', old);
  insertRehearsalAudit(db, 'rehearsal-audit-recent', recent);
  insertRehearsalMemory(db, 'rehearsal-memory-old-deleted', 'deleted', old);
  insertRehearsalMemory(db, 'rehearsal-memory-recent-active', 'active', recent);
  db.prepare(
    `INSERT INTO memory_sources (
      memory_id, source_type, source_id, source_timestamp, extracted_by,
      resolution_state, raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
    ) VALUES (?, ?, ?, ?, ?, 'internal', ?, NULL, NULL, NULL, NULL)`,
  ).run(
    'rehearsal-memory-old-deleted',
    'raw_event',
    'rehearsal-raw-old',
    old,
    'ops-rehearsal',
    'rehearsal-raw-old',
  );
  db.prepare(
    `INSERT INTO memory_revisions (
      id, memory_id, revision_number, change_type, previous_state, new_state,
      reason, actor, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'rehearsal-revision-old-deleted',
    'rehearsal-memory-old-deleted',
    1,
    'delete',
    null,
    '{}',
    'ops rehearsal synthetic deletion',
    'system',
    old,
  );
}

function insertRollbackMutationRows(db: Database.Database, timestamp: number): void {
  insertRehearsalRawEvent(db, 'rollback-mutation-raw', timestamp);
  insertRehearsalChatMessage(db, 'rollback-mutation-chat', 'rollback-mutation-raw', timestamp);
  insertRehearsalEventFailure(db, 'rollback-mutation-failure', 'rollback-mutation-raw', timestamp);
  insertRehearsalAudit(db, 'rollback-mutation-audit', timestamp);
  insertRehearsalMemory(db, 'rollback-mutation-memory', 'active', timestamp);
  db.prepare(
    `INSERT INTO memory_sources (
      memory_id, source_type, source_id, source_timestamp, extracted_by,
      resolution_state, raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
    ) VALUES (?, ?, ?, ?, ?, 'internal', ?, NULL, NULL, NULL, NULL)`,
  ).run(
    'rollback-mutation-memory',
    'raw_event',
    'rollback-mutation-raw',
    timestamp,
    'ops-rollback-rehearsal',
    'rollback-mutation-raw',
  );
  db.prepare(
    `INSERT INTO memory_revisions (
      id, memory_id, revision_number, change_type, previous_state, new_state,
      reason, actor, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'rollback-mutation-revision',
    'rollback-mutation-memory',
    1,
    'create',
    null,
    '{}',
    'ops rollback rehearsal synthetic mutation',
    'system',
    timestamp,
  );
}

function insertRehearsalRawEvent(db: Database.Database, id: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform,
      conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'chat.message.received', timestamp, 'system', 'qq', 'private:ops-rehearsal', '{}', timestamp);
}

function insertRehearsalChatMessage(
  db: Database.Database,
  id: string,
  rawEventId: string,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id,
      conversation_type, sender_id, text, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    rawEventId,
    id,
    'private:ops-rehearsal',
    'private',
    'ops-rehearsal-user',
    '[synthetic ops rehearsal message]',
    timestamp,
  );
}

function insertRehearsalEventFailure(db: Database.Database, id: string, rawEventId: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO event_processing_failures (
      id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
      error_name, error_message_hash, message_id_hash, sender_id_hash,
      conversation_id_hash, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    rawEventId,
    null,
    timestamp,
    'pi_inference',
    'private',
    'Error',
    'a'.repeat(64),
    'b'.repeat(64),
    'c'.repeat(64),
    'd'.repeat(64),
    JSON.stringify({ rehearsal: 'hashes_only' }),
  );
}

function insertRehearsalAudit(db: Database.Database, id: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO audit_log (
      id, timestamp, category, level, event_type, event_id,
      actor_class, invocation_context, summary, redacted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, timestamp, 'system', 'summary', 'ops.rehearsal', id, 'system', 'system', 'ops rehearsal', 0);
}

function insertRehearsalMemory(
  db: Database.Database,
  id: string,
  state: 'active' | 'deleted',
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO memory_records (
      id, scope, visibility, sensitivity, authority,
      kind, title, content, state, confidence, importance,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'system',
    'owner_admin_only',
    'normal',
    'system',
    'fact',
    id,
    'ops rehearsal synthetic memory',
    state,
    0.9,
    0.5,
    timestamp,
    timestamp,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redactForDisplay(message));
    process.exit(1);
  });
}
