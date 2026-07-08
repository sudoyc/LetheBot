/**
 * Memory Repository
 *
 * 内存记录的持久化操作
 */

import type Database from 'better-sqlite3';
import type { AuditEntry } from '../types/audit';
import type { MemoryRecord, MemorySource } from '../types/memory';
import type { ActorClass, InvocationContext } from '../types/tool';
import {
  redactSecretsInText,
  scanMemoryForSecrets,
  type SecretScanFinding,
} from '../memory/secret-scan.js';
import { ulid } from 'ulidx';

export interface MemorySourceInput {
  sourceType: MemorySource['sourceType'];
  sourceId: string;
  sourceTimestamp?: Date | number;
  extractedBy?: MemorySource['extractedBy'];
}

export interface MemoryActorInput {
  canonicalUserId?: string;
  actorClass?: ActorClass;
  context?: InvocationContext;
}

export interface MemoryRecordInput {
  id?: string;
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
  sources?: MemorySourceInput[];
  actor?: MemoryActorInput;
  revisionReason?: string;
  auditSummary?: string;
}

export interface MemoryStateChangeOptions {
  actor?: MemoryActorInput;
  reason?: string;
  auditSummary?: string;
  auditDetails?: Record<string, unknown>;
  evaluatorDecisionId?: string;
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

export class MemoryPolicyError extends Error {
  constructor(
    message: string,
    public readonly code: 'SECRET_OR_PROHIBITED_MEMORY',
    public readonly findings: SecretScanFinding[]
  ) {
    super(message);
    this.name = 'MemoryPolicyError';
  }
}

type MemoryRow = Record<string, unknown>;

type MemoryRecordSnapshot = Omit<MemoryRecord, 'createdAt' | 'updatedAt' | 'expiresAt'> & {
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};

type MemoryRevisionChangeType =
  | 'create'
  | 'update'
  | 'approve'
  | 'reject'
  | 'supersede'
  | 'disable'
  | 'delete'
  | 'restore';

/**
 * 内存记录仓储
 */
export class MemoryRepository {
  constructor(private readonly _db: Database.Database) {}

  private get db(): Database.Database {
    return this._db;
  }

  /**
   * 创建新的内存记录。
   *
   * 该方法是 durable memory 的受治理写入路径：同一事务内写入
   * memory_records、memory_sources、memory_revisions、audit_log，并同步更新 FTS。
   */
  async create(input: MemoryRecordInput): Promise<string> {
    const findings = this.scanForBlockedMemory(input);
    if (findings.length > 0) {
      throw new MemoryPolicyError(
        'Memory content matched deterministic secret/prohibited policy',
        'SECRET_OR_PROHIBITED_MEMORY',
        findings
      );
    }

    const id = input.id ?? ulid();
    const now = Date.now();
    const evaluatorDecisionId = input.evaluatorDecisionId ?? this.defaultPolicyDecisionId(id, input.state);
    const actor = this.resolveActor(input.actor, input, 'create');
    const sources = this.resolveSources(input, id, now, actor);

    const createTransaction = this.db.transaction(() => {
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
          evaluatorDecisionId,
          now,
          now,
          input.expiresAt?.getTime() ?? null
        );

      const rowid = this.getMemoryRowId(id);
      this.upsertFtsRow(rowid, input.title, input.content);

      this.insertSources(id, sources);

      const newState = this.rowToSnapshot(this.getRequiredMemoryRow(id));
      this.insertRevision({
        memoryId: id,
        revisionNumber: 1,
        changeType: 'create',
        previousState: null,
        newState,
        reason: input.revisionReason ?? this.defaultCreateReason(input),
        actor: this.actorToRevisionActor(actor),
        evaluatorDecisionId,
        createdAt: now,
      });

      this.insertAudit({
        timestamp: new Date(now),
        category: 'memory',
        level: 'summary',
        eventType: 'memory.create',
        eventId: id,
        actor: {
          canonicalUserId: actor.canonicalUserId,
          actorClass: actor.actorClass,
          context: actor.context,
        },
        summary: input.auditSummary ?? `Created ${input.state} ${input.scope} memory`,
        details: {
          memoryId: id,
          scope: input.scope,
          state: input.state,
          visibility: input.visibility,
          sensitivity: input.sensitivity,
          authority: input.authority,
          sourceCount: sources.length,
          policyDecision: evaluatorDecisionId,
        },
        redacted: true,
        riskLevel: this.riskLevelForMemory(input),
        evaluatorDecisionId,
      });
    });

