/**
 * Summary Worker
 *
 * 后台会话摘要生成工作器
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { PiAdapterInput, PiAdapterOutput } from '../pi/pi-adapter.js';
import type { BuildContextInput } from '../context/builder.js';
import type { BackgroundTaskExecutionContext } from './background.js';
import type { MemoryRepository } from '../storage/memory-repository.js';
import {
  GroupSummaryPolicyError,
  GroupSummaryPolicyRepository,
} from '../storage/group-summary-policy-repository.js';
import { ModelInvocationRepository } from '../storage/model-invocation-repository.js';
import type { ContextPack, RecentMessage } from '../types/context.js';
import type { MemoryRecord } from '../types/memory.js';
import { getLogger } from '../logger/index.js';
import { redactSecretsInText } from '../memory/secret-scan.js';

const logger = getLogger();

/**
 * 会话摘要输入
 */
export interface ConversationSummaryInput {
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId?: string;
  messageRange?: { start: string; end: string };
  timeRange?: { startTime: number; endTime: number };
  sourceChatMessageIds?: string[];
}

export interface PlanGroupSummaryWindowInput {
  conversationId: string;
  groupId: string;
  eligibleAfter: number;
}

export interface PlannedGroupSummaryWindow {
  sourceChatMessageIds: string[];
  candidateCount: number;
}

/**
 * 会话摘要输出
 */
export interface ConversationSummaryOutput {
  summaryId: string;
  conversationId: string;
  summary: string;
  messageCount: number;
  timeRange: { startTime: number; endTime: number };
  confidence: number;
  extractedFacts: string[];
}

/**
 * 摘要配置
 */
export interface SummaryPiRuntime {
  runTurn(input: PiAdapterInput): Promise<PiAdapterOutput>;
}

export interface SummaryContextBuilder {
  build(input: BuildContextInput): Promise<ContextPack>;
}

export interface SummaryConfig {
  maxMessagesToSummarize: number;
  minMessagesToTrigger: number;
  summaryPromptTemplate: string;
  targetTokenBudget: number;
  piProvider: string;
  piModel: string;
  requireDurableExecution: boolean;
}

/**
 * 会话消息记录
 */
interface ChatMessage {
  id: string;
  rawEventId: string;
  conversationId: string;
  senderId: string;
  text: string | null;
  timestamp: number;
  rawCreatedAt: number;
  isFromBot: boolean;
}

interface GroupSummaryAuthorization {
  groupId: string;
  conversationId: string;
  generation: number;
  eligibleAfter: number;
  execution?: BackgroundTaskExecutionContext;
}

interface PreparedSummaryContext {
  contextPack: ContextPack;
  sourceMessages: ChatMessage[];
}

interface SummaryModelResult {
  summary: string;
  facts: string[];
  tokensUsed: PiAdapterOutput['tokensUsed'];
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: SummaryConfig = {
  maxMessagesToSummarize: 50,
  minMessagesToTrigger: 10,
  summaryPromptTemplate:
    'Summarize the following conversation. Extract key facts, topics, and important information. Keep it concise under {targetTokenBudget} tokens.',
  targetTokenBudget: 200,
  piProvider: 'unknown',
  piModel: 'unknown',
  requireDurableExecution: false,
};

const SUMMARY_SYSTEM_PROMPT =
  'You are a conversation summarizer. Extract key information and provide concise summaries.';

/**
 * 会话摘要工作器
 */
export class SummaryWorker {
  private config: SummaryConfig;
  private readonly modelInvocationRepo: ModelInvocationRepository;
  private readonly groupSummaryPolicies: GroupSummaryPolicyRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly piAdapter: SummaryPiRuntime,
    private readonly memoryRepo: MemoryRepository,
    private readonly contextBuilder: SummaryContextBuilder,
    config?: Partial<SummaryConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.modelInvocationRepo = new ModelInvocationRepository(db);
    this.groupSummaryPolicies = new GroupSummaryPolicyRepository(db);
  }

