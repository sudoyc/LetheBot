/**
 * Database Connection & Setup
 *
 * SQLite 数据库连接和初始化
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

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
    verbose: config.verbose ? console.log : undefined,
  });

  // 启用外键约束
  db.pragma('foreign_keys = ON');

  // 启用 WAL 模式以提高并发性能
  if (!config.readonly) {
    db.pragma('journal_mode = WAL');
  }

  return db;
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
