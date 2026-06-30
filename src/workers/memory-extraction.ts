/**
 * Memory Extraction Worker
 *
 * 从对话中提取记忆候选
 */

import type Database from 'better-sqlite3';
import { getLogger } from '../logger/index.js';

const logger = getLogger();

export interface MemoryExtractionInput {
  conversationId: string;
  userId: string;
  userMessage: string;
  botResponse: string;
}

/**
 * 简化版记忆提取器
 * 使用模式匹配识别明确的自述句
 */
export class MemoryExtractionWorker {
  constructor(private db: Database.Database) {}

  /**
   * 从一次对话中提取记忆
   */
  async extractFromTurn(input: MemoryExtractionInput): Promise<void> {
    const patterns = [
      { regex: /我叫\s*([^，。！？,\\.!?]+)/, type: 'name', sensitivity: 'personal' as const, captureCount: 1 },
      { regex: /我是\s*([^，。！？,\\.!?]+)/, type: 'identity', sensitivity: 'personal' as const, captureCount: 1 },
      { regex: /我的\s*([^，。！？,\\.!?]+?)\s*是\s*([^，。！？,\\.!?]+)/, type: 'attribute', sensitivity: 'personal' as const, captureCount: 2 },
      { regex: /我喜欢\s*([^，。！？,\\.!?]+)/, type: 'preference', sensitivity: 'normal' as const, captureCount: 1 },
      { regex: /我不喜欢\s*([^，。！？,\\.!?]+)/, type: 'preference', sensitivity: 'normal' as const, captureCount: 1 },
      { regex: /我想要\s*([^，。！？,\\.!?]+)/, type: 'preference', sensitivity: 'normal' as const, captureCount: 1 },
      { regex: /我需要\s*([^，。！？,\\.!?]+)/, type: 'preference', sensitivity: 'normal' as const, captureCount: 1 },
    ];

    for (const { regex, type, sensitivity, captureCount } of patterns) {
      const match = input.userMessage.match(regex);
      if (match && match[1]) {
        const extractedFact = captureCount === 2 && match[2]
          ? `${match[1].trim()}: ${match[2].trim()}`
          : match[1].trim();

        await this.createMemory({
          scope: 'user',
          ownerId: input.userId,
          visibility: 'private_only',
          sensitivity,
          content: input.userMessage,
          extractedFact,
          type,
          conversationId: input.conversationId,
        });
      }
    }
  }

  /**
   * 创建记忆记录
   */
  private async createMemory(data: {
    scope: string;
    ownerId: string;
    visibility: string;
    sensitivity: string;
    content: string;
    extractedFact: string;
    type: string;
    conversationId: string;
  }): Promise<void> {
    const memoryId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    try {
      // 先检查用户是否存在，如果不存在则创建
      const userExists = this.db.prepare('SELECT id FROM canonical_users WHERE id = ?').get(data.ownerId);
      if (!userExists) {
        this.db.prepare(`
          INSERT INTO canonical_users (id, created_at, last_seen_at)
          VALUES (?, ?, ?)
        `).run(data.ownerId, Date.now(), Date.now());
      }

      this.db.prepare(`
        INSERT INTO memory_records (
          id, scope, canonical_user_id, visibility, sensitivity,
          authority, kind, title, content, state, confidence,
          importance, source_context, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memoryId,
        data.scope,
        data.ownerId,
        data.visibility,
        data.sensitivity,
        'user_stated',
        'preference',
        `${data.type}: ${data.extractedFact}`,
        data.content,
        'active', // 简化：直接 active
        0.9,
        0.7,
        `chat:${data.conversationId}`,
        Date.now(),
        Date.now(),
      );

      logger.debug({ memoryId, type: data.type, fact: data.extractedFact }, 'Memory created');
    } catch (error) {
      logger.error({ error, memoryId }, 'Failed to create memory');
      throw error;
    }
  }
}
