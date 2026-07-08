import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { ContextBuilder } from '../../../src/context/builder';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { IdentityRepository } from '../../../src/storage/identity-repository';

describe('ContextBuilder', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let builder: ContextBuilder;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    builder = new ContextBuilder(memoryRepo, identityRepo);

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-alice',
      Date.now(),
      Date.now()
    );

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-bob',
      Date.now(),
      Date.now()
    );

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-charlie',
      Date.now(),
      Date.now()
    );
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
      await memoryRepo.create({
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

    it('should NOT include private_only memory in group context', async () => {
      // Create private memory
      await memoryRepo.create({
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

    it('should include same_user_any_context memory in both private and group', async () => {
      await memoryRepo.create({
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
      const memId = await memoryRepo.create({
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
            version: 'pi-prompt-participant-context-v2',
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
        .filter((layer) => layer.name === 'identity_fields' || layer.name === 'participant_context')
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
      const memoryId = await memoryRepo.create({
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
        '- display_name="[REDACTED:api_key_assignment] [REDACTED:platform_id]"'
          + ' flags=[admin, trusted]'
          + ' role=admin'
          + ' group_card="[REDACTED:token_assignment] [REDACTED:platform_id]"',
        '',
      ].join('\n');
      const rawParticipantContext = [
        '## Participants',
        `- display_name=${JSON.stringify(sensitiveDisplayName)}`
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
        `- display_name="${participantDisplayName}"`
          + ' flags=[admin, trusted]'
          + ' role=admin'
          + ` group_card="${participantGroupCard}"`,
        '',
      ].join('\n');
      const participantContextWithPlatformAccount = [
        '## Participants',
        `- display_name="${participantDisplayName}"`
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
      const groupSummaryId = await memoryRepo.create({
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
      });

      const conversationSummaryId = await memoryRepo.create({
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
  });
});
