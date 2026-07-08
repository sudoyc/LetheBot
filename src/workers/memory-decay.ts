/**
 * Memory decay worker.
 *
 * Finds stale and low-confidence/low-importance active memories that should be
 * reviewed. This handler is intentionally non-destructive: it writes redacted
 * audit evidence only and never changes memory state, confidence, importance,
 * or revisions.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditRepository } from '../storage/audit-repository.js';

export interface MemoryDecayInput {
  jobId: string;
  nowMs?: number;
  staleBeforeMs?: number;
  maxConfidence?: number;
  maxImportance?: number;
  limit?: number;
  scope?: string;
  canonicalUserId?: string;
  groupId?: string;
  conversationId?: string;
}

export interface MemoryDecayResult {
  auditId: string;
  untilMs: number;
  staleBeforeMs: number;
  candidateCount: number;
  sampledCandidateCount: number;
  redacted: true;
  thresholds: {
    maxConfidence: number;
    maxImportance: number;
  };
  filters: {
    scope?: string;
    canonicalUserId?: string;
    groupId?: string;
    conversationId?: string;
  };
  candidates: Array<{
    memoryId: string;
    scope: string;
    canonicalUserId?: string;
    groupId?: string;
    conversationId?: string;
    subjectUserId?: string;
    kind: string;
    titleHash: string;
    confidence: number;
    importance: number;
    updatedAt: number;
    reasons: Array<'stale' | 'low_confidence' | 'low_importance'>;
  }>;
}

interface CountRow {
  count: number;
}

interface DecayCandidateRow {
  id: string;
  scope: string;
  canonical_user_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
  subject_user_id: string | null;
  kind: string;
  normalized_title: string;
  confidence: number;
  importance: number;
  updated_at: number;
}

interface DecayQuery {
  whereSql: string;
  params: unknown[];
}

const DEFAULT_DECAY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CONFIDENCE = 0.5;
const DEFAULT_MAX_IMPORTANCE = 0.3;
const DEFAULT_SAMPLE_LIMIT = 20;
const MAX_SAMPLE_LIMIT = 100;

export class MemoryDecayWorker {
  constructor(
    private readonly db: Database.Database,
    private readonly auditRepository: AuditRepository,
  ) {}

  async scan(input: MemoryDecayInput): Promise<MemoryDecayResult> {
    const untilMs = input.nowMs ?? Date.now();
    const staleBeforeMs = input.staleBeforeMs ?? untilMs - DEFAULT_DECAY_WINDOW_MS;
    const maxConfidence = this.normalizeUnitInterval(input.maxConfidence, DEFAULT_MAX_CONFIDENCE);
    const maxImportance = this.normalizeUnitInterval(input.maxImportance, DEFAULT_MAX_IMPORTANCE);
    const limit = this.normalizeLimit(input.limit);
    const filters = this.filtersFromInput(input);
    const query = this.buildQuery({
      ...filters,
      staleBeforeMs,
      maxConfidence,
      maxImportance,
    });

    const candidateCount = this.countCandidates(query);
    const candidates = this.sampleCandidates(query, limit).map((row) => ({
      memoryId: row.id,
      scope: row.scope,
      canonicalUserId: row.canonical_user_id ?? undefined,
      groupId: row.group_id ?? undefined,
      conversationId: row.conversation_id ?? undefined,
      subjectUserId: row.subject_user_id ?? undefined,
      kind: row.kind,
      titleHash: this.hashTitle(row.normalized_title),
      confidence: row.confidence,
      importance: row.importance,
      updatedAt: row.updated_at,
      reasons: this.reasonsFor(row, staleBeforeMs, maxConfidence, maxImportance),
    }));

    const auditId = await this.auditRepository.create({
      timestamp: new Date(untilMs),
      category: 'memory',
      level: 'redacted_full',
      eventType: 'memory.decay.candidates_detected',
      eventId: input.jobId,
      actor: {
        actorClass: 'system_worker',
        context: 'background_worker',
      },
      summary: candidateCount === 0
        ? 'Memory decay scan: no stale low-confidence candidates detected'
        : `Memory decay scan: ${candidateCount} candidate memory record(s) need review`,
      details: {
        untilMs,
        staleBeforeMs,
        thresholds: {
          maxConfidence,
          maxImportance,
        },
        filters,
        candidateCount,
        sampledCandidateCount: candidates.length,
        candidates,
        redaction: 'memory_ids_title_hashes_scores_and_reasons_only',
      },
      redacted: true,
      riskLevel: candidateCount > 0 ? 'medium' : 'low',
    });

    return {
      auditId,
      untilMs,
      staleBeforeMs,
      candidateCount,
      sampledCandidateCount: candidates.length,
      redacted: true,
      thresholds: {
        maxConfidence,
        maxImportance,
      },
      filters,
      candidates,
    };
  }

  private normalizeUnitInterval(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }

    return Math.min(1, Math.max(0, value));
  }

  private normalizeLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_SAMPLE_LIMIT;
    }

    return Math.min(MAX_SAMPLE_LIMIT, Math.max(1, Math.floor(value)));
  }

  private filtersFromInput(input: MemoryDecayInput): MemoryDecayResult['filters'] {
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
    staleBeforeMs: number;
    maxConfidence: number;
    maxImportance: number;
    scope?: string;
    canonicalUserId?: string;
    groupId?: string;
    conversationId?: string;
  }): DecayQuery {
    const clauses = [
      "state = 'active'",
      "sensitivity NOT IN ('secret', 'prohibited')",
      'updated_at <= ?',
      '(confidence <= ? OR importance <= ?)',
    ];
    const params: unknown[] = [
      input.staleBeforeMs,
      input.maxConfidence,
      input.maxImportance,
    ];

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
    };
  }

  private countCandidates(query: DecayQuery): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM memory_records WHERE ${query.whereSql}`)
      .get(...query.params) as CountRow;

    return row.count;
  }

  private sampleCandidates(query: DecayQuery, limit: number): DecayCandidateRow[] {
    return this.db
      .prepare(
        `SELECT
           id,
           scope,
           canonical_user_id,
           group_id,
           conversation_id,
           subject_user_id,
           kind,
           LOWER(TRIM(title)) AS normalized_title,
           confidence,
           importance,
           updated_at
         FROM memory_records
         WHERE ${query.whereSql}
         ORDER BY updated_at ASC, importance ASC, confidence ASC, id ASC
         LIMIT ?`,
      )
      .all(...query.params, limit) as DecayCandidateRow[];
  }

  private reasonsFor(
    row: DecayCandidateRow,
    staleBeforeMs: number,
    maxConfidence: number,
    maxImportance: number,
  ): Array<'stale' | 'low_confidence' | 'low_importance'> {
    const reasons: Array<'stale' | 'low_confidence' | 'low_importance'> = [];

    if (row.updated_at <= staleBeforeMs) {
      reasons.push('stale');
    }

    if (row.confidence <= maxConfidence) {
      reasons.push('low_confidence');
    }

    if (row.importance <= maxImportance) {
      reasons.push('low_importance');
    }

    return reasons;
  }

  private hashTitle(normalizedTitle: string): string {
    return createHash('sha256').update(normalizedTitle).digest('hex');
  }
}
