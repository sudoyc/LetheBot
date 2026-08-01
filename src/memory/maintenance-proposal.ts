import type Database from 'better-sqlite3';
import type { AuditRepository } from '../storage/audit-repository.js';
import { MemoryMaintenanceProposalRepository } from '../storage/memory-maintenance-proposal-repository.js';
import {
  hashMemoryMaintenanceValue,
  readMemoryMaintenanceCandidateSnapshot,
} from './maintenance-candidate-snapshot.js';

export type MemoryMaintenanceProposalKind = 'conflict' | 'consolidation' | 'decay';

export type MemoryMaintenanceReasonCode =
  | 'same_boundary_title_different_content'
  | 'same_boundary_title_and_content'
  | 'stale'
  | 'low_confidence'
  | 'low_importance';

export type MemoryMaintenanceProposedEffect =
  | {
    type: 'resolve_conflict';
    candidateMemoryIds: string[];
  }
  | {
    type: 'consolidate';
    retainedMemoryId: string;
    supersedeMemoryIds: string[];
  }
  | {
    type: 'disable';
    memoryId: string;
  };

export interface MemoryMaintenanceProposal {
  proposalId: string;
  proposalAuditId: string;
  kind: MemoryMaintenanceProposalKind;
  candidateMemoryIds: string[];
  sourceSet: Array<{
    memoryId: string;
    sourceCount: number;
    sourceFingerprint: string;
  }>;
  reasonCodes: MemoryMaintenanceReasonCode[];
  confidence: number;
  proposedEffect: MemoryMaintenanceProposedEffect;
  candidateFingerprint: string;
}

export async function createMemoryMaintenanceProposal(
  db: Database.Database,
  auditRepository: AuditRepository,
  input: {
    kind: MemoryMaintenanceProposalKind;
    candidateMemoryIds: string[];
    reasonCodes: MemoryMaintenanceReasonCode[];
    proposedEffect: MemoryMaintenanceProposedEffect;
    nowMs: number;
  },
): Promise<MemoryMaintenanceProposal> {
  const snapshot = readMemoryMaintenanceCandidateSnapshot(db, input.candidateMemoryIds);
  const candidateMemoryIds = snapshot.candidateMemoryIds;
  const candidateFingerprint = snapshot.candidateFingerprint;
  const reasonCodes = [...new Set(input.reasonCodes)] as MemoryMaintenanceReasonCode[];
  const proposalDigest = hashMemoryMaintenanceValue({
    kind: input.kind,
    candidateFingerprint,
    reasonCodes,
    proposedEffect: input.proposedEffect,
  });
  const proposalId = `memory-maintenance-${input.kind}-v1-${proposalDigest}`;
  const proposal = {
    proposalId,
    kind: input.kind,
    candidateMemoryIds,
    sourceSet: snapshot.sourceSet,
    reasonCodes,
    confidence: snapshot.confidence,
    proposedEffect: input.proposedEffect,
    candidateFingerprint,
  };
  return new MemoryMaintenanceProposalRepository(db, auditRepository).createOrGet({
    proposal,
    scope: snapshot.scope,
    candidates: snapshot.candidates,
    nowMs: input.nowMs,
  });
}
