/**
 * Read-only operational health inspection shared by local maintenance entrypoints.
 */

import type Database from 'better-sqlite3';
import type { Config } from '../config/index.js';

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

type DoctorCountTable = typeof DOCTOR_COUNT_TABLES[number];

export type OperationsDoctorConfig = Pick<
  Config,
  | 'onebotTransport'
  | 'onebotHttpUrl'
  | 'onebotWsUrl'
  | 'onebotToken'
  | 'onebotBotQqId'
  | 'lethebotHost'
  | 'lethebotPort'
  | 'lethebotHealthPath'
  | 'lethebotReadinessPath'
  | 'lethebotMetricsPath'
  | 'lethebotEventPath'
  | 'rawEventRetentionDays'
  | 'chatMessageRetentionDays'
  | 'auditLogRetentionDays'
  | 'disabledDeletedMemoryRetentionDays'
  | 'eventProcessingFailureRetentionDays'
>;

export interface OperationsDoctorResult {
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
  counts: Record<DoctorCountTable, number>;
  configuration: {
    oneBot: {
      transport: OperationsDoctorConfig['onebotTransport'];
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
}

export function runOperationsDoctor(
  db: Database.Database,
  dbPath: string,
  config: OperationsDoctorConfig,
): OperationsDoctorResult {
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
): Record<DoctorCountTable, number> {
  const counts = {} as Record<DoctorCountTable, number>;

  for (const table of DOCTOR_COUNT_TABLES) {
    counts[table] = existingTables.has(table) ? countTableRows(db, table) : 0;
  }

  return counts;
}

function countTableRows(db: Database.Database, tableName: DoctorCountTable): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}
