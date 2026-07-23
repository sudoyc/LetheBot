/**
 * Memory Extraction Worker
 *
 * 从对话中提取用户记忆的后台工作器
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { AuditRepository } from '../storage/audit-repository.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import { PrivacyPreferenceRepository } from '../storage/privacy-preference-repository.js';
import { getLogger } from '../logger/index.js';
import {
  buildMemoryCandidateEffectId,
  MemoryProposalService,
  type MemoryProposalOutcome,
} from '../memory/proposal-service.js';

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
  jobAttemptId?: string;
  sourceRawEventId?: string;
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
  errors?: Array<{ code: string; message: string; context?: Record<string, unknown> }>;
}

export interface ChatMessageExtractionInput {
  sourceChatMessageId: string;
  targetUserId: string;
  jobAttemptId?: string;
}

interface ExpectedExtractionEffect {
  memoryId: string;
  userId: string;
  conversationId: string;
  groupId?: string;
  visibility: 'private_only' | 'same_group_only';
  sensitivity: ExtractionPattern['sensitivity'];
  kind: 'preference' | 'fact';
  title: string;
  content: string;
  sourceContext: string;
  sourceId: string;
  sourceTimestamp?: number;
  sourceRawEventId?: string;
  jobAttemptId?: string;
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

const GROUP_AUTO_EXTRACTION_MAX_LENGTH = 160;
const GROUP_UNSAFE_CONTEXT_PATTERN = /(?:如果|假如|假设|要是|的话|听说|据说|我想要|我需要|(?:他|她|他们|她们|有人).{0,8}(?:说|表示))/u;
const GROUP_UNSAFE_ATTRIBUTE_PATTERN = /^我的\s*(?:备注|记录|假设|愿望)\s*是/u;
const GROUP_INTERROGATIVE_PATTERN = /(?:谁|什么|还是|叫不叫|喜欢不喜欢|是不是|对不对|是否|为什么|怎么(?:样)?|哪里|哪(?:个|种|些|一)|多少|几(?:个|种|次)|可不可以|能不能|有没有|[呢么嘛][。.!！]?$)/u;
const GROUP_CONDITIONAL_PATTERN = /(?:才(?:会|能|要)|就(?:会|能|要)|除非|否则|只要|一旦)/u;
const GROUP_REPORTED_SPEECH_PATTERN = /(?:是|由)[^，。！？,.!?]{1,40}(?:说|表示|提到|告诉)(?:的)?[。.!！]?$/u;
const GROUP_NESTED_SELF_REPORT_PATTERN = /.+我(?:叫|是|不?喜欢|想要|需要)/u;
const GROUP_EXTRACTION_PATTERNS: readonly ExtractionPattern[] = [
  {
    regex: /^我叫\s*[^，。！？,.!?\s][^，。！？,.!?]{0,79}[。.!！]?$/u,
    type: 'name',
    sensitivity: 'personal',
    confidence: 0.9,
    importance: 0.8,
  },
  {
    regex: /^我的\s*[^，。！？,.!?\s][^，。！？,.!?]{0,39}?\s*是\s*[^，。！？,.!?\s][^，。！？,.!?]{0,79}[。.!！]?$/u,
    type: 'attribute',
    sensitivity: 'personal',
    confidence: 0.7,
    importance: 0.6,
  },
  {
    regex: /^我(?:不)?喜欢\s*[^，。！？,.!?\s][^，。！？,.!?]{0,79}[。.!！]?$/u,
    type: 'preference',
    sensitivity: 'normal',
    confidence: 0.8,
    importance: 0.5,
  },
];

export function isAutomaticExtractionCandidate(input: {
  text: string;
  conversationType: 'private' | 'group';
}): boolean {
  const text = input.text.trim();
  if (text.length === 0) {
    return false;
  }

  if (input.conversationType === 'private') {
    return DEFAULT_PATTERNS.some((pattern) => pattern.regex.test(text));
  }

  if (
    text.length > GROUP_AUTO_EXTRACTION_MAX_LENGTH
    || text.includes('\n')
    || text.includes('\r')
    || text.includes('?')
    || text.includes('？')
    || /吗[。.!！]?$/.test(text)
    || GROUP_UNSAFE_CONTEXT_PATTERN.test(text)
    || GROUP_UNSAFE_ATTRIBUTE_PATTERN.test(text)
    || GROUP_INTERROGATIVE_PATTERN.test(text)
    || GROUP_CONDITIONAL_PATTERN.test(text)
    || GROUP_REPORTED_SPEECH_PATTERN.test(text)
    || GROUP_NESTED_SELF_REPORT_PATTERN.test(text)
  ) {
    return false;
  }

  return GROUP_EXTRACTION_PATTERNS.some((pattern) => pattern.regex.test(text));
}

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
    const errors: Array<{ code: string; message: string; context?: Record<string, unknown> }> = [];

    const patterns = input.conversationType === 'group'
      ? isAutomaticExtractionCandidate({
        text: input.userMessage,
        conversationType: 'group',
      }) ? GROUP_EXTRACTION_PATTERNS : []
      : this.patterns;

    // 模式匹配循环
    for (const pattern of patterns) {
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
              jobAttemptId: input.jobAttemptId,
              sourceRawEventId: input.sourceRawEventId,
            });

            memoryIds.push(memoryId);

            logger.debug(
              { memoryId, type: pattern.type },
              'Memory extracted successfully'
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : 'Unknown error creating memory';
            logger.error(
              {
                errorName: error instanceof Error ? error.name : 'UnknownError',
                errorCode: error instanceof MemoryExtractionError ? error.code : 'MEMORY_CREATE_FAILED',
                type: pattern.type,
              },
              'Failed to create memory'
            );
            errors.push({
              code: error instanceof MemoryExtractionError ? error.code : 'MEMORY_CREATE_FAILED',
              message: errorMessage,
              context: { type: pattern.type },
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

  async extractFromChatMessage(input: ChatMessageExtractionInput): Promise<ExtractionResult> {
    if (!input.sourceChatMessageId) {
      throw new MemoryExtractionError(
        'sourceChatMessageId is required',
        'INVALID_INPUT',
        { field: 'sourceChatMessageId' },
      );
    }

    if (!input.targetUserId) {
      throw new MemoryExtractionError(
        'targetUserId is required',
        'INVALID_INPUT',
        { field: 'targetUserId' },
      );
    }

    const source = this.db
      .prepare(
        `SELECT
          cm.id,
          cm.conversation_id,
          cm.conversation_type,
          cm.group_id,
          cm.text,
          cm.timestamp,
          cm.raw_event_id,
          re.type AS raw_event_type,
          re.source AS raw_event_source,
          re.platform,
          pa.canonical_user_id,
          pa.status AS platform_account_status
         FROM chat_messages cm
         JOIN raw_events re ON re.id = cm.raw_event_id
         LEFT JOIN platform_accounts pa
           ON pa.platform = re.platform
          AND pa.platform_account_id = CASE
            WHEN cm.sender_id LIKE 'qq-%' THEN SUBSTR(cm.sender_id, 4)
            ELSE cm.sender_id
          END
         WHERE cm.id = ?`
      )
      .get(input.sourceChatMessageId) as {
        id: string;
        conversation_id: string;
        conversation_type: 'private' | 'group';
        group_id: string | null;
        text: string | null;
        timestamp: number;
        raw_event_id: string;
        raw_event_type: string;
        raw_event_source: string;
        platform: string | null;
        canonical_user_id: string | null;
        platform_account_status: string | null;
      } | undefined;

    if (!source) {
      throw new MemoryExtractionError(
        'Canonical source chat message does not exist',
        'SOURCE_CHAT_MESSAGE_NOT_FOUND',
        { sourceChatMessageId: input.sourceChatMessageId },
      );
    }

    if (
      source.raw_event_type !== 'chat.message.received'
      || source.raw_event_source !== 'gateway'
      || source.platform !== 'qq'
    ) {
      throw new MemoryExtractionError(
        'Canonical source is not an inbound QQ chat message',
        'SOURCE_CHAT_MESSAGE_NOT_USABLE',
        { sourceChatMessageId: input.sourceChatMessageId },
      );
    }

    if (
      source.platform_account_status !== 'active'
      || source.canonical_user_id !== input.targetUserId
    ) {
      throw new MemoryExtractionError(
        'Canonical source sender does not match an active target identity',
        'SOURCE_IDENTITY_MISMATCH',
        { sourceChatMessageId: input.sourceChatMessageId },
      );
    }

    if (!source.text || source.text.trim().length === 0) {
      return { matched: false, count: 0, memoryIds: [] };
    }

    return this.extractForDurableJob({
      conversationId: source.conversation_id,
      userId: input.targetUserId,
      userMessage: source.text,
      botResponse: '',
      messageId: source.id,
      timestamp: source.timestamp,
      conversationType: source.conversation_type,
      groupId: source.group_id ?? undefined,
      jobAttemptId: input.jobAttemptId,
      sourceRawEventId: source.raw_event_id,
    });
  }

  async extractForDurableJob(input: MemoryExtractionInput): Promise<ExtractionResult> {
    const result = await this.extractFromTurn(input);
    const transientErrors = result.errors?.filter((error) => !isDeterministicExtractionRejection(error.code)) ?? [];
    if (transientErrors.length > 0) {
      throw new MemoryExtractionError(
        'Transient memory extraction candidate failure',
        'TRANSIENT_EXTRACTION_FAILURE',
        { errorCodes: transientErrors.map((error) => error.code) },
      );
    }

    return result;
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
    const allErrors: Array<{ code: string; message: string; context?: Record<string, unknown> }> = [];

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
        logger.error({
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: error instanceof MemoryExtractionError ? error.code : 'EXTRACTION_FAILED',
          messageId: turn.messageId,
        }, 'Failed to extract from turn');
        allErrors.push({
          code: error instanceof MemoryExtractionError ? error.code : 'EXTRACTION_FAILED',
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
    jobAttemptId?: string;
    sourceRawEventId?: string;
  }): Promise<string> {
    try {
      // 确保用户存在
      await this.ensureUserExists(data.userId);

      const privateSourceContext = data.messageId
        ? `chat:${data.conversationId}:${data.messageId}`
        : `chat:${data.conversationId}`;
      const isGroupDerived = data.conversationType === 'group';
      const sourceContext = isGroupDerived ? 'group_chat' : privateSourceContext;
      const sourceId = data.messageId ?? `chat:${data.conversationId}`;
      const kind = data.type === 'preference' ? 'preference' : 'fact';
      const memoryId = buildExtractionMemoryId({
        sourceId,
        userId: data.userId,
        kind,
        content: data.fact,
      });
      const expectedEffect: ExpectedExtractionEffect = {
        memoryId,
        userId: data.userId,
        conversationId: data.conversationId,
        groupId: data.groupId,
        visibility: isGroupDerived ? 'same_group_only' : 'private_only',
        sensitivity: data.sensitivity,
        kind,
        title: `${data.type}: ${data.fact}`,
        content: data.fact,
        sourceContext,
        sourceId,
        sourceTimestamp: data.timestamp,
        sourceRawEventId: data.sourceRawEventId,
        jobAttemptId: data.jobAttemptId,
      };
      if (await this.reuseExactEffect(expectedEffect)) {
        return memoryId;
      }

      const rejectionEffectId = buildMemoryCandidateEffectId(memoryId);
      const rejected = this.db
        .prepare(
          `SELECT summary FROM audit_log
           WHERE event_type = 'memory.candidate_rejected' AND event_id = ?
           ORDER BY timestamp ASC
           LIMIT 1`
        )
        .get(rejectionEffectId) as { summary: string } | undefined;
      if (rejected) {
        throw new MemoryExtractionError(
          rejected.summary,
          'MEMORY_REJECTED_REPLAY',
          { candidateId: memoryId },
        );
      }

      // 构建记忆记录。私聊第一方低风险陈述走本地 L0 policy 自动 active；
      // 群聊来源的 user memory 只进入 proposed，避免单条普通群消息成为 active user fact。
      let outcome: MemoryProposalOutcome;
      try {
        outcome = await this.memoryProposalService.processCandidate({
          id: memoryId,
          scope: 'user',
          canonicalUserId: data.userId,
          groupId: data.groupId,
          conversationId: data.conversationId,
          visibility: expectedEffect.visibility,
          sensitivity: data.sensitivity,
          authority: 'user_stated',
          kind,
          title: expectedEffect.title,
          content: data.fact,
          confidence: data.confidence,
          importance: data.importance,
          sourceContext,
          jobAttemptId: data.jobAttemptId,
          sourceEventIds: data.sourceRawEventId ? [data.sourceRawEventId] : undefined,
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
            context: data.jobAttemptId
              ? 'background_worker'
              : isGroupDerived ? 'group_chat' : 'private_chat',
          },
        });
      } catch (error) {
        if (await this.reuseExactEffect(expectedEffect)) {
          return memoryId;
        }
        throw error;
      }

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
        {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: error instanceof MemoryExtractionError ? error.code : 'MEMORY_CREATE_FAILED',
        },
        'Failed to create memory record'
      );

      if (error instanceof Error && error.message.includes('FOREIGN KEY')) {
        throw new MemoryExtractionError(
          'User does not exist and could not be created',
          'USER_CREATE_FAILED',
          { userId: data.userId, causeName: error.name }
        );
      }

      if (error instanceof MemoryExtractionError) {
        throw error;
      }

      throw new MemoryExtractionError(
        'Failed to create memory record',
        'MEMORY_CREATE_FAILED',
        { causeName: error instanceof Error ? error.name : 'UnknownError' }
      );
    }
  }

  private async reuseExactEffect(expected: ExpectedExtractionEffect): Promise<boolean> {
    const existing = await this.memoryRepo.findById(expected.memoryId);
    if (!existing) {
      return false;
    }

    const source = this.db
      .prepare(
        `SELECT source_type, source_id, source_timestamp, extracted_by
         FROM memory_sources
         WHERE memory_id = ? AND source_type = 'chat_message' AND source_id = ?`
      )
      .get(expected.memoryId, expected.sourceId) as {
        source_type: string;
        source_id: string;
        source_timestamp: number;
        extracted_by: string | null;
      } | undefined;
    const exact =
      existing.scope === 'user'
      && existing.canonicalUserId === expected.userId
      && existing.conversationId === expected.conversationId
      && existing.groupId === expected.groupId
      && existing.visibility === expected.visibility
      && existing.sensitivity === expected.sensitivity
      && existing.authority === 'user_stated'
      && existing.kind === expected.kind
      && existing.title === expected.title
      && existing.content === expected.content
      && existing.sourceContext === expected.sourceContext
      && source?.extracted_by === 'worker'
      && (expected.sourceTimestamp === undefined || source.source_timestamp === expected.sourceTimestamp);

    if (!exact) {
      throw new MemoryExtractionError(
        'Deterministic extraction effect conflicts with existing durable state',
        'MEMORY_EFFECT_CONFLICT',
        { candidateId: expected.memoryId },
      );
    }

    this.assertReusableDecisionAuthority(expected);

    return true;
  }

  private assertReusableDecisionAuthority(
    expected: ExpectedExtractionEffect,
  ): void {
    const creationEvidence = this.db
      .prepare(
        `SELECT
          (SELECT evaluator_decision_id
             FROM memory_revisions
            WHERE memory_id = ? AND revision_number = 1 AND change_type = 'create') AS revision_decision_id,
          (SELECT new_state
             FROM memory_revisions
            WHERE memory_id = ? AND revision_number = 1 AND change_type = 'create') AS revision_new_state,
          (SELECT evaluator_decision_id
             FROM audit_log
            WHERE event_type = 'memory.create' AND event_id = ?
            ORDER BY timestamp ASC
            LIMIT 1) AS audit_decision_id`
      )
      .get(expected.memoryId, expected.memoryId, expected.memoryId) as {
        revision_decision_id: string | null;
        revision_new_state: string | null;
        audit_decision_id: string | null;
      };
    const evaluatorDecisionId = creationEvidence.revision_decision_id;
    const creationSnapshot = readCreationSnapshot(creationEvidence.revision_new_state);

    if (
      !evaluatorDecisionId
      || creationEvidence.audit_decision_id !== evaluatorDecisionId
      || creationSnapshot?.evaluatorDecisionId !== evaluatorDecisionId
    ) {
      this.throwEffectConflict(expected.memoryId);
    }

    if (
      evaluatorDecisionId
        === `policy:l0:${creationSnapshot.state}:${expected.memoryId}`
    ) {
      return;
    }

    if (!expected.jobAttemptId || !expected.sourceRawEventId) {
      this.throwEffectConflict(expected.memoryId);
    }

    const authority = this.db
      .prepare(
        `SELECT
          ed.domain,
          ed.turn_id,
          ed.job_attempt_id,
          ed.actor_user_id,
          ed.actor_class,
          ed.invocation_context,
          ed.source_event_ids,
          owner_attempt.job_id AS owner_job_id,
          current_attempt.job_id AS current_job_id,
          current_attempt.status AS current_attempt_status,
          current_job.type AS current_job_type,
          current_job.payload AS current_job_payload
         FROM evaluator_decisions ed
         LEFT JOIN job_attempts owner_attempt ON owner_attempt.id = ed.job_attempt_id
         LEFT JOIN job_attempts current_attempt ON current_attempt.id = ?
         LEFT JOIN jobs current_job ON current_job.id = current_attempt.job_id
         WHERE ed.id = ?`
      )
      .get(expected.jobAttemptId, evaluatorDecisionId) as {
        domain: string;
        turn_id: string | null;
        job_attempt_id: string | null;
        actor_user_id: string | null;
        actor_class: string;
        invocation_context: string;
        source_event_ids: string;
        owner_job_id: string | null;
        current_job_id: string | null;
        current_attempt_status: string | null;
        current_job_type: string | null;
        current_job_payload: string | null;
      } | undefined;
    const payload = readExtractionJobPayload(authority?.current_job_payload);
    const sourceEventIds = readStringArray(authority?.source_event_ids);

    if (
      !authority
      || authority.domain !== 'memory'
      || authority.turn_id !== null
      || !authority.job_attempt_id
      || authority.actor_user_id !== expected.userId
      || authority.actor_class !== 'system_worker'
      || authority.invocation_context !== 'background_worker'
      || authority.owner_job_id !== authority.current_job_id
      || authority.current_attempt_status !== 'running'
      || authority.current_job_type !== 'extraction'
      || payload?.sourceChatMessageId !== expected.sourceId
      || payload.targetUserId !== expected.userId
      || sourceEventIds.length !== 1
      || sourceEventIds[0] !== expected.sourceRawEventId
    ) {
      this.throwEffectConflict(expected.memoryId);
    }
  }

  private throwEffectConflict(memoryId: string): never {
    throw new MemoryExtractionError(
      'Deterministic extraction effect conflicts with existing durable state',
      'MEMORY_EFFECT_CONFLICT',
      { candidateId: memoryId },
    );
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
      logger.error({
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorCode: 'USER_CREATE_FAILED',
      }, 'Failed to ensure user exists');
      throw new MemoryExtractionError(
        'Failed to create user',
        'USER_CREATE_FAILED',
        { userId, causeName: error instanceof Error ? error.name : 'UnknownError' }
      );
    }
  }
}

function buildExtractionMemoryId(input: {
  sourceId: string;
  userId: string;
  kind: 'preference' | 'fact';
  content: string;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'memory-extraction-v1',
      input.sourceId,
      input.userId,
      'user',
      input.kind,
      input.content,
    ]))
    .digest('hex');
  return `extraction-v1-${digest}`;
}

function isDeterministicExtractionRejection(code: string): boolean {
  return code === 'MEMORY_POLICY_REJECTED'
    || code === 'MEMORY_REJECTED'
    || code === 'MEMORY_REJECTED_REPLAY';
}

function readCreationSnapshot(value: string | null): {
  state: string;
  evaluatorDecisionId: string;
} | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== 'object'
      || parsed === null
      || !('state' in parsed)
      || !('evaluatorDecisionId' in parsed)
      || typeof parsed.state !== 'string'
      || typeof parsed.evaluatorDecisionId !== 'string'
    ) {
      return undefined;
    }
    return {
      state: parsed.state,
      evaluatorDecisionId: parsed.evaluatorDecisionId,
    };
  } catch {
    return undefined;
  }
}

function readExtractionJobPayload(value: string | null | undefined): {
  sourceChatMessageId: string;
  targetUserId: string;
} | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== 2
      || keys[0] !== 'sourceChatMessageId'
      || keys[1] !== 'targetUserId'
    ) {
      return undefined;
    }
    const sourceChatMessageId = 'sourceChatMessageId' in parsed
      ? parsed.sourceChatMessageId
      : undefined;
    const targetUserId = 'targetUserId' in parsed ? parsed.targetUserId : undefined;
    if (typeof sourceChatMessageId !== 'string' || typeof targetUserId !== 'string') {
      return undefined;
    }
    return { sourceChatMessageId, targetUserId };
  } catch {
    return undefined;
  }
}

function readStringArray(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}