    createTransaction();

    return id;
  }

  /**
   * 通过 ID 查找内存记录
   */
  async findById(id: string): Promise<MemoryRecord | null> {
    const row = this.db.prepare('SELECT * FROM memory_records WHERE id = ?').get(id) as
      | MemoryRow
      | undefined;

    return row ? this.rowToRecord(row) : null;
  }

  /**
   * 检索内存记录（带过滤和可见性规则）
   */
  async retrieve(filters: MemoryFilters): Promise<MemoryRecord[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM memory_records WHERE 1=1';

    query += ' AND state = ?';
    params.push(filters.state ?? 'active');

    query += ' AND sensitivity NOT IN (?, ?)';
    params.push('secret', 'prohibited');

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

    query += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(filters.limit ?? 50);

    const rows = this.db.prepare(query).all(...params) as MemoryRow[];
    return rows
      .map((r) => this.rowToRecord(r))
      .filter((record) => this.isAllowedForRetrieval(record, filters));
  }

  /**
   * 更新内存记录状态
   */
  async updateState(
    id: string,
    state: MemoryRecord['state'],
    options?: MemoryStateChangeOptions
  ): Promise<void> {
    const now = Date.now();

    const updateTransaction = this.db.transaction(() => {
      const previousRow = this.db.prepare('SELECT * FROM memory_records WHERE id = ?').get(id) as
        | MemoryRow
        | undefined;

      if (!previousRow) {
        return;
      }

      const previousRecord = this.rowToRecord(previousRow);
      if (previousRecord.state === state) {
        return;
      }

      const changeType = this.changeTypeForTransition(previousRecord.state, state);
      const evaluatorDecisionId = options?.evaluatorDecisionId
        ?? previousRecord.evaluatorDecisionId
        ?? this.defaultPolicyDecisionId(id, state);
      const actor = this.resolveActor(options?.actor, previousRecord, changeType);

      this.db
        .prepare(
          `UPDATE memory_records
           SET state = ?, updated_at = ?, evaluator_decision_id = ?
           WHERE id = ?`
        )
        .run(state, now, evaluatorDecisionId, id);

      const updatedRow = this.getRequiredMemoryRow(id);
      const nextRevision = this.nextRevisionNumber(id);

      this.insertRevision({
        memoryId: id,
        revisionNumber: nextRevision,
        changeType,
        previousState: this.recordToSnapshot(previousRecord),
        newState: this.rowToSnapshot(updatedRow),
        reason: options?.reason ?? `State changed from ${previousRecord.state} to ${state}`,
        actor: this.actorToRevisionActor(actor),
        evaluatorDecisionId,
        createdAt: now,
      });

      this.insertAudit({
        timestamp: new Date(now),
        category: 'memory',
        level: 'summary',
        eventType: `memory.${changeType}`,
        eventId: id,
        actor: {
          canonicalUserId: actor.canonicalUserId,
          actorClass: actor.actorClass,
          context: actor.context,
        },
        summary: options?.auditSummary ?? `Changed memory state to ${state}`,
        details: {
          memoryId: id,
          previousState: previousRecord.state,
          newState: state,
          revisionNumber: nextRevision,
          policyDecision: evaluatorDecisionId,
          ...(options?.auditDetails ?? {}),
        },
        redacted: true,
        riskLevel: 'low',
        evaluatorDecisionId,
      });
    });

    updateTransaction();
  }

  /**
   * 删除内存记录（软删除）
   */
  async delete(id: string, options?: MemoryStateChangeOptions): Promise<void> {
    await this.updateState(id, 'deleted', options);
  }

  /**
   * 禁用内存记录
   */
  async disable(id: string, options?: MemoryStateChangeOptions): Promise<void> {
    await this.updateState(id, 'disabled', options);
  }

  /**
   * 批准 proposed memory，变为 active。
   */
  async approve(id: string, options?: MemoryStateChangeOptions): Promise<void> {
    await this.updateState(id, 'active', options);
  }

  /**
   * 拒绝 proposed memory。Rejected records remain auditable but are excluded
   * from ordinary retrieval because retrieval defaults to active-only.
   */
  async reject(id: string, options?: MemoryStateChangeOptions): Promise<void> {
    await this.updateState(id, 'rejected', options);
  }

