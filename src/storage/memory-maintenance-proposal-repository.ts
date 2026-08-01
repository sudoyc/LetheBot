import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { readMemoryMaintenanceCandidateSnapshot } from '../memory/maintenance-candidate-snapshot.js';
import type {
  MemoryMaintenanceProposal,
  MemoryMaintenanceProposalKind,
  MemoryMaintenanceProposedEffect,
  MemoryMaintenanceReasonCode,
} from '../memory/maintenance-proposal.js';
import type { ActorClass, InvocationContext } from '../types/tool.js';
import type { AuditRepository } from './audit-repository.js';

export type MemoryMaintenanceProposalLifecycleState =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'applied'
  | 'rolled_back';

export type MemoryMaintenanceReviewTransition = 'approve' | 'reject' | 'expire';

export type MemoryMaintenanceProposalExactScope =
  | { kind: 'global' }
  | { kind: 'user'; canonicalUserId: string }
  | { kind: 'group'; groupId: string }
  | {
    kind: 'conversation';
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
  }
  | { kind: 'system' };

export type MemoryMaintenanceProposalAccess =
  | { kind: 'all' }
  | { kind: 'exact_scope'; scope: MemoryMaintenanceProposalExactScope }
  | {
    kind: 'private_user';
    canonicalUserId: string;
    conversationId: string;
  }
  | {
    kind: 'group_user';
    canonicalUserId: string;
    groupId: string;
    conversationId: string;
  }
  | {
    kind: 'exact_group';
    groupId: string;
    conversationId: string;
  };

export interface MemoryMaintenanceProposalRecord {
  proposalId: string;
  kind: MemoryMaintenanceProposalKind;
  effectType: 'resolve_conflict' | 'consolidate' | 'disable';
  lifecycleState: MemoryMaintenanceProposalLifecycleState;
  scope: MemoryMaintenanceScopeSnapshot;
  candidateFingerprint: string;
  confidence: number;
  effectMemoryId: string | null;
  effectMemoryRole: 'retained' | 'disable_target' | null;
  currentRevisionNumber: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  createdAuditId: string;
  candidates: Array<{
    candidateOrdinal: number;
    memoryId: string;
    effectRole: 'conflict_candidate' | 'retained' | 'supersede' | 'disable_target';
    expectedState: 'active';
    recordFingerprint: string;
    sourceCount: number;
    sourceFingerprint: string;
  }>;
  reasonCodes: MemoryMaintenanceReasonCode[];
  revisions: Array<{
    revisionId: string;
    revisionNumber: number;
    transition: 'propose' | MemoryMaintenanceReviewTransition | 'apply' | 'rollback';
    previousState: MemoryMaintenanceProposalLifecycleState | null;
    newState: MemoryMaintenanceProposalLifecycleState;
    actorUserId: string | null;
    actorClass: ActorClass;
    invocationContext: InvocationContext;
    reasonCode: string;
    auditId: string;
    createdAt: number;
  }>;
}

export interface MemoryMaintenanceReviewInput {
  proposalId: string;
  access: MemoryMaintenanceProposalAccess;
  expectedState: Extract<MemoryMaintenanceProposalLifecycleState, 'pending_review' | 'approved'>;
  expectedRevisionNumber: number;
  transition: MemoryMaintenanceReviewTransition;
  actor: {
    canonicalUserId?: string;
    actorClass: Extract<ActorClass, 'owner' | 'admin' | 'trusted_user' | 'user' | 'group_admin'>;
    invocationContext: Extract<InvocationContext, 'private_chat' | 'group_chat' | 'admin_cli'>;
  };
  authorityKind: 'local_admin' | 'bot_owner' | 'user' | 'group_owner' | 'group_admin';
  reasonCode: string;
  nowMs: number;
}

export type MemoryMaintenanceReviewResult =
  | {
    outcome: 'transitioned' | 'unchanged' | 'stale';
    proposal: MemoryMaintenanceProposalRecord;
  }
  | { outcome: 'not_found' };

export interface MemoryMaintenanceApplyInput {
  proposalId: string;
  access: MemoryMaintenanceProposalAccess;
  expectedState: 'approved';
  expectedRevisionNumber: number;
  actor: MemoryMaintenanceReviewInput['actor'];
  authorityKind: MemoryMaintenanceReviewInput['authorityKind'];
  reasonCode: string;
  retainedMemoryId?: string;
  nowMs: number;
}

export type MemoryMaintenanceApplyResult =
  | {
    outcome: 'transitioned' | 'unchanged' | 'stale';
    proposal: MemoryMaintenanceProposalRecord;
  }
  | { outcome: 'not_found' };

export interface MemoryMaintenanceRollbackInput {
  proposalId: string;
  access: MemoryMaintenanceProposalAccess;
  expectedState: 'applied';
  expectedRevisionNumber: number;
  actor: MemoryMaintenanceReviewInput['actor'];
  authorityKind: MemoryMaintenanceReviewInput['authorityKind'];
  reasonCode: string;
  nowMs: number;
}

export type MemoryMaintenanceRollbackResult =
  | {
    outcome: 'transitioned' | 'unchanged' | 'stale';
    proposal: MemoryMaintenanceProposalRecord;
  }
  | { outcome: 'not_found' };

export interface MemoryMaintenanceScopeSnapshot {
  scope: string;
  canonicalUserId: string | null;
  groupId: string | null;
  conversationId: string | null;
  subjectUserId: string | null;
}

export interface MemoryMaintenanceCandidateSnapshot {
  memoryId: string;
  recordFingerprint: string;
  sourceCount: number;
  sourceFingerprint: string;
}

export interface MemoryMaintenanceProposalPersistenceInput {
  proposal: Omit<MemoryMaintenanceProposal, 'proposalAuditId'>;
  scope: MemoryMaintenanceScopeSnapshot;
  candidates: MemoryMaintenanceCandidateSnapshot[];
  nowMs: number;
}

interface ExistingProposalRow {
  created_audit_id: string;
}

interface ExistingAuditRow {
  id: string;
}

interface ProposalReviewRow {
  id: string;
  kind: MemoryMaintenanceProposalKind;
  effect_type: MemoryMaintenanceProposalRecord['effectType'];
  lifecycle_state: MemoryMaintenanceProposalLifecycleState;
  scope: string;
  canonical_user_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
  subject_user_id: string | null;
  candidate_fingerprint: string;
  confidence: number;
  effect_memory_id: string | null;
  effect_memory_role: MemoryMaintenanceProposalRecord['effectMemoryRole'];
  current_revision_number: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  created_audit_id: string;
}

interface ProposalCandidateReviewRow {
  proposal_id: string;
  candidate_ordinal: number;
  memory_id: string;
  effect_role: MemoryMaintenanceProposalRecord['candidates'][number]['effectRole'];
  expected_state: 'active';
  record_fingerprint: string;
  source_count: number;
  source_fingerprint: string;
}

interface ProposalReasonReviewRow {
  proposal_id: string;
  reason_code: MemoryMaintenanceReasonCode;
}

interface ProposalRevisionReviewRow {
  id: string;
  proposal_id: string;
  revision_number: number;
  transition: MemoryMaintenanceProposalRecord['revisions'][number]['transition'];
  previous_state: MemoryMaintenanceProposalLifecycleState | null;
  new_state: MemoryMaintenanceProposalLifecycleState;
  actor_user_id: string | null;
  actor_class: ActorClass;
  invocation_context: InvocationContext;
  reason_code: string;
  audit_id: string;
  created_at: number;
}

