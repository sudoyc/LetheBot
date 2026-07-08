/**
 * Governed memory proposal service.
 *
 * Turns memory candidates from Pi/evaluators/workers into durable memory records
 * through deterministic L0 scanning, evaluator/risk classification, and the
 * governed MemoryRepository write path.
 */

import { ulid } from 'ulidx';
import type { AuditRepository } from '../storage/audit-repository.js';
import type { PrivacyPreferenceRepository } from '../storage/privacy-preference-repository.js';
import {
  MemoryPolicyError,
  MemoryRepository,
  type MemoryRecordInput,
  type MemorySourceInput,
  type MemoryStateChangeOptions,
} from '../storage/memory-repository.js';
import type { IEvaluator, MemoryEvaluationResult } from '../types/evaluator.js';
import type { MemoryRecord, MemorySource } from '../types/memory.js';
import type { ActorClass, InvocationContext } from '../types/tool.js';
import { scanMemoryForSecrets, type SecretScanFinding } from './secret-scan.js';

export type MemoryRiskLevel = 'low' | 'medium' | 'high' | 'prohibited';

export interface MemoryCandidateInput {
  id?: string;
  turnId?: string;
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
  confidence: number;
  importance: number;
  sourceContext: string;
  sources: MemorySourceInput[];
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
    context: InvocationContext;
  };
  contextSummary?: string;
  initialRiskLevel?: Exclude<MemoryRiskLevel, 'prohibited'>;
  expiresAt?: Date;
}

export interface MemoryProposalOutcome {
  requestId: string;
  status: 'active' | 'proposed' | 'rejected';
  riskLevel: MemoryRiskLevel;
  reason: string;
  memoryId?: string;
  evaluatorDecisionId?: string;
  findings?: SecretScanFinding[];
}

export interface MemoryProposalServiceOptions {
  evaluator?: Pick<IEvaluator, 'evaluateMemory'>;
  auditRepository?: Pick<AuditRepository, 'create'>;
  privacyPreferences?: Pick<PrivacyPreferenceRepository, 'isOptedOut'>;
  now?: () => number;
}

