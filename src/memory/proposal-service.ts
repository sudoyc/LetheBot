/**
 * Governed memory proposal service.
 *
 * Turns memory candidates from Pi/evaluators/workers into durable memory records
 * through deterministic L0 scanning, evaluator/risk classification, and the
 * governed MemoryRepository write path.
 */

import { createHash } from 'node:crypto';
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
import type {
  IEvaluator,
  MemoryEvaluationRequest,
  MemoryEvaluationResult,
} from '../types/evaluator.js';
import type { MemoryRecord, MemorySource } from '../types/memory.js';
import type { ActorClass, InvocationContext } from '../types/tool.js';
import { scanMemoryForSecrets, type SecretScanFinding } from './secret-scan.js';

export type MemoryRiskLevel = 'low' | 'medium' | 'high' | 'prohibited';

export interface MemoryCandidateInput {
  id?: string;
  turnId?: string;
  jobAttemptId?: string;
  sourceEventIds?: string[];
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
  evaluatorDecisionWriter?: MemoryEvaluatorDecisionWriter;
  auditRepository?: Pick<AuditRepository, 'create'> & Partial<Pick<AuditRepository, 'createOnceForEvent' | 'createSync'>>;
  privacyPreferences?: Pick<PrivacyPreferenceRepository, 'isOptedOut'>;
  now?: () => number;
}

export interface MemoryEvaluatorDecisionWriter {
  runWithMemoryDecision<T>(
    evidence: {
      request: MemoryEvaluationRequest;
      result: MemoryEvaluationResult;
    },
    effect: () => T,
  ): T;
}

interface EvaluatedMemoryCandidate {
  request: MemoryEvaluationRequest;
  result: MemoryEvaluationResult;
}

class MemoryEvaluatorInvocationError extends Error {
  constructor() {
    super('Memory evaluator invocation failed');
    this.name = 'MemoryEvaluatorInvocationError';
  }
}

interface GovernedMemoryPolicy {
  riskLevel: MemoryRiskLevel;
  visibility: MemoryRecord['visibility'];
  sensitivity: MemoryRecord['sensitivity'];
}

