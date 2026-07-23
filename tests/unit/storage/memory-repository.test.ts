import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigrations, closeDatabase } from '../../../src/storage/database';
import { MemoryPolicyError, MemoryRepository } from '../../../src/storage/memory-repository';
import { GroupSummaryPolicyRepository } from '../../../src/storage/group-summary-policy-repository';

describe('MemoryRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: MemoryRepository;
  let groupSummaryPolicies: GroupSummaryPolicyRepository;
  let createMemory: MemoryRepository['create'];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigrations(db, join(__dirname, '../../../migrations'));
    repo = new MemoryRepository(db);
    groupSummaryPolicies = new GroupSummaryPolicyRepository(db);

    const now = Date.now();

    // 创建测试用户
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-alice',
      now,
      now
    );
    db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id, account_type,
        verified_level, status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'qq',
      'qq-user-alice',
      'user-alice',
      'private',
      'observed',
      'active',
      now,
      now
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-memory-test-source',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:user-alice',
      '{}',
      now
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-source-1',
      'raw-memory-test-source',
      'platform-msg-source-1',
      'private:user-alice',
      'private',
      'qq-user-alice',
      'Synthetic memory source',
      now
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-memory-group-alpha-source',
      'chat.message.received',
      now + 1,
      'gateway',
      'qq',
      'group:group-alpha',
      '{}',
      now + 1
    );
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-bob',
      now,
      now
    );
    db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id, account_type,
        verified_level, status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'qq',
      'qq-user-bob',
      'user-bob',
      'private',
      'observed',
      'active',
      now,
      now
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-memory-bob-source',
      'chat.message.received',
      now + 2,
      'gateway',
      'qq',
      'private:user-bob',
      '{}',
      now + 2
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-source-bob',
      'raw-memory-bob-source',
      'platform-msg-source-bob',
      'private:user-bob',
      'private',
      'qq-user-bob',
      'Synthetic other-user memory source',
      now + 2
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-memory-group-beta-source',
      'chat.message.received',
      now + 3,
      'gateway',
      'qq',
      'group:group-beta',
      '{}',
      now + 3
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-group-beta-source',
      'raw-memory-group-beta-source',
      'platform-msg-group-beta-source',
      'group:group-beta',
      'group',
      'group-beta',
      'qq-user-alice',
      'Synthetic other-group memory source',
      now + 3
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-group-alpha-source',
      'raw-memory-group-alpha-source',
      'platform-msg-group-alpha-source',
      'group:group-alpha',
      'group',
      'group-alpha',
      'qq-user-alice',
      'Synthetic group memory source',
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-memory-test-source',
      'private:user-alice',
      'raw-memory-test-source',
      'mock',
      'mock',
      'completed',
      now
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-memory-test-source',
      'turn-memory-test-source',
      'memory.test',
      '{}',
      '{"ok":true}',
      'system',
      'user-alice',
      'system_worker',
      'private_chat',
      'success',
      0,
      now
    );
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at, started_at, completed_at, result
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'job-memory-test-source',
      'extraction',
      JSON.stringify({ sourceChatMessageId: 'msg-source-1' }),
      'completed',
      1,
      3,
      now,
      now,
      now,
      now,
      now,
      JSON.stringify({ sourceChatMessageId: 'msg-source-1' })
    );

    createMemory = (input) => repo.create({
      ...input,
      sources: input.sources ?? [
        {
          sourceType: 'raw_event',
          sourceId: 'raw-memory-test-source',
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
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('create and findById', () => {
    it('should create memory record', async () => {
      const id = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Favorite color',
        content: 'User likes blue',
        state: 'active',
        confidence: 0.9,
        importance: 0.7,
      });

      expect(id).toBeDefined();
      expect(id.length).toBeGreaterThan(0);
    });

    it.each([
      {
        id: 'memory-user-without-owner',
        boundary: { scope: 'user' as const },
        expectedError: /user scope requires canonicalUserId/,
      },
      {
        id: 'memory-group-without-owner',
        boundary: { scope: 'group' as const, conversationId: 'group:group-alpha' },
        expectedError: /group scope requires groupId/,
      },
      {
        id: 'memory-conversation-without-owner',
        boundary: { scope: 'conversation' as const, groupId: 'group-alpha' },
        expectedError: /conversation scope requires conversationId/,
      },
      {
        id: 'memory-global-with-user-owner',
        boundary: { scope: 'global' as const, canonicalUserId: 'user-alice' },
        expectedError: /global scope cannot set canonicalUserId/,
      },
      {
        id: 'memory-system-with-group-owner',
        boundary: { scope: 'system' as const, groupId: 'group-alpha' },
        expectedError: /system scope cannot set groupId/,
      },
      {
        id: 'memory-tool-with-conversation-owner',
        boundary: { scope: 'tool' as const, conversationId: 'private:user-alice' },
        expectedError: /tool scope cannot set conversationId/,
      },
    ])('rejects the invalid scope-owner boundary for $id atomically', async ({
      id,
      boundary,
      expectedError,
    }) => {
      await expect(
        createMemory({
          id,
          ...boundary,
          visibility: 'owner_admin_only',
          sensitivity: 'normal',
          authority: 'system',
          kind: 'fact',
          title: `Invalid owner boundary ${id}`,
          content: `Invalid owner boundary content ${id}`,
          state: 'proposed',
          confidence: 0.8,
          importance: 0.6,
          sourceContext: 'private_chat',
        }),
      ).rejects.toThrow(expectedError);

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
    });

    it.each([
      {
        id: 'memory-user-wrong-owner-source',
        boundary: {
          scope: 'user' as const,
          canonicalUserId: 'user-alice',
          visibility: 'private_only' as const,
        },
        sourceType: 'chat_message' as const,
        sourceId: 'msg-source-bob',
        expectedError: /source is incompatible with user memory boundary/,
      },
      {
        id: 'memory-user-private-from-group',
        boundary: {
          scope: 'user' as const,
          canonicalUserId: 'user-alice',
          visibility: 'private_only' as const,
        },
        sourceType: 'chat_message' as const,
        sourceId: 'msg-group-alpha-source',
        expectedError: /source is incompatible with user memory boundary/,
      },
      {
        id: 'memory-user-widened-from-group-with-false-context',
        boundary: {
          scope: 'user' as const,
          canonicalUserId: 'user-alice',
          visibility: 'same_user_any_context' as const,
        },
        sourceType: 'chat_message' as const,
        sourceId: 'msg-group-alpha-source',
        expectedError: /source is incompatible with user memory boundary/,
      },
      {
        id: 'memory-user-wrong-group-source',
        boundary: {
          scope: 'user' as const,
          canonicalUserId: 'user-alice',
          groupId: 'group-alpha',
          conversationId: 'group:group-alpha',
          visibility: 'same_group_only' as const,
        },
        sourceType: 'chat_message' as const,
        sourceId: 'msg-group-beta-source',
        expectedError: /source is incompatible with user memory boundary/,
      },
      {
        id: 'memory-group-wrong-group-source',
        boundary: {
          scope: 'group' as const,
          groupId: 'group-alpha',
          visibility: 'same_group_only' as const,
        },
        sourceType: 'chat_message' as const,
        sourceId: 'msg-group-beta-source',
        expectedError: /source is incompatible with group memory boundary/,
      },
      {
        id: 'memory-conversation-wrong-conversation-source',
        boundary: {
          scope: 'conversation' as const,
          conversationId: 'private:user-alice',
          visibility: 'private_only' as const,
        },
        sourceType: 'raw_event' as const,
        sourceId: 'raw-memory-bob-source',
        expectedError: /source is incompatible with conversation memory boundary/,
      },
      {
        id: 'memory-user-wrong-tool-actor',
        boundary: {
          scope: 'user' as const,
          canonicalUserId: 'user-bob',
          visibility: 'private_only' as const,
        },
        sourceType: 'tool_output' as const,
        sourceId: 'tool-memory-test-source',
        expectedError: /source is incompatible with user memory boundary/,
      },
    ])('rejects the incompatible source boundary for $id atomically', async ({
      id,
      boundary,
      sourceType,
      sourceId,
      expectedError,
    }) => {
      await expect(
        repo.create({
          id,
          ...boundary,
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: `Invalid source boundary ${id}`,
          content: `Invalid source boundary content ${id}`,
          state: 'active',
          confidence: 0.8,
          importance: 0.6,
          sourceContext: 'private_chat',
          sources: [{ sourceType, sourceId, extractedBy: 'worker' }],
        }),
      ).rejects.toThrow(expectedError);

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
    });

    it('rejects ambiguous raw-event evidence linked to mixed memory owners', async () => {
      db.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id, conversation_type,
          sender_id, text, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg-source-ambiguous-bob',
        'raw-memory-test-source',
        'platform-msg-source-ambiguous-bob',
        'private:user-alice',
        'private',
        'qq-user-bob',
        'Synthetic mixed-owner source',
        Date.now(),
      );

      await expect(
        repo.create({
          id: 'memory-ambiguous-raw-event-source',
          scope: 'user',
          canonicalUserId: 'user-alice',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Ambiguous raw-event source',
          content: 'Ambiguous raw-event source content',
          state: 'active',
          confidence: 0.8,
          importance: 0.6,
          sourceContext: 'private_chat',
          sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-test-source' }],
        }),
      ).rejects.toThrow(/source is incompatible with user memory boundary/);

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('treats group tool invocation evidence as group-derived when conversation type is unavailable', async () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'raw-memory-group-tool-source',
        'tool.invocation',
        now,
        'tool',
        'internal',
        'group:group-alpha',
        '{}',
        now,
      );
      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'turn-memory-group-tool-source',
        'group:group-alpha',
        'raw-memory-group-tool-source',
        'mock',
        'mock',
        'completed',
        now,
      );
      db.prepare(
        `INSERT INTO tool_calls (
          id, turn_id, tool_name, input, output, requested_by,
          actor_user_id, actor_class, invocation_context, status,
          secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'tool-memory-group-source',
        'turn-memory-group-tool-source',
        'memory.test',
        '{}',
        '{"ok":true}',
        'system',
        'user-alice',
        'system_worker',
        'group_chat',
        'success',
        0,
        now,
      );

      const widenedInput = {
        id: 'memory-user-widened-from-group-tool',
        scope: 'user' as const,
        canonicalUserId: 'user-alice',
        visibility: 'public' as const,
        sensitivity: 'normal' as const,
        authority: 'tool_derived' as const,
        kind: 'fact' as const,
        title: 'Group tool evidence with widened visibility',
        content: 'Group tool evidence must remain group-scoped',
        state: 'active' as const,
        confidence: 0.8,
        importance: 0.6,
        sourceContext: 'private_chat',
        sources: [{ sourceType: 'tool_output' as const, sourceId: 'tool-memory-group-source' }],
      };
      await expect(repo.create(widenedInput)).rejects.toThrow(
        /source is incompatible with user memory boundary/
      );

      const groupScopedId = await repo.create({
        ...widenedInput,
        id: 'memory-user-group-scoped-from-group-tool',
        conversationId: 'group:group-alpha',
        visibility: 'same_group_only',
      });

      expect((await repo.findById(groupScopedId))?.visibility).toBe('same_group_only');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('preserves complete evidence for matching group and conversation boundaries', async () => {
      const groupMemoryId = await repo.create({
        id: 'memory-valid-group-boundary',
        scope: 'group',
        groupId: 'group-alpha',
        conversationId: 'group:group-alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'summary',
        title: 'Valid group boundary',
        content: 'Valid group boundary content',
        state: 'active',
        confidence: 0.8,
        importance: 0.6,
        sourceContext: 'group_chat',
        sources: [{ sourceType: 'chat_message', sourceId: 'msg-group-alpha-source' }],
      });
      const conversationMemoryId = await repo.create({
        id: 'memory-valid-conversation-boundary',
        scope: 'conversation',
        conversationId: 'private:user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'summary',
        title: 'Valid conversation boundary',
        content: 'Valid conversation boundary content',
        state: 'active',
        confidence: 0.8,
        importance: 0.6,
        sourceContext: 'private_chat',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-test-source' }],
      });

      expect(
        db.prepare(
          `SELECT id, scope, group_id, conversation_id
             FROM memory_records
            WHERE id IN (?, ?)
            ORDER BY id`,
        ).all(groupMemoryId, conversationMemoryId),
      ).toEqual([
        {
          id: conversationMemoryId,
          scope: 'conversation',
          group_id: null,
          conversation_id: 'private:user-alice',
        },
        {
          id: groupMemoryId,
          scope: 'group',
          group_id: 'group-alpha',
          conversation_id: 'group:group-alpha',
        },
      ]);
      for (const memoryId of [groupMemoryId, conversationMemoryId]) {
        expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources WHERE memory_id = ?').get(memoryId))
          .toEqual({ count: 1 });
        expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get(memoryId))
          .toEqual({ count: 1 });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory' AND event_id = ?")
            .get(memoryId),
        ).toEqual({ count: 1 });
      }
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should create source, revision, audit, and FTS rows in the governed write path', async () => {
      const id = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Favorite editor',
        content: 'User likes NeovimUniqueTerm',
        state: 'active',
        confidence: 0.9,
        importance: 0.7,
        sourceContext: 'private_chat',
        sources: [
          {
            sourceType: 'chat_message',
            sourceId: 'msg-source-1',
            sourceTimestamp: 1234,
            extractedBy: 'worker',
          },
        ],
      });

      const sources = db
        .prepare('SELECT * FROM memory_sources WHERE memory_id = ?')
        .all(id) as any[];
      const revisions = db
        .prepare('SELECT * FROM memory_revisions WHERE memory_id = ?')
        .all(id) as any[];
      const auditRows = db
        .prepare("SELECT * FROM audit_log WHERE category = 'memory' AND event_id = ?")
        .all(id) as any[];
      const searchResults = await repo.search('NeovimUniqueTerm', {
        canonicalUserId: 'user-alice',
      });

      expect(sources).toHaveLength(1);
      expect(sources[0].source_type).toBe('chat_message');
      expect(sources[0].source_id).toBe('msg-source-1');
      expect(sources[0].resolution_state).toBe('internal');
      expect(sources[0].chat_message_id).toBe('msg-source-1');
      expect(revisions).toHaveLength(1);
      expect(revisions[0].change_type).toBe('create');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].event_type).toBe('memory.create');
      expect(searchResults.map((memory) => memory.id)).toContain(id);
    });

    it('persists canonical internal source references and explicit external command provenance', async () => {
      const internalId = await repo.create({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'fact',
        title: 'Canonical internal sources',
        content: 'This memory has tool and worker evidence',
        state: 'active',
        confidence: 0.8,
        importance: 0.6,
        sourceContext: 'background_worker',
        sources: [
          {
            sourceType: 'chat_message',
            sourceId: 'msg-source-1',
            extractedBy: 'worker',
          },
          {
            sourceType: 'tool_output',
            sourceId: 'tool-memory-test-source',
            extractedBy: 'worker',
          },
          {
            sourceType: 'worker_extraction',
            sourceId: 'job-memory-test-source',
            extractedBy: 'worker',
          },
        ],
      });
      const externalId = await repo.create({
        scope: 'system',
        visibility: 'owner_admin_only',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'procedure',
        title: 'Operator supplied procedure',
        content: 'A synthetic operator command supplied this procedure',
        state: 'proposed',
        confidence: 0.7,
        importance: 0.5,
        sourceContext: 'admin_cli:manual-entry',
        sources: [
          {
            sourceType: 'user_command',
            sourceId: 'external:user-command:test-entry',
            external: true,
            extractedBy: 'user',
          },
        ],
        actor: {
          actorClass: 'admin',
          context: 'admin_cli',
        },
      });

      const internalRows = db
        .prepare(
          `SELECT source_type, resolution_state, chat_message_id, tool_call_id, job_id
           FROM memory_sources
           WHERE memory_id = ?
           ORDER BY source_type`
        )
        .all(internalId);
      const externalRow = db
        .prepare(
          `SELECT resolution_state, raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
           FROM memory_sources
           WHERE memory_id = ?`
        )
        .get(externalId);

      expect(internalRows).toEqual([
        expect.objectContaining({
          source_type: 'chat_message',
          resolution_state: 'internal',
          chat_message_id: 'msg-source-1',
        }),
        expect.objectContaining({
          source_type: 'tool_output',
          resolution_state: 'internal',
          tool_call_id: 'tool-memory-test-source',
        }),
        expect.objectContaining({
          source_type: 'worker_extraction',
          resolution_state: 'internal',
          job_id: 'job-memory-test-source',
        }),
      ]);
      expect(externalRow).toEqual({
        resolution_state: 'external',
        raw_event_id: null,
        chat_message_id: null,
        tool_call_id: null,
        job_id: null,
        job_attempt_id: null,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects external downgrades and unsuccessful tool evidence atomically', async () => {
      db.prepare('UPDATE tool_calls SET status = ? WHERE id = ?')
        .run('error', 'tool-memory-test-source');

      const invalidSources = [
        {
          sourceContext: 'private_chat',
          sources: [
            {
              sourceType: 'raw_event' as const,
              sourceId: 'raw-memory-test-source',
              external: true,
            },
          ],
        },
        {
          sourceContext: 'admin_cli',
          sources: [
            {
              sourceType: 'user_command' as const,
              sourceId: 'external:user-command:not-explicit',
            },
          ],
          actor: {
            actorClass: 'admin' as const,
            context: 'admin_cli' as const,
          },
        },
        {
          sourceContext: 'private_chat',
          sources: [
            {
              sourceType: 'tool_output' as const,
              sourceId: 'tool-memory-test-source',
            },
          ],
        },
      ];

      for (const [index, sourceInput] of invalidSources.entries()) {
        await expect(
          repo.create({
            id: `memory-invalid-source-contract-${index}`,
            scope: 'user',
            canonicalUserId: 'user-alice',
            visibility: 'private_only',
            sensitivity: 'normal',
            authority: 'user_stated',
            kind: 'fact',
            title: `Invalid source contract ${index}`,
            content: `Invalid source contract ${index}`,
            state: 'active',
            confidence: 0.8,
            importance: 0.6,
            ...sourceInput,
          })
        ).rejects.toThrow(/memory source|user_command/);
      }

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rolls back record, source, revision, audit, and FTS rows when create audit insertion fails', async () => {
      const memoryId = 'memory-create-audit-rollback';
      const ftsTerm = 'LateCreateAuditRollbackTerm';
      db.exec(`
        CREATE TEMP TRIGGER fail_memory_create_audit
        BEFORE INSERT ON main.audit_log
        WHEN NEW.event_type = 'memory.create'
        BEGIN
          SELECT RAISE(ABORT, 'forced memory.create audit failure');
        END
      `);

      await expect(
        createMemory({
          id: memoryId,
          scope: 'user',
          canonicalUserId: 'user-alice',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Create audit rollback',
          content: `This memory contains ${ftsTerm}`,
          state: 'active',
          confidence: 0.8,
          importance: 0.6,
          sourceContext: 'private_chat',
          sources: [
            {
              sourceType: 'raw_event',
              sourceId: 'raw-memory-test-source',
              sourceTimestamp: 1234,
              extractedBy: 'worker',
            },
          ],
        })
      ).rejects.toThrow(/forced memory\.create audit failure/);

      expect(db.prepare('SELECT id FROM memory_records WHERE id = ?').all(memoryId)).toHaveLength(0);
      expect(db.prepare('SELECT memory_id FROM memory_sources WHERE memory_id = ?').all(memoryId)).toHaveLength(0);
      expect(db.prepare('SELECT memory_id FROM memory_revisions WHERE memory_id = ?').all(memoryId)).toHaveLength(0);
      expect(
        db
          .prepare("SELECT id FROM audit_log WHERE category = 'memory' AND event_id = ?")
          .all(memoryId)
      ).toHaveLength(0);
      expect(
        db.prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all(ftsTerm)
      ).toHaveLength(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects malformed explicit memory sources before durable memory rows are written', async () => {
      await expect(
        repo.create({
          scope: 'user',
          canonicalUserId: 'user-alice',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Malformed source',
          content: 'This memory should not be written',
          state: 'active',
          confidence: 0.8,
          importance: 0.6,
          sourceContext: 'private_chat',
          sources: [
            {
              sourceType: 'chat_message',
              sourceId: '   ',
              sourceTimestamp: 1234,
              extractedBy: 'worker',
            },
          ],
        }),
      ).rejects.toThrow(/sourceId/);

      await expect(
        repo.create({
          scope: 'user',
          canonicalUserId: 'user-alice',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Invalid timestamp source',
          content: 'This memory should not be written either',
          state: 'active',
          confidence: 0.8,
          importance: 0.6,
          sourceContext: 'private_chat',
          sources: [
            {
              sourceType: 'chat_message',
              sourceId: 'msg-invalid-timestamp',
              sourceTimestamp: new Date(Number.NaN),
              extractedBy: 'worker',
            },
          ],
        }),
      ).rejects.toThrow(/sourceTimestamp/);

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects missing and type-mismatched internal source identities atomically', async () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'source-id-in-wrong-table',
        'chat.message.received',
        now,
        'gateway',
        'qq',
        'private:user-alice',
        '{}',
        now
      );

      const invalidSources = [
        { sourceType: 'raw_event' as const, sourceId: 'missing-raw-event' },
        { sourceType: 'chat_message' as const, sourceId: 'source-id-in-wrong-table' },
        { sourceType: 'tool_output' as const, sourceId: 'source-id-in-wrong-table' },
      ];

      for (const [index, source] of invalidSources.entries()) {
        await expect(
          createMemory({
            id: `memory-invalid-source-${index}`,
            scope: 'user',
            canonicalUserId: 'user-alice',
            visibility: 'private_only',
            sensitivity: 'normal',
            authority: 'user_stated',
            kind: 'fact',
            title: `Invalid source ${index}`,
            content: `InvalidSourceIdentityTerm${index}`,
            state: 'active',
            confidence: 0.8,
            importance: 0.6,
            sourceContext: 'private_chat',
            sources: [
              {
                ...source,
                sourceTimestamp: now,
                extractedBy: 'worker',
              },
            ],
          })
        ).rejects.toThrow(/memory source/i);
      }

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH 'InvalidSourceIdentityTerm*'").get()
      ).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects worker-only and implicit fabricated provenance atomically', async () => {
      const baseInput = {
        scope: 'user' as const,
        canonicalUserId: 'user-alice',
        visibility: 'private_only' as const,
        sensitivity: 'normal' as const,
        authority: 'user_stated' as const,
        kind: 'fact' as const,
        state: 'active' as const,
        confidence: 0.8,
        importance: 0.6,
      };

      await expect(
        createMemory({
          ...baseInput,
          id: 'memory-worker-only-source',
          title: 'Worker-only source',
          content: 'WorkerOnlySourceTerm',
          sourceContext: 'background_worker',
          sources: [
            {
              sourceType: 'worker_extraction',
              sourceId: 'missing-worker-job',
              sourceTimestamp: Date.now(),
              extractedBy: 'worker',
            },
          ],
        })
      ).rejects.toThrow(/memory source/i);

      await expect(
        repo.create({
          ...baseInput,
          id: 'memory-implicit-source',
          title: 'Implicit source',
          content: 'ImplicitSourceFallbackTerm',
          sourceContext: 'private_chat',
        })
      ).rejects.toThrow(/explicit memory source/i);

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
      expect(
        db.prepare(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH 'WorkerOnlySourceTerm OR ImplicitSourceFallbackTerm'"
        ).get()
      ).toEqual({ count: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects blank implicit memory source context before durable memory rows are written', async () => {
      await expect(
        repo.create({
          scope: 'user',
          canonicalUserId: 'user-alice',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Blank implicit source',
          content: 'This memory should not be written',
          state: 'active',
          confidence: 0.8,
          importance: 0.6,
          sourceContext: '   ',
        }),
      ).rejects.toThrow(/explicit memory source/);

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects duplicate explicit memory source ids before durable memory rows are written', async () => {
      await expect(
        createMemory({
          scope: 'user',
          canonicalUserId: 'user-alice',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Duplicate source',
          content: 'This duplicate-source memory should not be written',
          state: 'active',
          confidence: 0.8,
          importance: 0.6,
          sourceContext: 'private_chat',
          sources: [
            {
              sourceType: 'chat_message',
              sourceId: 'msg-duplicate-source',
              sourceTimestamp: 1234,
              extractedBy: 'worker',
            },
            {
              sourceType: 'chat_message',
              sourceId: 'msg-duplicate-source',
              sourceTimestamp: 5678,
              extractedBy: 'worker',
            },
          ],
        }),
      ).rejects.toThrow(/duplicate sourceId/);

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects invalid memory expiration timestamps before durable memory rows are written', async () => {
      await expect(
        createMemory({
          scope: 'user',
          canonicalUserId: 'user-alice',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Invalid expiration',
          content: 'This invalid-expiration memory should not be written',
          state: 'active',
          confidence: 0.8,
          importance: 0.6,
          sourceContext: 'private_chat',
          expiresAt: new Date(Number.NaN),
        }),
      ).rejects.toThrow(/expiresAt/);

      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory'").get()).toEqual({
        count: 0,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('forces direct group-chat-derived user memory writes to group-only visibility', async () => {
      const id = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        groupId: 'group-alpha',
        conversationId: 'conv-group-alpha',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Group-only preference',
        content: 'User likes discussing TypeScript in this group',
        state: 'active',
        confidence: 0.9,
        importance: 0.7,
        sourceContext: 'group_chat:msg-group-alpha',
        sources: [
          {
            sourceType: 'raw_event',
            sourceId: 'raw-memory-group-alpha-source',
            sourceTimestamp: 1234,
            extractedBy: 'worker',
          },
        ],
      });

      const record = await repo.findById(id);
      const privateRetrieved = await repo.retrieve({
        canonicalUserId: 'user-alice',
        contextType: 'private',
      });
      const groupRetrieved = await repo.retrieve({
        canonicalUserId: 'user-alice',
        contextType: 'group',
        groupId: 'group-alpha',
      });
      const privateSearch = await repo.search('TypeScript', {
        canonicalUserId: 'user-alice',
        contextType: 'private',
      });
      const groupSearch = await repo.search('TypeScript', {
        canonicalUserId: 'user-alice',
        contextType: 'group',
        groupId: 'group-alpha',
      });
      const revision = db
        .prepare(
          `SELECT reason, new_state
           FROM memory_revisions
           WHERE memory_id = ? AND revision_number = 1`
        )
        .get(id) as { reason: string; new_state: string };
      const audit = db
        .prepare(
          `SELECT details
           FROM audit_log
           WHERE category = 'memory' AND event_id = ? AND event_type = 'memory.create'`
        )
        .get(id) as { details: string };

      expect(record?.visibility).toBe('same_group_only');
      expect(privateRetrieved.map((memory) => memory.id)).not.toContain(id);
      expect(privateSearch.map((memory) => memory.id)).not.toContain(id);
      expect(groupRetrieved.map((memory) => memory.id)).toContain(id);
      expect(groupSearch.map((memory) => memory.id)).toContain(id);
      expect(revision.reason).toContain('group-chat-derived user memory visibility forced to same_group_only');
      expect(JSON.parse(revision.new_state)).toMatchObject({ visibility: 'same_group_only' });
      expect(JSON.parse(audit.details)).toMatchObject({
        visibility: 'same_group_only',
        policyAdjustments: ['group-chat-derived user memory visibility forced to same_group_only'],
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should reject deterministic secret/prohibited memory content without writing rows', async () => {
      await expect(
        createMemory({
          scope: 'user',
          canonicalUserId: 'user-alice',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Temporary credential',
          content: 'password = hunter2',
          state: 'active',
          confidence: 0.9,
          importance: 0.7,
          sourceContext: 'private_chat',
        })
      ).rejects.toBeInstanceOf(MemoryPolicyError);

      const rows = db
        .prepare("SELECT * FROM memory_records WHERE title = 'Temporary credential'")
        .all();
      expect(rows).toHaveLength(0);
    });

    it('should find memory by ID', async () => {
      const id = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Test memory',
        content: 'Test content',
        state: 'active',
        confidence: 0.8,
        importance: 0.5,
      });

      const record = await repo.findById(id);

      expect(record).not.toBeNull();
      expect(record?.id).toBe(id);
      expect(record?.title).toBe('Test memory');
      expect(record?.content).toBe('Test content');
      expect(record?.canonicalUserId).toBe('user-alice');
      expect(record?.confidence).toBe(0.8);
    });

    it('should return null for non-existent ID', async () => {
      const record = await repo.findById('non-existent-id');
      expect(record).toBeNull();
    });
  });

  describe('retrieve with filters', () => {
    beforeEach(async () => {
      // 创建测试数据
      await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Private memory',
        content: 'Private content',
        state: 'active',
        confidence: 0.9,
        importance: 0.8,
      });

      await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Shared memory',
        content: 'Shared content',
        state: 'active',
        confidence: 0.85,
        importance: 0.7,
      });

      await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Deleted memory',
        content: 'Should not appear',
        state: 'deleted',
        confidence: 0.5,
        importance: 0.5,
      });
    });

    it('should retrieve active memories only', async () => {
      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.state === 'active')).toBe(true);
    });

    it('should filter by canonicalUserId', async () => {
      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });

      expect(results.every((r) => r.canonicalUserId === 'user-alice')).toBe(true);
    });

    it('should apply visibility filter for private context', async () => {
      const results = await repo.retrieve({
        canonicalUserId: 'user-alice',
        contextType: 'private',
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => ['private_only', 'same_user_any_context', 'public'].includes(r.visibility))).toBe(
        true
      );
    });

    it('should apply visibility filter for group context', async () => {
      const results = await repo.retrieve({
        canonicalUserId: 'user-alice',
        contextType: 'group',
      });

      // 只有 same_user_any_context，不包括 private_only
      expect(results).toHaveLength(1);
      expect(results[0].visibility).toBe('same_user_any_context');
      expect(results.every((r) => r.visibility !== 'private_only')).toBe(true);
    });

    it('applies visibility before limit for group retrieval', async () => {
      const results = await repo.retrieve({
        canonicalUserId: 'user-alice',
        contextType: 'group',
        limit: 1,
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Shared memory');
    });

    it('gates only exact-group summaries while policy is absent or disabled', async () => {
      const summaryId = await createMemory({
        scope: 'group',
        groupId: 'group-alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Alpha retained summary',
        content: 'Alpha retained summary content',
        state: 'active',
        confidence: 0.9,
        importance: 0.9,
        sourceContext: 'background_worker:summary',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-alpha-source' }],
      });
      const factId = await createMemory({
        scope: 'group',
        groupId: 'group-alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Alpha retained fact',
        content: 'Alpha retained fact content',
        state: 'active',
        confidence: 0.8,
        importance: 0.8,
        sourceContext: 'group_chat',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-alpha-source' }],
      });
      const betaSummaryId = await createMemory({
        scope: 'group',
        groupId: 'group-beta',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Beta retained summary',
        content: 'Beta retained summary content',
        state: 'active',
        confidence: 0.9,
        importance: 0.9,
        sourceContext: 'background_worker:summary',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-beta-source' }],
      });
      groupSummaryPolicies.setEnabled({
        groupId: 'group-beta',
        enabled: true,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-alice',
          invocationContext: 'admin_cli',
        },
      });

      const missingPolicy = await repo.retrieve({
        groupId: 'group-alpha',
        contextType: 'group',
      });
      expect(missingPolicy.map((memory) => memory.id)).toContain(factId);
      expect(missingPolicy.map((memory) => memory.id)).not.toContain(summaryId);
      expect((await repo.retrieve({
        groupId: 'group-beta',
        contextType: 'group',
      })).map((memory) => memory.id)).toEqual([betaSummaryId]);

      expect((await repo.retrieve({ groupId: 'group-alpha' })).map((memory) => memory.id))
        .toContain(summaryId);
      expect(await repo.findById(summaryId)).not.toBeNull();

      groupSummaryPolicies.setEnabled({
        groupId: 'group-alpha',
        enabled: true,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-alice',
          invocationContext: 'admin_cli',
        },
      });
      expect((await repo.retrieve({
        groupId: 'group-alpha',
        contextType: 'group',
      })).map((memory) => memory.id)).toEqual(expect.arrayContaining([summaryId, factId]));

      groupSummaryPolicies.setEnabled({
        groupId: 'group-alpha',
        enabled: false,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-alice',
          invocationContext: 'admin_cli',
        },
      });
      expect((await repo.retrieve({
        groupId: 'group-alpha',
        contextType: 'group',
      })).map((memory) => memory.id)).toEqual([factId]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rechecks group summary policy in the retrieval statement after a concurrent disable', async () => {
      const summaryId = await createMemory({
        scope: 'group',
        groupId: 'group-alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Racing retained summary',
        content: 'This summary must not survive a disable before retrieval executes',
        state: 'active',
        confidence: 0.9,
        importance: 0.9,
        sourceContext: 'background_worker:summary',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-alpha-source' }],
      });
      const factId = await createMemory({
        scope: 'group',
        groupId: 'group-alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Allowed group fact',
        content: 'This non-summary memory remains available',
        state: 'active',
        confidence: 0.8,
        importance: 0.8,
        sourceContext: 'group_chat',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-alpha-source' }],
      });
      groupSummaryPolicies.setEnabled({
        groupId: 'group-alpha',
        enabled: true,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-alice',
          invocationContext: 'admin_cli',
        },
      });

      const originalPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, 'prepare');
      let disabled = false;
      prepareSpy.mockImplementation((sql) => {
        const statement = originalPrepare(sql);
        if (!disabled && sql.includes('SELECT * FROM memory_records WHERE 1=1')) {
          disabled = true;
          groupSummaryPolicies.setEnabled({
            groupId: 'group-alpha',
            enabled: false,
            now: Date.now() + 1,
            authority: {
              kind: 'bot_owner',
              actorUserId: 'user-alice',
              invocationContext: 'admin_cli',
            },
          });
        }
        return statement;
      });

      try {
        const results = await repo.retrieve({
          groupId: 'group-alpha',
          contextType: 'group',
        });
        expect(disabled).toBe(true);
        expect(results.map((memory) => memory.id)).toContain(factId);
        expect(results.map((memory) => memory.id)).not.toContain(summaryId);
      } finally {
        prepareSpy.mockRestore();
      }
    });

    it('fails closed for group-summary retrieval without an exact current group', async () => {
      const summaryId = await createMemory({
        scope: 'group',
        groupId: 'group-alpha',
        conversationId: 'group:alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Enabled retained summary',
        content: 'Enabled summaries still require an exact current group',
        state: 'active',
        confidence: 0.9,
        importance: 0.9,
        sourceContext: 'background_worker:summary',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-alpha-source' }],
      });
      groupSummaryPolicies.setEnabled({
        groupId: 'group-alpha',
        enabled: true,
        authority: {
          kind: 'bot_owner',
          actorUserId: 'user-alice',
          invocationContext: 'admin_cli',
        },
      });

      expect((await repo.retrieve({
        conversationId: 'group:alpha',
        contextType: 'group',
      })).map((memory) => memory.id)).not.toContain(summaryId);
      expect((await repo.retrieve({
        conversationId: 'group:alpha',
        groupId: 'group-alpha',
        contextType: 'group',
      })).map((memory) => memory.id)).toContain(summaryId);
    });

    it('reports otherwise eligible exact-group summaries as bounded policy rejections', async () => {
      const firstId = await createMemory({
        scope: 'group',
        groupId: 'group-alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'First blocked summary',
        content: 'First blocked summary content',
        state: 'active',
        confidence: 0.9,
        importance: 0.9,
        sourceContext: 'background_worker:summary',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-alpha-source' }],
      });
      await createMemory({
        scope: 'group',
        groupId: 'group-alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'Second blocked summary',
        content: 'Second blocked summary content',
        state: 'active',
        confidence: 0.8,
        importance: 0.8,
        sourceContext: 'background_worker:summary',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-alpha-source' }],
      });

      await expect(repo.listPolicyBlockedGroupSummaryIds({
        groupId: 'group-alpha',
        contextType: 'group',
        limit: 1,
      })).resolves.toEqual([firstId]);
      await expect(repo.listPolicyBlockedGroupSummaryIds({
        groupId: 'group-beta',
        contextType: 'group',
      })).resolves.toEqual([]);
    });

    it('should respect limit parameter', async () => {
      const results = await repo.retrieve({
        canonicalUserId: 'user-alice',
        limit: 1,
      });

      expect(results).toHaveLength(1);
    });

    it('should order by importance DESC', async () => {
      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });

      expect(results[0].importance).toBeGreaterThanOrEqual(results[1].importance);
    });

    it('should exclude expired active memories from ordinary retrieval', async () => {
      const expiredId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Expired fact',
        content: 'Expired memory should not be retrieved',
        state: 'active',
        confidence: 0.8,
        importance: 0.9,
        sourceContext: 'private_chat',
        expiresAt: new Date(Date.now() - 1000),
      });

      const active = await repo.retrieve({ canonicalUserId: 'user-alice' });
      const activeInPrivate = await repo.retrieve({
        canonicalUserId: 'user-alice',
        contextType: 'private',
      });

      expect(active.map((memory) => memory.id)).not.toContain(expiredId);
      expect(activeInPrivate.map((memory) => memory.id)).not.toContain(expiredId);
    });
  });

  describe('state management', () => {
    let memoryId: string;

    beforeEach(async () => {
      memoryId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Test',
        content: 'Content',
        state: 'active',
        confidence: 0.5,
        importance: 0.5,
      });
    });

    it('should delete memory (soft delete)', async () => {
      await repo.delete(memoryId);

      const record = await repo.findById(memoryId);
      expect(record?.state).toBe('deleted');
    });

    it('should disable memory', async () => {
      await repo.disable(memoryId);

      const record = await repo.findById(memoryId);
      expect(record?.state).toBe('disabled');
    });

    it('preserves lifecycle state and evidence when disable audit insertion fails', async () => {
      const before = db
        .prepare(
          `SELECT state, updated_at, evaluator_decision_id
           FROM memory_records
           WHERE id = ?`
        )
        .get(memoryId) as {
          state: string;
          updated_at: number;
          evaluator_decision_id: string;
        };
      const beforeRevisionCount = db
        .prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?')
        .get(memoryId) as { count: number };
      const beforeAuditCount = db
        .prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory' AND event_id = ?")
        .get(memoryId) as { count: number };
      db.exec(`
        CREATE TEMP TRIGGER fail_memory_disable_audit
        BEFORE INSERT ON main.audit_log
        WHEN NEW.event_type = 'memory.disable'
        BEGIN
          SELECT RAISE(ABORT, 'forced memory.disable audit failure');
        END
      `);

      await expect(
        repo.disable(memoryId, {
          evaluatorDecisionId: 'decision-that-must-roll-back',
          reason: 'force a late transactional failure',
        })
      ).rejects.toThrow(/forced memory\.disable audit failure/);

      const after = db
        .prepare(
          `SELECT state, updated_at, evaluator_decision_id
           FROM memory_records
           WHERE id = ?`
        )
        .get(memoryId);
      const afterRevisionCount = db
        .prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?')
        .get(memoryId);
      const afterAuditCount = db
        .prepare("SELECT COUNT(*) AS count FROM audit_log WHERE category = 'memory' AND event_id = ?")
        .get(memoryId);

      expect(before.state).toBe('active');
      expect(beforeRevisionCount).toEqual({ count: 1 });
      expect(beforeAuditCount).toEqual({ count: 1 });
      expect(after).toEqual(before);
      expect(afterRevisionCount).toEqual(beforeRevisionCount);
      expect(afterAuditCount).toEqual(beforeAuditCount);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('deleted memories excluded from retrieval', async () => {
      await repo.delete(memoryId);

      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });
      expect(results.every((r) => r.id !== memoryId)).toBe(true);
    });

    it('disabled memories excluded from retrieval', async () => {
      await repo.disable(memoryId);

      const results = await repo.retrieve({ canonicalUserId: 'user-alice' });
      expect(results.every((r) => r.id !== memoryId)).toBe(true);
    });

    it('superseded memories excluded from retrieval and search', async () => {
      await repo.updateState(memoryId, 'superseded');

      const retrieved = await repo.retrieve({ canonicalUserId: 'user-alice' });
      const searched = await repo.search('Content', { canonicalUserId: 'user-alice' });

      expect(retrieved.every((r) => r.id !== memoryId)).toBe(true);
      expect(searched.every((r) => r.id !== memoryId)).toBe(true);
    });

    it('rejects lifecycle transitions back to proposed without durable mutation', async () => {
      await expect(repo.updateState(memoryId, 'proposed')).rejects.toThrow(/proposed/);

      const record = await repo.findById(memoryId);
      const revisions = db
        .prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
        .all(memoryId) as Array<{ change_type: string }>;
      const auditRows = db
        .prepare("SELECT event_type FROM audit_log WHERE category = 'memory' AND event_id = ? ORDER BY timestamp ASC")
        .all(memoryId) as Array<{ event_type: string }>;

      expect(record?.state).toBe('active');
      expect(revisions.map((row) => row.change_type)).toEqual(['create']);
      expect(auditRows.map((row) => row.event_type)).toEqual(['memory.create']);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('rejects invalid direct lifecycle transitions without durable mutation', async () => {
      await repo.disable(memoryId, { reason: 'operator disabled memory' });

      await expect(repo.supersede(memoryId)).rejects.toThrow(/invalid memory state transition/);
      await expect(repo.reject(memoryId)).rejects.toThrow(/proposed/);

      const record = await repo.findById(memoryId);
      const activeResults = await repo.retrieve({ canonicalUserId: 'user-alice' });
      const disabledResults = await repo.retrieve({
        canonicalUserId: 'user-alice',
        state: 'disabled',
      });
      const revisions = db
        .prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
        .all(memoryId) as Array<{ change_type: string }>;
      const auditRows = db
        .prepare("SELECT event_type FROM audit_log WHERE category = 'memory' AND event_id = ? ORDER BY timestamp ASC")
        .all(memoryId) as Array<{ event_type: string }>;

      expect(record?.state).toBe('disabled');
      expect(activeResults.map((memory) => memory.id)).not.toContain(memoryId);
      expect(disabledResults.map((memory) => memory.id)).toContain(memoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'disable']);
      expect(auditRows.map((row) => row.event_type)).toEqual(['memory.create', 'memory.disable']);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('state changes should create revision and audit rows', async () => {
      await repo.disable(memoryId, { reason: 'test disable' });
      await repo.delete(memoryId, { reason: 'test delete' });

      const revisions = db
        .prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
        .all(memoryId) as Array<{ change_type: string }>;
      const auditRows = db
        .prepare("SELECT event_type FROM audit_log WHERE category = 'memory' AND event_id = ? ORDER BY timestamp ASC")
        .all(memoryId) as Array<{ event_type: string }>;

      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'disable', 'delete']);
      expect(auditRows.map((row) => row.event_type)).toEqual([
        'memory.create',
        'memory.disable',
        'memory.delete',
      ]);
    });

    it('records local lifecycle authority without inheriting create-time policy evidence', async () => {
      const createDecisionId = `policy:l0:active:${memoryId}`;
      const disableDecisionId = `policy:l0:disabled:${memoryId}`;
      const restoreDecisionId = `policy:l0:active:${memoryId}`;
      const deleteDecisionId = `policy:l0:deleted:${memoryId}`;

      await repo.disable(memoryId, { reason: 'local disable decision' });
      await repo.restore(memoryId, { reason: 'local restore decision' });
      await repo.delete(memoryId, { reason: 'local delete decision' });

      const record = await repo.findById(memoryId);
      const revisions = db.prepare(
        `SELECT revision_number, change_type, previous_state, new_state, evaluator_decision_id
           FROM memory_revisions
          WHERE memory_id = ?
          ORDER BY revision_number ASC`
      ).all(memoryId) as Array<{
        revision_number: number;
        change_type: string;
        previous_state: string | null;
        new_state: string;
        evaluator_decision_id: string;
      }>;
      const auditRows = db.prepare(
        `SELECT event_type, evaluator_decision_id
           FROM audit_log
          WHERE category = 'memory' AND event_id = ?`
      ).all(memoryId) as Array<{
        event_type: string;
        evaluator_decision_id: string;
      }>;
      const auditDecisionByType = new Map(
        auditRows.map((row) => [row.event_type, row.evaluator_decision_id]),
      );

      expect(record).toMatchObject({
        state: 'deleted',
        evaluatorDecisionId: deleteDecisionId,
      });
      expect(revisions.map((row) => ({
        revisionNumber: row.revision_number,
        changeType: row.change_type,
        evaluatorDecisionId: row.evaluator_decision_id,
      }))).toEqual([
        { revisionNumber: 1, changeType: 'create', evaluatorDecisionId: createDecisionId },
        { revisionNumber: 2, changeType: 'disable', evaluatorDecisionId: disableDecisionId },
        { revisionNumber: 3, changeType: 'restore', evaluatorDecisionId: restoreDecisionId },
        { revisionNumber: 4, changeType: 'delete', evaluatorDecisionId: deleteDecisionId },
      ]);
      expect(JSON.parse(revisions[1].previous_state ?? '{}')).toMatchObject({
        state: 'active',
        evaluatorDecisionId: createDecisionId,
      });
      expect(JSON.parse(revisions[1].new_state)).toMatchObject({
        state: 'disabled',
        evaluatorDecisionId: disableDecisionId,
      });
      expect(auditDecisionByType).toEqual(new Map([
        ['memory.create', createDecisionId],
        ['memory.disable', disableDecisionId],
        ['memory.restore', restoreDecisionId],
        ['memory.delete', deleteDecisionId],
      ]));
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('redacts secret-like revision reasons before durable storage', async () => {
      const secret = 'sk-memoryrevisionabcdefghijklmnopqrstuvwxyz';
      const platformId = 'qq-723456789';

      await repo.disable(memoryId, { reason: `operator pasted ${secret} for ${platformId}` });

      const revision = db
        .prepare(
          `SELECT reason
           FROM memory_revisions
           WHERE memory_id = ? AND change_type = 'disable'`
        )
        .get(memoryId) as { reason: string };

      expect(revision.reason).toContain('[REDACTED:openai_like_api_key]');
      expect(revision.reason).toContain('[REDACTED:platform_id]');
      expect(revision.reason).not.toContain(secret);
      expect(revision.reason).not.toContain(platformId);
    });

    it('preserves platform markers for adjacent secret/platform revision and audit text', async () => {
      const adjacentSecretPlatform = 'sk-memoryrepo-adjacent-secret-qq-12345678901';

      await repo.disable(memoryId, {
        reason: `operator pasted ${adjacentSecretPlatform}`,
        auditSummary: `disable summary ${adjacentSecretPlatform}`,
        auditDetails: {
          reason: `disable detail ${adjacentSecretPlatform}`,
          nested: {
            value: adjacentSecretPlatform,
          },
        },
      });

      const revision = db
        .prepare(
          `SELECT reason
           FROM memory_revisions
           WHERE memory_id = ? AND change_type = 'disable'`
        )
        .get(memoryId) as { reason: string };
      const audit = db
        .prepare(
          `SELECT summary, details
           FROM audit_log
           WHERE category = 'memory' AND event_id = ? AND event_type = 'memory.disable'`
        )
        .get(memoryId) as { summary: string; details: string };
      const serialized = `${revision.reason}\n${audit.summary}\n${audit.details}`;

      expect(serialized).toContain('[REDACTED:openai_like_api_key]');
      expect(serialized).toContain('[REDACTED:platform_id]');
      expect(serialized).not.toContain(adjacentSecretPlatform);
      expect(serialized).not.toContain('qq-12345678901');
      expect(serialized).not.toContain('12345678901');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('preserves platform markers for assignment-shaped adjacent revision and audit text', async () => {
      const adjacentSecretPlatform = 'api_key=sk-memoryrepo-adjacent-secret-qq-12345678901';

      await repo.disable(memoryId, {
        reason: `operator pasted ${adjacentSecretPlatform}`,
        auditSummary: `disable summary ${adjacentSecretPlatform}`,
        auditDetails: {
          reason: `disable detail ${adjacentSecretPlatform}`,
          nested: {
            value: adjacentSecretPlatform,
          },
          [adjacentSecretPlatform]: 'dynamic key',
        },
      });

      const revision = db
        .prepare(
          `SELECT reason
           FROM memory_revisions
           WHERE memory_id = ? AND change_type = 'disable'`
        )
        .get(memoryId) as { reason: string };
      const audit = db
        .prepare(
          `SELECT summary, details
           FROM audit_log
           WHERE category = 'memory' AND event_id = ? AND event_type = 'memory.disable'`
        )
        .get(memoryId) as { summary: string; details: string };
      const serialized = `${revision.reason}\n${audit.summary}\n${audit.details}`;

      expect(serialized).toContain('[REDACTED:api_key_assignment]');
      expect(serialized).toContain('[REDACTED:platform_id]');
      expect(serialized).not.toContain(adjacentSecretPlatform);
      expect(serialized).not.toContain('sk-memoryrepo-adjacent-secret');
      expect(serialized).not.toContain('qq-12345678901');
      expect(serialized).not.toContain('12345678901');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should approve proposed memory with explicit approve revision', async () => {
      const proposedId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'preference',
        title: 'Proposal',
        content: 'Proposed content',
        state: 'proposed',
        confidence: 0.7,
        importance: 0.6,
      });

      await repo.approve(proposedId, { reason: 'admin approve proposal' });

      const record = await repo.findById(proposedId);
      const active = await repo.retrieve({ canonicalUserId: 'user-alice' });
      const revisions = db
        .prepare('SELECT change_type, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
        .all(proposedId) as Array<{ change_type: string; reason: string }>;

      expect(record?.state).toBe('active');
      expect(active.map((memory) => memory.id)).toContain(proposedId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'approve']);
      expect(revisions[1].reason).toBe('admin approve proposal');
    });

    it('should reject proposed memory and exclude it from retrieval', async () => {
      const proposedId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'fact',
        title: 'Rejectable proposal',
        content: 'Unverified content',
        state: 'proposed',
        confidence: 0.4,
        importance: 0.3,
      });

      await repo.reject(proposedId, { reason: 'admin reject proposal' });

      const record = await repo.findById(proposedId);
      const active = await repo.retrieve({ canonicalUserId: 'user-alice' });
      const rejected = await repo.retrieve({ canonicalUserId: 'user-alice', state: 'rejected' });
      const revisions = db
        .prepare('SELECT change_type, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
        .all(proposedId) as Array<{ change_type: string; reason: string }>;

      expect(record?.state).toBe('rejected');
      expect(active.map((memory) => memory.id)).not.toContain(proposedId);
      expect(rejected.map((memory) => memory.id)).toContain(proposedId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'reject']);
      expect(revisions[1].reason).toBe('admin reject proposal');
    });

    it('rejects approving or rejecting non-proposed memory without durable mutation', async () => {
      await expect(repo.approve(memoryId)).rejects.toThrow(/proposed/);
      await expect(repo.reject(memoryId)).rejects.toThrow(/proposed/);

      const record = await repo.findById(memoryId);
      const retrieved = await repo.retrieve({ canonicalUserId: 'user-alice' });
      const revisions = db
        .prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
        .all(memoryId) as Array<{ change_type: string }>;
      const auditRows = db
        .prepare("SELECT event_type FROM audit_log WHERE category = 'memory' AND event_id = ? ORDER BY timestamp ASC")
        .all(memoryId) as Array<{ event_type: string }>;

      expect(record?.state).toBe('active');
      expect(retrieved.map((memory) => memory.id)).toContain(memoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create']);
      expect(auditRows.map((row) => row.event_type)).toEqual(['memory.create']);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });
  });

  describe('full-text search', () => {
    beforeEach(async () => {
      await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Favorite color',
        content: 'User likes blue and green',
        state: 'active',
        confidence: 0.9,
        importance: 0.8,
      });

      await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Programming language',
        content: 'User knows TypeScript and Python',
        state: 'active',
        confidence: 0.85,
        importance: 0.7,
      });

      // Rebuild FTS index
      db.prepare("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')").run();
    });

    it('should search by content', async () => {
      const results = await repo.search('blue');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('blue');
    });

    it('should search by title', async () => {
      const results = await repo.search('color');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toContain('color');
    });

    it('should return empty for no match', async () => {
      const results = await repo.search('nonexistent');
      expect(results).toHaveLength(0);
    });

    it('uses stable IDs to order equal-rank FTS hits before applying the limit', async () => {
      const ids = Array.from(
        { length: 51 },
        (_, index) => `memory-equal-rank-${String(50 - index).padStart(2, '0')}`,
      );
      for (const id of ids) {
        await createMemory({
          id,
          scope: 'global',
          visibility: 'public',
          sensitivity: 'normal',
          authority: 'system',
          kind: 'fact',
          title: 'Equal rank',
          content: 'EqualRankSearchTerm',
          state: 'active',
          confidence: 0.8,
          importance: 0.5,
          sourceContext: 'admin_cli:synthetic-fts-order',
        });
      }

      const results = await repo.search('EqualRankSearchTerm', { limit: 50 });

      expect(results.map((memory) => memory.id)).toEqual(ids.slice().sort().slice(0, 50));
    });

    it('should only return active memories', async () => {
      const results = await repo.search('User');

      expect(results.every((r) => r.state === 'active')).toBe(true);
    });

    it('should enforce sensitivity, visibility, and state filters in search', async () => {
      const disabledId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Disabled searchable',
        content: 'SearchGovernanceTerm disabled',
        state: 'disabled',
        confidence: 0.8,
        importance: 0.5,
        sourceContext: 'private_chat',
      });

      await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Private searchable',
        content: 'SearchGovernanceTerm private only',
        state: 'active',
        confidence: 0.8,
        importance: 0.5,
        sourceContext: 'private_chat',
      });

      const now = Date.now();
      db.prepare(
        `INSERT INTO memory_records (
          id, scope, canonical_user_id, visibility, sensitivity, authority, kind,
          title, content, state, confidence, importance, source_context,
          evaluator_decision_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'legacy-secret',
        'user',
        'user-alice',
        'same_user_any_context',
        'secret',
        'user_stated',
        'fact',
        'Legacy secret',
        'SearchGovernanceTerm hidden',
        'active',
        0.9,
        0.7,
        'private_chat',
        'legacy',
        now,
        now
      );
      const legacyRow = db
        .prepare('SELECT rowid FROM memory_records WHERE id = ?')
        .get('legacy-secret') as { rowid: number };
      db.prepare('INSERT INTO memory_fts(rowid, title, content) VALUES (?, ?, ?)')
        .run(legacyRow.rowid, 'Legacy secret', 'SearchGovernanceTerm hidden');

      const groupResults = await repo.search('SearchGovernanceTerm', {
        canonicalUserId: 'user-alice',
        contextType: 'group',
      });
      const disabledResults = await repo.search('SearchGovernanceTerm', {
        canonicalUserId: 'user-alice',
        state: 'disabled',
      });

      expect(groupResults.every((memory) => memory.visibility !== 'private_only')).toBe(true);
      expect(groupResults.every((memory) => memory.sensitivity !== 'secret')).toBe(true);
      expect(groupResults.every((memory) => memory.state === 'active')).toBe(true);
      expect(disabledResults.map((memory) => memory.id)).toContain(disabledId);
    });

    it('applies visibility before limit for group search', async () => {
      const hiddenId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'private_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Hidden search limit memory',
        content: [
          'VisibilityLimitSearchTerm',
          'VisibilityLimitSearchTerm',
          'VisibilityLimitSearchTerm',
          'private only',
        ].join(' '),
        state: 'active',
        confidence: 0.8,
        importance: 0.9,
        sourceContext: 'private_chat',
      });
      const visibleId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Visible search limit memory',
        content: 'VisibilityLimitSearchTerm visible in group context',
        state: 'active',
        confidence: 0.8,
        importance: 0.6,
        sourceContext: 'private_chat',
      });

      const results = await repo.search('VisibilityLimitSearchTerm', {
        canonicalUserId: 'user-alice',
        contextType: 'group',
        limit: 1,
      });

      expect(results.map((memory) => memory.id)).toEqual([visibleId]);
      expect(results.map((memory) => memory.id)).not.toContain(hiddenId);
    });

    it('applies the disabled exact-group summary gate before FTS limit', async () => {
      const blockedSummaryId = await createMemory({
        scope: 'group',
        groupId: 'group-alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'tool_derived',
        kind: 'summary',
        title: 'PolicyGateSearchTerm summary',
        content: Array(12).fill('PolicyGateSearchTerm').join(' '),
        state: 'active',
        confidence: 0.9,
        importance: 1,
        sourceContext: 'background_worker:summary',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-alpha-source' }],
      });
      const allowedFactId = await createMemory({
        scope: 'group',
        groupId: 'group-alpha',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Allowed group fact',
        content: 'PolicyGateSearchTerm remains searchable',
        state: 'active',
        confidence: 0.8,
        importance: 0.5,
        sourceContext: 'group_chat',
        sources: [{ sourceType: 'raw_event', sourceId: 'raw-memory-group-alpha-source' }],
      });

      const results = await repo.search('PolicyGateSearchTerm', {
        groupId: 'group-alpha',
        contextType: 'group',
        limit: 1,
      });

      expect(results.map((memory) => memory.id)).toEqual([allowedFactId]);
      expect(results.map((memory) => memory.id)).not.toContain(blockedSummaryId);
      expect((await repo.search('PolicyGateSearchTerm', { groupId: 'group-alpha' }))
        .map((memory) => memory.id)).toContain(blockedSummaryId);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should exclude expired active memories from ordinary search', async () => {
      const expiredId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Expired searchable',
        content: 'ExpiredSearchTerm should not be searched',
        state: 'active',
        confidence: 0.8,
        importance: 0.9,
        sourceContext: 'private_chat',
        expiresAt: new Date(Date.now() - 1000),
      });
      const freshId = await createMemory({
        scope: 'user',
        canonicalUserId: 'user-alice',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'user_stated',
        kind: 'fact',
        title: 'Fresh searchable',
        content: 'ExpiredSearchTerm fresh result',
        state: 'active',
        confidence: 0.8,
        importance: 0.8,
        sourceContext: 'private_chat',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const results = await repo.search('ExpiredSearchTerm', {
        canonicalUserId: 'user-alice',
        contextType: 'private',
      });

      expect(results.map((memory) => memory.id)).not.toContain(expiredId);
      expect(results.map((memory) => memory.id)).toContain(freshId);
    });
  });
});
