/**
 * Summary Worker
 *
 * 后台会话摘要生成工作器
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { PiAdapter } from '../pi/pi-adapter.js';
import type { MemoryRepository } from '../storage/memory-repository.js';
import type { MemoryRecord } from '../types/memory.js';
import { getLogger } from '../logger/index.js';

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
export interface SummaryConfig {
  maxMessagesToSummarize: number;
  minMessagesToTrigger: number;
  summaryPromptTemplate: string;
  includeMemoryContext: boolean;
  targetTokenBudget: number;
}

/**
 * 会话消息记录
 */
interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  text: string | null;
  timestamp: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: SummaryConfig = {
  maxMessagesToSummarize: 50,
  minMessagesToTrigger: 10,
  summaryPromptTemplate:
    'Summarize the following conversation. Extract key facts, topics, and important information. Keep it concise under {targetTokenBudget} tokens.',
  includeMemoryContext: false,
  targetTokenBudget: 200,
};

const SUMMARY_SYSTEM_PROMPT =
  'You are a conversation summarizer. Extract key information and provide concise summaries.';

/**
 * 会话摘要工作器
 */
export class SummaryWorker {
  private config: SummaryConfig;

  constructor(
    private readonly db: Database.Database,
    private readonly piAdapter: PiAdapter,
    private readonly memoryRepo: MemoryRepository,
    config?: Partial<SummaryConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 生成会话摘要
   */
  async generateSummary(
    input: ConversationSummaryInput
  ): Promise<ConversationSummaryOutput | null> {
    logger.info(
      {
        conversationId: input.conversationId,
        conversationType: input.conversationType,
      },
      'Starting summary generation'
    );

    try {
      // Step 1: 加载消息
      const messages = await this.loadMessages(input);

      if (messages.length === 0) {
        logger.warn(
          { conversationId: input.conversationId },
          'No messages found for conversation'
        );
        return null;
      }

      const hasExplicitRange = Boolean(input.messageRange || input.timeRange);

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

      const timeRange = this.calculateTimeRange(messages);
      const confidence = this.calculateConfidence(messages.length);
      const existingSummary = await this.findExistingSummaryMemory(input, messages);
      if (existingSummary) {
        if (existingSummary.state !== 'active') {
          logger.info(
            {
              conversationId: input.conversationId,
              summaryId: existingSummary.id,
              state: existingSummary.state,
              messageCount: messages.length,
            },
            'Summary window already has a non-active governed memory'
          );
          return null;
        }

        logger.info(
          {
            conversationId: input.conversationId,
            summaryId: existingSummary.id,
            messageCount: messages.length,
          },
          'Existing summary found for message window'
        );
        return this.outputFromExistingSummary(existingSummary, input, messages, timeRange);
      }

      // Step 2: 构建摘要提示
      const prompt = this.buildSummaryPrompt(messages, input);

      // Step 3: 调用 LLM 生成摘要
      const summaryResult = await this.callLLM(prompt, input);

      if (!summaryResult) {
        logger.error(
          { conversationId: input.conversationId },
          'Failed to generate summary from LLM'
        );
        throw new Error('LLM returned empty response');
      }

      // Step 4: 存储摘要为记忆记录
      const summaryId = await this.storeSummaryAsMemory(
        input,
        summaryResult.summary,
        summaryResult.facts,
        messages,
        timeRange,
        confidence
      );

      logger.info(
        {
          conversationId: input.conversationId,
          summaryId,
          messageCount: messages.length,
        },
        'Summary generation completed'
      );

      return {
        summaryId,
        conversationId: input.conversationId,
        summary: summaryResult.summary,
        messageCount: messages.length,
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
            conversation_id,
            conversation_type,
            group_id,
            COUNT(*) as message_count,
            MIN(timestamp) as first_message_time,
            MAX(timestamp) as last_message_time
          FROM chat_messages
          WHERE timestamp > ?
          GROUP BY conversation_id, conversation_type, group_id
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

        const messages = await this.loadMessages(candidate);
        const existingSummary = await this.findExistingSummaryMemory(candidate, messages);
        if (!existingSummary) {
          candidates.push(candidate);
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
    input: ConversationSummaryInput
  ): Promise<ChatMessage[]> {
    try {
      let query = `
        SELECT id, conversation_id, sender_id, text, timestamp
        FROM chat_messages
        WHERE conversation_id = ?
      `;
      const params: unknown[] = [input.conversationId];

      // 应用消息范围过滤
      if (input.messageRange) {
        query += ' AND id BETWEEN ? AND ?';
        params.push(input.messageRange.start, input.messageRange.end);
      }

      // 应用时间范围过滤
      if (input.timeRange) {
        query += ' AND timestamp BETWEEN ? AND ?';
        params.push(input.timeRange.startTime, input.timeRange.endTime);
      }

      // 排序并限制数量
      query += ' ORDER BY timestamp ASC LIMIT ?';
      params.push(this.config.maxMessagesToSummarize);

      const rows = this.db.prepare(query).all(...params) as Array<{
        id: string;
        conversation_id: string;
        sender_id: string;
        text: string | null;
        timestamp: number;
      }>;

      return rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        senderId: row.sender_id,
        text: row.text,
        timestamp: row.timestamp,
      }));
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

  /**
   * 构建摘要提示
   */
  private buildSummaryPrompt(
    messages: ChatMessage[],
    input: ConversationSummaryInput
  ): string {
    const lines: string[] = [];

    // 添加任务说明
    const template = this.config.summaryPromptTemplate.replace(
      '{targetTokenBudget}',
      this.config.targetTokenBudget.toString()
    );
    lines.push(template);
    lines.push('');

    // 添加会话元数据
    lines.push(`Conversation Type: ${input.conversationType}`);
    if (input.groupId) {
      lines.push(`Group ID: ${input.groupId}`);
    }
    lines.push(`Message Count: ${messages.length}`);
    lines.push('');

    // 添加消息内容
    lines.push('Messages:');
    messages.forEach((msg) => {
      const timestamp = new Date(msg.timestamp).toISOString();
      const text = msg.text || '(no text)';
      lines.push(`[${timestamp}] User ${msg.senderId}: ${text}`);
    });

    lines.push('');
    lines.push(
      'Please provide:'
    );
    lines.push('1. A concise summary of the conversation');
    lines.push('2. Key facts or important information (as a list)');
    lines.push('');
    lines.push('Format your response as:');
    lines.push('SUMMARY: <your summary here>');
    lines.push('FACTS:');
    lines.push('- <fact 1>');
    lines.push('- <fact 2>');

    return lines.join('\n');
  }

  /**
   * 调用 LLM 生成摘要
   */
  private async callLLM(
    prompt: string,
    input: ConversationSummaryInput
  ): Promise<{ summary: string; facts: string[] } | null> {
    try {
      // 构建简单的 ContextPack（最小化实现）
      const contextPack = {
        id: `ctx-${Date.now()}`,
        turnId: `summary-${Date.now()}`,
        createdAt: new Date(),
        conversation: {
          conversationId: input.conversationId,
          conversationType: input.conversationType,
          groupId: input.groupId,
        },
        recentMessages: [
          {
            messageId: `summary-prompt-${Date.now()}`,
            senderId: 'system-worker',
            senderDisplayName: 'SummaryWorker',
            text: prompt,
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
        memory: {
          retrievedFacts: [],
          selectedMemoryIds: [],
        },
        participants: [],
        injectedIdentityFields: [],
        tokenBudget: {
          max: 1000,
          used: 0,
          breakdown: {
            recentMessages: 0,
            memory: 0,
            identity: 0,
            system: 0,
          },
        },
      };

      // 调用 Pi Adapter
      const output = await this.piAdapter.runTurn({
        contextPack,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        actor: {
          actorClass: 'system_worker',
        },
        invocationContext: 'background_worker',
        turnId: `summary-${Date.now()}`,
      });

      if (output.status !== 'completed' || !output.responseText) {
        logger.error(
          {
            conversationId: input.conversationId,
            status: output.status,
            errorMessage: output.errorMessage,
          },
          'LLM call failed or returned no text'
        );
        return null;
      }

      // 解析响应
      const result = this.parseLLMResponse(output.responseText);

      return result;
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
        'LLM call failed'
      );

      // 重试一次
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const retryContextPack = {
          id: `ctx-retry-${Date.now()}`,
          turnId: `summary-retry-${Date.now()}`,
          createdAt: new Date(),
          conversation: {
            conversationId: input.conversationId,
            conversationType: input.conversationType,
            groupId: input.groupId,
          },
          recentMessages: [
            {
              messageId: `summary-retry-prompt-${Date.now()}`,
              senderId: 'system-worker',
              senderDisplayName: 'SummaryWorker',
              text: prompt,
              timestamp: new Date(),
              isFromBot: false,
            },
          ],
          memory: {
            retrievedFacts: [],
            selectedMemoryIds: [],
          },
          participants: [],
          injectedIdentityFields: [],
          tokenBudget: {
            max: 1000,
            used: 0,
            breakdown: {
              recentMessages: 0,
              memory: 0,
              identity: 0,
              system: 0,
            },
          },
        };

        const output = await this.piAdapter.runTurn({
          contextPack: retryContextPack,
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          actor: {
            actorClass: 'system_worker',
          },
          invocationContext: 'background_worker',
          turnId: `summary-retry-${Date.now()}`,
        });

        if (output.status === 'completed' && output.responseText) {
          return this.parseLLMResponse(output.responseText);
        }
      } catch (retryError) {
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
    confidence: number
  ): Promise<string> {
    try {
      const memoryId = this.buildSummaryMemoryId(input, messages);
      const startDate = new Date(timeRange.startTime).toISOString().split('T')[0];
      const endDate = new Date(timeRange.endTime).toISOString().split('T')[0];

      const dateRange =
        startDate === endDate ? startDate : `${startDate} to ${endDate}`;

      const summaryId = await this.memoryRepo.create({
        id: memoryId,
        scope: input.conversationType === 'private' ? 'conversation' : 'group',
        conversationId: input.conversationId,
        groupId: input.groupId,
        visibility:
          input.conversationType === 'private'
            ? 'same_user_any_context'
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

  private buildSummaryMemoryId(
    input: ConversationSummaryInput,
    messages: ChatMessage[]
  ): string {
    const hash = createHash('sha256')
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

    return `summary-${hash}`;
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