  /**
   * 标记旧记忆已被新证据/新记录取代。
   */
  async supersede(id: string, options?: MemoryStateChangeOptions): Promise<void> {
    await this.updateState(id, 'superseded', options);
  }

  /**
   * 恢复被禁用或拒绝的记忆。
   */
  async restore(id: string, options?: MemoryStateChangeOptions): Promise<void> {
    await this.updateState(id, 'active', options);
  }

  /**
   * 全文搜索内存记录
   */
  async search(query: string, filters: MemoryFilters = {}): Promise<MemoryRecord[]> {
    const ftsRows = this.db
      .prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?')
      .all(query, filters.limit ?? 50) as Array<{ rowid: number }>;

    if (ftsRows.length === 0) {
      return [];
    }

    const rowids = ftsRows.map((r) => r.rowid);
    const placeholders = rowids.map(() => '?').join(',');
    const params: unknown[] = [...rowids];

    let sql = `SELECT * FROM memory_records WHERE rowid IN (${placeholders})`;
    sql += ' AND state = ?';
    params.push(filters.state ?? 'active');

    sql += ' AND sensitivity NOT IN (?, ?)';
    params.push('secret', 'prohibited');

    if (filters.canonicalUserId) {
      sql += ' AND canonical_user_id = ?';
      params.push(filters.canonicalUserId);
    }

    if (filters.groupId) {
      sql += ' AND group_id = ?';
      params.push(filters.groupId);
    }

    if (filters.conversationId) {
      sql += ' AND conversation_id = ?';
      params.push(filters.conversationId);
    }

    if (filters.scope) {
      sql += ' AND scope = ?';
      params.push(filters.scope);
    }

    const records = this.db.prepare(sql).all(...params) as MemoryRow[];
    return records
      .map((r) => this.rowToRecord(r))
      .filter((record) => this.isAllowedForRetrieval(record, filters));
  }

  private scanForBlockedMemory(input: MemoryRecordInput): SecretScanFinding[] {
    if (input.sensitivity === 'secret' || input.sensitivity === 'prohibited') {
      return [
        {
          kind: input.sensitivity,
          pattern: 'declared_sensitivity',
        },
      ];
    }

    return scanMemoryForSecrets(`${input.title}\n${input.content}`);
  }

  private resolveSources(
    input: MemoryRecordInput,
    memoryId: string,
    now: number,
    actor: Required<Pick<MemoryActorInput, 'actorClass' | 'context'>> & Pick<MemoryActorInput, 'canonicalUserId'>
  ): Required<MemorySourceInput>[] {
    if (input.sources && input.sources.length > 0) {
      return input.sources.map((source) => ({
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceTimestamp: source.sourceTimestamp ?? now,
        extractedBy: source.extractedBy ?? this.extractedByForActor(actor.actorClass),
      }));
    }

    return [
      {
        sourceType: this.defaultSourceType(input),
        sourceId: input.sourceContext ?? `memory:${memoryId}`,
        sourceTimestamp: now,
        extractedBy: this.extractedByForActor(actor.actorClass),
      },
    ];
  }

  private defaultSourceType(input: MemoryRecordInput): MemorySource['sourceType'] {
    if (input.sourceContext?.startsWith('chat:')) {
      return 'chat_message';
    }

    if (input.sourceContext?.startsWith('tool_result') || input.authority === 'tool_derived') {
      return 'tool_output';
    }

    if (input.authority === 'user_stated') {
      return 'user_command';
    }

    return 'worker_extraction';
  }

