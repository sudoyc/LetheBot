import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { ContextTraceRepository } from '../../../src/storage/context-trace-repository';
import type { ContextPack } from '../../../src/types/context';

describe('ContextTraceRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: ContextTraceRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-context-trace-repository-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    repo = new ContextTraceRepository(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-context-trace-repo', 'message.group', now, 'gateway', 'qq', 'group:qq-group-10001', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-context-trace-repo', 'group:qq-group-10001', 'evt-context-trace-repo', 'mock', 'mock', 'running', now);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('redacts sensitive trace narrative and memory metadata before durable persistence while preserving lookup ids', async () => {
    const context: ContextPack = {
      id: 'ctx-context-trace-repo',
      turnId: 'turn-context-trace-repo',
      createdAt: new Date(1_700_000_000_000),
      conversation: {
        conversationId: 'group:qq-group-10001',
        conversationType: 'group',
        groupId: 'qq-group-10001',
      },
      recentMessages: [
        {
          messageId: 'msg-qq-10002',
          senderId: 'qq-10003',
          senderDisplayName: 'Display should not be stored in trace',
          text: 'Raw recent message should not be stored in trace',
          timestamp: new Date(1_700_000_000_000),
          isFromBot: false,
        },
      ],
      memory: {
        retrievedFacts: [
          {
            memoryId: 'mem-qq-10004',
            scope: 'user',
            kind: 'fact',
            title: 'title sk-context-trace-title-secret-should-not-persist to qq-1234567891',
            content: 'Memory content should not be stored in context trace',
            confidence: 0.95,
            sourceContext: 'source api_key=sk-context-trace-source-secret-should-not-persist qq-1234567892',
          },
        ],
        selectedMemoryIds: ['mem-qq-10004'],
      },
      participants: [],
      injectedIdentityFields: [
        'conversation_id',
        'identity token=sk-context-trace-identity-secret-should-not-persist qq-1234567893',
      ],
      trace: {
        candidateMemoryIds: ['mem-qq-10004', 'mem-qq-10005'],
        selectedMemoryIds: ['mem-qq-10004'],
        rejectedMemories: [
          {
            memoryId: 'mem-qq-10005',
            reason: 'reject api_key=sk-context-trace-rejected-secret-should-not-persist qq-1234567894',
          },
        ],
        filtersApplied: [
          'state=active',
          'filter sk-context-trace-filter-secret-should-not-persist legacy_qq-1234567895',
        ],
      },
      tokenBudget: {
        max: 8000,
        used: 100,
        breakdown: {
          recentMessages: 10,
          memory: 40,
          identity: 20,
          system: 30,
        },
        promptLayers: [
          {
            name: 'recent_messages sk-context-trace-layer-name-secret-should-not-persist',
            version: 'pi-prompt qq-1234567896',
            tokens: 10,
          },
          {
            name: 'system_prompt_estimate',
            version: 'bounded-system-estimate-v1',
            tokens: 30,
          },
        ],
      },
    };

    await repo.createFromContext(context);

    const row = db
      .prepare(
        `SELECT
          id, turn_id, conversation_id, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories
         FROM context_traces WHERE id = ?`
      )
      .get(context.id) as {
        id: string;
        turn_id: string;
        conversation_id: string;
        group_id: string;
        candidate_memory_ids: string;
        selected_memory_ids: string;
        rejected_memories: string;
        filters_applied: string;
        injected_identity_fields: string;
        recent_message_ids: string;
        token_budget: string;
        memories: string;
      };
    const serializedRow = JSON.stringify(row);

    expect(serializedRow).not.toContain('sk-context-trace-title-secret-should-not-persist');
    expect(serializedRow).not.toContain('sk-context-trace-source-secret-should-not-persist');
    expect(serializedRow).not.toContain('sk-context-trace-identity-secret-should-not-persist');
    expect(serializedRow).not.toContain('sk-context-trace-rejected-secret-should-not-persist');
    expect(serializedRow).not.toContain('sk-context-trace-filter-secret-should-not-persist');
    expect(serializedRow).not.toContain('sk-context-trace-layer-name-secret-should-not-persist');
    expect(serializedRow).not.toContain('1234567891');
    expect(serializedRow).not.toContain('1234567892');
    expect(serializedRow).not.toContain('1234567893');
    expect(serializedRow).not.toContain('1234567894');
    expect(serializedRow).not.toContain('1234567895');
    expect(serializedRow).not.toContain('1234567896');
    expect(serializedRow).not.toContain('Memory content should not be stored');
    expect(serializedRow).not.toContain('Raw recent message should not be stored');
    expect(serializedRow).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedRow).toContain('[REDACTED:api_key_assignment]');
    expect(serializedRow).toContain('[REDACTED:token_assignment]');
    expect(serializedRow).toContain('[REDACTED:platform_id]');

    expect(row.id).toBe('ctx-context-trace-repo');
    expect(row.turn_id).toBe('turn-context-trace-repo');
    expect(row.conversation_id).toBe('group:qq-group-10001');
    expect(row.group_id).toBe('qq-group-10001');
    expect(JSON.parse(row.candidate_memory_ids)).toEqual(['mem-qq-10004', 'mem-qq-10005']);
    expect(JSON.parse(row.selected_memory_ids)).toEqual(['mem-qq-10004']);
    expect(JSON.parse(row.recent_message_ids)).toEqual(['msg-qq-10002']);

    const stored = await repo.findByTurnId('turn-context-trace-repo');
    expect(stored?.memories[0]?.memoryId).toBe('mem-qq-10004');
    expect(stored?.memories[0]?.title).toContain('[REDACTED:openai_like_api_key]');
    expect(stored?.rejectedMemories[0]?.memoryId).toBe('mem-qq-10005');
    expect(stored?.rejectedMemories[0]?.reason).toContain('[REDACTED:api_key_assignment]');
    expect(stored?.tokenBudget.promptLayers?.[0]?.name).toContain('[REDACTED:openai_like_api_key]');
    expect(stored?.tokenBudget.promptLayers?.[0]?.version).toContain('[REDACTED:platform_id]');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for adjacent secret/platform trace metadata before durable persistence', async () => {
    const context: ContextPack = {
      id: 'ctx-context-trace-adjacent',
      turnId: 'turn-context-trace-repo',
      createdAt: new Date(1_700_000_000_000),
      conversation: {
        conversationId: 'group:qq-group-10001',
        conversationType: 'group',
        groupId: 'qq-group-10001',
      },
      recentMessages: [
        {
          messageId: 'msg-qq-10002',
          senderId: 'qq-10003',
          text: 'Raw recent message should not be stored in trace',
          timestamp: new Date(1_700_000_000_000),
          isFromBot: false,
        },
      ],
      memory: {
        retrievedFacts: [
          {
            memoryId: 'mem-qq-10004',
            scope: 'user',
            kind: 'fact',
            title: 'title sk-context-trace-adjacent-title-secret-should-not-persist-qq-12345678911',
            content: 'Memory content should not be stored in context trace',
            confidence: 0.95,
            sourceContext: 'source sk-context-trace-adjacent-source-secret-should-not-persist-qq-12345678912',
          },
        ],
        selectedMemoryIds: ['mem-qq-10004'],
      },
      participants: [],
      injectedIdentityFields: [
        'identity sk-context-trace-adjacent-identity-secret-should-not-persist-qq-12345678913',
      ],
      trace: {
        candidateMemoryIds: ['mem-qq-10004', 'mem-qq-10005'],
        selectedMemoryIds: ['mem-qq-10004'],
        rejectedMemories: [
          {
            memoryId: 'mem-qq-10005',
            reason: 'reject sk-context-trace-adjacent-rejected-secret-should-not-persist-qq-12345678914',
          },
        ],
        filtersApplied: [
          'filter sk-context-trace-adjacent-filter-secret-should-not-persist-qq-12345678915',
        ],
      },
      tokenBudget: {
        max: 8000,
        used: 100,
        breakdown: {
          recentMessages: 10,
          memory: 40,
          identity: 20,
          system: 30,
        },
        promptLayers: [
          {
            name: 'layer sk-context-trace-adjacent-layer-name-secret-should-not-persist-qq-12345678916',
            version: 'version sk-context-trace-adjacent-layer-version-secret-should-not-persist-qq-12345678917',
            tokens: 10,
          },
        ],
      },
    };

    await repo.createFromContext(context);

    const row = db
      .prepare(
        `SELECT
          rejected_memories, filters_applied, injected_identity_fields,
          token_budget, memories
         FROM context_traces WHERE id = ?`
      )
      .get(context.id) as {
        rejected_memories: string;
        filters_applied: string;
        injected_identity_fields: string;
        token_budget: string;
        memories: string;
      };
    const storedMemories = JSON.parse(row.memories) as Array<{
      title: string;
      sourceContext?: string;
    }>;
    const storedRejectedMemories = JSON.parse(row.rejected_memories) as Array<{ reason: string }>;
    const storedFilters = JSON.parse(row.filters_applied) as string[];
    const storedIdentityFields = JSON.parse(row.injected_identity_fields) as string[];
    const storedTokenBudget = JSON.parse(row.token_budget) as NonNullable<ContextPack['tokenBudget']>;
    const serializedRow = JSON.stringify(row);

    for (const value of [
      storedMemories[0]?.title ?? '',
      storedMemories[0]?.sourceContext ?? '',
      storedRejectedMemories[0]?.reason ?? '',
      storedFilters[0] ?? '',
      storedIdentityFields[0] ?? '',
      storedTokenBudget.promptLayers?.[0]?.name ?? '',
      storedTokenBudget.promptLayers?.[0]?.version ?? '',
    ]) {
      expect(value).toContain('[REDACTED:openai_like_api_key]');
      expect(value).toContain('[REDACTED:platform_id]');
    }

    expect(serializedRow).not.toContain('sk-context-trace-adjacent');
    expect(serializedRow).not.toContain('qq-12345678911');
    expect(serializedRow).not.toContain('qq-12345678912');
    expect(serializedRow).not.toContain('qq-12345678913');
    expect(serializedRow).not.toContain('qq-12345678914');
    expect(serializedRow).not.toContain('qq-12345678915');
    expect(serializedRow).not.toContain('qq-12345678916');
    expect(serializedRow).not.toContain('qq-12345678917');
    expect(serializedRow).not.toContain('12345678911');
    expect(serializedRow).not.toContain('12345678912');
    expect(serializedRow).not.toContain('12345678913');
    expect(serializedRow).not.toContain('12345678914');
    expect(serializedRow).not.toContain('12345678915');
    expect(serializedRow).not.toContain('12345678916');
    expect(serializedRow).not.toContain('12345678917');
    expect(serializedRow).not.toContain('Memory content should not be stored');
    expect(serializedRow).not.toContain('Raw recent message should not be stored');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for assignment-shaped adjacent trace metadata before durable persistence', async () => {
    const context: ContextPack = {
      id: 'ctx-context-trace-assignment-adjacent',
      turnId: 'turn-context-trace-repo',
      createdAt: new Date(1_700_000_000_000),
      conversation: {
        conversationId: 'group:qq-group-10001',
        conversationType: 'group',
        groupId: 'qq-group-10001',
      },
      recentMessages: [
        {
          messageId: 'msg-qq-10002',
          senderId: 'qq-10003',
          text: 'Raw recent message should not be stored in trace',
          timestamp: new Date(1_700_000_000_000),
          isFromBot: false,
        },
      ],
      memory: {
        retrievedFacts: [
          {
            memoryId: 'mem-qq-10004',
            scope: 'user',
            kind: 'fact',
            title: 'title api_key=sk-context-trace-assignment-title-should-not-persist-qq-12345678911',
            content: 'Memory content should not be stored in context trace',
            confidence: 0.95,
            sourceContext: 'source api_key=sk-context-trace-assignment-source-should-not-persist-qq-12345678912',
          },
        ],
        selectedMemoryIds: ['mem-qq-10004'],
      },
      participants: [],
      injectedIdentityFields: [
        'identity api_key=sk-context-trace-assignment-identity-should-not-persist-qq-12345678913',
      ],
      trace: {
        candidateMemoryIds: ['mem-qq-10004', 'mem-qq-10005'],
        selectedMemoryIds: ['mem-qq-10004'],
        rejectedMemories: [
          {
            memoryId: 'mem-qq-10005',
            reason: 'reject api_key=sk-context-trace-assignment-rejected-should-not-persist-qq-12345678914',
          },
        ],
        filtersApplied: [
          'filter api_key=sk-context-trace-assignment-filter-should-not-persist-qq-12345678915',
        ],
      },
      tokenBudget: {
        max: 8000,
        used: 100,
        breakdown: {
          recentMessages: 10,
          memory: 40,
          identity: 20,
          system: 30,
        },
        promptLayers: [
          {
            name: 'layer api_key=sk-context-trace-assignment-layer-name-should-not-persist-qq-12345678916',
            version: 'version api_key=sk-context-trace-assignment-layer-version-should-not-persist-qq-12345678917',
            tokens: 10,
          },
        ],
      },
    };

    await repo.createFromContext(context);

    const row = db
      .prepare(
        `SELECT
          rejected_memories, filters_applied, injected_identity_fields,
          token_budget, memories
         FROM context_traces WHERE id = ?`
      )
      .get(context.id) as {
        rejected_memories: string;
        filters_applied: string;
        injected_identity_fields: string;
        token_budget: string;
        memories: string;
      };
    const storedMemories = JSON.parse(row.memories) as Array<{
      title: string;
      sourceContext?: string;
    }>;
    const storedRejectedMemories = JSON.parse(row.rejected_memories) as Array<{ reason: string }>;
    const storedFilters = JSON.parse(row.filters_applied) as string[];
    const storedIdentityFields = JSON.parse(row.injected_identity_fields) as string[];
    const storedTokenBudget = JSON.parse(row.token_budget) as NonNullable<ContextPack['tokenBudget']>;
    const serializedRow = JSON.stringify(row);

    for (const value of [
      storedMemories[0]?.title ?? '',
      storedMemories[0]?.sourceContext ?? '',
      storedRejectedMemories[0]?.reason ?? '',
      storedFilters[0] ?? '',
      storedIdentityFields[0] ?? '',
      storedTokenBudget.promptLayers?.[0]?.name ?? '',
      storedTokenBudget.promptLayers?.[0]?.version ?? '',
    ]) {
      expect(value).toContain('[REDACTED:api_key_assignment]');
      expect(value).toContain('[REDACTED:platform_id]');
    }

    expect(serializedRow).not.toContain('api_key=');
    expect(serializedRow).not.toContain('sk-context-trace-assignment');
    expect(serializedRow).not.toContain('qq-12345678911');
    expect(serializedRow).not.toContain('qq-12345678912');
    expect(serializedRow).not.toContain('qq-12345678913');
    expect(serializedRow).not.toContain('qq-12345678914');
    expect(serializedRow).not.toContain('qq-12345678915');
    expect(serializedRow).not.toContain('qq-12345678916');
    expect(serializedRow).not.toContain('qq-12345678917');
    expect(serializedRow).not.toContain('12345678911');
    expect(serializedRow).not.toContain('12345678912');
    expect(serializedRow).not.toContain('12345678913');
    expect(serializedRow).not.toContain('12345678914');
    expect(serializedRow).not.toContain('12345678915');
    expect(serializedRow).not.toContain('12345678916');
    expect(serializedRow).not.toContain('12345678917');
    expect(serializedRow).not.toContain('Memory content should not be stored');
    expect(serializedRow).not.toContain('Raw recent message should not be stored');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
