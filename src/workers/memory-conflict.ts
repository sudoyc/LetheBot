/**
 * Memory conflict worker.
 *
 * Detects active memory records that share the same owner/kind/title but hold
 * different content. The worker only writes redacted audit evidence; it does
 * not automatically supersede, delete, or activate memory.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditRepository } from '../storage/audit-repository.js';

export interface MemoryConflictInput {
  jobId: string;
  sinceMs?: number;
  nowMs?: number;
  limit?: number;
}

export interface MemoryConflictResult {
  auditId: string;
  sinceMs: number;
  untilMs: number;
  conflictCount: number;
  sampledConflictCount: number;
  redacted: true;
  conflicts: Array<{
    memoryIds: [string, string];
    scope: string;
    canonicalUserId?: string;
    groupId?: string;
    conversationId?: string;
    subjectUserId?: string;
    kind: string;
    titleHash: string;
    updatedAt: number;
  }>;
}

interface CountRow {
  count: number;
}

interface ConflictRow {
  left_id: string;
  right_id: string;
  scope: string;
  canonical_user_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
  subject_user_id: string | null;
  kind: string;
  normalized_title: string;
  updated_at: number;
}

const DEFAULT_SAMPLE_LIMIT = 20;
const MAX_SAMPLE_LIMIT = 100;

export class MemoryConflictWorker {
  constructor(
    private readonly db: Database.Database,
    private readonly auditRepository: AuditRepository,
  ) {}

  async detect(input: MemoryConflictInput): Promise<MemoryConflictResult> {
    const untilMs = input.nowMs ?? Date.now();
    const sinceMs = input.sinceMs ?? 0;
    const limit = this.normalizeLimit(input.limit);

    const conflictCount = this.countConflicts(sinceMs, untilMs);
    const conflicts = this.sampleConflicts(sinceMs, untilMs, limit).map((row) => ({
      memoryIds: [row.left_id, row.right_id] as [string, string],
      scope: row.scope,
      canonicalUserId: row.canonical_user_id ?? undefined,
      groupId: row.group_id ?? undefined,
      conversationId: row.conversation_id ?? undefined,
      subjectUserId: row.subject_user_id ?? undefined,
      kind: row.kind,
      titleHash: this.hashTitle(row.normalized_title),
      updatedAt: row.updated_at,
    }));

    const auditId = await this.auditRepository.create({
      timestamp: new Date(untilMs),
      category: 'memory',
      level: 'redacted_full',
      eventType: 'memory.conflict.detected',
      eventId: input.jobId,
      actor: {
        actorClass: 'system_worker',
        context: 'background_worker',
      },
      summary: conflictCount === 0
        ? 'Memory conflict scan: no active conflicts detected'
        : `Memory conflict scan: ${conflictCount} active conflict pair(s) detected`,
      details: {
        sinceMs,
        untilMs,
        conflictCount,
        sampledConflictCount: conflicts.length,
        conflicts,
        redaction: 'memory_ids_and_title_hashes_only',
      },
      redacted: true,
      riskLevel: conflictCount > 0 ? 'medium' : 'low',
    });

    return {
      auditId,
      sinceMs,
      untilMs,
      conflictCount,
      sampledConflictCount: conflicts.length,
      redacted: true,
      conflicts,
    };
  }

  private normalizeLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_SAMPLE_LIMIT;
    }

    return Math.min(MAX_SAMPLE_LIMIT, Math.max(1, Math.floor(value)));
  }

  private countConflicts(sinceMs: number, untilMs: number): number {
    const row = this.db.prepare(this.conflictCountSql()).get(sinceMs, sinceMs, untilMs, untilMs) as CountRow;
    return row.count;
  }

  private sampleConflicts(sinceMs: number, untilMs: number, limit: number): ConflictRow[] {
    return this.db
      .prepare(this.conflictSampleSql())
      .all(sinceMs, sinceMs, untilMs, untilMs, limit) as ConflictRow[];
  }

  private conflictCountSql(): string {
    return `
      SELECT COUNT(*) AS count
      FROM memory_records a
      JOIN memory_records b
        ON a.id < b.id
       AND a.scope = b.scope
       AND COALESCE(a.canonical_user_id, '') = COALESCE(b.canonical_user_id, '')
       AND COALESCE(a.group_id, '') = COALESCE(b.group_id, '')
       AND COALESCE(a.conversation_id, '') = COALESCE(b.conversation_id, '')
       AND COALESCE(a.subject_user_id, '') = COALESCE(b.subject_user_id, '')
       AND a.kind = b.kind
       AND LOWER(TRIM(a.title)) = LOWER(TRIM(b.title))
      WHERE a.state = 'active'
        AND b.state = 'active'
        AND a.sensitivity NOT IN ('secret', 'prohibited')
        AND b.sensitivity NOT IN ('secret', 'prohibited')
        AND a.content <> b.content
        AND (a.updated_at >= ? OR b.updated_at >= ?)
        AND a.updated_at <= ?
        AND b.updated_at <= ?`;
  }

  private conflictSampleSql(): string {
    return `
      SELECT
        a.id AS left_id,
        b.id AS right_id,
        a.scope,
        a.canonical_user_id,
        a.group_id,
        a.conversation_id,
        a.subject_user_id,
        a.kind,
        LOWER(TRIM(a.title)) AS normalized_title,
        MAX(a.updated_at, b.updated_at) AS updated_at
      FROM memory_records a
      JOIN memory_records b
        ON a.id < b.id
       AND a.scope = b.scope
       AND COALESCE(a.canonical_user_id, '') = COALESCE(b.canonical_user_id, '')
       AND COALESCE(a.group_id, '') = COALESCE(b.group_id, '')
       AND COALESCE(a.conversation_id, '') = COALESCE(b.conversation_id, '')
       AND COALESCE(a.subject_user_id, '') = COALESCE(b.subject_user_id, '')
       AND a.kind = b.kind
       AND LOWER(TRIM(a.title)) = LOWER(TRIM(b.title))
      WHERE a.state = 'active'
        AND b.state = 'active'
        AND a.sensitivity NOT IN ('secret', 'prohibited')
        AND b.sensitivity NOT IN ('secret', 'prohibited')
        AND a.content <> b.content
        AND (a.updated_at >= ? OR b.updated_at >= ?)
        AND a.updated_at <= ?
        AND b.updated_at <= ?
      ORDER BY updated_at DESC, a.id ASC, b.id ASC
      LIMIT ?`;
  }

  private hashTitle(normalizedTitle: string): string {
    return createHash('sha256').update(normalizedTitle).digest('hex');
  }
}
