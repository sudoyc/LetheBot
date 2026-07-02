/**
 * Local operations helper for SQLite backup/restore/retention/metrics.
 */

import { initDatabase, closeDatabase } from '../storage/database.js';
import { loadConfig } from '../config/index.js';
import {
  applyRetentionPolicy,
  backupSqliteDatabase,
  collectOperationsMetrics,
  restoreSqliteDatabase,
  type RetentionPolicy,
} from '../operations/sqlite-maintenance.js';

interface ParsedArgs {
  command: string;
  values: Record<string, string>;
  flags: Set<string>;
}

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
        rawEventsDays: parseOptionalDays(parsed.values['raw-days']) ?? config.rawEventRetentionDays,
        chatMessagesDays: parseOptionalDays(parsed.values['chat-days']) ?? config.chatMessageRetentionDays,
        auditLogDays: parseOptionalDays(parsed.values['audit-days']) ?? config.auditLogRetentionDays,
        disabledDeletedMemoryDays: parseOptionalDays(parsed.values['memory-days'])
          ?? config.disabledDeletedMemoryRetentionDays,
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
      printJson(collectOperationsMetrics(db, sinceMs));
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

  for (const arg of rest) {
    if (!arg.startsWith('--')) {
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const eqIndex = withoutPrefix.indexOf('=');
    if (eqIndex === -1) {
      flags.add(withoutPrefix);
      continue;
    }

    values[withoutPrefix.slice(0, eqIndex)] = withoutPrefix.slice(eqIndex + 1);
  }

  return { command, values, flags };
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required ${name}`);
  }
  return value;
}

function parseOptionalDays(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const days = Number(value);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`Invalid retention days: ${value}`);
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

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printUsage(): void {
  console.log(`Usage:
  pnpm ops:backup -- --db=./data/lethebot.db --out=./backups/lethebot.db
  pnpm ops:restore -- --backup=./backups/lethebot.db --db=./data/lethebot.db --overwrite
  pnpm ops:retention -- --raw-days=30 --chat-days=90 --audit-days=90 --memory-days=365
  pnpm ops:metrics -- --since=2026-07-01T00:00:00Z
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