interface MaintenanceMemoryRow {
  id: string;
  scope: string;
  canonical_user_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
  subject_user_id: string | null;
  visibility: string;
  sensitivity: string;
  authority: string;
  kind: string;
  title: string;
  content: string;
  state: string;
  confidence: number;
  importance: number;
  source_context: string;
  evaluator_decision_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

interface MemoryApplyEffect {
  memoryId: string;
  nextState: 'active' | 'superseded' | 'disabled';
  changeType: 'update' | 'supersede' | 'disable';
  effectRole: 'retained' | 'superseded' | 'disabled';
}

interface MemoryRevisionEffectEvidence {
  memoryId: string;
  effectRole: 'retained' | 'superseded' | 'disabled' | 'restored';
  memoryRevisionId: string;
  memoryRevisionNewState: string;
}

/**
 * Persists scanner output without granting it memory mutation authority.
 *
 * The proposal ID is derived from the recomputed snapshot before this boundary
 * is entered. Audit details are display evidence; normalized rows below are the
 * only lifecycle state consumed by later governance work.
 */
export class MemoryMaintenanceProposalRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly auditRepository: AuditRepository,
  ) {}

  createOrGet(input: MemoryMaintenanceProposalPersistenceInput): MemoryMaintenanceProposal {
    this.validateInput(input);
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT created_audit_id
           FROM memory_maintenance_proposals
          WHERE id = ? AND kind = ?`,
      ).get(input.proposal.proposalId, input.proposal.kind) as ExistingProposalRow | undefined;
      if (existing) {
        return {
          ...input.proposal,
          proposalAuditId: existing.created_audit_id,
        };
      }

      const auditId = this.findOrCreateProposalAudit(input);
      const effect = this.effectColumns(input.proposal.proposedEffect);
      this.db.prepare(
        `INSERT INTO memory_maintenance_proposals (
           id, kind, effect_type, lifecycle_state,
           scope, canonical_user_id, group_id, conversation_id, subject_user_id,
           candidate_fingerprint, confidence,
           effect_memory_id, effect_memory_role,
           current_revision_number, created_at, updated_at, expires_at,
           created_audit_id
         ) VALUES (?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)`,
      ).run(
        input.proposal.proposalId,
        input.proposal.kind,
        effect.effectType,
        input.scope.scope,
        input.scope.canonicalUserId,
        input.scope.groupId,
        input.scope.conversationId,
        input.scope.subjectUserId,
        input.proposal.candidateFingerprint,
        input.proposal.confidence,
        effect.memoryId,
        effect.memoryRole,
        input.nowMs,
        input.nowMs,
        auditId,
      );

      const candidateById = new Map(input.candidates.map((candidate) => [candidate.memoryId, candidate]));
      const insertCandidate = this.db.prepare(
        `INSERT INTO memory_maintenance_proposal_candidates (
           proposal_id, proposal_kind, candidate_ordinal, memory_id, effect_role,
           expected_state, record_fingerprint, source_count, source_fingerprint
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      );
      input.proposal.candidateMemoryIds.forEach((memoryId, ordinal) => {
        const candidate = candidateById.get(memoryId);
        if (!candidate) {
          throw new Error('memory maintenance proposal candidate snapshot is incomplete');
        }
        insertCandidate.run(
          input.proposal.proposalId,
          input.proposal.kind,
          ordinal,
          memoryId,
          this.candidateRole(input.proposal.proposedEffect, memoryId),
          candidate.recordFingerprint,
          candidate.sourceCount,
          candidate.sourceFingerprint,
        );
      });

      const insertReason = this.db.prepare(
        `INSERT INTO memory_maintenance_proposal_reasons (
           proposal_id, proposal_kind, reason_ordinal, reason_code
         ) VALUES (?, ?, ?, ?)`,
      );
      input.proposal.reasonCodes.forEach((reasonCode, ordinal) => {
        insertReason.run(input.proposal.proposalId, input.proposal.kind, ordinal, reasonCode);
      });

      this.db.prepare(
        `INSERT INTO memory_maintenance_proposal_revisions (
           id, proposal_id, proposal_kind, revision_number, transition,
           previous_state, new_state, actor_user_id, actor_class,
           invocation_context, reason_code, audit_id, created_at
         ) VALUES (?, ?, ?, 1, 'propose', NULL, 'pending_review', NULL,
                   'system_worker', 'background_worker', ?, ?, ?)`,
      ).run(
        `${input.proposal.proposalId}:revision:1`,
        input.proposal.proposalId,
        input.proposal.kind,
        'scan_proposal_created',
        auditId,
        input.nowMs,
      );

      return {
        ...input.proposal,
        proposalAuditId: auditId,
      };
    });

    return transaction.immediate();
  }

  listForReview(input: {
    access: MemoryMaintenanceProposalAccess;
    states?: MemoryMaintenanceProposalLifecycleState[];
    limit?: number;
  }): MemoryMaintenanceProposalRecord[] {
    const access = this.accessPredicate(input.access);
    const states = normalizeReviewStates(input.states);
    const limit = normalizeReviewLimit(input.limit);
    const statePlaceholders = states.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `${this.proposalSelectSql()}
        WHERE p.lifecycle_state IN (${statePlaceholders})
          AND (${access.sql})
        ORDER BY p.created_at ASC, p.id ASC
        LIMIT ?`,
    ).all(...states, ...access.params, limit) as ProposalReviewRow[];
    return this.hydrateProposalRows(rows);
  }

  countForReview(input: {
    access: MemoryMaintenanceProposalAccess;
    states?: MemoryMaintenanceProposalLifecycleState[];
  }): number {
    const access = this.accessPredicate(input.access);
    const states = normalizeReviewStates(input.states);
    const statePlaceholders = states.map(() => '?').join(', ');
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count
         FROM memory_maintenance_proposals p
        WHERE p.lifecycle_state IN (${statePlaceholders})
          AND (${access.sql})`,
    ).get(...states, ...access.params) as { count: number };
    return row.count;
  }

  findForReview(input: {
    proposalId: string;
    access: MemoryMaintenanceProposalAccess;
  }): MemoryMaintenanceProposalRecord | null {
    if (!isValidProposalId(input.proposalId)) {
      return null;
    }
    const access = this.accessPredicate(input.access);
    const row = this.db.prepare(
      `${this.proposalSelectSql()}
        WHERE p.id = ? AND (${access.sql})
        LIMIT 1`,
    ).get(input.proposalId, ...access.params) as ProposalReviewRow | undefined;
    return row ? this.hydrateProposalRows([row])[0] ?? null : null;
  }

  transitionReview(input: MemoryMaintenanceReviewInput): MemoryMaintenanceReviewResult {
    this.validateReviewInput(input);
    const transaction = this.db.transaction((): MemoryMaintenanceReviewResult => {
      const current = this.findForReview({
        proposalId: input.proposalId,
        access: input.access,
      });
      if (!current) {
        return { outcome: 'not_found' };
      }

      const next = reviewTransition(input.transition);
      const nextRevisionNumber = input.expectedRevisionNumber + 1;
      if (
        current.lifecycleState !== input.expectedState
        || current.currentRevisionNumber !== input.expectedRevisionNumber
      ) {
        const exactRetry = current.lifecycleState === next.newState
          && current.currentRevisionNumber === nextRevisionNumber
          && current.revisions.some((revision) => (
            revision.revisionNumber === nextRevisionNumber
            && revision.transition === input.transition
            && revision.previousState === input.expectedState
            && revision.newState === next.newState
            && revision.actorUserId === (input.actor.canonicalUserId ?? null)
            && revision.actorClass === input.actor.actorClass
            && revision.invocationContext === input.actor.invocationContext
            && revision.reasonCode === input.reasonCode
          ));
        return {
          outcome: exactRetry ? 'unchanged' : 'stale',
          proposal: current,
        };
      }

      const transitionAt = Math.max(input.nowMs, current.updatedAt);
      const update = this.db.prepare(
        `UPDATE memory_maintenance_proposals
            SET lifecycle_state = ?,
                current_revision_number = ?,
                updated_at = ?,
                expires_at = CASE WHEN ? = 'expired' THEN ? ELSE expires_at END
          WHERE id = ?
            AND lifecycle_state = ?
            AND current_revision_number = ?`,
      ).run(
        next.newState,
        nextRevisionNumber,
        transitionAt,
        next.newState,
        transitionAt,
        input.proposalId,
        input.expectedState,
        input.expectedRevisionNumber,
      );
      if (update.changes !== 1) {
        throw new Error('memory maintenance proposal review lost current revision authority');
      }

      const auditId = this.auditRepository.createSync({
        timestamp: new Date(transitionAt),
        category: 'memory',
        level: 'redacted_full',
        eventType: `memory.maintenance.${next.auditSuffix}`,
        eventId: input.proposalId,
        actor: {
          ...(input.actor.canonicalUserId
            ? { canonicalUserId: input.actor.canonicalUserId }
            : {}),
          actorClass: input.actor.actorClass,
          context: input.actor.invocationContext,
        },
        summary: `Memory maintenance proposal ${next.auditSuffix}`,
        details: {
          proposalKind: current.kind,
          transition: input.transition,
          previousState: input.expectedState,
          newState: next.newState,
          revisionNumber: nextRevisionNumber,
          reasonCode: input.reasonCode,
          authorityKind: input.authorityKind,
          redaction: 'normalized_lifecycle_metadata_only',
        },
        redacted: true,
        riskLevel: 'medium',
      });
      this.db.prepare(
        `INSERT INTO memory_maintenance_proposal_revisions (
           id, proposal_id, proposal_kind, revision_number, transition,
           previous_state, new_state, actor_user_id, actor_class,
           invocation_context, reason_code, audit_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `${input.proposalId}:revision:${nextRevisionNumber}`,
        input.proposalId,
        current.kind,
        nextRevisionNumber,
        input.transition,
        input.expectedState,
        next.newState,
        input.actor.canonicalUserId ?? null,
        input.actor.actorClass,
        input.actor.invocationContext,
        input.reasonCode,
        auditId,
        transitionAt,
      );

      const updated = this.findForReview({
        proposalId: input.proposalId,
        access: input.access,
      });
      if (!updated) {
        throw new Error('memory maintenance proposal review result is unavailable');
      }
      return { outcome: 'transitioned', proposal: updated };
    });
    return transaction.immediate();
  }

  applyApproved(input: MemoryMaintenanceApplyInput): MemoryMaintenanceApplyResult {
    this.validateApplyInput(input);
    const transaction = this.db.transaction((): MemoryMaintenanceApplyResult => {
      const current = this.findForReview({
        proposalId: input.proposalId,
        access: input.access,
      });
      if (!current) {
        return { outcome: 'not_found' };
      }

      const effects = this.resolveApplyEffects(current, input.retainedMemoryId);
      const nextRevisionNumber = input.expectedRevisionNumber + 1;
      if (
        current.lifecycleState !== input.expectedState
        || current.currentRevisionNumber !== input.expectedRevisionNumber
      ) {
        return {
          outcome: this.isExactApplyRetry(
            current,
            input,
            effects,
            nextRevisionNumber,
          ) ? 'unchanged' : 'stale',
          proposal: current,
        };
      }

      if (!this.candidateSnapshotIsCurrent(current)) {
        return { outcome: 'stale', proposal: current };
      }

      const memoryRows = this.readMaintenanceMemoryRows(
        current.candidates.map((candidate) => candidate.memoryId),
      );
      const transitionAt = Math.max(
        input.nowMs,
        current.updatedAt,
        ...memoryRows.map((row) => row.updated_at),
      );
      const proposalUpdate = this.db.prepare(
        `UPDATE memory_maintenance_proposals
            SET lifecycle_state = 'applied',
                current_revision_number = ?,
                updated_at = ?
          WHERE id = ?
            AND lifecycle_state = 'approved'
            AND current_revision_number = ?`,
      ).run(
        nextRevisionNumber,
        transitionAt,
        input.proposalId,
        input.expectedRevisionNumber,
      );
      if (proposalUpdate.changes !== 1) {
        throw new Error('memory maintenance proposal apply lost current revision authority');
      }

      const memoryRevisionIds = new Map<string, string>();
      for (const effect of effects) {
        const previousRow = memoryRows.find((row) => row.id === effect.memoryId);
        if (!previousRow) {
          throw new Error('memory maintenance apply candidate is unavailable');
        }
        const previousSnapshot = this.memoryRowSnapshot(previousRow);
        const evaluatorDecisionId = `policy:l0:${effect.nextState}:${effect.memoryId}`;
        const memoryUpdate = this.db.prepare(
          `UPDATE memory_records
              SET state = ?, updated_at = ?, evaluator_decision_id = ?
            WHERE id = ? AND state = 'active'`,
        ).run(
          effect.nextState,
          transitionAt,
          evaluatorDecisionId,
          effect.memoryId,
        );
        if (memoryUpdate.changes !== 1) {
          throw new Error('memory maintenance apply lost candidate state authority');
        }

        const updatedRow = this.readMaintenanceMemoryRow(effect.memoryId);
        const memoryRevisionNumber = this.nextMemoryRevisionNumber(effect.memoryId);
        const memoryRevisionId = ulid();
        this.db.prepare(
          `INSERT INTO memory_revisions (
             id, memory_id, revision_number, change_type,
             previous_state, new_state, reason, actor,
             evaluator_decision_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          memoryRevisionId,
          effect.memoryId,
          memoryRevisionNumber,
          effect.changeType,
          JSON.stringify(previousSnapshot),
          JSON.stringify(this.memoryRowSnapshot(updatedRow)),
          `Approved ${current.kind} maintenance application: ${input.reasonCode}`,
          input.actor.canonicalUserId ?? input.actor.actorClass,
          evaluatorDecisionId,
          transitionAt,
        );
        memoryRevisionIds.set(effect.memoryId, memoryRevisionId);

        this.auditRepository.createSync({
          timestamp: new Date(transitionAt),
          category: 'memory',
          level: 'summary',
          eventType: `memory.${effect.changeType}`,
          eventId: effect.memoryId,
          actor: {
            ...(input.actor.canonicalUserId
              ? { canonicalUserId: input.actor.canonicalUserId }
              : {}),
            actorClass: input.actor.actorClass,
            context: input.actor.invocationContext,
          },
          summary: `Memory maintenance ${effect.effectRole} effect applied`,
          details: {
            proposalId: input.proposalId,
            proposalKind: current.kind,
            previousState: previousRow.state,
            newState: effect.nextState,
            revisionNumber: memoryRevisionNumber,
            effectRole: effect.effectRole,
            reasonCode: input.reasonCode,
            authorityKind: input.authorityKind,
            redaction: 'normalized_lifecycle_metadata_only',
          },
          redacted: true,
          riskLevel: 'medium',
          evaluatorDecisionId,
        });
      }

      const proposalAuditId = this.auditRepository.createSync({
        timestamp: new Date(transitionAt),
        category: 'memory',
        level: 'redacted_full',
        eventType: 'memory.maintenance.applied',
        eventId: input.proposalId,
        actor: {
          ...(input.actor.canonicalUserId
            ? { canonicalUserId: input.actor.canonicalUserId }
            : {}),
          actorClass: input.actor.actorClass,
          context: input.actor.invocationContext,
        },
        summary: 'Memory maintenance proposal applied',
        details: {
          proposalKind: current.kind,
          transition: 'apply',
          previousState: 'approved',
          newState: 'applied',
          revisionNumber: nextRevisionNumber,
          reasonCode: input.reasonCode,
          authorityKind: input.authorityKind,
          candidateCount: effects.length,
          retainedMemoryId: effects.find((effect) => effect.effectRole === 'retained')
            ?.memoryId,
          redaction: 'normalized_lifecycle_metadata_only',
        },
        redacted: true,
        riskLevel: 'medium',
      });
      const proposalRevisionId = `${input.proposalId}:revision:${nextRevisionNumber}`;
      this.db.prepare(
        `INSERT INTO memory_maintenance_proposal_revisions (
           id, proposal_id, proposal_kind, revision_number, transition,
           previous_state, new_state, actor_user_id, actor_class,
           invocation_context, reason_code, audit_id, created_at
         ) VALUES (?, ?, ?, ?, 'apply', 'approved', 'applied', ?, ?, ?, ?, ?, ?)`,
      ).run(
        proposalRevisionId,
        input.proposalId,
        current.kind,
        nextRevisionNumber,
        input.actor.canonicalUserId ?? null,
        input.actor.actorClass,
        input.actor.invocationContext,
        input.reasonCode,
        proposalAuditId,
        transitionAt,
      );

      const insertEffect = this.db.prepare(
        `INSERT INTO memory_maintenance_proposal_revision_effects (
           proposal_revision_id, proposal_id, proposal_kind, transition,
           memory_id, effect_role, memory_revision_id
         ) VALUES (?, ?, ?, 'apply', ?, ?, ?)`,
      );
      for (const effect of effects) {
        const memoryRevisionId = memoryRevisionIds.get(effect.memoryId);
        if (!memoryRevisionId) {
          throw new Error('memory maintenance apply revision effect is incomplete');
        }
        insertEffect.run(
          proposalRevisionId,
          input.proposalId,
          current.kind,
          effect.memoryId,
          effect.effectRole,
          memoryRevisionId,
        );
      }

      const updated = this.findForReview({
        proposalId: input.proposalId,
        access: input.access,
      });
      if (!updated) {
        throw new Error('memory maintenance proposal apply result is unavailable');
      }
      return { outcome: 'transitioned', proposal: updated };
    });
    return transaction.immediate();
  }

  rollbackApplied(input: MemoryMaintenanceRollbackInput): MemoryMaintenanceRollbackResult {
    this.validateRollbackInput(input);
    const transaction = this.db.transaction((): MemoryMaintenanceRollbackResult => {
      const current = this.findForReview({
        proposalId: input.proposalId,
        access: input.access,
      });
      if (!current) {
        return { outcome: 'not_found' };
      }

      const nextRevisionNumber = input.expectedRevisionNumber + 1;
      if (
        current.lifecycleState !== input.expectedState
        || current.currentRevisionNumber !== input.expectedRevisionNumber
      ) {
        return {
          outcome: this.isExactRollbackRetry(current, input, nextRevisionNumber)
            ? 'unchanged'
            : 'stale',
          proposal: current,
        };
      }

      const applyEvidence = this.readRevisionEffectEvidence(
        current,
        'apply',
        input.expectedRevisionNumber,
      );
      if (!this.revisionEffectEvidenceIsCurrent(current, applyEvidence, 'apply')) {
        return { outcome: 'stale', proposal: current };
      }

      const memoryRows = this.readMaintenanceMemoryRows(
        current.candidates.map((candidate) => candidate.memoryId),
      );
      const transitionAt = Math.max(
        input.nowMs,
        current.updatedAt,
        ...memoryRows.map((row) => row.updated_at),
      );
      const proposalUpdate = this.db.prepare(
        `UPDATE memory_maintenance_proposals
            SET lifecycle_state = 'rolled_back',
                current_revision_number = ?,
                updated_at = ?
          WHERE id = ?
            AND lifecycle_state = 'applied'
            AND current_revision_number = ?`,
      ).run(
        nextRevisionNumber,
        transitionAt,
        input.proposalId,
        input.expectedRevisionNumber,
      );
      if (proposalUpdate.changes !== 1) {
        throw new Error('memory maintenance proposal rollback lost current revision authority');
      }

      const memoryRevisionIds = new Map<string, string>();
      for (const previousRow of memoryRows) {
        const previousSnapshot = this.memoryRowSnapshot(previousRow);
        const evaluatorDecisionId = `policy:l0:active:${previousRow.id}`;
        const memoryUpdate = this.db.prepare(
          `UPDATE memory_records
              SET state = 'active', updated_at = ?, evaluator_decision_id = ?
            WHERE id = ? AND state = ?`,
        ).run(
          transitionAt,
          evaluatorDecisionId,
          previousRow.id,
          previousRow.state,
        );
        if (memoryUpdate.changes !== 1) {
          throw new Error('memory maintenance rollback lost candidate state authority');
        }

        const updatedRow = this.readMaintenanceMemoryRow(previousRow.id);
        const memoryRevisionNumber = this.nextMemoryRevisionNumber(previousRow.id);
        const memoryRevisionId = ulid();
        this.db.prepare(
          `INSERT INTO memory_revisions (
             id, memory_id, revision_number, change_type,
             previous_state, new_state, reason, actor,
             evaluator_decision_id, created_at
           ) VALUES (?, ?, ?, 'restore', ?, ?, ?, ?, ?, ?)`,
        ).run(
          memoryRevisionId,
          previousRow.id,
          memoryRevisionNumber,
          JSON.stringify(previousSnapshot),
          JSON.stringify(this.memoryRowSnapshot(updatedRow)),
          `Governed ${current.kind} maintenance rollback: ${input.reasonCode}`,
          input.actor.canonicalUserId ?? input.actor.actorClass,
          evaluatorDecisionId,
          transitionAt,
        );
        memoryRevisionIds.set(previousRow.id, memoryRevisionId);

        this.auditRepository.createSync({
          timestamp: new Date(transitionAt),
          category: 'memory',
          level: 'summary',
          eventType: 'memory.restore',
          eventId: previousRow.id,
          actor: {
            ...(input.actor.canonicalUserId
              ? { canonicalUserId: input.actor.canonicalUserId }
              : {}),
            actorClass: input.actor.actorClass,
            context: input.actor.invocationContext,
          },
          summary: 'Memory maintenance effect restored',
          details: {
            proposalId: input.proposalId,
            proposalKind: current.kind,
            previousState: previousRow.state,
            newState: 'active',
            revisionNumber: memoryRevisionNumber,
            effectRole: 'restored',
            reasonCode: input.reasonCode,
            authorityKind: input.authorityKind,
            redaction: 'normalized_lifecycle_metadata_only',
          },
          redacted: true,
          riskLevel: 'medium',
          evaluatorDecisionId,
        });
      }

      const proposalAuditId = this.auditRepository.createSync({
        timestamp: new Date(transitionAt),
        category: 'memory',
        level: 'redacted_full',
        eventType: 'memory.maintenance.rolled_back',
        eventId: input.proposalId,
        actor: {
          ...(input.actor.canonicalUserId
            ? { canonicalUserId: input.actor.canonicalUserId }
            : {}),
          actorClass: input.actor.actorClass,
          context: input.actor.invocationContext,
        },
        summary: 'Memory maintenance proposal rolled back',
        details: {
          proposalKind: current.kind,
          transition: 'rollback',
          previousState: 'applied',
          newState: 'rolled_back',
          revisionNumber: nextRevisionNumber,
          reasonCode: input.reasonCode,
          authorityKind: input.authorityKind,
          candidateCount: memoryRows.length,
          redaction: 'normalized_lifecycle_metadata_only',
        },
        redacted: true,
        riskLevel: 'medium',
      });
      const proposalRevisionId = `${input.proposalId}:revision:${nextRevisionNumber}`;
      this.db.prepare(
        `INSERT INTO memory_maintenance_proposal_revisions (
           id, proposal_id, proposal_kind, revision_number, transition,
           previous_state, new_state, actor_user_id, actor_class,
           invocation_context, reason_code, audit_id, created_at
         ) VALUES (?, ?, ?, ?, 'rollback', 'applied', 'rolled_back', ?, ?, ?, ?, ?, ?)`,
      ).run(
        proposalRevisionId,
        input.proposalId,
        current.kind,
        nextRevisionNumber,
        input.actor.canonicalUserId ?? null,
        input.actor.actorClass,
        input.actor.invocationContext,
        input.reasonCode,
        proposalAuditId,
        transitionAt,
      );

      const insertEffect = this.db.prepare(
        `INSERT INTO memory_maintenance_proposal_revision_effects (
           proposal_revision_id, proposal_id, proposal_kind, transition,
           memory_id, effect_role, memory_revision_id
         ) VALUES (?, ?, ?, 'rollback', ?, 'restored', ?)`,
      );
      for (const memoryRow of memoryRows) {
        const memoryRevisionId = memoryRevisionIds.get(memoryRow.id);
        if (!memoryRevisionId) {
          throw new Error('memory maintenance rollback revision effect is incomplete');
        }
        insertEffect.run(
          proposalRevisionId,
          input.proposalId,
          current.kind,
          memoryRow.id,
          memoryRevisionId,
        );
      }

      const updated = this.findForReview({
        proposalId: input.proposalId,
        access: input.access,
      });
      if (!updated) {
        throw new Error('memory maintenance proposal rollback result is unavailable');
      }
      return { outcome: 'transitioned', proposal: updated };
    });
    return transaction.immediate();
  }

  private proposalSelectSql(): string {
    return `SELECT p.id, p.kind, p.effect_type, p.lifecycle_state,
                   p.scope, p.canonical_user_id, p.group_id,
                   p.conversation_id, p.subject_user_id,
                   p.candidate_fingerprint, p.confidence,
                   p.effect_memory_id, p.effect_memory_role,
                   p.current_revision_number, p.created_at, p.updated_at,
                   p.expires_at, p.created_audit_id
              FROM memory_maintenance_proposals AS p`;
  }

  private hydrateProposalRows(rows: ProposalReviewRow[]): MemoryMaintenanceProposalRecord[] {
    if (rows.length === 0) {
      return [];
    }
    const proposalIds = rows.map((row) => row.id);
    const placeholders = proposalIds.map(() => '?').join(', ');
    const candidates = this.db.prepare(
      `SELECT proposal_id, candidate_ordinal, memory_id, effect_role,
              expected_state, record_fingerprint, source_count,
              source_fingerprint
         FROM memory_maintenance_proposal_candidates
        WHERE proposal_id IN (${placeholders})
        ORDER BY proposal_id, candidate_ordinal`,
    ).all(...proposalIds) as ProposalCandidateReviewRow[];
    const reasons = this.db.prepare(
      `SELECT proposal_id, reason_code
         FROM memory_maintenance_proposal_reasons
        WHERE proposal_id IN (${placeholders})
        ORDER BY proposal_id, reason_ordinal`,
    ).all(...proposalIds) as ProposalReasonReviewRow[];
    const revisions = this.db.prepare(
      `SELECT id, proposal_id, revision_number, transition, previous_state,
              new_state, actor_user_id, actor_class, invocation_context,
              reason_code, audit_id, created_at
         FROM memory_maintenance_proposal_revisions
        WHERE proposal_id IN (${placeholders})
        ORDER BY proposal_id, revision_number`,
    ).all(...proposalIds) as ProposalRevisionReviewRow[];

    return rows.map((row) => ({
      proposalId: row.id,
      kind: row.kind,
      effectType: row.effect_type,
      lifecycleState: row.lifecycle_state,
      scope: {
        scope: row.scope,
        canonicalUserId: row.canonical_user_id,
        groupId: row.group_id,
        conversationId: row.conversation_id,
        subjectUserId: row.subject_user_id,
      },
      candidateFingerprint: row.candidate_fingerprint,
      confidence: row.confidence,
      effectMemoryId: row.effect_memory_id,
      effectMemoryRole: row.effect_memory_role,
      currentRevisionNumber: row.current_revision_number,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      createdAuditId: row.created_audit_id,
      candidates: candidates
        .filter((candidate) => candidate.proposal_id === row.id)
        .map((candidate) => ({
          candidateOrdinal: candidate.candidate_ordinal,
          memoryId: candidate.memory_id,
          effectRole: candidate.effect_role,
          expectedState: candidate.expected_state,
          recordFingerprint: candidate.record_fingerprint,
          sourceCount: candidate.source_count,
          sourceFingerprint: candidate.source_fingerprint,
        })),
      reasonCodes: reasons
        .filter((reason) => reason.proposal_id === row.id)
        .map((reason) => reason.reason_code),
      revisions: revisions
        .filter((revision) => revision.proposal_id === row.id)
        .map((revision) => ({
          revisionId: revision.id,
          revisionNumber: revision.revision_number,
          transition: revision.transition,
          previousState: revision.previous_state,
          newState: revision.new_state,
          actorUserId: revision.actor_user_id,
          actorClass: revision.actor_class,
          invocationContext: revision.invocation_context,
          reasonCode: revision.reason_code,
          auditId: revision.audit_id,
          createdAt: revision.created_at,
        })),
    }));
  }

  private accessPredicate(access: MemoryMaintenanceProposalAccess): {
    sql: string;
    params: unknown[];
  } {
    if (access.kind === 'all') {
      return { sql: '1 = 1', params: [] };
    }
    if (access.kind === 'exact_scope') {
      return this.exactScopePredicate(access.scope);
    }
    const hasCandidates = `EXISTS (
      SELECT 1 FROM memory_maintenance_proposal_candidates AS access_candidate
       WHERE access_candidate.proposal_id = p.id
    )`;
    const privateCandidateBoundary = `NOT EXISTS (
      SELECT 1
        FROM memory_maintenance_proposal_candidates AS access_candidate
        JOIN memory_records AS access_memory
          ON access_memory.id = access_candidate.memory_id
       WHERE access_candidate.proposal_id = p.id
         AND (
           access_memory.sensitivity IN ('secret', 'prohibited')
           OR access_memory.visibility = 'owner_admin_only'
         )
    )`;
    const groupCandidateBoundary = `NOT EXISTS (
      SELECT 1
        FROM memory_maintenance_proposal_candidates AS access_candidate
        JOIN memory_records AS access_memory
          ON access_memory.id = access_candidate.memory_id
       WHERE access_candidate.proposal_id = p.id
         AND (
           access_memory.sensitivity IN ('secret', 'prohibited')
           OR access_memory.visibility IN ('private_only', 'same_user_any_context')
         )
    )`;
    const sameGroupUserBoundary = `NOT EXISTS (
      SELECT 1
        FROM memory_maintenance_proposal_candidates AS access_candidate
        JOIN memory_records AS access_memory
          ON access_memory.id = access_candidate.memory_id
       WHERE access_candidate.proposal_id = p.id
         AND (
           access_memory.sensitivity IN ('secret', 'prohibited')
           OR access_memory.visibility <> 'same_group_only'
         )
    )`;

    switch (access.kind) {
      case 'private_user':
        requireNonEmptyAccessValue(access.canonicalUserId, 'canonical user ID');
        requireNonEmptyAccessValue(access.conversationId, 'conversation ID');
        return {
          sql: `${hasCandidates}
            AND ${privateCandidateBoundary}
            AND (
              (p.scope = 'user' AND p.canonical_user_id = ?)
              OR (p.scope = 'conversation' AND p.conversation_id = ?)
            )`,
          params: [access.canonicalUserId, access.conversationId],
        };
      case 'group_user':
        requireNonEmptyAccessValue(access.canonicalUserId, 'canonical user ID');
        requireExactGroupAccess(access.groupId, access.conversationId);
        return {
          sql: `${hasCandidates}
            AND p.scope = 'user'
            AND p.canonical_user_id = ?
            AND (p.group_id = ? OR p.conversation_id = ?)
            AND ${sameGroupUserBoundary}`,
          params: [access.canonicalUserId, access.groupId, access.conversationId],
        };
      case 'exact_group':
        requireExactGroupAccess(access.groupId, access.conversationId);
        return {
          sql: `${hasCandidates}
            AND (
              (
                p.scope = 'group'
                AND p.group_id = ?
                AND ${groupCandidateBoundary}
              )
              OR (
                p.scope = 'conversation'
                AND p.conversation_id = ?
                AND ${groupCandidateBoundary}
              )
              OR (
                p.scope = 'user'
                AND (p.group_id = ? OR p.conversation_id = ?)
                AND ${sameGroupUserBoundary}
              )
            )`,
          params: [
            access.groupId,
            access.conversationId,
            access.groupId,
            access.conversationId,
          ],
        };
    }
  }

  private exactScopePredicate(scope: MemoryMaintenanceProposalExactScope): {
    sql: string;
    params: unknown[];
  } {
    switch (scope.kind) {
      case 'global':
      case 'system':
        return {
          sql: `p.scope = ?
            AND p.canonical_user_id IS NULL
            AND p.group_id IS NULL
            AND p.conversation_id IS NULL`,
          params: [scope.kind],
        };
      case 'user':
        requireNonEmptyAccessValue(scope.canonicalUserId, 'canonical user ID');
        return {
          sql: `p.scope = 'user' AND p.canonical_user_id = ?`,
          params: [scope.canonicalUserId],
        };
      case 'group':
        requireNonEmptyAccessValue(scope.groupId, 'group ID');
        return {
          sql: `p.scope = 'group' AND p.group_id = ?`,
          params: [scope.groupId],
        };
      case 'conversation':
        requireNonEmptyAccessValue(scope.conversationId, 'conversation ID');
        if (scope.conversationType === 'private') {
          return {
            sql: `p.scope = 'conversation'
              AND p.conversation_id = ?
              AND p.group_id IS NULL`,
            params: [scope.conversationId],
          };
        }
        if (scope.conversationType === 'group') {
          const groupId = scope.groupId;
          if (groupId === undefined) {
            throw new Error('memory maintenance proposal group ID is invalid');
          }
          requireNonEmptyAccessValue(groupId, 'group ID');
          return {
            sql: `p.scope = 'conversation'
              AND p.conversation_id = ?
              AND p.group_id = ?`,
            params: [scope.conversationId, groupId],
          };
        }
        throw new Error('memory maintenance proposal conversation type is invalid');
    }
  }

  private validateReviewInput(input: MemoryMaintenanceReviewInput): void {
    if (!isValidProposalId(input.proposalId)) {
      throw new Error('memory maintenance proposal ID is invalid');
    }
    this.accessPredicate(input.access);
    if (!Number.isSafeInteger(input.expectedRevisionNumber) || input.expectedRevisionNumber < 1) {
      throw new Error('memory maintenance proposal expected revision is invalid');
    }
    if (
      (input.transition === 'approve' || input.transition === 'reject')
      && input.expectedState !== 'pending_review'
    ) {
      throw new Error('memory maintenance review transition does not match expected state');
    }
    if (
      input.transition === 'expire'
      && input.expectedState !== 'pending_review'
      && input.expectedState !== 'approved'
    ) {
      throw new Error('memory maintenance review transition does not match expected state');
    }
    if (!/^[a-z][a-z0-9_:-]{0,127}$/u.test(input.reasonCode)) {
      throw new Error('memory maintenance review reason code is invalid');
    }
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
      throw new Error('memory maintenance review timestamp is invalid');
    }
    if (
      input.actor.canonicalUserId !== undefined
      && (
        input.actor.canonicalUserId.length === 0
        || input.actor.canonicalUserId.trim() !== input.actor.canonicalUserId
      )
    ) {
      throw new Error('memory maintenance review actor is invalid');
    }
  }

  private validateApplyInput(input: MemoryMaintenanceApplyInput): void {
    if (!isValidProposalId(input.proposalId)) {
      throw new Error('memory maintenance proposal ID is invalid');
    }
    this.accessPredicate(input.access);
    if (input.expectedState !== 'approved') {
      throw new Error('memory maintenance apply requires approved expected state');
    }
    if (!Number.isSafeInteger(input.expectedRevisionNumber) || input.expectedRevisionNumber < 1) {
      throw new Error('memory maintenance proposal expected revision is invalid');
    }
    if (!/^[a-z][a-z0-9_:-]{0,127}$/u.test(input.reasonCode)) {
      throw new Error('memory maintenance apply reason code is invalid');
    }
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
      throw new Error('memory maintenance apply timestamp is invalid');
    }
    if (
      input.actor.canonicalUserId !== undefined
      && (
        input.actor.canonicalUserId.length === 0
        || input.actor.canonicalUserId.trim() !== input.actor.canonicalUserId
      )
    ) {
      throw new Error('memory maintenance apply actor is invalid');
    }
    if (
      input.retainedMemoryId !== undefined
      && (
        input.retainedMemoryId.length === 0
        || input.retainedMemoryId.trim() !== input.retainedMemoryId
      )
    ) {
      throw new Error('memory maintenance conflict retained memory is invalid');
    }
  }

  private validateRollbackInput(input: MemoryMaintenanceRollbackInput): void {
    if (!isValidProposalId(input.proposalId)) {
      throw new Error('memory maintenance proposal ID is invalid');
    }
    this.accessPredicate(input.access);
    if (input.expectedState !== 'applied') {
      throw new Error('memory maintenance rollback requires applied expected state');
    }
    if (!Number.isSafeInteger(input.expectedRevisionNumber) || input.expectedRevisionNumber < 1) {
      throw new Error('memory maintenance proposal expected revision is invalid');
    }
    if (!/^[a-z][a-z0-9_:-]{0,127}$/u.test(input.reasonCode)) {
      throw new Error('memory maintenance rollback reason code is invalid');
    }
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
      throw new Error('memory maintenance rollback timestamp is invalid');
    }
    if (
      input.actor.canonicalUserId !== undefined
      && (
        input.actor.canonicalUserId.length === 0
        || input.actor.canonicalUserId.trim() !== input.actor.canonicalUserId
      )
    ) {
      throw new Error('memory maintenance rollback actor is invalid');
    }
  }

  private isExactRollbackRetry(
    proposal: MemoryMaintenanceProposalRecord,
    input: MemoryMaintenanceRollbackInput,
    nextRevisionNumber: number,
  ): boolean {
    if (
      proposal.lifecycleState !== 'rolled_back'
      || proposal.currentRevisionNumber !== nextRevisionNumber
    ) {
      return false;
    }
    const revision = proposal.revisions.find((candidate) => (
      candidate.revisionNumber === nextRevisionNumber
      && candidate.transition === 'rollback'
      && candidate.previousState === 'applied'
      && candidate.newState === 'rolled_back'
      && candidate.actorUserId === (input.actor.canonicalUserId ?? null)
      && candidate.actorClass === input.actor.actorClass
      && candidate.invocationContext === input.actor.invocationContext
      && candidate.reasonCode === input.reasonCode
    ));
    if (!revision) {
      return false;
    }
    return this.revisionEffectEvidenceIsCurrent(
      proposal,
      this.readRevisionEffectEvidence(proposal, 'rollback', nextRevisionNumber),
      'rollback',
    );
  }

  private readRevisionEffectEvidence(
    proposal: MemoryMaintenanceProposalRecord,
    transition: 'apply' | 'rollback',
    proposalRevisionNumber: number,
  ): MemoryRevisionEffectEvidence[] {
    const rows = this.db.prepare(
      `SELECT e.memory_id, e.effect_role, e.memory_revision_id,
              r.new_state AS memory_revision_new_state
         FROM memory_maintenance_proposal_revision_effects AS e
         JOIN memory_maintenance_proposal_revisions AS pr
           ON pr.id = e.proposal_revision_id
          AND pr.proposal_id = e.proposal_id
          AND pr.proposal_kind = e.proposal_kind
          AND pr.transition = e.transition
         JOIN memory_revisions AS r
           ON r.id = e.memory_revision_id
          AND r.memory_id = e.memory_id
        WHERE e.proposal_id = ?
          AND e.proposal_kind = ?
          AND e.transition = ?
          AND pr.revision_number = ?
        ORDER BY e.memory_id`,
    ).all(
      proposal.proposalId,
      proposal.kind,
      transition,
      proposalRevisionNumber,
    ) as Array<{
      memory_id: string;
      effect_role: MemoryRevisionEffectEvidence['effectRole'];
      memory_revision_id: string;
      memory_revision_new_state: string;
    }>;
    return rows.map((row) => ({
      memoryId: row.memory_id,
      effectRole: row.effect_role,
      memoryRevisionId: row.memory_revision_id,
      memoryRevisionNewState: row.memory_revision_new_state,
    }));
  }

  private revisionEffectEvidenceIsCurrent(
    proposal: MemoryMaintenanceProposalRecord,
    evidence: MemoryRevisionEffectEvidence[],
    transition: 'apply' | 'rollback',
  ): boolean {
    const proposalRevision = proposal.revisions.find((revision) => (
      revision.transition === transition
      && (
        transition === 'apply'
          ? revision.newState === 'applied'
          : revision.newState === 'rolled_back'
      )
    ));
    if (
      !proposalRevision
      || evidence.length !== proposal.candidates.length
      || new Set(evidence.map((effect) => effect.memoryId)).size !== evidence.length
      || evidence.some((effect) => (
        !proposal.candidates.some((candidate) => candidate.memoryId === effect.memoryId)
      ))
      || !this.effectRolesMatchProposal(proposal, evidence, transition)
    ) {
      return false;
    }

    try {
      const snapshot = readMemoryMaintenanceCandidateSnapshot(
        this.db,
        proposal.candidates.map((candidate) => candidate.memoryId),
      );
      if (
        snapshot.scope.scope !== proposal.scope.scope
        || snapshot.scope.canonicalUserId !== proposal.scope.canonicalUserId
        || snapshot.scope.groupId !== proposal.scope.groupId
        || snapshot.scope.conversationId !== proposal.scope.conversationId
        || snapshot.scope.subjectUserId !== proposal.scope.subjectUserId
        || snapshot.candidates.length !== proposal.candidates.length
      ) {
        return false;
      }
      const snapshotById = new Map(snapshot.candidates.map((candidate) => [
        candidate.memoryId,
        candidate,
      ]));
      if (proposal.candidates.some((candidate) => {
        const current = snapshotById.get(candidate.memoryId);
        return current?.sourceCount !== candidate.sourceCount
          || current.sourceFingerprint !== candidate.sourceFingerprint;
      })) {
        return false;
      }

      const memoryRows = this.readMaintenanceMemoryRows(
        proposal.candidates.map((candidate) => candidate.memoryId),
      );
      const memoryById = new Map(memoryRows.map((row) => [row.id, row]));
      return evidence.every((effect) => {
        const memoryRow = memoryById.get(effect.memoryId);
        if (
          !memoryRow
          || JSON.stringify(this.memoryRowSnapshot(memoryRow))
            !== effect.memoryRevisionNewState
        ) {
          return false;
        }
        const latest = this.db.prepare(
          `SELECT id FROM memory_revisions
            WHERE memory_id = ?
              AND revision_number = (
                SELECT MAX(revision_number) FROM memory_revisions WHERE memory_id = ?
              )
            ORDER BY id`,
        ).all(effect.memoryId, effect.memoryId) as Array<{ id: string }>;
        return latest.length === 1 && latest[0]?.id === effect.memoryRevisionId;
      });
    } catch {
      return false;
    }
  }

  private effectRolesMatchProposal(
    proposal: MemoryMaintenanceProposalRecord,
    evidence: MemoryRevisionEffectEvidence[],
    transition: 'apply' | 'rollback',
  ): boolean {
    if (transition === 'rollback') {
      return evidence.every((effect) => effect.effectRole === 'restored');
    }
    if (proposal.kind === 'decay') {
      return evidence.length === 1 && evidence[0]?.effectRole === 'disabled';
    }
    return evidence.filter((effect) => effect.effectRole === 'retained').length === 1
      && evidence.filter((effect) => effect.effectRole === 'superseded').length
        === evidence.length - 1;
  }

  private resolveApplyEffects(
    proposal: MemoryMaintenanceProposalRecord,
    retainedMemoryId: string | undefined,
  ): MemoryApplyEffect[] {
    switch (proposal.kind) {
      case 'conflict': {
        if (proposal.effectType !== 'resolve_conflict') {
          throw new Error('memory maintenance conflict effect is invalid');
        }
        if (!retainedMemoryId) {
          throw new Error('memory maintenance conflict application requires one retained candidate');
        }
        if (!proposal.candidates.some((candidate) => candidate.memoryId === retainedMemoryId)) {
          throw new Error('memory maintenance conflict retained memory is not a proposal candidate');
        }
        if (
          proposal.candidates.length < 2
          || proposal.candidates.some((candidate) => candidate.effectRole !== 'conflict_candidate')
        ) {
          throw new Error('memory maintenance conflict candidates are invalid');
        }
        return proposal.candidates.map((candidate) => (
          candidate.memoryId === retainedMemoryId
            ? {
              memoryId: candidate.memoryId,
              nextState: 'active',
              changeType: 'update',
              effectRole: 'retained',
            }
            : {
              memoryId: candidate.memoryId,
              nextState: 'superseded',
              changeType: 'supersede',
              effectRole: 'superseded',
            }
        ));
      }
      case 'consolidation': {
        if (retainedMemoryId !== undefined) {
          throw new Error('memory maintenance retained selection is only valid for conflict');
        }
        const retained = proposal.candidates.filter((candidate) => candidate.effectRole === 'retained');
        const superseded = proposal.candidates.filter((candidate) => candidate.effectRole === 'supersede');
        if (
          proposal.effectType !== 'consolidate'
          || retained.length !== 1
          || superseded.length < 1
          || retained[0]?.memoryId !== proposal.effectMemoryId
          || retained.length + superseded.length !== proposal.candidates.length
        ) {
          throw new Error('memory maintenance consolidation candidates are invalid');
        }
        return proposal.candidates.map((candidate) => (
          candidate.effectRole === 'retained'
            ? {
              memoryId: candidate.memoryId,
              nextState: 'active',
              changeType: 'update',
              effectRole: 'retained',
            }
            : {
              memoryId: candidate.memoryId,
              nextState: 'superseded',
              changeType: 'supersede',
              effectRole: 'superseded',
            }
        ));
      }
      case 'decay': {
        if (retainedMemoryId !== undefined) {
          throw new Error('memory maintenance retained selection is only valid for conflict');
        }
        const target = proposal.candidates[0];
        if (
          proposal.effectType !== 'disable'
          || proposal.candidates.length !== 1
          || target?.effectRole !== 'disable_target'
          || target.memoryId !== proposal.effectMemoryId
        ) {
          throw new Error('memory maintenance decay candidate is invalid');
        }
        return [{
          memoryId: target.memoryId,
          nextState: 'disabled',
          changeType: 'disable',
          effectRole: 'disabled',
        }];
      }
    }
  }

  private candidateSnapshotIsCurrent(proposal: MemoryMaintenanceProposalRecord): boolean {
    try {
      const snapshot = readMemoryMaintenanceCandidateSnapshot(
        this.db,
        proposal.candidates.map((candidate) => candidate.memoryId),
      );
      if (
        snapshot.candidateFingerprint !== proposal.candidateFingerprint
        || snapshot.scope.scope !== proposal.scope.scope
        || snapshot.scope.canonicalUserId !== proposal.scope.canonicalUserId
        || snapshot.scope.groupId !== proposal.scope.groupId
        || snapshot.scope.conversationId !== proposal.scope.conversationId
        || snapshot.scope.subjectUserId !== proposal.scope.subjectUserId
        || snapshot.candidates.length !== proposal.candidates.length
      ) {
        return false;
      }
      const currentById = new Map(snapshot.candidates.map((candidate) => [
        candidate.memoryId,
        candidate,
      ]));
      return proposal.candidates.every((candidate) => {
        const current = currentById.get(candidate.memoryId);
        return candidate.expectedState === 'active'
          && current?.recordFingerprint === candidate.recordFingerprint
          && current.sourceCount === candidate.sourceCount
          && current.sourceFingerprint === candidate.sourceFingerprint;
      });
    } catch {
      return false;
    }
  }

  private isExactApplyRetry(
    proposal: MemoryMaintenanceProposalRecord,
    input: MemoryMaintenanceApplyInput,
    effects: MemoryApplyEffect[],
    nextRevisionNumber: number,
  ): boolean {
    if (
      proposal.lifecycleState !== 'applied'
      || proposal.currentRevisionNumber !== nextRevisionNumber
    ) {
      return false;
    }
    const revision = proposal.revisions.find((candidate) => (
      candidate.revisionNumber === nextRevisionNumber
      && candidate.transition === 'apply'
      && candidate.previousState === 'approved'
      && candidate.newState === 'applied'
      && candidate.actorUserId === (input.actor.canonicalUserId ?? null)
      && candidate.actorClass === input.actor.actorClass
      && candidate.invocationContext === input.actor.invocationContext
      && candidate.reasonCode === input.reasonCode
    ));
    if (!revision) {
      return false;
    }
    const storedEffects = this.db.prepare(
      `SELECT memory_id, effect_role
         FROM memory_maintenance_proposal_revision_effects
        WHERE proposal_revision_id = ?
        ORDER BY memory_id`,
    ).all(revision.revisionId) as Array<{
      memory_id: string;
      effect_role: MemoryApplyEffect['effectRole'];
    }>;
    const expectedEffects = effects
      .map((effect) => ({ memory_id: effect.memoryId, effect_role: effect.effectRole }))
      .sort((left, right) => left.memory_id.localeCompare(right.memory_id));
    return storedEffects.length === expectedEffects.length
      && storedEffects.every((effect, index) => (
        effect.memory_id === expectedEffects[index]?.memory_id
        && effect.effect_role === expectedEffects[index]?.effect_role
      ));
  }

  private readMaintenanceMemoryRows(memoryIds: string[]): MaintenanceMemoryRow[] {
    const placeholders = memoryIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT id, scope, canonical_user_id, group_id, conversation_id,
              subject_user_id, visibility, sensitivity, authority, kind,
              title, content, state, confidence, importance, source_context,
              evaluator_decision_id, created_at, updated_at, expires_at
         FROM memory_records
        WHERE id IN (${placeholders})
        ORDER BY id`,
    ).all(...memoryIds) as MaintenanceMemoryRow[];
    if (rows.length !== memoryIds.length) {
      throw new Error('memory maintenance apply candidate is unavailable');
    }
    return rows;
  }

  private readMaintenanceMemoryRow(memoryId: string): MaintenanceMemoryRow {
    const row = this.readMaintenanceMemoryRows([memoryId])[0];
    if (!row) {
      throw new Error('memory maintenance apply candidate is unavailable');
    }
    return row;
  }

  private memoryRowSnapshot(row: MaintenanceMemoryRow): Record<string, unknown> {
    const sourceRows = this.db.prepare(
      `SELECT source_id FROM memory_sources
        WHERE memory_id = ? ORDER BY source_timestamp ASC, source_id ASC`,
    ).all(row.id) as Array<{ source_id: string }>;
    return {
      id: row.id,
      scope: row.scope,
      ...(row.canonical_user_id ? { canonicalUserId: row.canonical_user_id } : {}),
      ...(row.group_id ? { groupId: row.group_id } : {}),
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.subject_user_id ? { subjectUserId: row.subject_user_id } : {}),
      visibility: row.visibility,
      sensitivity: row.sensitivity,
      authority: row.authority,
      kind: row.kind,
      title: row.title,
      content: row.content,
      state: row.state,
      confidence: row.confidence,
      importance: row.importance,
      sourceContext: row.source_context,
      sourceEventIds: sourceRows.map((source) => source.source_id),
      ...(row.evaluator_decision_id
        ? { evaluatorDecisionId: row.evaluator_decision_id }
        : {}),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}),
    };
  }

  private nextMemoryRevisionNumber(memoryId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
         FROM memory_revisions WHERE memory_id = ?`,
    ).get(memoryId) as { next: number };
    return row.next;
  }

  private validateInput(input: MemoryMaintenanceProposalPersistenceInput): void {
    const candidateIds = input.proposal.candidateMemoryIds;
    const uniqueCandidateIds = new Set(candidateIds);
    if (candidateIds.length === 0 || uniqueCandidateIds.size !== candidateIds.length) {
      throw new Error('memory maintenance proposal candidates must be unique');
    }
    if (
      input.candidates.length !== candidateIds.length
      || new Set(input.candidates.map((candidate) => candidate.memoryId)).size
        !== input.candidates.length
      || input.candidates.some((candidate) => !uniqueCandidateIds.has(candidate.memoryId))
    ) {
      throw new Error('memory maintenance proposal candidate snapshot is incomplete');
    }

    switch (input.proposal.proposedEffect.type) {
      case 'resolve_conflict':
        if (!sameIdSet(input.proposal.proposedEffect.candidateMemoryIds, candidateIds)) {
          throw new Error('memory maintenance conflict effect does not match candidates');
        }
        break;
      case 'consolidate': {
        const retainedMemoryId = input.proposal.proposedEffect.retainedMemoryId;
        if (
          !uniqueCandidateIds.has(retainedMemoryId)
          || !sameIdSet(
            input.proposal.proposedEffect.supersedeMemoryIds,
            candidateIds.filter((id) => id !== retainedMemoryId),
          )
        ) {
          throw new Error('memory maintenance consolidation effect does not match candidates');
        }
        break;
      }
      case 'disable':
        if (candidateIds.length !== 1 || candidateIds[0] !== input.proposal.proposedEffect.memoryId) {
          throw new Error('memory maintenance decay effect does not match candidates');
        }
        break;
    }
  }

  private findOrCreateProposalAudit(input: MemoryMaintenanceProposalPersistenceInput): string {
    const existing = this.db.prepare(
      `SELECT id
         FROM audit_log
        WHERE event_type = 'memory.maintenance.proposed'
          AND event_id = ?
        ORDER BY timestamp ASC, id ASC
        LIMIT 1`,
    ).get(input.proposal.proposalId) as ExistingAuditRow | undefined;
    if (existing) {
      return existing.id;
    }

    return this.auditRepository.createSync({
      timestamp: new Date(input.nowMs),
      category: 'memory',
      level: 'redacted_full',
      eventType: 'memory.maintenance.proposed',
      eventId: input.proposal.proposalId,
      actor: {
        actorClass: 'system_worker',
        context: 'background_worker',
      },
      summary: `Memory ${input.proposal.kind} maintenance proposal created for review`,
      details: {
        ...input.proposal,
        redaction: 'memory_ids_counts_effects_and_fingerprints_only',
      },
      redacted: true,
      riskLevel: 'medium',
    });
  }

  private effectColumns(effect: MemoryMaintenanceProposedEffect): {
    effectType: string;
    memoryId: string | null;
    memoryRole: string | null;
  } {
    switch (effect.type) {
      case 'resolve_conflict':
        return {
          effectType: 'resolve_conflict',
          memoryId: null,
          memoryRole: null,
        };
      case 'consolidate':
        return {
          effectType: 'consolidate',
          memoryId: effect.retainedMemoryId,
          memoryRole: 'retained',
        };
      case 'disable':
        return {
          effectType: 'disable',
          memoryId: effect.memoryId,
          memoryRole: 'disable_target',
        };
    }
  }

  private candidateRole(
    effect: MemoryMaintenanceProposedEffect,
    memoryId: string,
  ): string {
    switch (effect.type) {
      case 'resolve_conflict':
        return 'conflict_candidate';
      case 'consolidate':
        return memoryId === effect.retainedMemoryId ? 'retained' : 'supersede';
      case 'disable':
        return 'disable_target';
    }
  }
}

function sameIdSet(left: string[], right: string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((id) => right.includes(id));
}

function reviewTransition(transition: MemoryMaintenanceReviewTransition): {
  newState: Extract<MemoryMaintenanceProposalLifecycleState, 'approved' | 'rejected' | 'expired'>;
  auditSuffix: 'approved' | 'rejected' | 'expired';
} {
  switch (transition) {
    case 'approve':
      return { newState: 'approved', auditSuffix: 'approved' };
    case 'reject':
      return { newState: 'rejected', auditSuffix: 'rejected' };
    case 'expire':
      return { newState: 'expired', auditSuffix: 'expired' };
  }
}

function isProposalLifecycleState(value: string): value is MemoryMaintenanceProposalLifecycleState {
  return [
    'pending_review',
    'approved',
    'rejected',
    'expired',
    'applied',
    'rolled_back',
  ].includes(value);
}

function normalizeReviewLimit(value: number | undefined): number {
  if (value === undefined) {
    return 50;
  }
  if (!Number.isFinite(value)) {
    throw new Error('memory maintenance proposal review limit is invalid');
  }
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function normalizeReviewStates(
  value: MemoryMaintenanceProposalLifecycleState[] | undefined,
): MemoryMaintenanceProposalLifecycleState[] {
  const states = value ?? ['pending_review'];
  if (
    states.length === 0
    || new Set(states).size !== states.length
    || states.some((state) => !isProposalLifecycleState(state))
  ) {
    throw new Error('memory maintenance proposal states are invalid');
  }
  return states;
}

function isValidProposalId(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && value.trim() === value;
}

function requireNonEmptyAccessValue(value: string, label: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`memory maintenance proposal ${label} is invalid`);
  }
}

function requireExactGroupAccess(groupId: string, conversationId: string): void {
  if (!/^qq-group-[1-9][0-9]{4,11}$/u.test(groupId) || conversationId !== groupId) {
    throw new Error('memory maintenance proposal group scope is invalid');
  }
}
