/**
 * Social action decision service.
 *
 * Converts attention + Pi output into a persisted ActionDecision, invoking the
 * evaluator for risk/gray paths and applying cooldown downgrade before
 * execution.
 */

import { ulid } from 'ulidx';
import type { ChatMessageReceived } from '../types/events';
import type { ActionDecision, ActionPlan } from '../types/action';
import type { AttentionSignals } from '../types/attention';
import type { ActorClass, InvocationContext } from '../types/tool';
import type { IEvaluator, SocialEvaluationRequest, SocialEvaluationResult } from '../types/evaluator';
import { ActionRepository } from './action-repository';
import { ActionCooldownManager } from './cooldown';

export interface CreateSocialDecisionInput {
  turnId: string;
  rawEventId: string;
  event: ChatMessageReceived;
  responseText: string;
  signals: AttentionSignals;
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
  };
}

export class SocialDecisionService {
  constructor(
    private readonly actionRepo: ActionRepository,
    private readonly evaluator: IEvaluator,
    private readonly cooldowns: ActionCooldownManager,
  ) {}

  async createDecision(input: CreateSocialDecisionInput): Promise<ActionDecision> {
    const baseActions = this.buildActionPlans(input.event, input.responseText, input.signals);
    const baseReasons = [
      ...input.signals.triggerReasons,
      input.responseText.trim().length > 0 ? 'pi_response_text' : 'pi_empty_response',
    ];
    const evaluatorRequired = this.requiresEvaluator(input.signals, baseActions);
    const evaluation = evaluatorRequired
      ? await this.evaluateSocialAction(input, baseActions[0])
      : undefined;

    const evaluated = this.applyEvaluation(baseActions, evaluation);
    const cooldownResult = this.cooldowns.apply(evaluated.actions);
    const suppressors = [
      ...input.signals.suppressors,
      ...evaluated.suppressors,
      ...cooldownResult.suppressors,
    ];

    return this.actionRepo.createDecision({
      turnId: input.turnId,
      decidedBy: evaluation ? 'evaluator' : 'pi',
      actions: cooldownResult.actions,
      riskLevel: evaluation?.riskLevel ?? (evaluatorRequired ? 'medium' : 'low'),
      confidence: evaluation?.confidence ?? input.signals.triggerScore,
      reasons: evaluation ? [...baseReasons, `evaluator:${evaluation.reason}`] : baseReasons,
      suppressors,
      evaluatorRequired,
      evaluatorPassed: evaluation ? evaluation.decision === 'approve' || evaluation.decision === 'downgrade' : true,
    });
  }

  private requiresEvaluator(signals: AttentionSignals, actions: ActionPlan[]): boolean {
    return (
      signals.classification === 'needs_evaluation' ||
      actions.some((action) => action.constraints.evaluatorRequired)
    );
  }

  private async evaluateSocialAction(
    input: CreateSocialDecisionInput,
    proposedAction: ActionPlan | undefined,
  ): Promise<SocialEvaluationResult | undefined> {
    if (!proposedAction) {
      return undefined;
    }

    const request: SocialEvaluationRequest = {
      requestId: ulid(),
      domain: 'social',
      turnId: input.turnId,
      actor: input.actor,
      context: this.toInvocationContext(input.event),
      sourceEventIds: [input.rawEventId],
      contextSummary: this.buildContextSummary(input.event, input.responseText),
      createdAt: new Date(),
      proposedAction,
      attentionSignals: input.signals,
      isProactive: false,
    };

    return this.evaluator.evaluateSocial(request);
  }

  private applyEvaluation(
    actions: ActionPlan[],
    evaluation: SocialEvaluationResult | undefined,
  ): { actions: ActionPlan[]; suppressors: string[] } {
    if (!evaluation) {
      return { actions, suppressors: [] };
    }

    if (evaluation.decision === 'reject' || evaluation.decision === 'propose') {
      return {
        actions: actions.map((action) => this.toSilentStore(action, `Evaluator ${evaluation.decision}: ${evaluation.reason}`)),
        suppressors: [`evaluator_${evaluation.decision}`],
      };
    }

    if (evaluation.decision === 'downgrade' && evaluation.downgradeAction) {
      return {
        actions: actions.map((action) => {
          if (action.type !== evaluation.downgradeAction?.from) {
            return action;
          }
          return {
            ...action,
            type: evaluation.downgradeAction.to,
            reason: evaluation.downgradeAction.reason,
            constraints: {
              ...action.constraints,
              cooldownSeconds: evaluation.cooldownSeconds ?? action.constraints.cooldownSeconds,
            },
          };
        }),
        suppressors: [`evaluator_downgrade:${evaluation.downgradeAction.from}->${evaluation.downgradeAction.to}`],
      };
    }

    return {
      actions: evaluation.modifiedAction ? [evaluation.modifiedAction] : actions,
      suppressors: [],
    };
  }

  private buildActionPlans(
    event: ChatMessageReceived,
    responseText: string,
    signals: AttentionSignals,
  ): ActionPlan[] {
    const text = responseText.trim();
    const target = {
      conversationId: event.message.conversationId,
      conversationType: event.message.conversationType,
      userId: event.message.conversationType === 'private' ? event.message.senderId : undefined,
      groupId: event.message.groupId,
    };

    if (!text) {
      return [
        {
          type: 'silent_store',
          priority: 0,
          target,
          constraints: {
            evaluatorRequired: signals.classification === 'needs_evaluation',
          },
          reason: 'Pi returned no outbound response',
        },
      ];
    }

    const actionType = event.message.conversationType === 'private' ? 'reply_full' : 'reply_short';
    const cooldownSeconds = event.message.conversationType === 'group' ? 60 : 0;

    return [
      {
        type: actionType,
        priority: 100,
        target,
        payload: { text },
        constraints: {
          evaluatorRequired: signals.classification === 'needs_evaluation',
          cooldownKey: `${event.message.conversationType}:${event.message.conversationId}:${actionType}`,
          cooldownSeconds,
          maxResponseTokens: event.message.conversationType === 'private' ? 1024 : 256,
          redactionLevel: event.message.conversationType === 'private' ? 'light' : 'strict',
        },
        reason: 'Pi produced response text',
      },
    ];
  }

  private toSilentStore(action: ActionPlan, reason: string): ActionPlan {
    return {
      type: 'silent_store',
      priority: action.priority,
      target: action.target,
      constraints: action.constraints,
      reason,
    };
  }

  private toInvocationContext(event: ChatMessageReceived): InvocationContext {
    return event.message.conversationType === 'private' ? 'private_chat' : 'group_chat';
  }

  private buildContextSummary(event: ChatMessageReceived, responseText: string): string {
    const inputText = event.message.content.text ?? '';
    return [
      `conversation_type=${event.message.conversationType}`,
      `mentions_bot=${event.message.mentionsBot}`,
      `sender_role=${event.message.senderRole ?? 'unknown'}`,
      `message=${inputText.slice(0, 500)}`,
      `proposed_response=${responseText.slice(0, 500)}`,
    ].join('\n');
  }
}