  /**
   * 生成会话摘要
   */
  async generateSummary(
    input: ConversationSummaryInput,
    execution?: BackgroundTaskExecutionContext,
  ): Promise<ConversationSummaryOutput | null> {
    logger.info(
      {
        conversationId: input.conversationId,
        conversationType: input.conversationType,
      },
      'Starting summary generation'
    );

    try {
      this.validateConversationBoundary(input);
      const groupAuthorization = this.captureGroupSummaryAuthorization(input, execution);
      if (
        execution
        && input.conversationType === 'group'
        && input.sourceChatMessageIds === undefined
      ) {
        throw new GroupSummaryPolicyError(
          'job_binding_mismatch',
          'Durable group summary jobs require a frozen source window.',
        );
      }

      // Step 1: 加载消息
      const messages = await this.loadMessages(input, groupAuthorization?.eligibleAfter);

      if (messages.length === 0) {
        logger.warn(
          { conversationId: input.conversationId },
          'No messages found for conversation'
        );
        return null;
      }

      const hasExplicitRange = Boolean(
        input.messageRange || input.timeRange || input.sourceChatMessageIds,
      );

      if (!hasExplicitRange && messages.length < this.config.minMessagesToTrigger) {
        logger.info(
          {
            conversationId: input.conversationId,
            messageCount: messages.length,
            minRequired: this.config.minMessagesToTrigger,
          },
          'Message count below threshold, skipping summary'
        );
        return null;
      }

      logger.debug(
        {
          conversationId: input.conversationId,
          messageCount: messages.length,
        },
        'Messages loaded successfully'
      );

      const preparedContext = await this.prepareSummaryContext(messages, input);
      const selectedMessages = preparedContext.sourceMessages;
      if (
        input.conversationType === 'group'
        && input.sourceChatMessageIds
        && !this.sameOrderedIds(
          selectedMessages.map((message) => message.id),
          input.sourceChatMessageIds,
        )
      ) {
        throw new GroupSummaryPolicyError(
          'job_binding_mismatch',
          'Frozen group summary sources changed during context preparation.',
        );
      }
      const timeRange = this.calculateTimeRange(selectedMessages);
      const confidence = this.calculateConfidence(selectedMessages.length);
      const existingSummary = await this.findExistingSummaryMemory(input, selectedMessages);
      if (existingSummary) {
        this.assertGroupSummaryAuthorization(input, groupAuthorization);
        if (existingSummary.state !== 'active') {
          logger.info(
            {
              conversationId: input.conversationId,
              summaryId: existingSummary.id,
              state: existingSummary.state,
              messageCount: selectedMessages.length,
            },
            'Summary window already has a non-active governed memory'
          );
          return null;
        }

        logger.info(
          {
            conversationId: input.conversationId,
            summaryId: existingSummary.id,
            messageCount: selectedMessages.length,
          },
          'Existing summary found for message window'
        );
        return this.outputFromExistingSummary(existingSummary, input, selectedMessages, timeRange);
      }

      if (this.config.requireDurableExecution && !execution) {
        throw new Error('Summary Provider execution requires durable job-attempt context');
      }
      this.assertGroupSummaryAuthorization(input, groupAuthorization);
      const modelContextId = execution
        ? this.modelInvocationRepo.createContext(
            preparedContext.contextPack,
            execution.jobAttemptId,
            'summary',
          )
        : undefined;

      // Step 2: 调用 LLM 生成摘要
      const summaryResult = await this.callLLM(
        preparedContext.contextPack,
        input,
        selectedMessages.map((message) => message.rawEventId),
        execution,
        modelContextId,
        groupAuthorization,
      );

      if (!summaryResult) {
        logger.error(
          { conversationId: input.conversationId },
          'Failed to generate summary from LLM'
        );
        throw new Error('LLM returned empty response');
      }

      // Step 3: 存储摘要为记忆记录
      const summaryId = await this.storeSummaryAsMemory(
        input,
        summaryResult.summary,
        summaryResult.facts,
        selectedMessages,
        timeRange,
        confidence,
        groupAuthorization,
      );

      logger.info(
        {
          conversationId: input.conversationId,
          summaryId,
          messageCount: selectedMessages.length,
        },
        'Summary generation completed'
      );

      return {
        summaryId,
        conversationId: input.conversationId,
        summary: summaryResult.summary,
        messageCount: selectedMessages.length,
        timeRange,
        confidence,
        extractedFacts: summaryResult.facts,
      };
    } catch (error) {
      logger.error(
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                  name: error.name,
                }
              : error,
          conversationId: input.conversationId,
        },
        'Summary generation failed'
      );
      throw error;
    }
  }

  private assertPlanningInput(input: PlanGroupSummaryWindowInput): void {
    if (
      input.conversationId.length === 0
      || input.conversationId.trim() !== input.conversationId
      || input.groupId.length === 0
      || input.groupId.trim() !== input.groupId
      || !Number.isSafeInteger(input.eligibleAfter)
      || input.eligibleAfter < 0
    ) {
      throw new GroupSummaryPolicyError(
        'invalid_input',
        'Group summary planning input is invalid.',
      );
    }
  }

  private loadGroupPlanningMessages(input: PlanGroupSummaryWindowInput): ChatMessage[] {
    const safePayload = `CASE
      WHEN json_valid(job.payload) THEN job.payload
      ELSE '{}'
    END`;
    const rows = this.db.prepare(
      `SELECT
         cm.id,
         cm.raw_event_id,
         cm.conversation_id,
         cm.sender_id,
         cm.text,
         cm.timestamp,
         re.created_at AS raw_created_at,
         re.source AS raw_source
       FROM chat_messages AS cm
       JOIN raw_events AS re ON re.id = cm.raw_event_id
       WHERE cm.conversation_id = ?
         AND cm.conversation_type = 'group'
         AND cm.group_id = ?
         AND re.created_at >= ?
         AND NOT EXISTS (
           SELECT 1
           FROM memory_sources AS source
           JOIN memory_records AS memory ON memory.id = source.memory_id
           WHERE memory.kind = 'summary'
             AND memory.scope = 'group'
             AND memory.group_id = ?
             AND memory.conversation_id = ?
             AND memory.source_context = 'background_worker:summary'
             AND source.source_type = 'chat_message'
             AND (source.chat_message_id = cm.id OR source.source_id = cm.id)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM jobs AS job
           JOIN group_summary_job_bindings AS binding ON binding.job_id = job.id
           JOIN json_each(${safePayload}, '$.sourceChatMessageIds') AS frozen_source
           WHERE job.type = 'summary'
             AND job.status IN ('pending', 'running', 'completed', 'failed')
             AND binding.group_id = ?
             AND binding.conversation_id = ?
             AND binding.canceled_at IS NULL
             AND json_type(${safePayload}, '$.sourceChatMessageIds') = 'array'
             AND frozen_source.type = 'text'
             AND frozen_source.value = cm.id
         )
       ORDER BY re.created_at ASC, re.id ASC, cm.id ASC
       LIMIT ?`,
    ).all(
      input.conversationId,
      input.groupId,
      input.eligibleAfter,
      input.groupId,
      input.conversationId,
      input.groupId,
      input.conversationId,
      this.config.maxMessagesToSummarize,
    ) as Array<{
      id: string;
      raw_event_id: string;
      conversation_id: string;
      sender_id: string;
      text: string | null;
      timestamp: number;
      raw_created_at: number;
      raw_source: string;
    }>;

    return this.chatMessagesFromRows(rows);
  }

  async planGroupSummaryWindow(
    input: PlanGroupSummaryWindowInput,
  ): Promise<PlannedGroupSummaryWindow | null> {
    this.assertPlanningInput(input);
    const candidateMessages = this.loadGroupPlanningMessages(input);
    if (candidateMessages.length < this.config.minMessagesToTrigger) {
      return null;
    }

    const summaryInput: ConversationSummaryInput = {
      conversationId: input.conversationId,
      conversationType: 'group',
      groupId: input.groupId,
    };
    const prepared = await this.prepareSummaryContext(candidateMessages, summaryInput);
    const sourceChatMessageIds = prepared.sourceMessages.map((message) => message.id);
    if (sourceChatMessageIds.length === 0) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Group summary planning did not retain any source messages.',
      );
    }

    return {
      sourceChatMessageIds,
      candidateCount: candidateMessages.length,
    };
  }

  /**
   * 查找需要摘要的会话
   */
  async findConversationsNeedingSummary(
    sinceMinutes: number
  ): Promise<ConversationSummaryInput[]> {
    const cutoffTime = Date.now() - sinceMinutes * 60 * 1000;

    try {
      // 查找最近有消息但尚未生成摘要的会话
      const rows = this.db
        .prepare(
          `
          SELECT
            cm.conversation_id,
            cm.conversation_type,
            cm.group_id,
            COUNT(*) as message_count,
            MIN(cm.timestamp) as first_message_time,
            MAX(cm.timestamp) as last_message_time,
            gsp.generation AS policy_generation,
            gsp.eligible_after AS policy_eligible_after
          FROM chat_messages cm
          JOIN raw_events re ON re.id = cm.raw_event_id
          LEFT JOIN group_summary_policies gsp ON gsp.group_id = cm.group_id
          WHERE (
              cm.conversation_type = 'private'
              AND re.created_at > ?
            ) OR (
              cm.conversation_type = 'group'
              AND cm.group_id IS NOT NULL
              AND gsp.state = 'enabled'
              AND re.created_at >= gsp.eligible_after
            )
          GROUP BY cm.conversation_id, cm.conversation_type, cm.group_id,
                   gsp.generation, gsp.eligible_after
          HAVING message_count >= ?
        `
        )
        .all(cutoffTime, this.config.minMessagesToTrigger) as Array<{
        conversation_id: string;
        conversation_type: 'private' | 'group';
        group_id: string | null;
        message_count: number;
        first_message_time: number;
        last_message_time: number;
        policy_generation: number | null;
        policy_eligible_after: number | null;
      }>;

      const candidates: ConversationSummaryInput[] = [];

      for (const row of rows) {
        const candidate: ConversationSummaryInput = {
          conversationId: row.conversation_id,
          conversationType: row.conversation_type,
          groupId: row.group_id ?? undefined,
          timeRange: {
            startTime: row.first_message_time,
            endTime: row.last_message_time,
          },
        };

        const groupAuthorization = row.conversation_type === 'group'
          && row.group_id !== null
          && row.policy_generation !== null
          && row.policy_eligible_after !== null
          ? {
              groupId: row.group_id,
              conversationId: row.conversation_id,
              generation: row.policy_generation,
              eligibleAfter: row.policy_eligible_after,
            }
          : undefined;
        if (groupAuthorization) {
          const plan = await this.planGroupSummaryWindow({
            conversationId: candidate.conversationId,
            groupId: groupAuthorization.groupId,
            eligibleAfter: groupAuthorization.eligibleAfter,
          });
          if (plan) {
            try {
              this.assertGroupSummaryAuthorization(candidate, groupAuthorization);
              candidates.push(candidate);
            } catch (error) {
              if (!(error instanceof GroupSummaryPolicyError)) {
                throw error;
              }
            }
          }
          continue;
        }
        const messages = await this.loadMessages(
          candidate,
        );
        const preparedContext = await this.prepareSummaryContext(messages, candidate);
        const existingSummary = await this.findExistingSummaryMemory(
          candidate,
          preparedContext.sourceMessages,
        );
        if (!existingSummary) {
          try {
            candidates.push(candidate);
          } catch (error) {
            if (!(error instanceof GroupSummaryPolicyError)) {
              throw error;
            }
          }
        }
      }

      return candidates;
    } catch (error) {
      logger.error(
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                  name: error.name,
                }
              : error,
        },
        'Failed to find conversations needing summary'
      );
      throw error;
    }
  }

  /**
   * 从数据库加载消息
   */
  private async loadMessages(
    input: ConversationSummaryInput,
    groupEligibleAfter?: number,
  ): Promise<ChatMessage[]> {
    try {
      this.validateConversationBoundary(input);
      if (input.conversationType === 'group' && input.sourceChatMessageIds) {
        if (groupEligibleAfter === undefined) {
          throw new GroupSummaryPolicyError(
            'policy_disabled',
            'Group summary policy is disabled.',
          );
        }
        return this.selectFrozenGroupMessages(input, groupEligibleAfter);
      }
      let query = `
        SELECT
          cm.id,
          cm.raw_event_id,
          cm.conversation_id,
          cm.sender_id,
          cm.text,
          cm.timestamp,
          re.created_at AS raw_created_at,
          re.source AS raw_source
        FROM chat_messages cm
        JOIN raw_events re ON re.id = cm.raw_event_id
        WHERE cm.conversation_id = ?
          AND cm.conversation_type = ?
      `;
      const params: unknown[] = [input.conversationId, input.conversationType];

      if (input.conversationType === 'group') {
        if (groupEligibleAfter === undefined) {
          throw new GroupSummaryPolicyError(
            'policy_disabled',
            'Group summary policy is disabled.',
          );
        }
        query += ' AND cm.group_id = ?';
        params.push(input.groupId);
        query += ' AND re.created_at >= ?';
        params.push(groupEligibleAfter);
      } else {
        query += ' AND cm.group_id IS NULL';
      }

      // 应用消息范围过滤
      if (input.messageRange) {
        query += ' AND cm.id BETWEEN ? AND ?';
        params.push(input.messageRange.start, input.messageRange.end);
      }

      // 应用时间范围过滤
      if (input.timeRange) {
        query += ' AND cm.timestamp BETWEEN ? AND ?';
        params.push(input.timeRange.startTime, input.timeRange.endTime);
      }

      // 排序并限制数量
      query += ' ORDER BY cm.timestamp ASC, cm.rowid ASC LIMIT ?';
      params.push(this.config.maxMessagesToSummarize);

      const rows = this.db.prepare(query).all(...params) as Array<{
        id: string;
        raw_event_id: string;
        conversation_id: string;
        sender_id: string;
        text: string | null;
        timestamp: number;
        raw_created_at: number;
        raw_source: string;
      }>;

      return this.chatMessagesFromRows(rows);
    } catch (error) {
      logger.error(
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                  name: error.name,
                }
              : error,
          conversationId: input.conversationId,
        },
        'Failed to load messages'
      );
      throw error;
    }
  }

  private selectFrozenGroupMessages(
    input: ConversationSummaryInput,
    eligibleAfter: number,
  ): ChatMessage[] {
    const sourceIds = this.normalizeFrozenSourceIds(input.sourceChatMessageIds);
    const placeholders = sourceIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT
         cm.id,
         cm.raw_event_id,
         cm.conversation_id,
         cm.sender_id,
         cm.text,
         cm.timestamp,
         re.created_at AS raw_created_at,
         re.source AS raw_source
       FROM chat_messages AS cm
       JOIN raw_events AS re ON re.id = cm.raw_event_id
       WHERE cm.id IN (${placeholders})
         AND cm.conversation_id = ?
         AND cm.conversation_type = 'group'
         AND cm.group_id = ?
         AND re.created_at >= ?
       ORDER BY re.created_at ASC, re.id ASC, cm.id ASC`,
    ).all(
      ...sourceIds,
      input.conversationId,
      input.groupId,
      eligibleAfter,
    ) as Array<{
      id: string;
      raw_event_id: string;
      conversation_id: string;
      sender_id: string;
      text: string | null;
      timestamp: number;
      raw_created_at: number;
      raw_source: string;
    }>;
    const messages = this.chatMessagesFromRows(rows);
    if (!this.sameOrderedIds(messages.map((message) => message.id), sourceIds)) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Frozen group summary source set is missing, reordered, or outside its scope.',
      );
    }
    return messages;
  }

  private normalizeFrozenSourceIds(sourceIds: string[] | undefined): string[] {
    if (
      !Array.isArray(sourceIds)
      || sourceIds.length === 0
      || sourceIds.length > this.config.maxMessagesToSummarize
    ) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Frozen group summary source IDs are invalid.',
      );
    }
    const normalized = sourceIds.map((sourceId) => {
      if (
        typeof sourceId !== 'string'
        || sourceId.length === 0
        || sourceId.trim() !== sourceId
      ) {
        throw new GroupSummaryPolicyError(
          'job_binding_mismatch',
          'Frozen group summary source IDs are invalid.',
        );
      }
      return sourceId;
    });
    if (new Set(normalized).size !== normalized.length) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Frozen group summary source IDs must be unique.',
      );
    }
    return normalized;
  }

  private chatMessagesFromRows(rows: Array<{
    id: string;
    raw_event_id: string;
    conversation_id: string;
    sender_id: string;
    text: string | null;
    timestamp: number;
    raw_created_at: number;
    raw_source: string;
  }>): ChatMessage[] {
    return rows.map((row) => ({
      id: row.id,
      rawEventId: row.raw_event_id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      text: row.text,
      timestamp: row.timestamp,
      rawCreatedAt: row.raw_created_at,
      isFromBot: this.isBotMessage(row.sender_id, row.raw_source),
    }));
  }

  private sameOrderedIds(actual: string[], expected: string[]): boolean {
    return actual.length === expected.length
      && actual.every((value, index) => value === expected[index]);
  }

  /**
   * 调用 LLM 生成摘要
   */
  private async callLLM(
    contextPack: ContextPack,
    input: ConversationSummaryInput,
    rawEventIds: string[],
    execution?: BackgroundTaskExecutionContext,
    modelContextId?: string,
    groupAuthorization?: GroupSummaryAuthorization,
  ): Promise<SummaryModelResult | null> {
    try {
      const output = await this.runSummaryTurnWithLedger(
        contextPack,
        rawEventIds,
        1,
        input,
        groupAuthorization,
        execution,
        modelContextId,
      );

      if (output.status !== 'completed' || !this.hasUsableResponseText(output)) {
        logger.error(
          {
            conversationId: input.conversationId,
            status: output.status,
            errorMessage: output.errorMessage,
          },
          'LLM call failed or returned no text'
        );
        throw new Error('Summary Pi turn did not complete');
      }

      // 解析响应
      const result = this.parseLLMResponse(output.responseText);

      return { ...result, tokensUsed: output.tokensUsed };
    } catch (error) {
      if (error instanceof GroupSummaryPolicyError) {
        throw error;
      }
      logger.error(
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                  name: error.name,
                }
              : error,
          conversationId: input.conversationId,
        },
        'LLM call failed'
      );

      // 重试一次
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const output = await this.runSummaryTurnWithLedger(
          contextPack,
          rawEventIds,
          2,
          input,
          groupAuthorization,
          execution,
          modelContextId,
        );

        if (output.status === 'completed' && this.hasUsableResponseText(output)) {
          return {
            ...this.parseLLMResponse(output.responseText),
            tokensUsed: output.tokensUsed,
          };
        }
      } catch (retryError) {
        if (retryError instanceof GroupSummaryPolicyError) {
          throw retryError;
        }
        logger.error(
          {
            error:
              retryError instanceof Error
                ? {
                    message: retryError.message,
                    stack: retryError.stack,
                    name: retryError.name,
                  }
                : retryError,
          },
          'LLM retry failed'
        );
      }

      return null;
    }
  }

  private async prepareSummaryContext(
    messages: ChatMessage[],
    input: ConversationSummaryInput,
  ): Promise<PreparedSummaryContext> {
    const turnId = this.buildSummaryTurnId(input, messages);
    const contextPack = await this.contextBuilder.build({
      turnId,
      conversationId: this.buildOpaqueConversationRef(input),
      conversationType: input.conversationType,
      groupId: this.buildOpaqueGroupRef(input),
      recentMessages: this.toOpaqueRecentMessages(messages),
      includeMemory: false,
    });
    const sourceMessagesById = new Map(messages.map((message) => [message.id, message]));
    const retainedMessageIds = contextPack.recentMessages.map((message) => message.messageId);
    if (new Set(retainedMessageIds).size !== retainedMessageIds.length) {
      throw new Error('Summary context contains duplicate source messages');
    }
    const sourceMessages = retainedMessageIds.map((messageId) => {
      const sourceMessage = sourceMessagesById.get(messageId);
      if (!sourceMessage) {
        throw new Error('Summary context contains an untraceable source message');
      }
      return sourceMessage;
    });

    if (sourceMessages.length === 0) {
      throw new Error('Summary context did not retain any source messages');
    }

    return { contextPack, sourceMessages };
  }

  private async runSummaryTurn(contextPack: ContextPack): Promise<PiAdapterOutput> {
    return this.piAdapter.runTurn({
      contextPack,
      systemPrompt: this.buildSummarySystemPrompt(),
      actor: {
        actorClass: 'system_worker',
      },
      invocationContext: 'background_worker',
      turnId: contextPack.turnId,
    });
  }

  private async runSummaryTurnWithLedger(
    contextPack: ContextPack,
    rawEventIds: string[],
    callNumber: number,
    input: ConversationSummaryInput,
    groupAuthorization: GroupSummaryAuthorization | undefined,
    execution?: BackgroundTaskExecutionContext,
    modelContextId?: string,
  ): Promise<PiAdapterOutput> {
    this.assertGroupSummaryAuthorization(input, groupAuthorization);
    const invocationId = execution && modelContextId
      ? this.modelInvocationRepo.startInvocation({
          contextId: modelContextId,
          jobAttemptId: execution.jobAttemptId,
          purpose: 'summary',
          callNumber,
          provider: this.config.piProvider,
          model: this.config.piModel,
          rawEventIds,
        })
      : undefined;

    let output: PiAdapterOutput;
    try {
      output = await this.runSummaryTurn(contextPack);
    } catch (error) {
      if (invocationId) {
        this.modelInvocationRepo.failInvocation(invocationId, 'runtime_exception');
      }
      throw error;
    }

    if (invocationId) {
      if (output.status === 'completed' && this.hasUsableResponseText(output)) {
        this.modelInvocationRepo.completeInvocation(
          invocationId,
          output.tokensUsed,
          output.responseText,
        );
      } else {
        this.modelInvocationRepo.failInvocation(
          invocationId,
          output.status === 'aborted'
            ? 'provider_aborted'
            : output.status === 'completed'
              ? 'empty_response'
              : 'provider_failed',
          output.status === 'aborted' ? 'aborted' : 'failed',
        );
      }
    }

    return output;
  }

  private hasUsableResponseText(output: PiAdapterOutput): output is PiAdapterOutput & {
    responseText: string;
  } {
    return typeof output.responseText === 'string' && output.responseText.trim().length > 0;
  }

  private buildSummarySystemPrompt(): string {
    const task = this.config.summaryPromptTemplate.replace(
      '{targetTokenBudget}',
      this.config.targetTokenBudget.toString(),
    );
    return [
      SUMMARY_SYSTEM_PROMPT,
      task,
      'Return exactly this structure:',
      'SUMMARY: <concise summary>',
      'FACTS:',
      '- <important fact>',
    ].join('\n\n');
  }

  private toOpaqueRecentMessages(messages: ChatMessage[]): RecentMessage[] {
    const participantRefs = new Map<string, string>();
    let nextParticipant = 1;

    return messages.map((message) => {
      let senderRef = 'bot';
      if (!message.isFromBot) {
        const existing = participantRefs.get(message.senderId);
        senderRef = existing ?? `participant_${nextParticipant++}`;
        participantRefs.set(message.senderId, senderRef);
      }

      return {
        messageId: message.id,
        senderId: senderRef === 'bot' ? senderRef : `summary-${senderRef}`,
        senderDisplayName: senderRef,
        text: message.text === null
          ? undefined
          : this.redactSummaryMessageText(message.text),
        timestamp: new Date(message.timestamp),
        isFromBot: message.isFromBot,
      };
    });
  }

  private redactSummaryMessageText(value: string): string {
    const platformRedacted = this.redactPlatformIdentifiers(value);
    const secretRedacted = redactSecretsInText(platformRedacted).text;
    const redacted = this.redactPlatformIdentifiers(secretRedacted);
    const platformMarkerLost =
      platformRedacted.includes('[REDACTED:platform_id]')
      && !redacted.includes('[REDACTED:platform_id]');

    return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
  }

  private redactPlatformIdentifiers(value: string): string {
    return value
      .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
      .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
  }

  private buildSummaryTurnId(
    input: ConversationSummaryInput,
    messages: ChatMessage[],
  ): string {
    return `summary-turn-${this.buildSummaryHash(input, messages)}`;
  }

  private buildOpaqueConversationRef(input: ConversationSummaryInput): string {
    const hash = createHash('sha256')
      .update(JSON.stringify({
        version: 1,
        conversationId: input.conversationId,
        conversationType: input.conversationType,
        groupId: input.groupId ?? null,
      }))
      .digest('hex')
      .slice(0, 24);
    return `summary-context-${hash}`;
  }

  private buildOpaqueGroupRef(input: ConversationSummaryInput): string | undefined {
    if (input.conversationType !== 'group' || !input.groupId) {
      return undefined;
    }

    const hash = createHash('sha256')
      .update(JSON.stringify({
        version: 1,
        groupId: input.groupId,
      }))
      .digest('hex')
      .slice(0, 24);
    return `summary-group-${hash}`;
  }

  private validateConversationBoundary(input: ConversationSummaryInput): void {
    if (input.conversationType === 'group' && !input.groupId) {
      throw new Error('Group summary requires a groupId');
    }
    if (input.conversationType === 'private' && input.groupId !== undefined) {
      throw new Error('Private summary must not include a groupId');
    }
    if (input.conversationType === 'private' && input.sourceChatMessageIds !== undefined) {
      throw new Error('Private summary must not include frozen group sources');
    }
    if (
      input.sourceChatMessageIds !== undefined
      && (input.messageRange !== undefined || input.timeRange !== undefined)
    ) {
      throw new Error('Frozen group summary sources cannot be combined with mutable ranges');
    }
  }

  private isBotMessage(senderId: string, rawSource: string): boolean {
    return rawSource === 'agent'
      || senderId === 'bot'
      || senderId === 'bot-self'
      || senderId.startsWith('bot-');
  }

  /**
   * 解析 LLM 响应
   */
  private parseLLMResponse(response: string): { summary: string; facts: string[] } {
    const lines = response.split('\n');
    let summary = '';
    const facts: string[] = [];
    let inFactsSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('SUMMARY:')) {
        summary = trimmed.substring(8).trim();
      } else if (summary && !inFactsSection && !trimmed.startsWith('FACTS:')) {
        // 继续摘要内容
        summary += ' ' + trimmed;
      } else if (trimmed.startsWith('FACTS:')) {
        inFactsSection = true;
      } else if (inFactsSection && trimmed.startsWith('-')) {
        facts.push(trimmed.substring(1).trim());
      }
    }

    // 如果没有找到格式化的响应，使用整个响应作为摘要
    if (!summary) {
      summary = response.trim();
    }

    return { summary, facts };
  }

  /**
   * 计算时间范围
   */
  private calculateTimeRange(messages: ChatMessage[]): {
    startTime: number;
    endTime: number;
  } {
    if (messages.length === 0) {
      return { startTime: 0, endTime: 0 };
    }

    const timestamps = messages.map((m) => m.timestamp);
    return {
      startTime: Math.min(...timestamps),
      endTime: Math.max(...timestamps),
    };
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(messageCount: number): number {
    // 基于消息数量计算置信度
    // 10 条消息 -> 0.7
    // 30 条消息 -> 0.8
    // 50+ 条消息 -> 0.9
    if (messageCount < 10) {
      return 0.6;
    } else if (messageCount < 30) {
      return 0.7;
    } else if (messageCount < 50) {
      return 0.8;
    } else {
      return 0.9;
    }
  }

  /**
   * 存储摘要为记忆记录
   */
  private async storeSummaryAsMemory(
    input: ConversationSummaryInput,
    summary: string,
    facts: string[],
    messages: ChatMessage[],
    timeRange: { startTime: number; endTime: number },
    confidence: number,
    groupAuthorization?: GroupSummaryAuthorization,
  ): Promise<string> {
    try {
      const memoryId = this.buildSummaryMemoryId(input, messages);
      const startDate = new Date(timeRange.startTime).toISOString().split('T')[0];
      const endDate = new Date(timeRange.endTime).toISOString().split('T')[0];

      const dateRange =
        startDate === endDate ? startDate : `${startDate} to ${endDate}`;

      const createSummary = (): string => this.memoryRepo.createSync({
        id: memoryId,
        scope: input.conversationType === 'private' ? 'conversation' : 'group',
        conversationId: input.conversationId,
        groupId: input.groupId,
        visibility:
          input.conversationType === 'private'
            ? 'private_only'
            : 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: `Conversation summary (${dateRange})`,
        content: summary + (facts.length > 0 ? '\n\nKey facts:\n' + facts.map((f) => `- ${f}`).join('\n') : ''),
        state: 'active',
        confidence,
        importance: 0.6,
        sourceContext: 'background_worker:summary',
        sources: messages.map((message) => ({
          sourceType: 'chat_message' as const,
          sourceId: message.id,
          sourceTimestamp: message.timestamp,
          extractedBy: 'worker' as const,
        })),
        actor: {
          actorClass: 'system_worker',
          context: 'background_worker',
        },
        revisionReason: 'Conversation summary generated by SummaryWorker',
        auditSummary: 'Created conversation summary memory',
      });

      const summaryId = groupAuthorization
        ? this.db.transaction(() => {
            this.assertGroupSummaryAuthorization(input, groupAuthorization);
            if (input.conversationType === 'group' && input.sourceChatMessageIds) {
              this.assertFrozenSourceSnapshot(
                input,
                messages,
                groupAuthorization.eligibleAfter,
              );
            } else {
              this.assertSelectedRawSourcesEligible(messages, groupAuthorization.eligibleAfter);
            }
            return createSummary();
          }).immediate()
        : createSummary();

      return summaryId;
    } catch (error) {
      logger.error(
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                  name: error.name,
                }
              : error,
          conversationId: input.conversationId,
        },
        'Failed to store summary as memory'
      );
      throw error;
    }
  }

  private captureGroupSummaryAuthorization(
    input: ConversationSummaryInput,
    execution?: BackgroundTaskExecutionContext,
  ): GroupSummaryAuthorization | undefined {
    if (input.conversationType !== 'group' || !input.groupId) {
      return undefined;
    }

    if (execution) {
      const binding = this.groupSummaryPolicies.assertSummaryJobExecutionAllowed({
        jobId: execution.jobId,
        jobAttemptId: execution.jobAttemptId,
        groupId: input.groupId,
        conversationId: input.conversationId,
        now: execution.now,
      });
      return {
        groupId: binding.groupId,
        conversationId: binding.conversationId,
        generation: binding.generation,
        eligibleAfter: binding.eligibleAfter,
        execution,
      };
    }

    const policy = this.groupSummaryPolicies.requireEnabled(input.groupId);
    return {
      groupId: input.groupId,
      conversationId: input.conversationId,
      generation: policy.generation,
      eligibleAfter: policy.eligibleAfter,
    };
  }

  private assertGroupSummaryAuthorization(
    input: ConversationSummaryInput,
    authorization?: GroupSummaryAuthorization,
  ): void {
    if (input.conversationType !== 'group') {
      return;
    }
    if (!input.groupId || !authorization) {
      throw new GroupSummaryPolicyError(
        'policy_disabled',
        'Group summary policy is disabled.',
      );
    }

    if (authorization.execution) {
      const binding = this.groupSummaryPolicies.assertSummaryJobExecutionAllowed({
        jobId: authorization.execution.jobId,
        jobAttemptId: authorization.execution.jobAttemptId,
        groupId: input.groupId,
        conversationId: input.conversationId,
        now: authorization.execution.now,
      });
      if (
        binding.groupId !== authorization.groupId
        || binding.conversationId !== authorization.conversationId
        || binding.generation !== authorization.generation
        || binding.eligibleAfter !== authorization.eligibleAfter
      ) {
        throw new GroupSummaryPolicyError(
          'job_binding_mismatch',
          'Group summary job binding changed during execution.',
        );
      }
      return;
    }

    const policy = this.groupSummaryPolicies.requireEnabled(input.groupId);
    if (
      authorization.groupId !== input.groupId
      || authorization.conversationId !== input.conversationId
      || policy.generation !== authorization.generation
      || policy.eligibleAfter !== authorization.eligibleAfter
    ) {
      throw new GroupSummaryPolicyError(
        'stale_policy_generation',
        'Group summary policy generation changed during execution.',
      );
    }
  }

  private assertSelectedRawSourcesEligible(
    messages: ChatMessage[],
    eligibleAfter: number,
  ): void {
    const rawEventIds = [...new Set(messages.map((message) => message.rawEventId))];
    const placeholders = rawEventIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT id, created_at
         FROM raw_events
        WHERE id IN (${placeholders})`,
    ).all(...rawEventIds) as Array<{ id: string; created_at: number }>;
    const createdAtById = new Map(rows.map((row) => [row.id, row.created_at]));

    if (messages.some((message) => {
      const createdAt = createdAtById.get(message.rawEventId);
      return createdAt === undefined
        || createdAt !== message.rawCreatedAt
        || createdAt < eligibleAfter;
    })) {
      throw new GroupSummaryPolicyError(
        'stale_policy_generation',
        'Group summary sources are outside the authorized policy epoch.',
      );
    }
  }

  private assertFrozenSourceSnapshot(
    input: ConversationSummaryInput,
    messages: ChatMessage[],
    eligibleAfter: number,
  ): void {
    const current = this.selectFrozenGroupMessages(input, eligibleAfter);
    const unchanged = current.length === messages.length
      && current.every((message, index) => {
        const original = messages[index];
        return original !== undefined
          && message.id === original.id
          && message.rawEventId === original.rawEventId
          && message.conversationId === original.conversationId
          && message.senderId === original.senderId
          && message.text === original.text
          && message.timestamp === original.timestamp
          && message.rawCreatedAt === original.rawCreatedAt
          && message.isFromBot === original.isFromBot;
      });
    if (!unchanged) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Frozen group summary sources changed before the governed memory write.',
      );
    }
  }

  private buildSummaryMemoryId(
    input: ConversationSummaryInput,
    messages: ChatMessage[]
  ): string {
    return `summary-${this.buildSummaryHash(input, messages)}`;
  }

  private buildSummaryHash(
    input: ConversationSummaryInput,
    messages: ChatMessage[],
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          conversationId: input.conversationId,
          conversationType: input.conversationType,
          groupId: input.groupId ?? null,
          sourceMessageIds: messages.map((message) => message.id),
        })
      )
      .digest('hex')
      .slice(0, 32);
  }

  private async findExistingSummaryMemory(
    input: ConversationSummaryInput,
    messages: ChatMessage[]
  ): Promise<MemoryRecord | null> {
    if (messages.length === 0) {
      return null;
    }

    const deterministicId = this.buildSummaryMemoryId(input, messages);
    const directMatch = await this.memoryRepo.findById(deterministicId);
    if (this.isSummaryMemoryForInput(directMatch, input)) {
      return directMatch;
    }

    return this.findExistingSummaryByExactSources(input, messages);
  }

  private async findExistingSummaryByExactSources(
    input: ConversationSummaryInput,
    messages: ChatMessage[]
  ): Promise<MemoryRecord | null> {
    const sourceIds = messages.map((message) => message.id);
    const sourcePlaceholders = sourceIds.map(() => '?').join(', ');
    const scope = input.conversationType === 'private' ? 'conversation' : 'group';

    const row = this.db
      .prepare(
        `
        SELECT mr.id
        FROM memory_records mr
        JOIN memory_sources ms
          ON ms.memory_id = mr.id
         AND ms.source_type = 'chat_message'
        WHERE mr.kind = 'summary'
          AND mr.scope = ?
          AND mr.conversation_id = ?
          AND COALESCE(mr.group_id, '') = COALESCE(?, '')
          AND mr.source_context = 'background_worker:summary'
        GROUP BY mr.id
        HAVING COUNT(ms.source_id) = ?
           AND SUM(CASE WHEN ms.source_id IN (${sourcePlaceholders}) THEN 1 ELSE 0 END) = ?
        ORDER BY mr.created_at DESC
        LIMIT 1
        `
      )
      .get(
        scope,
        input.conversationId,
        input.groupId ?? null,
        sourceIds.length,
        ...sourceIds,
        sourceIds.length
      ) as { id: string } | undefined;

    if (!row) {
      return null;
    }

    const memory = await this.memoryRepo.findById(row.id);
    return this.isSummaryMemoryForInput(memory, input) ? memory : null;
  }

  private isSummaryMemoryForInput(
    memory: MemoryRecord | null,
    input: ConversationSummaryInput
  ): memory is MemoryRecord {
    if (!memory) {
      return false;
    }

    const expectedScope = input.conversationType === 'private' ? 'conversation' : 'group';
    return memory.kind === 'summary'
      && memory.scope === expectedScope
      && memory.conversationId === input.conversationId
      && (memory.groupId ?? undefined) === (input.groupId ?? undefined)
      && memory.sourceContext === 'background_worker:summary';
  }

  private outputFromExistingSummary(
    memory: MemoryRecord,
    input: ConversationSummaryInput,
    messages: ChatMessage[],
    timeRange: { startTime: number; endTime: number }
  ): ConversationSummaryOutput {
    const parsed = this.parseStoredSummaryContent(memory.content);

    return {
      summaryId: memory.id,
      conversationId: input.conversationId,
      summary: parsed.summary,
      messageCount: messages.length,
      timeRange,
      confidence: memory.confidence,
      extractedFacts: parsed.facts,
    };
  }

  private parseStoredSummaryContent(content: string): { summary: string; facts: string[] } {
    const marker = '\n\nKey facts:\n';
    const markerIndex = content.indexOf(marker);

    if (markerIndex === -1) {
      return { summary: content, facts: [] };
    }

    const factsText = content.slice(markerIndex + marker.length);
    const facts = factsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => line.slice(1).trim())
      .filter((line) => line.length > 0);

    return {
      summary: content.slice(0, markerIndex),
      facts,
    };
  }

}
