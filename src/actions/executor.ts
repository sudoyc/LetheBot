/**
 * Action executor / response router skeleton.
 *
 * Converts approved ActionPlans into platform side effects while persisting
 * execution results. Governed memory and durable local background actions are
 * routed through configured repositories; unwired action types are rejected.
 */

import type { MessageContent, MessageTarget } from '../gateway/adapter.js';
import type { GatewayCapabilities } from '../types/events.js';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type {
  ActionDecision,
  ActionExecutionResult,
  ActionPlan,
  BackgroundTaskActionType,
} from '../types/action.js';
import type { PrivacyPreferenceRepository } from '../storage/privacy-preference-repository.js';
import type { JobRepository } from '../storage/job-repository.js';
import { GroupSummaryPolicyError } from '../storage/group-summary-policy-repository.js';
import { MemoryPolicyError, type MemoryRepository } from '../storage/memory-repository.js';
import type { MemoryRecord } from '../types/memory.js';
import type { ActorClass } from '../types/tool.js';
import {
  GroupSummaryWindowError,
  type SummaryJobEnqueuer,
} from '../workers/group-summary-job-service.js';
import { ActionRepository, type ActionTurnSource } from './action-repository.js';

export interface MessageSender {
  sendMessage(target: MessageTarget, content: MessageContent): Promise<string>;
  sendReaction?(messageId: string, emoji: string): Promise<void>;
  getCapabilities?(): GatewayCapabilities;
}

export interface ActionExecutorOptions {
  privacyPreferences?: Pick<PrivacyPreferenceRepository, 'isOptedOut'>;
  jobRepository?: Pick<JobRepository, 'enqueue'>;
  summaryJobService?: SummaryJobEnqueuer;
  memoryRepository?: Pick<MemoryRepository, 'create'>;
}

const ADMIN_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_TASK_ACTION_TYPES = [
  'summary',
  'extraction',
  'consolidation',
  'decay',
  'conflict',
  'admin_digest',
  'retention',
] as const satisfies readonly BackgroundTaskActionType[];

const MEMORY_PROPOSAL_SCOPES = ['user', 'group', 'conversation', 'global'] as const;
const MEMORY_PROPOSAL_KINDS = [
  'preference',
  'fact',
  'constraint',
  'summary',
  'reflection',
  'procedure',
] as const satisfies readonly MemoryRecord['kind'][];

type MemoryProposalScope = typeof MEMORY_PROPOSAL_SCOPES[number];

interface ParsedMemoryProposal {
  scope: MemoryProposalScope;
  canonicalUserId?: string;
  groupId?: string;
  conversationId?: string;
  visibility: MemoryRecord['visibility'];
  kind: MemoryRecord['kind'];
  title: string;
  content: string;
  confidence: number;
  importance: number;
}

type DmOptOutStatus =
  | 'not_checked'
  | 'missing_canonical_user'
  | 'checked_not_opted_out'
  | 'opted_out';

export class ActionExecutor {
  constructor(
    private readonly actionRepo: ActionRepository,
    private readonly messageSender: MessageSender,
    private readonly options: ActionExecutorOptions = {},
  ) {}

  async execute(decision: ActionDecision): Promise<ActionExecutionResult[]> {
    const verified = this.snapshotAndVerifyDecision(decision);
    const actions = [...verified.decision.actions].sort((a, b) => b.priority - a.priority);
    const idempotencySuffixes = this.buildJobIdempotencySuffixes(actions);
    const results: ActionExecutionResult[] = [];

    for (const [index, action] of actions.entries()) {
      results.push(await this.executeAction(
        verified.decision,
        action,
        verified.turnSource,
        idempotencySuffixes[index],
      ));
    }

    return results;
  }

  private snapshotAndVerifyDecision(decision: ActionDecision): {
    decision: ActionDecision;
    turnSource: ActionTurnSource;
  } {
    let snapshot: ActionDecision;
    try {
      snapshot = structuredClone(decision);
    } catch {
      throw new Error('Action decision execution binding is invalid');
    }
    const turnSource = this.actionRepo.assertExecutionBinding(snapshot);
    return { decision: snapshot, turnSource };
  }