  private insertSources(memoryId: string, sources: Required<MemorySourceInput>[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO memory_sources (memory_id, source_type, source_id, source_timestamp, extracted_by)
       VALUES (?, ?, ?, ?, ?)`
    );

    const seen = new Set<string>();
    for (const source of sources) {
      const key = `${memoryId}\u0000${source.sourceId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      stmt.run(
        memoryId,
        source.sourceType,
        source.sourceId,
        this.sourceTimestampToNumber(source.sourceTimestamp),
        source.extractedBy ?? null
      );
    }
  }

  private insertRevision(input: {
    memoryId: string;
    revisionNumber: number;
    changeType: MemoryRevisionChangeType;
    previousState: MemoryRecordSnapshot | null;
    newState: MemoryRecordSnapshot;
    reason: string;
    actor: string;
    evaluatorDecisionId?: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type, previous_state, new_state,
          reason, actor, evaluator_decision_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ulid(),
        input.memoryId,
        input.revisionNumber,
        input.changeType,
        input.previousState ? JSON.stringify(input.previousState) : null,
        JSON.stringify(input.newState),
        this.redactAuditText(input.reason),
        input.actor,
        input.evaluatorDecisionId ?? null,
        input.createdAt
      );
  }

  private insertAudit(entry: Omit<AuditEntry, 'id'>): void {
    const summary = this.redactAuditText(entry.summary);
    const details = entry.details ? this.redactAuditStructuredValue(entry.details) : null;

    this.db
      .prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_user_id, actor_class, invocation_context,
          summary, details, redacted, risk_level, evaluator_decision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ulid(),
        entry.timestamp.getTime(),
        entry.category,
        entry.level,
        entry.eventType,
        entry.eventId,
        entry.actor.canonicalUserId ?? null,
        entry.actor.actorClass,
        entry.actor.context,
        summary,
        details ? JSON.stringify(details) : null,
        entry.redacted ? 1 : 0,
        entry.riskLevel ?? null,
        entry.evaluatorDecisionId ?? null
      );
  }

  private redactAuditText(text: string): string {
    const platformRedacted = this.redactPlatformIdentifiers(text);
    const secretRedacted = redactSecretsInText(platformRedacted).text;
    const redacted = this.redactPlatformIdentifiers(secretRedacted);
    const platformMarkerLost =
      platformRedacted.includes('[REDACTED:platform_id]') && !redacted.includes('[REDACTED:platform_id]');

    return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
  }

  private redactPlatformIdentifiers(text: string): string {
    return text
      .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
      .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
  }

