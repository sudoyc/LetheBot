/**
 * Governance CLI
 *
 * 治理命令行工具（Phase L）
 */

import type Database from 'better-sqlite3';
import type { ContextBuilder } from '../context/builder.js';
import {
  formatGovernanceMemoryIdForDisplay,
  GovernanceService,
} from '../governance/service.js';
import {
  collectGovernanceMemoryIdGroups,
  GovernanceQueryService,
  projectGovernanceMemoryExport,
  type AuditInspectionRecord,
  type ActionDecisionExplanation,
  type ActionDecisionInspectionRecord,
  type ActionExecutionInspectionRecord,
  type EventProcessingFailureInspectionRecord,
  type ExplainTurnResolution,
  type ExportMemoryRecord,
  type GovernanceHealthSummaryInspectionRecord,
  type JobAttemptInspectionRecord,
  type JobInspectionRecord,
  type ListAuditOptions,
  type ListActionDecisionOptions,
  type ListActionExecutionOptions,
  type ListEventProcessingFailureOptions,
  type ListJobAttemptOptions,
  type ListJobOptions,
  type ListMemoryOptions,
  type ListMemoryReviewOptions,
  type ListPrivacyPreferenceOptions,
  type ListToolCallOptions,
  type ListWorkerHeartbeatOptions,
  type ModelInvocationSummaryInspectionRecord,
  type MemoryReviewAuditEventType,
  type MemoryReviewCandidateInspectionRecord,
  type MemoryReviewSummaryInspectionRecord,
  type MemoryReviewSummaryOptions,
  type ShowMemoryResult,
  type SummarizeModelInvocationsOptions,
  type ToolCallExplanation,
  type ToolCallInspectionRecord,
  type PrivacyPreferenceInspectionRecord,
  type StoredContextExplanation,
  type WorkerHeartbeatInspectionRecord,
} from '../governance/query-service.js';
import type { MemoryRepository } from '../storage/memory-repository.js';
import type { PrivacyPreferenceType } from '../storage/privacy-preference-repository.js';
import type { ContextPack, MemorySelectionEvidence } from '../types/context.js';
import type { MemoryRecord } from '../types/memory.js';

export interface CommandResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface UnlinkPlatformAccountOptions {
  platform: 'qq';
  platformAccountId: string;
}

export interface SupersedeMemoryOptions {
  reviewAuditId?: string;
}

export interface DisableMemoryOptions {
  decayReviewAuditId?: string;
}

export type {
  ActionDecisionExplanation,
  ActionDecisionInspectionRecord,
  ActionExecutionInspectionRecord,
  AuditInspectionRecord,
  EventProcessingFailureInspectionRecord,
  ExplainTurnResolution,
  ExportMemoryRecord,
  GovernanceHealthSummaryInspectionRecord,
  JobAttemptInspectionRecord,
  JobInspectionRecord,
  ListAuditOptions,
  ListActionDecisionOptions,
  ListActionExecutionOptions,
  ListEventProcessingFailureOptions,
  ListJobAttemptOptions,
  ListJobOptions,
  ListMemoryOptions,
  ListMemoryReviewOptions,
  ListPrivacyPreferenceOptions,
  ListToolCallOptions,
  ListWorkerHeartbeatOptions,
  ModelInvocationPurpose,
  ModelInvocationStatus,
  ModelInvocationSummaryInspectionRecord,
  MemoryReviewAuditEventType,
  MemoryReviewCandidateInspectionRecord,
  MemoryReviewResolutionStatus,
  MemoryReviewSummaryEventTypeRecord,
  MemoryReviewSummaryInspectionRecord,
  MemoryReviewSummaryOptions,
  MemoryRecordInspectionRecord,
  MemorySourceInspectionRecord,
  PrivacyPreferenceInspectionRecord,
  ShowMemoryResult,
  StoredContextExplanation,
  SummarizeModelInvocationsOptions,
  ToolCallExplanation,
  ToolCallInspectionRecord,
  WorkerHeartbeatInspectionRecord,
} from '../governance/query-service.js';

