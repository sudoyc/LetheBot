/**
 * Context trace repository.
 *
 * Stores the explainability metadata generated with a ContextPack so `/why`
 * can use the exact turn-time trace instead of silently rebuilding against
 * changed memory state.
 */

import type Database from 'better-sqlite3';
import { redactSecretsInText } from '../memory/secret-scan';
import type { ContextPack } from '../types/context';
import type { MemoryRecord } from '../types/memory';

export interface StoredContextTrace {
  contextPackId: string;
  turnId: string;
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
  createdAt: Date;
}

interface ContextTraceRow {
  id: string;
  turn_id: string;
  conversation_id: string;
  conversation_type: 'private' | 'group';
  group_id: string | null;
  candidate_memory_ids: string;
  selected_memory_ids: string;
  rejected_memories: string;
  filters_applied: string;
  injected_identity_fields: string;
  recent_message_ids: string;
  token_budget: string;
  memories: string;
  created_at: number;
}

export class ContextTraceRepository {
  constructor(private readonly db: Database.Database) {}

  async createFromContext(context: ContextPack): Promise<void> {
    const trace = context.trace;
    const memories = context.memory.retrievedFacts.map((memory) => ({
      memoryId: memory.memoryId,
      scope: memory.scope,
      kind: memory.kind,
      title: redactContextTraceText(memory.title),
      sourceContext: memory.sourceContext === undefined
        ? undefined
        : redactContextTraceText(memory.sourceContext),
    }));
    const rejectedMemories = (trace?.rejectedMemories ?? []).map((memory) => ({
      memoryId: memory.memoryId,
      reason: redactContextTraceText(memory.reason),
    }));
    const filtersApplied = (trace?.filtersApplied ?? []).map(redactContextTraceText);
    const injectedIdentityFields = context.injectedIdentityFields.map(redactContextTraceText);
    const tokenBudget = redactTokenBudget(context.tokenBudget);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO context_traces (
          id, turn_id, conversation_id, conversation_type, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        context.id,
        context.turnId,
        context.conversation.conversationId,
        context.conversation.conversationType,
        context.conversation.groupId ?? null,
        JSON.stringify(trace?.candidateMemoryIds ?? []),
        JSON.stringify(context.memory.selectedMemoryIds),
        JSON.stringify(rejectedMemories),
        JSON.stringify(filtersApplied),
        JSON.stringify(injectedIdentityFields),
        JSON.stringify(context.recentMessages.map((message) => message.messageId)),
        JSON.stringify(tokenBudget),
        JSON.stringify(memories),
        context.createdAt.getTime()
      );
  }

  async findByTurnId(turnId: string): Promise<StoredContextTrace | null> {
    const row = this.db
      .prepare('SELECT * FROM context_traces WHERE turn_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(turnId) as ContextTraceRow | undefined;

    return row ? this.rowToTrace(row) : null;
  }

  private rowToTrace(row: ContextTraceRow): StoredContextTrace {
    return {
      contextPackId: row.id,
      turnId: row.turn_id,
      conversation: {
        conversationId: row.conversation_id,
        conversationType: row.conversation_type,
        groupId: row.group_id ?? undefined,
      },
      selectedMemoryIds: this.parseJsonArray<string>(row.selected_memory_ids),
      candidateMemoryIds: this.parseJsonArray<string>(row.candidate_memory_ids),
      rejectedMemories: this.parseJsonArray<StoredContextTrace['rejectedMemories'][number]>(
        row.rejected_memories
      ),
      filtersApplied: this.parseJsonArray<string>(row.filters_applied),
      injectedIdentityFields: this.parseJsonArray<string>(row.injected_identity_fields),
      recentMessageIds: this.parseJsonArray<string>(row.recent_message_ids),
      tokenBudget: this.parseJsonObject<ContextPack['tokenBudget']>(row.token_budget),
      memories: this.parseJsonArray<StoredContextTrace['memories'][number]>(row.memories),
      createdAt: new Date(row.created_at),
    };
  }

  private parseJsonArray<T>(raw: string): T[] {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }

  private parseJsonObject<T>(raw: string): T {
    return JSON.parse(raw) as T;
  }
}

function redactContextTraceText(text: string): string {
  const platformRedacted = redactPlatformIdentifiers(text);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]') && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactTokenBudget(tokenBudget: ContextPack['tokenBudget']): ContextPack['tokenBudget'] {
  return {
    max: tokenBudget.max,
    used: tokenBudget.used,
    breakdown: { ...tokenBudget.breakdown },
    ...(tokenBudget.promptLayers
      ? {
          promptLayers: tokenBudget.promptLayers.map((layer) => ({
            name: redactContextTraceText(layer.name),
            version: redactContextTraceText(layer.version),
            tokens: layer.tokens,
          })),
        }
      : {}),
  };
}

function redactPlatformIdentifiers(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}
