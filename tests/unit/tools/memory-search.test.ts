import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigrations, closeDatabase } from '../../../src/storage/database';
import { MemoryRepository, type MemoryRecordInput } from '../../../src/storage/memory-repository';
import { GroupSummaryPolicyRepository } from '../../../src/storage/group-summary-policy-repository';
import { PrivacyPreferenceRepository } from '../../../src/storage/privacy-preference-repository';
import { createGroupRecentSummaryTool, createMemoryDisableTool, createMemoryProposeTool, createMemorySearchTool, registerBuiltInTools } from '../../../src/tools/builtins/memory-search';
import {
  applyPreparedLocalToolEffect,
  isPreparedLocalToolEffect,
} from '../../../src/tools/prepared-local-effect';
import { ToolRegistry } from '../../../src/tools/registry';
import type { ToolHandlerRequest } from '../../../src/types/tool';

interface MemorySearchOutput {
  results: Array<{
    kind: string;
    scope: string;
    title: string;
    content: string;
    confidence: number;
    importance: number;
    sourceContext: string;
  }>;
  count: number;
}

interface MemoryProposeOutput {
  status: 'proposed' | 'rejected';
  scope?: string;
  visibility?: string;
  kind?: string;
  reason: string;
}

interface MemoryDisableOutput {
  status: 'disabled' | 'rejected';
  reason: string;
}

interface GroupRecentSummaryOutput {
  status: 'ok' | 'rejected';
  reason: string;
  summary: string;
  messageCount: number;
  participantCount: number;
  botMessageCount: number;
  mentionBotCount: number;
  mediaMessageCount: number;
  quoteMessageCount: number;
  windowStart?: string;
  windowEnd?: string;
  excerpts: Array<{
    speaker: string;
    text?: string;
    timestamp: string;
    flags: string[];
  }>;
}

const PROPOSAL_SOURCE_EVENT_ID = 'raw-memory-tool-source';
const PROPOSAL_EVALUATOR_DECISION_ID = 'eval-memory-propose-test';

