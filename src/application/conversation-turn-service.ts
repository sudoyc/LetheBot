import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import {
  IdentityRepository,
  InactivePlatformAccountError,
} from '../storage/identity-repository.js';
import { ContextTraceRepository } from '../storage/context-trace-repository.js';
import { TurnRepository } from '../storage/turn-repository.js';
import { ActionRepository } from '../actions/action-repository.js';
import { ActionExecutor } from '../actions/executor.js';
import { SocialDecisionService } from '../actions/social-decision-service.js';
import { AttentionEngine } from '../attention/engine.js';
import { DelayedAttentionService } from '../attention/delayed-attention-service.js';
import { ContextBuilder } from '../context/builder.js';
import { buildSystemPrompt } from '../context/persona.js';
import { GovernanceService } from '../governance/service.js';
import { parseQqGovernanceCommand } from '../governance/qq-command.js';
import { TurnDeadlineExceededError } from '../pi/turn-admission-controller.js';
import { isAutomaticExtractionCandidate } from '../workers/memory-extraction.js';
import type { EnqueueTaskInput } from '../workers/background.js';
import type { PiAdapterInput, PiAdapterOutput } from '../pi/pi-adapter.js';
import type { ActionDecision, ActionExecutionResult } from '../types/action.js';
import type { AttentionSignals } from '../types/attention.js';
import type { ChatMessageReceived } from '../types/events.js';
import type {
  RecordEventProcessingFailureInput,
  TurnApplicationOutcome,
} from './turn-application-service.js';

export interface PiRuntime {
  runTurn(input: PiAdapterInput): Promise<PiAdapterOutput>;
  usesDurableInvocationLedger?: boolean;
}

export interface ConversationTurnServiceOptions {
  db: Database.Database;
  identityRepository: IdentityRepository;
  contextTraceRepository: ContextTraceRepository;
  turnRepository: TurnRepository;
  actionRepository: ActionRepository;
  attentionEngine: AttentionEngine;
  delayedAttentionService: DelayedAttentionService;
  contextBuilder: ContextBuilder;
  governanceService: GovernanceService;
  enqueueBackgroundTask(task: EnqueueTaskInput): string;
  piProvider: string;
  piModel: string;
  botOwnerQqId?: string;
  getPiRuntime(): PiRuntime;
  getActionExecutor(): ActionExecutor;
  getSocialDecisionService(): SocialDecisionService;
  redactSensitiveText(text: string): string;
  recordEventProcessingFailure(input: RecordEventProcessingFailureInput): void;
  logger: Logger;
}

export interface HandleConversationTurnOptions {
  sourceAlreadyPersisted?: boolean;
  signals?: AttentionSignals;
  deadlineAtMs?: number;
}

export class ConversationTurnService {
  constructor(private readonly options: ConversationTurnServiceOptions) {}

