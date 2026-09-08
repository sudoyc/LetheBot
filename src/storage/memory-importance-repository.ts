import type Database from 'better-sqlite3';
import { readMemoryImportanceEvidence, type MemoryImportanceEvidence, type MemoryImportanceSummary } from '../memory/importance.js';

export class MemoryImportanceRepository {
  constructor(private readonly db: Database.Database) {}

  save(proposalId: string, evidence: MemoryImportanceEvidence, nowMs: number, jobAttemptId?: string): void {
    const current = readMemoryImportanceEvidence(this.db, evidence.memoryId, evidence, nowMs);
    if (!current || JSON.stringify(current) !== JSON.stringify(evidence)) throw new Error('Importance evidence is stale');
    this.db.prepare(`INSERT INTO memory_importance_scores
      (proposal_id, memory_id, memory_revision_id, scorer_version, window_start_at, window_end_at,
        window_end_order, observation_count, distinct_day_count, span_days, previous_importance,
        proposed_importance, evidence_fingerprint, job_attempt_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(proposalId, evidence.memoryId, evidence.memoryRevisionId, evidence.scorerVersion,
        evidence.windowStartAt, evidence.windowEndAt, evidence.windowEndOrder, evidence.observationCount,
        evidence.distinctDayCount, evidence.spanDays, evidence.previousImportance, evidence.proposedImportance,
        evidence.evidenceFingerprint, jobAttemptId ?? null);
    const insert = this.db.prepare(`INSERT INTO memory_importance_sources
      (proposal_id, source_ordinal, source_raw_event_id, source_chat_message_id, raw_event_id, chat_message_id,
        source_fingerprint, source_timestamp, ingress_at, evidence_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    evidence.sources.forEach((source, ordinal) => insert.run(proposalId, ordinal, source.rawEventId,
      source.chatMessageId, source.rawEventId, source.chatMessageId, source.fingerprint,
      source.timestamp, source.ingressAt, source.evidenceRole));
  }

  summary(proposalId: string): MemoryImportanceSummary | null {
    return this.db.prepare(`SELECT scorer_version AS scorerVersion, window_start_at AS windowStartAt,
      window_end_at AS windowEndAt, window_end_order AS windowEndOrder, observation_count AS observationCount,
      distinct_day_count AS distinctDayCount, span_days AS spanDays, previous_importance AS previousImportance,
      proposed_importance AS proposedImportance, evidence_fingerprint AS evidenceFingerprint,
      (SELECT COUNT(*) FROM memory_importance_sources WHERE proposal_id = score.proposal_id) AS sourceCount
      FROM memory_importance_scores score WHERE proposal_id = ?`).get(proposalId) as MemoryImportanceSummary | undefined ?? null;
  }

  isCurrent(proposalId: string, nowMs: number): boolean {
    const summary = this.summary(proposalId);
    const target = this.db.prepare(`SELECT score.memory_id, score.memory_revision_id, proposal.confidence, proposal.expires_at
      FROM memory_importance_scores score JOIN memory_maintenance_proposals proposal ON proposal.id = score.proposal_id
      WHERE score.proposal_id = ?`).get(proposalId) as {
        memory_id: string; memory_revision_id: string; confidence: number; expires_at: number;
      } | undefined;
    if (!summary || !target) return false;
    const evidence = readMemoryImportanceEvidence(this.db, target.memory_id, summary, nowMs);
    if (!evidence || evidence.evidenceFingerprint !== summary.evidenceFingerprint
      || evidence.memoryRevisionId !== target.memory_revision_id || evidence.confidence !== target.confidence
      || evidence.expiresAt !== target.expires_at) return false;
    const sources = this.db.prepare(`SELECT source_raw_event_id, source_chat_message_id,
      raw_event_id, chat_message_id, source_fingerprint, source_timestamp, ingress_at, evidence_role
      FROM memory_importance_sources WHERE proposal_id = ? ORDER BY source_ordinal`).all(proposalId);
    return JSON.stringify(sources) === JSON.stringify(evidence.sources.map((source) => ({
      source_raw_event_id: source.rawEventId, source_chat_message_id: source.chatMessageId,
      raw_event_id: source.rawEventId, chat_message_id: source.chatMessageId, source_fingerprint: source.fingerprint,
      source_timestamp: source.timestamp, ingress_at: source.ingressAt, evidence_role: source.evidenceRole,
    }))) && summary.scorerVersion === evidence.scorerVersion && summary.windowStartAt === evidence.windowStartAt
      && summary.observationCount === evidence.observationCount && summary.distinctDayCount === evidence.distinctDayCount
      && summary.spanDays === evidence.spanDays && summary.previousImportance === evidence.previousImportance
      && summary.proposedImportance === evidence.proposedImportance && summary.sourceCount === evidence.sources.length;
  }
}
