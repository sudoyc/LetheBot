/**
 * Memory Repository
 *
 * 内存记录的持久化操作
 */

import type Database from 'better-sqlite3';
import type { AuditEntry } from '../types/audit.js';
import type { MemoryRecord, MemorySource } from '../types/memory.js';
import type { ActorClass, InvocationContext } from '../types/tool.js';
import {
  redactSecretsInText,
  scanMemoryForSecrets,
  type SecretScanFinding,
} from '../memory/secret-scan.js';
import { GroupSummaryPolicyRepository } from './group-summary-policy-repository.js';
import { ulid } from 'ulidx';

export interface MemorySourceInput {
  sourceType: MemorySource['sourceType'];
  sourceId: string;
  sourceTimestamp?: Date | number;
  extractedBy?: MemorySource['extractedBy'];
  external?: boolean;
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

type PreparedMemorySource = Required<MemorySourceInput>;

type ResolvedMemorySource = PreparedMemorySource & {
  resolutionState: 'internal' | 'external';
  rawEventId?: string;
  chatMessageId?: string;
  toolCallId?: string;
  jobId?: string;
  jobAttemptId?: string;
};

type WorkerSourceRow = {
  id: string;
  payload: string | null;
  result: string | null;
  attemptResult: string | null;
};

type MemoryBoundaryEvidence = {
  conversationId: string | null;
  conversationType: 'private' | 'group' | null;
  groupId: string | null;
  senderCanonicalUserId: string | null;
  actorCanonicalUserId: string | null;
  invocationContext: InvocationContext | null;
};

/**
 * 内存记录仓储
 */
export class MemoryRepository {
  private readonly groupSummaryPolicies: GroupSummaryPolicyRepository;

  constructor(private readonly _db: Database.Database) {
    this.groupSummaryPolicies = new GroupSummaryPolicyRepository(_db);
  }

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
    return this.createSync(input);
  }

  createSync(input: MemoryRecordInput): string {
    const createPolicy = this.applyCreatePolicy(input);
    const governedInput = createPolicy.input;
    this.assertScopeOwnerBoundary(governedInput);
    this.assertMemoryPolicyAllowed(governedInput);

    const id = governedInput.id ?? ulid();
    const now = Date.now();
    const evaluatorDecisionId = governedInput.evaluatorDecisionId ?? this.defaultPolicyDecisionId(id, governedInput.state);
    const actor = this.resolveActor(governedInput.actor, governedInput, 'create');
    const sources = this.resolveSources(governedInput, now, actor);
    const expiresAt = this.resolveExpiresAtTimestamp(governedInput.expiresAt);

    const createTransaction = this.db.transaction(() => {
      const resolvedSources = this.resolveSourceReferences(governedInput, sources, actor);

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
          governedInput.scope,
          governedInput.canonicalUserId ?? null,
          governedInput.groupId ?? null,
          governedInput.conversationId ?? null,
          governedInput.subjectUserId ?? null,
          governedInput.visibility,
          governedInput.sensitivity,
          governedInput.authority,
          governedInput.kind,
          governedInput.title,
          governedInput.content,
          governedInput.state,
          governedInput.confidence,
          governedInput.importance,
          governedInput.sourceContext ?? null,
          evaluatorDecisionId,
          now,
          now,
          expiresAt
        );

      const rowid = this.getMemoryRowId(id);
      this.upsertFtsRow(rowid, governedInput.title, governedInput.content);

      this.insertSources(id, resolvedSources);

      const newState = this.rowToSnapshot(this.getRequiredMemoryRow(id));
      this.insertRevision({
        memoryId: id,
        revisionNumber: 1,
        changeType: 'create',
        previousState: null,
        newState,
        reason: governedInput.revisionReason ?? this.defaultCreateReason(governedInput),
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
        summary: governedInput.auditSummary ?? `Created ${governedInput.state} ${governedInput.scope} memory`,
        details: {
          memoryId: id,
          scope: governedInput.scope,
          state: governedInput.state,
          visibility: governedInput.visibility,
          sensitivity: governedInput.sensitivity,
          authority: governedInput.authority,
          sourceCount: sources.length,
          policyDecision: evaluatorDecisionId,
          ...(createPolicy.adjustments.length > 0 ? { policyAdjustments: createPolicy.adjustments } : {}),
        },
        redacted: true,
        riskLevel: this.riskLevelForMemory(governedInput),
        evaluatorDecisionId,
      });
    });