  async handleEvent(
    event: ChatMessageReceived,
    rawEventId: string,
    options: HandleConversationTurnOptions = {},
  ): Promise<TurnApplicationOutcome> {
    let turnId: string | undefined;
    let turnFinalized = false;
    let currentStage = 'identity_resolution';

    try {
      this.assertTurnDeadline(options.deadlineAtMs, currentStage);
      this.options.logger.info({
        type: event.type,
        conversationId: event.conversationId,
        senderId: event.message.senderId,
      }, 'Processing event');

      currentStage = 'identity_resolution';
      const senderId = event.message.senderId.replace('qq-', '');
      const canonicalUserId = await this.resolveIdentity(senderId);
      if (!canonicalUserId) {
        return 'completed';
      }

      this.assertTurnDeadline(options.deadlineAtMs, currentStage);

      if (!options.sourceAlreadyPersisted) {
        currentStage = 'display_metadata';
        await this.recordDisplayMetadata(event, canonicalUserId);
      }

      const parsedGovernanceCommand = parseQqGovernanceCommand(
        event.message.content.text ?? '',
      );
      if (parsedGovernanceCommand.status !== 'not_command') {
        if (options.sourceAlreadyPersisted) {
          this.options.logger.debug('Stored governance command is not replayed through delayed Attention');
          return 'completed';
        }

        currentStage = 'chat_message_store';
        this.storeChatMessage(event, rawEventId, false);

        currentStage = 'turn_create';
        const conversationId = event.conversationId ?? event.message.conversationId;
        turnId = await this.options.turnRepository.createPending({
          conversationId,
          triggerEventId: rawEventId,
          piModel: 'qq-governance-v1',
          piProvider: 'local',
        });
        const governanceTurnId = turnId;

        currentStage = 'governance_command';
        this.assertTurnDeadline(options.deadlineAtMs, currentStage);
        const actionType = event.message.conversationType === 'group'
          ? 'reply_short'
          : 'reply_full';
        const persistGovernanceEffectAndDecision = this.options.db.transaction(() => {
          const governanceResult = this.options.governanceService.handleQqCommandSync({
            sourceEventId: rawEventId,
            ...(this.options.botOwnerQqId === undefined
              ? {}
              : { botOwnerQqId: this.options.botOwnerQqId }),
          });
          if (!governanceResult) {
            throw new Error('Governance command verification mismatch');
          }

          const actionDecision = this.options.actionRepository.createDecisionSync({
            turnId: governanceTurnId,
            decidedBy: 'attention',
            actions: [
              {
                type: actionType,
                priority: 100,
                target: {
                  conversationId,
                  conversationType: event.message.conversationType,
                  ...(event.message.conversationType === 'group'
                    ? { groupId: event.message.groupId }
                    : {
                        userId: event.message.senderId,
                        canonicalUserId,
                      }),
                },
                payload: { text: governanceResult.responseText },
                constraints: {
                  evaluatorRequired: false,
                  redactionLevel: 'strict',
                  proactive: false,
                },
                reason: 'Deterministic QQ governance command',
              },
            ],
            riskLevel: 'low',
            confidence: 1,
            reasons: ['Deterministic QQ governance command'],
            suppressors: [],
            evaluatorRequired: false,
            claimActor: { canonicalUserId },
          });
          return { governanceResult, actionDecision };
        });
        const {
          governanceResult,
          actionDecision,
        } = persistGovernanceEffectAndDecision.immediate();

        currentStage = 'action_execution';
        this.assertTurnDeadline(options.deadlineAtMs, currentStage);
        const actionResults = await this.options.getActionExecutor().execute(actionDecision);
        const successfulReply = this.findSuccessfulReplyExecution(actionResults);
        const deliveredReplyText = successfulReply
          ? this.getDeliveredReplyText(
              actionDecision,
              successfulReply,
              governanceResult.responseText,
            )
          : undefined;

        if (successfulReply && deliveredReplyText && deliveredReplyText.trim().length > 0) {
          const completedTurnId = turnId;
          this.options.db.transaction(() => {
            currentStage = 'bot_response_persist';
            this.storeBotResponse(
              conversationId,
              event.message.conversationType,
              deliveredReplyText,
              event.message.groupId,
              successfulReply.executed?.messageId,
            );

            currentStage = 'turn_complete';
            this.options.turnRepository.markCompleted(completedTurnId, {
              responseText: deliveredReplyText,
              tokensUsed: { input: 0, output: 0, total: 0 },
            });
          })();
          turnFinalized = true;
        } else {
          currentStage = 'turn_complete';
          this.options.turnRepository.markCompleted(turnId, {
            responseText: governanceResult.responseText,
            tokensUsed: { input: 0, output: 0, total: 0 },
          });
          turnFinalized = true;
        }

        return 'completed';
      }

      const hasNormalizedContent = Boolean(event.message.content.text?.trim())
        || (event.message.content.media?.length ?? 0) > 0
        || event.message.content.quote !== undefined
        || (event.message.mentions?.length ?? 0) > 0
        || event.message.mentionsBot
        || event.message.replyToMessageId !== undefined;
      let signals = options.signals;
      if (hasNormalizedContent && !signals) {
        try {
          currentStage = 'attention_analysis';
          signals = this.options.attentionEngine.analyze({
            conversationType: event.message.conversationType,
            mentionsBot: event.message.mentionsBot,
            text: event.message.content.text ?? '',
            senderId: event.message.senderId,
            senderRole: event.message.senderRole,
            replyToBot: this.isReplyToStoredBotMessage(event),
          });

          this.options.logger.debug({ signals }, 'Attention analysis');
        } catch (error) {
          this.options.logger.error({
            error: error instanceof Error ? {
              message: error.message,
              stack: error.stack,
              name: error.name,
            } : error,
            step: 'attention_analysis',
            eventType: event.type,
            conversationId: event.conversationId,
          }, 'Attention analysis failed');
          throw error;
        }
      }

      if (!options.sourceAlreadyPersisted) {
        const shouldEnqueueExtraction = isAutomaticExtractionCandidate({
          text: event.message.content.text ?? '',
          conversationType: event.message.conversationType,
        });
        currentStage = signals?.classification === 'defer'
          ? 'delayed_attention_persist'
          : 'chat_message_store';
        this.options.db.transaction(() => {
          this.storeChatMessage(event, rawEventId, false);
          if (shouldEnqueueExtraction) {
            currentStage = 'memory_extraction_enqueue';
            this.options.enqueueBackgroundTask({
              type: 'extraction',
              payload: {
                sourceChatMessageId: rawEventId,
                targetUserId: canonicalUserId,
              },
              idempotencyKey: `extraction:auto:${rawEventId}`,
              maxAttempts: 3,
            });
          }
          if (signals?.classification === 'defer') {
            currentStage = 'delayed_attention_persist';
            this.options.delayedAttentionService.enqueueCandidate({ sourceRawEventId: rawEventId });
          }
        }).immediate();
      }

      if (!hasNormalizedContent) {
        this.options.logger.debug('Event has no normalized message content, skipping');
        return 'completed';
      }
      if (!signals) {
        throw new Error('Attention signals are required for normalized message content');
      }
      if (signals.classification === 'defer') {
        this.options.logger.debug('Event deferred for delayed Attention recheck');
        return 'completed';
      }

      if (signals.classification === 'silent') {
        this.options.logger.debug('Event classified as silent, skipping');
        return 'completed';
      }

      currentStage = 'turn_create';
      this.assertTurnDeadline(options.deadlineAtMs, currentStage);
      turnId = await this.options.turnRepository.createPending({
        conversationId: event.conversationId ?? event.message.conversationId,
        triggerEventId: rawEventId,
        piModel: this.options.piModel,
        piProvider: this.options.piProvider,
      });

      const groupId = event.message.groupId;

      let context;
      try {
        currentStage = 'context_building';
        context = await this.options.contextBuilder.buildContext({
          turnId,
          conversationId: event.conversationId ?? event.message.conversationId,
          conversationType: event.message.conversationType,
          recentMessages: [
            {
              messageId: rawEventId,
              senderId: event.message.senderId,
              text: event.message.content.text ?? '',
              timestamp: event.timestamp,
              senderDisplayName: event.message.senderDisplayName ?? event.message.senderId,
              isFromBot: false,
              ...(event.message.senderRole ? { senderRole: event.message.senderRole } : {}),
            },
          ],
          currentMessageId: rawEventId,
          ...(event.message.replyToMessageId
            ? { replyToMessageId: event.message.replyToMessageId }
            : {}),
          targetUserId: canonicalUserId,
          groupId,
        });

        await this.options.contextTraceRepository.createFromContext(context);
        await this.options.turnRepository.markRunning(turnId, context.id);

        this.options.logger.debug({
          memoryCount: context.memory.retrievedFacts.length,
          tokenBudget: context.tokenBudget,
        }, 'Context built');
      } catch (error) {
        this.options.logger.error({
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          } : error,
          step: 'context_building',
          canonicalUserId,
          groupId,
          conversationId: event.conversationId,
        }, 'Context building failed');
        throw error;
      }

      let piResult;
      try {
        currentStage = 'pi_inference';
        this.assertTurnDeadline(options.deadlineAtMs, currentStage);
        const systemPrompt = buildSystemPrompt({
          conversationType: event.message.conversationType,
          hasMemorySystem: true,
        });

        piResult = await this.options.getPiRuntime().runTurn({
          contextPack: context,
          systemPrompt,
          actor: {
            canonicalUserId,
            actorClass: 'user',
            ...(groupId ? { groupId } : {}),
          },
          invocationContext: event.message.conversationType === 'private' ? 'private_chat' : 'group_chat',
          turnId,
          sourceEventIds: [rawEventId],
          ...(options.deadlineAtMs === undefined ? {} : { deadlineAtMs: options.deadlineAtMs }),
        });

        this.options.logger.debug({
          responseLength: piResult.responseText?.length ?? 0,
          toolCallCount: piResult.toolCallIds.length,
          status: piResult.status,
        }, 'Pi response');
      } catch (error) {
        this.options.logger.error({
          error: this.redactErrorForLog(error),
          step: 'pi_inference',
          canonicalUserId,
          conversationId: event.conversationId,
        }, 'Pi inference failed');
        throw error;
      }

      if (piResult.status !== 'completed') {
        await this.options.turnRepository.markFailed(
          turnId,
          piResult.errorMessage ?? `Pi turn ended with status: ${piResult.status}`,
        );
        turnFinalized = true;
        return 'failed';
      }

      currentStage = 'social_decision';
      this.assertTurnDeadline(options.deadlineAtMs, currentStage);
      const responseText = piResult.responseText ?? '';
      const actionDecision = await this.options.getSocialDecisionService().createDecision({
        turnId,
        rawEventId,
        event,
        responseText,
        signals,
        actor: {
          canonicalUserId,
          actorClass: event.message.conversationType === 'group'
            && (event.message.senderRole === 'owner' || event.message.senderRole === 'admin')
            ? 'group_admin'
            : 'user',
        },
      });
      currentStage = 'action_execution';
      this.assertTurnDeadline(options.deadlineAtMs, currentStage);
      const actionResults = await this.options.getActionExecutor().execute(actionDecision);
      const successfulReply = this.findSuccessfulReplyExecution(actionResults);
      const deliveredReplyText = successfulReply
        ? this.getDeliveredReplyText(actionDecision, successfulReply, responseText)
        : undefined;

      if (successfulReply && deliveredReplyText && deliveredReplyText.trim().length > 0) {
        try {
          this.options.logger.info({
            conversationId: event.conversationId,
            responseLength: deliveredReplyText.length,
            actionDecisionId: actionDecision.id,
            actionExecutionId: successfulReply.id,
          }, 'Response action executed');

          if (!turnId) {
            throw new Error('Turn identity is required before post-action persistence');
          }
          const completedTurnId = turnId;
          this.options.db.transaction(() => {
            currentStage = 'bot_response_persist';
            this.storeBotResponse(
              event.conversationId ?? event.message.conversationId,
              event.message.conversationType,
              deliveredReplyText,
              event.message.groupId,
              successfulReply.executed?.messageId,
            );

            currentStage = 'turn_complete';
            this.markTurnCompletedFromRuntime(
              completedTurnId,
              responseText,
              piResult.tokensUsed,
            );
          })();
          turnFinalized = true;
        } catch (error) {
          this.options.logger.error({
            error: error instanceof Error ? {
              message: error.message,
              stack: error.stack,
              name: error.name,
            } : error,
            step: currentStage,
            conversationType: event.message.conversationType,
            conversationId: event.conversationId,
            senderId: event.message.senderId,
            groupId: event.message.groupId,
            responseLength: responseText.length,
          }, 'Failed to persist post-action side effects');
          throw error;
        }
      }

      if (!turnFinalized) {
        currentStage = 'turn_complete';
        this.markTurnCompletedFromRuntime(turnId, responseText, piResult.tokensUsed);
        turnFinalized = true;
      }
      return 'completed';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const redactedErrorMessage = this.options.redactSensitiveText(errorMessage);

      if (turnId && !turnFinalized) {
        try {
          await this.options.turnRepository.markFailed(turnId, redactedErrorMessage);
          turnFinalized = true;
        } catch (markFailedError) {
          this.options.logger.error({
            error: this.redactErrorForLog(markFailedError),
            turnId,
          }, 'Failed to mark agent turn as failed');
        }
      }

      this.options.recordEventProcessingFailure({
        event,
        rawEventId,
        turnId,
        stage: currentStage,
        error,
        ...(error instanceof TurnDeadlineExceededError
          ? { outcomeCode: error.code }
          : {}),
      });

      this.options.logger.error({
        error: this.redactErrorForLog(error),
        event: {
          type: event.type,
          conversationId: event.conversationId,
          senderId: event.message.senderId,
          conversationType: event.message.conversationType,
          messageId: event.message.messageId,
          timestamp: event.timestamp,
        },
      }, 'Failed to handle event');
      return 'failed';
    }
  }

  private markTurnCompletedFromRuntime(
    turnId: string,
    responseText: string,
    tokensUsed: PiAdapterOutput['tokensUsed'],
  ): void {
    if (this.options.getPiRuntime().usesDurableInvocationLedger === true) {
      this.options.turnRepository.markCompletedFromPiInvocations(turnId, { responseText });
      return;
    }

    this.options.turnRepository.markCompleted(turnId, { responseText, tokensUsed });
  }

  private async resolveIdentity(platformUserId: string): Promise<string | null> {
    try {
      const canonicalUserId = await this.options.identityRepository.getOrCreateCanonicalUser(
        'qq',
        platformUserId,
      );
      this.options.logger.debug({ canonicalUserId }, 'Resolved user identity');
      return canonicalUserId;
    } catch (error) {
      if (error instanceof InactivePlatformAccountError) {
        this.options.logger.info({
          platform: 'qq',
          accountStatus: error.status,
        }, 'Inactive platform account denied');
        return null;
      }

      this.options.logger.error({ error, platformUserId }, 'Failed to resolve identity');
      throw error;
    }
  }

  private storeChatMessage(
    event: ChatMessageReceived,
    rawEventId: string,
    isFromBot: boolean = false,
  ): void {
    this.options.db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, group_id, sender_id, sender_role,
        text, has_media, has_quote, mentions_bot,
        reply_to_message_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      rawEventId,
      event.message.messageId,
      event.conversationId,
      event.message.conversationType,
      event.message.groupId || null,
      event.message.senderId,
      event.message.senderRole || null,
      event.message.content.text || '',
      (event.message.content.media?.length ?? 0) > 0 ? 1 : 0,
      event.message.content.quote ? 1 : 0,
      event.message.mentionsBot ? 1 : 0,
      event.message.replyToMessageId || null,
      new Date(event.timestamp).getTime(),
    );

    this.options.logger.debug({ messageId: event.id, rawEventId, isFromBot }, 'Chat message stored');
  }

  private async recordDisplayMetadata(
    event: ChatMessageReceived,
    canonicalUserId: string,
  ): Promise<void> {
    const displayName = event.message.senderCard ?? event.message.senderDisplayName;
    if (!displayName) {
      return;
    }
    const safeDisplayName = this.options.redactSensitiveText(displayName);

    const sourceGroupId = event.message.conversationType === 'group'
      ? event.message.groupId
      : undefined;
    const existing = await this.options.identityRepository.getDisplayProfile(
      canonicalUserId,
      sourceGroupId,
    );

    await this.options.identityRepository.upsertDisplayProfile({
      canonicalUserId,
      sourceGroupId,
      currentDisplayName: safeDisplayName,
      trust: 'platform_provided',
    });

    if (!existing || existing.currentDisplayName !== safeDisplayName) {
      await this.options.identityRepository.recordNicknameHistory(
        canonicalUserId,
        safeDisplayName,
        sourceGroupId,
      );
    }
  }

  private storeBotResponse(
    conversationId: string,
    conversationType: 'private' | 'group',
    text: string,
    groupId?: string,
    sentMessageId?: string,
  ): void {
    const rawEventId = `evt-bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const messageId = sentMessageId ?? `msg-bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    this.options.db.transaction(() => {
      this.options.db.prepare(`
        INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawEventId,
        'bot.response',
        Date.now(),
        'agent',
        'qq',
        conversationId,
        JSON.stringify({ messageId, conversationId, conversationType, groupId, text }),
        Date.now(),
      );

      this.options.db.prepare(`
        INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id,
          conversation_type, group_id, sender_id, text,
          has_media, has_quote, mentions_bot, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        rawEventId,
        messageId,
        conversationId,
        conversationType,
        groupId ?? null,
        'bot-self',
        text,
        0,
        0,
        0,
        Date.now(),
      );
    })();

    this.options.logger.debug({ messageId, rawEventId }, 'Bot response stored');
  }

  private findSuccessfulReplyExecution(
    results: ActionExecutionResult[],
  ): ActionExecutionResult | undefined {
    return results.find((result) => {
      if (!result.executed?.messageId) {
        return false;
      }

      if (
        result.status === 'success' &&
        (result.actionType === 'reply_short' ||
          result.actionType === 'reply_full' ||
          result.actionType === 'reply_with_tool' ||
          result.actionType === 'ask_clarification')
      ) {
        return true;
      }

      return result.status === 'downgraded' && (
        result.actionType === 'send_folded_forward' ||
        result.actionType === 'react_only'
      );
    });
  }

  private getDeliveredReplyText(
    decision: ActionDecision,
    execution: ActionExecutionResult,
    fallbackText: string,
  ): string {
    const actionText = decision.actions.find((action) => {
      return action.type === execution.actionType && action.payload?.text?.trim();
    })?.payload?.text?.trim();
    const reactionText = execution.actionType === 'react_only'
      ? decision.actions.find((action) => action.type === 'react_only' && action.payload?.reaction?.trim())
        ?.payload?.reaction?.trim()
      : undefined;

    return actionText ?? reactionText ?? fallbackText;
  }

  private isReplyToStoredBotMessage(event: ChatMessageReceived): boolean {
    const replyToMessageId = event.message.replyToMessageId;
    if (!replyToMessageId) {
      return false;
    }

    const row = this.options.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM chat_messages
         WHERE message_id = ?
           AND conversation_id = ?
           AND conversation_type = ?
           AND sender_id = 'bot-self'`
      )
      .get(
        replyToMessageId,
        event.conversationId ?? event.message.conversationId,
        event.message.conversationType,
      ) as { count: number } | undefined;

    return (row?.count ?? 0) > 0;
  }

  private assertTurnDeadline(deadlineAtMs: number | undefined, stage: string): void {
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
      throw new TurnDeadlineExceededError(stage);
    }
  }

  private redactErrorForLog(error: unknown): unknown {
    if (error instanceof Error) {
      return {
        message: this.options.redactSensitiveText(error.message),
        stack: error.stack ? this.options.redactSensitiveText(error.stack) : undefined,
        name: error.name,
      };
    }

    if (typeof error === 'string') {
      return this.options.redactSensitiveText(error);
    }

    return error;
  }
}
