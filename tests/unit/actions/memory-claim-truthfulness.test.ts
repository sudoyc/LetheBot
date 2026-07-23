import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ActionCooldownManager } from '../../../src/actions/cooldown';
import { ActionRepository } from '../../../src/actions/action-repository';
import { SocialDecisionService } from '../../../src/actions/social-decision-service';
import { EvaluatorStub } from '../../../src/evaluator/evaluator-stub';
import { AuditRepository } from '../../../src/storage/audit-repository';
import { redactContextTraceText } from '../../../src/storage/context-trace-repository';
import { closeDatabase, initDatabase, runMigrations } from '../../../src/storage/database';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { ToolCallRepository } from '../../../src/storage/tool-call-repository';
import type { ActionDecision, ActionPlan } from '../../../src/types/action';
import type { ChatMessageReceived } from '../../../src/types/events';
import type { ActorClass } from '../../../src/types/tool';

const RAW_EVENT_ID = 'raw-rel-mem-01';
const TURN_ID = 'turn-rel-mem-01';
const CONTEXT_ID = 'context-rel-mem-01';
const CONVERSATION_ID = 'private:synthetic-memory-claim';
const GROUP_ID = 'qq-group-synthetic-memory-claim';
const CANONICAL_USER_ID = 'user-rel-mem-01-synthetic';
const PLATFORM_USER_ID = 'synthetic-memory-claim';
const PROPOSITION = 'response_style=compact';
const CHINESE_DURABLE_CLAIM = `已记住：${PROPOSITION}`;
const CHINESE_NEUTRAL = `收到：${PROPOSITION}`;
const CHINESE_PENDING = `已创建待审核记忆提议：${PROPOSITION}`;
const ENGLISH_NEUTRAL = `Acknowledged: ${PROPOSITION}`;
const CLAIM_GUARD_SUPPRESSOR = 'memory_claim_truthfulness_guard';

