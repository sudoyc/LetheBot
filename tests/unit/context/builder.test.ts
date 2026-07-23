import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigrations, closeDatabase } from '../../../src/storage/database';
import { ContextBuilder } from '../../../src/context/builder';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { IdentityRepository } from '../../../src/storage/identity-repository';
import { GroupSummaryPolicyRepository } from '../../../src/storage/group-summary-policy-repository';

describe('ContextBuilder', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let createMemory: MemoryRepository['create'];
  let identityRepo: IdentityRepository;
  let groupSummaryPolicies: GroupSummaryPolicyRepository;
  let builder: ContextBuilder;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigrations(db, join(__dirname, '../../../migrations'));
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    groupSummaryPolicies = new GroupSummaryPolicyRepository(db);
    builder = new ContextBuilder(memoryRepo, identityRepo);

    const now = Date.now();
    for (const canonicalUserId of ['user-alice', 'user-bob', 'user-charlie']) {
      db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
        canonicalUserId,
        now,
        now,
      );
      seedPlatformAccount(db, canonicalUserId, `qq-${canonicalUserId}`, now);
    }

    seedMemoryEvidence(db, {
      rawEventId: 'raw-context-builder-source',
      chatMessageId: 'msg-context-builder-source',
      conversationId: 'private:user-alice',
      conversationType: 'private',
      senderId: 'qq-user-alice',
      timestamp: now,
    });
    seedMemoryEvidence(db, {
      rawEventId: 'raw-context-builder-bob-source',
      chatMessageId: 'msg-context-builder-bob-source',
      conversationId: 'private:user-bob',
      conversationType: 'private',
      senderId: 'qq-user-bob',
      timestamp: now + 1,
    });
    seedMemoryEvidence(db, {
      rawEventId: 'raw-context-builder-charlie-source',
      chatMessageId: 'msg-context-builder-charlie-source',
      conversationId: 'private:user-charlie',
      conversationType: 'private',
      senderId: 'qq-user-charlie',
      timestamp: now + 2,
    });
    seedMemoryEvidence(db, {
      rawEventId: 'raw-context-builder-hard-budget-source',
      chatMessageId: 'msg-context-builder-hard-budget-source',
      conversationId: 'group:hard-budget',
      conversationType: 'group',
      groupId: 'group-hard-budget',
      senderId: 'qq-user-alice',
      timestamp: now + 3,
    });
    seedMemoryEvidence(db, {
      rawEventId: 'raw-context-builder-group-1-source',
      chatMessageId: 'msg-context-builder-group-1-source',
      conversationId: 'conv-group-1',
      conversationType: 'group',
      groupId: 'group-1',
      senderId: 'qq-user-alice',
      timestamp: now + 4,
    });

    createMemory = (input) => memoryRepo.create({
      ...input,
      sources: input.sources ?? [
        {
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-source',
          sourceTimestamp: now,
          extractedBy: 'user',
        },
      ],
    });
  });

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('buildContext', () => {
    it('should build basic context pack', async () => {
      const context = await builder.buildContext({
        turnId: 'turn-001',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'user-alice',
            text: '你好',
            timestamp: new Date(),
            senderDisplayName: 'Alice',
            isFromBot: false,
          },
        ],
      });

      expect(context.id).toBeDefined();
      expect(context.turnId).toBe('turn-001');
      expect(context.conversation.conversationId).toBe('private:user-alice');
      expect(context.recentMessages).toHaveLength(1);
      expect(context.tokenBudget.max).toBeGreaterThan(0);
    });

    it('should retrieve user memory with private_only visibility', async () => {
      // Create user memory
      await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'personal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Secret preference',
        content: 'I prefer dark mode',
        state: 'active',
        confidence: 0.9,
        importance: 0.5,
        sourceContext: 'private chat',
        sourceEventIds: [],
      });

      const context = await builder.buildContext({
        turnId: 'turn-002',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-alice',
      });

      expect(context.memory.retrievedFacts).toHaveLength(1);
      expect(context.memory.retrievedFacts[0].content).toContain('dark mode');
    });

    it('should reject legacy normal-labeled secret-like memory at the final prompt boundary', async () => {
      const contentSecret = 'sk-legacy-context-content-abcdefghijklmnopqrstuv';
      const titleSecret = 'ghp_legacycontexttitleabcdefghijklmnop';
      const now = Date.now();
      const legacyRows = [
        {
          id: 'legacy-secret-memory-content',
          title: 'Legacy credential note',
          content: `The old credential was ${contentSecret}`,
        },
        {
          id: 'legacy-secret-memory-title',
          title: `Legacy token ${titleSecret}`,
          content: 'This legacy row was incorrectly labeled normal',
        },
      ];

      const insertLegacyMemory = db.prepare(
        `INSERT INTO memory_records (
          id, scope, canonical_user_id, visibility, sensitivity, authority,
          kind, title, content, state, confidence, importance, created_at, updated_at
        ) VALUES (?, 'user', 'user-alice', 'private_only', 'normal', 'user_stated',
                  'fact', ?, ?, 'active', 0.9, 0.9, ?, ?)`
      );
      for (const row of legacyRows) {
        insertLegacyMemory.run(row.id, row.title, row.content, now, now);
      }

      const context = await builder.buildContext({
        turnId: 'turn-legacy-secret-memory-boundary',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-alice',
      });

      expect(context.trace?.candidateMemoryIds).toEqual(
        expect.arrayContaining(legacyRows.map((row) => row.id))
      );
      expect(context.trace?.rejectedMemories).toEqual(
        expect.arrayContaining(legacyRows.map((row) => ({
          memoryId: row.id,
          reason: 'content_policy:secret',
        })))
      );
      expect(context.memory.selectedMemoryIds).not.toEqual(
        expect.arrayContaining(legacyRows.map((row) => row.id))
      );
      expect(context.memory.retrievedFacts).toEqual([]);
      expect(context.memory.userProfile).toBeUndefined();
      expect(context.memory.groupProfile).toBeUndefined();
      expect(JSON.stringify(context)).not.toContain(contentSecret);
      expect(JSON.stringify(context)).not.toContain(titleSecret);

      const storedRows = db.prepare(
        `SELECT id, title, content, sensitivity, state
         FROM memory_records
         WHERE id IN (?, ?)
         ORDER BY id ASC`
      ).all(...legacyRows.map((row) => row.id));
      expect(storedRows).toEqual(legacyRows
        .map((row) => ({ ...row, sensitivity: 'normal', state: 'active' }))
        .sort((left, right) => left.id.localeCompare(right.id)));
    });

    it('should NOT include private_only memory in group context', async () => {
      // Create private memory
      await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'personal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Secret',
        content: 'My password is secret123',
        state: 'active',
        confidence: 0.9,
        importance: 0.5,
        sourceContext: 'private chat',
        sourceEventIds: [],
      });

      const context = await builder.buildContext({
        turnId: 'turn-003',
        conversationId: 'group:tech-chat',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-alice',
      });

      // Private memory should be filtered out
      expect(context.memory.retrievedFacts.every((m) => !m.content.includes('secret123'))).toBe(true);
      expect(context.trace?.rejectedMemories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: 'private_only_in_group_context',
          }),
        ])
      );
    });

    it('should apply group visibility before user-memory retrieval limits', async () => {
      for (let i = 0; i < 50; i += 1) {
        await createMemory({
          scope: 'user',
          canonicalUserId: 'user-alice',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: `Private high-importance ${i}`,
          content: `Private high-importance memory ${i} must not starve visible group context`,
          state: 'active',
          confidence: 0.9,
          importance: 0.9,
          sourceContext: 'private_chat',
        });
      }

      const visibleId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Visible group user fact',
        content: 'Visible user memory should survive group context retrieval limits',
        state: 'active',
        confidence: 0.8,
        importance: 0.1,
        sourceContext: 'private_chat',
      });

      const context = await builder.buildContext({
        turnId: 'turn-group-visibility-limit',
        conversationId: 'group:visibility-limit',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-alice',
        groupId: 'group-visibility-limit',
      });

      expect(context.memory.selectedMemoryIds).toContain(visibleId);
      expect(context.memory.retrievedFacts).toHaveLength(1);
      expect(context.memory.retrievedFacts[0].memoryId).toBe(visibleId);
      expect(context.trace?.candidateMemoryIds).toContain(visibleId);
      expect(context.trace?.rejectedMemories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: 'private_only_in_group_context',
          }),
        ])
      );
    });

    it('should include same_user_any_context memory in both private and group', async () => {
      await createMemory({
        scope: 'user',
        canonicalUserId: 'user-bob',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'preference',
        title: 'Language preference',
        content: 'Prefers English',
        state: 'active',
        confidence: 0.8,
        importance: 0.5,
        sourceContext: 'conversation',
        sourceEventIds: [],
        sources: [{
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-bob-source',
        }],
      });

      // Private context
      const privateCtx = await builder.buildContext({
        turnId: 'turn-004',
        conversationId: 'private:user-bob',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-bob',
      });

      expect(privateCtx.memory.retrievedFacts.some((m) => m.content.includes('English'))).toBe(true);

      // Group context
      const groupCtx = await builder.buildContext({
        turnId: 'turn-005',
        conversationId: 'group:dev-team',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-bob',
      });

      expect(groupCtx.memory.retrievedFacts.some((m) => m.content.includes('English'))).toBe(true);
    });

    it('should exclude deleted memory', async () => {
      const memId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-charlie',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Fact',
        content: 'Important fact',
        state: 'active',
        confidence: 0.9,
        importance: 0.5,
        sourceContext: 'chat',
        sourceEventIds: [],
        sources: [{
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-charlie-source',
        }],
      });

      await memoryRepo.delete(memId);

      const context = await builder.buildContext({
        turnId: 'turn-006',
        conversationId: 'private:user-charlie',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-charlie',
      });

      expect(context.memory.retrievedFacts).toHaveLength(0);
      expect(context.trace?.selectedMemoryIds).toHaveLength(0);
    });

    it('should calculate token budget', async () => {
      const context = await builder.buildContext({
        turnId: 'turn-007',
        conversationId: 'private:user-dave',
        conversationType: 'private',
        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'user-dave',
            text: 'Hello world this is a test message',
            timestamp: new Date(),
            senderDisplayName: 'Dave',
            isFromBot: false,
          },
        ],
        targetUserId: 'user-dave',
      });

      expect(context.tokenBudget.used).toBeGreaterThan(0);
      expect(context.tokenBudget.breakdown.recentMessages).toBeGreaterThan(0);
      expect(context.tokenBudget.breakdown.system).toBeGreaterThan(0);
    });

    it('should enforce the token budget while retaining a marked latest user input', async () => {
      const originalText = 'latest-user-input-'.repeat(1_200);
      const context = await builder.buildContext({
        turnId: 'turn-hard-token-budget-latest',
        conversationId: 'group:hard-token-budget-latest',
        conversationType: 'group',
        groupId: 'group-hard-token-budget-latest',
        recentMessages: [
          {
            messageId: 'msg-hard-token-budget-latest',
            senderId: 'user-alice',
            senderDisplayName: 'Alice',
            text: originalText,
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
        targetUserId: 'user-alice',
        participants: [
          {
            canonicalUserId: 'user-bob',
            displayName: 'Participant omitted after latest input consumes the budget',
            isOwner: false,
            isAdmin: false,
            isTrusted: false,
          },
        ],
      });

      expect(context.tokenBudget.used).toBeLessThanOrEqual(context.tokenBudget.max);
      expect(context.tokenBudget.max).toBe(8_000);
      expect(context.recentMessages).toHaveLength(1);
      expect(context.recentMessages[0]?.messageId).toBe('msg-hard-token-budget-latest');
      expect(context.recentMessages[0]?.text).not.toBe(originalText);
      expect(context.recentMessages[0]?.text).toMatch(/ \[truncated\]$/);
      expect(context.trace?.filtersApplied).toContain(
        'token_budget:latest_user_message_truncated'
      );
      expect(context.participants).toEqual([
        expect.objectContaining({
          canonicalUserId: 'user-alice',
          speakerRef: 'speaker_1',
          displayName: 'Alice',
        }),
      ]);
      expect(context.injectedIdentityFields).toContain('participant_context');
      expect(context.trace?.filtersApplied).toContain(
        'token_budget:participants_omitted=1'
      );
      expect(
        context.tokenBudget.promptLayers?.reduce((sum, layer) => sum + layer.tokens, 0)
      ).toBe(context.tokenBudget.used);
    });

    it('should apply participant, profile, history, scoped-memory, then global-memory budget priority', async () => {
      groupSummaryPolicies.setEnabled({
        groupId: 'group-hard-budget',
        enabled: true,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-alice',
          invocationContext: 'admin_cli',
        },
      });
      const highConfidenceUserProfileId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'summary',
        title: 'High confidence user profile',
        content: 'U'.repeat(1_800),
        state: 'active',
        confidence: 0.95,
        importance: 0.1,
        sourceContext: 'worker_extraction',
      });
      const lowConfidenceUserProfileId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'summary',
        title: 'Low confidence user profile',
        content: 'u'.repeat(20_000),
        state: 'active',
        confidence: 0.2,
        importance: 1,
        sourceContext: 'worker_extraction',
      });
      const highConfidenceGroupProfileId = await createMemory({
        scope: 'group',
        groupId: 'group-hard-budget',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'High confidence group profile',
        content: 'G'.repeat(1_800),
        state: 'active',
        confidence: 0.9,
        importance: 0.1,
        sourceContext: 'background_worker:summary',
        sources: [{
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-hard-budget-source',
        }],
      });
      const lowConfidenceGroupProfileId = await createMemory({
        scope: 'group',
        groupId: 'group-hard-budget',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Low confidence group profile',
        content: 'g'.repeat(20_000),
        state: 'active',
        confidence: 0.1,
        importance: 1,
        sourceContext: 'background_worker:summary',
        sources: [{
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-hard-budget-source',
        }],
      });
      const scopedMemoryId = await createMemory({
        scope: 'conversation',
        conversationId: 'group:hard-budget',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Scoped memory retained first',
        content: 'S'.repeat(4_000),
        state: 'active',
        confidence: 0.8,
        importance: 0.2,
        sourceContext: 'group_chat',
        sources: [{
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-hard-budget-source',
        }],
      });
      const globalMemoryId = await createMemory({
        scope: 'global',
        visibility: 'public',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: 'Global memory with higher importance',
        content: 'W'.repeat(4_000),
        state: 'active',
        confidence: 0.99,
        importance: 1,
        sourceContext: 'system',
      });

      const context = await builder.buildContext({
        turnId: 'turn-hard-token-budget-priority',
        conversationId: 'group:hard-budget',
        conversationType: 'group',
        groupId: 'group-hard-budget',
        targetUserId: 'user-alice',
        participants: [
          {
            canonicalUserId: 'user-bob',
            displayName: 'P'.repeat(100),
            role: 'admin',
            isOwner: false,
            isAdmin: true,
            isTrusted: true,
          },
        ],
        recentMessages: [
          {
            messageId: 'msg-budget-history-user',
            senderId: 'user-bob',
            senderDisplayName: 'Bob',
            text: 'H'.repeat(1_000),
            timestamp: new Date(1),
            isFromBot: false,
          },
          {
            messageId: 'msg-budget-history-bot',
            senderId: 'bot-self',
            senderDisplayName: 'LetheBot',
            text: 'B'.repeat(1_000),
            timestamp: new Date(2),
            isFromBot: true,
          },
          {
            messageId: 'msg-budget-latest-user',
            senderId: 'user-alice',
            senderDisplayName: 'Alice',
            text: 'latest question',
            timestamp: new Date(3),
            isFromBot: false,
          },
        ],
      });

      expect(context.tokenBudget.used).toBeLessThanOrEqual(context.tokenBudget.max);
      expect(context.participants).toHaveLength(2);
      expect(context.participants.map((participant) => participant.speakerRef)).toEqual([
        'speaker_1',
        'speaker_3',
      ]);
      expect(context.injectedIdentityFields).toContain('participant_context');
      expect(context.memory.userProfile?.memoryId).toBe(highConfidenceUserProfileId);
      expect(context.memory.groupProfile?.memoryId).toBe(highConfidenceGroupProfileId);
      expect(context.memory.selectedMemoryIds).toEqual([
        highConfidenceUserProfileId,
        highConfidenceGroupProfileId,
        scopedMemoryId,
      ]);
      expect(context.memory.retrievedFacts.map((memory) => memory.memoryId)).toEqual(
        context.memory.selectedMemoryIds
      );
      expect(context.trace?.selectedMemoryIds).toEqual(context.memory.selectedMemoryIds);
      expect(context.trace?.memorySelections?.map((selection) => selection.memoryId)).toEqual(
        context.memory.selectedMemoryIds,
      );
      expect(context.trace?.memorySelections?.slice(0, 2).map((selection) => (
        selection.selectionReason
      ))).toEqual(['profile_priority', 'profile_priority']);
      expect(context.trace?.memorySelections?.[2]).toMatchObject({
        memoryId: scopedMemoryId,
        scopeAffinity: 'exact_conversation',
        retrievalRank: 3,
        selectionReason: 'ranked_fallback',
      });
      expect(context.recentMessages.map((message) => message.messageId)).toEqual([
        'msg-budget-history-user',
        'msg-budget-history-bot',
        'msg-budget-latest-user',
      ]);

      for (const memoryId of [
        lowConfidenceUserProfileId,
        lowConfidenceGroupProfileId,
        globalMemoryId,
      ]) {
        expect(context.trace?.rejectedMemories.filter(
          (rejection) => rejection.memoryId === memoryId
        )).toEqual([{ memoryId, reason: 'token_budget_exceeded' }]);
      }

      const accountedMemoryIds = [
        ...(context.trace?.selectedMemoryIds ?? []),
        ...(context.trace?.rejectedMemories.map((rejection) => rejection.memoryId) ?? []),
      ];
      expect(accountedMemoryIds).toHaveLength(context.trace?.candidateMemoryIds.length ?? 0);
      expect(new Set(accountedMemoryIds)).toEqual(
        new Set(context.trace?.candidateMemoryIds ?? [])
      );
      expect(
        context.tokenBudget.promptLayers?.reduce((sum, layer) => sum + layer.tokens, 0)
      ).toBe(context.tokenBudget.used);
    });

    it('should account for actual injected identity fields in token budget', async () => {
      const shortIdentityContext = await builder.buildContext({
        turnId: 'turn-identity-short',
        conversationId: 'group:g1',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'u1',
        groupId: 'g1',
      });

      const longIdentityContext = await builder.buildContext({
        turnId: 'turn-identity-long',
        conversationId: 'group:very-long-conversation-identity-for-budgeting',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-very-long-target-identity-for-budgeting',
        groupId: 'group-very-long-identity-for-budgeting',
      });

      expect(shortIdentityContext.injectedIdentityFields).toEqual(
        expect.arrayContaining(['conversation_id', 'conversation_type', 'group_id', 'target_user_ref'])
      );
      expect(shortIdentityContext.tokenBudget.breakdown.identity).toBeGreaterThan(0);
      expect(longIdentityContext.tokenBudget.breakdown.identity).toBeGreaterThan(
        shortIdentityContext.tokenBudget.breakdown.identity
      );
      expect(longIdentityContext.tokenBudget.used).toBe(
        longIdentityContext.tokenBudget.breakdown.recentMessages
        + longIdentityContext.tokenBudget.breakdown.memory
        + longIdentityContext.tokenBudget.breakdown.identity
        + longIdentityContext.tokenBudget.breakdown.system
      );
    });

    it('should prepare structured identity data and budget the rendered identity prompt', async () => {
      const secret = 'sk-context-identity-secret-abcdefghijklmnopqrstuvwxyz';
      const platformId = 'qq-1234567890';
      const expectedIdentityContext = [
        '## Identity',
        '- conversation_id="private:[REDACTED:platform_id]"',
        '- conversation_type="private"',
        '- target_user_ref="[REDACTED:api_key_assignment] [REDACTED:platform_id]"',
        '',
      ].join('\n');
      const rawIdentityContext = [
        '## Identity',
        `- conversation_id=${JSON.stringify(`private:${platformId}`)}`,
        '- conversation_type="private"',
        `- target_user_ref=${JSON.stringify(`api_key=${secret}-${platformId}`)}`,
        '',
      ].join('\n');

      const context = await builder.buildContext({
        turnId: 'turn-identity-rendered-budget',
        conversationId: `private:${platformId}`,
        conversationType: 'private',
        recentMessages: [],
        targetUserId: `api_key=${secret}-${platformId}`,
      });

      const identityLayer = context.tokenBudget.promptLayers?.find(
        (layer) => layer.name === 'identity_fields'
      );

      expect(context.injectedIdentityFields).toEqual([
        'conversation_id',
        'conversation_type',
        'target_user_ref',
      ]);
      expect(context.injectedIdentityData).toEqual([
        { name: 'conversation_id', value: `private:${platformId}` },
        { name: 'conversation_type', value: 'private' },
        { name: 'target_user_ref', value: `api_key=${secret}-${platformId}` },
      ]);
      expect(identityLayer?.tokens).toBe(
        Math.ceil(expectedIdentityContext.length / 2)
      );
      expect(context.tokenBudget.breakdown.identity).toBe(identityLayer?.tokens);
      expect(identityLayer?.tokens).toBeLessThan(
        Math.ceil(rawIdentityContext.length / 2)
      );
    });

    it('should attach prompt layer versions and token evidence to the budget trace', async () => {
      const context = await builder.buildContext({
        turnId: 'turn-budget-prompt-layers',
        conversationId: 'group:prompt-layer-budget',
        conversationType: 'group',
        recentMessages: [
          {
            messageId: 'msg-prompt-layer-budget',
            senderId: 'user-alice',
            text: 'Prompt layer version evidence should cover recent messages',
            timestamp: new Date(),
            senderDisplayName: 'Alice Prompt Layer',
            isFromBot: false,
          },
        ],
        targetUserId: 'user-alice',
        groupId: 'group-prompt-layer-budget',
        participants: [
          {
            canonicalUserId: 'user-alice',
            displayName: 'Alice Prompt Layer',
            groupCard: 'Prompt Layer Captain',
            role: 'admin',
            isOwner: false,
            isAdmin: true,
            isTrusted: true,
          },
        ],
      });

      const promptLayers = context.tokenBudget.promptLayers ?? [];

      expect(promptLayers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'recent_messages',
            version: 'pi-prompt-recent-message-v2',
            tokens: context.tokenBudget.breakdown.recentMessages,
          }),
          expect.objectContaining({
            name: 'memory_context',
            version: 'pi-prompt-memory-context-v2',
            tokens: context.tokenBudget.breakdown.memory,
          }),
          expect.objectContaining({
            name: 'identity_fields',
            version: 'context-builder-identity-fields-v2',
          }),
          expect.objectContaining({
            name: 'participant_context',
            version: 'pi-prompt-participant-context-v3',
          }),
          expect.objectContaining({
            name: 'message_references',
            version: 'pi-prompt-message-reference-v1',
          }),
          expect.objectContaining({
            name: 'system_prompt_estimate',
            version: 'bounded-system-estimate-v1',
            tokens: context.tokenBudget.breakdown.system,
          }),
        ])
      );

      const promptLayerTokens = promptLayers.reduce(
        (sum, layer) => sum + layer.tokens,
        0
      );
      expect(promptLayerTokens).toBe(context.tokenBudget.used);

      const identityLayerTokens = promptLayers
        .filter((layer) => (
          layer.name === 'identity_fields'
          || layer.name === 'participant_context'
          || layer.name === 'message_references'
        ))
        .reduce((sum, layer) => sum + layer.tokens, 0);
      expect(identityLayerTokens).toBe(context.tokenBudget.breakdown.identity);
    });

    it('should account for prompt-rendered recent-message labels and memory titles in token budget', async () => {
      const longDisplayName = 'Display name with enough length to affect prompt accounting';
      const withDisplayOnlyMessage = await builder.buildContext({
        turnId: 'turn-budget-display-label',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [
          {
            messageId: 'msg-budget-display-label',
            senderId: 'user-alice',
            senderDisplayName: longDisplayName,
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
        targetUserId: 'user-alice',
      });

      expect(withDisplayOnlyMessage.tokenBudget.breakdown.recentMessages).toBeGreaterThan(
        Math.ceil(longDisplayName.length / 2)
      );

      const longMemoryTitle = 'Long memory title that is rendered in the Pi context preamble and must be counted';
      const memoryId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: longMemoryTitle,
        content: 'short fact',
        state: 'active',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      const withMemory = await builder.buildContext({
        turnId: 'turn-budget-memory-title',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [],
        targetUserId: 'user-alice',
      });

      expect(withMemory.memory.selectedMemoryIds).toContain(memoryId);
      expect(withMemory.tokenBudget.breakdown.memory).toBeGreaterThan(
        Math.ceil('short fact'.length / 2) + Math.ceil(longMemoryTitle.length / 2)
      );
    });

    it('should redact assignment-shaped secret/platform display labels before token budgeting', async () => {
      const secret = 'sk-context-budget-secret-abcdefghijklmnopqrstuvwxyz';
      const platformId = 'qq-123456789';
      const sensitiveDisplayName = `api_key=${secret}-${platformId}`;
      const expectedRenderedLabel =
        'sender_display_name="[REDACTED:api_key_assignment] [REDACTED:platform_id]"';
      const rawRenderedLabel = `sender_display_name=${JSON.stringify(sensitiveDisplayName)}`;

      const context = await builder.buildContext({
        turnId: 'turn-budget-redacted-display-label',
        conversationId: 'private:user-alice',
        conversationType: 'private',
        recentMessages: [
          {
            messageId: 'msg-budget-redacted-display-label',
            senderId: 'user-alice',
            senderDisplayName: sensitiveDisplayName,
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      expect(context.tokenBudget.breakdown.recentMessages).toBe(
        Math.ceil(expectedRenderedLabel.length / 2)
      );
      expect(context.tokenBudget.breakdown.recentMessages).toBeLessThan(
        Math.ceil(rawRenderedLabel.length / 2)
      );
    });

    it('should redact assignment-shaped secret/platform participant labels before token budgeting', async () => {
      const displaySecret = 'sk-context-participant-display-abcdefghijklmnopqrstuvwxyz';
      const cardSecret = 'sk-context-participant-card-abcdefghijklmnopqrstuvwxyz';
      const displayPlatformId = 'qq-123456789';
      const cardPlatformId = 'qq-234567890';
      const sensitiveDisplayName = `api_key=${displaySecret}-${displayPlatformId}`;
      const sensitiveGroupCard = `token=${cardSecret}-${cardPlatformId}`;
      const expectedParticipantContext = [
        '## Participants',
        '- speaker_ref=speaker_1'
          + ' display_name="[REDACTED:api_key_assignment] [REDACTED:platform_id]"'
          + ' flags=[admin, trusted]'
          + ' role=admin'
          + ' group_card="[REDACTED:token_assignment] [REDACTED:platform_id]"',
        '',
      ].join('\n');
      const rawParticipantContext = [
        '## Participants',
        `- speaker_ref=speaker_1 display_name=${JSON.stringify(sensitiveDisplayName)}`
          + ' flags=[admin, trusted]'
          + ' role=admin'
          + ` group_card=${JSON.stringify(sensitiveGroupCard)}`,
        '',
      ].join('\n');

      const context = await builder.buildContext({
        turnId: 'turn-budget-redacted-participant-labels',
        conversationId: 'group:participant-redaction-budget',
        conversationType: 'group',
        groupId: 'group-participant-redaction-budget',
        recentMessages: [],
        targetUserId: 'user-alice',
        participants: [
          {
            canonicalUserId: 'user-bob',
            displayName: sensitiveDisplayName,
            groupCard: sensitiveGroupCard,
            role: 'admin',
            isOwner: false,
            isAdmin: true,
            isTrusted: true,
          },
        ],
      });

      const participantLayer = context.tokenBudget.promptLayers?.find(
        (layer) => layer.name === 'participant_context'
      );

      expect(participantLayer?.tokens).toBe(
        Math.ceil(expectedParticipantContext.length / 2)
      );
      expect(participantLayer?.tokens).toBeLessThan(
        Math.ceil(rawParticipantContext.length / 2)
      );
    });

    it('should carry group participant context and account for prompt-rendered participant labels', async () => {
      const withoutParticipants = await builder.buildContext({
        turnId: 'turn-budget-no-participants',
        conversationId: 'group:participant-budget',
        conversationType: 'group',
        groupId: 'group-participant-budget',
        recentMessages: [],
        targetUserId: 'user-alice',
      });

      const participantDisplayName = 'Participant display label with enough text to affect budget';
      const participantGroupCard = 'Participant group card label with enough text to affect budget';
      const withParticipants = await builder.buildContext({
        turnId: 'turn-budget-with-participants',
        conversationId: 'group:participant-budget',
        conversationType: 'group',
        groupId: 'group-participant-budget',
        recentMessages: [],
        targetUserId: 'user-alice',
        participants: [
          {
            canonicalUserId: 'user-bob',
            displayName: participantDisplayName,
            groupCard: participantGroupCard,
            role: 'admin',
            isOwner: false,
            isAdmin: true,
            isTrusted: true,
            platformAccountId: 'qq-123456789',
          },
        ],
      });

      expect(withParticipants.participants).toHaveLength(1);
      expect(withParticipants.participants[0]).toMatchObject({
        canonicalUserId: 'user-bob',
        displayName: participantDisplayName,
        groupCard: participantGroupCard,
        role: 'admin',
        isAdmin: true,
        isTrusted: true,
      });
      expect(withParticipants.injectedIdentityFields).toContain('participant_context');
      const participantLayer = withParticipants.tokenBudget.promptLayers?.find(
        (layer) => layer.name === 'participant_context'
      );
      const expectedParticipantContext = [
        '## Participants',
        `- speaker_ref=speaker_1 display_name="${participantDisplayName}"`
          + ' flags=[admin, trusted]'
          + ' role=admin'
          + ` group_card="${participantGroupCard}"`,
        '',
      ].join('\n');
      const participantContextWithPlatformAccount = [
        '## Participants',
        `- speaker_ref=speaker_1 display_name="${participantDisplayName}"`
          + ' flags=[admin, trusted]'
          + ' role=admin'
          + ` group_card="${participantGroupCard}"`
          + ' platform_account_id="[REDACTED:platform_id]"',
        '',
      ].join('\n');

      expect(participantLayer?.tokens).toBe(
        Math.ceil(expectedParticipantContext.length / 2)
      );
      expect(participantLayer?.tokens).toBeLessThan(
        Math.ceil(participantContextWithPlatformAccount.length / 2)
      );
      expect(withParticipants.tokenBudget.breakdown.identity).toBeGreaterThan(
        withoutParticipants.tokenBudget.breakdown.identity
        + Math.ceil(participantDisplayName.length / 2)
        + Math.ceil(participantGroupCard.length / 2)
      );
    });

    it('should retrieve group and conversation summaries with trace and identity fields', async () => {
      groupSummaryPolicies.setEnabled({
        groupId: 'group-1',
        enabled: true,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-alice',
          invocationContext: 'admin_cli',
        },
      });
      const groupSummaryId = await createMemory({
        scope: 'group',
        groupId: 'group-1',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Group summary',
        content: 'The group is discussing the release plan',
        state: 'active',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'background_worker:summary',
        sources: [{
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-group-1-source',
        }],
      });

      const conversationSummaryId = await createMemory({
        scope: 'conversation',
        conversationId: 'conv-group-1',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Conversation summary',
        content: 'This conversation covered deployment blockers',
        state: 'active',
        confidence: 0.85,
        importance: 0.7,
        sourceContext: 'background_worker:summary',
        sources: [{
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-group-1-source',
        }],
      });

      const context = await builder.buildContext({
        turnId: 'turn-008',
        conversationId: 'conv-group-1',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-alice',
        groupId: 'group-1',
      });

      expect(context.memory.selectedMemoryIds).toContain(groupSummaryId);
      expect(context.memory.selectedMemoryIds).toContain(conversationSummaryId);
      expect(context.memory.groupProfile?.memoryId).toBe(groupSummaryId);
      expect(context.trace?.candidateMemoryIds).toEqual(
        expect.arrayContaining([groupSummaryId, conversationSummaryId])
      );
      expect(context.trace?.selectedMemoryIds).toEqual(context.memory.selectedMemoryIds);
      expect(context.injectedIdentityFields).toEqual(
        expect.arrayContaining(['conversation_id', 'conversation_type', 'group_id', 'target_user_ref'])
      );
    });

    it('retains policy-blocked group summary IDs in trace without budgeting or injecting them', async () => {
      const groupSummaryId = await createMemory({
        scope: 'group',
        groupId: 'group-1',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Disabled group summary',
        content: 'This retained summary must not enter the prompt while policy is disabled',
        state: 'active',
        confidence: 0.9,
        importance: 1,
        sourceContext: 'background_worker:summary',
        sources: [{
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-group-1-source',
        }],
      });

      const context = await builder.buildContext({
        turnId: 'turn-disabled-group-summary-trace',
        conversationId: 'conv-group-1',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-alice',
        groupId: 'group-1',
      });

      expect(context.trace?.candidateMemoryIds).toContain(groupSummaryId);
      expect(context.trace?.selectedMemoryIds).not.toContain(groupSummaryId);
      expect(context.trace?.rejectedMemories).toContainEqual({
        memoryId: groupSummaryId,
        reason: 'group_summary_policy_disabled',
      });
      expect(context.trace?.filtersApplied).toContain('group_summary_policy=disabled');
      expect(context.memory.selectedMemoryIds).not.toContain(groupSummaryId);
      expect(context.memory.groupProfile).toBeUndefined();
      expect(context.memory.retrievedFacts).toEqual([]);
      expect(context.tokenBudget.breakdown.memory).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('does not use bounded trace IDs as the disabled-summary enforcement gate', async () => {
      for (let index = 0; index < 51; index += 1) {
        await createMemory({
          scope: 'group',
          groupId: 'group-1',
          visibility: 'same_group_only',
          sensitivity: 'normal',
          authority: 'tool_derived',
          kind: 'summary',
          title: `Higher-ranked retained summary ${index}`,
          content: `Unrelated retained summary ${index}`,
          state: 'active',
          confidence: 0.9,
          importance: 1,
          sourceContext: 'background_worker:summary',
          sources: [{
            sourceType: 'raw_event',
            sourceId: 'raw-context-builder-group-1-source',
          }],
        });
      }
      const currentConversationSummaryId = await createMemory({
        scope: 'group',
        groupId: 'group-1',
        conversationId: 'conv-group-1',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Lower-ranked current conversation summary',
        content: 'This retained summary must remain blocked despite trace truncation',
        state: 'active',
        confidence: 0.9,
        importance: 0.1,
        sourceContext: 'background_worker:summary',
        sources: [{
          sourceType: 'raw_event',
          sourceId: 'raw-context-builder-group-1-source',
        }],
      });

      const context = await builder.buildContext({
        turnId: 'turn-disabled-group-summary-overflow',
        conversationId: 'conv-group-1',
        conversationType: 'group',
        recentMessages: [],
        targetUserId: 'user-alice',
        groupId: 'group-1',
      });

      expect(context.trace?.candidateMemoryIds).not.toContain(currentConversationSummaryId);
      expect(context.memory.selectedMemoryIds).not.toContain(currentConversationSummaryId);
      expect(context.memory.retrievedFacts).toEqual([]);
      expect(context.memory.groupProfile).toBeUndefined();
      expect(context.tokenBudget.breakdown.memory).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });
  });
});

function seedPlatformAccount(
  db: Database.Database,
  canonicalUserId: string,
  platformAccountId: string,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO platform_accounts (
      platform, platform_account_id, canonical_user_id, account_type,
      verified_level, status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'qq',
    platformAccountId,
    canonicalUserId,
    'private',
    'observed',
    'active',
    timestamp,
    timestamp,
  );
}

function seedMemoryEvidence(db: Database.Database, input: {
  rawEventId: string;
  chatMessageId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId?: string;
  senderId: string;
  timestamp: number;
}): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.chatMessageId,
    input.rawEventId,
    `platform-${input.chatMessageId}`,
    input.conversationId,
    input.conversationType,
    input.groupId ?? null,
    input.senderId,
    'Synthetic memory provenance',
    input.timestamp,
  );
}
