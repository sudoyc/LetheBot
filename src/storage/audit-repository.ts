/**
 * Audit Repository
 *
 * 审计日志的持久化操作
 */

import type Database from 'better-sqlite3';
import type { AuditEntry, AuditQueryOptions, AuditStatsResult } from '../types/audit';
import { ulid } from 'ulidx';

/**
 * 审计日志仓储
 */
export class AuditRepository {
  constructor(private readonly _db: Database.Database) {}

  private get db(): Database.Database {
    return this._db;
  }

  /**
   * 创建审计日志条目
   */
  async create(entry: Omit<AuditEntry, 'id'>): Promise<string> {
    const id = ulid();

    this.db
      .prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_user_id, actor_class, invocation_context,
          summary, details, redacted, risk_level, evaluator_decision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        entry.timestamp.getTime(),
        entry.category,
        entry.level,
        entry.eventType,
        entry.eventId,
        entry.actor.canonicalUserId ?? null,
        entry.actor.actorClass,
        entry.actor.context,
        entry.summary,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.redacted ? 1 : 0,
        entry.riskLevel ?? null,
        entry.evaluatorDecisionId ?? null
      );

    return id;
  }

  /**
   * 通过 ID 查找审计日志
   */
  async findById(id: string): Promise<AuditEntry | null> {
    const row = this.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;

    return row ? this.rowToEntry(row) : null;
  }

  /**
   * 查询审计日志
   */
  async query(options: AuditQueryOptions): Promise<AuditEntry[]> {
    let query = 'SELECT * FROM audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (options.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }

    if (options.level) {
      query += ' AND level = ?';
      params.push(options.level);
    }

    if (options.eventType) {
      query += ' AND event_type = ?';
      params.push(options.eventType);
    }

    if (options.userId) {
      query += ' AND actor_user_id = ?';
      params.push(options.userId);
    }

    if (options.startTime) {
      query += ' AND timestamp >= ?';
      params.push(options.startTime.getTime());
    }

    if (options.endTime) {
      query += ' AND timestamp <= ?';
      params.push(options.endTime.getTime());
    }

    if (options.riskLevel) {
      query += ' AND risk_level = ?';
      params.push(options.riskLevel);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as unknown[];
    return rows.map((r) => this.rowToEntry(r as Record<string, unknown>));
  }

  /**
   * 根据 Memory ID 查询审计日志
   */
  async listByMemoryId(memoryId: string): Promise<AuditEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log
         WHERE category = 'memory' AND event_id = ?
         ORDER BY timestamp ASC`
      )
      .all(memoryId) as unknown[];

    return rows.map((r) => this.rowToEntry(r as Record<string, unknown>));
  }

  /**
   * 获取审计统计
   */
  async getStats(startTime?: Date, endTime?: Date): Promise<AuditStatsResult> {
    let timeFilter = '';
    const params: unknown[] = [];

    if (startTime) {
      timeFilter += ' AND timestamp >= ?';
      params.push(startTime.getTime());
    }

    if (endTime) {
      timeFilter += ' AND timestamp <= ?';
      params.push(endTime.getTime());
    }

    // 总事件数
    const totalResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM audit_log WHERE 1=1${timeFilter}`)
      .get(...params) as { count: number };

    // 按类别统计
    const categoryRows = this.db
      .prepare(`SELECT category, COUNT(*) as count FROM audit_log WHERE 1=1${timeFilter} GROUP BY category`)
      .all(...params) as Array<{ category: string; count: number }>;

    const eventsByCategory: Record<string, number> = {};
    for (const row of categoryRows) {
      eventsByCategory[row.category] = row.count;
    }

    // 按风险级别统计
    const riskRows = this.db
      .prepare(
        `SELECT risk_level, COUNT(*) as count FROM audit_log
         WHERE risk_level IS NOT NULL${timeFilter}
         GROUP BY risk_level`
      )
      .all(...params) as Array<{ risk_level: string; count: number }>;

    const eventsByRiskLevel: Record<string, number> = {};
    for (const row of riskRows) {
      eventsByRiskLevel[row.risk_level] = row.count;
    }

    // 最近 7 天活动
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const activityRows = this.db
      .prepare(
        `SELECT DATE(timestamp / 1000, 'unixepoch') as date, COUNT(*) as count
         FROM audit_log
         WHERE timestamp >= ?
         GROUP BY date
         ORDER BY date DESC`
      )
      .all(sevenDaysAgo) as Array<{ date: string; count: number }>;

    return {
      totalEvents: totalResult.count,
      eventsByCategory,
      eventsByRiskLevel,
      recentActivity: activityRows,
    };
  }

  /**
   * 将数据库行转换为 AuditEntry
   */
  private rowToEntry(row: Record<string, unknown>): AuditEntry {
    return {
      id: row.id as string,
      timestamp: new Date(row.timestamp as number),
      category: row.category as AuditEntry['category'],
      level: row.level as AuditEntry['level'],
      eventType: row.event_type as string,
      eventId: row.event_id as string,
      actor: {
        canonicalUserId: (row.actor_user_id as string | null) ?? undefined,
        actorClass: row.actor_class as AuditEntry['actor']['actorClass'],
        context: row.invocation_context as AuditEntry['actor']['context'],
      },
      summary: row.summary as string,
      details: row.details ? JSON.parse(row.details as string) : undefined,
      redacted: Boolean(row.redacted),
      riskLevel: (row.risk_level as AuditEntry['riskLevel']) ?? undefined,
      evaluatorDecisionId: (row.evaluator_decision_id as string | null) ?? undefined,
    };
  }
}