export class MemoryProposalService {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly options: MemoryProposalServiceOptions = {}
  ) {}

  async processCandidate(candidate: MemoryCandidateInput): Promise<MemoryProposalOutcome> {
    const requestId = ulid();
    const rejectionEffectId = candidate.id
      ? buildMemoryCandidateEffectId(candidate.id)
      : requestId;
    if (await this.isMemoryAssociationOptedOut(candidate)) {
      const reason = 'Memory candidate rejected by memory-association opt-out';
      await this.auditRejectedCandidate({
        candidate,
        requestId,
        rejectionEffectId,
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
        rejectionEffectId,
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
    let evaluation: EvaluatedMemoryCandidate | undefined;
    try {
      evaluation = await this.evaluateCandidate(candidate, requestId, initialRiskLevel);
    } catch (error) {
      if (!(error instanceof MemoryEvaluatorInvocationError)) {
        throw error;
      }

      const reason = 'Memory candidate rejected because evaluator review failed';
      await this.auditRejectedCandidate({
        candidate,
        requestId,
        rejectionEffectId,
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
    const evaluationResult = evaluation?.result;
    const governedPolicy = this.resolveGovernedPolicy(candidate, evaluationResult, initialRiskLevel);

    if (governedPolicy.riskLevel === 'prohibited') {
      const reason = 'Memory candidate rejected by deterministic post-evaluator policy';
      const recommendedSensitivity = evaluationResult?.recommendedSensitivity;
      const findings: SecretScanFinding[] = [
        recommendedSensitivity === 'secret' || recommendedSensitivity === 'prohibited'
          ? { kind: recommendedSensitivity, pattern: 'evaluator_recommendation' }
          : { kind: 'prohibited', pattern: 'evaluator_risk' },
      ];
      this.runEvaluatedEffect(evaluation, () => this.auditRejectedCandidateSync({
        candidate,
        requestId,
        rejectionEffectId,
        reason,
        riskLevel: 'prohibited',
        findings,
        evaluatorDecisionId: evaluationResult?.decisionId,
      }));

      return {
        requestId,
        status: 'rejected',
        riskLevel: 'prohibited',
        reason,
        evaluatorDecisionId: evaluationResult?.decisionId,
        findings,
      };
    }

    if (evaluationResult?.decision === 'reject' && evaluation) {
      return this.createRejectedMemory(candidate, requestId, evaluation, governedPolicy);
    }

    const state = this.resolveTargetState(candidate, evaluationResult, governedPolicy.riskLevel);

    const memoryInput = this.toMemoryInput(candidate, {
      state,
      evaluatorDecisionId: evaluationResult?.decisionId,
      visibility: governedPolicy.visibility,
      sensitivity: governedPolicy.sensitivity,
      revisionReason: this.buildRevisionReason(candidate, evaluationResult, state),
      auditSummary: `Created ${state} memory from governed candidate`,
    });

    try {
      const memoryId = this.runEvaluatedEffect(
        evaluation,
        () => this.memoryRepo.createSync(memoryInput),
      );
      return {
        requestId,
        status: state,
        riskLevel: governedPolicy.riskLevel,
        reason: evaluationResult
          ? `${evaluationResult.reason}; deterministic policy selected risk=${governedPolicy.riskLevel} state=${state}`
          : this.defaultDecisionReason(governedPolicy.riskLevel, state),
        memoryId,
        evaluatorDecisionId: evaluationResult?.decisionId,
      };
    } catch (error) {
      if (error instanceof MemoryPolicyError) {
        this.runEvaluatedEffect(evaluation, () => this.auditRejectedCandidateSync({
          candidate,
          requestId,
          rejectionEffectId,
          reason: 'Memory candidate rejected by repository policy scan',
          riskLevel: 'prohibited',
          findings: error.findings,
          evaluatorDecisionId: evaluationResult?.decisionId,
        }));

        return {
          requestId,
          status: 'rejected',
          riskLevel: 'prohibited',
          reason: 'Memory candidate rejected by repository policy scan',
          findings: error.findings,
          evaluatorDecisionId: evaluationResult?.decisionId,
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
  ): Promise<EvaluatedMemoryCandidate | undefined> {
    if (!this.options.evaluator) {
      return undefined;
    }

    if (!this.options.evaluatorDecisionWriter) {
      throw new Error('Memory evaluator decision writer is required');
    }

    const hasTurn = typeof candidate.turnId === 'string' && candidate.turnId.trim().length > 0;
    const hasJobAttempt = typeof candidate.jobAttemptId === 'string'
      && candidate.jobAttemptId.trim().length > 0;
    if (hasTurn === hasJobAttempt) {
      throw new Error('Memory evaluator requires exactly one turn or job-attempt authority');
    }

    if (
      !candidate.sourceEventIds
      || candidate.sourceEventIds.length === 0
      || !candidate.sourceEventIds.every((sourceEventId) => sourceEventId.trim().length > 0)
    ) {
      throw new Error('Memory evaluator requires canonical source event IDs');
    }

    const authority = hasJobAttempt
      ? { jobAttemptId: candidate.jobAttemptId as string }
      : { turnId: candidate.turnId as string };
    const request: MemoryEvaluationRequest = {
      requestId,
      domain: 'memory',
      ...authority,
      actor: {
        canonicalUserId: candidate.actor.canonicalUserId,
        actorClass: candidate.actor.actorClass,
      },
      context: candidate.actor.context,
      sourceEventIds: [...candidate.sourceEventIds],
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
    };
    let result: MemoryEvaluationResult;
    try {
      result = await this.options.evaluator.evaluateMemory(request);
    } catch {
      throw new MemoryEvaluatorInvocationError();
    }
    return { request, result };
  }

  private resolveTargetState(
    candidate: MemoryCandidateInput,
    evaluation: MemoryEvaluationResult | undefined,
    riskLevel: MemoryRiskLevel
  ): 'active' | 'proposed' {
    if (this.isGroupChatDerivedUserMemory(candidate)) {
      return 'proposed';
    }

    if (this.isPrivateUserMemory(candidate) && evaluation && evaluation.confidence < 0.85) {
      return 'proposed';
    }

    if (evaluation?.decision === 'propose') {
      return 'proposed';
    }

    if (evaluation?.decision === 'downgrade') {
      return 'proposed';
    }

    if (riskLevel === 'high' || riskLevel === 'prohibited') {
      return 'proposed';
    }

    if (evaluation?.recommendedState) {
      return evaluation.recommendedState;
    }

    return riskLevel === 'low' ? 'active' : 'proposed';
  }

  private async createRejectedMemory(
    candidate: MemoryCandidateInput,
    requestId: string,
    evaluation: EvaluatedMemoryCandidate,
    governedPolicy: GovernedMemoryPolicy
  ): Promise<MemoryProposalOutcome> {
    const result = evaluation.result;
    const memoryId = this.runEvaluatedEffect(evaluation, () => this.memoryRepo.createSync(this.toMemoryInput(candidate, {
      state: 'rejected',
      evaluatorDecisionId: result.decisionId,
      visibility: governedPolicy.visibility,
      sensitivity: governedPolicy.sensitivity,
      revisionReason: `Rejected by evaluator: ${result.reason}`,
      auditSummary: 'Created rejected memory candidate after evaluator rejection',
    })));

    return {
      requestId,
      status: 'rejected',
      riskLevel: governedPolicy.riskLevel,
      reason: result.reason,
      memoryId,
      evaluatorDecisionId: result.decisionId,
    };
  }

  private toMemoryInput(
    candidate: MemoryCandidateInput,
    decision: {
      state: MemoryRecord['state'];
      evaluatorDecisionId?: string;
      visibility: MemoryRecord['visibility'];
      sensitivity: MemoryRecord['sensitivity'];
      revisionReason: string;
      auditSummary: string;
    }
  ): MemoryRecordInput {
    return {
      id: candidate.id,
      scope: candidate.scope,
      canonicalUserId: candidate.canonicalUserId,
      groupId: candidate.groupId,
      conversationId: candidate.conversationId,
      subjectUserId: candidate.subjectUserId,
      visibility: decision.visibility,
      sensitivity: decision.sensitivity,
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

  private resolveGovernedPolicy(
    candidate: MemoryCandidateInput,
    evaluation: MemoryEvaluationResult | undefined,
    initialRiskLevel: Exclude<MemoryRiskLevel, 'prohibited'>
  ): GovernedMemoryPolicy {
    let visibility = this.isGroupChatDerivedUserMemory(candidate)
      ? candidate.visibility
      : evaluation?.recommendedVisibility ?? candidate.visibility;
    const sensitivity = evaluation?.recommendedSensitivity ?? candidate.sensitivity;
    let riskLevel = this.maxRiskLevel(initialRiskLevel, evaluation?.riskLevel);

    if (sensitivity === 'secret' || sensitivity === 'prohibited') {
      riskLevel = 'prohibited';
    } else if (sensitivity === 'sensitive') {
      riskLevel = this.maxRiskLevel(riskLevel, 'high');
    } else if (sensitivity === 'personal') {
      riskLevel = this.maxRiskLevel(riskLevel, 'medium');
    }

    if (this.isGroupChatDerivedUserMemory(candidate)) {
      riskLevel = this.maxRiskLevel(riskLevel, 'high');
    }

    if (riskLevel === 'medium' && !this.isConservativeVisibility(visibility)) {
      visibility = this.isConservativeVisibility(candidate.visibility)
        ? candidate.visibility
        : this.defaultConservativeVisibility(candidate);
    }

    return {
      riskLevel,
      visibility,
      sensitivity,
    };
  }

  private maxRiskLevel(
    ...levels: Array<MemoryRiskLevel | undefined>
  ): MemoryRiskLevel {
    const rank: Record<MemoryRiskLevel, number> = {
      low: 0,
      medium: 1,
      high: 2,
      prohibited: 3,
    };
    return levels.reduce<MemoryRiskLevel>((highest, level) => {
      if (!level || rank[level] <= rank[highest]) {
        return highest;
      }
      return level;
    }, 'low');
  }

  private isConservativeVisibility(visibility: MemoryRecord['visibility']): boolean {
    return visibility === 'private_only'
      || visibility === 'same_group_only'
      || visibility === 'owner_admin_only';
  }

  private defaultConservativeVisibility(
    candidate: MemoryCandidateInput
  ): MemoryRecord['visibility'] {
    if (candidate.groupId || candidate.scope === 'group') {
      return 'same_group_only';
    }
    if (candidate.scope === 'global' || candidate.scope === 'system' || candidate.scope === 'tool') {
      return 'owner_admin_only';
    }
    return 'private_only';
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
    riskLevel: MemoryRiskLevel,
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

  private isPrivateUserMemory(candidate: MemoryCandidateInput): boolean {
    return candidate.scope === 'user'
      && !candidate.groupId
      && (
        candidate.sourceContext.startsWith('private_chat')
        || candidate.sourceContext.startsWith('chat:')
      );
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
    rejectionEffectId: string;
    reason: string;
    riskLevel: Exclude<MemoryRiskLevel, 'low' | 'medium'>;
    findings: SecretScanFinding[];
    evaluatorDecisionId?: string;
  }): Promise<void> {
    if (!this.options.auditRepository) {
      return;
    }

    const entry = this.buildRejectedCandidateAuditEntry(input);

    if (this.options.auditRepository.createOnceForEvent) {
      await this.options.auditRepository.createOnceForEvent(entry);
      return;
    }

    await this.options.auditRepository.create(entry);
  }

  private buildRejectedCandidateAuditEntry(input: {
    candidate: MemoryCandidateInput;
    requestId: string;
    rejectionEffectId: string;
    reason: string;
    riskLevel: Exclude<MemoryRiskLevel, 'low' | 'medium'>;
    findings: SecretScanFinding[];
    evaluatorDecisionId?: string;
  }) {
    return {
      timestamp: new Date(this.now()),
      category: 'memory',
      level: 'summary',
      eventType: 'memory.candidate_rejected',
      eventId: input.rejectionEffectId,
      actor: {
        canonicalUserId: input.candidate.actor.canonicalUserId,
        actorClass: input.candidate.actor.actorClass,
        context: input.candidate.actor.context,
      },
      summary: input.reason,
      details: {
        requestId: input.requestId,
        rejectionEffectId: input.rejectionEffectId,
        scope: input.candidate.scope,
        sourceContext: input.candidate.sourceContext,
        sourceIds: input.candidate.sources.map((source) => source.sourceId),
        findings: input.findings.map((finding) => ({
          kind: finding.kind,
          pattern: finding.pattern,
        })),
      },
      redacted: true,
      riskLevel: input.riskLevel,
      evaluatorDecisionId: input.evaluatorDecisionId,
    } as const;
  }

  private auditRejectedCandidateSync(input: {
    candidate: MemoryCandidateInput;
    requestId: string;
    rejectionEffectId: string;
    reason: string;
    riskLevel: Exclude<MemoryRiskLevel, 'low' | 'medium'>;
    findings: SecretScanFinding[];
    evaluatorDecisionId?: string;
  }): void {
    if (!this.options.auditRepository?.createSync) {
      throw new Error('Synchronous memory rejection audit writer is required');
    }
    this.options.auditRepository.createSync(this.buildRejectedCandidateAuditEntry(input));
  }

  private runEvaluatedEffect<T>(
    evaluation: EvaluatedMemoryCandidate | undefined,
    effect: () => T,
  ): T {
    if (!evaluation) {
      return effect();
    }
    const writer = this.options.evaluatorDecisionWriter;
    if (!writer) {
      throw new Error('Memory evaluator decision writer is required');
    }
    return writer.runWithMemoryDecision(evaluation, effect);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function buildMemoryCandidateEffectId(candidateId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['memory-candidate-rejection-v1', candidateId]))
    .digest('hex');
  return `memory-candidate-v1-${digest}`;
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
