/**
 * Context trace repository.
 *
 * Stores the explainability metadata generated with a ContextPack so `/why`
 * can use the exact turn-time trace instead of silently rebuilding against
 * changed memory state.
 */

import type Database from 'better-sqlite3';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type {
  ContextPack,
  MemorySelectionEvidence,
  MessageRef,
  ReplyReference,
  SpeakerRef,
} from '../types/context.js';
import type { MemoryRecord } from '../types/memory.js';

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
  referenceTrace?: ContextReferenceTrace;
  memorySelections?: MemorySelectionEvidence[];
  memories: Array<{
    memoryId: string;
    scope: string;
    kind?: MemoryRecord['kind'];
    title: string;
    sourceContext?: string;
    selection?: MemorySelectionEvidence;
  }>;
  createdAt: Date;
}

export interface ContextReferenceTrace {
  currentMessageRef: MessageRef;
  messages: Array<{
    messageRef: MessageRef;
    speakerRef: SpeakerRef;
    isCurrent: boolean;
  }>;
  replyReference?: ReplyReference;
}

type StoredTokenBudget = ContextPack['tokenBudget'] & {
  referenceTrace?: ContextReferenceTrace;
};

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
    const memorySelections = validateMemorySelections(
      trace?.memorySelections,
      context.memory.selectedMemoryIds,
    );
    const selectionByMemoryId = new Map(
      memorySelections.map((selection) => [selection.memoryId, selection]),
    );
    const memories = context.memory.retrievedFacts.map((memory) => ({
      memoryId: memory.memoryId,
      scope: memory.scope,
      kind: memory.kind,
      title: redactContextTraceText(memory.title),
      sourceContext: memory.sourceContext === undefined
        ? undefined
        : redactContextTraceText(memory.sourceContext),
      ...(selectionByMemoryId.has(memory.memoryId)
        ? { selection: selectionByMemoryId.get(memory.memoryId) }
        : {}),
    }));
    const rejectedMemories = (trace?.rejectedMemories ?? []).map((memory) => ({
      memoryId: memory.memoryId,
      reason: redactContextTraceText(memory.reason),
    }));
    const filtersApplied = (trace?.filtersApplied ?? []).map(redactContextTraceText);
    const injectedIdentityFields = context.injectedIdentityFields.map(redactContextTraceText);
    const referenceTrace = buildReferenceTrace(context);
    const tokenBudget: StoredTokenBudget = {
      ...redactTokenBudget(context.tokenBudget),
      ...(referenceTrace ? { referenceTrace } : {}),
    };

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
    const tokenBudget = this.parseJsonObject<StoredTokenBudget>(row.token_budget);
    const selectedMemoryIds = this.parseJsonArray<string>(row.selected_memory_ids);
    const parsedMemories = this.parseJsonArray<StoredContextTrace['memories'][number]>(row.memories);
    const parsedSelections = parsedMemories.flatMap((memory) => (
      memory.selection === undefined ? [] : [memory.selection]
    ));
    const memorySelections = parsedSelections.length === 0
      ? []
      : validateMemorySelections(parsedSelections, selectedMemoryIds);
    const selectionByMemoryId = new Map(
      memorySelections.map((selection) => [selection.memoryId, selection]),
    );
    const memories = parsedMemories.map((memory) => ({
      memoryId: memory.memoryId,
      scope: memory.scope,
      ...(memory.kind === undefined ? {} : { kind: memory.kind }),
      title: memory.title,
      ...(memory.sourceContext === undefined ? {} : { sourceContext: memory.sourceContext }),
      ...(selectionByMemoryId.has(memory.memoryId)
        ? { selection: selectionByMemoryId.get(memory.memoryId) }
        : {}),
    }));
    return {
      contextPackId: row.id,
      turnId: row.turn_id,
      conversation: {
        conversationId: row.conversation_id,
        conversationType: row.conversation_type,
        groupId: row.group_id ?? undefined,
      },
      selectedMemoryIds,
      candidateMemoryIds: this.parseJsonArray<string>(row.candidate_memory_ids),
      rejectedMemories: this.parseJsonArray<StoredContextTrace['rejectedMemories'][number]>(
        row.rejected_memories
      ),
      filtersApplied: this.parseJsonArray<string>(row.filters_applied),
      injectedIdentityFields: this.parseJsonArray<string>(row.injected_identity_fields),
      recentMessageIds: this.parseJsonArray<string>(row.recent_message_ids),
      tokenBudget,
      referenceTrace: tokenBudget.referenceTrace,
      ...(memorySelections.length === 0 ? {} : { memorySelections }),
      memories,
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

const MEMORY_QUERY_SOURCES = ['current_message', 'quoted_message', 'recent_thread'] as const;
const MEMORY_RETRIEVAL_METHODS = ['scoped_rank', 'fts'] as const;
const MEMORY_SCOPE_AFFINITIES = ['exact_conversation', 'exact_group', 'same_user', 'global'] as const;
const MEMORY_SELECTION_REASONS = ['profile_priority', 'query_match', 'ranked_fallback'] as const;

function validateMemorySelections(
  selections: MemorySelectionEvidence[] | undefined,
  selectedMemoryIds: string[],
): MemorySelectionEvidence[] {
  if (selections === undefined) {
    return [];
  }
  if (selections.length !== selectedMemoryIds.length) {
    throw new Error('Context memory selection evidence must cover every selected memory');
  }

  return selections.map((selection, index) => {
    if (selection.memoryId !== selectedMemoryIds[index]) {
      throw new Error('Context memory selection evidence must follow selected memory order');
    }
    assertOrderedEnumSubset(selection.querySources, MEMORY_QUERY_SOURCES, 'query source');
    assertOrderedEnumSubset(
      selection.retrievalMethods,
      MEMORY_RETRIEVAL_METHODS,
      'retrieval method',
    );
    if (selection.retrievalMethods.length === 0) {
      throw new Error('Context memory selection evidence requires a retrieval method');
    }
    if (!MEMORY_SCOPE_AFFINITIES.includes(selection.scopeAffinity)) {
      throw new Error('Context memory selection evidence has an invalid scope affinity');
    }
    if (!MEMORY_SELECTION_REASONS.includes(selection.selectionReason)) {
      throw new Error('Context memory selection evidence has an invalid selection reason');
    }
    if (!Number.isSafeInteger(selection.retrievalRank) || selection.retrievalRank < 1) {
      throw new Error('Context memory selection evidence has an invalid retrieval rank');
    }

    return {
      memoryId: selection.memoryId,
      querySources: [...selection.querySources],
      retrievalMethods: [...selection.retrievalMethods],
      scopeAffinity: selection.scopeAffinity,
      retrievalRank: selection.retrievalRank,
      selectionReason: selection.selectionReason,
    };
  });
}

function assertOrderedEnumSubset<T extends string>(
  values: T[],
  allowed: readonly T[],
  label: string,
): void {
  const indexes = values.map((value) => allowed.indexOf(value));
  if (
    indexes.some((index) => index < 0)
    || new Set(values).size !== values.length
    || indexes.some((index, position) => position > 0 && index <= (indexes[position - 1] ?? -1))
  ) {
    throw new Error(`Context memory selection evidence has an invalid ${label}`);
  }
}

function buildReferenceTrace(context: ContextPack): ContextReferenceTrace | undefined {
  const referencedContext = context;
  const hasAnyReferenceData = referencedContext.currentMessageRef !== undefined
    || referencedContext.replyReference !== undefined
    || referencedContext.recentMessages.some((message) => (
      message.messageRef !== undefined
      || message.speakerRef !== undefined
      || message.isCurrent !== undefined
    ));
  if (!hasAnyReferenceData) {
    return undefined;
  }

  if (!isMessageRef(referencedContext.currentMessageRef)) {
    throw new Error('Context reference trace requires an opaque current message ref');
  }

  const messages = referencedContext.recentMessages.map((message) => {
    if (!isMessageRef(message.messageRef) || !isSpeakerRef(message.speakerRef)) {
      throw new Error('Context reference trace contains an invalid message or speaker ref');
    }
    if (typeof message.isCurrent !== 'boolean') {
      throw new Error('Context reference trace requires an explicit current marker');
    }
    return {
      messageRef: message.messageRef,
      speakerRef: message.speakerRef,
      isCurrent: message.isCurrent,
    };
  });
  if (new Set(messages.map((message) => message.messageRef)).size !== messages.length) {
    throw new Error('Context reference trace message refs must be unique');
  }
  const currentMessages = messages.filter((message) => message.isCurrent);
  if (
    currentMessages.length !== 1
    || currentMessages[0]?.messageRef !== referencedContext.currentMessageRef
  ) {
    throw new Error('Context reference trace current marker is inconsistent');
  }

  const replyReference = referencedContext.replyReference === undefined
    ? undefined
    : validateReplyReference(referencedContext.replyReference, referencedContext.currentMessageRef);
  return {
    currentMessageRef: referencedContext.currentMessageRef,
    messages,
    ...(replyReference ? { replyReference } : {}),
  };
}

function validateReplyReference(
  reference: NonNullable<ContextReferenceTrace['replyReference']>,
  currentMessageRef: MessageRef,
): NonNullable<ContextReferenceTrace['replyReference']> {
  if (
    reference.status !== 'resolved'
    && reference.status !== 'unresolved'
  ) {
    throw new Error('Context reply reference status is invalid');
  }
  if (
    !isMessageRef(reference.sourceMessageRef)
    || reference.sourceMessageRef !== currentMessageRef
  ) {
    throw new Error('Context reply reference source is invalid');
  }

  if (reference.status === 'unresolved') {
    if (
      reference.targetMessageRef !== undefined
      || reference.targetSpeakerRef !== undefined
      || reference.targetRole !== undefined
      || reference.targetInRollingWindow !== undefined
    ) {
      throw new Error('Unresolved context reply reference cannot contain a target');
    }
    return {
      status: 'unresolved',
      sourceMessageRef: reference.sourceMessageRef,
    };
  }

  if (
    !isMessageRef(reference.targetMessageRef)
    || !isSpeakerRef(reference.targetSpeakerRef)
    || (reference.targetRole !== 'human' && reference.targetRole !== 'bot')
    || typeof reference.targetInRollingWindow !== 'boolean'
  ) {
    throw new Error('Resolved context reply reference target is invalid');
  }
  return {
    status: 'resolved',
    sourceMessageRef: reference.sourceMessageRef,
    targetMessageRef: reference.targetMessageRef,
    targetSpeakerRef: reference.targetSpeakerRef,
    targetRole: reference.targetRole,
    targetInRollingWindow: reference.targetInRollingWindow,
  };
}

function isMessageRef(value: string | undefined): value is MessageRef {
  return typeof value === 'string' && /^message_[1-9]\d*$/.test(value);
}

function isSpeakerRef(value: string | undefined): value is SpeakerRef {
  return typeof value === 'string' && /^speaker_[1-9]\d*$/.test(value);
}

export function redactContextTraceText(text: string): string {
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