    createTransaction();

    return id;
  }

  assertCreatePolicyAllowed(input: MemoryRecordInput): void {
    const governedInput = this.applyCreatePolicy(input).input;
    this.assertScopeOwnerBoundary(governedInput);
    this.assertMemoryPolicyAllowed(governedInput);
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

    const state = filters.state ?? 'active';
    query += ' AND state = ?';
    params.push(state);

    if (state === 'active') {
      query += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(Date.now());
    }

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

    query = this.appendContextVisibilityFilter(query, params, filters);
    query = this.appendGroupSummaryPolicyFilter(query, params, filters);

    query += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(filters.limit ?? 50);

    const rows = this.db.prepare(query).all(...params) as MemoryRow[];
    return rows
      .map((r) => this.rowToRecord(r))
      .filter((record) => this.isAllowedForRetrieval(record, filters));
  }

  isGroupSummaryPolicyEnabled(groupId: string): boolean {
    try {
      return this.groupSummaryPolicies.isEnabled(groupId);
    } catch (error) {
      if (this.isMissingGroupSummaryPolicyTable(error)) {
        return false;
      }
      throw error;
    }
  }

  async listPolicyBlockedGroupSummaryIds(filters: {
    groupId: string;
    contextType: 'group';
    limit?: number;
  }): Promise<string[]> {
    if (this.isGroupSummaryPolicyEnabled(filters.groupId)) {
      return [];
    }

    const params: unknown[] = [
      'active',
      Date.now(),
      'secret',
      'prohibited',
      filters.groupId,
      'group',
      'summary',
    ];
    let sql = `
      SELECT id
      FROM memory_records
      WHERE state = ?
        AND (expires_at IS NULL OR expires_at > ?)
        AND sensitivity NOT IN (?, ?)
        AND group_id = ?
        AND scope = ?
        AND kind = ?
    `;
    sql = this.appendContextVisibilityFilter(sql, params, filters);
    sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(this.boundedPolicyTraceLimit(filters.limit));

    const rows = this.db.prepare(sql).all(...params) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * 更新内存记录状态
   */
  async updateState(
    id: string,
    state: MemoryRecord['state'],
    options?: MemoryStateChangeOptions
  ): Promise<void> {
    this.updateStateSync(id, state, options);
  }

  updateStateSync(
    id: string,
    state: MemoryRecord['state'],
    options?: MemoryStateChangeOptions
  ): void {
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

      if (state === 'proposed') {
        throw new Error('memory state transition to proposed is not allowed');
      }

      this.assertAllowedStateTransition(previousRecord.state, state);

      const changeType = this.changeTypeForTransition(previousRecord.state, state);
      const evaluatorDecisionId = options?.evaluatorDecisionId
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
    this.disableSync(id, options);
  }

  disableSync(id: string, options?: MemoryStateChangeOptions): void {
    this.updateStateSync(id, 'disabled', options);
  }

  /**
   * 批准 proposed memory，变为 active。
   */
  async approve(id: string, options?: MemoryStateChangeOptions): Promise<void> {
    this.assertProposedForDecision(id);
    await this.updateState(id, 'active', options);
  }

  /**
   * 拒绝 proposed memory。Rejected records remain auditable but are excluded
   * from ordinary retrieval because retrieval defaults to active-only.
   */
  async reject(id: string, options?: MemoryStateChangeOptions): Promise<void> {
    this.assertProposedForDecision(id);
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
    const params: unknown[] = [query];
    let sql = `
      SELECT memory_records.*
      FROM memory_fts
      JOIN memory_records ON memory_fts.rowid = memory_records.rowid
      WHERE memory_fts MATCH ?
    `;
    const state = filters.state ?? 'active';
    sql += ' AND state = ?';
    params.push(state);

    if (state === 'active') {
      sql += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(Date.now());
    }

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

    sql = this.appendContextVisibilityFilter(sql, params, filters);
    sql = this.appendGroupSummaryPolicyFilter(sql, params, filters);
    sql += ' ORDER BY rank, memory_records.id ASC LIMIT ?';
    params.push(filters.limit ?? 50);

    const records = this.db.prepare(sql).all(...params) as MemoryRow[];
    return records
      .map((r) => this.rowToRecord(r))
      .filter((record) => this.isAllowedForRetrieval(record, filters));
  }

  private appendGroupSummaryPolicyFilter(
    sql: string,
    params: unknown[],
    filters: MemoryFilters,
  ): string {
    if (filters.contextType !== 'group') {
      return sql;
    }

    params.push('group', 'summary');
    if (
      filters.groupId === undefined
      || filters.groupId.length === 0
      || filters.groupId.trim() !== filters.groupId
      || !this.hasGroupSummaryPolicyTable()
    ) {
      return `${sql} AND NOT (memory_records.scope = ? AND memory_records.kind = ?)`;
    }

    return `${sql} AND NOT (
      memory_records.scope = ?
      AND memory_records.kind = ?
      AND NOT EXISTS (
        SELECT 1
          FROM group_summary_policies AS group_summary_policy
         WHERE group_summary_policy.group_id = memory_records.group_id
           AND group_summary_policy.state = 'enabled'
      )
    )`;
  }

  private boundedPolicyTraceLimit(limit?: number): number {
    if (limit === undefined || !Number.isFinite(limit)) {
      return 50;
    }
    return Math.min(Math.max(Math.floor(limit), 1), 50);
  }

  private isMissingGroupSummaryPolicyTable(error: unknown): boolean {
    return error instanceof Error
      && error.message === 'no such table: group_summary_policies';
  }

  private hasGroupSummaryPolicyTable(): boolean {
    return this.db.prepare(
      `SELECT 1
         FROM sqlite_master
        WHERE type = 'table' AND name = 'group_summary_policies'`,
    ).get() !== undefined;
  }

  private appendContextVisibilityFilter(sql: string, params: unknown[], filters: MemoryFilters): string {
    if (!filters.contextType) {
      return sql;
    }

    if (filters.contextType === 'private') {
      params.push('private_only', 'same_user_any_context', 'public');
      return `${sql} AND visibility IN (?, ?, ?)`;
    }

    const visibilityClauses = ['visibility IN (?, ?)'];
    params.push('same_user_any_context', 'public');

    const sameGroupClauses: string[] = [];
    const sameGroupParams: unknown[] = [];
    if (filters.groupId) {
      sameGroupClauses.push('group_id = ?');
      sameGroupParams.push(filters.groupId);
    }
    if (filters.conversationId) {
      sameGroupClauses.push('conversation_id = ?');
      sameGroupParams.push(filters.conversationId);
    }

    if (sameGroupClauses.length > 0) {
      visibilityClauses.push(`(visibility = ? AND (${sameGroupClauses.join(' OR ')}))`);
      params.push('same_group_only', ...sameGroupParams);
    }

    return `${sql} AND (${visibilityClauses.join(' OR ')})`;
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

  private assertMemoryPolicyAllowed(input: MemoryRecordInput): void {
    const findings = this.scanForBlockedMemory(input);
    if (findings.length > 0) {
      throw new MemoryPolicyError(
        'Memory content matched deterministic secret/prohibited policy',
        'SECRET_OR_PROHIBITED_MEMORY',
        findings
      );
    }
  }

  private assertScopeOwnerBoundary(input: MemoryRecordInput): void {
    for (const field of ['canonicalUserId', 'groupId', 'conversationId'] as const) {
      const value = input[field];
      if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
        throw new Error(`memory ${field} must be a non-empty string when provided`);
      }
    }

    if (input.scope === 'user') {
      this.requireScopeOwner(input, 'canonicalUserId');
      if (
        input.visibility === 'same_group_only'
        && input.groupId === undefined
        && input.conversationId === undefined
      ) {
        throw new Error('same_group_only user memory requires groupId or conversationId');
      }
      return;
    }

    if (input.scope === 'group') {
      this.requireScopeOwner(input, 'groupId');
      this.rejectForeignScopeOwner(input, 'canonicalUserId');
      return;
    }

    if (input.scope === 'conversation') {
      this.requireScopeOwner(input, 'conversationId');
      this.rejectForeignScopeOwner(input, 'canonicalUserId');
      return;
    }

    for (const field of ['canonicalUserId', 'groupId', 'conversationId'] as const) {
      this.rejectForeignScopeOwner(input, field);
    }
  }

  private requireScopeOwner(
    input: MemoryRecordInput,
    field: 'canonicalUserId' | 'groupId' | 'conversationId'
  ): void {
    if (input[field] === undefined) {
      throw new Error(`${input.scope} scope requires ${field}`);
    }
  }

  private rejectForeignScopeOwner(
    input: MemoryRecordInput,
    field: 'canonicalUserId' | 'groupId' | 'conversationId'
  ): void {
    if (input[field] !== undefined) {
      throw new Error(`${input.scope} scope cannot set ${field}`);
    }
  }

  private applyCreatePolicy(input: MemoryRecordInput): {
    input: MemoryRecordInput;
    adjustments: string[];
  } {
    const adjustments: string[] = [];
    let governedInput = input;

    if (
      this.isGroupChatDerivedUserMemoryInput(input)
      && this.isUnsafeGroupDerivedUserVisibility(input.visibility)
    ) {
      const adjustment = 'group-chat-derived user memory visibility forced to same_group_only';
      adjustments.push(adjustment);
      const adjustedInput = {
        ...input,
        visibility: 'same_group_only' as const,
      };
      governedInput = {
        ...adjustedInput,
        revisionReason: `${input.revisionReason ?? this.defaultCreateReason(adjustedInput)}; L0 policy: ${adjustment}`,
      };
    }

    return {
      input: governedInput,
      adjustments,
    };
  }

  private isGroupChatDerivedUserMemoryInput(input: MemoryRecordInput): boolean {
    return input.scope === 'user' && input.sourceContext?.startsWith('group_chat') === true;
  }

  private isUnsafeGroupDerivedUserVisibility(visibility: MemoryRecord['visibility']): boolean {
    return visibility !== 'same_group_only' && visibility !== 'owner_admin_only';
  }

  private resolveSources(
    input: MemoryRecordInput,
    now: number,
    actor: Required<Pick<MemoryActorInput, 'actorClass' | 'context'>> & Pick<MemoryActorInput, 'canonicalUserId'>
  ): PreparedMemorySource[] {
    if (!input.sources || input.sources.length === 0) {
      throw new Error('explicit memory source metadata is required');
    }

    const resolvedSources = input.sources.map((source) => ({
      sourceType: source.sourceType,
      sourceId: this.resolveSourceId(source.sourceId),
      sourceTimestamp: this.resolveSourceTimestamp(source.sourceTimestamp ?? now),
      extractedBy: source.extractedBy ?? this.extractedByForActor(actor.actorClass),
      external: source.external ?? false,
    }));
    const seenSourceIds = new Set<string>();
    for (const source of resolvedSources) {
      if (seenSourceIds.has(source.sourceId)) {
        throw new Error('duplicate sourceId for memory source');
      }
      seenSourceIds.add(source.sourceId);
    }

    return resolvedSources;
  }

  private resolveSourceReferences(
    input: MemoryRecordInput,
    sources: PreparedMemorySource[],
    actor: Required<Pick<MemoryActorInput, 'actorClass' | 'context'>> & Pick<MemoryActorInput, 'canonicalUserId'>
  ): ResolvedMemorySource[] {
    const hasCanonicalEventSource = sources.some(
      (source) => source.sourceType === 'raw_event' || source.sourceType === 'chat_message'
    );

    const resolvedSources = sources.map((source): ResolvedMemorySource => {
      if (source.sourceType === 'user_command') {
        if (!source.external) {
          throw new Error('user_command memory source must be explicitly external');
        }
        if (actor.context !== 'admin_cli' || input.sourceContext?.startsWith('admin_cli') !== true) {
          throw new Error('external user_command memory source requires admin_cli context');
        }
        return {
          ...source,
          resolutionState: 'external',
        };
      }

      if (source.external) {
        throw new Error(`internal memory source ${source.sourceType} cannot be marked external`);
      }

      if (source.sourceType === 'raw_event') {
        if (!this.rowExists('raw_events', source.sourceId)) {
          throw new Error('memory source raw_event does not resolve to raw_events.id');
        }
        return {
          ...source,
          resolutionState: 'internal',
          rawEventId: source.sourceId,
        };
      }

      if (source.sourceType === 'chat_message') {
        if (!this.rowExists('chat_messages', source.sourceId)) {
          throw new Error('memory source chat_message does not resolve to chat_messages.id');
        }
        return {
          ...source,
          resolutionState: 'internal',
          chatMessageId: source.sourceId,
        };
      }

      if (source.sourceType === 'tool_output') {
        const toolCall = this.db
          .prepare('SELECT status FROM tool_calls WHERE id = ?')
          .get(source.sourceId) as { status: string } | undefined;
        if (!toolCall || toolCall.status !== 'success') {
          throw new Error('memory source tool_output requires a successful tool_calls.id');
        }
        return {
          ...source,
          resolutionState: 'internal',
          toolCallId: source.sourceId,
        };
      }

      if (!hasCanonicalEventSource) {
        throw new Error('worker_extraction memory source requires a raw_event or chat_message source');
      }

      const job = this.db
        .prepare(
          `SELECT id, payload, result, NULL AS attemptResult
           FROM jobs
           WHERE id = ? AND type = 'extraction' AND status = 'completed'`
        )
        .get(source.sourceId) as WorkerSourceRow | undefined;
      const attempt = this.db
        .prepare(
          `SELECT job_attempts.id,
                  jobs.payload AS payload,
                  jobs.result AS result,
                  job_attempts.result AS attemptResult
           FROM job_attempts
           JOIN jobs ON jobs.id = job_attempts.job_id
           WHERE job_attempts.id = ?
             AND job_attempts.status = 'completed'
             AND jobs.type = 'extraction'
             AND jobs.status = 'completed'`
        )
        .get(source.sourceId) as WorkerSourceRow | undefined;
      if ((job ? 1 : 0) + (attempt ? 1 : 0) !== 1) {
        throw new Error('memory source worker_extraction must resolve to one completed extraction job or attempt');
      }
      const workerSource = job ?? attempt;
      if (!workerSource || !this.workerSourceReferencesCanonicalEvidence(workerSource, sources)) {
        throw new Error('memory source worker_extraction must preserve its raw or chat source reference');
      }
      return {
        ...source,
        resolutionState: 'internal',
        ...(job ? { jobId: job.id } : { jobAttemptId: attempt?.id }),
      };
    });

    this.assertSourceBoundaries(input, resolvedSources);
    return resolvedSources;
  }

  private assertSourceBoundaries(
    input: MemoryRecordInput,
    sources: ResolvedMemorySource[]
  ): void {
    if (input.scope !== 'user' && input.scope !== 'group' && input.scope !== 'conversation') {
      return;
    }

    for (const source of sources) {
      if (source.sourceType === 'user_command' || source.sourceType === 'worker_extraction') {
        continue;
      }

      const evidence = source.sourceType === 'tool_output'
        ? this.readToolBoundaryEvidence(source.sourceId)
        : this.readChatBoundaryEvidence(source.sourceType, source.sourceId);
      if (
        evidence.length === 0
        || !evidence.every((item) => this.isSourceBoundaryCompatible(input, item))
      ) {
        throw new Error(`memory source is incompatible with ${input.scope} memory boundary`);
      }
    }
  }

  private readChatBoundaryEvidence(
    sourceType: 'raw_event' | 'chat_message',
    sourceId: string
  ): MemoryBoundaryEvidence[] {
    const sourcePredicate = sourceType === 'raw_event'
      ? 'raw_events.id = ?'
      : 'chat_messages.id = ?';

    return this.db.prepare(
      `SELECT chat_messages.conversation_id AS conversationId,
              chat_messages.conversation_type AS conversationType,
              chat_messages.group_id AS groupId,
              ${this.senderCanonicalUserIdExpression('chat_messages.sender_id')} AS senderCanonicalUserId,
              NULL AS actorCanonicalUserId,
              NULL AS invocationContext
         FROM chat_messages
         JOIN raw_events ON raw_events.id = chat_messages.raw_event_id
        WHERE ${sourcePredicate}`
    ).all(sourceId) as MemoryBoundaryEvidence[];
  }

  private readToolBoundaryEvidence(sourceId: string): MemoryBoundaryEvidence[] {
    return this.db.prepare(
      `SELECT COALESCE(context_traces.conversation_id, agent_turns.conversation_id,
                       chat_messages.conversation_id) AS conversationId,
              COALESCE(context_traces.conversation_type,
                       chat_messages.conversation_type) AS conversationType,
              COALESCE(context_traces.group_id, chat_messages.group_id) AS groupId,
              ${this.senderCanonicalUserIdExpression('chat_messages.sender_id')} AS senderCanonicalUserId,
              tool_calls.actor_user_id AS actorCanonicalUserId,
              tool_calls.invocation_context AS invocationContext
         FROM tool_calls
         LEFT JOIN agent_turns ON agent_turns.id = tool_calls.turn_id
         LEFT JOIN context_traces
                ON context_traces.id = agent_turns.context_pack_id
               AND context_traces.turn_id = agent_turns.id
         LEFT JOIN raw_events ON raw_events.id = agent_turns.trigger_event_id
         LEFT JOIN chat_messages ON chat_messages.raw_event_id = raw_events.id
        WHERE tool_calls.id = ?
          AND tool_calls.status = 'success'`
    ).all(sourceId) as MemoryBoundaryEvidence[];
  }

  private senderCanonicalUserIdExpression(senderIdColumn: string): string {
    return `(
      SELECT platform_accounts.canonical_user_id
        FROM platform_accounts
       WHERE platform_accounts.platform = 'qq'
         AND platform_accounts.status = 'active'
         AND (
           platform_accounts.platform_account_id = ${senderIdColumn}
           OR (
             substr(${senderIdColumn}, 1, length('qq-')) = 'qq-'
             AND platform_accounts.platform_account_id = substr(${senderIdColumn}, length('qq-') + 1)
           )
         )
       LIMIT 1
    )`;
  }

  private isSourceBoundaryCompatible(
    input: MemoryRecordInput,
    evidence: MemoryBoundaryEvidence
  ): boolean {
    if (input.scope === 'user') {
      if (
        evidence.actorCanonicalUserId
        && evidence.senderCanonicalUserId
        && evidence.actorCanonicalUserId !== evidence.senderCanonicalUserId
      ) {
        return false;
      }

      const sourceUserId = evidence.actorCanonicalUserId ?? evidence.senderCanonicalUserId;
      if (sourceUserId !== input.canonicalUserId) {
        return false;
      }

      const isGroupEvidence = evidence.conversationType === 'group'
        || evidence.invocationContext === 'group_chat';
      if (isGroupEvidence) {
        if (input.visibility === 'owner_admin_only') {
          return true;
        }
        if (input.visibility !== 'same_group_only') {
          return false;
        }
        return (
          (input.groupId !== undefined && evidence.groupId === input.groupId)
          || (
            input.conversationId !== undefined
            && evidence.conversationId === input.conversationId
          )
        );
      }

      if (input.visibility === 'private_only') {
        return evidence.conversationType === 'private'
          || (evidence.conversationType === null && evidence.invocationContext === 'private_chat');
      }

      if (input.visibility === 'same_group_only') {
        return false;
      }

      return true;
    }

    if (input.scope === 'group') {
      return evidence.conversationType === 'group' && evidence.groupId === input.groupId;
    }

    return evidence.conversationId === input.conversationId;
  }

  private rowExists(table: 'raw_events' | 'chat_messages', id: string): boolean {
    return this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  }

  private workerSourceReferencesCanonicalEvidence(
    workerSource: WorkerSourceRow,
    sources: PreparedMemorySource[]
  ): boolean {
    const expectedRawEventIds = new Set(
      sources
        .filter((source) => source.sourceType === 'raw_event')
        .map((source) => source.sourceId)
    );
    const expectedChatMessageIds = new Set(
      sources
        .filter((source) => source.sourceType === 'chat_message')
        .map((source) => source.sourceId)
    );
    const references = {
      rawEventIds: new Set<string>(),
      chatMessageIds: new Set<string>(),
    };

    for (const value of [workerSource.payload, workerSource.result, workerSource.attemptResult]) {
      if (!value) {
        continue;
      }
      try {
        this.collectWorkerSourceReferences(JSON.parse(value) as unknown, references);
      } catch {
        continue;
      }
    }

    return [...references.rawEventIds].some((id) => expectedRawEventIds.has(id))
      || [...references.chatMessageIds].some((id) => expectedChatMessageIds.has(id));
  }

  private collectWorkerSourceReferences(
    value: unknown,
    output: { rawEventIds: Set<string>; chatMessageIds: Set<string> }
  ): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectWorkerSourceReferences(item, output);
      }
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();
      if (normalizedKey === 'raweventid' || normalizedKey === 'sourceraweventid') {
        this.addWorkerSourceReference(output.rawEventIds, nestedValue);
      }
      if (normalizedKey === 'chatmessageid' || normalizedKey === 'sourcechatmessageid') {
        this.addWorkerSourceReference(output.chatMessageIds, nestedValue);
      }
      this.collectWorkerSourceReferences(nestedValue, output);
    }
  }

  private addWorkerSourceReference(target: Set<string>, value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.addWorkerSourceReference(target, item);
      }
      return;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      target.add(value.trim());
    }
  }

  private insertSources(memoryId: string, sources: ResolvedMemorySource[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO memory_sources (
         memory_id, source_type, source_id, source_timestamp, extracted_by,
         resolution_state, raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        source.extractedBy ?? null,
        source.resolutionState,
        source.rawEventId ?? null,
        source.chatMessageId ?? null,
        source.toolCallId ?? null,
        source.jobId ?? null,
        source.jobAttemptId ?? null
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
      .replace(/(?<![A-Za-z0-9])qq-(?:group-)?[1-9][0-9]{4,11}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
      .replace(/(?<![A-Za-z0-9])[1-9][0-9]{4,11}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
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
    if (actorClass === 'tool') {
      return 'tool';
    }
    if (actorClass === 'user' || actorClass === 'trusted_user' || actorClass === 'admin' || actorClass === 'owner') {
      return 'user';
    }
    return 'worker';
  }

  private sourceTimestampToNumber(value: Date | number): number {
    return value instanceof Date ? value.getTime() : value;
  }

  private resolveSourceId(value: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('memory sourceId must be a non-empty string');
    }

    return value;
  }

  private resolveSourceTimestamp(value: Date | number): Date | number {
    const timestamp = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(timestamp)) {
      throw new Error('memory sourceTimestamp must be a finite timestamp');
    }

    return value;
  }

  private resolveExpiresAtTimestamp(value: Date | undefined): number | null {
    if (!value) {
      return null;
    }

    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) {
      throw new Error('memory expiresAt must be a finite timestamp');
    }

    return timestamp;
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

  private assertProposedForDecision(id: string): void {
    const row = this.db.prepare('SELECT state FROM memory_records WHERE id = ?').get(id) as
      | { state: MemoryRecord['state'] }
      | undefined;

    if (!row) {
      return;
    }

    if (row.state !== 'proposed') {
      throw new Error('memory must be proposed before approval or rejection');
    }
  }

  private assertAllowedStateTransition(
    previousState: MemoryRecord['state'],
    nextState: MemoryRecord['state']
  ): void {
    const allowedTransitions: Record<MemoryRecord['state'], ReadonlySet<MemoryRecord['state']>> = {
      proposed: new Set(['active', 'rejected', 'deleted']),
      active: new Set(['disabled', 'deleted', 'superseded']),
      rejected: new Set(['active', 'deleted']),
      disabled: new Set(['active', 'deleted']),
      superseded: new Set(['deleted']),
      deleted: new Set(['active']),
    };

    if (!allowedTransitions[previousState].has(nextState)) {
      throw new Error(`invalid memory state transition from ${previousState} to ${nextState}`);
    }
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
