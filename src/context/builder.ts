/**
 * Context Builder
 *
 * 构建 ContextPack，应用内存可见性过滤
 */

import { ulid } from 'ulidx';
import type {
  ContextPack,
  MemoryBlock,
  MemoryQuerySource,
  MemoryRetrievalMethod,
  MemoryScopeAffinity,
  MemorySelectionEvidence,
  MessageRef,
  ParticipantContext,
  RecentMessage,
  ReplyReference,
  SpeakerRef,
} from '../types/context.js';
import type { MemoryFilters, MemoryRepository } from '../storage/memory-repository.js';
import type { IdentityRepository } from '../storage/identity-repository.js';
import type { MemoryRecord } from '../types/memory.js';
import type Database from 'better-sqlite3';
import { redactSecretsInText, scanMemoryForSecrets } from '../memory/secret-scan.js';
import { toSafeMemoryFtsQuery } from '../memory/fts-query.js';

export interface BuildContextInput {
  turnId?: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  recentMessages?: RecentMessage[];
  participants?: ParticipantContext[];
  targetUserId?: string;
  canonicalUserId?: string;
  groupId?: string;
  messageLimit?: number;
  db?: Database.Database;
  includeMemory?: boolean;
  currentMessageId?: string;
  replyToMessageId?: string;
}

interface MemoryRetrievalResult {
  selected: MemoryRecord[];
  rankings: Map<string, MemoryRanking>;
  candidateMemoryIds: string[];
  rejectedMemories: Array<{
    memoryId: string;
    reason: string;
  }>;
  filtersApplied: string[];
}

interface MemoryQuery {
  source: MemoryQuerySource;
  ftsQuery: string;
}

interface MemoryRanking {
  querySources: Set<MemoryQuerySource>;
  retrievalMethods: Set<MemoryRetrievalMethod>;
  scopeAffinity: MemoryScopeAffinity;
  ftsOrdinal?: number;
}

interface IdentityBudgetField {
  name: string;
  value: string;
}

interface BudgetSelectionResult {
  recentMessages: RecentMessage[];
  memories: MemoryRecord[];
  participants: ParticipantContext[];
  currentMessageRef?: MessageRef;
  replyReference?: ReplyReference;
  tokenBudget: ContextPack['tokenBudget'];
  rejectedMemories: MemoryRetrievalResult['rejectedMemories'];
  filtersApplied: string[];
}

interface StoredChatMessageRow {
  id: string;
  sender_id: string;
  sender_role: 'member' | 'admin' | 'owner' | null;
  text: string | null;
  timestamp: number;
  raw_source: string | null;
}

interface ResolvedMessageIdentity {
  identityKey: string;
  canonicalUserId?: string;
  displayName: string;
  role?: 'member' | 'admin' | 'owner';
}

interface ReplyResolution {
  status: 'resolved' | 'unresolved';
  targetMessageId?: string;
  targetInRollingWindow?: boolean;
}

interface MaterializedReferenceContext {
  recentMessages: RecentMessage[];
  participants: ParticipantContext[];
  currentMessageRef?: MessageRef;
  replyReference?: ReplyReference;
}

export class ContextBuilder {
  private memoryRepo: MemoryRepository;
  private identityRepo: IdentityRepository;
  private db?: Database.Database;

  constructor(
    memoryRepo: MemoryRepository,
    identityRepo: IdentityRepository,
    db?: Database.Database
  );
  constructor(
    db: Database.Database,
    memoryRepo: MemoryRepository,
    identityRepo: IdentityRepository
  );
  constructor(
    first: MemoryRepository | Database.Database,
    second: IdentityRepository | MemoryRepository,
    third?: Database.Database | IdentityRepository
  ) {
    if (this.isDatabase(first)) {
      this.db = first;
      this.memoryRepo = second as MemoryRepository;
      this.identityRepo = third as IdentityRepository;
    } else {
      this.memoryRepo = first;
      this.identityRepo = second as IdentityRepository;
      this.db = third as Database.Database | undefined;
    }
  }

  private isDatabase(value: unknown): value is Database.Database {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as { prepare?: unknown };
    return typeof candidate.prepare === 'function';
  }

  /**
   * 获取身份仓库（预留给未来使用）
   */
  getIdentityRepo(): IdentityRepository {
    return this.identityRepo;
  }

  /**
   * 从数据库加载最近的聊天消息
   */
  private async loadRecentMessages(
    conversationId: string,
    conversationType: 'private' | 'group',
    groupId: string | undefined,
    limit: number = 20
  ): Promise<RecentMessage[]> {
    if (!this.db) {
      return [];
    }

    const groupFilter = conversationType === 'group' && groupId !== undefined
      ? 'AND cm.group_id = ?'
      : 'AND cm.group_id IS NULL';
    const parameters = conversationType === 'group' && groupId !== undefined
      ? [conversationId, conversationType, groupId, limit]
      : [conversationId, conversationType, limit];
    const rows = this.db.prepare(`
      SELECT
        cm.id,
        cm.sender_id,
        cm.sender_role,
        cm.text,
        cm.timestamp,
        re.source as raw_source
      FROM chat_messages cm
      LEFT JOIN raw_events re ON re.id = cm.raw_event_id
      WHERE cm.conversation_id = ?
        AND cm.conversation_type = ?
        ${groupFilter}
      ORDER BY cm.timestamp DESC, cm.rowid DESC
      LIMIT ?
    `).all(...parameters) as StoredChatMessageRow[];

    // 反转顺序，使最旧的消息在前
    return rows.reverse().map((row) => this.storedRowToRecentMessage(row));
  }

  private loadReplyTarget(input: {
    platformMessageId: string;
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
  }): RecentMessage[] {
    if (!this.db || (input.conversationType === 'group' && input.groupId === undefined)) {
      return [];
    }

    const groupFilter = input.conversationType === 'group'
      ? 'AND cm.group_id = ?'
      : 'AND cm.group_id IS NULL';
    const parameters = input.conversationType === 'group'
      ? [
          input.platformMessageId,
          input.conversationId,
          input.conversationType,
          input.groupId,
        ]
      : [
          input.platformMessageId,
          input.conversationId,
          input.conversationType,
        ];
    const rows = this.db.prepare(`
      SELECT
        cm.id,
        cm.sender_id,
        cm.sender_role,
        cm.text,
        cm.timestamp,
        re.source as raw_source
      FROM chat_messages cm
      LEFT JOIN raw_events re ON re.id = cm.raw_event_id
      WHERE cm.message_id = ?
        AND cm.conversation_id = ?
        AND cm.conversation_type = ?
        ${groupFilter}
      ORDER BY cm.timestamp DESC, cm.rowid DESC
      LIMIT 2
    `).all(...parameters) as StoredChatMessageRow[];

    return rows.map((row) => this.storedRowToRecentMessage(row));
  }