  private redactAuditStructuredValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.redactAuditText(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redactAuditStructuredValue(item));
    }

    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        result[this.redactAuditText(key)] = this.redactAuditStructuredValue(child);
      }
      return result;
    }

    return value;
  }

  private upsertFtsRow(rowid: number, title: string, content: string): void {
    this.db
      .prepare('INSERT INTO memory_fts(rowid, title, content) VALUES (?, ?, ?)')
      .run(rowid, title, content);
  }

  private getMemoryRowId(id: string): number {
    const row = this.db.prepare('SELECT rowid FROM memory_records WHERE id = ?').get(id) as
      | { rowid: number }
      | undefined;

    if (!row) {
      throw new Error(`Memory ${id} was not inserted`);
    }

    return row.rowid;
  }

  private getRequiredMemoryRow(id: string): MemoryRow {
    const row = this.db.prepare('SELECT * FROM memory_records WHERE id = ?').get(id) as
      | MemoryRow
      | undefined;

    if (!row) {
      throw new Error(`Memory ${id} not found`);
    }

    return row;
  }

  private nextRevisionNumber(memoryId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 as next FROM memory_revisions WHERE memory_id = ?')
      .get(memoryId) as { next: number };

    return row.next;
  }

  private resolveActor(
    actor: MemoryActorInput | undefined,
    input: Pick<MemoryRecordInput, 'canonicalUserId' | 'authority' | 'sourceContext'>,
    changeType: MemoryRevisionChangeType
  ): Required<Pick<MemoryActorInput, 'actorClass' | 'context'>> & Pick<MemoryActorInput, 'canonicalUserId'> {
    const context = actor?.context ?? this.inferInvocationContext(input.sourceContext, changeType);
    const actorClass = actor?.actorClass ?? this.inferActorClass(input.authority, context, changeType);

    return {
      canonicalUserId: actor?.canonicalUserId ?? input.canonicalUserId,
      actorClass,
      context,
    };
  }

  private inferInvocationContext(
    sourceContext: string | undefined,
    changeType: MemoryRevisionChangeType
  ): InvocationContext {
    if (sourceContext?.startsWith('group_chat')) {
      return 'group_chat';
    }
    if (sourceContext?.startsWith('private_chat') || sourceContext?.startsWith('chat:')) {
      return 'private_chat';
    }
    if (sourceContext?.startsWith('admin_cli')) {
      return 'admin_cli';
    }
    if (sourceContext?.startsWith('background_worker')) {
      return 'background_worker';
    }
    if (
      changeType === 'approve' ||
      changeType === 'reject' ||
      changeType === 'disable' ||
      changeType === 'delete' ||
      changeType === 'restore'
    ) {
      return 'admin_cli';
    }
    return 'internal';
  }

  private inferActorClass(
    authority: MemoryRecord['authority'] | undefined,
    context: InvocationContext,
    changeType: MemoryRevisionChangeType
  ): ActorClass {
    if (
      changeType === 'approve' ||
      changeType === 'reject' ||
      changeType === 'disable' ||
      changeType === 'delete' ||
      changeType === 'restore'
    ) {
      return 'admin';
    }
    if (authority === 'user_stated') {
      return 'user';
    }
    if (authority === 'tool_derived') {
      return 'tool';
    }
    if (context === 'background_worker') {
      return 'system_worker';
    }
    return 'system_worker';
  }

  private actorToRevisionActor(
    actor: Required<Pick<MemoryActorInput, 'actorClass' | 'context'>> & Pick<MemoryActorInput, 'canonicalUserId'>
  ): string {
    return actor.canonicalUserId ?? actor.actorClass;
  }

  private extractedByForActor(actorClass: ActorClass): NonNullable<MemorySource['extractedBy']> {
    if (actorClass === 'evaluator') {
      return 'evaluator';
    }
    if (actorClass === 'user' || actorClass === 'trusted_user' || actorClass === 'admin' || actorClass === 'owner') {
      return 'user';
    }
    return 'worker';
  }

  private sourceTimestampToNumber(value: Date | number): number {
    return value instanceof Date ? value.getTime() : value;
  }

  private defaultPolicyDecisionId(memoryId: string, state: MemoryRecord['state']): string {
    return `policy:l0:${state}:${memoryId}`;
  }

  private defaultCreateReason(input: MemoryRecordInput): string {
    return `Governed memory create via repository (${input.state})`;
  }

  private riskLevelForMemory(input: MemoryRecordInput): AuditEntry['riskLevel'] {
    if (input.sensitivity === 'sensitive') {
      return 'medium';
    }
    if (input.visibility === 'owner_admin_only') {
      return 'medium';
    }
    return 'low';
  }

  private changeTypeForTransition(
    previousState: MemoryRecord['state'],
    state: MemoryRecord['state']
  ): Exclude<MemoryRevisionChangeType, 'create'> {
    if (state === 'active' && previousState === 'proposed') {
      return 'approve';
    }
    if (state === 'rejected') {
      return 'reject';
    }
    if (state === 'superseded') {
      return 'supersede';
    }
    if (state === 'disabled') {
      return 'disable';
    }
    if (state === 'deleted') {
      return 'delete';
    }
    if (state === 'active') {
      return 'restore';
    }
    return 'update';
  }

  private isAllowedForRetrieval(record: MemoryRecord, filters: MemoryFilters): boolean {
    if (record.sensitivity === 'secret' || record.sensitivity === 'prohibited') {
      return false;
    }

    if (!filters.contextType) {
      return true;
    }

    if (record.visibility === 'owner_admin_only') {
      return false;
    }

    if (record.visibility === 'private_only') {
      return filters.contextType === 'private';
    }

    if (record.visibility === 'same_group_only') {
      return filters.contextType === 'group'
        && (
          (Boolean(filters.groupId) && record.groupId === filters.groupId)
          || (Boolean(filters.conversationId) && record.conversationId === filters.conversationId)
        );
    }

    if (record.visibility === 'same_user_any_context') {
      return true;
    }

    if (record.visibility === 'public') {
      return true;
    }

    return false;
  }

  private rowToSnapshot(row: MemoryRow): MemoryRecordSnapshot {
    return this.recordToSnapshot(this.rowToRecord(row));
  }

  private recordToSnapshot(record: MemoryRecord): MemoryRecordSnapshot {
    return {
      ...record,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      expiresAt: record.expiresAt?.toISOString(),
    };
  }

  /**
   * 将数据库行转换为 MemoryRecord
   */
  private rowToRecord(row: MemoryRow): MemoryRecord {
    const id = row.id as string;

    return {
      id,
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
      sourceEventIds: this.listSourceIds(id),
      evaluatorDecisionId: (row.evaluator_decision_id as string | null) ?? undefined,
      createdAt: new Date(row.created_at as number),
      updatedAt: new Date(row.updated_at as number),
      expiresAt: row.expires_at ? new Date(row.expires_at as number) : undefined,
    };
  }

  private listSourceIds(memoryId: string): string[] {
    const rows = this.db
      .prepare('SELECT source_id FROM memory_sources WHERE memory_id = ? ORDER BY source_timestamp ASC, source_id ASC')
      .all(memoryId) as Array<{ source_id: string }>;

    return rows.map((row) => row.source_id);
  }
}