describe('Memory claim truthfulness', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepository: MemoryRepository;
  let evidenceCounter: number;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-memory-claim-truthfulness-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigrations(db, join(__dirname, '../../../migrations'));
    memoryRepository = new MemoryRepository(db);
    evidenceCounter = 0;

    const now = Date.now() - 1_000;
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run(CANONICAL_USER_ID, now, now);
    db.prepare(
      `INSERT INTO platform_accounts (
         platform, platform_account_id, canonical_user_id, account_type,
         verified_level, status, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'qq',
      PLATFORM_USER_ID,
      CANONICAL_USER_ID,
      'private',
      'observed',
      'active',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      RAW_EVENT_ID,
      'chat.message.received',
      now,
      'gateway',
      'qq',
      CONVERSATION_ID,
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'chat-rel-mem-01',
      RAW_EVENT_ID,
      'message-rel-mem-01',
      CONVERSATION_ID,
      'private',
      `qq-${PLATFORM_USER_ID}`,
      `Please retain ${PROPOSITION}.`,
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, context_pack_id,
         pi_model, pi_provider, status, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      TURN_ID,
      CONVERSATION_ID,
      RAW_EVENT_ID,
      CONTEXT_ID,
      'mock',
      'mock',
      'running',
      now,
    );
    db.prepare(
      `INSERT INTO context_traces (
         id, turn_id, conversation_id, conversation_type, group_id,
         candidate_memory_ids, selected_memory_ids, rejected_memories,
         filters_applied, injected_identity_fields, recent_message_ids,
         token_budget, memories, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      CONTEXT_ID,
      TURN_ID,
      CONVERSATION_ID,
      'private',
      null,
      '[]',
      '[]',
      '[]',
      '[]',
      '[]',
      JSON.stringify(['chat-rel-mem-01']),
      '{}',
      '[]',
      now,
    );
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('REL-MEM-01 replaces an affirmative durable-memory claim when no memory effect exists', async () => {
    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get(),
    ).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('recognizes a high-confidence English durable-memory claim', async () => {
    const decision = await createDecision(`I've saved to memory: ${PROPOSITION}`);

    expectDecisionText(decision, ENGLISH_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    [`我会记住：${PROPOSITION}`, CHINESE_NEUTRAL],
    [`Remembered: ${PROPOSITION}`, ENGLISH_NEUTRAL],
    [`It's been remembered: ${PROPOSITION}`, ENGLISH_NEUTRAL],
    [`I’ve remembered: ${PROPOSITION}`, ENGLISH_NEUTRAL],
    [`已创建记忆提议：${PROPOSITION}`, CHINESE_NEUTRAL],
    [`Created a memory proposal: ${PROPOSITION}`, ENGLISH_NEUTRAL],
    [`Submitted for memory review: ${PROPOSITION}`, ENGLISH_NEUTRAL],
  ])('neutralizes unsupported durable or pending form %s', async (claim, expected) => {
    const decision = await createDecision(claim);

    expectDecisionText(decision, expected, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('guards a later-line claim and does not echo its unsafe platform identifier', async () => {
    const syntheticPlatformId = '13579';
    const text = `Thanks.\nRemembered: contact account ${syntheticPlatformId}`;
    const decision = await createDecision(text);

    expectDecisionText(decision, 'Thanks.\nAcknowledged.', true);
    expect(JSON.stringify(decision.actions)).not.toContain(syntheticPlatformId);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    ['**Remembered:** contact account 13579', 'Acknowledged.'],
    ['- **已记住：**联系账号 13579', '- 收到。'],
    ['- [x] **Remembered:** contact account 13579', '- [x] Acknowledged.'],
    ['### __Remembered:__ contact account 13579', '### Acknowledged.'],
    ['Update: Remembered: contact account 13579', 'Update: Acknowledged.'],
  ])('does not echo an unsafe proposition through bounded presentation form %s', async (
    text,
    expected,
  ) => {
    const decision = await createDecision(text);

    expectDecisionText(decision, expected, true);
    expect(JSON.stringify(decision.actions)).not.toContain('13579');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    [`Thanks. I have remembered that ${PROPOSITION}`, `Thanks. ${ENGLISH_NEUTRAL}`],
    [`- Remembered: ${PROPOSITION}`, `- ${ENGLISH_NEUTRAL}`],
    [`好的，已创建记忆提议：${PROPOSITION}`, `好的，${CHINESE_NEUTRAL}`],
    [
      `Sure, I have created a memory proposal: ${PROPOSITION}`,
      `Sure, ${ENGLISH_NEUTRAL}`,
    ],
  ])('neutralizes a presented unsupported claim without dropping its prefix: %s', async (
    text,
    expected,
  ) => {
    const decision = await createDecision(text);

    expectDecisionText(decision, expected, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not rewrite ordinary recollection wording that makes no durable-store claim', async () => {
    const text = `I remember ${PROPOSITION} from this conversation.`;
    const decision = await createDecision(text);

    expectDecisionText(decision, text, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not rewrite generic review wording without an explicit memory claim', async () => {
    const text = `Submitted for review: ${PROPOSITION}`;
    const decision = await createDecision(text);

    expectDecisionText(decision, text, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    `I've saved the report to /tmp/report.md.`,
    'I remembered to send the email.',
    `I'll remember to restart the worker.`,
    '已保存到记忆卡：photo.jpg',
    '已保存《记忆》这篇文章。',
    '已创建有关记忆提议的文档。',
    '已提交关于记忆审核的报告。',
    'I have created a memory proposal document: draft.md',
  ])('does not rewrite ordinary file or task wording: %s', async (text) => {
    const decision = await createDecision(text);

    expectDecisionText(decision, text, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    `The docs say I've saved to memory: ${PROPOSITION}`,
    `用户说“我会记住：${PROPOSITION}”`,
    `Update: The docs say Remembered: ${PROPOSITION}`,
  ])('does not rewrite reported speech: %s', async (text) => {
    const decision = await createDecision(text);

    expectDecisionText(decision, text, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    `已记住：alpha；已记住：beta`,
    `Remembered: alpha; I've remembered: beta`,
  ])('uses generic neutral wording for nested or multiple claims: %s', async (text) => {
    const decision = await createDecision(text);

    expectDecisionText(decision, text.startsWith('已') ? '收到。' : 'Acknowledged.', true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not echo a sensitive proposition in returned or stored corrected text', async () => {
    const sensitiveProposition = 'api_key=sk-memory-claim-synthetic-secret-qq-1234567890';
    const decision = await createDecision(`已记住：${sensitiveProposition}`);

    expectDecisionText(decision, '收到。', true);
    expect(JSON.stringify(decision.actions)).not.toContain(sensitiveProposition);
    const stored = db.prepare('SELECT actions FROM action_decisions WHERE id = ?').get(decision.id) as {
      actions: string;
    };
    expect(stored.actions).not.toContain(sensitiveProposition);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not echo a bare five-digit platform identifier from an unsupported claim', async () => {
    const syntheticPlatformId = '13579';
    const proposition = `联系账号 ${syntheticPlatformId}`;
    const decision = await createDecision(`已记住：${proposition}`);

    expectDecisionText(decision, '收到。', true);
    expect(JSON.stringify(decision.actions)).not.toContain(syntheticPlatformId);
    const stored = db.prepare('SELECT actions FROM action_decisions WHERE id = ?').get(decision.id) as {
      actions: string;
    };
    expect(stored.actions).not.toContain(syntheticPlatformId);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('allows the exact proposition from the turn-bound selected active memory', async () => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_DURABLE_CLAIM, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('accepts selected active memory when its source context is redacted in ContextTrace', async () => {
    const sourceContext = 'chat:private:qq-12345678:synthetic-source';
    const memoryId = await seedActiveMemory(PROPOSITION, { sourceContext });
    selectMemories([memoryId]);
    const storedTrace = db.prepare('SELECT memories FROM context_traces WHERE id = ?').get(CONTEXT_ID) as {
      memories: string;
    };
    const traceMemories = JSON.parse(storedTrace.memories) as Array<{ sourceContext?: string }>;
    if (traceMemories[0]) {
      traceMemories[0].sourceContext = redactContextTraceText(sourceContext);
    }
    db.prepare('UPDATE context_traces SET memories = ? WHERE id = ?')
      .run(JSON.stringify(traceMemories), CONTEXT_ID);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_DURABLE_CLAIM, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('accepts selected active memory created from an audited admin CLI command', async () => {
    const memoryId = await seedExternalAdminMemory();
    selectMemories([memoryId]);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_DURABLE_CLAIM, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects external command evidence without its admin CLI create audit', async () => {
    const memoryId = await seedExternalAdminMemory();
    selectMemories([memoryId]);
    db.prepare(
      `UPDATE audit_log
          SET invocation_context = 'internal'
        WHERE event_type = 'memory.create' AND event_id = ?`,
    ).run(memoryId);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('uses bounded NFKC normalization for an otherwise exact proposition', async () => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);

    const normalizedClaim = 'I have saved to memory: ｒｅｓｐｏｎｓｅ＿ｓｔｙｌｅ＝ｃｏｍｐａｃｔ.';
    const normalizedDecision = await createDecision(normalizedClaim);
    expectDecisionText(normalizedDecision, normalizedClaim, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    ['Remembered: RESPONSE_STYLE=COMPACT', 'Acknowledged: RESPONSE_STYLE=COMPACT'],
    ['Remembered: response_style = compact', 'Acknowledged: response_style = compact'],
  ])('does not normalize case or internal whitespace for exact matching: %s', async (claim, expected) => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);

    const decision = await createDecision(claim);

    expectDecisionText(decision, expected, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not let an unrelated selected active memory authorize the claim', async () => {
    const memoryId = await seedActiveMemory('response_style=expanded');
    selectMemories([memoryId]);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not use semantic or punctuation-insensitive matching for a near proposition', async () => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);

    const decision = await createDecision('已记住：response style compact');

    expectDecisionText(decision, '收到：response style compact', true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not let a selected memory with a different subject authorize the claim', async () => {
    const memoryId = await seedActiveMemory(PROPOSITION, {
      subjectUserId: 'user-rel-mem-01-other-subject',
    });
    selectMemories([memoryId]);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rechecks selected memory lifecycle and source state at decision time', async () => {
    const disabledMemoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([disabledMemoryId]);
    await memoryRepository.disable(disabledMemoryId, {
      actor: {
        canonicalUserId: CANONICAL_USER_ID,
        actorClass: 'user',
        context: 'private_chat',
      },
      reason: 'Synthetic lifecycle regression',
    });

    const disabledDecision = await createDecision(CHINESE_DURABLE_CLAIM);
    expectDecisionText(disabledDecision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects selected active memory whose resolved source points at a different row', async () => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);
    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-rel-mem-01-foreign-source',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      CONVERSATION_ID,
      '{}',
      now,
    );
    db.prepare('UPDATE memory_sources SET raw_event_id = ? WHERE memory_id = ?')
      .run('raw-rel-mem-01-foreign-source', memoryId);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects selected active memory repointed wholesale to an unrelated valid source', async () => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);
    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-rel-mem-01-unrelated-valid',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:unrelated-memory-source',
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'chat-rel-mem-01-unrelated-valid',
      'raw-rel-mem-01-unrelated-valid',
      'message-rel-mem-01-unrelated-valid',
      'private:unrelated-memory-source',
      'private',
      'qq-unrelated-memory-source',
      'Synthetic unrelated source',
      now,
    );
    db.prepare(
      `UPDATE memory_sources
          SET source_id = ?, raw_event_id = ?, source_timestamp = ?
        WHERE memory_id = ?`,
    ).run(
      'raw-rel-mem-01-unrelated-valid',
      'raw-rel-mem-01-unrelated-valid',
      now,
      memoryId,
    );

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects selected active memory repointed to a future same-boundary source', async () => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);
    const memory = db.prepare('SELECT created_at FROM memory_records WHERE id = ?').get(memoryId) as {
      created_at: number;
    };
    const sourceTimestamp = memory.created_at + 1_000;
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-rel-mem-01-future-same-boundary',
      'chat.message.received',
      sourceTimestamp,
      'gateway',
      'qq',
      CONVERSATION_ID,
      '{}',
      sourceTimestamp,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'chat-rel-mem-01-future-same-boundary',
      'raw-rel-mem-01-future-same-boundary',
      'message-rel-mem-01-future-same-boundary',
      CONVERSATION_ID,
      'private',
      `qq-${PLATFORM_USER_ID}`,
      'Synthetic future same-boundary source',
      sourceTimestamp,
    );
    db.prepare(
      `UPDATE memory_sources
          SET source_id = ?, raw_event_id = ?, source_timestamp = ?
        WHERE memory_id = ?`,
    ).run(
      'raw-rel-mem-01-future-same-boundary',
      'raw-rel-mem-01-future-same-boundary',
      sourceTimestamp,
      memoryId,
    );

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects selected active memory repointed to a prior same-boundary source', async () => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);
    const memory = db.prepare('SELECT created_at FROM memory_records WHERE id = ?').get(memoryId) as {
      created_at: number;
    };
    const sourceTimestamp = memory.created_at - 1;
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-rel-mem-01-prior-same-boundary',
      'chat.message.received',
      sourceTimestamp,
      'gateway',
      'qq',
      CONVERSATION_ID,
      '{}',
      sourceTimestamp,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'chat-rel-mem-01-prior-same-boundary',
      'raw-rel-mem-01-prior-same-boundary',
      'message-rel-mem-01-prior-same-boundary',
      CONVERSATION_ID,
      'private',
      `qq-${PLATFORM_USER_ID}`,
      'Synthetic prior source unrelated to the memory',
      sourceTimestamp,
    );
    db.prepare(
      `UPDATE memory_sources
          SET source_id = ?, raw_event_id = ?, source_timestamp = ?
        WHERE memory_id = ?`,
    ).run(
      'raw-rel-mem-01-prior-same-boundary',
      'raw-rel-mem-01-prior-same-boundary',
      sourceTimestamp,
      memoryId,
    );

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('accepts an exact selected active memory in the same group', async () => {
    configureGroupContext();
    const memoryId = await seedActiveMemory(PROPOSITION, {
      scope: 'group',
      groupId: GROUP_ID,
      visibility: 'same_group_only',
      sourceContext: 'group_chat',
    });
    selectMemories([memoryId]);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM, {
      event: makeSyntheticGroupEvent(),
      actorClass: 'group_admin',
    });

    expectDecisionText(decision, CHINESE_DURABLE_CLAIM, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    ['foreign conversation selector', GROUP_ID, 'qq-group-foreign-memory-claim'],
    ['foreign group selector', 'qq-group-foreign-memory-claim', GROUP_ID],
  ])('fails closed for same_group_only memory with a %s', async (_label, groupId, conversationId) => {
    configureGroupContext();
    const memoryId = await seedActiveMemory(PROPOSITION, {
      groupId,
      conversationId,
      visibility: 'same_group_only',
      sourceContext: 'group_chat',
    });
    selectMemories([memoryId]);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM, {
      event: makeSyntheticGroupEvent(),
      actorClass: 'group_admin',
    });

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('fails closed when same_group_only memory has no group or conversation selector', async () => {
    configureGroupContext();
    const memoryId = await seedActiveMemory(PROPOSITION, {
      groupId: GROUP_ID,
      visibility: 'same_group_only',
      sourceContext: 'group_chat',
    });
    db.prepare('UPDATE memory_records SET group_id = NULL WHERE id = ?').run(memoryId);
    selectMemories([memoryId]);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM, {
      event: makeSyntheticGroupEvent(),
      actorClass: 'group_admin',
    });

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    ['foreign group conversation', {
      conversationId: 'qq-group-foreign-memory-claim',
      conversationType: 'group' as const,
      groupId: GROUP_ID,
    }],
    ['foreign group identifier', {
      conversationId: GROUP_ID,
      conversationType: 'group' as const,
      groupId: 'qq-group-foreign-memory-claim',
    }],
    ['private conversation type', {
      conversationId: GROUP_ID,
      conversationType: 'private' as const,
      groupId: GROUP_ID,
    }],
  ])('does not authorize group memory for an action with a %s', async (_label, target) => {
    configureGroupContext();
    const memoryId = await seedActiveMemory(PROPOSITION, {
      scope: 'group',
      groupId: GROUP_ID,
      visibility: 'same_group_only',
      sourceContext: 'group_chat',
    });
    selectMemories([memoryId]);

    const decision = await createRepositoryDecision({
      ...makeGroupTextAction(CHINESE_DURABLE_CLAIM),
      target,
    });

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    ['non-chat raw type', () => db.prepare("UPDATE raw_events SET type = 'system.synthetic'").run()],
    ['raw/chat conversation mismatch', () => (
      db.prepare("UPDATE raw_events SET conversation_id = 'private:foreign-memory-claim'").run()
    )],
  ])('fails closed for %s in the trigger source chain', async (_label, corruptSource) => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);
    corruptSource();

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    ['foreign private conversation', {
      conversationId: 'private:foreign-memory-claim',
      conversationType: 'private' as const,
      userId: `qq-${PLATFORM_USER_ID}`,
      canonicalUserId: CANONICAL_USER_ID,
    }],
    ['foreign private canonical actor', {
      conversationId: CONVERSATION_ID,
      conversationType: 'private' as const,
      userId: `qq-${PLATFORM_USER_ID}`,
      canonicalUserId: 'user-rel-mem-01-foreign',
    }],
    ['foreign private delivery user', {
      conversationId: CONVERSATION_ID,
      conversationType: 'private' as const,
      userId: 'qq-synthetic-memory-claim-foreign',
      canonicalUserId: CANONICAL_USER_ID,
    }],
  ])('does not authorize selected memory for an action with a %s', async (_label, target) => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);

    const decision = await createRepositoryDecision({
      ...makePrivateTextAction(CHINESE_DURABLE_CLAIM),
      target,
    });

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not authorize a selected memory claim in a cross-target dm_user action', async () => {
    const memoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([memoryId]);

    const decision = await createRepositoryDecision({
      ...makePrivateTextAction(CHINESE_DURABLE_CLAIM),
      type: 'dm_user',
      target: {
        conversationId: CONVERSATION_ID,
        conversationType: 'private',
        userId: 'qq-synthetic-memory-claim-foreign',
        canonicalUserId: 'user-rel-mem-01-foreign',
      },
    });

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('describes a fully committed same-turn memory.propose effect only as pending review', async () => {
    const memoryId = await seedProposalToolChain(PROPOSITION, true);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_PENDING, true);
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?').get(memoryId)).toEqual({
      state: 'proposed',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('preserves exact pending-review wording for the matching committed proposal', async () => {
    await seedProposalToolChain(PROPOSITION, true);

    const decision = await createDecision(CHINESE_PENDING);

    expectDecisionText(decision, CHINESE_PENDING, false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    `已创建记忆提议：${PROPOSITION}`,
    `Created a memory proposal: ${PROPOSITION}`,
  ])('canonicalizes supported proposal wording %s to pending review', async (claim) => {
    await seedProposalToolChain(PROPOSITION, true);

    const decision = await createDecision(claim);

    expectDecisionText(
      decision,
      claim.startsWith('已')
        ? CHINESE_PENDING
        : `Created a memory proposal pending review: ${PROPOSITION}`,
      true,
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not treat a successful tool row with a rejected handler result as a memory effect', async () => {
    await seedProposalToolChain(PROPOSITION, false);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT status FROM tool_calls').get()).toEqual({ status: 'success' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not let an unrelated committed proposal authorize the claim', async () => {
    await seedProposalToolChain('response_style=expanded', true);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('requires the proposal tool input content to match the created memory', async () => {
    await seedProposalToolChain(PROPOSITION, true);
    db.prepare('UPDATE tool_calls SET input = ?').run(JSON.stringify({
      title: 'Synthetic proposed memory 1',
      content: 'response_style=expanded',
    }));

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    ['memory authority', () => db.prepare("UPDATE memory_records SET authority = 'inferred'").run()],
    ['source extractor', () => db.prepare("UPDATE memory_sources SET extracted_by = 'evaluator'").run()],
    ['source timestamp', () => db.prepare('UPDATE memory_sources SET source_timestamp = source_timestamp + 1').run()],
  ])('rejects a proposal chain with mismatched %s', async (_label, corruptChain) => {
    await seedProposalToolChain(PROPOSITION, true);
    corruptChain();

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects an expired same-turn proposal even when decision createdAt is backdated', async () => {
    await seedProposalToolChain(PROPOSITION, true);
    const expiredAt = Date.now() - 1;
    db.prepare('UPDATE memory_records SET expires_at = ?').run(expiredAt);

    const decision = await createRepositoryDecision(
      makePrivateTextAction(CHINESE_DURABLE_CLAIM),
      new Date(expiredAt - 1_000),
    );

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects duplicate tool effects for one evaluator decision', async () => {
    const memoryId = await seedProposalToolChain(PROPOSITION, true);
    const evaluatorDecisionId = readMemoryEvaluatorDecisionId(memoryId);
    new ToolCallRepository(db).createSync({
      id: 'tool-memory-proposal-duplicate',
      turnId: TURN_ID,
      evaluatorDecisionId,
      toolName: 'memory.propose',
      input: { title: 'Synthetic proposed memory 1', content: PROPOSITION },
      output: {
        status: 'proposed',
        scope: 'user',
        visibility: 'private_only',
        kind: 'preference',
      },
      requestedBy: 'pi',
      actor: { canonicalUserId: CANONICAL_USER_ID, actorClass: 'user' },
      context: 'private_chat',
      status: 'success',
      executionTimeMs: 1,
      secretsRedacted: false,
    });

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects duplicate memory effects for one evaluator decision', async () => {
    const memoryId = await seedProposalToolChain(PROPOSITION, true);
    const evaluatorDecisionId = readMemoryEvaluatorDecisionId(memoryId);
    await memoryRepository.create({
      id: 'memory-proposal-duplicate',
      scope: 'user',
      canonicalUserId: CANONICAL_USER_ID,
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'tool_derived',
      kind: 'preference',
      title: 'Synthetic duplicate proposed memory',
      content: PROPOSITION,
      state: 'proposed',
      confidence: 0.95,
      importance: 0.8,
      sourceContext: 'private_chat',
      evaluatorDecisionId,
      sources: [{
        sourceType: 'raw_event',
        sourceId: RAW_EVENT_ID,
        sourceTimestamp: readRawEventTimestamp(),
        extractedBy: 'tool',
      }],
      actor: {
        canonicalUserId: CANONICAL_USER_ID,
        actorClass: 'user',
        context: 'private_chat',
      },
    });

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects a proposal chain with a contradictory duplicate create revision', async () => {
    const memoryId = await seedProposalToolChain(PROPOSITION, true);
    db.prepare(
      `INSERT INTO memory_revisions (
         id, memory_id, revision_number, change_type, previous_state, new_state,
         reason, actor, evaluator_decision_id, created_at
       )
       SELECT ?, memory_id, revision_number, change_type, previous_state, new_state,
              reason, 'system', NULL, created_at
         FROM memory_revisions
        WHERE memory_id = ? AND revision_number = 1`,
    ).run('revision-rel-mem-01-contradictory', memoryId);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    ['create revision', (futureAt: number) => (
      db.prepare('UPDATE memory_revisions SET created_at = ?').run(futureAt)
    )],
    ['memory audit', (futureAt: number) => (
      db.prepare("UPDATE audit_log SET timestamp = ? WHERE event_type = 'memory.create'").run(futureAt)
    )],
    ['tool audit', (futureAt: number) => (
      db.prepare("UPDATE audit_log SET timestamp = ? WHERE event_type = 'tool.executed'").run(futureAt)
    )],
  ])('rejects a proposal chain whose %s is timestamped after the decision', async (_label, moveFuture) => {
    await seedProposalToolChain(PROPOSITION, true);
    moveFuture(Date.now() + 60_000);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('accepts a committed group proposal when the social actor is a normalized group admin', async () => {
    configureGroupContext();
    await seedProposalToolChain(PROPOSITION, true);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM, {
      event: makeSyntheticGroupEvent(),
      actorClass: 'group_admin',
    });

    expectDecisionText(decision, CHINESE_PENDING, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('fails closed when active and proposed evidence make the memory state ambiguous', async () => {
    const activeMemoryId = await seedActiveMemory(PROPOSITION);
    selectMemories([activeMemoryId]);
    await seedProposalToolChain(PROPOSITION, true);

    const decision = await createDecision(CHINESE_DURABLE_CLAIM);

    expectDecisionText(decision, CHINESE_NEUTRAL, true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  async function createDecision(
    responseText: string,
    options: {
      event?: ChatMessageReceived;
      actorClass?: ActorClass;
    } = {},
  ): Promise<ActionDecision> {
    const service = new SocialDecisionService(
      new ActionRepository(db),
      new EvaluatorStub(),
      new ActionCooldownManager(),
    );
    return service.createDecision({
      turnId: TURN_ID,
      rawEventId: RAW_EVENT_ID,
      event: options.event ?? makeSyntheticPrivateEvent(),
      responseText,
      signals: {
        classification: 'needs_response',
        triggerScore: 1,
        triggerReasons: ['private_message'],
        suppressors: [],
        recommendedPath: 'reply_fast_path',
      },
      actor: {
        canonicalUserId: CANONICAL_USER_ID,
        actorClass: options.actorClass ?? 'user',
      },
    });
  }

  async function createRepositoryDecision(
    action: ActionPlan,
    createdAt?: Date,
  ): Promise<ActionDecision> {
    return new ActionRepository(db).createDecision({
      turnId: TURN_ID,
      decidedBy: 'pi',
      actions: [action],
      riskLevel: 'low',
      confidence: 1,
      reasons: ['synthetic memory truthfulness action'],
      suppressors: [],
      evaluatorRequired: false,
      claimActor: {
        canonicalUserId: CANONICAL_USER_ID,
      },
      createdAt,
    });
  }

  function makePrivateTextAction(text: string): ActionPlan {
    return {
      type: 'reply_full',
      priority: 100,
      target: {
        conversationId: CONVERSATION_ID,
        conversationType: 'private',
        userId: `qq-${PLATFORM_USER_ID}`,
        canonicalUserId: CANONICAL_USER_ID,
      },
      payload: { text },
      constraints: {},
      reason: 'Synthetic private memory claim action',
    };
  }

  function makeGroupTextAction(text: string): ActionPlan {
    return {
      type: 'reply_short',
      priority: 100,
      target: {
        conversationId: GROUP_ID,
        conversationType: 'group',
        groupId: GROUP_ID,
      },
      payload: { text },
      constraints: {},
      reason: 'Synthetic group memory claim action',
    };
  }

  function expectDecisionText(
    decision: ActionDecision,
    expectedText: string,
    corrected: boolean,
  ): void {
    const returnedText = decision.actions[0]?.payload?.text ?? '';
    const stored = db.prepare('SELECT actions FROM action_decisions WHERE id = ?').get(decision.id) as {
      actions: string;
    };
    const storedActions = JSON.parse(stored.actions) as Array<{ payload?: { text?: string } }>;
    const storedText = storedActions[0]?.payload?.text ?? '';

    expect(returnedText).toBe(expectedText);
    expect(storedText).toBe(expectedText);
    expect(storedText).toBe(returnedText);
    expect(decision.suppressors.includes(CLAIM_GUARD_SUPPRESSOR)).toBe(corrected);
  }

  async function seedActiveMemory(
    content: string,
    options: {
      subjectUserId?: string;
      scope?: 'user' | 'group' | 'conversation' | 'global';
      groupId?: string;
      conversationId?: string;
      visibility?: 'private_only' | 'same_group_only' | 'public';
      sourceContext?: string;
    } = {},
  ): Promise<string> {
    const scope = options.scope ?? 'user';
    const sourceContext = options.sourceContext ?? 'private_chat';
    return memoryRepository.create({
      id: `memory-active-${++evidenceCounter}`,
      scope,
      canonicalUserId: scope === 'user' ? CANONICAL_USER_ID : undefined,
      groupId: options.groupId,
      conversationId: options.conversationId,
      subjectUserId: options.subjectUserId,
      visibility: options.visibility ?? 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: `Synthetic active memory ${evidenceCounter}`,
      content,
      state: 'active',
      confidence: 0.95,
      importance: 0.8,
      sourceContext,
      sources: [{
        sourceType: 'raw_event',
        sourceId: RAW_EVENT_ID,
        sourceTimestamp: readRawEventTimestamp(),
        extractedBy: 'user',
      }],
      actor: {
        canonicalUserId: CANONICAL_USER_ID,
        actorClass: 'user',
        context: sourceContext,
      },
    });
  }

  async function seedExternalAdminMemory(): Promise<string> {
    return memoryRepository.create({
      id: `memory-external-admin-${++evidenceCounter}`,
      scope: 'user',
      canonicalUserId: CANONICAL_USER_ID,
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: `Synthetic admin memory ${evidenceCounter}`,
      content: PROPOSITION,
      state: 'active',
      confidence: 0.95,
      importance: 0.8,
      sourceContext: 'admin_cli:synthetic-entry',
      sources: [{
        sourceType: 'user_command',
        sourceId: `external:user-command:${evidenceCounter}`,
        sourceTimestamp: Date.now() - 1,
        extractedBy: 'user',
        external: true,
      }],
      actor: {
        canonicalUserId: CANONICAL_USER_ID,
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });
  }

  function selectMemories(memoryIds: string[]): void {
    const readMemory = db.prepare(
      `SELECT id, scope, kind, title, source_context
         FROM memory_records
        WHERE id = ?`,
    );
    const memories = memoryIds.map((memoryId) => {
      const row = readMemory.get(memoryId) as {
        id: string;
        scope: string;
        kind: string;
        title: string;
        source_context: string | null;
      };
      return {
        memoryId: row.id,
        scope: row.scope,
        kind: row.kind,
        title: row.title,
        sourceContext: row.source_context ?? undefined,
      };
    });
    db.prepare(
      `UPDATE context_traces
          SET candidate_memory_ids = ?, selected_memory_ids = ?, memories = ?, created_at = ?
        WHERE id = ? AND turn_id = ?`,
    ).run(
      JSON.stringify(memoryIds),
      JSON.stringify(memoryIds),
      JSON.stringify(memories),
      Date.now(),
      CONTEXT_ID,
      TURN_ID,
    );
  }

  async function seedProposalToolChain(content: string, commitMemory: boolean): Promise<string> {
    const sequence = ++evidenceCounter;
    const evaluatorDecisionId = `eval-memory-proposal-${sequence}`;
    const toolCallId = `tool-memory-proposal-${sequence}`;
    const now = Date.now();
    const context = db.prepare(
      'SELECT conversation_type, group_id, created_at FROM context_traces WHERE id = ?',
    ).get(CONTEXT_ID) as {
      conversation_type: 'private' | 'group';
      group_id: string | null;
      created_at: number;
    };
    const evaluatorAt = Math.max(now, context.created_at);
    const invocationContext = context.conversation_type === 'group' ? 'group_chat' : 'private_chat';
    const scope = context.conversation_type === 'group' ? 'group' : 'user';
    const visibility = context.conversation_type === 'group' ? 'same_group_only' : 'private_only';
    const title = `Synthetic proposed memory ${sequence}`;
    db.prepare(
      `INSERT INTO evaluator_decisions (
         id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
         evaluator_version, tool_name, actor_user_id, actor_class, invocation_context,
         source_event_ids, request_created_at, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      evaluatorDecisionId,
      `request-memory-proposal-${sequence}`,
      'tool',
      TURN_ID,
      'approve',
      'Synthetic approved memory proposal',
      0.95,
      'low',
      'test-memory-claim-v1',
      'memory.propose',
      CANONICAL_USER_ID,
      'user',
      invocationContext,
      JSON.stringify([RAW_EVENT_ID]),
      evaluatorAt,
      evaluatorAt,
    );

    let memoryId = '';
    if (commitMemory) {
      memoryId = await memoryRepository.create({
        id: `memory-proposal-${sequence}`,
        scope,
        canonicalUserId: scope === 'user' ? CANONICAL_USER_ID : undefined,
        groupId: scope === 'group' ? context.group_id ?? undefined : undefined,
        visibility,
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'preference',
        title,
        content,
        state: 'proposed',
        confidence: 0.95,
        importance: 0.8,
        sourceContext: invocationContext,
        evaluatorDecisionId,
        sources: [{
          sourceType: 'raw_event',
          sourceId: RAW_EVENT_ID,
          sourceTimestamp: readRawEventTimestamp(),
          extractedBy: 'tool',
        }],
        actor: {
          canonicalUserId: CANONICAL_USER_ID,
          actorClass: 'user',
          context: invocationContext,
        },
      });
    }

    new ToolCallRepository(db).createSync({
      id: toolCallId,
      turnId: TURN_ID,
      evaluatorDecisionId,
      toolName: 'memory.propose',
      input: { title, content },
      output: commitMemory
        ? {
            status: 'proposed',
            scope,
            visibility,
            kind: 'preference',
            reason: 'created proposed memory for review',
          }
        : { status: 'rejected', reason: 'synthetic handler rejection' },
      requestedBy: 'pi',
      actor: {
        canonicalUserId: CANONICAL_USER_ID,
        actorClass: 'user',
      },
      context: invocationContext,
      status: 'success',
      executionTimeMs: 1,
      secretsRedacted: false,
      createdAt: Date.now(),
    });
    new AuditRepository(db).createSync({
      timestamp: new Date(),
      category: 'tool',
      level: 'redacted_full',
      eventType: 'tool.executed',
      eventId: toolCallId,
      actor: {
        canonicalUserId: CANONICAL_USER_ID,
        actorClass: 'user',
        context: invocationContext,
      },
      summary: 'Synthetic memory.propose terminal evidence',
      redacted: true,
      riskLevel: 'low',
      evaluatorDecisionId,
    });

    return memoryId;
  }

  function configureGroupContext(): void {
    db.prepare('UPDATE raw_events SET conversation_id = ? WHERE id = ?')
      .run(GROUP_ID, RAW_EVENT_ID);
    db.prepare(
      `UPDATE chat_messages
          SET conversation_id = ?, conversation_type = 'group', group_id = ?
        WHERE raw_event_id = ?`,
    ).run(GROUP_ID, GROUP_ID, RAW_EVENT_ID);
    db.prepare('UPDATE agent_turns SET conversation_id = ? WHERE id = ?')
      .run(GROUP_ID, TURN_ID);
    db.prepare(
      `UPDATE context_traces
          SET conversation_id = ?, conversation_type = 'group', group_id = ?
        WHERE id = ?`,
    ).run(GROUP_ID, GROUP_ID, CONTEXT_ID);
  }

  function readRawEventTimestamp(): number {
    const row = db.prepare('SELECT timestamp FROM raw_events WHERE id = ?').get(RAW_EVENT_ID) as {
      timestamp: number;
    };
    return row.timestamp;
  }

  function readMemoryEvaluatorDecisionId(memoryId: string): string {
    const row = db.prepare(
      'SELECT evaluator_decision_id FROM memory_records WHERE id = ?',
    ).get(memoryId) as { evaluator_decision_id: string };
    return row.evaluator_decision_id;
  }
});

function makeSyntheticPrivateEvent(): ChatMessageReceived {
  return {
    id: RAW_EVENT_ID,
    type: 'chat.message.received',
    timestamp: new Date('2030-01-01T00:00:00.000Z'),
    source: 'gateway',
    platform: 'qq',
    conversationId: CONVERSATION_ID,
    ingress: {
      transport: 'http',
      platformEventId: 'synthetic-rel-mem-01',
    },
    message: {
      messageId: 'message-rel-mem-01',
      conversationId: CONVERSATION_ID,
      conversationType: 'private',
      senderId: `qq-${PLATFORM_USER_ID}`,
      content: {
        text: `Please retain ${PROPOSITION}.`,
      },
      mentions: [],
      mentionsBot: false,
    },
    gatewayCapabilities: {
      platform: 'qq',
      reactions: {
        emojiLike: false,
        faceMessage: false,
      },
      foldedForward: {
        groupForward: false,
        privateForward: false,
        customNode: false,
      },
      platformAdmin: {
        kick: false,
        mute: false,
        setGroupCard: false,
      },
    },
  };
}

function makeSyntheticGroupEvent(): ChatMessageReceived {
  return {
    ...makeSyntheticPrivateEvent(),
    conversationId: GROUP_ID,
    message: {
      ...makeSyntheticPrivateEvent().message,
      conversationId: GROUP_ID,
      conversationType: 'group',
      groupId: GROUP_ID,
      senderRole: 'admin',
      mentionsBot: true,
    },
  };
}
