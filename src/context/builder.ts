/**
 * Context Builder
 *
 * 构建 ContextPack，应用内存可见性过滤
 */

import { ulid } from 'ulidx';
import type { ContextPack, RecentMessage } from '../types/context';
import type { MemoryRepository } from '../storage/memory-repository';
import type { IdentityRepository } from '../storage/identity-repository';
import type Database from 'better-sqlite3';

export interface BuildContextInput {
  turnId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  recentMessages: RecentMessage[];
  targetUserId?: string;
  groupId?: string;
  db?: Database.Database; // 添加数据库连接
}

export class ContextBuilder {
  constructor(
    private memoryRepo: MemoryRepository,
    private identityRepo: IdentityRepository,
    private db?: Database.Database // 添加数据库连接
  ) {}

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
        id, sender_id, text, timestamp
      FROM chat_messages
      WHERE conversation_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(conversationId, limit) as Array<{
      id: string;
      sender_id: string;
      text: string;
      timestamp: number;
    }>;

    // 反转顺序，使最旧的消息在前
    return rows.reverse().map((row) => ({
      messageId: row.id,
      senderId: row.sender_id === 'bot-self' ? 'bot-self' : `qq-${row.sender_id}`,
      senderDisplayName: row.sender_id === 'bot-self' ? 'LetheBot' : `qq-${row.sender_id}`,
      text: row.text,
      timestamp: new Date(row.timestamp),
      isFromBot: row.sender_id === 'bot-self',
    }));
  }

  async buildContext(input: BuildContextInput): Promise<ContextPack> {
    const { turnId, conversationId, conversationType, targetUserId, groupId } = input;

    // 从数据库加载历史消息（如果有数据库连接）
    let recentMessages: RecentMessage[];
    if (this.db) {
      recentMessages = await this.loadRecentMessages(conversationId, 20);
      // 如果数据库中没有历史，回退到传入的消息
      if (recentMessages.length === 0) {
        recentMessages = input.recentMessages;
      }
    } else {
      // 无数据库连接时使用传入的消息
      recentMessages = input.recentMessages;
    }

    // 检索记忆（带可见性过滤）
    const retrievedFacts = await this.retrieveMemory(targetUserId, conversationType, groupId);

    // 计算 token 预算
    const tokenBudget = this.calculateTokenBudget(recentMessages, retrievedFacts);

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
        retrievedFacts: retrievedFacts.map((mem) => ({
          memoryId: mem.id,
          scope: mem.scope,
          title: mem.title,
          content: mem.content,
          confidence: mem.confidence,
          sourceContext: mem.sourceContext,
        })),
        selectedMemoryIds: retrievedFacts.map((m) => m.id),
      },
      participants: [],
      injectedIdentityFields: [],
      tokenBudget,
    };

    return context;
  }

  /**
   * 检索记忆并应用可见性过滤
   */
  private async retrieveMemory(
    userId?: string,
    conversationType?: 'private' | 'group',
    groupId?: string
  ) {
    const allMemories: Array<Awaited<ReturnType<typeof this.memoryRepo.retrieve>>[number]> = [];

    // 检索用户记忆
    if (userId) {
      const userMemories = await this.memoryRepo.retrieve({
        canonicalUserId: userId,
        state: 'active',
      });
      allMemories.push(...userMemories);
    }

    // 检索全局公开记忆
    const globalMemories = await this.memoryRepo.retrieve({
      scope: 'global',
      state: 'active',
    });
    allMemories.push(...globalMemories);

    // 应用可见性过滤
    const filtered = allMemories.filter((mem) => {
      // private_only 只在私聊可见
      if (mem.visibility === 'private_only') {
        return conversationType === 'private';
      }

      // same_group_only 只在同一群组可见
      if (mem.visibility === 'same_group_only') {
        return conversationType === 'group' && mem.groupId === groupId;
      }

      // same_user_any_context 在任何上下文可见
      if (mem.visibility === 'same_user_any_context') {
        return true;
      }

      // public 总是可见
      if (mem.visibility === 'public') {
        return true;
      }

      // owner_admin_only 需要额外权限检查（简化为不可见）
      if (mem.visibility === 'owner_admin_only') {
        return false;
      }

      return false;
    });

    return filtered;
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
}
