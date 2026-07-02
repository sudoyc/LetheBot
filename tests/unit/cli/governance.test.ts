import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { IdentityRepository } from '../../../src/storage/identity-repository';
import { ContextBuilder } from '../../../src/context/builder';
import { GovernanceCLI } from '../../../src/cli/governance';

describe('GovernanceCLI', () => {
  let testDir: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let contextBuilder: ContextBuilder;
  let cli: GovernanceCLI;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    contextBuilder = new ContextBuilder(memoryRepo, identityRepo, db);
    cli = new GovernanceCLI(memoryRepo, { db, contextBuilder });

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
  });

  async function createMemory(overrides: Partial<Parameters<MemoryRepository['create']>[0]> = {}): Promise<string> {
    return memoryRepo.create({
      scope: 'user',
      visibility: 'private_only',
      sensitivity: 'normal',
      state: 'active',
      authority: 'user_stated',
      kind: 'preference',
      title: 'TypeScript preference',
      content: 'Alice prefers TypeScript',
      canonicalUserId: 'user-alice',
      confidence: 0.9,
      importance: 0.8,
      sourceContext: 'private_chat',
      ...overrides,
    });
  }

  function getRevisionRows(memoryId: string): Array<{ change_type: string; actor: string; reason: string | null }> {
    return db
      .prepare('SELECT change_type, actor, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(memoryId) as Array<{ change_type: string; actor: string; reason: string | null }>;
  }

  function getAuditRows(memoryId: string): Array<{
    event_type: string;
    actor_class: string | null;
    invocation_context: string | null;
    summary: string;
  }> {
    return db
      .prepare(
        `SELECT event_type, actor_class, invocation_context, summary
         FROM audit_log
         WHERE category = 'memory' AND event_id = ?
         ORDER BY timestamp ASC`
      )
      .all(memoryId) as Array<{
      event_type: string;
      actor_class: string | null;
      invocation_context: string | null;
      summary: string;
    }>;
  }

  afterEach(() => {
    if (db) {
      closeDatabase(db);
    }
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('listMemory', () => {
    it('should list all active memory', async () => {
      await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'user_stated',
        kind: 'preference',
        title: 'TypeScript preference',
        content: 'Alice prefers TypeScript',
        canonicalUserId: 'user-alice',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      await memoryRepo.create({
        scope: 'group',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'inferred',
        kind: 'summary',
        title: 'Rust discussion',
        content: 'Group dev discusses Rust',
        groupId: 'group-dev',
        confidence: 0.85,
        importance: 0.7,
        sourceContext: 'group_chat',
      });

      const result = await cli.listMemory({});
      expect(result).toHaveLength(2);
      expect(result[0].content).toContain('TypeScript');
      expect(result[1].content).toContain('Rust');
    });

    it('should filter by user', async () => {
      await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'user_stated',
        kind: 'preference',
        title: 'TypeScript preference',
        content: 'Alice prefers TypeScript',
        canonicalUserId: 'user-alice',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      const result = await cli.listMemory({ userId: 'user-alice' });
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('TypeScript');
    });

    it('should filter by state', async () => {
      await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        authority: 'user_stated',
        kind: 'preference',
        title: 'TypeScript preference',
        content: 'Alice prefers TypeScript',
        canonicalUserId: 'user-alice',
        confidence: 0.9,
        importance: 0.8,
        sourceContext: 'private_chat',
      });

      await memoryRepo.create({
        scope: 'user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'proposed',
        authority: 'inferred',
        kind: 'preference',
        title: 'Python preference',
        content: 'Bob prefers Python',
        canonicalUserId: 'user-bob',
        confidence: 0.7,
        importance: 0.6,
        sourceContext: 'private_chat',
      });

      const active = await cli.listMemory({ state: 'active' });
      expect(active).toHaveLength(1);

      const proposed = await cli.listMemory({ state: 'proposed' });
      expect(proposed).toHaveLength(1);
      expect(proposed[0].content).toContain('Python');
    });

    it('should filter by scope, sensitivity, and source metadata', async () => {
      const userMemoryId = await createMemory({
        id: 'mem-source-filter-user',
        sources: [
          {
            sourceType: 'chat_message',
            sourceId: 'msg-source-1',
            sourceTimestamp: Date.now(),
            extractedBy: 'worker',
          },
        ],
      });

      const groupMemoryId = await createMemory({
        id: 'mem-source-filter-group',
        scope: 'group',
        visibility: 'same_group_only',
        sensitivity: 'sensitive',
        authority: 'inferred',
        kind: 'summary',
        title: 'Group sensitive summary',
        content: 'Group discussed a sensitive but non-secret topic',
        canonicalUserId: undefined,
        groupId: 'group-dev',
        sourceContext: 'group_chat',
        sources: [
          {
            sourceType: 'chat_message',
            sourceId: 'msg-source-2',
            sourceTimestamp: Date.now(),
            extractedBy: 'worker',
          },
        ],
      });

      const groupScope = await cli.listMemory({ scope: 'group' });
      expect(groupScope.map((memory) => memory.id)).toEqual([groupMemoryId]);

      const sensitive = await cli.listMemory({ sensitivity: 'sensitive' });
      expect(sensitive.map((memory) => memory.id)).toEqual([groupMemoryId]);

      const sourceMatched = await cli.listMemory({
        sourceType: 'chat_message',
        sourceId: 'msg-source-1',
      });
      expect(sourceMatched.map((memory) => memory.id)).toEqual([userMemoryId]);

      const sourceContextMatched = await cli.listMemory({ sourceContext: 'group_chat' });
      expect(sourceContextMatched.map((memory) => memory.id)).toEqual([groupMemoryId]);
    });
  });

  describe('deleteMemory', () => {
    it('should mark memory as deleted', async () => {
      const memoryId = await createMemory();

      const result = await cli.deleteMemory(memoryId);
      expect(result.success).toBe(true);

      const memory = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });
      expect(memory).toHaveLength(0);

      const deleted = await memoryRepo.findById(memoryId);
      expect(deleted?.state).toBe('deleted');

      const revisions = getRevisionRows(memoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'delete']);
      expect(revisions[1]?.actor).toBe('admin');
      expect(revisions[1]?.reason).toBe('Governance CLI delete memory');

      const auditRows = getAuditRows(memoryId);
      const deleteAudit = auditRows.find((row) => row.event_type === 'memory.delete');
      expect(deleteAudit).toMatchObject({
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        summary: `Governance CLI deleted memory ${memoryId}`,
      });
    });

    it('should fail for nonexistent memory', async () => {
      const result = await cli.deleteMemory('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('disableMemory', () => {
    it('should mark memory as disabled', async () => {
      const memoryId = await createMemory();

      const result = await cli.disableMemory(memoryId);
      expect(result.success).toBe(true);

      const memory = await memoryRepo.retrieve({ canonicalUserId: 'user-alice', state: 'disabled' });
      expect(memory).toHaveLength(1);
      expect(memory[0].state).toBe('disabled');

      const active = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });
      expect(active).toHaveLength(0);

      const revisions = getRevisionRows(memoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'disable']);
      expect(revisions[1]?.actor).toBe('admin');

      const auditRows = getAuditRows(memoryId);
      const disableAudit = auditRows.find((row) => row.event_type === 'memory.disable');
      expect(disableAudit?.invocation_context).toBe('admin_cli');
    });
  });

  describe('enableMemory', () => {
    it('should restore disabled memory', async () => {
      const memoryId = await createMemory();

      await cli.disableMemory(memoryId);

      const result = await cli.enableMemory(memoryId);
      expect(result.success).toBe(true);

      const memory = await memoryRepo.retrieve({ canonicalUserId: 'user-alice', state: 'active' });
      expect(memory).toHaveLength(1);
      expect(memory[0].state).toBe('active');

      const revisions = getRevisionRows(memoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'disable', 'restore']);

      const auditRows = getAuditRows(memoryId);
      const restoreAudit = auditRows.find((row) => row.event_type === 'memory.restore');
      expect(restoreAudit).toMatchObject({
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        summary: `Governance CLI enabled memory ${memoryId}`,
      });
    });
  });

  describe('explainContext', () => {
    it('should rebuild context trace for a stored turn', async () => {
      const memoryId = await createMemory({
        visibility: 'same_user_any_context',
      });
      const now = Date.now();

      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('evt-why', 'message.private', now, 'gateway', 'qq', 'conv-why', '{}', now);

      db.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id, conversation_type,
          sender_id, text, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg-why',
        'evt-why',
        'platform-msg-why',
        'conv-why',
        'private',
        'user-alice',
        'Why did you remember TypeScript?',
        now
      );

      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, context_pack_id,
          pi_model, pi_provider, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'turn-why',
        'conv-why',
        'evt-why',
        'ctx-old',
        'mock-model',
        'mock-provider',
        'completed',
        now
      );

      const explanation = await cli.explainContext({ turnId: 'turn-why' });

      expect(explanation.turnId).toBe('turn-why');
      expect(explanation.traceSource).toBe('rebuilt');
      expect(explanation.conversation).toMatchObject({
        conversationId: 'conv-why',
        conversationType: 'private',
      });
      expect(explanation.selectedMemoryIds).toContain(memoryId);
      expect(explanation.candidateMemoryIds).toContain(memoryId);
      expect(explanation.filtersApplied).toContain('state=active');
      expect(explanation.recentMessageIds).toContain('msg-why');
      expect(explanation.memories.map((memory) => memory.memoryId)).toContain(memoryId);
    });
  });

  describe('redactDisplayProfile', () => {
    it('should redact display profile and nickname history with audit', async () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO display_profiles (
          canonical_user_id, source_group_id, current_display_name, observed_at, trust
        ) VALUES (?, ?, ?, ?, ?)`
      ).run('user-alice', '', 'Alice Original', now, 'platform_provided');

      db.prepare(
        `INSERT INTO nickname_history (
          id, canonical_user_id, source_group_id, display_name, observed_at
        ) VALUES (?, ?, ?, ?, ?)`
      ).run('nick-1', 'user-alice', '', 'Alice Old', now);

      const result = await cli.redactDisplayProfile({ canonicalUserId: 'user-alice' });
      expect(result.success).toBe(true);

      const display = db
        .prepare('SELECT current_display_name FROM display_profiles WHERE canonical_user_id = ?')
        .get('user-alice') as { current_display_name: string };
      const history = db
        .prepare('SELECT display_name, observed_until FROM nickname_history WHERE id = ?')
        .get('nick-1') as { display_name: string; observed_until: number | null };

      expect(display.current_display_name).toBe('[redacted]');
      expect(history.display_name).toBe('[redacted]');
      expect(history.observed_until).toBeTypeOf('number');

      const audit = db
        .prepare("SELECT * FROM audit_log WHERE category = 'system' AND event_type = 'display_profile.redact'")
        .get() as {
        actor_class: string;
        invocation_context: string;
        event_id: string;
      };

      expect(audit).toMatchObject({
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        event_id: 'user-alice:',
      });
    });
  });
});
