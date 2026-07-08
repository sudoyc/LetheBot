/**
 * Local operations helper for SQLite backup/restore/retention/metrics.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, closeDatabase, runMigration } from '../storage/database.js';
import { loadConfig } from '../config/index.js';
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

  if (parsed.command === 'worker-soak') {
    const durationMs = parseOptionalPositiveInteger(parsed.values['duration-ms'], '--duration-ms') ?? 15_000;
    const intervalMs = parseOptionalPositiveInteger(parsed.values['interval-ms'], '--interval-ms') ?? 1_000;
    const tempDir = parsed.values.db ? undefined : mkdtempSync(join(tmpdir(), 'lethebot-worker-soak-'));
    const dbPath = parsed.values.db ?? join(tempDir ?? tmpdir(), 'worker-soak.db');
    const db = initDatabase({ path: dbPath });
    try {
      runMigration(db, join(__dirname, '../../migrations/001_initial_schema.sql'));
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
  pnpm ops:worker-soak -- --duration-ms=15000 --interval-ms=1000
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redactForDisplay(message));
    process.exit(1);
  });
}