  private storedRowToRecentMessage(row: StoredChatMessageRow): RecentMessage {
    const isFromBot = this.isBotSender(row.sender_id, row.raw_source);

    return {
      messageId: row.id,
      senderId: this.normalizeSenderId(row.sender_id, isFromBot),
      senderDisplayName: isFromBot ? 'LetheBot' : 'unknown',
      text: row.text ?? undefined,
      timestamp: new Date(row.timestamp),
      isFromBot,
      ...(row.sender_role === null ? {} : { senderRole: row.sender_role }),
    };
  }

  async build(input: BuildContextInput): Promise<ContextPack> {
    return this.buildContext(input);
  }

  async buildContext(input: BuildContextInput): Promise<ContextPack> {
    const {
      conversationId,
      conversationType,
      groupId,
      messageLimit = 20,
    } = input;
    const turnId = input.turnId ?? ulid();
    const targetUserId = input.targetUserId ?? input.canonicalUserId;
    const participants = input.participants ?? [];

    const suppliedRecentMessages = input.recentMessages ?? [];
    const suppliedMessageIds = new Set(
      suppliedRecentMessages.map((message) => message.messageId)
    );
    const persistedMessageIds = new Set<string>();
    const rollingMessageIds = new Set<string>();

    // 从数据库加载历史消息（如果有数据库连接）
    let recentMessages: RecentMessage[];
    if (this.db) {
      const loadedMessages = await this.loadRecentMessages(
        conversationId,
        conversationType,
        groupId,
        messageLimit,
      );
      for (const message of loadedMessages) {
        persistedMessageIds.add(message.messageId);
        rollingMessageIds.add(message.messageId);
      }
      recentMessages = [
        ...loadedMessages.filter((message) => !suppliedMessageIds.has(message.messageId)),
        ...suppliedRecentMessages,
      ];
    } else {
      // 无数据库连接时使用传入的消息
      recentMessages = suppliedRecentMessages;
    }

    let replyResolution: ReplyResolution | undefined;
    if (input.replyToMessageId !== undefined) {
      const targetMatches = this.loadReplyTarget({
        platformMessageId: input.replyToMessageId,
        conversationId,
        conversationType,
        groupId,
      });
      if (targetMatches.length === 1 && targetMatches[0]) {
        const target = targetMatches[0];
        const targetInRollingWindow = rollingMessageIds.has(target.messageId);
        replyResolution = {
          status: 'resolved',
          targetMessageId: target.messageId,
          targetInRollingWindow,
        };
        persistedMessageIds.add(target.messageId);
        if (!recentMessages.some((message) => message.messageId === target.messageId)) {
          recentMessages = [target, ...recentMessages];
        }
      } else {
        replyResolution = { status: 'unresolved' };
      }
    }

    const currentMessageId = this.resolveCurrentMessageId(
      recentMessages,
      input.currentMessageId,
    );
    const memoryQueries = this.buildMemoryQueries(
      recentMessages,
      currentMessageId,
      replyResolution,
    );
    const messageIdentities = await this.resolveMessageIdentities({
      messages: recentMessages,
      conversationType,
      groupId,
      persistedMessageIds,
      suppliedMessageIds,
    });

    // 检索记忆（带可见性过滤）
    const memoryRetrieval = input.includeMemory === false
      ? {
          selected: [],
          rankings: new Map<string, MemoryRanking>(),
          candidateMemoryIds: [],
          rejectedMemories: [],
          filtersApplied: [],
        }
      : await this.retrieveMemory(
          targetUserId,
          conversationType,
          groupId,
          conversationId,
          memoryQueries,
        );
    const identityBudgetFields = this.buildIdentityBudgetFields({
      conversationId,
      conversationType,
      groupId,
      targetUserId,
    });
    const budgetSelection = this.applyTokenBudget({
      recentMessages,
      memories: memoryRetrieval.selected,
      identityFields: identityBudgetFields,
      participants,
      conversationType,
      currentMessageId,
      replyResolution,
      messageIdentities,
      memoryRankings: memoryRetrieval.rankings,
    });
    const retrievedFacts = budgetSelection.memories;
    const memoryBlocks = this.toMemoryBlocks(retrievedFacts);
    const selectedMemoryIds = retrievedFacts.map((memory) => memory.id);
    const rankedMemoryIds = this.orderMemoriesForBudget(
      memoryRetrieval.selected,
      memoryRetrieval.rankings,
    ).map((memory) => memory.id);
    const retrievalRanks = new Map(
      rankedMemoryIds.map((memoryId, index) => [memoryId, index + 1]),
    );
    const priorityProfileIds = this.getPriorityProfileIds(memoryRetrieval.selected);
    const memorySelections = retrievedFacts.map((memory) => this.toMemorySelectionEvidence(
      memory,
      memoryRetrieval.rankings,
      retrievalRanks,
      priorityProfileIds,
    ));
    const injectedIdentityFields = this.buildInjectedIdentityFields({
      ...input,
      participants: budgetSelection.participants,
    });
    if (budgetSelection.currentMessageRef !== undefined) {
      injectedIdentityFields.push('message_reference_context');
    }
    if (budgetSelection.replyReference !== undefined) {
      injectedIdentityFields.push('reply_reference');
    }
    const memoryFilters = input.includeMemory === false
      ? ['memory=excluded_by_caller']
      : [
          'state=active',
          'sensitivity!=secret/prohibited',
          `contextType=${conversationType}`,
          'visibility_scope_filter',
          ...memoryRetrieval.filtersApplied,
        ];

    const context: ContextPack = {
      id: ulid(),
      turnId,
      createdAt: new Date(),
      conversation: {
        conversationId,
        conversationType,
        groupId,
      },
      recentMessages: budgetSelection.recentMessages,
      ...(budgetSelection.currentMessageRef === undefined
        ? {}
        : { currentMessageRef: budgetSelection.currentMessageRef }),
      ...(budgetSelection.replyReference === undefined
        ? {}
        : { replyReference: budgetSelection.replyReference }),
      memory: {
        userProfile: memoryBlocks.find((mem) => mem.scope === 'user' && mem.kind === 'summary'),
        groupProfile: memoryBlocks.find((mem) => mem.scope === 'group' && mem.kind === 'summary'),
        retrievedFacts: memoryBlocks,
        selectedMemoryIds,
      },
      participants: budgetSelection.participants,
      injectedIdentityFields,
      injectedIdentityData: identityBudgetFields,
      tokenBudget: budgetSelection.tokenBudget,
      trace: {
        candidateMemoryIds: memoryRetrieval.candidateMemoryIds,
        selectedMemoryIds,
        rejectedMemories: [
          ...memoryRetrieval.rejectedMemories,
          ...budgetSelection.rejectedMemories,
        ],
        memorySelections,
        filtersApplied: [
          ...memoryFilters,
          ...budgetSelection.filtersApplied,
        ],
      },
    };

    return context;
  }

  private resolveCurrentMessageId(
    messages: RecentMessage[],
    explicitCurrentMessageId?: string,
  ): string | undefined {
    if (explicitCurrentMessageId !== undefined) {
      if (!messages.some((message) => message.messageId === explicitCurrentMessageId)) {
        throw new Error('Explicit current message is unavailable in this conversation');
      }
      return explicitCurrentMessageId;
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && !message.isFromBot) {
        return message.messageId;
      }
    }

