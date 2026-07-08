/**
 * Memory Extraction Worker
 *
 * 从对话中提取用户记忆的后台工作器
 */

import type Database from 'better-sqlite3';
import { AuditRepository } from '../storage/audit-repository.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { PrivacyPreferenceRepository } from '../storage/privacy-preference-repository.js';
import { EvaluatorStub } from '../evaluator/evaluator-stub.js';
import { getLogger } from '../logger/index.js';
import { MemoryProposalService } from '../memory/proposal-service.js';

const logger = getLogger();

/**
 * 从单次对话中提取记忆的输入参数
 */
export interface MemoryExtractionInput {
  conversationId: string;
  userId: string; // canonical_user_id
  userMessage: string;
  botResponse: string;
  messageId?: string;
  timestamp?: number;
  conversationType?: 'private' | 'group';
  groupId?: string;
}

/**
 * 批处理输入
 */
export interface BatchExtractionInput {
  conversationId: string;
  turns: Array<{
    userId: string;
    userMessage: string;
    botResponse: string;
    messageId?: string;
    timestamp?: number;
    conversationType?: 'private' | 'group';
    groupId?: string;
  }>;
}

/**
 * 提取模式定义
 */
export interface ExtractionPattern {
  regex: RegExp;
  type: 'name' | 'identity' | 'attribute' | 'preference';
  sensitivity: 'normal' | 'personal' | 'sensitive';
  confidence: number; // 0.0-1.0
  importance: number; // 0.0-1.0
}

/**
 * 提取结果
 */
export interface ExtractionResult {
  matched: boolean;
  count: number;
  memoryIds: string[];
  errors?: Array<{ message: string; context?: Record<string, unknown> }>;
}

/**
 * 记忆提取错误
 */
export class MemoryExtractionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'MemoryExtractionError';
  }
}

/**
 * 默认提取模式（中文常见自述模式）
 */
const DEFAULT_PATTERNS: ExtractionPattern[] = [
  {
    regex: /我叫\s*([^，。！？,.!?]+)/,
    type: 'name',
    sensitivity: 'personal',
    confidence: 0.9,
    importance: 0.8,
  },
  {
    regex: /我是\s*([^，。！？,.!?]+)/,
    type: 'identity',
    sensitivity: 'personal',
    confidence: 0.7,
    importance: 0.6,
  },
  {
    regex: /我的\s*([^，。！？,.!?]+?)\s*是\s*([^，。！？,.!?]+)/,
    type: 'attribute',
    sensitivity: 'personal',
    confidence: 0.7,
    importance: 0.6,
  },
  {
    regex: /我喜欢\s*([^，。！？,.!?]+)/,
    type: 'preference',
    sensitivity: 'normal',
    confidence: 0.8,
    importance: 0.5,
  },
  {
    regex: /我不喜欢\s*([^，。！？,.!?]+)/,
    type: 'preference',
    sensitivity: 'normal',
    confidence: 0.8,
    importance: 0.5,
  },
  {
    regex: /我想要\s*([^，。！？,.!?]+)/,
    type: 'preference',
    sensitivity: 'normal',
    confidence: 0.6,
    importance: 0.4,
  },
  {
    regex: /我需要\s*([^，。！？,.!?]+)/,
    type: 'preference',
    sensitivity: 'normal',
    confidence: 0.6,
    importance: 0.4,
  },
];

/**
 * 记忆提取工作器
 */
export class MemoryExtractionWorker {
  private patterns: ExtractionPattern[];
  private readonly memoryRepo: MemoryRepository;
  private readonly memoryProposalService: MemoryProposalService;

  constructor(
    private readonly db: Database.Database,
    memoryRepo?: MemoryRepository,
    patterns?: ExtractionPattern[],
    memoryProposalService?: MemoryProposalService
  ) {
    if (!db) {
      throw new Error('Database instance is required');
    }

    this.memoryRepo = memoryRepo ?? new MemoryRepository(db);
    this.memoryProposalService = memoryProposalService
      ?? new MemoryProposalService(this.memoryRepo, {
        evaluator: new EvaluatorStub(),
        auditRepository: new AuditRepository(db),
        privacyPreferences: new PrivacyPreferenceRepository(db),
      });
    this.patterns = patterns ?? DEFAULT_PATTERNS;
  }

