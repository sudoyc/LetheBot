import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ContextBuilder } from '../../src/context/builder.js';
import { initDatabase, runMigrations } from '../../src/storage/database.js';
import { ContextTraceRepository } from '../../src/storage/context-trace-repository.js';
import { IdentityRepository } from '../../src/storage/identity-repository.js';
import {
  MemoryRepository,
  type MemoryRecordInput,
} from '../../src/storage/memory-repository.js';

type QuerySource = 'current_query' | 'resolved_quote' | 'recent_thread';
type MemoryBoundary =
  | 'private_user'
  | 'group_user'
  | 'group_fact'
  | 'conversation_fact';

interface RetrievalCase {
  id: string;
  index: number;
  querySource: QuerySource;
  boundary: MemoryBoundary;
  expectedScopeAffinity: 'same_user' | 'exact_group' | 'exact_conversation';
  distractorCount: number;
}

interface ExpectedSelectionEvidence {
  memoryId: string;
  retrievalRank: number;
  selectionReason: string;
  querySources: string[];
  retrievalMethods: string[];
  scopeAffinity: string;
}

const QUERY_SOURCES: QuerySource[] = [
  'current_query',
  'resolved_quote',
  'recent_thread',
];
const MEMORY_BOUNDARIES: Array<{
  boundary: MemoryBoundary;
  expectedScopeAffinity: RetrievalCase['expectedScopeAffinity'];
}> = [
  { boundary: 'private_user', expectedScopeAffinity: 'same_user' },
  { boundary: 'group_user', expectedScopeAffinity: 'exact_group' },
  { boundary: 'group_fact', expectedScopeAffinity: 'exact_group' },
  { boundary: 'conversation_fact', expectedScopeAffinity: 'exact_conversation' },
];
const RETRIEVAL_CASES: RetrievalCase[] = QUERY_SOURCES.flatMap(
  (querySource, querySourceIndex) => MEMORY_BOUNDARIES.map(
    ({ boundary, expectedScopeAffinity }, boundaryIndex) => {
      const index = querySourceIndex * MEMORY_BOUNDARIES.length + boundaryIndex;
      return {
        id: `${querySource}-${boundary}`,
        index,
        querySource,
        boundary,
        expectedScopeAffinity,
        distractorCount: index === 0 ? 51 : 8,
      };
    },
  ),
);
const TARGET_FILLER = ' target-detail'.repeat(240);
const DISTRACTOR_FILLER = ' distractor-detail'.repeat(120);