    return undefined;
  }

  private async resolveMessageIdentities(input: {
    messages: RecentMessage[];
    conversationType: 'private' | 'group';
    groupId?: string;
    persistedMessageIds: Set<string>;
    suppliedMessageIds: Set<string>;
  }): Promise<Map<string, ResolvedMessageIdentity>> {
    const identities = new Map<string, ResolvedMessageIdentity>();

    for (const message of input.messages) {
      if (message.isFromBot) {
        identities.set(message.messageId, {
          identityKey: 'bot:self',
          displayName: 'LetheBot',
        });
        continue;
      }

      let canonicalUserId: string | undefined;
      if (message.senderId.startsWith('user-')) {
        canonicalUserId = message.senderId;
      } else {
        const platformAccountId = message.senderId.startsWith('qq-')
          ? message.senderId.slice(3)
          : message.senderId;
        canonicalUserId = await this.identityRepo.findCanonicalUserId('qq', platformAccountId)
          ?? undefined;
      }

      const exactDisplayProfile = canonicalUserId === undefined
        || (input.conversationType === 'group' && input.groupId === undefined)
        ? null
        : await this.identityRepo.getDisplayProfile(
            canonicalUserId,
            input.conversationType === 'group' ? input.groupId : undefined,
          );
      const mayUseSuppliedDisplay = input.suppliedMessageIds.has(message.messageId)
        || !input.persistedMessageIds.has(message.messageId);
      const suppliedDisplayName = mayUseSuppliedDisplay
        && message.senderDisplayName.trim().length > 0
        && message.senderDisplayName !== message.senderId
        ? message.senderDisplayName
        : undefined;
      const displayName = exactDisplayProfile?.currentDisplayName
        || suppliedDisplayName
        || 'unknown';
      const identityKey = canonicalUserId !== undefined
        ? `canonical:${canonicalUserId}`
        : message.senderId === 'unknown' || message.senderId === 'qq-unknown'
          ? `unresolved-message:${message.messageId}`
          : `sender:${message.senderId}`;

      identities.set(message.messageId, {
        identityKey,
        ...(canonicalUserId === undefined ? {} : { canonicalUserId }),
        displayName,
        ...(message.senderRole === undefined ? {} : { role: message.senderRole }),
      });
    }

    return identities;
  }

  /**
   * 检索记忆并应用可见性过滤
   */
  private buildMemoryQueries(
    messages: RecentMessage[],
    currentMessageId: string | undefined,
    replyResolution: ReplyResolution | undefined,
  ): MemoryQuery[] {
    const queries: MemoryQuery[] = [];
    const addQuery = (source: MemoryQuerySource, text: string | undefined): void => {
      const ftsQuery = text === undefined ? undefined : toSafeMemoryFtsQuery(text);
      if (ftsQuery !== undefined) {
        queries.push({ source, ftsQuery });
      }
    };

    const currentMessage = currentMessageId === undefined
      ? undefined
      : messages.find((message) => message.messageId === currentMessageId);
    addQuery('current_message', currentMessage?.text);

    const quotedMessageId = replyResolution?.status === 'resolved'
      ? replyResolution.targetMessageId
      : undefined;
    const quotedMessage = quotedMessageId === undefined
      ? undefined
      : messages.find((message) => message.messageId === quotedMessageId);
    addQuery('quoted_message', quotedMessage?.text);

    const recentThread = messages
      .filter((message) => (
        message.messageId !== currentMessageId
        && message.messageId !== quotedMessageId
        && message.text !== undefined
      ))
      .slice()
      .reverse()
      .map((message) => message.text)
      .join('\n');
    addQuery('recent_thread', recentThread);

    return queries;
  }

  private async retrieveMemory(
    userId: string | undefined,
    conversationType: 'private' | 'group',
    groupId: string | undefined,
    conversationId: string,
    memoryQueries: MemoryQuery[] = [],
  ): Promise<MemoryRetrievalResult> {
    const allMemories = new Map<string, MemoryRecord>();
    const rankings = new Map<string, MemoryRanking>();
    const groupSummaryPolicyDisabled = conversationType === 'group'
      && groupId !== undefined
      && !this.memoryRepo.isGroupSummaryPolicyEnabled(groupId);
    const blockedGroupSummaryIds = groupSummaryPolicyDisabled
      ? await this.memoryRepo.listPolicyBlockedGroupSummaryIds({
          groupId,
          contextType: 'group',
        })
      : [];

    const routes = this.buildMemoryFilterRoutes(
      userId,
      conversationType,
      groupId,
      conversationId,
    );
    const recordMemories = (
      memories: MemoryRecord[],
      method: MemoryRetrievalMethod,
      querySource?: MemoryQuerySource,
    ): void => {
      memories.forEach((memory, index) => {
        allMemories.set(memory.id, memory);
        const ranking = rankings.get(memory.id) ?? {
          querySources: new Set<MemoryQuerySource>(),
          retrievalMethods: new Set<MemoryRetrievalMethod>(),
          scopeAffinity: this.memoryScopeAffinity(memory, userId, groupId, conversationId),
        };
        ranking.retrievalMethods.add(method);
        if (querySource !== undefined) {
          ranking.querySources.add(querySource);
          const ordinal = index + 1;
          ranking.ftsOrdinal = ranking.ftsOrdinal === undefined
            ? ordinal
            : Math.min(ranking.ftsOrdinal, ordinal);
        }
        rankings.set(memory.id, ranking);
      });
    };

    for (const route of routes) {
      recordMemories(await this.memoryRepo.retrieve(route), 'scoped_rank');
      if (route.contextType !== undefined) {
        for (const query of memoryQueries) {
          recordMemories(
            await this.memoryRepo.search(query.ftsQuery, route),
            'fts',
            query.source,
          );
        }
      }
    }

    // 应用可见性过滤
    const selected: MemoryRecord[] = [];
    const blockedGroupSummaryIdSet = new Set(blockedGroupSummaryIds);
    const rejectedMemories: MemoryRetrievalResult['rejectedMemories'] = blockedGroupSummaryIds
      .map((memoryId) => ({ memoryId, reason: 'group_summary_policy_disabled' }));

    for (const mem of allMemories.values()) {
      if (blockedGroupSummaryIdSet.has(mem.id)) {
        continue;
      }
      const rejectionReason = this.getMemoryRejectionReason(
        mem,
        userId,
        conversationType,
        groupId,
        conversationId
      );

      if (rejectionReason) {
        rejectedMemories.push({ memoryId: mem.id, reason: rejectionReason });
      } else {
        selected.push(mem);
      }
    }

    selected.sort((a, b) => this.compareMemoryRankings(a, b, rankings));

    return {
      selected,
      rankings,
      candidateMemoryIds: [
        ...allMemories.keys(),
        ...blockedGroupSummaryIds.filter((memoryId) => !allMemories.has(memoryId)),
      ],
      rejectedMemories,
      filtersApplied: [
        ...(groupSummaryPolicyDisabled ? ['group_summary_policy=disabled'] : []),
        ...(memoryQueries.length > 0 ? ['memory_ranking=query_fts_scope_recency_v1'] : []),
      ],
    };
  }

  private buildMemoryFilterRoutes(
    userId: string | undefined,
    conversationType: 'private' | 'group',
    groupId: string | undefined,
    conversationId: string,
  ): MemoryFilters[] {
    const routes: MemoryFilters[] = [];

    if (userId) {
      routes.push({ canonicalUserId: userId, state: 'active', contextType: conversationType });
      if (groupId) {
        routes.push({
          canonicalUserId: userId,
          state: 'active',
          contextType: conversationType,
          groupId,
        });
      }
      if (conversationId) {
        routes.push({
          canonicalUserId: userId,
          state: 'active',
          contextType: conversationType,
          conversationId,
        });
      }
      routes.push({ canonicalUserId: userId, state: 'active' });
    }
    if (conversationId) {
      routes.push({
        scope: 'conversation',
        conversationId,
        state: 'active',
        contextType: conversationType,
      });
    }
    if (groupId) {
      routes.push({
        scope: 'group',
        groupId,
        state: 'active',
        contextType: conversationType,
      });
    }

    routes.push({ scope: 'global', state: 'active', contextType: conversationType });
    if (groupId) {
      routes.push({
        scope: 'global',
        state: 'active',
        contextType: conversationType,
        groupId,
      });
    }
    if (conversationId) {
      routes.push({
        scope: 'global',
        state: 'active',
        contextType: conversationType,
        conversationId,
      });
    }
    routes.push({ scope: 'global', state: 'active' });

    return routes;
  }

  private applyTokenBudget(input: {
    recentMessages: RecentMessage[];
    memories: MemoryRecord[];
    identityFields: IdentityBudgetField[];
    participants: ParticipantContext[];
    conversationType: 'private' | 'group';
    currentMessageId?: string;
    replyResolution?: ReplyResolution;
    messageIdentities: Map<string, ResolvedMessageIdentity>;
    memoryRankings: Map<string, MemoryRanking>;
  }): BudgetSelectionResult {
    const selectedMessages: Array<{ index: number; message: RecentMessage }> = [];
    const selectedMemories: MemoryRecord[] = [];
    const rejectedMemories: MemoryRetrievalResult['rejectedMemories'] = [];
    const rejectedMemoryIds = new Set<string>();
    const filtersApplied: string[] = [];

    const materializeSelection = (
      messages = selectedMessages,
    ): MaterializedReferenceContext => this.materializeReferenceContext({
      messages: messages
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.message),
      suppliedParticipants: input.participants,
      conversationType: input.conversationType,
      currentMessageId: input.currentMessageId,
      replyResolution: input.replyResolution,
      messageIdentities: input.messageIdentities,
      includeSuppliedParticipantsWithoutMessages: input.recentMessages.length === 0,
    });
    const calculateSelection = (
      messages = selectedMessages,
      memories = selectedMemories,
    ): ContextPack['tokenBudget'] => {
      const materialized = materializeSelection(messages);
      return this.calculateTokenBudget(
        materialized.recentMessages,
        this.toMemoryBlocks(memories),
        input.identityFields,
        materialized.participants,
        input.conversationType,
        materialized.currentMessageRef,
        materialized.replyReference,
      );
    };
    const rejectMemory = (memory: MemoryRecord): void => {
      if (!rejectedMemoryIds.has(memory.id)) {
        rejectedMemoryIds.add(memory.id);
        rejectedMemories.push({ memoryId: memory.id, reason: 'token_budget_exceeded' });
      }
    };

    let tokenBudget = calculateSelection();
    if (tokenBudget.used > tokenBudget.max) {
      throw new Error('Context token budget cannot fit fixed system and identity layers');
    }

    const currentMessageIndex = input.currentMessageId === undefined
      ? -1
      : input.recentMessages.findIndex(
          (message) => message.messageId === input.currentMessageId
        );
    if (currentMessageIndex >= 0) {
      const currentMessage = input.recentMessages[currentMessageIndex];
      if (!currentMessage) {
        throw new Error('Current message disappeared during context budgeting');
      }

      const fullSelection = [
        ...selectedMessages,
        { index: currentMessageIndex, message: currentMessage },
      ];
      const fullBudget = calculateSelection(fullSelection);
      if (fullBudget.used <= fullBudget.max) {
        selectedMessages.push({ index: currentMessageIndex, message: currentMessage });
        tokenBudget = fullBudget;
      } else {
        const truncatedMessage = this.truncateMessageToFit(
          currentMessage,
          (message) => calculateSelection([
            ...selectedMessages,
            { index: currentMessageIndex, message },
          ]).used <= tokenBudget.max,
        );
        if (!truncatedMessage) {
          throw new Error('Context token budget cannot retain the current message');
        }
        selectedMessages.push({ index: currentMessageIndex, message: truncatedMessage });
        tokenBudget = calculateSelection();
        filtersApplied.push('token_budget:latest_user_message_truncated');
      }
    }

    const quoteTargetIndex = input.replyResolution?.status === 'resolved'
      && input.replyResolution.targetMessageId !== undefined
      ? input.recentMessages.findIndex(
          (message) => message.messageId === input.replyResolution?.targetMessageId
        )
      : -1;
    if (quoteTargetIndex >= 0 && quoteTargetIndex !== currentMessageIndex) {
      const quoteTarget = input.recentMessages[quoteTargetIndex];
      if (!quoteTarget) {
        throw new Error('Quote target disappeared during context budgeting');
      }

      const fullSelection = [
        ...selectedMessages,
        { index: quoteTargetIndex, message: quoteTarget },
      ];
      const fullBudget = calculateSelection(fullSelection);
      if (fullBudget.used <= fullBudget.max) {
        selectedMessages.push({ index: quoteTargetIndex, message: quoteTarget });
        tokenBudget = fullBudget;
      } else {
        const truncatedTarget = this.truncateMessageToFit(
          quoteTarget,
          (message) => calculateSelection([
            ...selectedMessages,
            { index: quoteTargetIndex, message },
          ]).used <= tokenBudget.max,
        );
        if (truncatedTarget) {
          selectedMessages.push({ index: quoteTargetIndex, message: truncatedTarget });
          tokenBudget = calculateSelection();
          filtersApplied.push('token_budget:quote_target_truncated');
        } else {
          const selectedCurrentIndex = selectedMessages.findIndex(
            (entry) => entry.index === currentMessageIndex
          );
          const selectedCurrent = selectedMessages[selectedCurrentIndex];
          if (!selectedCurrent) {
            throw new Error('Context token budget cannot retain the quote target');
          }

          const minimalTarget = {
            ...quoteTarget,
            ...(quoteTarget.text === undefined ? {} : { text: ' [truncated]' }),
          };
          const withoutCurrent = selectedMessages.filter(
            (_entry, index) => index !== selectedCurrentIndex
          );
          const retruncatedCurrent = this.truncateMessageToFit(
            selectedCurrent.message,
            (message) => calculateSelection([
              ...withoutCurrent,
              { index: currentMessageIndex, message },
              { index: quoteTargetIndex, message: minimalTarget },
            ]).used <= tokenBudget.max,
          );
          if (!retruncatedCurrent) {
            throw new Error('Context token budget cannot retain current and quoted messages');
          }
          selectedMessages[selectedCurrentIndex] = {
            index: currentMessageIndex,
            message: retruncatedCurrent,
          };
          selectedMessages.push({ index: quoteTargetIndex, message: minimalTarget });
          tokenBudget = calculateSelection();
          if (!filtersApplied.includes('token_budget:latest_user_message_truncated')) {
            filtersApplied.push('token_budget:latest_user_message_truncated');
          }
          filtersApplied.push('token_budget:quote_target_truncated');
        }
      }
    }

    const prioritizedProfiles = this.getPriorityProfiles(input.memories);
    const handledProfileIds = new Set(prioritizedProfiles.map((memory) => memory.id));

    for (const memory of prioritizedProfiles) {
      const candidateMemories = [...selectedMemories, memory];
      const candidateBudget = calculateSelection(
        selectedMessages,
        candidateMemories,
      );
      if (candidateBudget.used <= candidateBudget.max) {
        selectedMemories.push(memory);
        tokenBudget = candidateBudget;
      } else {
        rejectMemory(memory);
      }
    }

    const requiredMessageIndexes = new Set([currentMessageIndex, quoteTargetIndex]);
    for (let index = input.recentMessages.length - 1; index >= 0; index -= 1) {
      if (requiredMessageIndexes.has(index)) {
        continue;
      }
      const message = input.recentMessages[index];
      if (!message) {
        continue;
      }

      const candidateMessages = [...selectedMessages, { index, message }];
      const candidateBudget = calculateSelection(
        candidateMessages,
        selectedMemories,
      );
      if (candidateBudget.used > candidateBudget.max) {
        break;
      }
      selectedMessages.push({ index, message });
      tokenBudget = candidateBudget;
    }

    const remainingMemories = this.orderMemoriesForBudget(
      input.memories,
      input.memoryRankings,
    )
      .filter((memory) => !handledProfileIds.has(memory.id));
    for (const memory of remainingMemories) {
      const candidateMemories = [...selectedMemories, memory];
      const candidateBudget = calculateSelection(
        selectedMessages,
        candidateMemories,
      );
      if (candidateBudget.used <= candidateBudget.max) {
        selectedMemories.push(memory);
        tokenBudget = candidateBudget;
      } else {
        rejectMemory(memory);
      }
    }

    const selectedMemoryIds = new Set(selectedMemories.map((memory) => memory.id));
    for (const memory of input.memories) {
      if (!selectedMemoryIds.has(memory.id) && !rejectedMemoryIds.has(memory.id)) {
        rejectMemory(memory);
      }
    }

    const materialized = materializeSelection();
    const recentMessagesOmitted = input.recentMessages.length
      - materialized.recentMessages.length;
    if (recentMessagesOmitted > 0) {
      filtersApplied.push(`token_budget:recent_messages_omitted=${recentMessagesOmitted}`);
    }
    const suppliedParticipantRefs = new Set(
      materialized.participants
        .map((participant) => participant.canonicalUserId)
        .filter((canonicalUserId): canonicalUserId is string => canonicalUserId !== undefined)
    );
    const participantsOmitted = input.participants.filter((participant) => (
      participant.canonicalUserId === undefined
      || !suppliedParticipantRefs.has(participant.canonicalUserId)
    )).length;
    if (participantsOmitted > 0 && input.recentMessages.length > 0) {
      filtersApplied.push(`token_budget:participants_omitted=${participantsOmitted}`);
    }

    tokenBudget = this.calculateTokenBudget(
      materialized.recentMessages,
      this.toMemoryBlocks(selectedMemories),
      input.identityFields,
      materialized.participants,
      input.conversationType,
      materialized.currentMessageRef,
      materialized.replyReference,
    );
    if (tokenBudget.used > tokenBudget.max) {
      throw new Error('Context token budget selection exceeded its estimator maximum');
    }

    return {
      recentMessages: materialized.recentMessages,
      memories: selectedMemories,
      participants: materialized.participants,
      ...(materialized.currentMessageRef === undefined
        ? {}
        : { currentMessageRef: materialized.currentMessageRef }),
      ...(materialized.replyReference === undefined
        ? {}
        : { replyReference: materialized.replyReference }),
      tokenBudget,
      rejectedMemories,
      filtersApplied,
    };
  }

  private materializeReferenceContext(input: {
    messages: RecentMessage[];
    suppliedParticipants: ParticipantContext[];
    conversationType: 'private' | 'group';
    currentMessageId?: string;
    replyResolution?: ReplyResolution;
    messageIdentities: Map<string, ResolvedMessageIdentity>;
    includeSuppliedParticipantsWithoutMessages: boolean;
  }): MaterializedReferenceContext {
    const speakerRefs = new Map<string, SpeakerRef>();
    let nextSpeakerRef = 1;
    const recentMessages = input.messages.map((message, index): RecentMessage => {
      const identity = input.messageIdentities.get(message.messageId) ?? {
        identityKey: message.isFromBot ? 'bot:self' : `sender:${message.senderId}`,
        displayName: message.isFromBot ? 'LetheBot' : 'unknown',
      };
      let speakerRef = speakerRefs.get(identity.identityKey);
      if (speakerRef === undefined) {
        speakerRef = `speaker_${nextSpeakerRef}`;
        nextSpeakerRef += 1;
        speakerRefs.set(identity.identityKey, speakerRef);
      }

      return {
        ...message,
        senderDisplayName: identity.displayName,
        messageRef: `message_${index + 1}`,
        speakerRef,
        isCurrent: message.messageId === input.currentMessageId,
      };
    });
    const currentMessage = recentMessages.find((message) => message.isCurrent);
    const currentMessageRef = currentMessage?.messageRef;

    let replyReference: ReplyReference | undefined;
    if (input.replyResolution !== undefined && currentMessageRef !== undefined) {
      const targetMessage = input.replyResolution.targetMessageId === undefined
        ? undefined
        : recentMessages.find(
            (message) => message.messageId === input.replyResolution?.targetMessageId
          );
      if (input.replyResolution.status === 'resolved' && targetMessage) {
        replyReference = {
          status: 'resolved',
          sourceMessageRef: currentMessageRef,
          targetMessageRef: targetMessage.messageRef,
          targetSpeakerRef: targetMessage.speakerRef,
          targetRole: targetMessage.isFromBot ? 'bot' : 'human',
          targetInRollingWindow: input.replyResolution.targetInRollingWindow ?? false,
        };
      } else {
        replyReference = {
          status: 'unresolved',
          sourceMessageRef: currentMessageRef,
        };
      }
    }

    const participants = this.materializeParticipants({
      messages: recentMessages,
      suppliedParticipants: input.suppliedParticipants,
      conversationType: input.conversationType,
      messageIdentities: input.messageIdentities,
      nextSpeakerRef,
      includeSuppliedParticipantsWithoutMessages:
        input.includeSuppliedParticipantsWithoutMessages,
    });

    return {
      recentMessages,
      participants,
      ...(currentMessageRef === undefined ? {} : { currentMessageRef }),
      ...(replyReference === undefined ? {} : { replyReference }),
    };
  }

  private materializeParticipants(input: {
    messages: RecentMessage[];
    suppliedParticipants: ParticipantContext[];
    conversationType: 'private' | 'group';
    messageIdentities: Map<string, ResolvedMessageIdentity>;
    nextSpeakerRef: number;
    includeSuppliedParticipantsWithoutMessages: boolean;
  }): ParticipantContext[] {
    if (input.conversationType !== 'group') {
      return [];
    }

    if (input.messages.length === 0) {
      if (!input.includeSuppliedParticipantsWithoutMessages) {
        return [];
      }
      return input.suppliedParticipants.map((participant, index) => ({
        ...participant,
        speakerRef: `speaker_${input.nextSpeakerRef + index}`,
      }));
    }

    const participants: ParticipantContext[] = [];
    const seenSpeakerRefs = new Set<SpeakerRef>();
    for (const message of input.messages) {
      if (message.isFromBot || message.speakerRef === undefined) {
        continue;
      }
      if (seenSpeakerRefs.has(message.speakerRef)) {
        continue;
      }
      seenSpeakerRefs.add(message.speakerRef);

      const identity = input.messageIdentities.get(message.messageId);
      const supplied = input.suppliedParticipants.find((participant) => {
        if (
          identity?.canonicalUserId !== undefined
          && participant.canonicalUserId === identity.canonicalUserId
        ) {
          return true;
        }
        if (participant.platformAccountId === undefined) {
          return false;
        }
        const normalizedParticipantId = participant.platformAccountId.startsWith('qq-')
          ? participant.platformAccountId
          : `qq-${participant.platformAccountId}`;
        return normalizedParticipantId === message.senderId;
      });
      const role = identity?.role ?? message.senderRole ?? supplied?.role;
      const displayName = identity?.displayName === 'unknown'
        ? supplied?.displayName ?? 'unknown'
        : identity?.displayName ?? supplied?.displayName ?? 'unknown';

      participants.push({
        ...(identity?.canonicalUserId === undefined
          ? supplied?.canonicalUserId === undefined
            ? {}
            : { canonicalUserId: supplied.canonicalUserId }
          : { canonicalUserId: identity.canonicalUserId }),
        speakerRef: message.speakerRef,
        displayName,
        ...(supplied?.groupCard === undefined ? {} : { groupCard: supplied.groupCard }),
        ...(role === undefined ? {} : { role }),
        isOwner: supplied?.isOwner ?? role === 'owner',
        isAdmin: supplied?.isAdmin ?? (role === 'admin' || role === 'owner'),
        isTrusted: supplied?.isTrusted ?? false,
      });
    }

    return participants;
  }

  private truncateMessageToFit(
    message: RecentMessage,
    fits: (candidate: RecentMessage) => boolean,
  ): RecentMessage | undefined {
    const text = message.text ?? '';
    const marker = ' [truncated]';
    let low = 0;
    let high = text.length;
    let best: RecentMessage | undefined;

    while (low <= high) {
      const prefixLength = Math.floor((low + high) / 2);
      const candidate = {
        ...message,
        text: `${text.slice(0, prefixLength)}${marker}`,
      };
      if (fits(candidate)) {
        best = candidate;
        low = prefixLength + 1;
      } else {
        high = prefixLength - 1;
      }
    }

    return best;
  }

  private selectHighestConfidenceProfile(
    memories: MemoryRecord[],
    scope: 'user' | 'group',
  ): MemoryRecord | undefined {
    return memories
      .filter((memory) => memory.scope === scope && memory.kind === 'summary')
      .sort((a, b) => (
        b.confidence - a.confidence
        || b.importance - a.importance
        || b.updatedAt.getTime() - a.updatedAt.getTime()
        || a.id.localeCompare(b.id)
      ))[0];
  }

  private getPriorityProfiles(memories: MemoryRecord[]): MemoryRecord[] {
    return [
      this.selectHighestConfidenceProfile(memories, 'user'),
      this.selectHighestConfidenceProfile(memories, 'group'),
    ].filter((memory): memory is MemoryRecord => memory !== undefined);
  }

  private getPriorityProfileIds(memories: MemoryRecord[]): Set<string> {
    return new Set(this.getPriorityProfiles(memories).map((memory) => memory.id));
  }

  private orderMemoriesForBudget(
    memories: MemoryRecord[],
    rankings: Map<string, MemoryRanking>,
  ): MemoryRecord[] {
    const profiles = this.getPriorityProfiles(memories);
    const profileIds = new Set(profiles.map((memory) => memory.id));
    const remaining = memories
      .filter((memory) => !profileIds.has(memory.id))
      .sort((a, b) => this.compareMemoryRankings(a, b, rankings));
    return [...profiles, ...remaining];
  }

  private compareMemoryRankings(
    a: MemoryRecord,
    b: MemoryRecord,
    rankings: Map<string, MemoryRanking>,
  ): number {
    const aRanking = rankings.get(a.id);
    const bRanking = rankings.get(b.id);
    const queryOrder = this.memoryQueryPriority(bRanking) - this.memoryQueryPriority(aRanking);
    if (queryOrder !== 0) {
      return queryOrder;
    }

    const scopeOrder = this.scopeAffinityPriority(bRanking?.scopeAffinity)
      - this.scopeAffinityPriority(aRanking?.scopeAffinity);
    if (scopeOrder !== 0) {
      return scopeOrder;
    }

    const ftsOrder = (aRanking?.ftsOrdinal ?? Number.MAX_SAFE_INTEGER)
      - (bRanking?.ftsOrdinal ?? Number.MAX_SAFE_INTEGER);
    if (ftsOrder !== 0) {
      return ftsOrder;
    }

    const globalScopeOrder = Number(a.scope === 'global') - Number(b.scope === 'global');
    return globalScopeOrder
      || b.importance - a.importance
      || b.createdAt.getTime() - a.createdAt.getTime()
      || b.confidence - a.confidence
      || a.id.localeCompare(b.id);
  }

  private memoryQueryPriority(ranking: MemoryRanking | undefined): number {
    if (ranking?.querySources.has('current_message')) {
      return 3;
    }
    if (ranking?.querySources.has('quoted_message')) {
      return 2;
    }
    if (ranking?.querySources.has('recent_thread')) {
      return 1;
    }
    return 0;
  }

  private scopeAffinityPriority(scopeAffinity: MemoryScopeAffinity | undefined): number {
    if (scopeAffinity === 'exact_conversation') {
      return 4;
    }
    if (scopeAffinity === 'exact_group') {
      return 3;
    }
    if (scopeAffinity === 'same_user') {
      return 2;
    }
    return scopeAffinity === 'global' ? 1 : 0;
  }

  private memoryScopeAffinity(
    memory: MemoryRecord,
    userId?: string,
    groupId?: string,
    conversationId?: string,
  ): MemoryScopeAffinity {
    if (conversationId !== undefined && memory.conversationId === conversationId) {
      return 'exact_conversation';
    }
    if (groupId !== undefined && memory.groupId === groupId) {
      return 'exact_group';
    }
    if (userId !== undefined && memory.canonicalUserId === userId) {
      return 'same_user';
    }
    if (memory.scope === 'conversation') {
      return 'exact_conversation';
    }
    if (memory.scope === 'group') {
      return 'exact_group';
    }
    if (memory.scope === 'user') {
      return 'same_user';
    }
    return 'global';
  }

  private toMemorySelectionEvidence(
    memory: MemoryRecord,
    rankings: Map<string, MemoryRanking>,
    retrievalRanks: Map<string, number>,
    priorityProfileIds: Set<string>,
  ): MemorySelectionEvidence {
    const ranking = rankings.get(memory.id);
    const retrievalRank = retrievalRanks.get(memory.id);
    if (!ranking || retrievalRank === undefined) {
      throw new Error('Selected memory is missing deterministic ranking evidence');
    }

    const querySourceOrder: MemoryQuerySource[] = [
      'current_message',
      'quoted_message',
      'recent_thread',
    ];
    const retrievalMethodOrder: MemoryRetrievalMethod[] = ['scoped_rank', 'fts'];
    const querySources = querySourceOrder.filter((source) => ranking.querySources.has(source));
    const retrievalMethods = retrievalMethodOrder.filter(
      (method) => ranking.retrievalMethods.has(method),
    );

    return {
      memoryId: memory.id,
      querySources,
      retrievalMethods,
      scopeAffinity: ranking.scopeAffinity,
      retrievalRank,
      selectionReason: priorityProfileIds.has(memory.id)
        ? 'profile_priority'
        : querySources.length > 0
          ? 'query_match'
          : 'ranked_fallback',
    };
  }

  private toMemoryBlocks(memories: MemoryRecord[]): MemoryBlock[] {
    return memories.map((memory) => ({
      id: memory.id,
      memoryId: memory.id,
      kind: memory.kind,
      scope: memory.scope,
      title: memory.title,
      content: memory.content,
      confidence: memory.confidence,
      sourceContext: memory.sourceContext,
    }));
  }

  /**
   * 计算 token 预算
   */
  private calculateTokenBudget(
    recentMessages: RecentMessage[],
    memoryBlocks: MemoryBlock[],
    identityFields: IdentityBudgetField[],
    participants: ParticipantContext[],
    conversationType: 'private' | 'group',
    currentMessageRef?: MessageRef,
    replyReference?: ReplyReference,
  ) {
    // 简化的 token 估算（1 token ≈ 2 字符），但按当前 Pi prompt
    // render 形态统计，而不是只统计裸 message/memory content。
    const recentMessagesTokens = recentMessages.reduce((sum, msg) => {
      return sum + this.estimateTextTokens(this.renderRecentMessageForBudget(msg));
    }, 0);

    const memoryTokens = this.estimateTextTokens(this.renderMemoryContextForBudget(memoryBlocks));

    const currentSpeakerRef = recentMessages.find((message) => (
      message.messageRef === currentMessageRef && message.isCurrent === true
    ))?.speakerRef;
    const promptIdentityFields = identityFields.map((field) => (
      field.name === 'target_user_ref' && currentSpeakerRef !== undefined
        ? { ...field, value: currentSpeakerRef }
        : field
    ));
    const identityFieldTokens = this.estimateTextTokens(
      this.renderIdentityContextForBudget(promptIdentityFields)
    );
    const participantTokens = this.estimateTextTokens(
      this.renderParticipantContextForBudget(participants, conversationType)
    );
    const messageReferenceTokens = this.estimateTextTokens(
      this.renderMessageReferencesForBudget(
        recentMessages,
        currentMessageRef,
        replyReference,
      )
    );
    const identityTokens = identityFieldTokens + participantTokens + messageReferenceTokens;

    const systemTokens = 300; // 系统提示词估算

    const promptLayers = [
      {
        name: 'recent_messages',
        version: 'pi-prompt-recent-message-v2',
        tokens: recentMessagesTokens,
      },
      {
        name: 'memory_context',
        version: 'pi-prompt-memory-context-v2',
        tokens: memoryTokens,
      },
      {
        name: 'identity_fields',
        version: 'context-builder-identity-fields-v2',
        tokens: identityFieldTokens,
      },
      {
        name: 'participant_context',
        version: 'pi-prompt-participant-context-v3',
        tokens: participantTokens,
      },
      {
        name: 'message_references',
        version: 'pi-prompt-message-reference-v1',
        tokens: messageReferenceTokens,
      },
      {
        name: 'system_prompt_estimate',
        version: 'bounded-system-estimate-v1',
        tokens: systemTokens,
      },
    ];

    const used = promptLayers.reduce((sum, layer) => sum + layer.tokens, 0);

    return {
      max: 8000,
      used,
      breakdown: {
        recentMessages: recentMessagesTokens,
        memory: memoryTokens,
        identity: identityTokens,
        system: systemTokens,
      },
      promptLayers,
    };
  }

  private estimateTextTokens(text: string): number {
    return Math.ceil(text.length / 2);
  }

  private renderRecentMessageForBudget(msg: RecentMessage): string {
    if (msg.isFromBot) {
      return msg.text ?? '';
    }

    const displayField = `sender_display_name=${this.formatPromptDataLiteral(msg.senderDisplayName)}`;
    return msg.text
      ? `${displayField}\nmessage_text:\n${msg.text}`
      : displayField;
  }

  private renderMessageReferencesForBudget(
    messages: RecentMessage[],
    currentMessageRef?: MessageRef,
    replyReference?: ReplyReference,
  ): string {
    if (messages.length === 0) {
      return '';
    }

    const contextLines = ['## Message References'];
    for (const message of messages) {
      if (message.messageRef === undefined || message.speakerRef === undefined) {
        continue;
      }
      contextLines.push(
        `- message_ref=${message.messageRef}`
        + ` speaker_ref=${message.speakerRef}`
        + ` role=${message.isFromBot ? 'bot' : 'human'}`
        + ` current=${message.messageRef === currentMessageRef ? 'true' : 'false'}`
      );
    }

    if (replyReference !== undefined) {
      const replyParts = [
        '- reply',
        `status=${replyReference.status}`,
        `source_message_ref=${replyReference.sourceMessageRef}`,
      ];
      if (replyReference.targetMessageRef !== undefined) {
        replyParts.push(`target_message_ref=${replyReference.targetMessageRef}`);
      }
      if (replyReference.targetSpeakerRef !== undefined) {
        replyParts.push(`target_speaker_ref=${replyReference.targetSpeakerRef}`);
      }
      if (replyReference.targetRole !== undefined) {
        replyParts.push(`target_role=${replyReference.targetRole}`);
      }
      if (replyReference.targetInRollingWindow !== undefined) {
        replyParts.push(
          `target_in_rolling_window=${replyReference.targetInRollingWindow ? 'true' : 'false'}`
        );
      }
      contextLines.push(replyParts.join(' '));
    }
    contextLines.push('');

    return contextLines.join('\n');
  }

  private renderMemoryContextForBudget(memoryBlocks: MemoryBlock[]): string {
    const contextLines: string[] = [];
    const userProfile = memoryBlocks.find((mem) => mem.scope === 'user' && mem.kind === 'summary');
    const groupProfile = memoryBlocks.find((mem) => mem.scope === 'group' && mem.kind === 'summary');

    if (userProfile) {
      contextLines.push('## User Profile');
      contextLines.push(userProfile.content);
      contextLines.push('');
    }

    if (groupProfile) {
      contextLines.push('## Group Context');
      contextLines.push(groupProfile.content);
      contextLines.push('');
    }

    if (memoryBlocks.length > 0) {
      contextLines.push('## Relevant Facts');
      for (const fact of memoryBlocks) {
        contextLines.push(`- **${fact.title}**: ${fact.content}`);
      }
      contextLines.push('');
    }

    return contextLines.join('\n');
  }

  private renderIdentityContextForBudget(identityFields: IdentityBudgetField[]): string {
    if (identityFields.length === 0) {
      return '';
    }

    const contextLines = ['## Identity'];
    for (const field of identityFields) {
      contextLines.push(`- ${field.name}=${this.formatPromptDataLiteral(field.value)}`);
    }
    contextLines.push('');

    return contextLines.join('\n');
  }

  private renderParticipantContextForBudget(
    participants: ParticipantContext[],
    conversationType: 'private' | 'group'
  ): string {
    if (conversationType !== 'group' || participants.length === 0) {
      return '';
    }

    const contextLines = ['## Participants'];
    for (const participant of participants) {
      contextLines.push(this.renderParticipantLineForBudget(participant));
    }
    contextLines.push('');

    return contextLines.join('\n');
  }

  private renderParticipantLineForBudget(participant: ParticipantContext): string {
    const flags: string[] = [];
    if (participant.isOwner) {
      flags.push('owner');
    }
    if (participant.isAdmin) {
      flags.push('admin');
    }
    if (participant.isTrusted) {
      flags.push('trusted');
    }

    const parts = [
      `- speaker_ref=${participant.speakerRef ?? 'speaker_unknown'}`,
      `display_name=${this.formatPromptDataLiteral(participant.displayName)}`,
    ];
    if (flags.length > 0) {
      parts.push(`flags=[${flags.join(', ')}]`);
    }
    if (participant.role) {
      parts.push(`role=${participant.role}`);
    }
    if (participant.groupCard) {
      parts.push(`group_card=${this.formatPromptDataLiteral(participant.groupCard)}`);
    }

    return parts.join(' ');
  }

  private formatPromptDataLiteral(value: string): string {
    return JSON.stringify(this.sanitizePromptDataText(value));
  }

  private sanitizePromptDataText(value: string): string {
    return this.redactPromptDataText(value)
      .replace(/[\r\n]+/g, ' ')
      .replace(/</g, '‹')
      .replace(/>/g, '›');
  }

  private redactPromptDataText(value: string): string {
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

  private normalizeSenderId(senderId: string, isFromBot: boolean): string {
    if (isFromBot) {
      return 'bot-self';
    }

    if (senderId.startsWith('qq-') || senderId.startsWith('user-')) {
      return senderId;
    }

    return `qq-${senderId}`;
  }

  private isBotSender(senderId: string, rawSource: string | null): boolean {
    return rawSource === 'agent'
      || senderId === 'bot'
      || senderId === 'bot-self'
      || senderId.startsWith('bot-');
  }

  private buildInjectedIdentityFields(input: BuildContextInput): string[] {
    const fields = ['conversation_id', 'conversation_type'];

    if (input.groupId) {
      fields.push('group_id');
    }

    if (input.targetUserId ?? input.canonicalUserId) {
      fields.push('target_user_ref');
    }

    if (input.conversationType === 'group' && input.participants && input.participants.length > 0) {
      fields.push('participant_context');
    }

    return fields;
  }

  private buildIdentityBudgetFields(input: {
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
    targetUserId?: string;
  }): IdentityBudgetField[] {
    const fields: IdentityBudgetField[] = [
      { name: 'conversation_id', value: input.conversationId },
      { name: 'conversation_type', value: input.conversationType },
    ];

    if (input.groupId) {
      fields.push({ name: 'group_id', value: input.groupId });
    }

    if (input.targetUserId) {
      fields.push({ name: 'target_user_ref', value: input.targetUserId });
    }

    return fields;
  }

  private getMemoryRejectionReason(
    mem: MemoryRecord,
    userId?: string,
    conversationType?: 'private' | 'group',
    groupId?: string,
    conversationId?: string
  ): string | null {
    if (mem.state !== 'active') {
      return `state:${mem.state}`;
    }

    if (mem.sensitivity === 'secret' || mem.sensitivity === 'prohibited') {
      return `sensitivity:${mem.sensitivity}`;
    }

    const contentPolicyFinding = scanMemoryForSecrets(`${mem.title}\n${mem.content}`)[0];
    if (contentPolicyFinding) {
      return `content_policy:${contentPolicyFinding.kind}`;
    }

    if (mem.expiresAt && mem.expiresAt.getTime() <= Date.now()) {
      return 'expired';
    }

    if (mem.scope === 'user' && mem.canonicalUserId && userId && mem.canonicalUserId !== userId) {
      return 'unrelated_user_scope';
    }

    if (mem.scope === 'conversation' && mem.conversationId && conversationId && mem.conversationId !== conversationId) {
      return 'unrelated_conversation_scope';
    }

    if (
      mem.scope === 'group'
      && mem.groupId
      && groupId
      && mem.groupId !== groupId
      && mem.conversationId !== conversationId
    ) {
      return 'unrelated_group_scope';
    }

    if (mem.visibility === 'owner_admin_only') {
      return 'owner_admin_only';
    }

    if (mem.visibility === 'private_only') {
      return conversationType === 'private' ? null : 'private_only_in_group_context';
    }

    if (mem.visibility === 'same_group_only') {
      const sameGroup = Boolean(groupId) && mem.groupId === groupId;
      const sameConversation = Boolean(conversationId) && mem.conversationId === conversationId;

      return conversationType === 'group' && (sameGroup || sameConversation)
        ? null
        : 'not_same_group_context';
    }

    if (mem.visibility === 'same_user_any_context') {
      return null;
    }

    if (mem.visibility === 'public') {
      return null;
    }

    return 'unknown_visibility';
  }
}
