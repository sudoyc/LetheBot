/**
 * Memory consolidation worker.
 *
 * Detects duplicate active memory groups that are safe candidates for future
 * governed consolidation. This handler writes redacted audit evidence only; it
 * does not supersede, merge, delete, or otherwise mutate memory records.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditRepository } from '../storage/audit-repository.js';

export interface MemoryConsolidationInput {
  jobId: string;
  nowMs?: number;
  minGroupSize?: number;
  limit?: number;
  scope?: string;
  canonicalUserId?: string;
  groupId?: string;
  conversationId?: string;
}

export interface MemoryConsolidationResult {
  auditId: string;
  untilMs: number;
  groupCount: number;
  sampledGroupCount: number;
  redacted: true;
  minGroupSize: number;
  filters: {
    scope?: string;
    canonicalUserId?: string;
    groupId?: string;
    conversationId?: string;
  };
  groups: Array<{
    memoryIds: string[];
    scope: string;
    canonicalUserId?: string;
    groupId?: string;
    conversationId?: string;
    subjectUserId?: string;
    kind: string;
    titleHash: string;
    contentHash: string;
    groupSize: number;
    updatedAt: number;
  }>;
}

interface CountRow {
  count: number;
}

interface ConsolidationGroupRow {
  memory_ids: string;
  scope: string;
  canonical_user_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
  subject_user_id: string | null;
  kind: string;
  normalized_title: string;
  content: string;
  group_size: number;
  updated_at: number;
}

interface ConsolidationQuery {
  whereSql: string;
  params: unknown[];
  minGroupSize: number;
}

const DEFAULT_MIN_GROUP_SIZE = 2;
const DEFAULT_SAMPLE_LIMIT = 20;
const MAX_SAMPLE_LIMIT = 100;

export class MemoryConsolidationWorker {
  constructor(
    private readonly db: Database.Database,
    private readonly auditRepository: AuditRepository,
  ) {}

  async scan(input: MemoryConsolidationInput): Promise<MemoryConsolidationResult> {
    const untilMs = input.nowMs ?? Date.now();
    const minGroupSize = this.normalizeMinGroupSize(input.minGroupSize);
    const limit = this.normalizeLimit(input.limit);
    const filters = this.filtersFromInput(input);
    const query = this.buildQuery({ ...filters, minGroupSize });

    const groupCount = this.countGroups(query);
    const groups = this.sampleGroups(query, limit).map((row) => ({
      memoryIds: row.memory_ids.split(',').filter((id) => id.length > 0),
      scope: row.scope,
      canonicalUserId: row.canonical_user_id ?? undefined,
      groupId: row.group_id ?? undefined,
      conversationId: row.conversation_id ?? undefined,
      subjectUserId: row.subject_user_id ?? undefined,
      kind: row.kind,
      titleHash: this.hash(row.normalized_title),
      contentHash: this.hash(row.content),
      groupSize: row.group_size,
      updatedAt: row.updated_at,
    }));

    const auditId = await this.auditRepository.create({
      timestamp: new Date(untilMs),
      category: 'memory',
      level: 'redacted_full',
      eventType: 'memory.consolidation.candidates_detected',
      eventId: input.jobId,
      actor: {
        actorClass: 'system_worker',
        context: 'background_worker',
      },
      summary: groupCount === 0
        ? 'Memory consolidation scan: no duplicate active groups detected'
        : `Memory consolidation scan: ${groupCount} duplicate active group(s) need review`,
      details: {
        untilMs,
        minGroupSize,
        filters,
        groupCount,
        sampledGroupCount: groups.length,
        groups,
        redaction: 'memory_ids_title_hashes_content_hashes_and_counts_only',
      },
      redacted: true,
      riskLevel: groupCount > 0 ? 'medium' : 'low',
    });

    return {
      auditId,
      untilMs,
      groupCount,
      sampledGroupCount: groups.length,
      redacted: true,
      minGroupSize,
      filters,
      groups,
    };
  }

  private normalizeMinGroupSize(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_MIN_GROUP_SIZE;
    }

    return Math.max(2, Math.floor(value));
  }

  private normalizeLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_SAMPLE_LIMIT;
    }

    return Math.min(MAX_SAMPLE_LIMIT, Math.max(1, Math.floor(value)));
  }

  private filtersFromInput(input: MemoryConsolidationInput): MemoryConsolidationResult['filters'] {
    return {
      scope: this.nonEmptyString(input.scope),
      canonicalUserId: this.nonEmptyString(input.canonicalUserId),
      groupId: this.nonEmptyString(input.groupId),
      conversationId: this.nonEmptyString(input.conversationId),
    };
  }

  private nonEmptyString(value: string | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private buildQuery(input: {
    minGroupSize: number;
    scope?: string;
    canonicalUserId?: string;
    groupId?: string;
    conversationId?: string;
  }): ConsolidationQuery {
    const clauses = [
      "state = 'active'",
      "sensitivity NOT IN ('secret', 'prohibited')",
    ];
    const params: unknown[] = [];

    if (input.scope) {
      clauses.push('scope = ?');
      params.push(input.scope);
    }

    if (input.canonicalUserId) {
      clauses.push('canonical_user_id = ?');
      params.push(input.canonicalUserId);
    }

    if (input.groupId) {
      clauses.push('group_id = ?');
      params.push(input.groupId);
    }

    if (input.conversationId) {
      clauses.push('conversation_id = ?');
      params.push(input.conversationId);
    }

    return {
      whereSql: clauses.join(' AND '),
      params,
      minGroupSize: input.minGroupSize,
    };
  }

  private countGroups(query: ConsolidationQuery): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM (${this.groupSelectSql(query, false)}) AS duplicate_groups`,
      )
      .get(...query.params, query.minGroupSize) as CountRow;

    return row.count;
  }

  private sampleGroups(query: ConsolidationQuery, limit: number): ConsolidationGroupRow[] {
    return this.db
      .prepare(
        `${this.groupSelectSql(query, true)}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...query.params, query.minGroupSize, limit) as ConsolidationGroupRow[];
  }

  private groupSelectSql(_query: ConsolidationQuery, includeRows: boolean): string {
    const selectFields = includeRows
      ? `GROUP_CONCAT(id) AS memory_ids,
         scope,
         canonical_user_id,
         group_id,
         conversation_id,
         subject_user_id,
         kind,
         LOWER(TRIM(title)) AS normalized_title,
         content,
         COUNT(*) AS group_size,
         MAX(updated_at) AS updated_at`
      : '1';

    return `
      SELECT ${selectFields}
      FROM memory_records
      WHERE ${_query.whereSql}
      GROUP BY
        scope,
        COALESCE(canonical_user_id, ''),
        COALESCE(group_id, ''),
        COALESCE(conversation_id, ''),
        COALESCE(subject_user_id, ''),
        kind,
        LOWER(TRIM(title)),
        content
      HAVING COUNT(*) >= ?`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
