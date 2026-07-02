/**
 * Context Builder
 *
 * 构建 ContextPack，应用内存可见性过滤
 */

import { ulid } from 'ulidx';
import type { ContextPack, RecentMessage } from '../types/context';
import type { MemoryRepository } from '../storage/memory-repository';
import type { IdentityRepository } from '../storage/identity-repository';
import type { MemoryRecord } from '../types/memory';
import type Database from 'better-sqlite3';

export interface BuildContextInput {
  turnId?: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  recentMessages?: RecentMessage[];
  targetUserId?: string;
  canonicalUserId?: string;
  groupId?: string;
  messageLimit?: number;
  db?: Database.Database;
}

interface MemoryRetrievalResult {
  selected: MemoryRecord[];
  candidateMemoryIds: string[];
  rejectedMemories: Array<{
    memoryId: string;
    reason: string;
  }>;
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
    limit: number = 20
  ): Promise<RecentMessage[]> {
    if (!this.db) {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT
        cm.id,
        cm.sender_id,
        cm.text,
        cm.timestamp,
        re.source as raw_source
      FROM chat_messages cm
      LEFT JOIN raw_events re ON re.id = cm.raw_event_id
      WHERE cm.conversation_id = ?
      ORDER BY cm.timestamp DESC
      LIMIT ?
    `).all(conversationId, limit) as Array<{
      id: string;
      sender_id: string;
      text: string | null;
      timestamp: number;
      raw_source: string | null;
    }>;

    // 反转顺序，使最旧的消息在前
    return rows.reverse().map((row) => {
      const isFromBot = this.isBotSender(row.sender_id, row.raw_source);
      const senderId = this.normalizeSenderId(row.sender_id, isFromBot);

      return {
        messageId: row.id,
        senderId,
        senderDisplayName: isFromBot ? 'LetheBot' : senderId,
        text: row.text ?? undefined,
        timestamp: new Date(row.timestamp),
        isFromBot,
      };
    });
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

    // 从数据库加载历史消息（如果有数据库连接）
    let recentMessages: RecentMessage[];
    if (this.db) {
      recentMessages = await this.loadRecentMessages(conversationId, messageLimit);
      // 如果数据库中没有历史，回退到传入的消息
      if (recentMessages.length === 0) {
        recentMessages = input.recentMessages ?? [];
      }
    } else {
      // 无数据库连接时使用传入的消息
      recentMessages = input.recentMessages ?? [];
    }

    // 检索记忆（带可见性过滤）
    const memoryRetrieval = await this.retrieveMemory(
      targetUserId,
      conversationType,
      groupId,
      conversationId
    );
    const retrievedFacts = memoryRetrieval.selected;
    const memoryBlocks = retrievedFacts.map((mem) => ({
      id: mem.id,
      memoryId: mem.id,
      kind: mem.kind,
      scope: mem.scope,
      title: mem.title,
      content: mem.content,
      confidence: mem.confidence,
      sourceContext: mem.sourceContext,
    }));

    // 计算 token 预算
    const tokenBudget = this.calculateTokenBudget(recentMessages, retrievedFacts);
    const injectedIdentityFields = this.buildInjectedIdentityFields(input);

    const context: ContextPack = {
      id: ulid(),
      turnId,
      createdAt: new Date(),
      conversation: {
        conversationId,
        conversationType,
        groupId,
      },
      recentMessages,
      memory: {
        userProfile: memoryBlocks.find((mem) => mem.scope === 'user' && mem.kind === 'summary'),
        groupProfile: memoryBlocks.find((mem) => mem.scope === 'group' && mem.kind === 'summary'),
        retrievedFacts: memoryBlocks,
        selectedMemoryIds: retrievedFacts.map((m) => m.id),
      },
      participants: [],
      injectedIdentityFields,
      tokenBudget,
      trace: {
        candidateMemoryIds: memoryRetrieval.candidateMemoryIds,
        selectedMemoryIds: retrievedFacts.map((m) => m.id),
        rejectedMemories: memoryRetrieval.rejectedMemories,
        filtersApplied: [
          'state=active',
          'sensitivity!=secret/prohibited',
          `contextType=${conversationType}`,
          'visibility_scope_filter',
        ],
      },
    };

    return context;
  }

  /**
   * 检索记忆并应用可见性过滤
   */
  private async retrieveMemory(
    userId?: string,
    conversationType?: 'private' | 'group',
    groupId?: string,
    conversationId?: string
  ): Promise<MemoryRetrievalResult> {
    const allMemories: MemoryRecord[] = [];

    // 检索用户记忆
    if (userId) {
      const userMemories = await this.memoryRepo.retrieve({
        canonicalUserId: userId,
        state: 'active',
      });
      allMemories.push(...userMemories);
    }

    if (conversationId) {
      const conversationMemories = await this.memoryRepo.retrieve({
        conversationId,
        state: 'active',
        contextType: conversationType,
      });
      allMemories.push(...conversationMemories);
    }

    if (groupId) {
      const groupMemories = await this.memoryRepo.retrieve({
        groupId,
        state: 'active',
        contextType: conversationType,
      });
      allMemories.push(...groupMemories);
    }

    // 检索全局公开记忆
    const globalMemories = await this.memoryRepo.retrieve({
      scope: 'global',
      state: 'active',
    });
    allMemories.push(...globalMemories);

    // 应用可见性过滤
    const deduped = new Map(allMemories.map((mem) => [mem.id, mem]));
    const selected: MemoryRecord[] = [];
    const rejectedMemories: MemoryRetrievalResult['rejectedMemories'] = [];

    for (const mem of deduped.values()) {
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

    selected.sort((a, b) => b.importance - a.importance || b.createdAt.getTime() - a.createdAt.getTime());

    return {
      selected,
      candidateMemoryIds: Array.from(deduped.keys()),
      rejectedMemories,
    };
  }

  /**
   * 计算 token 预算
   */
  private calculateTokenBudget(
    recentMessages: RecentMessage[],
    retrievedFacts: Array<{ content: string }>
  ) {
    // 简化的 token 估算（1 token ≈ 2 字符）
    const recentMessagesTokens = recentMessages.reduce((sum, msg) => {
      return sum + Math.ceil((msg.text?.length ?? 0) / 2);
    }, 0);

    const memoryTokens = retrievedFacts.reduce((sum, mem) => {
      return sum + Math.ceil(mem.content.length / 2);
    }, 0);

    const systemTokens = 300; // 系统提示词估算

    const used = recentMessagesTokens + memoryTokens + systemTokens;

    return {
      max: 8000,
      used,
      breakdown: {
        recentMessages: recentMessagesTokens,
        memory: memoryTokens,
        identity: 0,
        system: systemTokens,
      },
    };
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