describe('built-in memory.search tool', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let groupSummaryPolicies: GroupSummaryPolicyRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-memory-search-tool-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigrations(db, join(__dirname, '../../../migrations'));
    memoryRepo = new MemoryRepository(db);
    groupSummaryPolicies = new GroupSummaryPolicyRepository(db);
    const now = Date.now();
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run('user-alice', now, now);
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run('user-bob', now, now);
    const insertPlatformAccount = db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id, account_type,
        verified_level, status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertPlatformAccount.run(
      'qq', 'qq-user-alice', 'user-alice', 'private', 'observed', 'active', now, now,
    );
    insertPlatformAccount.run(
      'qq', 'qq-user-bob', 'user-bob', 'private', 'observed', 'active', now, now,
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-memory-tool-source',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:user-alice',
      '{}',
      now,
    );
    const insertRawSource = db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertChatSource = db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const seedSource = (input: {
      rawEventId: string;
      chatMessageId: string;
      conversationId: string;
      conversationType: 'private' | 'group';
      groupId?: string;
      senderId: string;
    }): void => {
      insertRawSource.run(
        input.rawEventId,
        'chat.message.received',
        now,
        'gateway',
        'qq',
        input.conversationId,
        '{}',
        now,
      );
      insertChatSource.run(
        input.chatMessageId,
        input.rawEventId,
        `platform-${input.chatMessageId}`,
        input.conversationId,
        input.conversationType,
        input.groupId ?? null,
        input.senderId,
        'Synthetic scoped memory source',
        now,
      );
    };
    seedSource({
      rawEventId: 'raw-memory-tool-source-bob',
      chatMessageId: 'msg-memory-tool-source-bob',
      conversationId: 'private:user-bob',
      conversationType: 'private',
      senderId: 'qq-user-bob',
    });
    seedSource({
      rawEventId: 'raw-memory-tool-group-alpha-alice',
      chatMessageId: 'msg-memory-tool-group-alpha-alice',
      conversationId: 'conv-qq-group-tool-alpha',
      conversationType: 'group',
      groupId: 'qq-group-tool-alpha',
      senderId: 'qq-user-alice',
    });
    seedSource({
      rawEventId: 'raw-memory-tool-group-alpha-bob',
      chatMessageId: 'msg-memory-tool-group-alpha-bob',
      conversationId: 'conv-qq-group-tool-alpha',
      conversationType: 'group',
      groupId: 'qq-group-tool-alpha',
      senderId: 'qq-user-bob',
    });
    seedSource({
      rawEventId: 'raw-memory-tool-group-other-alice',
      chatMessageId: 'msg-memory-tool-group-other-alice',
      conversationId: 'conv-qq-group-tool-other',
      conversationType: 'group',
      groupId: 'qq-group-tool-other',
      senderId: 'qq-user-alice',
    });
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-private-source',
      'raw-memory-tool-source',
      'platform-msg-private-source',
      'private:user-alice',
      'private',
      'qq-user-alice',
      'Synthetic private source',
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-memory-propose-test',
      'private:user-alice',
      'raw-memory-tool-source',
      'mock',
      'mock',
      'completed',
      now,
    );
    db.prepare(
      `INSERT INTO evaluator_decisions (
        id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
        evaluator_version, tool_name, actor_user_id, actor_class, invocation_context,
        source_event_ids, request_created_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      PROPOSAL_EVALUATOR_DECISION_ID,
      'req-memory-propose-test',
      'tool',
      'turn-memory-propose-test',
      'approve',
      'Approved direct memory proposal test',
      0.95,
      'medium',
      'test-v1',
      'memory.propose',
      'user-alice',
      'user',
      'private_chat',
      JSON.stringify([PROPOSAL_SOURCE_EVENT_ID]),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, evaluator_decision_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tc-memory-propose-test',
      'turn-memory-propose-test',
      PROPOSAL_EVALUATOR_DECISION_ID,
      'memory.propose',
      '{}',
      '{"approved":true}',
      'system',
      'user-alice',
      'evaluator',
      'private_chat',
      'success',
      0,
      now,
    );
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('registers with safe read-context metadata and ordinary chat permissions', () => {
    const registry = new ToolRegistry();

    registerBuiltInTools(registry, { memoryRepository: memoryRepo, database: db });

    const entry = registry.get('memory.search');
    const proposeEntry = registry.get('memory.propose');
    const disableEntry = registry.get('memory.disable');
    const recentSummaryEntry = registry.get('group.recent_summary');
    expect(entry).toMatchObject({
      name: 'memory.search',
      capabilities: ['read_context'],
      evaluatorPolicy: 'bypass',
      auditLevel: 'redacted_full',
      outputSensitivity: 'secret_possible',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
      },
    });
    expect(proposeEntry).toMatchObject({
      name: 'memory.propose',
      capabilities: ['read_context', 'modifies_memory'],
      evaluatorPolicy: 'required',
      auditLevel: 'redacted_full',
      outputSensitivity: 'sensitive',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
      },
    });
    expect(disableEntry).toMatchObject({
      name: 'memory.disable',
      capabilities: ['read_context', 'modifies_memory'],
      evaluatorPolicy: 'required',
      auditLevel: 'redacted_full',
      outputSensitivity: 'sensitive',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
      },
    });
    expect(recentSummaryEntry).toMatchObject({
      name: 'group.recent_summary',
      capabilities: ['read_context'],
      evaluatorPolicy: 'bypass',
      auditLevel: 'redacted_full',
      outputSensitivity: 'secret_possible',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
      },
    });
    expect(registry.checkPermission(
      'memory.search',
      { actorClass: 'user', canonicalUserId: 'user-alice' },
      'private_chat',
    )).toBe(true);
    expect(registry.checkPermission(
      'memory.search',
      { actorClass: 'user', canonicalUserId: 'user-alice' },
      'admin_cli',
    )).toBe(false);
    expect(registry.checkPermission(
      'memory.propose',
      { actorClass: 'user', canonicalUserId: 'user-alice' },
      'private_chat',
    )).toBe(true);
    expect(registry.requiresEvaluator('memory.propose')).toBe(true);
    expect(registry.checkPermission(
      'memory.disable',
      { actorClass: 'user', canonicalUserId: 'user-alice' },
      'private_chat',
    )).toBe(true);
    expect(registry.requiresEvaluator('memory.disable')).toBe(true);
    expect(registry.checkPermission(
      'group.recent_summary',
      { actorClass: 'user', canonicalUserId: 'user-alice', groupId: 'group-alpha' },
      'group_chat',
    )).toBe(true);
    expect(registry.checkPermission(
      'group.recent_summary',
      { actorClass: 'user', canonicalUserId: 'user-alice' },
      'private_chat',
    )).toBe(false);
  });

  it('returns sanitized current-group recent summary without raw platform ids or secrets', async () => {
    const firstTimestamp = Date.parse('2026-01-01T00:00:00.000Z');
    const secondTimestamp = Date.parse('2026-01-01T00:01:00.000Z');
    const thirdTimestamp = Date.parse('2026-01-01T00:02:00.000Z');
    await seedGroupMessage({
      id: 'msg-group-recent-1',
      groupId: 'group-alpha',
      senderId: 'qq-123456789',
      text: 'Please review api_key=sk-grouprecentsecret1234567890 and qq-987654321',
      mentionsBot: true,
      timestamp: firstTimestamp,
    });
    await seedGroupMessage({
      id: 'msg-group-recent-2',
      groupId: 'group-alpha',
      senderId: 'qq-222222222',
      text: 'I attached the screenshot.',
      hasMedia: true,
      timestamp: secondTimestamp,
    });
    await seedGroupMessage({
      id: 'msg-group-recent-3',
      groupId: 'group-alpha',
      senderId: 'bot-self',
      text: 'I will summarize it.',
      hasQuote: true,
      timestamp: thirdTimestamp,
    });
    await seedGroupMessage({
      id: 'msg-group-recent-other',
      groupId: 'group-other',
      senderId: 'qq-333333333',
      text: 'Other group must not appear.',
      timestamp: thirdTimestamp + 1,
    });

    const output = await executeGroupRecentSummary({ limit: 10 }, 'group-alpha');
    const serialized = JSON.stringify(output);

    expect(output).toMatchObject({
      status: 'ok',
      reason: 'loaded current group recent chat summary',
      messageCount: 3,
      participantCount: 2,
      botMessageCount: 1,
      mentionBotCount: 1,
      mediaMessageCount: 1,
      quoteMessageCount: 1,
      windowStart: new Date(firstTimestamp).toISOString(),
      windowEnd: new Date(thirdTimestamp).toISOString(),
    });
    expect(output.summary).toContain('3 message(s), 2 participant(s), 1 bot message(s), 1 bot mention(s)');
    expect(output.excerpts.map((excerpt) => excerpt.speaker)).toEqual(['participant_1', 'participant_2', 'bot']);
    expect(output.excerpts[0]).toMatchObject({
      text: 'Please review [REDACTED:api_key_assignment] and [REDACTED:platform_id]',
      flags: ['mentions_bot'],
    });
    expect(output.excerpts[1]).toMatchObject({
      text: 'I attached the screenshot.',
      flags: ['has_media'],
    });
    expect(output.excerpts[2]).toMatchObject({
      text: 'I will summarize it.',
      flags: ['bot', 'has_quote'],
    });
    expect(serialized).not.toContain('qq-123456789');
    expect(serialized).not.toContain('qq-222222222');
    expect(serialized).not.toContain('qq-987654321');
    expect(serialized).not.toContain('sk-grouprecentsecret1234567890');
    expect(serialized).not.toContain('Other group must not appear');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects group.recent_summary without group context and does not read other scopes', async () => {
    await seedGroupMessage({
      id: 'msg-group-recent-private-check',
      groupId: 'group-alpha',
      senderId: 'qq-123456789',
      text: 'Should be unavailable without group context.',
      timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    });

    const noGroupOutput = await executeGroupRecentSummary({ limit: 2 }, undefined);
    const privateOutput = await executeGroupRecentSummary({ limit: 2 }, 'group-alpha', 'private_chat');

    expect(noGroupOutput).toEqual({
      status: 'rejected',
      reason: 'group context is required',
      summary: '',
      messageCount: 0,
      participantCount: 0,
      botMessageCount: 0,
      mentionBotCount: 0,
      mediaMessageCount: 0,
      quoteMessageCount: 0,
      excerpts: [],
    });
    expect(privateOutput).toEqual(noGroupOutput);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('disables only allowed active own memory through memory.disable without returning ids', async () => {
    const memoryId = await seedMemory({
      title: 'DisableMe preference',
      content: 'DisableMe should leave ordinary retrieval after disable',
      visibility: 'private_only',
    });
    const output = await executeMemoryDisable({
      memoryId,
      reason: 'user requested disable',
    }, 'private_chat', undefined, 'user-alice', 'tc-memory-disable-test', 'eval-memory-disable-test');
    const serialized = JSON.stringify(output);

    const memory = await memoryRepo.findById(memoryId);
    const retrieved = await memoryRepo.retrieve({ canonicalUserId: 'user-alice', contextType: 'private' });
    const revisions = db.prepare('SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC').all(memoryId) as Array<{
      change_type: string;
      reason: string;
      actor: string;
      evaluator_decision_id: string | null;
    }>;
    const auditRows = db.prepare('SELECT * FROM audit_log WHERE event_id = ? ORDER BY timestamp ASC').all(memoryId) as Array<{
      event_type: string;
      summary: string;
      details: string;
      actor_user_id: string;
      invocation_context: string;
      evaluator_decision_id: string | null;
    }>;

    expect(output).toEqual({
      status: 'disabled',
      reason: 'memory disabled',
    });
    expect(serialized).not.toContain(memoryId);
    expect(memory?.state).toBe('disabled');
    expect(retrieved.map((record) => record.id)).not.toContain(memoryId);
    expect(revisions.map((row) => row.change_type)).toEqual(['create', 'disable']);
    expect(revisions[1]).toMatchObject({
      actor: 'user-alice',
      evaluator_decision_id: 'eval-memory-disable-test',
    });
    expect(revisions[1]?.reason).toContain('memory.disable tool request');
    expect(auditRows.map((row) => row.event_type)).toEqual(['memory.create', 'memory.disable']);
    expect(auditRows[1]).toMatchObject({
      summary: 'memory.disable disabled memory through tool request',
      actor_user_id: 'user-alice',
      invocation_context: 'private_chat',
      evaluator_decision_id: 'eval-memory-disable-test',
    });
    expect(auditRows[1]?.details).toContain('tc-memory-disable-test');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects disallowed memory.disable requests without mutating memory', async () => {
    const otherMemoryId = await seedMemory({
      title: 'Other user memory',
      content: 'Other user memory should not be disabled by Alice',
      canonicalUserId: 'user-bob',
      visibility: 'private_only',
    });
    const proposedMemoryId = await seedMemory({
      title: 'Proposed memory',
      content: 'Proposed memory should not be disabled directly',
      state: 'proposed',
    });

    const otherOutput = await executeMemoryDisable({ memoryId: otherMemoryId }, 'private_chat');
    const proposedOutput = await executeMemoryDisable({ memoryId: proposedMemoryId }, 'private_chat');
    const missingOutput = await executeMemoryDisable({}, 'private_chat');

    expect(otherOutput).toEqual({
      status: 'rejected',
      reason: 'memory not found or not allowed for this actor',
    });
    expect(proposedOutput).toEqual({
      status: 'rejected',
      reason: 'only active memory can be disabled',
    });
    expect(missingOutput).toEqual({
      status: 'rejected',
      reason: 'memoryId is required',
    });
    expect((await memoryRepo.findById(otherMemoryId))?.state).toBe('active');
    expect((await memoryRepo.findById(proposedMemoryId))?.state).toBe('proposed');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('creates only proposed source-linked memory through memory.propose without returning ids', async () => {
    const output = await executeMemoryPropose({
      title: 'Tool proposed preference',
      content: 'User may prefer release notes with concise bullets',
      kind: 'preference',
      confidence: 0.93,
      importance: 0.82,
    }, 'private_chat', undefined, 'user-alice', 'tc-memory-propose-test',
    [PROPOSAL_SOURCE_EVENT_ID], PROPOSAL_EVALUATOR_DECISION_ID);
    const serialized = JSON.stringify(output);

    const memoryRows = db.prepare('SELECT * FROM memory_records').all() as Array<{
      id: string;
      scope: string;
      canonical_user_id: string | null;
      visibility: string;
      kind: string;
      title: string;
      content: string;
      state: string;
      confidence: number;
      importance: number;
      source_context: string;
      evaluator_decision_id: string | null;
    }>;
    const memoryId = memoryRows[0]?.id ?? '';
    const sourceRows = db.prepare('SELECT * FROM memory_sources WHERE memory_id = ?').all(memoryId) as Array<{
      source_type: string;
      source_id: string;
      source_timestamp: number;
      extracted_by: string;
      resolution_state: string;
      raw_event_id: string | null;
      tool_call_id: string | null;
    }>;
    const revisionRows = db.prepare('SELECT * FROM memory_revisions WHERE memory_id = ?').all(memoryId) as Array<{
      change_type: string;
      reason: string;
      actor: string;
      evaluator_decision_id: string | null;
    }>;
    const auditRows = db.prepare('SELECT * FROM audit_log WHERE event_id = ?').all(memoryId) as Array<{
      event_type: string;
      summary: string;
      actor_user_id: string;
      invocation_context: string;
      evaluator_decision_id: string | null;
    }>;

    expect(output).toEqual({
      status: 'proposed',
      scope: 'user',
      visibility: 'private_only',
      kind: 'preference',
      reason: 'created proposed memory for review',
    });
    expect(serialized).not.toContain(memoryId);
    expect(serialized).not.toContain('tc-memory-propose-test');
    expect(serialized).not.toContain(PROPOSAL_SOURCE_EVENT_ID);
    expect(serialized).not.toContain(PROPOSAL_EVALUATOR_DECISION_ID);
    expect(memoryRows).toHaveLength(1);
    expect(memoryRows[0]).toMatchObject({
      scope: 'user',
      canonical_user_id: 'user-alice',
      visibility: 'private_only',
      kind: 'preference',
      title: 'Tool proposed preference',
      content: 'User may prefer release notes with concise bullets',
      state: 'proposed',
      source_context: 'private_chat',
      evaluator_decision_id: PROPOSAL_EVALUATOR_DECISION_ID,
    });
    expect(memoryRows[0]?.confidence).toBe(0.93);
    expect(memoryRows[0]?.importance).toBe(0.82);
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0]).toMatchObject({
      source_type: 'raw_event',
      source_id: PROPOSAL_SOURCE_EVENT_ID,
      source_timestamp: db.prepare('SELECT timestamp FROM raw_events WHERE id = ?')
        .pluck()
        .get(PROPOSAL_SOURCE_EVENT_ID),
      extracted_by: 'tool',
      resolution_state: 'internal',
      raw_event_id: PROPOSAL_SOURCE_EVENT_ID,
      tool_call_id: null,
    });
    expect(revisionRows).toHaveLength(1);
    expect(revisionRows[0]).toMatchObject({
      change_type: 'create',
      actor: 'user-alice',
      evaluator_decision_id: PROPOSAL_EVALUATOR_DECISION_ID,
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      event_type: 'memory.create',
      actor_user_id: 'user-alice',
      invocation_context: 'private_chat',
      evaluator_decision_id: PROPOSAL_EVALUATOR_DECISION_ID,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('honors memory-association opt-out for user proposals without blocking group scope', async () => {
    const privacyRepo = new PrivacyPreferenceRepository(db);
    privacyRepo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'memory_association',
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });

    const userOutput = await executeMemoryPropose({
      title: 'Opted-out user proposal',
      content: 'This user-scoped candidate must not become durable memory',
    }, 'private_chat', undefined, 'user-alice', 'tc-memory-propose-opted-out',
    [PROPOSAL_SOURCE_EVENT_ID], PROPOSAL_EVALUATOR_DECISION_ID);

    expect(userOutput).toEqual({
      status: 'rejected',
      reason: 'User has opted out of memory association',
    });
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM memory_sources').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM memory_revisions').all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM audit_log WHERE category = 'memory'").all()).toHaveLength(0);

    db.prepare('UPDATE evaluator_decisions SET invocation_context = ? WHERE id = ?')
      .run('group_chat', PROPOSAL_EVALUATOR_DECISION_ID);
    moveProposalSourceToGroup('qq-group-tool-alpha');
    const groupUserOutput = await executeMemoryPropose({
      title: 'Group-chat user proposal',
      content: 'Same-group visibility must not bypass a user association opt-out',
      scope: 'user',
    }, 'group_chat', 'qq-group-tool-alpha', 'user-alice', 'tc-memory-propose-group-user-optout',
    [PROPOSAL_SOURCE_EVENT_ID], PROPOSAL_EVALUATOR_DECISION_ID);

    expect(groupUserOutput).toEqual({
      status: 'rejected',
      reason: 'User has opted out of memory association',
    });
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);

    const groupOutput = await executeMemoryPropose({
      title: 'Group-scoped proposal',
      content: 'A personal opt-out must not disable group-owned memory',
      scope: 'group',
    }, 'group_chat', 'qq-group-tool-alpha', 'user-alice', 'tc-memory-propose-group-optout',
    [PROPOSAL_SOURCE_EVENT_ID], PROPOSAL_EVALUATOR_DECISION_ID);

    expect(groupOutput).toMatchObject({
      status: 'proposed',
      scope: 'group',
      visibility: 'same_group_only',
    });
    expect(db.prepare('SELECT scope, group_id FROM memory_records').all()).toEqual([
      { scope: 'group', group_id: 'qq-group-tool-alpha' },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('revalidates memory-association opt-out when applying a prepared user proposal', async () => {
    const tool = createMemoryProposeTool(memoryRepo, db);
    const output = await tool.handler({
      toolCallId: 'tc-memory-propose-late-optout',
      turnId: 'turn-memory-propose-test',
      toolName: 'memory.propose',
      signal: new AbortController().signal,
      sourceEventIds: [PROPOSAL_SOURCE_EVENT_ID],
      evaluatorDecisionId: PROPOSAL_EVALUATOR_DECISION_ID,
      input: {
        title: 'Late opt-out proposal',
        content: 'This prepared effect must fail if the user opts out before commit',
      },
      actor: {
        actorClass: 'user',
        canonicalUserId: 'user-alice',
      },
      context: 'private_chat',
    });

    if (!isPreparedLocalToolEffect(output)) {
      throw new Error('Expected a prepared memory proposal effect');
    }

    new PrivacyPreferenceRepository(db).setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'memory_association',
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });

    expect(() => db.transaction(() => applyPreparedLocalToolEffect(output))())
      .toThrow('User has opted out of memory association');
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM memory_sources').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM memory_revisions').all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM audit_log WHERE category = 'memory'").all()).toHaveLength(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('revalidates evaluator approval when applying a prepared memory proposal', async () => {
    const tool = createMemoryProposeTool(memoryRepo, db);
    const output = await tool.handler({
      toolCallId: 'tc-memory-propose-test',
      turnId: 'turn-memory-propose-test',
      toolName: 'memory.propose',
      signal: new AbortController().signal,
      sourceEventIds: [PROPOSAL_SOURCE_EVENT_ID],
      evaluatorDecisionId: PROPOSAL_EVALUATOR_DECISION_ID,
      input: {
        title: 'Approval must remain valid',
        content: 'The prepared effect must fail closed if approval changes',
      },
      actor: {
        actorClass: 'user',
        canonicalUserId: 'user-alice',
      },
      context: 'private_chat',
    });

    if (!isPreparedLocalToolEffect(output)) {
      throw new Error('Expected a prepared memory proposal effect');
    }
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);

    db.prepare("UPDATE evaluator_decisions SET decision = 'reject' WHERE id = ?")
      .run(PROPOSAL_EVALUATOR_DECISION_ID);

    expect(() => db.transaction(() => applyPreparedLocalToolEffect(output))())
      .toThrow('matching evaluator approval evidence is required to propose memory');
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM memory_sources').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM memory_revisions').all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM audit_log WHERE category = 'memory'").all()).toHaveLength(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it.each([
    {
      label: 'trusted source event evidence',
      sourceEventIds: undefined,
      evaluatorDecisionId: PROPOSAL_EVALUATOR_DECISION_ID,
    },
    {
      label: 'evaluator approval evidence',
      sourceEventIds: [PROPOSAL_SOURCE_EVENT_ID],
      evaluatorDecisionId: undefined,
    },
  ])('rejects memory.propose without $label and creates no memory', async ({
    sourceEventIds,
    evaluatorDecisionId,
  }) => {
    const output = await executeMemoryPropose({
      title: 'Unbound proposal',
      content: 'This proposal must not outlive missing trusted evidence',
    }, 'private_chat', undefined, 'user-alice', 'tc-memory-propose-missing-context',
    sourceEventIds, evaluatorDecisionId);
    const serialized = JSON.stringify(output);

    expect(output).toMatchObject({
      status: 'rejected',
      reason: expect.any(String),
    });
    expect(Object.keys(output).sort()).toEqual(['reason', 'status']);
    expect(serialized).not.toContain(PROPOSAL_SOURCE_EVENT_ID);
    expect(serialized).not.toContain(PROPOSAL_EVALUATOR_DECISION_ID);
    expect(serialized).not.toContain('tc-memory-propose-missing-context');
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it.each([
    {
      label: 'an unknown evaluator decision',
      evaluatorDecisionId: 'eval-memory-propose-unknown',
    },
    {
      label: 'a non-approve evaluator decision',
      evaluatorDecisionId: PROPOSAL_EVALUATOR_DECISION_ID,
      update: "UPDATE evaluator_decisions SET decision = 'reject' WHERE id = ?",
    },
    {
      label: 'a mismatched evaluator actor',
      evaluatorDecisionId: PROPOSAL_EVALUATOR_DECISION_ID,
      update: "UPDATE evaluator_decisions SET actor_user_id = 'user-bob' WHERE id = ?",
    },
    {
      label: 'a different approved tool',
      evaluatorDecisionId: PROPOSAL_EVALUATOR_DECISION_ID,
      update: "UPDATE evaluator_decisions SET tool_name = 'memory.disable' WHERE id = ?",
    },
    {
      label: 'mismatched evaluator source evidence',
      evaluatorDecisionId: PROPOSAL_EVALUATOR_DECISION_ID,
      update: "UPDATE evaluator_decisions SET source_event_ids = '[]' WHERE id = ?",
    },
  ])('rejects memory.propose with $label and creates no memory', async ({
    evaluatorDecisionId,
    update,
  }) => {
    if (update) {
      db.prepare(update).run(PROPOSAL_EVALUATOR_DECISION_ID);
    }

    const output = await executeMemoryPropose({
      title: 'Unapproved proposal',
      content: 'This proposal must remain non-durable without matching approval evidence',
    }, 'private_chat', undefined, 'user-alice', 'tc-memory-propose-invalid-approval',
    [PROPOSAL_SOURCE_EVENT_ID], evaluatorDecisionId);

    expect(output).toMatchObject({
      status: 'rejected',
      reason: expect.any(String),
    });
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects unsafe memory.propose inputs without durable memory rows', async () => {
    const globalOutput = await executeMemoryPropose({
      title: 'Global proposal',
      content: 'Ordinary users should not propose global memory',
      scope: 'global',
    }, 'private_chat', undefined, 'user-alice', 'tc-memory-propose-test',
    [PROPOSAL_SOURCE_EVENT_ID], PROPOSAL_EVALUATOR_DECISION_ID);
    const secretOutput = await executeMemoryPropose({
      title: 'Secret proposal',
      content: 'api_key=sk-memoryproposesecret1234567890abcdef',
    }, 'private_chat', undefined, 'user-alice', 'tc-memory-propose-test',
    [PROPOSAL_SOURCE_EVENT_ID], PROPOSAL_EVALUATOR_DECISION_ID);

    expect(globalOutput).toEqual({
      status: 'rejected',
      reason: 'owner or admin actor is required to propose global memory',
    });
    expect(secretOutput).toEqual({
      status: 'rejected',
      reason: 'memory proposal rejected by deterministic memory policy',
    });
    expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('keeps group-chat memory proposals same-group scoped and rejects missing actor identity', async () => {
    db.prepare('UPDATE evaluator_decisions SET invocation_context = ? WHERE id = ?')
      .run('group_chat', PROPOSAL_EVALUATOR_DECISION_ID);
    moveProposalSourceToGroup('qq-group-tool-alpha');

    const groupOutput = await executeMemoryPropose(
      {
        title: 'Group proposed summary',
        content: 'The group may prefer short deployment reminders',
        scope: 'user',
        visibility: 'same_user_any_context',
      },
      'group_chat',
      'qq-group-tool-alpha',
      'user-alice',
      'tc-memory-propose-test',
      [PROPOSAL_SOURCE_EVENT_ID],
      PROPOSAL_EVALUATOR_DECISION_ID,
    );
    const missingActorOutput = await executeMemoryPropose(
      { title: 'Missing actor', content: 'Should not be written without actor identity' },
      'private_chat',
      undefined,
      null,
      'tc-memory-propose-missing-actor',
      [PROPOSAL_SOURCE_EVENT_ID],
      PROPOSAL_EVALUATOR_DECISION_ID,
    );

    const rows = db.prepare('SELECT * FROM memory_records ORDER BY created_at ASC').all() as Array<{
      scope: string;
      canonical_user_id: string | null;
      group_id: string | null;
      visibility: string;
      state: string;
      title: string;
    }>;

    expect(groupOutput).toMatchObject({
      status: 'proposed',
      scope: 'user',
      visibility: 'same_group_only',
    });
    expect(missingActorOutput).toEqual({
      status: 'rejected',
      reason: 'canonical actor identity is required to propose memory',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: 'user',
      canonical_user_id: 'user-alice',
      group_id: 'qq-group-tool-alpha',
      visibility: 'same_group_only',
      state: 'proposed',
      title: 'Group proposed summary',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('returns only current user visible private-context memories without source ids', async () => {
    const privateId = await seedMemory({
      title: 'ProjectAlpha private preference',
      content: 'ProjectAlpha user prefers concise answers',
      visibility: 'private_only',
      importance: 0.9,
      sourceContext: 'private_chat:source-private',
      sources: [{ sourceType: 'chat_message', sourceId: 'msg-private-source' }],
    });
    await seedMemory({
      title: 'ProjectAlpha other user preference',
      content: 'ProjectAlpha other user likes verbose answers',
      canonicalUserId: 'user-bob',
      visibility: 'private_only',
      importance: 1,
    });
    await seedMemory({
      title: 'ProjectAlpha group-only user memory',
      content: 'ProjectAlpha visible only in the current group',
      visibility: 'same_group_only',
      groupId: 'qq-group-tool-alpha',
      importance: 0.8,
    });
    await seedMemory({
      title: 'ProjectAlpha owner-admin memory',
      content: 'ProjectAlpha owner admin only note',
      visibility: 'owner_admin_only',
      importance: 0.7,
    });
    await seedMemory({
      title: 'ProjectAlpha global public procedure',
      content: 'ProjectAlpha public troubleshooting procedure',
      scope: 'global',
      canonicalUserId: undefined,
      visibility: 'public',
      importance: 0.6,
    });

    const output = await executeMemorySearch({ query: 'ProjectAlpha', limit: 10 }, 'private_chat');
    const serialized = JSON.stringify(output);

    expect(output.count).toBe(2);
    expect(output.results.map((memory) => memory.title)).toEqual([
      'ProjectAlpha private preference',
      'ProjectAlpha global public procedure',
    ]);
    expect(serialized).toContain('ProjectAlpha user prefers concise answers');
    expect(serialized).not.toContain('other user likes verbose answers');
    expect(serialized).not.toContain('visible only in the current group');
    expect(serialized).not.toContain('owner admin only note');
    expect(output.results[0]?.sourceContext).toBe('private_chat');
    expect(serialized).not.toContain(privateId);
    expect(serialized).not.toContain('msg-private-source');
    expect(serialized).not.toContain('source-private');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('returns current user, current group scoped, and global memories in group context without leaking other user group-derived memory', async () => {
    groupSummaryPolicies.setEnabled({
      groupId: 'qq-group-tool-alpha',
      enabled: true,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-alice',
        invocationContext: 'admin_cli',
      },
    });
    await seedMemory({
      title: 'ProjectBeta private preference',
      content: 'ProjectBeta private-only memory should not appear in group',
      visibility: 'private_only',
      importance: 1,
    });
    await seedMemory({
      title: 'ProjectBeta same-user preference',
      content: 'ProjectBeta same user memory can appear in group',
      visibility: 'same_user_any_context',
      importance: 0.95,
    });
    await seedMemory({
      title: 'ProjectBeta current group user memory',
      content: 'ProjectBeta current group user memory can appear',
      visibility: 'same_group_only',
      groupId: 'qq-group-tool-alpha',
      importance: 0.9,
    });
    await seedMemory({
      title: 'ProjectBeta other user group memory',
      content: 'ProjectBeta other user group-derived memory must not appear',
      canonicalUserId: 'user-bob',
      visibility: 'same_group_only',
      groupId: 'qq-group-tool-alpha',
      importance: 0.99,
    });
    await seedMemory({
      title: 'ProjectBeta current group summary',
      content: 'ProjectBeta current group summary can appear',
      scope: 'group',
      canonicalUserId: undefined,
      visibility: 'same_group_only',
      groupId: 'qq-group-tool-alpha',
      kind: 'summary',
      importance: 0.85,
    });
    await seedMemory({
      title: 'ProjectBeta other group summary',
      content: 'ProjectBeta other group summary must not appear',
      scope: 'group',
      canonicalUserId: undefined,
      visibility: 'same_group_only',
      groupId: 'qq-group-tool-other',
      kind: 'summary',
      importance: 0.8,
    });
    await seedMemory({
      title: 'ProjectBeta global fact',
      content: 'ProjectBeta global public fact can appear',
      scope: 'global',
      canonicalUserId: undefined,
      visibility: 'public',
      importance: 0.7,
    });

    const output = await executeMemorySearch(
      { query: 'ProjectBeta', limit: 10 },
      'group_chat',
      'qq-group-tool-alpha',
    );
    const serialized = JSON.stringify(output);

    expect(output.results.map((memory) => memory.title)).toEqual([
      'ProjectBeta same-user preference',
      'ProjectBeta current group user memory',
      'ProjectBeta current group summary',
      'ProjectBeta global fact',
    ]);
    expect(serialized).not.toContain('private-only memory should not appear in group');
    expect(serialized).not.toContain('other user group-derived memory must not appear');
    expect(serialized).not.toContain('other group summary must not appear');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('inherits exact-group summary policy while preserving allowed memory classes', async () => {
    await seedMemory({
      title: 'ProjectPolicy same-user fact',
      content: 'ProjectPolicy same-user fact remains visible',
      visibility: 'same_user_any_context',
      importance: 0.95,
    });
    await seedMemory({
      title: 'ProjectPolicy group fact',
      content: 'ProjectPolicy group fact remains visible',
      scope: 'group',
      canonicalUserId: undefined,
      visibility: 'same_group_only',
      groupId: 'qq-group-tool-alpha',
      importance: 0.9,
    });
    await seedMemory({
      title: 'ProjectPolicy group summary',
      content: 'ProjectPolicy group summary follows policy',
      scope: 'group',
      canonicalUserId: undefined,
      visibility: 'same_group_only',
      groupId: 'qq-group-tool-alpha',
      kind: 'summary',
      importance: 1,
    });
    await seedMemory({
      title: 'ProjectPolicy global fact',
      content: 'ProjectPolicy global fact remains visible',
      scope: 'global',
      canonicalUserId: undefined,
      visibility: 'public',
      importance: 0.8,
    });

    const whileAbsent = await executeMemorySearch(
      { query: 'ProjectPolicy', limit: 10 },
      'group_chat',
      'qq-group-tool-alpha',
    );
    expect(whileAbsent.results.map((memory) => memory.title)).toEqual([
      'ProjectPolicy same-user fact',
      'ProjectPolicy group fact',
      'ProjectPolicy global fact',
    ]);

    groupSummaryPolicies.setEnabled({
      groupId: 'qq-group-tool-alpha',
      enabled: true,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-alice',
        invocationContext: 'admin_cli',
      },
    });
    const whileEnabled = await executeMemorySearch(
      { query: 'ProjectPolicy', limit: 10 },
      'group_chat',
      'qq-group-tool-alpha',
    );
    expect(whileEnabled.results.map((memory) => memory.title))
      .toContain('ProjectPolicy group summary');

    groupSummaryPolicies.setEnabled({
      groupId: 'qq-group-tool-alpha',
      enabled: false,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-alice',
        invocationContext: 'admin_cli',
      },
    });
    const whileDisabled = await executeMemorySearch(
      { query: 'ProjectPolicy', limit: 10 },
      'group_chat',
      'qq-group-tool-alpha',
    );
    expect(whileDisabled.results.map((memory) => memory.title))
      .not.toContain('ProjectPolicy group summary');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('returns an empty result when canonical user context is missing', async () => {
    await seedMemory({
      title: 'ProjectGamma preference',
      content: 'ProjectGamma should not appear without actor identity',
      visibility: 'same_user_any_context',
    });

    const output = await executeMemorySearch(
      { query: 'ProjectGamma' },
      'private_chat',
      undefined,
      null,
    );

    expect(output).toEqual({ results: [], count: 0 });
  });

  async function seedMemory(overrides: Partial<MemoryRecordInput>): Promise<string> {
    const scope = overrides.scope ?? 'user';
    const canonicalUserId = scope === 'user'
      ? overrides.canonicalUserId ?? 'user-alice'
      : undefined;
    const sourceId = overrides.groupId === 'qq-group-tool-alpha'
      ? canonicalUserId === 'user-bob'
        ? 'raw-memory-tool-group-alpha-bob'
        : 'raw-memory-tool-group-alpha-alice'
      : overrides.groupId === 'qq-group-tool-other'
        ? 'raw-memory-tool-group-other-alice'
        : canonicalUserId === 'user-bob'
          ? 'raw-memory-tool-source-bob'
          : 'raw-memory-tool-source';

    return memoryRepo.create({
      scope: 'user',
      canonicalUserId: 'user-alice',
      visibility: 'same_user_any_context',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'Default memory',
      content: 'Default memory content',
      state: 'active',
      confidence: 0.9,
      importance: 0.5,
      sourceContext: 'private_chat',
      sources: [
        {
          sourceType: 'raw_event',
          sourceId,
          extractedBy: 'user',
        },
      ],
      ...overrides,
    });
  }

  function moveProposalSourceToGroup(groupId: string): void {
    const conversationId = `conv-${groupId}`;
    db.prepare('UPDATE raw_events SET conversation_id = ? WHERE id = ?')
      .run(conversationId, PROPOSAL_SOURCE_EVENT_ID);
    db.prepare(
      `UPDATE chat_messages
          SET conversation_id = ?, conversation_type = 'group', group_id = ?
        WHERE raw_event_id = ?`,
    ).run(conversationId, groupId, PROPOSAL_SOURCE_EVENT_ID);
    db.prepare('UPDATE agent_turns SET conversation_id = ? WHERE id = ?')
      .run(conversationId, 'turn-memory-propose-test');
  }

  async function seedGroupMessage(input: {
    id: string;
    groupId: string;
    senderId: string;
    text: string;
    timestamp: number;
    mentionsBot?: boolean;
    hasMedia?: boolean;
    hasQuote?: boolean;
  }): Promise<void> {
    const rawEventId = `raw-${input.id}`;
    const conversationId = `conv-${input.groupId}`;
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rawEventId,
      'chat.message.received',
      input.timestamp,
      'gateway',
      'qq',
      conversationId,
      '{}',
      input.timestamp,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      rawEventId,
      `platform-${input.id}`,
      conversationId,
      'group',
      input.groupId,
      input.senderId,
      input.text,
      input.hasMedia ? 1 : 0,
      input.hasQuote ? 1 : 0,
      input.mentionsBot ? 1 : 0,
      input.timestamp,
    );
  }

  async function executeMemorySearch(
    input: unknown,
    context: ToolHandlerRequest['context'],
    groupId?: string,
    canonicalUserId: string | null = 'user-alice',
  ): Promise<MemorySearchOutput> {
    const tool = createMemorySearchTool(memoryRepo);
    const output = await tool.handler({
      toolCallId: 'tc-memory-search-test',
      turnId: 'turn-memory-search-test',
      toolName: 'memory.search',
      signal: new AbortController().signal,
      input,
      actor: {
        actorClass: 'user',
        ...(canonicalUserId ? { canonicalUserId } : {}),
        ...(groupId ? { groupId } : {}),
      },
      context,
    });

    return output as MemorySearchOutput;
  }

  async function executeMemoryPropose(
    input: unknown,
    context: ToolHandlerRequest['context'],
    groupId?: string,
    canonicalUserId: string | null = 'user-alice',
    toolCallId = 'tc-memory-propose-test',
    sourceEventIds?: string[],
    evaluatorDecisionId?: string,
  ): Promise<MemoryProposeOutput> {
    const tool = createMemoryProposeTool(memoryRepo, db);
    const changesBefore = db.prepare('SELECT total_changes() AS count').get() as { count: number };
    const output = await tool.handler({
      toolCallId,
      turnId: 'turn-memory-propose-test',
      toolName: 'memory.propose',
      signal: new AbortController().signal,
      sourceEventIds,
      evaluatorDecisionId,
      input,
      actor: {
        actorClass: 'user',
        ...(canonicalUserId ? { canonicalUserId } : {}),
        ...(groupId ? { groupId } : {}),
      },
      context,
    });

    if (isPreparedLocalToolEffect(output)) {
      expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changesBefore);
      db.transaction(() => applyPreparedLocalToolEffect(output))();
      return output.publicResult as MemoryProposeOutput;
    }

    return output as MemoryProposeOutput;
  }

  async function executeMemoryDisable(
    input: unknown,
    context: ToolHandlerRequest['context'],
    groupId?: string,
    canonicalUserId: string | null = 'user-alice',
    toolCallId = 'tc-memory-disable-test',
    evaluatorDecisionId?: string,
  ): Promise<MemoryDisableOutput> {
    const tool = createMemoryDisableTool(memoryRepo);
    const changesBefore = db.prepare('SELECT total_changes() AS count').get() as { count: number };
    const output = await tool.handler({
      toolCallId,
      turnId: 'turn-memory-disable-test',
      toolName: 'memory.disable',
      signal: new AbortController().signal,
      evaluatorDecisionId,
      input,
      actor: {
        actorClass: 'user',
        ...(canonicalUserId ? { canonicalUserId } : {}),
        ...(groupId ? { groupId } : {}),
      },
      context,
    });

    if (isPreparedLocalToolEffect(output)) {
      expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changesBefore);
      db.transaction(() => applyPreparedLocalToolEffect(output))();
      return output.publicResult as MemoryDisableOutput;
    }

    return output as MemoryDisableOutput;
  }

  async function executeGroupRecentSummary(
    input: unknown,
    groupId?: string,
    context: ToolHandlerRequest['context'] = 'group_chat',
  ): Promise<GroupRecentSummaryOutput> {
    const tool = createGroupRecentSummaryTool(db);
    const output = await tool.handler({
      toolCallId: 'tc-group-recent-summary-test',
      turnId: 'turn-group-recent-summary-test',
      toolName: 'group.recent_summary',
      signal: new AbortController().signal,
      input,
      actor: {
        actorClass: 'user',
        canonicalUserId: 'user-alice',
        ...(groupId ? { groupId } : {}),
      },
      context,
    });

    return output as GroupRecentSummaryOutput;
  }
});
