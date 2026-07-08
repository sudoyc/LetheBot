/**
 * Action executor / response router skeleton.
 *
 * Converts approved ActionPlans into platform side effects while persisting
 * execution results. Broader memory/tool/background actions are intentionally
 * rejected here until their dedicated governed executors are wired.
 */

import type { MessageContent, MessageTarget } from '../gateway/adapter';
import { redactSecretsInText } from '../memory/secret-scan';
import type { ActionDecision, ActionExecutionResult, ActionPlan } from '../types/action';
import type { PrivacyPreferenceRepository } from '../storage/privacy-preference-repository';
import { ActionRepository } from './action-repository';

export interface MessageSender {
  sendMessage(target: MessageTarget, content: MessageContent): Promise<string>;
}

export interface ActionExecutorOptions {
  privacyPreferences?: Pick<PrivacyPreferenceRepository, 'isOptedOut'>;
}

export class ActionExecutor {
  constructor(
    private readonly actionRepo: ActionRepository,
    private readonly messageSender: MessageSender,
    private readonly options: ActionExecutorOptions = {},
  ) {}

  async execute(decision: ActionDecision): Promise<ActionExecutionResult[]> {
    const actions = [...decision.actions].sort((a, b) => b.priority - a.priority);
    const results: ActionExecutionResult[] = [];

    for (const action of actions) {
      results.push(await this.executeAction(decision, action));
    }

    return results;
  }

  private async executeAction(
    decision: ActionDecision,
    action: ActionPlan,
  ): Promise<ActionExecutionResult> {
    if (this.isReplyAction(action)) {
      return this.executeReply(decision, action);
    }

    if (action.type === 'dm_user') {
      return this.executeDirectMessage(decision, action);
    }

    if (action.type === 'silent_store' || action.type === 'silent_summarize_later') {
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

  private async executeDirectMessage(
    decision: ActionDecision,
    action: ActionPlan,
  ): Promise<ActionExecutionResult> {
    const target = action.target;
    const text = action.payload?.text?.trim();

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
        auditEntry: action.reason,
      });
    }

    if (
      action.constraints.proactive === true &&
      this.options.privacyPreferences &&
      await this.options.privacyPreferences.isOptedOut(target.userId, 'proactive_dm')
    ) {
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
        auditEntry: `${action.reason}; proactive_dm_opt_out=true`,
      });
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
        auditEntry: action.reason,
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
        auditEntry: action.reason,
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

  private isReplyAction(action: ActionPlan): boolean {
    return (
      action.type === 'reply_short' ||
      action.type === 'reply_full' ||
      action.type === 'ask_clarification'
    );
  }

  private redactErrorMessage(message: string): string {
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
}