  private async executeAction(
    decision: ActionDecision,
    action: ActionPlan,
    turnSource: ActionTurnSource,
    jobIdempotencySuffix?: string,
  ): Promise<ActionExecutionResult> {
    const policyRejection = this.getPolicyRejection(decision, action);
    if (policyRejection) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: policyRejection.code,
          message: policyRejection.message,
          recoverable: false,
        },
        auditLevel: 'summary',
        auditEntry: `${action.reason}; L0 policy: ${policyRejection.message}`,
      });
    }

    if (this.isReplyAction(action)) {
      return this.executeReply(decision, action);
    }

    if (action.type === 'dm_user') {
      return this.executeDirectMessage(decision, action);
    }

    if (action.type === 'react_only') {
      return this.executeReaction(decision, action);
    }

    if (action.type === 'send_folded_forward') {
      return this.executeFoldedForward(decision, action);
    }

    if (action.type === 'admin_digest') {
      return this.executeAdminDigest(decision, action, jobIdempotencySuffix);
    }

    if (action.type === 'propose_memory') {
      return this.executeProposeMemory(decision, action, turnSource);
    }

    if (action.type === 'schedule_background_task') {
      return this.executeScheduleBackgroundTask(
        decision,
        action,
        turnSource,
        jobIdempotencySuffix,
      );
    }

    if (action.type === 'silent_summarize_later') {
      return this.executeSilentSummarizeLater(
        decision,
        action,
        turnSource,
        jobIdempotencySuffix,
      );
    }

    if (action.type === 'silent_store') {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'success',
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    return this.actionRepo.createExecution({
      actionDecisionId: decision.id,
      actionType: action.type,
      status: 'rejected',
      error: {
        code: 'ACTION_NOT_IMPLEMENTED',
        message: `${action.type} execution is not wired yet`,
        recoverable: true,
      },
      auditLevel: 'summary',
      auditEntry: action.reason,
    });
  }

  private async executeSilentSummarizeLater(
    decision: ActionDecision,
    action: ActionPlan,
    turnSource: ActionTurnSource,
    jobIdempotencySuffix?: string,
  ): Promise<ActionExecutionResult> {
    const target = action.target;
    if (!target?.conversationId) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'INVALID_SILENT_SUMMARY_ACTION',
          message: 'silent_summarize_later action requires a target conversationId',
          recoverable: false,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    const reasonSummary = this.redactActionNarrative(action.reason);
    const idempotencyKey = `${`action:silent_summarize_later:${decision.id}:summary`}${jobIdempotencySuffix ?? ''}`;
    const payload = {
      source: 'action_executor',
      actionDecisionId: decision.id,
      actionType: action.type,
      conversationId: target.conversationId,
      conversationType: target.conversationType,
      groupId: target.groupId,
      reasonSummary,
    };

    if (target.conversationType === 'group') {
      const invalidTarget = this.groupSummaryTargetError(target, action.payload);
      if (invalidTarget) {
        return this.rejectGroupSummaryAction(decision, action, invalidTarget);
      }
      const invalidSource = this.groupSummaryTurnSourceError(target, turnSource);
      if (invalidSource) {
        return this.rejectGroupSummaryAction(decision, action, invalidSource);
      }
      if (!this.options.summaryJobService) {
        return this.rejectGroupSummaryAction(
          decision,
          action,
          'Group summaries require the governed summary job service',
          'GROUP_SUMMARY_SERVICE_NOT_CONFIGURED',
          true,
        );
      }

      try {
        const jobId = await this.options.summaryJobService.enqueueSummary({
          conversationId: target.conversationId,
          conversationType: 'group',
          groupId: target.groupId,
          payload,
          baseIdempotencyKey: idempotencyKey,
          maxAttempts: 2,
        });
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'success',
          executedJobId: jobId,
          auditLevel: 'summary',
          auditEntry: `${reasonSummary}; silent_summary_job_scheduled=true`,
        });
      } catch (error) {
        return this.handleGroupSummaryEnqueueFailure(
          decision,
          action,
          error,
          'SCHEDULE_SILENT_SUMMARY_FAILED',
          'Unknown silent summary scheduling failure',
        );
      }
    }

    if (!this.options.jobRepository) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'BACKGROUND_JOB_REPOSITORY_NOT_CONFIGURED',
          message: 'silent_summarize_later action requires a durable job repository',
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    try {
      const jobId = this.options.jobRepository.enqueue({
        type: 'summary',
        payload,
        idempotencyKey,
        maxAttempts: 2,
      });

      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'success',
        executedJobId: jobId,
        auditLevel: 'summary',
        auditEntry: `${reasonSummary}; silent_summary_job_scheduled=true`,
      });
    } catch (error) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'failed',
        error: {
          code: 'SCHEDULE_SILENT_SUMMARY_FAILED',
          message: this.redactErrorMessage(
            error instanceof Error ? error.message : 'Unknown silent summary scheduling failure',
          ),
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }
  }

  private async executeProposeMemory(
    decision: ActionDecision,
    action: ActionPlan,
    turnSource: ActionTurnSource,
  ): Promise<ActionExecutionResult> {
    if (!this.options.memoryRepository) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'MEMORY_REPOSITORY_NOT_CONFIGURED',
          message: 'propose_memory action requires a governed memory repository',
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    const proposal = action.payload?.memoryProposal;
    const parsed = this.parseMemoryProposal(action, proposal);
    if (!parsed.ok) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'INVALID_MEMORY_PROPOSAL_ACTION',
          message: parsed.reason,
          recoverable: false,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    const reasonSummary = this.redactActionNarrative(action.reason);
    if (
      parsed.value.scope === 'user'
      && parsed.value.canonicalUserId
      && this.options.privacyPreferences
      && await this.options.privacyPreferences.isOptedOut(
        parsed.value.canonicalUserId,
        'memory_association',
      )
    ) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'MEMORY_ASSOCIATION_OPT_OUT',
          message: 'User has opted out of memory association',
          recoverable: false,
        },
        auditLevel: 'summary',
        auditEntry: `${reasonSummary}; memory_association_opt_out=true`,
      });
    }

    const actorClass = this.memoryProposalActorClass(decision);

    try {
      const memoryId = await this.options.memoryRepository.create({
        scope: parsed.value.scope,
        canonicalUserId: parsed.value.canonicalUserId,
        groupId: parsed.value.groupId,
        conversationId: parsed.value.conversationId,
        visibility: parsed.value.visibility,
        sensitivity: 'normal',
        authority: 'inferred',
        kind: parsed.value.kind,
        title: parsed.value.title,
        content: parsed.value.content,
        state: 'proposed',
        confidence: parsed.value.confidence,
        importance: parsed.value.importance,
        sourceContext: 'action_executor:propose_memory',
        evaluatorDecisionId: decision.evaluatorDecisionId,
        sources: [
          {
            sourceType: 'raw_event',
            sourceId: turnSource.triggerEventId,
            extractedBy: actorClass === 'evaluator' ? 'evaluator' : 'worker',
          },
        ],
        actor: {
          canonicalUserId: parsed.value.canonicalUserId,
          actorClass,
          context: 'internal',
        },
        revisionReason: `propose_memory action created proposed memory; ${reasonSummary}`,
        auditSummary: 'propose_memory action created proposed memory for review',
      });

      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'success',
        executedMemoryId: memoryId,
        auditLevel: 'summary',
        auditEntry: `${reasonSummary}; memory_proposal_created=true`,
      });
    } catch (error) {
      if (error instanceof MemoryPolicyError) {
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'rejected',
          error: {
            code: 'MEMORY_PROPOSAL_POLICY_REJECTED',
            message: 'memory proposal rejected by deterministic memory policy',
            recoverable: false,
          },
          auditLevel: 'summary',
          auditEntry: `${reasonSummary}; memory_proposal_policy_rejected=true`,
        });
      }

      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'failed',
        error: {
          code: 'CREATE_MEMORY_PROPOSAL_FAILED',
          message: this.redactErrorMessage(
            error instanceof Error ? error.message : 'Unknown memory proposal creation failure',
          ),
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }
  }

  private async executeAdminDigest(
    decision: ActionDecision,
    action: ActionPlan,
    jobIdempotencySuffix?: string,
  ): Promise<ActionExecutionResult> {
    if (!this.options.jobRepository) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'BACKGROUND_JOB_REPOSITORY_NOT_CONFIGURED',
          message: 'admin_digest action requires a durable job repository',
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    const nowMs = Date.now();
    const reasonSummary = this.redactActionNarrative(action.reason);

    try {
      const jobId = this.options.jobRepository.enqueue({
        type: 'admin_digest',
        payload: {
          source: 'action_executor',
          actionDecisionId: decision.id,
          actionType: action.type,
          conversationType: action.target?.conversationType,
          sinceMs: nowMs - ADMIN_DIGEST_WINDOW_MS,
          nowMs,
          reasonSummary,
        },
        idempotencyKey: `${`action:admin_digest:${decision.id}`}${jobIdempotencySuffix ?? ''}`,
        maxAttempts: 2,
      });

      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'success',
        executedJobId: jobId,
        auditLevel: 'summary',
        auditEntry: `${reasonSummary}; admin_digest_job_scheduled=true`,
      });
    } catch (error) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'failed',
        error: {
          code: 'SCHEDULE_ADMIN_DIGEST_FAILED',
          message: this.redactErrorMessage(
            error instanceof Error ? error.message : 'Unknown admin digest scheduling failure',
          ),
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }
  }

  private async executeScheduleBackgroundTask(
    decision: ActionDecision,
    action: ActionPlan,
    turnSource: ActionTurnSource,
    jobIdempotencySuffix?: string,
  ): Promise<ActionExecutionResult> {
    const task = action.payload?.backgroundTask;
    if (!task || !this.isBackgroundTaskActionType(task.type)) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'INVALID_BACKGROUND_TASK_ACTION',
          message: 'schedule_background_task action requires a known payload.backgroundTask.type',
          recoverable: false,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    const reasonSummary = this.redactActionNarrative(action.reason);
    const taskPayload = this.redactActionStructuredValue(task.payload ?? {});
    const taskPayloadRecord = this.toActionPayloadRecord(taskPayload);
    const idempotencyKey = `${`action:schedule_background_task:${decision.id}:${task.type}`}${jobIdempotencySuffix ?? ''}`;
    const payload = {
      ...taskPayloadRecord,
      source: 'action_executor',
      actionDecisionId: decision.id,
      actionType: action.type,
      conversationType: action.target?.conversationType ?? taskPayloadRecord.conversationType,
      reasonSummary,
      taskPayload: taskPayloadRecord,
    };

    if (task.type === 'summary' && action.target?.conversationType === 'group') {
      const invalidTarget = this.groupSummaryTargetError(action.target, task.payload);
      if (invalidTarget) {
        return this.rejectGroupSummaryAction(decision, action, invalidTarget);
      }
      const invalidSource = this.groupSummaryTurnSourceError(action.target, turnSource);
      if (invalidSource) {
        return this.rejectGroupSummaryAction(decision, action, invalidSource);
      }
      if (!this.options.summaryJobService) {
        return this.rejectGroupSummaryAction(
          decision,
          action,
          'Group summaries require the governed summary job service',
          'GROUP_SUMMARY_SERVICE_NOT_CONFIGURED',
          true,
        );
      }

      try {
        const jobId = await this.options.summaryJobService.enqueueSummary({
          conversationId: action.target.conversationId,
          conversationType: 'group',
          groupId: action.target.groupId,
          payload,
          baseIdempotencyKey: idempotencyKey,
          scheduledAt: this.toBackgroundTaskScheduledAt(task.scheduledAt),
          maxAttempts: this.toBackgroundTaskMaxAttempts(task.maxAttempts),
        });
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'success',
          executedJobId: jobId,
          auditLevel: 'summary',
          auditEntry: `${reasonSummary}; background_task_scheduled=true`,
        });
      } catch (error) {
        return this.handleGroupSummaryEnqueueFailure(
          decision,
          action,
          error,
          'SCHEDULE_BACKGROUND_TASK_FAILED',
          'Unknown background task scheduling failure',
        );
      }
    }

    if (
      task.type === 'summary'
      && this.summaryPayloadClaimsGroup(task.payload)
    ) {
      return this.rejectGroupSummaryAction(
        decision,
        action,
        'Group summary scope must come from an exact group action target',
      );
    }

    if (!this.options.jobRepository) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'BACKGROUND_JOB_REPOSITORY_NOT_CONFIGURED',
          message: 'schedule_background_task action requires a durable job repository',
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    try {
      const jobId = this.options.jobRepository.enqueue({
        type: task.type,
        payload,
        idempotencyKey,
        scheduledAt: this.toBackgroundTaskScheduledAt(task.scheduledAt),
        maxAttempts: this.toBackgroundTaskMaxAttempts(task.maxAttempts),
      });

      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'success',
        executedJobId: jobId,
        auditLevel: 'summary',
        auditEntry: `${reasonSummary}; background_task_scheduled=true`,
      });
    } catch (error) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'failed',
        error: {
          code: 'SCHEDULE_BACKGROUND_TASK_FAILED',
          message: this.redactErrorMessage(
            error instanceof Error ? error.message : 'Unknown background task scheduling failure',
          ),
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }
  }

  private async executeReaction(
    decision: ActionDecision,
    action: ActionPlan,
  ): Promise<ActionExecutionResult> {
    const reaction = action.payload?.reaction?.trim();
    const messageId = action.payload?.messageId?.trim();

    if (!reaction || !messageId) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'INVALID_REACTION_ACTION',
          message: 'react_only action requires payload.reaction and payload.messageId',
          recoverable: false,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    const capabilities = this.getGatewayCapabilities();

    if (capabilities.reactions.emojiLike && this.messageSender.sendReaction) {
      try {
        await this.messageSender.sendReaction(messageId, reaction);
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'success',
          auditLevel: 'summary',
          auditEntry: `${action.reason}; gateway_reaction=true`,
        });
      } catch (error) {
        if (!capabilities.reactions.faceMessage || !action.target) {
          return this.actionRepo.createExecution({
            actionDecisionId: decision.id,
            actionType: action.type,
            status: 'failed',
            error: {
              code: 'SEND_REACTION_FAILED',
              message: this.redactErrorMessage(
                error instanceof Error ? error.message : 'Unknown reaction send failure',
              ),
              recoverable: true,
            },
            auditLevel: 'summary',
            auditEntry: action.reason,
          });
        }
      }
    }

    if (capabilities.reactions.faceMessage && action.target) {
      try {
        const fallbackMessageId = await this.messageSender.sendMessage(action.target, { text: reaction });
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'downgraded',
          executedMessageId: fallbackMessageId,
          downgradedFrom: 'react_only',
          downgradedReason: 'Gateway emoji-like reaction unavailable or failed; sent face-message fallback',
          auditLevel: 'summary',
          auditEntry: `${action.reason}; face_message_fallback=true`,
        });
      } catch (error) {
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'failed',
          error: {
            code: 'SEND_REACTION_FALLBACK_FAILED',
            message: this.redactErrorMessage(
              error instanceof Error ? error.message : 'Unknown reaction fallback send failure',
            ),
            recoverable: true,
          },
          auditLevel: 'summary',
          auditEntry: action.reason,
        });
      }
    }

    return this.actionRepo.createExecution({
      actionDecisionId: decision.id,
      actionType: action.type,
      status: 'downgraded',
      downgradedFrom: 'react_only',
      downgradedReason: 'Gateway reaction and face-message fallback unavailable; stored silently',
      auditLevel: 'summary',
      auditEntry: `${action.reason}; silent_reaction_fallback=true`,
    });
  }

  private async executeFoldedForward(
    decision: ActionDecision,
    action: ActionPlan,
  ): Promise<ActionExecutionResult> {
    const target = action.target;
    const text = action.payload?.text?.trim();

    if (target && text) {
      try {
        const fallbackMessageId = await this.messageSender.sendMessage(target, { text });
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'downgraded',
          executedMessageId: fallbackMessageId,
          downgradedFrom: 'send_folded_forward',
          downgradedReason: 'Folded-forward delivery is not wired; sent text fallback',
          auditLevel: 'summary',
          auditEntry: `${action.reason}; folded_forward_text_fallback=true`,
        });
      } catch (error) {
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'failed',
          error: {
            code: 'SEND_FOLDED_FORWARD_FALLBACK_FAILED',
            message: this.redactErrorMessage(
              error instanceof Error ? error.message : 'Unknown folded-forward fallback send failure',
            ),
            recoverable: true,
          },
          auditLevel: 'summary',
          auditEntry: action.reason,
        });
      }
    }

    const downgradedReason = text
      ? 'Folded-forward delivery is not wired and no fallback target was provided; stored silently'
      : 'Folded-forward delivery is not wired and no fallback text was provided; stored silently';

    return this.actionRepo.createExecution({
      actionDecisionId: decision.id,
      actionType: action.type,
      status: 'downgraded',
      downgradedFrom: 'send_folded_forward',
      downgradedReason,
      auditLevel: 'summary',
      auditEntry: `${action.reason}; silent_folded_forward_fallback=true`,
    });
  }

  private async executeDirectMessage(
    decision: ActionDecision,
    action: ActionPlan,
  ): Promise<ActionExecutionResult> {
    const target = action.target;
    const text = action.payload?.text?.trim();
    let dmOptOutStatus: DmOptOutStatus = 'not_checked';

    if (!target?.userId || !text) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'INVALID_DM_ACTION',
          message: 'dm_user action requires target.userId and non-empty text',
          recoverable: false,
        },
        auditLevel: 'summary',
        auditEntry: this.withDmAuditMetadata(action, dmOptOutStatus),
      });
    }

    if (action.constraints.proactive === true && this.options.privacyPreferences) {
      if (!target.canonicalUserId) {
        dmOptOutStatus = 'missing_canonical_user';
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'rejected',
          error: {
            code: 'PROACTIVE_DM_CANONICAL_USER_REQUIRED',
            message: 'Proactive DM action requires target.canonicalUserId for opt-out enforcement',
            recoverable: false,
          },
          auditLevel: 'summary',
          auditEntry: this.withDmAuditMetadata(action, dmOptOutStatus),
        });
      }

      const optedOut = await this.options.privacyPreferences.isOptedOut(
        target.canonicalUserId,
        'proactive_dm',
      );
      dmOptOutStatus = optedOut ? 'opted_out' : 'checked_not_opted_out';

      if (optedOut) {
        return this.actionRepo.createExecution({
          actionDecisionId: decision.id,
          actionType: action.type,
          status: 'rejected',
          error: {
            code: 'PROACTIVE_DM_OPT_OUT',
            message: 'User has opted out of proactive DMs',
            recoverable: false,
          },
          auditLevel: 'summary',
          auditEntry: `${this.withDmAuditMetadata(action, dmOptOutStatus)}; proactive_dm_opt_out=true`,
        });
      }
    }

    try {
      const messageId = await this.messageSender.sendMessage(
        {
          conversationId: target.conversationId,
          conversationType: 'private',
          userId: target.userId,
        },
        { text },
      );

      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'success',
        executedMessageId: messageId,
        auditLevel: 'summary',
        auditEntry: this.withDmAuditMetadata(action, dmOptOutStatus),
      });
    } catch (error) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'failed',
        error: {
          code: 'SEND_DM_FAILED',
          message: this.redactErrorMessage(
            error instanceof Error ? error.message : 'Unknown DM send failure',
          ),
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: this.withDmAuditMetadata(action, dmOptOutStatus),
      });
    }
  }

  private async executeReply(
    decision: ActionDecision,
    action: ActionPlan,
  ): Promise<ActionExecutionResult> {
    const target = action.target;
    const text = action.payload?.text?.trim();

    if (!target || !text) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'rejected',
        error: {
          code: 'INVALID_REPLY_ACTION',
          message: 'Reply action requires target and non-empty text',
          recoverable: false,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }

    try {
      const messageId = await this.messageSender.sendMessage(target, { text });
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'success',
        executedMessageId: messageId,
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    } catch (error) {
      return this.actionRepo.createExecution({
        actionDecisionId: decision.id,
        actionType: action.type,
        status: 'failed',
        error: {
          code: 'SEND_MESSAGE_FAILED',
          message: this.redactErrorMessage(
            error instanceof Error ? error.message : 'Unknown send failure',
          ),
          recoverable: true,
        },
        auditLevel: 'summary',
        auditEntry: action.reason,
      });
    }
  }

  private buildJobIdempotencySuffixes(actions: ActionPlan[]): Array<string | undefined> {
    const keys = actions.map((action) => this.jobIdempotencyGroupKey(action));
    const duplicateCounts = new Map<string, number>();
    for (const key of keys) {
      if (key) {
        duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
      }
    }

    const seen = new Map<string, number>();
    return keys.map((key) => {
      if (!key || (duplicateCounts.get(key) ?? 0) <= 1) {
        return undefined;
      }

      const ordinal = (seen.get(key) ?? 0) + 1;
      seen.set(key, ordinal);
      return `:action${ordinal}`;
    });
  }

  private jobIdempotencyGroupKey(action: ActionPlan): string | undefined {
    if (action.type === 'admin_digest') {
      return 'admin_digest';
    }

    if (action.type === 'silent_summarize_later') {
      return 'silent_summarize_later:summary';
    }

    if (action.type === 'schedule_background_task') {
      const taskType = action.payload?.backgroundTask?.type;
      return typeof taskType === 'string' ? `schedule_background_task:${taskType}` : undefined;
    }

    return undefined;
  }

  private groupSummaryTargetError(target: MessageTarget, payload: unknown): string | undefined {
    if (
      target.conversationType !== 'group'
      || this.nonEmptyString(target.conversationId) !== target.conversationId
      || target.groupId === undefined
      || this.nonEmptyString(target.groupId) !== target.groupId
    ) {
      return 'Group summaries require an exact non-empty group and conversation target';
    }

    if (!this.isPlainRecord(payload)) {
      return undefined;
    }
    const expected: Record<string, string> = {
      conversationId: target.conversationId,
      conversationType: 'group',
      groupId: target.groupId,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (payload[field] !== undefined && payload[field] !== value) {
        return `Group summary payload ${field} contradicts the action target`;
      }
    }
    return undefined;
  }

  private groupSummaryTurnSourceError(
    target: MessageTarget,
    turnSource: ActionTurnSource,
  ): string | undefined {
    if (turnSource.conversationType !== 'group' || !turnSource.groupId) {
      return 'Group summary actions require an exact triggering group chat';
    }
    if (
      target.conversationId !== turnSource.conversationId
      || target.groupId !== turnSource.groupId
    ) {
      return 'Group summary target must match the triggering group and conversation';
    }
    return undefined;
  }

  private summaryPayloadClaimsGroup(payload: unknown): boolean {
    return this.isPlainRecord(payload)
      && (payload.conversationType === 'group' || payload.groupId !== undefined);
  }

  private rejectGroupSummaryAction(
    decision: ActionDecision,
    action: ActionPlan,
    message: string,
    code = 'INVALID_GROUP_SUMMARY_ACTION',
    recoverable = false,
  ): Promise<ActionExecutionResult> {
    return this.actionRepo.createExecution({
      actionDecisionId: decision.id,
      actionType: action.type,
      status: 'rejected',
      error: { code, message, recoverable },
      auditLevel: 'summary',
      auditEntry: this.redactActionNarrative(action.reason),
    });
  }

  private handleGroupSummaryEnqueueFailure(
    decision: ActionDecision,
    action: ActionPlan,
    error: unknown,
    fallbackCode: string,
    fallbackMessage: string,
  ): Promise<ActionExecutionResult> {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? Reflect.get(error, 'code')
      : undefined;
    if (
      (error instanceof GroupSummaryPolicyError || errorCode === 'policy_disabled')
      && errorCode === 'policy_disabled'
    ) {
      return this.rejectGroupSummaryAction(
        decision,
        action,
        error instanceof Error ? error.message : 'Group summary policy is disabled.',
        'GROUP_SUMMARY_POLICY_DISABLED',
      );
    }
    if (
      (error instanceof GroupSummaryWindowError || errorCode === 'window_unavailable')
      && errorCode === 'window_unavailable'
    ) {
      return this.rejectGroupSummaryAction(
        decision,
        action,
        error instanceof Error ? error.message : 'No group summary window is available',
        'GROUP_SUMMARY_WINDOW_UNAVAILABLE',
        true,
      );
    }

    return this.actionRepo.createExecution({
      actionDecisionId: decision.id,
      actionType: action.type,
      status: 'failed',
      error: {
        code: fallbackCode,
        message: this.redactErrorMessage(error instanceof Error ? error.message : fallbackMessage),
        recoverable: true,
      },
      auditLevel: 'summary',
      auditEntry: this.redactActionNarrative(action.reason),
    });
  }

  private getGatewayCapabilities(): GatewayCapabilities {
    return this.messageSender.getCapabilities?.() ?? {
      platform: 'qq',
      reactions: { emojiLike: false, faceMessage: false },
      foldedForward: { groupForward: false, privateForward: false, customNode: false },
      platformAdmin: { kick: false, mute: false, setGroupCard: false },
    };
  }

  private isReplyAction(action: ActionPlan): boolean {
    return (
      action.type === 'reply_short' ||
      action.type === 'reply_full' ||
      action.type === 'reply_with_tool' ||
      action.type === 'ask_clarification'
    );
  }

  private getPolicyRejection(
    decision: ActionDecision,
    action: ActionPlan,
  ): { code: string; message: string } | undefined {
    if (this.isNoopAction(action)) {
      return undefined;
    }

    if (decision.riskLevel === 'prohibited') {
      return {
        code: 'PROHIBITED_ACTION_DECISION',
        message: 'Action decision risk level is prohibited',
      };
    }

    const evaluatorRequired =
      decision.evaluatorRequired || action.constraints.evaluatorRequired === true;
    if (evaluatorRequired && decision.evaluatorPassed !== true) {
      return {
        code: 'EVALUATOR_NOT_PASSED',
        message: 'Action requires evaluator approval but decision was not approved',
      };
    }

    return undefined;
  }

  private isNoopAction(action: ActionPlan): boolean {
    return action.type === 'silent_store';
  }

  private redactErrorMessage(message: string): string {
    return this.redactActionNarrative(message);
  }

  private redactActionNarrative(message: string): string {
    const platformRedacted = this.redactPlatformIdentifiers(message);
    const secretRedacted = redactSecretsInText(platformRedacted).text;
    const redacted = this.redactPlatformIdentifiers(secretRedacted);
    const platformMarkerLost =
      platformRedacted.includes('[REDACTED:platform_id]')
      && !redacted.includes('[REDACTED:platform_id]');

    return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
  }

  private redactPlatformIdentifiers(message: string): string {
    return message
      .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
      .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
  }

  private isBackgroundTaskActionType(value: string): value is BackgroundTaskActionType {
    return BACKGROUND_TASK_ACTION_TYPES.includes(value as BackgroundTaskActionType);
  }

  private parseMemoryProposal(
    action: ActionPlan,
    value: unknown,
  ): { ok: true; value: ParsedMemoryProposal } | { ok: false; reason: string } {
    if (!this.isPlainRecord(value)) {
      return { ok: false, reason: 'propose_memory action requires payload.memoryProposal' };
    }

    const scope = this.nonEmptyString(value.scope);
    if (!scope || !this.isMemoryProposalScope(scope)) {
      return { ok: false, reason: 'memoryProposal.scope must be user, group, conversation, or global' };
    }

    const kind = this.nonEmptyString(value.kind);
    if (!kind || !this.isMemoryProposalKind(kind)) {
      return { ok: false, reason: 'memoryProposal.kind is not supported' };
    }

    const title = this.nonEmptyString(value.title);
    const content = this.nonEmptyString(value.content);
    if (!title || !content) {
      return { ok: false, reason: 'memoryProposal.title and memoryProposal.content are required' };
    }

    const confidence = this.unitNumber(value.confidence);
    if (confidence === undefined) {
      return { ok: false, reason: 'memoryProposal.confidence must be a number between 0 and 1' };
    }

    const explicitGroupId = this.nonEmptyString(value.groupId);
    const targetGroupId = action.target?.groupId;
    const groupId = explicitGroupId ?? targetGroupId;
    const conversationId = action.target?.conversationId;
    const canonicalUserId = this.nonEmptyString(value.canonicalUserId);

    if (scope === 'user' && !canonicalUserId) {
      return { ok: false, reason: 'user memory proposals require memoryProposal.canonicalUserId' };
    }

    if (scope === 'group' && !groupId) {
      return { ok: false, reason: 'group memory proposals require memoryProposal.groupId or target.groupId' };
    }

    if (scope === 'conversation' && !conversationId) {
      return {
        ok: false,
        reason: 'conversation memory proposals require target.conversationId',
      };
    }

    return {
      ok: true,
      value: {
        scope,
        canonicalUserId: scope === 'user' ? canonicalUserId : undefined,
        groupId: scope === 'global' ? undefined : groupId,
        conversationId: scope === 'conversation' ? conversationId : undefined,
        visibility: this.defaultMemoryProposalVisibility(scope, groupId, action.target?.conversationType),
        kind,
        title,
        content,
        confidence,
        importance: confidence,
      },
    };
  }

  private memoryProposalActorClass(decision: ActionDecision): ActorClass {
    return decision.decidedBy === 'evaluator' ? 'evaluator' : 'system_worker';
  }

  private isMemoryProposalScope(value: string): value is MemoryProposalScope {
    return MEMORY_PROPOSAL_SCOPES.includes(value as MemoryProposalScope);
  }

  private isMemoryProposalKind(value: string): value is MemoryRecord['kind'] {
    return MEMORY_PROPOSAL_KINDS.includes(value as MemoryRecord['kind']);
  }

  private defaultMemoryProposalVisibility(
    scope: MemoryProposalScope,
    groupId: string | undefined,
    conversationType: MessageTarget['conversationType'] | undefined,
  ): MemoryRecord['visibility'] {
    if (scope === 'global') {
      return 'owner_admin_only';
    }

    if (scope === 'group') {
      return 'same_group_only';
    }

    if (scope === 'conversation') {
      return groupId || conversationType === 'group' ? 'same_group_only' : 'private_only';
    }

    return groupId ? 'same_group_only' : 'private_only';
  }

  private nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  private unitNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : undefined;
  }

  private toBackgroundTaskScheduledAt(value: number | Date | undefined): number | Date | undefined {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value : undefined;
    }

    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private toBackgroundTaskMaxAttempts(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
  }

  private redactActionStructuredValue(value: unknown, path: string[] = []): unknown {
    if (typeof value === 'string') {
      return this.redactActionPayloadText(value);
    }

    if (typeof value === 'number') {
      return this.shouldRedactNumericPlatformId(path, value)
        ? '[REDACTED:platform_id]'
        : value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redactActionStructuredValue(item, path));
    }

    if (this.isPlainRecord(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const redactedKey = this.redactActionPayloadText(key);
        result[redactedKey] = this.redactActionStructuredValue(child, [...path, key]);
      }
      return result;
    }

    return value;
  }

  private toActionPayloadRecord(value: unknown): Record<string, unknown> {
    return this.isPlainRecord(value) ? value : {};
  }

  private redactActionPayloadText(text: string): string {
    const redacted = this.redactActionNarrative(text);
    if (redacted === text) {
      return text;
    }

    const markers = Array.from(redacted.matchAll(/\[REDACTED:[^\]]+\]/g), (match) => match[0]);
    return markers.length > 0 ? Array.from(new Set(markers)).join(' ') : redacted;
  }

  private withDmAuditMetadata(action: ActionPlan, optOutStatus: DmOptOutStatus): string {
    const proactive = action.constraints.proactive === true;
    const trigger = action.constraints.proactiveTrigger ?? 'unspecified';
    const redactionLevel = action.constraints.redactionLevel ?? 'default';
    const cooldownKey = action.constraints.cooldownKey
      ? this.redactActionNarrative(action.constraints.cooldownKey)
      : 'none';

    return [
      this.redactActionNarrative(action.reason),
      `dm_proactive=${proactive}`,
      `dm_trigger=${trigger}`,
      `dm_opt_out=${optOutStatus}`,
      `dm_redaction_level=${redactionLevel}`,
      `dm_cooldown_key=${cooldownKey}`,
    ].join('; ');
  }

  private shouldRedactNumericPlatformId(path: string[], value: number): boolean {
    return Number.isInteger(value)
      && this.isPlatformIdField(path)
      && /^\d{8,12}$/.test(String(Math.abs(value)));
  }

  private isPlatformIdField(path: string[]): boolean {
    const key = path.at(-1);
    if (!key) {
      return false;
    }

    return /(^|_)(?:target|subject|recipient|actor|owner)?[_-]?(user|sender|group|message|conversation|platform|qq)[_-]?ids?$/i.test(key)
      || /^(?:target|subject|recipient|actor|owner)?(?:User|Sender|Group|Message|Conversation|Platform|Qq)Ids?$/i.test(key)
      || /^(userId|senderId|groupId|messageId|conversationId|platformUserId|platformMessageId)$/i.test(key);
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  }
}
