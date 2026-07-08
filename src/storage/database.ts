/**
 * Database Connection & Setup
 *
 * SQLite 数据库连接和初始化
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { redactSecretsInText } from '../memory/secret-scan';

export interface DatabaseConfig {
  path: string;
  readonly?: boolean;
  verbose?: boolean;
}

/**
 * 初始化数据库连接
 */
export function initDatabase(config: DatabaseConfig): Database.Database {
  const db = new Database(config.path, {
    readonly: config.readonly ?? false,
    verbose: config.verbose ? logVerboseSql : undefined,
  });

  // 启用外键约束
  db.pragma('foreign_keys = ON');

  // 启用 WAL 模式以提高并发性能
  if (!config.readonly) {
    db.pragma('journal_mode = WAL');
  }

  return db;
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
 * 执行 SQL 迁移
 */
export function runMigration(db: Database.Database, migrationPath: string): void {
  const sql = readFileSync(migrationPath, 'utf-8');

  // 使用事务执行迁移
  db.transaction(() => {
    db.exec(sql);
  })();
}

/**
 * 获取当前 schema 版本
 */
export function getSchemaVersion(db: Database.Database): number {
  try {
    const result = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as
      | { version: number }
      | undefined;
    return result?.version ?? 0;
  } catch {
    // 表不存在，返回版本 0
    return 0;
  }
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