export type { ActionExecutionExplanation } from '../governance/query-service.js';

interface MemoryReviewEvidence {
  auditId: string;
  eventType: MemoryReviewAuditEventType;
}

export interface ExplainContextOptions {
  turnId?: string;
  conversationId?: string;
  conversationType?: 'private' | 'group';
  groupId?: string;
  canonicalUserId?: string;
  messageLimit?: number;
}

export interface ContextExplanation {
  turnId: string;
  contextPackId: string;
  traceSource: 'stored' | 'rebuilt';
  conversation: ContextPack['conversation'];
  selectedMemoryIds: string[];
  candidateMemoryIds: string[];
  rejectedMemories: NonNullable<ContextPack['trace']>['rejectedMemories'];
  filtersApplied: string[];
  injectedIdentityFields: string[];
  recentMessageIds: string[];
  tokenBudget: ContextPack['tokenBudget'];
  memorySelections?: MemorySelectionEvidence[];
  memories: Array<{
    memoryId: string;
    scope: string;
    kind?: MemoryRecord['kind'];
    title: string;
    sourceContext?: string;
    selection?: MemorySelectionEvidence;
  }>;
  actionDecision?: ActionDecisionExplanation;
  toolCalls?: ToolCallExplanation[];
}

export interface RedactDisplayProfileOptions {
  canonicalUserId: string;
  groupId?: string;
}

export interface PrivacyPreferenceCommandOptions {
  canonicalUserId: string;
  preferenceType: PrivacyPreferenceType;
  reason?: string;
}

interface GovernanceCLIOptions {
  db?: Database.Database;
  contextBuilder?: Pick<ContextBuilder, 'build'>;
}

interface AuditRow {
  id: string;
  timestamp: number;
  category: string;
  level: string;
  event_type: string;
  event_id: string;
  actor_user_id: string | null;
  actor_class: string | null;
  invocation_context: string | null;
  summary: string;
  details: string | null;
  redacted: number;
  risk_level: string | null;
  evaluator_decision_id: string | null;
}

