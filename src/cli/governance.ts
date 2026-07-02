/**
 * Governance CLI
 *
 * 治理命令行工具（Phase L）
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import type { ContextBuilder } from '../context/builder';
import type { MemoryRepository } from '../storage/memory-repository';
import type { ContextPack } from '../types/context';
import type { MemoryRecord, MemorySource } from '../types/memory';

export interface ListMemoryOptions {
  userId?: string;
  groupId?: string;
  conversationId?: string;
  state?: MemoryRecord['state'];
  scope?: MemoryRecord['scope'];
  sensitivity?: MemoryRecord['sensitivity'];
  sourceContext?: string;
  sourceType?: MemorySource['sourceType'];
  sourceId?: string;
  limit?: number;
}

export interface CommandResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface ExplainContextOptions {
  turnId?: string;
  conversationId?: string;
  conversationType?: 'private' | 'group';
  groupId?: string;
  canonicalUserId?: string;
  messageLimit?: number;
}

export interface ContextExplanation {
  turnId: string;
  contextPackId: string;
  traceSource: 'rebuilt';
  conversation: ContextPack['conversation'];
  selectedMemoryIds: string[];
  candidateMemoryIds: string[];
  rejectedMemories: NonNullable<ContextPack['trace']>['rejectedMemories'];
  filtersApplied: string[];
  injectedIdentityFields: string[];
  recentMessageIds: string[];
  tokenBudget: ContextPack['tokenBudget'];
  memories: Array<{
    memoryId: string;
    scope: string;
    kind?: MemoryRecord['kind'];
    title: string;
    sourceContext?: string;
  }>;
}

export interface RedactDisplayProfileOptions {
  canonicalUserId: string;
  groupId?: string;
}

interface GovernanceCLIOptions {
  db?: Database.Database;
  contextBuilder?: Pick<ContextBuilder, 'build'>;
}

interface LastTurnRow {
  id: string;
  context_pack_id: string | null;
  conversation_id: string;
  conversation_type: 'private' | 'group' | null;
  group_id: string | null;
  sender_id: string | null;
}

export class GovernanceCLI {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly options: GovernanceCLIOptions = {}
  ) {}

  /**
   * 列出记忆记录
   */
  async listMemory(options: ListMemoryOptions): Promise<MemoryRecord[]> {
    if (this.options.db) {
      return this.listMemoryFromDatabase(options);
    }

    const filters: Parameters<typeof this.memoryRepo.retrieve>[0] = {
      state: options.state ?? 'active',
      limit: options.limit,
    };

    if (options.userId) filters.canonicalUserId = options.userId;
    if (options.groupId) filters.groupId = options.groupId;
    if (options.conversationId) filters.conversationId = options.conversationId;
    if (options.scope) filters.scope = options.scope;

    return this.memoryRepo.retrieve(filters);
  }

  /**
   * 删除记忆记录
   */
  async deleteMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing) {
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
        };
      }

      await this.memoryRepo.updateState(memoryId, 'deleted', {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'Governance CLI delete memory',
        auditSummary: `Governance CLI deleted memory ${memoryId}`,
      });

      return {
        success: true,
        message: `Memory ${memoryId} deleted`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 禁用记忆记录
   */
  async disableMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing) {
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
        };
      }

      await this.memoryRepo.updateState(memoryId, 'disabled', {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'Governance CLI disable memory',
        auditSummary: `Governance CLI disabled memory ${memoryId}`,
      });

      return {
        success: true,
        message: `Memory ${memoryId} disabled`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 启用记忆记录
   */
  async enableMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing || existing.state !== 'disabled') {
        return {
          success: false,
          error: `Memory ${memoryId} not found or not disabled`,
        };
      }

      await this.memoryRepo.updateState(memoryId, 'active', {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'Governance CLI restore memory',
        auditSummary: `Governance CLI enabled memory ${memoryId}`,
      });

      return {
        success: true,
        message: `Memory ${memoryId} enabled`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * CLI 等价 `/why`：重建指定或最近回合的 ContextBuilder trace。
   */
  async explainContext(options: ExplainContextOptions): Promise<ContextExplanation> {
    if (!this.options.contextBuilder) {
      throw new Error('ContextBuilder is required for context explanation');
    }

    const resolved = this.resolveExplainContextOptions(options);
    const context = await this.options.contextBuilder.build({
      turnId: resolved.turnId,
      conversationId: resolved.conversationId,
      conversationType: resolved.conversationType,
      groupId: resolved.groupId,
      canonicalUserId: resolved.canonicalUserId,
      messageLimit: options.messageLimit,
    });

    return {
      turnId: resolved.turnId,
      contextPackId: context.id,
      traceSource: 'rebuilt',
      conversation: context.conversation,
      selectedMemoryIds: context.memory.selectedMemoryIds,
      candidateMemoryIds: context.trace?.candidateMemoryIds ?? [],
      rejectedMemories: context.trace?.rejectedMemories ?? [],
      filtersApplied: context.trace?.filtersApplied ?? [],
      injectedIdentityFields: context.injectedIdentityFields,
      recentMessageIds: context.recentMessages.map((message) => message.messageId),
      tokenBudget: context.tokenBudget,
      memories: context.memory.retrievedFacts.map((memory) => ({
        memoryId: memory.memoryId,
        scope: memory.scope,
        kind: memory.kind,
        title: memory.title,
        sourceContext: memory.sourceContext,
      })),
    };
  }

  /**
   * Redact current display profile and nickname history for a user or group-scoped profile.
   */
  async redactDisplayProfile(options: RedactDisplayProfileOptions): Promise<CommandResult> {
    if (!this.options.db) {
      return {
        success: false,
        error: 'Database connection is required for display profile redaction',
      };
    }

    const db = this.options.db;
    const now = Date.now();
    const groupId = options.groupId ?? '';

    try {
      const transaction = db.transaction(() => {
        const displayResult = db
          .prepare(
            `UPDATE display_profiles
             SET current_display_name = ?, observed_at = ?, trust = ?
             WHERE canonical_user_id = ?
               AND source_group_id = ?`
          )
          .run('[redacted]', now, 'user_set', options.canonicalUserId, groupId);

        const historyResult = db
          .prepare(
            `UPDATE nickname_history
             SET display_name = ?, observed_until = COALESCE(observed_until, ?)
             WHERE canonical_user_id = ?
               AND source_group_id = ?`
          )
          .run('[redacted]', now, options.canonicalUserId, groupId);

        this.insertSystemAudit({
          eventType: 'display_profile.redact',
          eventId: `${options.canonicalUserId}:${groupId}`,
          summary: `Governance CLI redacted display profile for ${options.canonicalUserId}`,
          details: {
            canonicalUserId: options.canonicalUserId,
            groupId: groupId || undefined,
            displayProfilesUpdated: displayResult.changes,
            nicknameHistoryUpdated: historyResult.changes,
          },
        });

        return displayResult.changes + historyResult.changes;
      });

      const changes = transaction();
      return {
        success: true,
        message: `Redacted ${changes} display profile/nickname rows for ${options.canonicalUserId}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async listMemoryFromDatabase(options: ListMemoryOptions): Promise<MemoryRecord[]> {
    const db = this.options.db;
    if (!db) {
      return [];
    }

    const params: unknown[] = [];
    let query = 'SELECT DISTINCT mr.id FROM memory_records mr';

    if (options.sourceType || options.sourceId) {
      query += ' JOIN memory_sources ms ON ms.memory_id = mr.id';
    }

    query += ' WHERE 1=1';

    query += ' AND mr.state = ?';
    params.push(options.state ?? 'active');

    if (options.userId) {
      query += ' AND mr.canonical_user_id = ?';
      params.push(options.userId);
    }

    if (options.groupId) {
      query += ' AND mr.group_id = ?';
      params.push(options.groupId);
    }

    if (options.conversationId) {
      query += ' AND mr.conversation_id = ?';
      params.push(options.conversationId);
    }

    if (options.scope) {
      query += ' AND mr.scope = ?';
      params.push(options.scope);
    }

    if (options.sensitivity) {
      query += ' AND mr.sensitivity = ?';
      params.push(options.sensitivity);
    }

    if (options.sourceContext) {
      query += ' AND mr.source_context = ?';
      params.push(options.sourceContext);
    }

    if (options.sourceType) {
      query += ' AND ms.source_type = ?';
      params.push(options.sourceType);
    }

    if (options.sourceId) {
      query += ' AND ms.source_id = ?';
      params.push(options.sourceId);
    }

    query += ' ORDER BY mr.importance DESC, mr.created_at DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as Array<{ id: string }>;
    const memories = await Promise.all(rows.map((row) => this.memoryRepo.findById(row.id)));
    return memories.filter((memory): memory is MemoryRecord => memory !== null);
  }

  private resolveExplainContextOptions(options: ExplainContextOptions): {
    turnId: string;
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
    canonicalUserId?: string;
  } {
    if (options.conversationId && options.conversationType) {
      return {
        turnId: options.turnId ?? 'governance-cli-why',
        conversationId: options.conversationId,
        conversationType: options.conversationType,
        groupId: options.groupId,
        canonicalUserId: options.canonicalUserId,
      };
    }

    const row = this.findTurnRow(options.turnId);
    if (!row) {
      throw new Error(options.turnId ? `Turn ${options.turnId} not found` : 'No agent turn found');
    }

    const conversationType = options.conversationType ?? row.conversation_type;
    if (!conversationType) {
      throw new Error('Conversation type is required when it cannot be inferred from the turn');
    }

    return {
      turnId: row.id,
      conversationId: options.conversationId ?? row.conversation_id,
      conversationType,
      groupId: options.groupId ?? row.group_id ?? undefined,
      canonicalUserId: options.canonicalUserId ?? this.inferCanonicalUserId(row.sender_id),
    };
  }

  private findTurnRow(turnId?: string): LastTurnRow | null {
    const db = this.options.db;
    if (!db) {
      throw new Error('Database connection is required to resolve a turn');
    }

    const baseQuery = `
      SELECT
        at.id,
        at.context_pack_id,
        at.conversation_id,
        cm.conversation_type,
        cm.group_id,
        cm.sender_id
      FROM agent_turns at
      LEFT JOIN chat_messages cm ON cm.raw_event_id = at.trigger_event_id
    `;

    const row = turnId
      ? db.prepare(`${baseQuery} WHERE at.id = ? LIMIT 1`).get(turnId)
      : db.prepare(`${baseQuery} ORDER BY at.started_at DESC LIMIT 1`).get();

    return (row as LastTurnRow | undefined) ?? null;
  }

  private inferCanonicalUserId(senderId: string | null): string | undefined {
    if (!senderId) {
      return undefined;
    }
    return senderId.startsWith('user-') ? senderId : undefined;
  }

  private insertSystemAudit(input: {
    eventType: string;
    eventId: string;
    summary: string;
    details: object;
  }): void {
    if (!this.options.db) {
      return;
    }

    this.options.db
      .prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_user_id, actor_class, invocation_context,
          summary, details, redacted, risk_level, evaluator_decision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ulid(),
        Date.now(),
        'system',
        'summary',
        input.eventType,
        input.eventId,
        null,
        'admin',
        'admin_cli',
        input.summary,
        JSON.stringify(input.details),
        1,
        'medium',
        null
      );
  }
}
