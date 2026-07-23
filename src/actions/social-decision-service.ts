/**
 * Social action decision service.
 *
 * Converts attention + Pi output into a persisted ActionDecision, invoking the
 * evaluator for risk/gray paths and applying cooldown downgrade before
 * execution.
 */

import { ulid } from 'ulidx';
import { isDeepStrictEqual } from 'node:util';
import type { ChatMessageReceived } from '../types/events.js';
import type { ActionDecision, ActionPlan } from '../types/action.js';
import type { AttentionSignals } from '../types/attention.js';
import type { ActorClass, InvocationContext } from '../types/tool.js';
import type { IEvaluator, SocialEvaluationRequest, SocialEvaluationResult } from '../types/evaluator.js';
import {
  ActionRepository,
  sanitizeEvaluatorNarrative,
  type SocialEvaluatorEvidence,
} from './action-repository.js';
import { ActionCooldownManager } from './cooldown.js';
import { applyPassingSocialEvaluation } from './social-evaluation.js';

const STRONG_TRIGGER_REASONS = new Set(['@bot', 'reply_to_bot', 'command']);

class SocialEvaluatorInvocationError extends Error {
  constructor() {
    super('Social evaluator invocation failed');
    this.name = 'SocialEvaluatorInvocationError';
  }
}

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
    const isProactive = input.responseText.trim().length > 0
      && this.isProactiveIntervention(input.event, input.signals);
    const baseActions = this.buildActionPlans(
      input.event,
      input.responseText,
      input.signals,
      input.actor.canonicalUserId,
      isProactive,
    );
    const baseReasons = [
      ...input.signals.triggerReasons,
      input.responseText.trim().length > 0 ? 'pi_response_text' : 'pi_empty_response',
    ];
    const evaluatorRequired = this.requiresEvaluator(input.signals, baseActions);
    let rawEvaluatorEvidence: SocialEvaluatorEvidence | undefined;
    let evaluatorFailed = false;
    if (evaluatorRequired) {
      try {
        rawEvaluatorEvidence = await this.evaluateSocialAction(input, baseActions[0], isProactive);
      } catch (error) {
        if (!(error instanceof SocialEvaluatorInvocationError)) {
          throw error;
        }
        evaluatorFailed = true;
      }
    }

    if (evaluatorFailed) {
      return this.actionRepo.createDecision({
        turnId: input.turnId,
        decidedBy: 'pi',
        actions: baseActions.map((action) => this.toSilentStore(
          action,
          'Evaluator review failed; governed action suppressed',
        )),
        riskLevel: 'medium',
        confidence: input.signals.triggerScore,
        reasons: [...baseReasons, 'evaluator_failure'],
        suppressors: [...input.signals.suppressors, 'evaluator_terminal_failure'],
        evaluatorRequired: true,
        evaluatorPassed: false,
        claimActor: input.actor,
      });
    }

    const evaluatorEvidence = rawEvaluatorEvidence
      ? {
          request: rawEvaluatorEvidence.request,
          result: {
            ...rawEvaluatorEvidence.result,
            reason: sanitizeEvaluatorNarrative(rawEvaluatorEvidence.result.reason),
          },
        }
      : undefined;
    const evaluation = evaluatorEvidence?.result;

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
      reasons: evaluation
        ? [...baseReasons, sanitizeEvaluatorNarrative(`evaluator:${evaluation.reason}`)]
        : baseReasons,
      suppressors,
      evaluatorRequired,
      evaluatorPassed: evaluation
        ? evaluation.decision === 'approve' || evaluation.decision === 'downgrade'
        : undefined,
      evaluatorEvidence,
      claimActor: input.actor,
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
    isProactive: boolean,
  ): Promise<SocialEvaluatorEvidence | undefined> {
    if (!proposedAction) {
      return undefined;
    }

    const request: SocialEvaluationRequest = structuredClone({
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
      isProactive,
    });

    const evaluatorRequest = structuredClone(request);
    let result: SocialEvaluationResult;
    try {
      result = await this.evaluator.evaluateSocial(evaluatorRequest);
    } catch {
      throw new SocialEvaluatorInvocationError();
    }
    if (!isDeepStrictEqual(evaluatorRequest, request)) {
      throw new Error('Social evaluator mutated its request');
    }
    if (result.requestId !== request.requestId) {
      throw new Error('Evaluator result request does not match evaluator request');
    }

    return { request, result: structuredClone(result) };
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
        actions: actions.map((action) => this.toSilentStore(
          action,
          sanitizeEvaluatorNarrative(`Evaluator ${evaluation.decision}: ${evaluation.reason}`),
        )),
        suppressors: [`evaluator_${evaluation.decision}`],
      };
    }

    return applyPassingSocialEvaluation(actions, evaluation);
  }

  private buildActionPlans(
    event: ChatMessageReceived,
    responseText: string,
    signals: AttentionSignals,
    canonicalUserId?: string,
    isProactive: boolean = false,
  ): ActionPlan[] {
    const text = responseText.trim();
    const target = {
      conversationId: event.message.conversationId,
      conversationType: event.message.conversationType,
      userId: event.message.conversationType === 'private' ? event.message.senderId : undefined,
      canonicalUserId: event.message.conversationType === 'private' ? canonicalUserId : undefined,
      groupId: event.message.groupId,
    };

    if (!text) {
      return [
        {
          type: 'silent_store',
          priority: 0,
          target,
          constraints: {
            evaluatorRequired: signals.classification === 'needs_evaluation' || isProactive,
            proactive: isProactive,
          },
          reason: 'Pi returned no outbound response',
        },
      ];
    }

    const actionType = event.message.conversationType === 'private' ? 'reply_full' : 'reply_short';
    const isStrongGroupTrigger = event.message.conversationType === 'group'
      && signals.triggerReasons.some((reason) => STRONG_TRIGGER_REASONS.has(reason));
    const cooldownSeconds = event.message.conversationType === 'group' && !isStrongGroupTrigger ? 60 : 0;

    return [
      {
        type: actionType,
        priority: 100,
        target,
        payload: { text },
        constraints: {
          evaluatorRequired: signals.classification === 'needs_evaluation' || isProactive,
          proactive: isProactive,
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

  private isProactiveIntervention(
    event: ChatMessageReceived,
    signals: AttentionSignals,
  ): boolean {
    return event.message.conversationType === 'group'
      && !event.message.mentionsBot
      && !signals.triggerReasons.includes('reply_to_bot');
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