export class MemoryProposalService {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly options: MemoryProposalServiceOptions = {}
  ) {}

  async processCandidate(candidate: MemoryCandidateInput): Promise<MemoryProposalOutcome> {
    const requestId = ulid();
    if (await this.isMemoryAssociationOptedOut(candidate)) {
      const reason = 'Memory candidate rejected by memory-association opt-out';
      await this.auditRejectedCandidate({
        candidate,
        requestId,
        reason,
        riskLevel: 'high',
        findings: [],
      });

      return {
        requestId,
        status: 'rejected',
        riskLevel: 'high',
        reason,
      };
    }

    const findings = this.scanForBlockedCandidate(candidate);
    if (findings.length > 0) {
      await this.auditRejectedCandidate({
        candidate,
        requestId,
        reason: 'Memory candidate rejected by deterministic secret/prohibited scan',
        riskLevel: 'prohibited',
        findings,
      });

      return {
        requestId,
        status: 'rejected',
        riskLevel: 'prohibited',
        reason: 'Memory candidate rejected by deterministic secret/prohibited scan',
        findings,
      };
    }

    const initialRiskLevel = candidate.initialRiskLevel ?? this.classifyRisk(candidate);
    const evaluation = await this.evaluateCandidate(candidate, requestId, initialRiskLevel);
    const state = this.resolveTargetState(candidate, evaluation, initialRiskLevel);

    if (evaluation?.decision === 'reject') {
      return this.createRejectedMemory(candidate, requestId, evaluation);
    }

    const memoryInput = this.toMemoryInput(candidate, {
      state,
      evaluatorDecisionId: evaluation?.decisionId,
      evaluation,
      revisionReason: this.buildRevisionReason(candidate, evaluation, state),
      auditSummary: `Created ${state} memory from governed candidate`,
    });

    try {
      const memoryId = await this.memoryRepo.create(memoryInput);
      return {
        requestId,
        status: state,
        riskLevel: evaluation?.riskLevel ?? initialRiskLevel,
        reason: evaluation?.reason ?? this.defaultDecisionReason(initialRiskLevel, state),
        memoryId,
        evaluatorDecisionId: evaluation?.decisionId,
      };
    } catch (error) {
      if (error instanceof MemoryPolicyError) {
        await this.auditRejectedCandidate({
          candidate,
          requestId,
          reason: 'Memory candidate rejected by repository policy scan',
          riskLevel: 'prohibited',
          findings: error.findings,
        });

        return {
          requestId,
          status: 'rejected',
          riskLevel: 'prohibited',
          reason: 'Memory candidate rejected by repository policy scan',
          findings: error.findings,
          evaluatorDecisionId: evaluation?.decisionId,
        };
      }

      throw error;
    }
  }

  async approveProposal(memoryId: string, options?: MemoryStateChangeOptions): Promise<void> {
    await this.memoryRepo.approve(memoryId, {
      ...options,
      reason: options?.reason ?? 'Approved memory proposal',
      auditSummary: options?.auditSummary ?? `Approved memory proposal ${memoryId}`,
    });
  }

  async rejectProposal(memoryId: string, options?: MemoryStateChangeOptions): Promise<void> {
    await this.memoryRepo.reject(memoryId, {
      ...options,
      reason: options?.reason ?? 'Rejected memory proposal',
      auditSummary: options?.auditSummary ?? `Rejected memory proposal ${memoryId}`,
    });
  }

  async supersedeMemory(memoryId: string, replacementMemoryId: string, options?: MemoryStateChangeOptions): Promise<void> {
    await this.memoryRepo.supersede(memoryId, {
      ...options,
      reason: options?.reason ?? `Superseded by memory ${replacementMemoryId}`,
      auditSummary: options?.auditSummary ?? `Superseded memory ${memoryId} with ${replacementMemoryId}`,
    });
  }

  private scanForBlockedCandidate(candidate: MemoryCandidateInput): SecretScanFinding[] {
    if (candidate.sensitivity === 'secret' || candidate.sensitivity === 'prohibited') {
      return [{ kind: candidate.sensitivity, pattern: 'declared_sensitivity' }];
    }

    return scanMemoryForSecrets(`${candidate.title}\n${candidate.content}`);
  }

  private classifyRisk(candidate: MemoryCandidateInput): Exclude<MemoryRiskLevel, 'prohibited'> {
    if (this.isGroupChatDerivedUserMemory(candidate)) {
      return 'high';
    }

    if (candidate.sensitivity === 'sensitive' || candidate.visibility === 'owner_admin_only') {
      return 'high';
    }

    if (candidate.sensitivity === 'personal' || candidate.authority === 'inferred' || candidate.authority === 'tool_derived') {
      return 'medium';
    }

    return 'low';
  }

  private async evaluateCandidate(
    candidate: MemoryCandidateInput,
    requestId: string,
    initialRiskLevel: Exclude<MemoryRiskLevel, 'prohibited'>
  ): Promise<MemoryEvaluationResult | undefined> {
    if (!this.options.evaluator) {
      return undefined;
    }

    return this.options.evaluator.evaluateMemory({
      requestId,
      domain: 'memory',
      turnId: candidate.turnId ?? requestId,
      actor: {
        canonicalUserId: candidate.actor.canonicalUserId,
        actorClass: candidate.actor.actorClass,
      },
      context: candidate.actor.context,
      sourceEventIds: candidate.sources.map((source) => source.sourceId),
      contextSummary: candidate.contextSummary ?? this.buildContextSummary(candidate),
      createdAt: new Date(this.now()),
      memoryCandidate: {
        scope: candidate.scope,
        canonicalUserId: candidate.canonicalUserId,
        groupId: candidate.groupId,
        kind: candidate.kind,
        title: candidate.title,
        content: candidate.content,
        confidence: candidate.confidence,
        sourceContext: candidate.sourceContext,
      },
      initialRiskLevel,
    });
  }

  private resolveTargetState(
    candidate: MemoryCandidateInput,
    evaluation: MemoryEvaluationResult | undefined,
    initialRiskLevel: Exclude<MemoryRiskLevel, 'prohibited'>
  ): 'active' | 'proposed' {
    if (this.isGroupChatDerivedUserMemory(candidate)) {
      return 'proposed';
    }

    if (evaluation?.decision === 'propose') {
      return 'proposed';
    }

    if (evaluation?.decision === 'downgrade') {
      return 'proposed';
    }

    if (evaluation?.recommendedState) {
      return evaluation.recommendedState;
    }

    return initialRiskLevel === 'low' ? 'active' : 'proposed';
  }

  private async createRejectedMemory(
    candidate: MemoryCandidateInput,
    requestId: string,
    evaluation: MemoryEvaluationResult
  ): Promise<MemoryProposalOutcome> {
    const memoryId = await this.memoryRepo.create(this.toMemoryInput(candidate, {
      state: 'rejected',
      evaluatorDecisionId: evaluation.decisionId,
      evaluation,
      revisionReason: `Rejected by evaluator: ${evaluation.reason}`,
      auditSummary: 'Created rejected memory candidate after evaluator rejection',
    }));

    return {
      requestId,
      status: 'rejected',
      riskLevel: evaluation.riskLevel,
      reason: evaluation.reason,
      memoryId,
      evaluatorDecisionId: evaluation.decisionId,
    };
  }

  private toMemoryInput(
    candidate: MemoryCandidateInput,
    decision: {
      state: MemoryRecord['state'];
      evaluatorDecisionId?: string;
      evaluation?: MemoryEvaluationResult;
      revisionReason: string;
      auditSummary: string;
    }
  ): MemoryRecordInput {
    const evaluationAdjusted = this.applyEvaluatorRecommendations(candidate, decision.evaluation);

    return {
      id: candidate.id,
      scope: candidate.scope,
      canonicalUserId: candidate.canonicalUserId,
      groupId: candidate.groupId,
      conversationId: candidate.conversationId,
      subjectUserId: candidate.subjectUserId,
      visibility: evaluationAdjusted.visibility,
      sensitivity: evaluationAdjusted.sensitivity,
      authority: candidate.authority,
      kind: candidate.kind,
      title: candidate.title,
      content: candidate.content,
      state: decision.state,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sourceContext: candidate.sourceContext,
      evaluatorDecisionId: decision.evaluatorDecisionId,
      expiresAt: candidate.expiresAt,
      sources: candidate.sources,
      actor: candidate.actor,
      revisionReason: decision.revisionReason,
      auditSummary: decision.auditSummary,
    };
  }

  private applyEvaluatorRecommendations(
    candidate: MemoryCandidateInput,
    evaluation: MemoryEvaluationResult | undefined
  ): Pick<MemoryCandidateInput, 'visibility' | 'sensitivity'> {
    if (this.isGroupChatDerivedUserMemory(candidate)) {
      return {
        visibility: candidate.visibility,
        sensitivity: evaluation?.recommendedSensitivity ?? candidate.sensitivity,
      };
    }

    return {
      visibility: evaluation?.recommendedVisibility ?? candidate.visibility,
      sensitivity: evaluation?.recommendedSensitivity ?? candidate.sensitivity,
    };
  }

  private buildRevisionReason(
    candidate: MemoryCandidateInput,
    evaluation: MemoryEvaluationResult | undefined,
    state: 'active' | 'proposed'
  ): string {
    const reasons = [`Governed memory candidate accepted as ${state}`];
    if (evaluation) {
      reasons.push(`evaluator=${evaluation.decision}:${evaluation.reason}`);
    }
    if (this.isGroupChatDerivedUserMemory(candidate)) {
      reasons.push('group-chat-derived user memory forced to proposal');
    }
    return reasons.join('; ');
  }

  private defaultDecisionReason(
    riskLevel: Exclude<MemoryRiskLevel, 'prohibited'>,
    state: 'active' | 'proposed'
  ): string {
    return `Deterministic memory policy classified risk=${riskLevel} and selected state=${state}`;
  }

  private buildContextSummary(candidate: MemoryCandidateInput): string {
    return [
      `scope=${candidate.scope}`,
      `source_context=${candidate.sourceContext}`,
      `visibility=${candidate.visibility}`,
      `sensitivity=${candidate.sensitivity}`,
      `authority=${candidate.authority}`,
      `kind=${candidate.kind}`,
      `source_count=${candidate.sources.length}`,
    ].join('\n');
  }

  private isGroupChatDerivedUserMemory(candidate: MemoryCandidateInput): boolean {
    return candidate.sourceContext.startsWith('group_chat') && candidate.scope === 'user';
  }

  private async isMemoryAssociationOptedOut(candidate: MemoryCandidateInput): Promise<boolean> {
    if (
      candidate.scope !== 'user' ||
      !candidate.canonicalUserId ||
      !this.options.privacyPreferences
    ) {
      return false;
    }

    return this.options.privacyPreferences.isOptedOut(candidate.canonicalUserId, 'memory_association');
  }

  private async auditRejectedCandidate(input: {
    candidate: MemoryCandidateInput;
    requestId: string;
    reason: string;
    riskLevel: Exclude<MemoryRiskLevel, 'low' | 'medium'>;
    findings: SecretScanFinding[];
  }): Promise<void> {
    if (!this.options.auditRepository) {
      return;
    }

    await this.options.auditRepository.create({
      timestamp: new Date(this.now()),
      category: 'memory',
      level: 'summary',
      eventType: 'memory.candidate_rejected',
      eventId: input.requestId,
      actor: {
        canonicalUserId: input.candidate.actor.canonicalUserId,
        actorClass: input.candidate.actor.actorClass,
        context: input.candidate.actor.context,
      },
      summary: input.reason,
      details: {
        requestId: input.requestId,
        scope: input.candidate.scope,
        sourceContext: input.candidate.sourceContext,
        sourceIds: input.candidate.sources.map((source) => source.sourceId),
        findings: input.findings.map((finding) => ({
          kind: finding.kind,
          pattern: finding.pattern,
        })),
      },
      redacted: true,
      riskLevel: 'high',
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function toMemorySourceInput(
  sourceType: MemorySource['sourceType'],
  sourceId: string,
  sourceTimestamp: number,
  extractedBy: NonNullable<MemorySource['extractedBy']>
): MemorySourceInput {
  return {
    sourceType,
    sourceId,
    sourceTimestamp,
    extractedBy,
  };
}