export class GovernanceCLI {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly options: GovernanceCLIOptions = {}
  ) {}

  /**
   * 列出记忆记录
   */
  async listMemory(options: ListMemoryOptions): Promise<MemoryRecord[]> {
    if (this.options.db) {
      return new GovernanceQueryService(this.options.db).listMemory(options);
    }

    const filters: Parameters<typeof this.memoryRepo.retrieve>[0] = {
      state: options.state ?? 'active',
      limit: options.limit,
    };

    if (options.userId) filters.canonicalUserId = options.userId;
    if (options.groupId) filters.groupId = options.groupId;
    if (options.conversationId) filters.conversationId = options.conversationId;
    if (options.scope) filters.scope = options.scope;

    return this.memoryRepo.retrieve(filters);
  }

  /**
   * 查看单条记忆及其 source/revision/audit 证据。
   */
  async showMemory(memoryId: string): Promise<ShowMemoryResult | null> {
    const db = this.requireDatabase('memory inspection');
    return new GovernanceQueryService(db).showMemory(memoryId);
  }

  /**
   * 导出可见记忆。默认只导出 active，且强制排除 secret/prohibited。
   */
  async exportMemory(options: ListMemoryOptions = {}): Promise<ExportMemoryRecord[]> {
    if (this.options.db) {
      return new GovernanceQueryService(this.options.db).exportMemory(options);
    }

    const memories = await this.listMemory({
      ...options,
      state: options.state ?? 'active',
    });
    return projectGovernanceMemoryExport(memories);
  }

  /**
   * 查询审计记录。默认隐藏 details；显式 includeDetails 时也会做 deterministic secret redaction。
   */
  async listAudit(options: ListAuditOptions = {}): Promise<AuditInspectionRecord[]> {
    const db = this.requireDatabase('audit inspection');
    return new GovernanceQueryService(db).listAudit(options);
  }

  async listMemoryReviewCandidates(
    options: ListMemoryReviewOptions = {}
  ): Promise<MemoryReviewCandidateInspectionRecord[]> {
    const db = this.requireDatabase('memory review inspection');
    return new GovernanceQueryService(db).listMemoryReviewCandidates(options);
  }

  async summarizeMemoryReviews(
    options: MemoryReviewSummaryOptions = {}
  ): Promise<MemoryReviewSummaryInspectionRecord> {
    const db = this.requireDatabase('memory review inspection');
    return new GovernanceQueryService(db).summarizeMemoryReviews(options);
  }

  async summarizeModelInvocations(
    options: SummarizeModelInvocationsOptions = {},
  ): Promise<ModelInvocationSummaryInspectionRecord> {
    const db = this.requireDatabase('model invocation summary');
    return new GovernanceQueryService(db).summarizeModelInvocations(options);
  }

  async summarizeGovernanceHealth(): Promise<GovernanceHealthSummaryInspectionRecord> {
    const db = this.requireDatabase('governance health summary');
    return new GovernanceQueryService(db).summarizeGovernanceHealth();
  }

  async listToolCalls(options: ListToolCallOptions = {}): Promise<ToolCallInspectionRecord[]> {
    const db = this.requireDatabase('tool call inspection');
    return new GovernanceQueryService(db).listToolCalls(options);
  }

  async listActionDecisions(options: ListActionDecisionOptions = {}): Promise<ActionDecisionInspectionRecord[]> {
    const db = this.requireDatabase('action decision inspection');
    return new GovernanceQueryService(db).listActionDecisions(options);
  }

  async listActionExecutions(options: ListActionExecutionOptions = {}): Promise<ActionExecutionInspectionRecord[]> {
    const db = this.requireDatabase('action execution inspection');
    return new GovernanceQueryService(db).listActionExecutions(options);
  }

  async listJobs(options: ListJobOptions = {}): Promise<JobInspectionRecord[]> {
    const db = this.requireDatabase('job inspection');
    return new GovernanceQueryService(db).listJobs(options);
  }

  async listJobAttempts(options: ListJobAttemptOptions = {}): Promise<JobAttemptInspectionRecord[]> {
    const db = this.requireDatabase('job attempt inspection');
    return new GovernanceQueryService(db).listJobAttempts(options);
  }

  async listWorkerHeartbeats(
    options: ListWorkerHeartbeatOptions = {}
  ): Promise<WorkerHeartbeatInspectionRecord[]> {
    const db = this.requireDatabase('worker heartbeat inspection');
    return new GovernanceQueryService(db).listWorkerHeartbeats(options);
  }

  async listEventProcessingFailures(
    options: ListEventProcessingFailureOptions = {}
  ): Promise<EventProcessingFailureInspectionRecord[]> {
    const db = this.requireDatabase('event processing failure inspection');
    return new GovernanceQueryService(db).listEventProcessingFailures(options);
  }

  async unlinkPlatformAccount(options: UnlinkPlatformAccountOptions): Promise<CommandResult> {
    const db = this.requireDatabase('platform account unlink');

    try {
      const result = new GovernanceService(db).unlinkPlatformAccountAsLocalAdmin(options);
      return result.outcome === 'unlinked'
        ? {
          success: true,
          message: 'Platform account mapping disabled',
        }
        : {
          success: false,
          error: 'Platform account mapping not found or not active',
        };
    } catch {
      return {
        success: false,
        error: 'Platform account unlink failed',
      };
    }
  }

  /**
   * 删除记忆记录
   */
  async deleteMemory(memoryId: string): Promise<CommandResult> {
    try {
      const result = new GovernanceService(
        this.requireDatabase('memory deletion'),
        this.memoryRepo,
      ).forgetMemoryAsLocalAdmin(memoryId);
      if (result.outcome === 'not_found') {
        return {
          success: false,
          error: `Memory ${formatGovernanceMemoryIdForDisplay(memoryId)} not found`,
        };
      }

      return {
        success: true,
        message: `Memory ${formatGovernanceMemoryIdForDisplay(memoryId)} deleted`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 禁用记忆记录
   */
  async disableMemory(memoryId: string, options: DisableMemoryOptions = {}): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing) {
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
        };
      }

      if (options.decayReviewAuditId) {
        if (existing.state !== 'active') {
          return {
            success: false,
            error: `Memory ${memoryId} is not active`,
          };
        }

        if (this.isBlockedMemorySensitivity(existing.sensitivity)) {
          return {
            success: false,
            error: `Memory ${memoryId} has blocked sensitivity ${existing.sensitivity}`,
          };
        }

        const reviewValidation = this.validateDecayReviewAuditEvidence(
          options.decayReviewAuditId,
          memoryId
        );
        if (typeof reviewValidation === 'string') {
          return {
            success: false,
            error: reviewValidation,
          };
        }
      }

      const decayReviewSuffix = options.decayReviewAuditId
        ? ` from decay review ${options.decayReviewAuditId}`
        : '';

      await this.memoryRepo.updateState(memoryId, 'disabled', {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: `Governance CLI disable memory${decayReviewSuffix}`,
        auditSummary: `Governance CLI disabled memory ${memoryId}${decayReviewSuffix}`,
        auditDetails: options.decayReviewAuditId
          ? {
            decayReviewAuditId: options.decayReviewAuditId,
            reviewEventType: 'memory.decay.candidates_detected',
            governedDecayApproval: true,
          }
          : undefined,
      });

      return {
        success: true,
        message: `Memory ${memoryId} disabled`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 批准 proposed 记忆。
   */
  async approveMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing || existing.state !== 'proposed') {
        return {
          success: false,
          error: `Memory ${memoryId} not found or not proposed`,
        };
      }

      await this.memoryRepo.approve(memoryId, {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'Governance CLI approve memory proposal',
        auditSummary: `Governance CLI approved memory ${memoryId}`,
      });

      return {
        success: true,
        message: `Memory ${memoryId} approved`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 拒绝 proposed 记忆。
   */
  async rejectMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing || existing.state !== 'proposed') {
        return {
          success: false,
          error: `Memory ${memoryId} not found or not proposed`,
        };
      }

      await this.memoryRepo.reject(memoryId, {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'Governance CLI reject memory proposal',
        auditSummary: `Governance CLI rejected memory ${memoryId}`,
      });

      return {
        success: true,
        message: `Memory ${memoryId} rejected`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 用 replacement 取代旧记忆。
   */
  async supersedeMemory(
    memoryId: string,
    replacementMemoryId: string,
    options: SupersedeMemoryOptions = {}
  ): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);
      const replacement = await this.memoryRepo.findById(replacementMemoryId);

      if (!existing) {
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
        };
      }

      if (!replacement) {
        return {
          success: false,
          error: `Replacement memory ${replacementMemoryId} not found`,
        };
      }

      const validationError = this.validateSafeSupersede(existing, replacement);
      if (validationError) {
        return {
          success: false,
          error: validationError,
        };
      }

      const reviewEvidence = options.reviewAuditId
        ? this.validateReviewAuditEvidence(options.reviewAuditId, memoryId, replacementMemoryId)
        : undefined;

      if (typeof reviewEvidence === 'string') {
        return {
          success: false,
          error: reviewEvidence,
        };
      }

      const reviewSuffix = reviewEvidence ? ` reviewed by ${reviewEvidence.auditId}` : '';

      await this.memoryRepo.supersede(memoryId, {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: `Governance CLI supersede memory with ${replacementMemoryId}${reviewSuffix}`,
        auditSummary: `Governance CLI superseded memory ${memoryId} by ${replacementMemoryId}${reviewSuffix}`,
        auditDetails: {
          replacementMemoryId,
          reviewAuditId: reviewEvidence?.auditId,
          reviewEventType: reviewEvidence?.eventType,
          governedReviewApproval: Boolean(reviewEvidence),
        },
      });

      return {
        success: true,
        message: `Memory ${memoryId} superseded by ${replacementMemoryId}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 启用记忆记录
   */
  async enableMemory(memoryId: string): Promise<CommandResult> {
    try {
      const result = new GovernanceService(
        this.requireDatabase('memory restoration'),
        this.memoryRepo,
      ).restoreMemoryAsLocalAdmin(memoryId);
      if (result.outcome === 'not_found') {
        return {
          success: false,
          error: `Memory ${memoryId} not found or not restorable`,
        };
      }

      return {
        success: true,
        message: `Memory ${memoryId} enabled`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 恢复 disabled/rejected 记忆。保留 enableMemory 作为旧命令别名。
   */
  async restoreMemory(memoryId: string): Promise<CommandResult> {
    return this.enableMemory(memoryId);
  }

  private validateSafeSupersede(existing: MemoryRecord, replacement: MemoryRecord): string | null {
    if (existing.id === replacement.id) {
      return 'Cannot supersede a memory with itself';
    }

    if (existing.state !== 'active') {
      return `Memory ${existing.id} is not active`;
    }

    if (replacement.state !== 'active') {
      return `Replacement memory ${replacement.id} is not active`;
    }

    if (this.isBlockedMemorySensitivity(existing.sensitivity)) {
      return `Memory ${existing.id} has blocked sensitivity ${existing.sensitivity}`;
    }

    if (this.isBlockedMemorySensitivity(replacement.sensitivity)) {
      return `Replacement memory ${replacement.id} has blocked sensitivity ${replacement.sensitivity}`;
    }

    const boundaryFields: Array<keyof Pick<
      MemoryRecord,
      'scope' | 'canonicalUserId' | 'groupId' | 'conversationId' | 'subjectUserId' | 'kind'
    >> = ['scope', 'canonicalUserId', 'groupId', 'conversationId', 'subjectUserId', 'kind'];

    for (const field of boundaryFields) {
      if ((existing[field] ?? null) !== (replacement[field] ?? null)) {
        return `Cannot supersede memory across different ${field} boundaries`;
      }
    }

    return null;
  }

  private isBlockedMemorySensitivity(sensitivity: MemoryRecord['sensitivity']): boolean {
    return sensitivity === 'secret' || sensitivity === 'prohibited';
  }

  private validateReviewAuditEvidence(
    reviewAuditId: string,
    memoryId: string,
    replacementMemoryId: string
  ): MemoryReviewEvidence | string {
    const db = this.requireDatabase('memory review approval');
    const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(reviewAuditId) as AuditRow | undefined;

    if (!row) {
      return `Review audit ${reviewAuditId} not found`;
    }

    if (row.category !== 'memory') {
      return `Review audit ${reviewAuditId} is not a memory audit event`;
    }

    if (
      row.event_type !== 'memory.conflict.detected'
      && row.event_type !== 'memory.consolidation.candidates_detected'
    ) {
      return `Review audit ${reviewAuditId} is not a supported memory review event`;
    }

    const details = row.details ? this.parseJson(row.details) : undefined;
    if (!this.reviewDetailsReferencePair(details, memoryId, replacementMemoryId)) {
      return `Review audit ${reviewAuditId} does not reference both memory records`;
    }

    return {
      auditId: reviewAuditId,
      eventType: row.event_type,
    };
  }

  private validateDecayReviewAuditEvidence(
    reviewAuditId: string,
    memoryId: string
  ): true | string {
    const db = this.requireDatabase('memory decay review approval');
    const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(reviewAuditId) as AuditRow | undefined;

    if (!row) {
      return `Decay review audit ${reviewAuditId} not found`;
    }

    if (row.category !== 'memory') {
      return `Decay review audit ${reviewAuditId} is not a memory audit event`;
    }

    if (row.event_type !== 'memory.decay.candidates_detected') {
      return `Decay review audit ${reviewAuditId} is not a memory decay review event`;
    }

    const details = row.details ? this.parseJson(row.details) : undefined;
    if (!this.reviewDetailsReferenceMemoryId(details, memoryId)) {
      return `Decay review audit ${reviewAuditId} does not reference memory ${memoryId}`;
    }

    return true;
  }

  private reviewDetailsReferencePair(
    details: unknown,
    memoryId: string,
    replacementMemoryId: string
  ): boolean {
    return collectGovernanceMemoryIdGroups(details).some((group) => (
      group.includes(memoryId) && group.includes(replacementMemoryId)
    ));
  }

  private reviewDetailsReferenceMemoryId(details: unknown, memoryId: string): boolean {
    if (Array.isArray(details)) {
      return details.some((item) => this.reviewDetailsReferenceMemoryId(item, memoryId));
    }

    if (details && typeof details === 'object') {
      const objectValue = details as Record<string, unknown>;
      if (objectValue.memoryId === memoryId) {
        return true;
      }

      if (Array.isArray(objectValue.memoryIds) && objectValue.memoryIds.includes(memoryId)) {
        return true;
      }

      return Object.values(objectValue).some((child) => this.reviewDetailsReferenceMemoryId(child, memoryId));
    }

    return false;
  }

  /**
   * CLI 等价 `/why`：重建指定或最近回合的 ContextBuilder trace。
   */
  async explainContext(options: ExplainContextOptions): Promise<ContextExplanation> {
    if (!this.options.contextBuilder) {
      throw new Error('ContextBuilder is required for context explanation');
    }

    const resolved = await this.resolveExplainContextOptions(options);
    const [actionDecision, toolCalls, stored] = await Promise.all([
      this.findActionDecisionExplanation(resolved.turnId),
      this.findToolCallExplanations(resolved.turnId),
      this.findStoredContextExplanation(resolved.turnId),
    ]);
    if (stored) {
      return { ...stored, actionDecision, toolCalls };
    }

    const context = await this.options.contextBuilder.build({
      turnId: resolved.turnId,
      conversationId: resolved.conversationId,
      conversationType: resolved.conversationType,
      groupId: resolved.groupId,
      canonicalUserId: resolved.canonicalUserId,
      messageLimit: options.messageLimit,
    });
    const memorySelections = context.trace?.memorySelections;
    const selectionByMemoryId = new Map(
      (memorySelections ?? []).map((selection) => [selection.memoryId, selection]),
    );

    return {
      turnId: resolved.turnId,
      contextPackId: context.id,
      traceSource: 'rebuilt',
      conversation: context.conversation,
      selectedMemoryIds: context.memory.selectedMemoryIds,
      candidateMemoryIds: context.trace?.candidateMemoryIds ?? [],
      rejectedMemories: context.trace?.rejectedMemories ?? [],
      filtersApplied: context.trace?.filtersApplied ?? [],
      injectedIdentityFields: context.injectedIdentityFields,
      recentMessageIds: context.recentMessages.map((message) => message.messageId),
      tokenBudget: context.tokenBudget,
      ...(memorySelections === undefined ? {} : { memorySelections }),
      memories: context.memory.retrievedFacts.map((memory) => ({
        memoryId: memory.memoryId,
        scope: memory.scope,
        kind: memory.kind,
        title: memory.title,
        sourceContext: memory.sourceContext,
        ...(selectionByMemoryId.has(memory.memoryId)
          ? { selection: selectionByMemoryId.get(memory.memoryId) }
          : {}),
      })),
      actionDecision,
      toolCalls,
    };
  }

  private async findToolCallExplanations(turnId: string): Promise<ToolCallExplanation[]> {
    if (!this.options.db) {
      return [];
    }

    return new GovernanceQueryService(this.options.db).explainToolCalls(turnId);
  }

  private async findActionDecisionExplanation(
    turnId: string,
  ): Promise<ActionDecisionExplanation | undefined> {
    if (!this.options.db) {
      return undefined;
    }

    return new GovernanceQueryService(this.options.db).explainActionDecision(turnId);
  }

  private async findStoredContextExplanation(turnId: string): Promise<StoredContextExplanation | null> {
    if (!this.options.db) {
      return null;
    }

    return new GovernanceQueryService(this.options.db).explainStoredContext(turnId);
  }

  /**
   * Redact current display profile and nickname history for a user or group-scoped profile.
   */
  async redactDisplayProfile(options: RedactDisplayProfileOptions): Promise<CommandResult> {
    if (!this.options.db) {
      return {
        success: false,
        error: 'Database connection is required for display profile redaction',
      };
    }

    const db = this.options.db;

    try {
      const changes = new GovernanceService(db).redactDisplayProfileAsLocalAdmin(options);
      return {
        success: true,
        message: `Redacted ${changes} display profile/nickname rows for ${options.canonicalUserId}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async listPrivacyPreferences(
    options: ListPrivacyPreferenceOptions = {}
  ): Promise<PrivacyPreferenceInspectionRecord[]> {
    const db = this.requireDatabase('privacy preference inspection');
    return new GovernanceQueryService(db).listPrivacyPreferences(options);
  }

  async setPrivacyOptOut(options: PrivacyPreferenceCommandOptions): Promise<CommandResult> {
    try {
      new GovernanceService(
        this.requireDatabase('privacy preference update'),
      ).setPrivacyPreferenceAsLocalAdmin({
        canonicalUserId: options.canonicalUserId,
        preferenceType: options.preferenceType,
        state: 'opted_out',
        reason: options.reason ?? 'Governance CLI set privacy opt-out',
      });

      return {
        success: true,
        message: `${options.canonicalUserId} opted out of ${options.preferenceType}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async clearPrivacyOptOut(options: PrivacyPreferenceCommandOptions): Promise<CommandResult> {
    try {
      new GovernanceService(
        this.requireDatabase('privacy preference update'),
      ).setPrivacyPreferenceAsLocalAdmin({
        canonicalUserId: options.canonicalUserId,
        preferenceType: options.preferenceType,
        state: 'opted_in',
        reason: options.reason ?? 'Governance CLI clear privacy opt-out',
      });

      return {
        success: true,
        message: `${options.canonicalUserId} opted back into ${options.preferenceType}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private requireDatabase(purpose: string): Database.Database {
    if (!this.options.db) {
      throw new Error(`Database connection is required for ${purpose}`);
    }

    return this.options.db;
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async resolveExplainContextOptions(options: ExplainContextOptions): Promise<{
    turnId: string;
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
    canonicalUserId?: string;
  }> {
    if (options.turnId && options.conversationId) {
      throw new Error('Choose either --turn or --conversation, not both');
    }

    if (options.conversationId && !options.conversationType) {
      throw new Error('Conversation type is required when --conversation is provided');
    }

    if (options.conversationId && options.conversationType === 'group' && !options.groupId) {
      throw new Error('Group ID is required when --conversation uses --type group');
    }

    if (options.conversationId && options.conversationType === 'private' && options.groupId) {
      throw new Error('Group ID is not allowed when --conversation uses --type private');
    }

    if (options.conversationId && options.conversationType) {
      return {
        turnId: options.turnId ?? 'governance-cli-why',
        conversationId: options.conversationId,
        conversationType: options.conversationType,
        groupId: options.groupId,
        canonicalUserId: options.canonicalUserId,
      };
    }

    const row = await this.findExplainTurn(options.turnId);
    if (!row) {
      throw new Error(options.turnId ? `Turn ${options.turnId} not found` : 'No agent turn found');
    }

    const conversationType = options.conversationType ?? row.conversationType;
    if (!conversationType) {
      throw new Error('Conversation type is required when it cannot be inferred from the turn');
    }

    return {
      turnId: row.turnId,
      conversationId: options.conversationId ?? row.conversationId,
      conversationType,
      groupId: options.groupId ?? row.groupId ?? undefined,
      canonicalUserId: options.canonicalUserId ?? this.inferCanonicalUserId(row.senderId),
    };
  }

  private async findExplainTurn(turnId?: string): Promise<ExplainTurnResolution | null> {
    if (!this.options.db) {
      throw new Error('Database connection is required to resolve a turn');
    }

    return new GovernanceQueryService(this.options.db).resolveExplainTurn(turnId);
  }

  private inferCanonicalUserId(senderId: string | null): string | undefined {
    if (!senderId) {
      return undefined;
    }
    return senderId.startsWith('user-') ? senderId : undefined;
  }
}
