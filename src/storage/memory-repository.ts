/**
 * Memory Repository
 *
 * 内存记录的持久化操作
 */

import type Database from 'better-sqlite3';
import type { MemoryRecord } from '../types/memory';
import { ulid } from 'ulidx';

export interface MemoryRecordInput {
  scope: MemoryRecord['scope'];
  canonicalUserId?: string;
  groupId?: string;
  conversationId?: string;
  subjectUserId?: string;
  visibility: MemoryRecord['visibility'];
  sensitivity: MemoryRecord['sensitivity'];
  authority: MemoryRecord['authority'];
  kind: MemoryRecord['kind'];
  title: string;
  content: string;
  state: MemoryRecord['state'];
  confidence: number;
  importance: number;
  sourceContext?: string;
  evaluatorDecisionId?: string;
  expiresAt?: Date;
}

export interface MemoryFilters {
  canonicalUserId?: string;
  groupId?: string;
  conversationId?: string;
  scope?: MemoryRecord['scope'];
  contextType?: 'private' | 'group';
  state?: MemoryRecord['state'];
  limit?: number;
}

/**
 * 内存记录仓储
 */
export class MemoryRepository {
  constructor(private readonly _db: Database.Database) {}

  private get db(): Database.Database {
    return this._db;
  }

  /**
   * 创建新的内存记录
   */
  async create(input: MemoryRecordInput): Promise<string> {
    const id = ulid();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO memory_records (
        id, scope, canonical_user_id, group_id, conversation_id, subject_user_id,
        visibility, sensitivity, authority, kind, title, content, state,
        confidence, importance, source_context, evaluator_decision_id,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.scope,
        input.canonicalUserId ?? null,
        input.groupId ?? null,
        input.conversationId ?? null,
        input.subjectUserId ?? null,
        input.visibility,
        input.sensitivity,
        input.authority,
        input.kind,
        input.title,
        input.content,
        input.state,
        input.confidence,
        input.importance,
        input.sourceContext ?? null,
        input.evaluatorDecisionId ?? null,
        now,
        now,
        input.expiresAt?.getTime() ?? null
      );

    return id;
  }

  /**
   * 通过 ID 查找内存记录
   */
  async findById(id: string): Promise<MemoryRecord | null> {
    const row = this.db.prepare('SELECT * FROM memory_records WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;

    return row ? this.rowToRecord(row) : null;
  }

  /**
   * 检索内存记录（带过滤和可见性规则）
   */
  async retrieve(filters: MemoryFilters): Promise<MemoryRecord[]> {
    let query = 'SELECT * FROM memory_records WHERE state = ?';
    const params: unknown[] = [filters.state ?? 'active'];

    if (filters.canonicalUserId) {
      query += ' AND canonical_user_id = ?';
      params.push(filters.canonicalUserId);
    }

    if (filters.groupId) {
      query += ' AND group_id = ?';
      params.push(filters.groupId);
    }

    if (filters.conversationId) {
      query += ' AND conversation_id = ?';
      params.push(filters.conversationId);
    }

    if (filters.scope) {
      query += ' AND scope = ?';
      params.push(filters.scope);
    }

    // 可见性过滤
    if (filters.contextType === 'private') {
      query += ' AND visibility IN (?, ?, ?)';
      params.push('private_only', 'same_user_any_context', 'public');
    } else if (filters.contextType === 'group') {
      query += ' AND visibility IN (?, ?, ?)';
      params.push('same_group_only', 'same_user_any_context', 'public');
    }

    query += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(filters.limit ?? 50);

    const rows = this.db.prepare(query).all(...params) as unknown[];
    return rows.map((r) => this.rowToRecord(r as Record<string, unknown>));
  }

  /**
   * 更新内存记录状态
   */
  async updateState(id: string, state: MemoryRecord['state']): Promise<void> {
    this.db
      .prepare('UPDATE memory_records SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, Date.now(), id);
  }

  /**
   * 删除内存记录（软删除）
   */
  async delete(id: string): Promise<void> {
    await this.updateState(id, 'deleted');
  }

  /**
   * 禁用内存记录
   */
  async disable(id: string): Promise<void> {
    await this.updateState(id, 'disabled');
  }

  /**
   * 全文搜索内存记录
   */
  async search(query: string, filters?: MemoryFilters): Promise<MemoryRecord[]> {
    // 先从 FTS 搜索获取 rowid
    const ftsRows = this.db
      .prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(query, filters?.limit ?? 50) as Array<{ rowid: number }>;

    if (ftsRows.length === 0) {
      return [];
    }

    // 获取完整记录
    const rowids = ftsRows.map((r) => r.rowid);
    const placeholders = rowids.map(() => '?').join(',');
    const records = this.db
      .prepare(`SELECT * FROM memory_records WHERE rowid IN (${placeholders}) AND state = 'active'`)
      .all(...rowids) as unknown[];

    return records.map((r) => this.rowToRecord(r as Record<string, unknown>));
  }

  /**
   * 将数据库行转换为 MemoryRecord
   */
  private rowToRecord(row: Record<string, unknown>): MemoryRecord {
    return {
      id: row.id as string,
      scope: row.scope as MemoryRecord['scope'],
      canonicalUserId: (row.canonical_user_id as string | null) ?? undefined,
      groupId: (row.group_id as string | null) ?? undefined,
      conversationId: (row.conversation_id as string | null) ?? undefined,
      subjectUserId: (row.subject_user_id as string | null) ?? undefined,
      visibility: row.visibility as MemoryRecord['visibility'],
      sensitivity: row.sensitivity as MemoryRecord['sensitivity'],
      authority: row.authority as MemoryRecord['authority'],
      kind: row.kind as MemoryRecord['kind'],
      title: row.title as string,
      content: row.content as string,
      state: row.state as MemoryRecord['state'],
      confidence: row.confidence as number,
      importance: row.importance as number,
      sourceContext: row.source_context as string,
      sourceEventIds: [], // 需要单独查询 memory_sources
      evaluatorDecisionId: row.evaluator_decision_id as string | undefined,
      createdAt: new Date(row.created_at as number),
      updatedAt: new Date(row.updated_at as number),
      expiresAt: row.expires_at ? new Date(row.expires_at as number) : undefined,
    };
  }
}