  /**
   * 从单个对话轮次中提取记忆
   */
  async extractFromTurn(input: MemoryExtractionInput): Promise<ExtractionResult> {
    // 输入验证
    if (!input.conversationId) {
      throw new MemoryExtractionError(
        'conversationId is required',
        'INVALID_INPUT',
        { field: 'conversationId' }
      );
    }

    if (!input.userId) {
      throw new MemoryExtractionError('userId is required', 'INVALID_INPUT', { field: 'userId' });
    }

    if (!input.userMessage) {
      throw new MemoryExtractionError(
        'userMessage is required',
        'INVALID_INPUT',
        { field: 'userMessage' }
      );
    }

    // 空消息或过长消息记录警告但不抛出错误
    if (input.userMessage.trim().length === 0) {
      logger.warn({ conversationId: input.conversationId }, 'Empty user message, skipping extraction');
      return { matched: false, count: 0, memoryIds: [] };
    }

    if (input.userMessage.length > 10000) {
      logger.warn(
        { conversationId: input.conversationId, length: input.userMessage.length },
        'User message too long, may affect extraction performance'
      );
    }

    const memoryIds: string[] = [];
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];

    // 模式匹配循环
    for (const pattern of this.patterns) {
      try {
        const matches = input.userMessage.match(pattern.regex);

        if (matches) {
          // 提取fact内容（完整匹配）
          const fact = matches[0];

          // 创建记忆
          try {
            const memoryId = await this.createMemory({
              userId: input.userId,
              conversationId: input.conversationId,
              type: pattern.type,
              fact,
              sensitivity: pattern.sensitivity,
              confidence: pattern.confidence,
              importance: pattern.importance,
              messageId: input.messageId,
              timestamp: input.timestamp,
              conversationType: input.conversationType,
              groupId: input.groupId,
            });

            memoryIds.push(memoryId);

            logger.debug(
              { memoryId, type: pattern.type, fact },
              'Memory extracted successfully'
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : 'Unknown error creating memory';
            logger.error(
              { err: error, type: pattern.type, fact },
              'Failed to create memory'
            );
            errors.push({
              message: errorMessage,
              context: { type: pattern.type, fact },
            });
          }
        }
      } catch (error) {
        // 正则匹配异常，记录并跳过该模式
        logger.warn(
          { err: error, pattern: pattern.regex.source },
          'Pattern matching failed, skipping'
        );
        continue;
      }
    }

    return {
      matched: memoryIds.length > 0,
      count: memoryIds.length,
      memoryIds,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * 批量提取多个对话轮次
   */
  async extractBatch(input: BatchExtractionInput): Promise<ExtractionResult> {
    if (!input.conversationId) {
      throw new MemoryExtractionError(
        'conversationId is required',
        'INVALID_INPUT',
        { field: 'conversationId' }
      );
    }

    if (!input.turns || input.turns.length === 0) {
      logger.info({ conversationId: input.conversationId }, 'No turns to process');
      return { matched: false, count: 0, memoryIds: [] };
    }

    logger.info(
      { conversationId: input.conversationId, turnCount: input.turns.length },
      'Starting batch extraction'
    );

    const allMemoryIds: string[] = [];
    const allErrors: Array<{ message: string; context?: Record<string, unknown> }> = [];

    // 遍历所有turns，错误不中断流程
    for (const turn of input.turns) {
      try {
        const result = await this.extractFromTurn({
          conversationId: input.conversationId,
          userId: turn.userId,
          userMessage: turn.userMessage,
          botResponse: turn.botResponse,
          messageId: turn.messageId,
          timestamp: turn.timestamp,
          conversationType: turn.conversationType,
          groupId: turn.groupId,
        });

        allMemoryIds.push(...result.memoryIds);
        if (result.errors) {
          allErrors.push(...result.errors);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ err: error, turn }, 'Failed to extract from turn');
        allErrors.push({
          message: errorMessage,
          context: { messageId: turn.messageId },
        });
        // 继续处理后续turns
      }
    }

    const successRate = input.turns.length > 0
      ? ((input.turns.length - allErrors.length) / input.turns.length) * 100
      : 0;

    logger.info(
      {
        conversationId: input.conversationId,
        totalTurns: input.turns.length,
        successCount: input.turns.length - allErrors.length,
        successRate: successRate.toFixed(1) + '%',
        memoryCount: allMemoryIds.length,
      },
      'Batch extraction completed'
    );

    return {
      matched: allMemoryIds.length > 0,
      count: allMemoryIds.length,
      memoryIds: allMemoryIds,
      errors: allErrors.length > 0 ? allErrors : undefined,
    };
  }

  /**
   * 获取当前提取模式
   */
  getPatterns(): ExtractionPattern[] {
    return [...this.patterns];
  }

  /**
   * 设置自定义提取模式
   */
  setPatterns(patterns: ExtractionPattern[]): void {
    this.patterns = patterns;
  }

  /**
   * 创建记忆（私有方法）
   */
  private async createMemory(data: {
    userId: string;
    conversationId: string;
    type: ExtractionPattern['type'];
    fact: string;
    sensitivity: ExtractionPattern['sensitivity'];
    confidence: number;
    importance: number;
    messageId?: string;
    timestamp?: number;
    conversationType?: 'private' | 'group';
    groupId?: string;
  }): Promise<string> {
    try {
      // 确保用户存在
      await this.ensureUserExists(data.userId);

      const privateSourceContext = data.messageId
        ? `chat:${data.conversationId}:${data.messageId}`
        : `chat:${data.conversationId}`;
      const sourceContext = data.conversationType === 'group' ? 'group_chat' : privateSourceContext;
      const sourceId = data.messageId ?? `chat:${data.conversationId}`;
      const isGroupDerived = data.conversationType === 'group';

      // 构建记忆记录。私聊第一方低风险陈述走本地 L0 policy 自动 active；
      // 群聊来源的 user memory 只进入 proposed，避免单条普通群消息成为 active user fact。
      const outcome = await this.memoryProposalService.processCandidate({
        scope: 'user',
        canonicalUserId: data.userId,
        groupId: data.groupId,
        conversationId: data.conversationId,
        visibility: isGroupDerived ? 'same_group_only' : 'private_only',
        sensitivity: data.sensitivity,
        authority: 'user_stated',
        kind: data.type === 'preference' ? 'preference' : 'fact',
        title: `${data.type}: ${data.fact}`,
        content: data.fact,
        confidence: data.confidence,
        importance: data.importance,
        sourceContext,
        sources: [
          {
            sourceType: 'chat_message',
            sourceId,
            sourceTimestamp: data.timestamp ?? Date.now(),
            extractedBy: 'worker',
          },
        ],
        actor: {
          canonicalUserId: data.userId,
          actorClass: 'system_worker',
          context: isGroupDerived ? 'group_chat' : 'private_chat',
        },
      });

      if (!outcome.memoryId) {
        throw new MemoryExtractionError(
          outcome.reason,
          outcome.riskLevel === 'prohibited' ? 'MEMORY_POLICY_REJECTED' : 'MEMORY_REJECTED',
          { riskLevel: outcome.riskLevel, findings: outcome.findings }
        );
      }

      return outcome.memoryId;
    } catch (error) {
      logger.error(
        { err: error, userId: data.userId },
        'Failed to create memory record'
      );

      if (error instanceof Error && error.message.includes('FOREIGN KEY')) {
        throw new MemoryExtractionError(
          'User does not exist and could not be created',
          'USER_CREATE_FAILED',
          { userId: data.userId, originalError: error.message }
        );
      }

      if (error instanceof MemoryExtractionError) {
        throw error;
      }

      throw new MemoryExtractionError(
        'Failed to create memory record',
        'MEMORY_CREATE_FAILED',
        { originalError: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  }

  /**
   * 确保用户存在（私有方法）
   */
  private async ensureUserExists(userId: string): Promise<void> {
    try {
      const existing = this.db
        .prepare('SELECT id FROM canonical_users WHERE id = ?')
        .get(userId);

      if (!existing) {
        const now = Date.now();
        this.db
          .prepare(
            'INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)'
          )
          .run(userId, now, now);

        logger.debug({ userId }, 'Created canonical user');
      }
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to ensure user exists');
      throw new MemoryExtractionError(
        'Failed to create user',
        'USER_CREATE_FAILED',
        { userId, originalError: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  }
}