describe('REL-RET-01 query-aware memory retrieval', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let contextBuilder: ContextBuilder;
  let traceRepo: ContextTraceRepository;

  beforeEach(() => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-query-retrieval-'));
    db = initDatabase({ path: join(testDir, 'lethebot.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    contextBuilder = new ContextBuilder(db, memoryRepo, identityRepo);
    traceRepo = new ContextTraceRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('selects the expected source for 12 current, quote, and thread queries', async () => {
    for (const retrievalCase of RETRIEVAL_CASES) {
      const fixture = await seedRetrievalCase(
        db,
        memoryRepo,
        identityRepo,
        retrievalCase,
      );
      const context = await contextBuilder.buildContext({
        turnId: fixture.turnId,
        conversationId: fixture.conversationId,
        conversationType: fixture.conversationType,
        targetUserId: fixture.userId,
        groupId: fixture.groupId,
        currentMessageId: fixture.currentMessageId,
        replyToMessageId: fixture.replyToMessageId,
      });
      const trace = context.trace as (typeof context.trace & {
        memorySelections?: ExpectedSelectionEvidence[];
      });
      const selections = trace?.memorySelections ?? [];
      const selectedIds = context.memory.selectedMemoryIds;
      const rejectedMemories = trace?.rejectedMemories ?? [];
      const rejectedIds = rejectedMemories.map((entry) => entry.memoryId);
      const accountedIds = [...selectedIds, ...rejectedIds];
      const strongerDistractors = db.prepare(
        `SELECT COUNT(*) AS count
           FROM memory_records AS distractor
           JOIN memory_records AS target ON target.id = ?
          WHERE distractor.id LIKE ?
            AND distractor.created_at > target.created_at
            AND distractor.importance > target.importance`,
      ).get(
        fixture.targetMemoryId,
        `memory-r8-distractor-${String(retrievalCase.index + 1).padStart(2, '0')}-%`,
      ) as { count: number };

      expect.soft(strongerDistractors.count).toBe(retrievalCase.distractorCount);
      expect.soft(
        trace?.candidateMemoryIds,
        `${retrievalCase.id}: lexical target must enter the bounded candidate set`,
      ).toContain(fixture.targetMemoryId);
      expect.soft(
        selectedIds,
        `${retrievalCase.id}: lexical target must survive the production token budget`,
      ).toContain(fixture.targetMemoryId);
      for (const incompatibleMemoryId of fixture.incompatibleMemoryIds) {
        expect.soft(
          selectedIds,
          `${retrievalCase.id}: incompatible memory must not be selected`,
        ).not.toContain(incompatibleMemoryId);
      }
      for (const crossOwnerMemoryId of fixture.crossOwnerFloodMemoryIds) {
        expect.soft(
          trace?.candidateMemoryIds,
          `${retrievalCase.id}: another user's group memory must be filtered before FTS limit`,
        ).not.toContain(crossOwnerMemoryId);
      }
      expect.soft(
        trace?.selectedMemoryIds,
        `${retrievalCase.id}: ContextPack and trace selection order must agree`,
      ).toEqual(selectedIds);
      expect.soft(
        new Set(accountedIds).size,
        `${retrievalCase.id}: a candidate must not be selected and rejected`,
      ).toBe(accountedIds.length);
      expect.soft(
        [...new Set(accountedIds)].sort(),
        `${retrievalCase.id}: every bounded candidate needs one terminal reason`,
      ).toEqual([...(trace?.candidateMemoryIds ?? [])].sort());
      expect.soft(
        rejectedMemories.every((rejection) => rejection.reason.trim().length > 0),
        `${retrievalCase.id}: every rejected candidate needs a non-empty reason`,
      ).toBe(true);
      expect.soft(
        selections.map((selection) => selection.memoryId),
        `${retrievalCase.id}: every selected memory needs structured evidence`,
      ).toEqual(selectedIds);
      expect.soft(
        selections,
        `${retrievalCase.id}: target selection evidence must name query, FTS, and scope`,
      ).toContainEqual(expect.objectContaining({
        memoryId: fixture.targetMemoryId,
        retrievalRank: 1,
        selectionReason: 'query_match',
        querySources: [selectionQuerySource(retrievalCase.querySource)],
        retrievalMethods: expect.arrayContaining(['fts']),
        scopeAffinity: retrievalCase.expectedScopeAffinity,
      }));
      const targetSelection = selections.find(
        (selection) => selection.memoryId === fixture.targetMemoryId,
      );
      if (retrievalCase.distractorCount > 50) {
        expect.soft(
          targetSelection?.retrievalMethods,
          `${retrievalCase.id}: FTS must rescue the target beyond the scoped LIMIT 50`,
        ).toEqual(['fts']);
      }
      expect.soft(context.tokenBudget.used).toBeLessThanOrEqual(context.tokenBudget.max);

      await traceRepo.createFromContext(context);
      const stored = await traceRepo.findByTurnId(fixture.turnId);
      expect.soft(
        stored?.candidateMemoryIds,
        `${retrievalCase.id}: durable trace must preserve candidate order`,
      ).toEqual(trace?.candidateMemoryIds);
      expect.soft(stored?.selectedMemoryIds).toEqual(trace?.selectedMemoryIds);
      expect.soft(stored?.rejectedMemories).toEqual(rejectedMemories);
      expect.soft(
        stored?.memorySelections,
        `${retrievalCase.id}: durable trace must round-trip all selection evidence`,
      ).toEqual(selections);
      expect.soft(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect.soft(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    }
  }, 60_000);

  it('orders competing query sources and scope affinities deterministically', async () => {
    const userId = 'user-r8-order';
    const groupId = 'group-r8-order';
    const conversationId = 'conversation-r8-order';
    const turnId = 'turn-r8-order';
    await identityRepo.ensureCanonicalUser(userId);

    seedChatMessage(db, {
      rawEventId: 'raw-r8-order-quote',
      chatMessageId: 'message-r8-order-quote',
      platformMessageId: 'platform-r8-order-quote',
      conversationId,
      conversationType: 'group',
      groupId,
      senderId: userId,
      text: 'quoteordertoken',
      timestamp: 1_900_000_000_000,
    });
    seedChatMessage(db, {
      rawEventId: 'raw-r8-order-thread',
      chatMessageId: 'message-r8-order-thread',
      platformMessageId: 'platform-r8-order-thread',
      conversationId,
      conversationType: 'group',
      groupId,
      senderId: userId,
      text: 'threadordertoken',
      timestamp: 1_900_000_000_001,
    });
    seedChatMessage(db, {
      rawEventId: 'raw-r8-order-current',
      chatMessageId: 'message-r8-order-current',
      platformMessageId: 'platform-r8-order-current',
      conversationId,
      conversationType: 'group',
      groupId,
      senderId: userId,
      text: 'currentordertoken scopeordertoken',
      timestamp: 1_900_000_000_002,
    });
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turnId,
      conversationId,
      'raw-r8-order-current',
      'mock',
      'mock',
      'running',
      1_900_000_000_002,
    );

    const sourceMemoryIds = ['current', 'quote', 'thread'].map(
      (source) => `memory-r8-order-${source}`,
    );
    for (const [source, token] of [
      ['current', 'currentordertoken'],
      ['quote', 'quoteordertoken'],
      ['thread', 'threadordertoken'],
    ] as const) {
      await memoryRepo.create(memoryInput({
        id: `memory-r8-order-${source}`,
        boundary: 'group_fact',
        userId,
        groupId,
        conversationId,
        title: 'Query source order',
        content: token,
        importance: 0.5,
      }));
    }

    const scopeMemoryIds = [
      'memory-r8-order-conversation',
      'memory-r8-order-group',
      'memory-r8-order-user',
      'memory-r8-order-global',
    ];
    await memoryRepo.create(memoryInput({
      id: scopeMemoryIds[0],
      boundary: 'conversation_fact',
      userId,
      groupId,
      conversationId,
      title: 'Scope order',
      content: 'scopeordertoken',
      importance: 0.5,
    }));
    await memoryRepo.create(memoryInput({
      id: scopeMemoryIds[1],
      boundary: 'group_fact',
      userId,
      groupId,
      conversationId,
      title: 'Scope order',
      content: 'scopeordertoken',
      importance: 0.5,
    }));
    await memoryRepo.create({
      id: scopeMemoryIds[2],
      scope: 'user',
      canonicalUserId: userId,
      visibility: 'same_user_any_context',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'Scope order',
      content: 'scopeordertoken',
      state: 'active',
      confidence: 0.9,
      importance: 0.5,
      sourceContext: 'admin_cli:synthetic-retrieval-fixture',
      sources: syntheticMemorySources(scopeMemoryIds[2]),
      actor: syntheticMemoryActor(),
    });
    await memoryRepo.create({
      id: scopeMemoryIds[3],
      scope: 'global',
      visibility: 'public',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: 'Scope order',
      content: 'scopeordertoken',
      state: 'active',
      confidence: 0.9,
      importance: 0.5,
      sourceContext: 'admin_cli:synthetic-retrieval-fixture',
      sources: syntheticMemorySources(scopeMemoryIds[3]),
      actor: syntheticMemoryActor(),
    });

    const context = await contextBuilder.buildContext({
      turnId,
      conversationId,
      conversationType: 'group',
      targetUserId: userId,
      groupId,
      currentMessageId: 'message-r8-order-current',
      replyToMessageId: 'platform-r8-order-quote',
    });
    const selectedIds = context.memory.selectedMemoryIds;
    expect(selectedIds.filter((memoryId) => sourceMemoryIds.includes(memoryId))).toEqual(
      sourceMemoryIds,
    );
    expect(selectedIds.filter((memoryId) => scopeMemoryIds.includes(memoryId))).toEqual(
      scopeMemoryIds,
    );
    expect(context.trace?.memorySelections?.map((selection) => selection.retrievalRank)).toEqual(
      selectedIds.map((_, index) => index + 1),
    );
  });
});

function selectionQuerySource(
  querySource: QuerySource,
): 'current_message' | 'quoted_message' | 'recent_thread' {
  if (querySource === 'current_query') {
    return 'current_message';
  }
  if (querySource === 'resolved_quote') {
    return 'quoted_message';
  }
  return 'recent_thread';
}

async function seedRetrievalCase(
  db: Database.Database,
  memoryRepo: MemoryRepository,
  identityRepo: IdentityRepository,
  retrievalCase: RetrievalCase,
): Promise<{
  turnId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId?: string;
  userId: string;
  currentMessageId: string;
  replyToMessageId?: string;
  targetMemoryId: string;
  incompatibleMemoryIds: string[];
  crossOwnerFloodMemoryIds: string[];
}> {
  const suffix = String(retrievalCase.index + 1).padStart(2, '0');
  const token = `retrievaltarget${suffix}`;
  const userId = `user-r8-${suffix}`;
  const otherUserId = `user-r8-other-${suffix}`;
  const groupId = `group-r8-${suffix}`;
  const otherGroupId = `group-r8-other-${suffix}`;
  const isPrivate = retrievalCase.boundary === 'private_user';
  const conversationType = isPrivate ? 'private' : 'group';
  const conversationId = isPrivate ? `private:r8-${suffix}` : `conversation-r8-${suffix}`;
  const turnId = `turn-r8-${suffix}`;
  const baseTimestamp = 1_800_000_000_000 + retrievalCase.index * 100_000;

  await identityRepo.ensureCanonicalUser(userId);
  await identityRepo.ensureCanonicalUser(otherUserId);

  const currentMessageId = `message-r8-current-${suffix}`;
  const currentRawEventId = `raw-r8-current-${suffix}`;
  const currentText = retrievalCase.querySource === 'current_query'
    ? token
    : 'synthetic retrieval request';
  seedChatMessage(db, {
    rawEventId: currentRawEventId,
    chatMessageId: currentMessageId,
    platformMessageId: `platform-r8-current-${suffix}`,
    conversationId,
    conversationType,
    groupId: isPrivate ? undefined : groupId,
    senderId: userId,
    text: currentText,
    timestamp: baseTimestamp + 50_000,
  });
  db.prepare(
    `INSERT INTO agent_turns (
      id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(turnId, conversationId, currentRawEventId, 'mock', 'mock', 'running', baseTimestamp + 50_000);

  let replyToMessageId: string | undefined;
  if (retrievalCase.querySource === 'resolved_quote') {
    const quoteMessageId = `message-r8-quote-${suffix}`;
    replyToMessageId = `platform-r8-quote-${suffix}`;
    seedChatMessage(db, {
      rawEventId: `raw-r8-quote-${suffix}`,
      chatMessageId: quoteMessageId,
      platformMessageId: replyToMessageId,
      conversationId,
      conversationType,
      groupId: isPrivate ? undefined : groupId,
      senderId: userId,
      text: token,
      timestamp: baseTimestamp,
    });

    if (retrievalCase.index === MEMORY_BOUNDARIES.length) {
      for (let index = 0; index < 21; index += 1) {
        seedChatMessage(db, {
          rawEventId: `raw-r8-quote-window-${suffix}-${index}`,
          chatMessageId: `message-r8-quote-window-${suffix}-${index}`,
          platformMessageId: `platform-r8-quote-window-${suffix}-${index}`,
          conversationId,
          conversationType,
          groupId: isPrivate ? undefined : groupId,
          senderId: userId,
          text: `unrelated rolling message ${index}`,
          timestamp: baseTimestamp + 1_000 + index,
        });
      }
    }
  }

  if (retrievalCase.querySource === 'recent_thread') {
    seedChatMessage(db, {
      rawEventId: `raw-r8-thread-${suffix}`,
      chatMessageId: `message-r8-thread-${suffix}`,
      platformMessageId: `platform-r8-thread-${suffix}`,
      conversationId,
      conversationType,
      groupId: isPrivate ? undefined : groupId,
      senderId: userId,
      text: token,
      timestamp: baseTimestamp + 10_000,
    });
  }

  const targetMemoryId = `memory-r8-target-${suffix}`;
  await memoryRepo.create(memoryInput({
    id: targetMemoryId,
    boundary: retrievalCase.boundary,
    userId,
    groupId,
    conversationId,
    title: `Relevant ${token}`,
    content: `The relevant source contains ${token}.${TARGET_FILLER}`,
    importance: 0.01,
  }));
  for (let index = 0; index < retrievalCase.distractorCount; index += 1) {
    await memoryRepo.create(memoryInput({
      id: `memory-r8-distractor-${suffix}-${String(index).padStart(2, '0')}`,
      boundary: retrievalCase.boundary,
      userId,
      groupId,
      conversationId,
      title: `Higher priority unrelated record ${index}`,
      content: `Unrelated record ${index}.${DISTRACTOR_FILLER}`,
      importance: 0.99,
    }));
  }

  const incompatibleInputs: Array<{
    label: string;
    boundary: MemoryBoundary;
    userId: string;
    groupId: string;
    conversationId: string;
  }> = isPrivate
    ? [
        {
          label: 'other-group-user',
          boundary: 'group_user',
          userId,
          groupId: otherGroupId,
          conversationId: `other-conversation-r8-${suffix}`,
        },
        {
          label: 'other-private-user',
          boundary: 'private_user',
          userId: otherUserId,
          groupId: otherGroupId,
          conversationId: `private:r8-other-${suffix}`,
        },
      ]
    : [
        {
          label: 'other-group-user',
          boundary: 'group_user',
          userId,
          groupId: otherGroupId,
          conversationId,
        },
        {
          label: 'other-group-fact',
          boundary: 'group_fact',
          userId,
          groupId: otherGroupId,
          conversationId,
        },
        {
          label: 'other-conversation-fact',
          boundary: 'conversation_fact',
          userId,
          groupId,
          conversationId: `other-conversation-r8-${suffix}`,
        },
        {
          label: 'other-user-same-group',
          boundary: 'group_user',
          userId: otherUserId,
          groupId,
          conversationId,
        },
      ];
  const incompatibleMemoryIds: string[] = [];
  for (const incompatible of incompatibleInputs) {
    const memoryId = `memory-r8-incompatible-${incompatible.label}-${suffix}`;
    incompatibleMemoryIds.push(memoryId);
    await memoryRepo.create(memoryInput({
      id: memoryId,
      boundary: incompatible.boundary,
      userId: incompatible.userId,
      groupId: incompatible.groupId,
      conversationId: incompatible.conversationId,
      title: `Incompatible ${token}`,
      content: `This incompatible record also contains ${token}`,
      importance: 1,
    }));
  }

  const crossOwnerFloodMemoryIds: string[] = [];
  if (retrievalCase.id === 'current_query-group_fact') {
    for (let index = 0; index < 51; index += 1) {
      const memoryId = `memory-r8-cross-owner-${suffix}-${String(index).padStart(2, '0')}`;
      crossOwnerFloodMemoryIds.push(memoryId);
      await memoryRepo.create(memoryInput({
        id: memoryId,
        boundary: 'group_user',
        userId: otherUserId,
        groupId,
        conversationId,
        title: `${token} ${token} ${token}`,
        content: `${token} ${token} ${token}`,
        importance: 1,
      }));
    }
  }

  return {
    turnId,
    conversationId,
    conversationType,
    ...(isPrivate ? {} : { groupId }),
    userId,
    currentMessageId,
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    targetMemoryId,
    incompatibleMemoryIds,
    crossOwnerFloodMemoryIds,
  };
}

function memoryInput(input: {
  id: string;
  boundary: MemoryBoundary;
  userId: string;
  groupId: string;
  conversationId: string;
  title: string;
  content: string;
  importance: number;
}): MemoryRecordInput {
  const isUser = input.boundary === 'private_user' || input.boundary === 'group_user';
  const isPrivate = input.boundary === 'private_user';
  return {
    id: input.id,
    scope: isUser
      ? 'user'
      : input.boundary === 'group_fact'
        ? 'group'
        : 'conversation',
    ...(isUser ? { canonicalUserId: input.userId } : {}),
    ...(isPrivate ? {} : { groupId: input.groupId }),
    ...(input.boundary === 'conversation_fact'
      ? { conversationId: input.conversationId }
      : {}),
    visibility: isPrivate ? 'private_only' : 'same_group_only',
    sensitivity: 'normal',
    authority: isUser ? 'user_stated' : 'system',
    kind: isUser ? 'preference' : 'fact',
    title: input.title,
    content: input.content,
    state: 'active',
    confidence: 0.9,
    importance: input.importance,
    sourceContext: 'admin_cli:synthetic-retrieval-fixture',
    sources: syntheticMemorySources(input.id),
    actor: syntheticMemoryActor(),
  };
}

function syntheticMemorySources(memoryId: string): MemoryRecordInput['sources'] {
  return [{
    sourceType: 'user_command',
    sourceId: `external:${memoryId}`,
    sourceTimestamp: 1_700_000_000_000,
    extractedBy: 'user',
    external: true,
  }];
}

function syntheticMemoryActor(): NonNullable<MemoryRecordInput['actor']> {
  return {
    actorClass: 'admin',
    context: 'admin_cli',
  };
}

function seedChatMessage(db: Database.Database, input: {
  rawEventId: string;
  chatMessageId: string;
  platformMessageId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId?: string;
  senderId: string;
  text: string;
  timestamp: number;
}): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.rawEventId,
    'chat.message.received',
    input.timestamp,
    'gateway',
    'qq',
    input.conversationId,
    '{}',
    input.timestamp,
  );
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id, conversation_type,
      group_id, sender_id, text, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.chatMessageId,
    input.rawEventId,
    input.platformMessageId,
    input.conversationId,
    input.conversationType,
    input.groupId ?? null,
    input.senderId,
    input.text,
    input.timestamp,
  );
}
