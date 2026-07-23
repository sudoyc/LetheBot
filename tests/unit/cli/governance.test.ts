import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { IdentityRepository } from '../../../src/storage/identity-repository';
import { JobRepository } from '../../../src/storage/job-repository';
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

    const sourceTimestamp = Date.now();
    for (const canonicalUserId of ['user-alice', 'user-bob']) {
      db.prepare(
        `INSERT INTO platform_accounts (
          platform, platform_account_id, canonical_user_id, account_type,
          verified_level, status, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'qq',
        canonicalUserId,
        canonicalUserId,
        'private',
        'observed',
        'active',
        sourceTimestamp,
        sourceTimestamp,
      );
    }
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-governance-source',
      'chat.message.received',
      sourceTimestamp,
      'gateway',
      'qq',
      'private:user-alice',
      '{}',
      sourceTimestamp
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'raw-governance-group-source',
      'chat.message.received',
      sourceTimestamp,
      'gateway',
      'qq',
      'group:group-dev',
      '{}',
      sourceTimestamp,
    );
    const insertSourceChatMessage = db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const sourceId of ['msg-source-1', 'msg-source-2', 'msg-show-1']) {
      const isGroupSource = sourceId === 'msg-source-2';
      insertSourceChatMessage.run(
        sourceId,
        isGroupSource ? 'raw-governance-group-source' : 'raw-governance-source',
        `platform-${sourceId}`,
        isGroupSource ? 'group:group-dev' : 'private:user-alice',
        isGroupSource ? 'group' : 'private',
        isGroupSource ? 'group-dev' : null,
        'user-alice',
        'fixture source',
        0,
        0,
        0,
        sourceTimestamp
      );
    }
  });

  async function createMemory(overrides: Partial<Parameters<MemoryRepository['create']>[0]> = {}): Promise<string> {
    const input: Parameters<MemoryRepository['create']>[0] = {
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
    };
    if (input.sources) {
      return memoryRepo.create(input);
    }

    const sourceTimestamp = Date.now();
    const sourceCount = db.prepare(
      "SELECT COUNT(*) AS count FROM chat_messages WHERE id LIKE 'msg-governance-memory-source-%'"
    ).get() as { count: number };
    const sourceIndex = sourceCount.count + 1;
    const rawEventId = `raw-governance-memory-source-${sourceIndex}`;
    const chatMessageId = `msg-governance-memory-source-${sourceIndex}`;
    const isGroupSource = input.scope === 'group'
      || input.visibility === 'same_group_only'
      || (input.scope === 'conversation' && input.groupId !== undefined);
    const senderId = input.scope === 'user'
      ? (input.canonicalUserId ?? 'user-alice')
      : 'user-alice';
    const conversationId = input.conversationId
      ?? (isGroupSource
        ? `group:${input.groupId ?? 'governance-source'}`
        : `private:${senderId}`);

    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rawEventId,
      'chat.message.received',
      sourceTimestamp,
      'gateway',
      'qq',
      conversationId,
      '{}',
      sourceTimestamp,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chatMessageId,
      rawEventId,
      `platform-${chatMessageId}`,
      conversationId,
      isGroupSource ? 'group' : 'private',
      isGroupSource ? (input.groupId ?? null) : null,
      senderId,
      'Synthetic governance memory provenance',
      sourceTimestamp,
    );

    return memoryRepo.create({
      ...input,
      sources: [
        {
          sourceType: 'chat_message',
          sourceId: chatMessageId,
          sourceTimestamp,
          extractedBy: 'evaluator',
        },
      ],
    });
  }

  function getRevisionRows(memoryId: string): Array<{ change_type: string; actor: string; reason: string | null }> {
    return db
      .prepare('SELECT change_type, actor, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(memoryId) as Array<{ change_type: string; actor: string; reason: string | null }>;
  }

  function getAuditRows(memoryId: string): Array<{
    event_type: string;
    actor_user_id: string | null;
    actor_class: string | null;
    invocation_context: string | null;
    summary: string;
    details: string | null;
  }> {
    return db
      .prepare(
        `SELECT event_type, actor_user_id, actor_class, invocation_context, summary, details
         FROM audit_log
         WHERE category = 'memory' AND event_id = ?
         ORDER BY timestamp ASC`
      )
      .all(memoryId) as Array<{
      event_type: string;
      actor_user_id: string | null;
      actor_class: string | null;
      invocation_context: string | null;
      summary: string;
      details: string | null;
    }>;
  }

  function insertMemoryReviewAudit(
    auditId: string,
    eventType: 'memory.conflict.detected' | 'memory.consolidation.candidates_detected',
    memoryIds: string[],
    options: { summary?: string; extraDetails?: Record<string, unknown> } = {}
  ): string {
    const now = Date.now();
    const details = eventType === 'memory.conflict.detected'
      ? {
        conflicts: [
          {
            memoryIds,
            titleHash: 'review-title-hash',
          },
        ],
        redaction: 'memory_ids_and_title_hashes_only',
        ...(options.extraDetails ?? {}),
      }
      : {
        groups: [
          {
            memoryIds,
            titleHash: 'review-title-hash',
            contentHash: 'review-content-hash',
          },
        ],
        redaction: 'memory_ids_title_hashes_content_hashes_and_counts_only',
        ...(options.extraDetails ?? {}),
      };

    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      auditId,
      now,
      'memory',
      'redacted_full',
      eventType,
      `job-${auditId}`,
      'system_worker',
      'background_worker',
      options.summary ?? 'Review worker detected memory candidates',
      JSON.stringify(details),
      1,
      'medium'
    );

    return auditId;
  }

  function insertMemoryDecayReviewAudit(
    auditId: string,
    memoryIds: string[],
    options: { summary?: string; extraDetails?: Record<string, unknown> } = {}
  ): string {
    const now = Date.now();
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      auditId,
      now,
      'memory',
      'redacted_full',
      'memory.decay.candidates_detected',
      `job-${auditId}`,
      'system_worker',
      'background_worker',
      options.summary ?? 'Decay worker detected stale low-score candidates',
      JSON.stringify({
        candidates: memoryIds.map((memoryId) => ({
          memoryId,
          titleHash: `title-hash-${memoryId}`,
          confidence: 0.4,
          importance: 0.2,
          reasons: ['stale', 'low_confidence', 'low_importance'],
        })),
        redaction: 'memory_ids_title_hashes_scores_and_reasons_only',
        ...(options.extraDetails ?? {}),
      }),
      1,
      'medium'
    );

    return auditId;
  }

  function insertTurnForInspection(turnId = 'turn-inspect'): string {
    const now = Date.now();
    const eventId = `evt-${turnId}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(eventId, 'message.private', now, 'gateway', 'qq', `conv-${turnId}`, '{}', now);

    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(turnId, `conv-${turnId}`, eventId, `ctx-${turnId}`, 'mock-model', 'mock-provider', 'completed', now);

    return turnId;
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
      await createMemory({
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

      await createMemory({
        scope: 'group',
        canonicalUserId: undefined,
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
      await createMemory({
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
      await createMemory({
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

      await createMemory({
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
      expect(result).toEqual({
        success: true,
        message: `Memory ${memoryId} deleted`,
      });

      const memory = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });
      expect(memory).toHaveLength(0);

      const deleted = await memoryRepo.findById(memoryId);
      expect(deleted?.state).toBe('deleted');

      const revisions = getRevisionRows(memoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'delete']);
      expect(revisions[1]?.actor).toBe('local_admin');
      expect(revisions[1]?.reason).toBe('Governance CLI delete memory');

      const auditRows = getAuditRows(memoryId);
      const deleteAudit = auditRows.find((row) => row.event_type === 'memory.delete');
      expect(deleteAudit).toMatchObject({
        actor_user_id: 'local_admin',
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        summary: `Governance CLI deleted memory ${memoryId}`,
      });
      expect(JSON.parse(deleteAudit?.details ?? '{}')).toMatchObject({
        governanceActor: 'local_admin',
      });
    });

    it('should fail for nonexistent memory', async () => {
      const result = await cli.deleteMemory('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('bounds and redacts caller-controlled memory IDs in command results', async () => {
      const platformLike = await cli.deleteMemory('missing-12345');
      const hostileId = `${'x'.repeat(129)}\n\u001b[31mqq-123456789`;
      const hostile = await cli.deleteMemory(hostileId);

      expect(platformLike).toEqual({
        success: false,
        error: 'Memory [redacted-id] not found',
      });
      expect(hostile).toEqual({
        success: false,
        error: 'Memory [redacted-id] not found',
      });
      expect(hostile.error).not.toContain('\n');
      expect(hostile.error).not.toContain('\u001b');
      expect(hostile.error).not.toContain('123456789');
    });

    it('redacts a successful 5-digit memory ID from display and durable audit bodies', async () => {
      const memoryId = await createMemory({ id: '12345' });

      expect(await cli.deleteMemory(memoryId)).toEqual({
        success: true,
        message: 'Memory [redacted-id] deleted',
      });
      const audit = db.prepare(
        `SELECT event_id, summary, details
           FROM audit_log
          WHERE event_type = 'memory.delete' AND event_id = ?`,
      ).get(memoryId) as { event_id: string; summary: string; details: string };
      const auditBody = `${audit.summary}\n${audit.details}`;
      expect(audit.event_id).toBe(memoryId);
      expect(audit.summary).toBe('Governance CLI deleted memory [redacted-id]');
      expect(JSON.parse(audit.details)).toMatchObject({ memoryId: '[redacted-id]' });
      expect(auditBody).not.toContain(memoryId);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('projects a successful hostile memory ID out of deletion audit bodies', async () => {
      const memoryId = `${'x'.repeat(129)}\n\u001b[31mqq-123456789`;
      await createMemory({ id: memoryId });

      expect(await cli.deleteMemory(memoryId)).toEqual({
        success: true,
        message: 'Memory [redacted-id] deleted',
      });
      const audit = db.prepare(
        `SELECT event_id, summary, details
           FROM audit_log
          WHERE event_type = 'memory.delete' AND event_id = ?`,
      ).get(memoryId) as { event_id: string; summary: string; details: string };
      const details = JSON.parse(audit.details) as {
        memoryId: string;
        policyDecision: string;
      };
      expect(audit.event_id).toBe(memoryId);
      expect(audit.summary).toBe('Governance CLI deleted memory [redacted-id]');
      expect(details.memoryId).toBe('[redacted-id]');
      expect(details.policyDecision).toMatch(/^policy:l0:deleted:sha256:[0-9a-f]{64}$/);
      expect(audit.summary).not.toContain('\u001b');
      expect(audit.details).not.toContain('123456789');
      expect(audit.details).not.toContain('x'.repeat(129));
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
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

    it('should disable active memory through explicit decay review approval', async () => {
      const memoryId = await createMemory({
        title: 'Old low score preference',
        content: 'Alice used to prefer an old low score option',
        confidence: 0.4,
        importance: 0.2,
      });
      const decayReviewAuditId = insertMemoryDecayReviewAudit('audit-decay-disable', [memoryId]);

      const result = await cli.disableMemory(memoryId, { decayReviewAuditId });

      expect(result.success).toBe(true);
      expect((await memoryRepo.findById(memoryId))?.state).toBe('disabled');
      expect(await memoryRepo.retrieve({ canonicalUserId: 'user-alice' })).toHaveLength(0);

      const revisions = getRevisionRows(memoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'disable']);
      expect(revisions[1]?.reason).toBe(`Governance CLI disable memory from decay review ${decayReviewAuditId}`);

      const auditRows = getAuditRows(memoryId);
      const disableAudit = auditRows.find((row) => row.event_type === 'memory.disable');
      expect(disableAudit).toBeDefined();
      if (!disableAudit) {
        throw new Error('Expected decay disable audit row');
      }
      expect(disableAudit.summary).toBe(
        `Governance CLI disabled memory ${memoryId} from decay review ${decayReviewAuditId}`
      );
      expect(JSON.parse(disableAudit.details ?? '{}') as Record<string, unknown>).toMatchObject({
        memoryId,
        previousState: 'active',
        newState: 'disabled',
        decayReviewAuditId,
        reviewEventType: 'memory.decay.candidates_detected',
        governedDecayApproval: true,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should reject decay-reviewed disable when audit does not reference the memory', async () => {
      const memoryId = await createMemory({
        title: 'Decay mismatch target',
        content: 'Alice has a target memory',
      });
      const unrelatedMemoryId = await createMemory({
        title: 'Decay mismatch unrelated',
        content: 'Alice has an unrelated memory',
      });
      const decayReviewAuditId = insertMemoryDecayReviewAudit('audit-decay-mismatch', [unrelatedMemoryId]);

      const result = await cli.disableMemory(memoryId, { decayReviewAuditId });

      expect(result).toMatchObject({
        success: false,
        error: `Decay review audit ${decayReviewAuditId} does not reference memory ${memoryId}`,
      });
      expect((await memoryRepo.findById(memoryId))?.state).toBe('active');
      expect(getRevisionRows(memoryId).map((row) => row.change_type)).toEqual(['create']);
      expect(getAuditRows(memoryId).map((row) => row.event_type)).not.toContain('memory.disable');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
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

    it('should restore deleted memory through the governance restore alias', async () => {
      const memoryId = await createMemory();

      await cli.deleteMemory(memoryId);
      const result = await cli.restoreMemory(memoryId);

      expect(result.success).toBe(true);

      const memory = await memoryRepo.findById(memoryId);
      const revisions = getRevisionRows(memoryId);

      expect(memory?.state).toBe('active');
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'delete', 'restore']);
    });
  });

  describe('proposal lifecycle commands', () => {
    it('should approve proposed memory and record audit/revision rows', async () => {
      const memoryId = await createMemory({
        state: 'proposed',
        authority: 'inferred',
        title: 'Proposal',
        content: 'Alice may prefer Go',
      });

      const result = await cli.approveMemory(memoryId);

      expect(result.success).toBe(true);
      expect((await memoryRepo.findById(memoryId))?.state).toBe('active');

      const revisions = getRevisionRows(memoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'approve']);
      expect(revisions[1]?.actor).toBe('admin');
      expect(revisions[1]?.reason).toBe('Governance CLI approve memory proposal');

      const auditRows = getAuditRows(memoryId);
      expect(auditRows.find((row) => row.event_type === 'memory.approve')).toMatchObject({
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        summary: `Governance CLI approved memory ${memoryId}`,
      });
    });

    it('should reject proposed memory and keep it out of active retrieval', async () => {
      const memoryId = await createMemory({
        state: 'proposed',
        authority: 'inferred',
        title: 'Rejected proposal',
        content: 'Alice may prefer Java',
      });

      const result = await cli.rejectMemory(memoryId);

      expect(result.success).toBe(true);
      expect((await memoryRepo.findById(memoryId))?.state).toBe('rejected');

      const active = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });
      const rejected = await cli.listMemory({ state: 'rejected', userId: 'user-alice' });
      const revisions = getRevisionRows(memoryId);

      expect(active.map((memory) => memory.id)).not.toContain(memoryId);
      expect(rejected.map((memory) => memory.id)).toContain(memoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'reject']);
      expect(getAuditRows(memoryId).find((row) => row.event_type === 'memory.reject')).toMatchObject({
        actor_class: 'admin',
        invocation_context: 'admin_cli',
      });
    });

    it('should supersede an active memory with another memory', async () => {
      const oldMemoryId = await createMemory({
        title: 'Old preference',
        content: 'Alice prefers TypeScript 4',
      });
      const newMemoryId = await createMemory({
        title: 'New preference',
        content: 'Alice prefers TypeScript 5',
      });

      const result = await cli.supersedeMemory(oldMemoryId, newMemoryId);

      expect(result.success).toBe(true);
      expect((await memoryRepo.findById(oldMemoryId))?.state).toBe('superseded');

      const active = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });
      const revisions = getRevisionRows(oldMemoryId);

      expect(active.map((memory) => memory.id)).not.toContain(oldMemoryId);
      expect(active.map((memory) => memory.id)).toContain(newMemoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'supersede']);
      expect(revisions[1]?.reason).toBe(`Governance CLI supersede memory with ${newMemoryId}`);
    });

    it('should approve a reviewed supersede with revision, audit details, and clean FK state', async () => {
      const oldMemoryId = await createMemory({
        title: 'TypeScript version preference',
        content: 'Alice prefers TypeScript 4',
      });
      const replacementMemoryId = await createMemory({
        title: 'TypeScript version preference',
        content: 'Alice prefers TypeScript 5',
      });
      const reviewAuditId = insertMemoryReviewAudit(
        'audit-reviewed-supersede',
        'memory.conflict.detected',
        [oldMemoryId, replacementMemoryId]
      );

      const result = await cli.supersedeMemory(oldMemoryId, replacementMemoryId, { reviewAuditId });

      expect(result.success).toBe(true);
      expect((await memoryRepo.findById(oldMemoryId))?.state).toBe('superseded');
      expect((await memoryRepo.findById(replacementMemoryId))?.state).toBe('active');

      const active = await memoryRepo.retrieve({ canonicalUserId: 'user-alice' });
      const revisions = getRevisionRows(oldMemoryId);
      const auditRows = getAuditRows(oldMemoryId);
      const supersedeAudit = auditRows.find((row) => row.event_type === 'memory.supersede');

      expect(active.map((memory) => memory.id)).not.toContain(oldMemoryId);
      expect(active.map((memory) => memory.id)).toContain(replacementMemoryId);
      expect(revisions.map((row) => row.change_type)).toEqual(['create', 'supersede']);
      expect(revisions[1]?.reason).toBe(
        `Governance CLI supersede memory with ${replacementMemoryId} reviewed by ${reviewAuditId}`
      );
      expect(supersedeAudit).toBeDefined();
      if (!supersedeAudit) {
        throw new Error('Expected supersede audit row');
      }
      expect(supersedeAudit.summary).toBe(
        `Governance CLI superseded memory ${oldMemoryId} by ${replacementMemoryId} reviewed by ${reviewAuditId}`
      );

      const auditDetails = JSON.parse(supersedeAudit.details ?? '{}') as Record<string, unknown>;
      expect(auditDetails).toMatchObject({
        memoryId: oldMemoryId,
        replacementMemoryId,
        reviewAuditId,
        reviewEventType: 'memory.conflict.detected',
        governedReviewApproval: true,
        previousState: 'active',
        newState: 'superseded',
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should reject supersede across owner, scope, or kind boundaries without mutation', async () => {
      const oldMemoryId = await createMemory({
        title: 'Boundary old',
        content: 'Alice prefers one thing',
      });
      const differentOwnerId = await createMemory({
        canonicalUserId: 'user-bob',
        title: 'Boundary different owner',
        content: 'Bob prefers something else',
      });
      const differentScopeId = await createMemory({
        scope: 'group',
        canonicalUserId: undefined,
        groupId: 'group-dev',
        visibility: 'same_group_only',
        title: 'Boundary different scope',
        content: 'Group prefers something else',
      });
      const differentKindId = await createMemory({
        kind: 'fact',
        title: 'Boundary different kind',
        content: 'Alice has a fact',
      });

      const ownerResult = await cli.supersedeMemory(oldMemoryId, differentOwnerId);
      const scopeResult = await cli.supersedeMemory(oldMemoryId, differentScopeId);
      const kindResult = await cli.supersedeMemory(oldMemoryId, differentKindId);

      expect(ownerResult).toMatchObject({
        success: false,
        error: 'Cannot supersede memory across different canonicalUserId boundaries',
      });
      expect(scopeResult).toMatchObject({
        success: false,
        error: 'Cannot supersede memory across different scope boundaries',
      });
      expect(kindResult).toMatchObject({
        success: false,
        error: 'Cannot supersede memory across different kind boundaries',
      });
      expect((await memoryRepo.findById(oldMemoryId))?.state).toBe('active');
      expect(getRevisionRows(oldMemoryId).map((row) => row.change_type)).toEqual(['create']);
      expect(getAuditRows(oldMemoryId).map((row) => row.event_type)).not.toContain('memory.supersede');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should reject reviewed supersede when the review audit does not reference both memories', async () => {
      const oldMemoryId = await createMemory({
        title: 'Review mismatch old',
        content: 'Alice prefers one review target',
      });
      const replacementMemoryId = await createMemory({
        title: 'Review mismatch replacement',
        content: 'Alice prefers another review target',
      });
      const reviewAuditId = insertMemoryReviewAudit(
        'audit-review-mismatch',
        'memory.consolidation.candidates_detected',
        [oldMemoryId, 'mem-unrelated']
      );

      const result = await cli.supersedeMemory(oldMemoryId, replacementMemoryId, { reviewAuditId });

      expect(result).toMatchObject({
        success: false,
        error: `Review audit ${reviewAuditId} does not reference both memory records`,
      });
      expect((await memoryRepo.findById(oldMemoryId))?.state).toBe('active');
      expect((await memoryRepo.findById(replacementMemoryId))?.state).toBe('active');
      expect(getRevisionRows(oldMemoryId).map((row) => row.change_type)).toEqual(['create']);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });
  });

  describe('memory review candidate inspection', () => {
    it('should list redacted conflict and consolidation review candidates and filter by memory id', async () => {
      const oldMemoryId = await createMemory({
        title: 'Review list old',
        content: 'Alice prefers old review list behavior',
      });
      const replacementMemoryId = await createMemory({
        title: 'Review list replacement',
        content: 'Alice prefers new review list behavior',
      });
      const unrelatedMemoryId = await createMemory({
        title: 'Review list unrelated',
        content: 'Alice has unrelated review content',
      });
      const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';

      insertMemoryReviewAudit(
        'audit-review-list-conflict',
        'memory.conflict.detected',
        [oldMemoryId, replacementMemoryId],
        {
          summary: `Review summary contains token ${secret}`,
          extraDetails: {
            note: `details contain api_key=${secret}`,
          },
        }
      );
      insertMemoryReviewAudit(
        'audit-review-list-consolidation',
        'memory.consolidation.candidates_detected',
        [unrelatedMemoryId, 'mem-other']
      );

      const filtered = await cli.listMemoryReviewCandidates({
        memoryId: oldMemoryId,
        includeDetails: true,
      });
      const all = await cli.listMemoryReviewCandidates({ limit: 10 });

      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toMatchObject({
        auditId: 'audit-review-list-conflict',
        eventType: 'memory.conflict.detected',
        status: 'unresolved',
        candidateCount: 1,
        memoryIdGroups: [[oldMemoryId, replacementMemoryId]],
        resolutionAuditIds: [],
        supersededMemoryIds: [],
        replacementMemoryIds: [],
        disabledMemoryIds: [],
      });
      expect(JSON.stringify(filtered)).not.toContain(secret);
      expect(JSON.stringify(filtered)).toContain('[REDACTED');
      expect(all.map((candidate) => candidate.auditId)).toEqual(
        expect.arrayContaining([
          'audit-review-list-consolidation',
          'audit-review-list-conflict',
        ])
      );
      expect(all[0]?.details).toBeUndefined();

      const unresolvedBefore = await cli.listMemoryReviewCandidates({ status: 'unresolved' });
      expect(unresolvedBefore.map((candidate) => candidate.auditId)).toEqual(
        expect.arrayContaining([
          'audit-review-list-consolidation',
          'audit-review-list-conflict',
        ])
      );

      const approval = await cli.supersedeMemory(oldMemoryId, replacementMemoryId, {
        reviewAuditId: 'audit-review-list-conflict',
      });
      expect(approval.success).toBe(true);

      const resolved = await cli.listMemoryReviewCandidates({ status: 'resolved' });
      const unresolvedAfter = await cli.listMemoryReviewCandidates({ status: 'unresolved' });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
          auditId: 'audit-review-list-conflict',
          status: 'resolved',
          supersededMemoryIds: [oldMemoryId],
          replacementMemoryIds: [replacementMemoryId],
          disabledMemoryIds: [],
      });
      expect(resolved[0]?.resolutionAuditIds).toHaveLength(1);
      expect(unresolvedAfter.map((candidate) => candidate.auditId)).toContain('audit-review-list-consolidation');
      expect(unresolvedAfter.map((candidate) => candidate.auditId)).not.toContain('audit-review-list-conflict');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should list decay review candidates and mark them resolved after governed disable', async () => {
      const memoryId = await createMemory({
        title: 'Decay review list target',
        content: 'Alice has a stale low-score review-list memory',
        confidence: 0.4,
        importance: 0.2,
      });
      const decayReviewAuditId = insertMemoryDecayReviewAudit('audit-decay-review-list', [memoryId]);

      const unresolved = await cli.listMemoryReviewCandidates({
        eventType: 'memory.decay.candidates_detected',
        memoryId,
        status: 'unresolved',
        includeDetails: true,
      });

      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({
        auditId: decayReviewAuditId,
        eventType: 'memory.decay.candidates_detected',
        status: 'unresolved',
        candidateCount: 1,
        memoryIdGroups: [[memoryId]],
        resolutionAuditIds: [],
        supersededMemoryIds: [],
        replacementMemoryIds: [],
        disabledMemoryIds: [],
      });

      const disable = await cli.disableMemory(memoryId, { decayReviewAuditId });
      expect(disable.success).toBe(true);

      const resolved = await cli.listMemoryReviewCandidates({
        eventType: 'memory.decay.candidates_detected',
        memoryId,
        status: 'resolved',
      });
      const unresolvedAfter = await cli.listMemoryReviewCandidates({
        eventType: 'memory.decay.candidates_detected',
        memoryId,
        status: 'unresolved',
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        auditId: decayReviewAuditId,
        status: 'resolved',
        supersededMemoryIds: [],
        replacementMemoryIds: [],
        disabledMemoryIds: [memoryId],
      });
      expect(resolved[0]?.resolutionAuditIds).toHaveLength(1);
      expect(unresolvedAfter).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should summarize review candidates by event type and resolution status without leaking details', async () => {
      const oldMemoryId = await createMemory({
        title: 'Review summary old',
        content: 'Alice prefers the old review summary value',
      });
      const replacementMemoryId = await createMemory({
        title: 'Review summary replacement',
        content: 'Alice prefers the new review summary value',
      });
      const duplicateMemoryId = await createMemory({
        title: 'Review summary duplicate',
        content: 'Alice has duplicate review summary content',
      });
      const duplicatePeerMemoryId = await createMemory({
        title: 'Review summary duplicate peer',
        content: 'Alice has duplicate review summary content',
      });
      const decayMemoryId = await createMemory({
        title: 'Review summary decay',
        content: 'Alice has a stale review summary memory',
        confidence: 0.4,
        importance: 0.2,
      });
      const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';

      const conflictAuditId = insertMemoryReviewAudit(
        'audit-review-summary-conflict',
        'memory.conflict.detected',
        [oldMemoryId, replacementMemoryId],
        {
          summary: `conflict summary includes ${secret}`,
          extraDetails: {
            note: `conflict detail includes api_key=${secret}`,
          },
        }
      );
      insertMemoryReviewAudit(
        'audit-review-summary-consolidation',
        'memory.consolidation.candidates_detected',
        [duplicateMemoryId, duplicatePeerMemoryId]
      );
      const decayAuditId = insertMemoryDecayReviewAudit('audit-review-summary-decay', [decayMemoryId]);

      expect((await cli.supersedeMemory(oldMemoryId, replacementMemoryId, {
        reviewAuditId: conflictAuditId,
      })).success).toBe(true);
      expect((await cli.disableMemory(decayMemoryId, { decayReviewAuditId: decayAuditId })).success).toBe(true);

      const summary = await cli.summarizeMemoryReviews();

      expect(summary).toMatchObject({
        filters: {
          status: 'all',
        },
        total: 3,
        resolved: 2,
        unresolved: 1,
        candidateGroups: 3,
        memoryReferences: 5,
        resolutionAuditCount: 2,
        supersededMemoryCount: 1,
        replacementMemoryCount: 1,
        disabledMemoryCount: 1,
      });
      expect(summary.generatedAt).toBeInstanceOf(Date);
      expect(summary.byEventType).toEqual([
        expect.objectContaining({
          eventType: 'memory.conflict.detected',
          total: 1,
          resolved: 1,
          unresolved: 0,
          memoryReferences: 2,
          supersededMemoryCount: 1,
          replacementMemoryCount: 1,
        }),
        expect.objectContaining({
          eventType: 'memory.consolidation.candidates_detected',
          total: 1,
          resolved: 0,
          unresolved: 1,
          memoryReferences: 2,
        }),
        expect.objectContaining({
          eventType: 'memory.decay.candidates_detected',
          total: 1,
          resolved: 1,
          unresolved: 0,
          memoryReferences: 1,
          disabledMemoryCount: 1,
        }),
      ]);
      expect(JSON.stringify(summary)).not.toContain(secret);

      const unresolvedSummary = await cli.summarizeMemoryReviews({ status: 'unresolved' });
      expect(unresolvedSummary).toMatchObject({
        total: 1,
        resolved: 0,
        unresolved: 1,
        candidateGroups: 1,
        memoryReferences: 2,
      });
      expect(unresolvedSummary.byEventType.find(
        (row) => row.eventType === 'memory.consolidation.candidates_detected'
      )).toMatchObject({
        total: 1,
        unresolved: 1,
      });

      const memoryFilteredSummary = await cli.summarizeMemoryReviews({ memoryId: oldMemoryId });
      expect(memoryFilteredSummary).toMatchObject({
        total: 1,
        resolved: 1,
        unresolved: 0,
        candidateGroups: 1,
        memoryReferences: 2,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });
  });

  describe('inspection and export commands', () => {
    it('should show memory with sources, revisions, and redacted audit evidence', async () => {
      const memoryId = await createMemory({
        sources: [
          {
            sourceType: 'chat_message',
            sourceId: 'msg-show-1',
            sourceTimestamp: Date.now(),
            extractedBy: 'worker',
          },
        ],
      });

      const result = await cli.showMemory(memoryId);

      expect(result?.record.id).toBe(memoryId);
      expect(result?.sources).toEqual([
        expect.objectContaining({
          memoryId,
          sourceType: 'chat_message',
          sourceId: 'msg-show-1',
          extractedBy: 'worker',
        }),
      ]);
      expect(result?.revisions.map((revision) => revision.changeType)).toEqual(['create']);
      expect(result?.audit).toEqual([
        expect.objectContaining({
          category: 'memory',
          eventType: 'memory.create',
          eventId: memoryId,
          details: undefined,
          detailsRedacted: true,
        }),
      ]);
    });

    it('should export only visible active memory by default', async () => {
      const activeId = await createMemory({
        id: 'mem-export-active',
        visibility: 'same_user_any_context',
      });
      const disabledId = await createMemory({
        id: 'mem-export-disabled',
        content: 'Alice used to prefer CoffeeScript',
      });
      const proposedId = await createMemory({
        id: 'mem-export-proposed',
        state: 'proposed',
        content: 'Alice may prefer Zig',
      });

      await cli.disableMemory(disabledId);

      const exported = await cli.exportMemory({ userId: 'user-alice' });

      expect(exported.map((memory) => memory.id)).toEqual([activeId]);
      expect(exported.map((memory) => memory.id)).not.toContain(disabledId);
      expect(exported.map((memory) => memory.id)).not.toContain(proposedId);
      expect(exported[0]).toMatchObject({
        state: 'active',
        sensitivity: 'normal',
        content: 'Alice prefers TypeScript',
      });
    });

    it('should inspect audit rows with details hidden by default and redacted when included', async () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_user_id, actor_class, invocation_context,
          summary, details, redacted, risk_level, evaluator_decision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'audit-secret-1',
        now,
        'tool',
        'full',
        'tool.execute',
        'tool-call-secret',
        'user-alice',
        'user',
        'private_chat',
        'Tool summary password=supersecret',
        JSON.stringify({
          nested: {
            token: 'token=abcdefghijklmnop',
          },
        }),
        0,
        'high',
        null
      );

      const hidden = await cli.listAudit({ category: 'tool' });
      expect(hidden).toHaveLength(1);
      expect(hidden[0].summary).toContain('[REDACTED:password_assignment]');
      expect(hidden[0].details).toBeUndefined();
      expect(hidden[0].detailsRedacted).toBe(true);

      const included = await cli.listAudit({ category: 'tool', includeDetails: true });
      const serialized = JSON.stringify(included[0]);

      expect(serialized).toContain('[REDACTED:token_assignment]');
      expect(serialized).not.toContain('abcdefghijklmnop');
      expect(serialized).not.toContain('supersecret');
    });

    it('should inspect action decisions, executions, and tool calls with redacted payloads', async () => {
      const turnId = insertTurnForInspection('turn-action-tool-inspect');
      const now = Date.now();

      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, evaluator_passed,
          actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-inspect',
        turnId,
        'pi',
        'medium',
        0.88,
        1,
        1,
        JSON.stringify([
          {
            type: 'reply_full',
            priority: 1,
            constraints: { redactionLevel: 'strict' },
            payload: { text: 'Do not echo password=actionsecret' },
            reason: 'User asked a question',
          },
        ]),
        JSON.stringify(['Sensitive reason token=reasonsecret123']),
        JSON.stringify(['cooldown']),
        now
      );

      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts, created_at, updated_at, scheduled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('job-qq-123456789', 'admin_digest', '{}', 'pending', 0, 2, now, now, now);

      db.prepare(
        `INSERT INTO memory_records (
          id, scope, visibility, sensitivity, authority, kind, title, content,
          state, confidence, importance, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'mem-qq-987654321',
        'global',
        'owner_admin_only',
        'normal',
        'inferred',
        'summary',
        'Governance action memory',
        'Action execution created proposed memory',
        'proposed',
        0.8,
        0.5,
        now,
        now
      );

      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status,
          executed_message_id, executed_memory_id, executed_job_id, downgraded_from, downgraded_reason,
          error_code, error_message, audit_level, audit_entry, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'execution-inspect',
        'decision-inspect',
        'admin_digest',
        'success',
        'msg-out-1',
        'mem-qq-987654321',
        'job-qq-123456789',
        null,
        null,
        null,
        null,
        'redacted_full',
        'audit password=executionsecret',
        now + 1
      );

      db.prepare(
        `INSERT INTO tool_calls (
          id, turn_id, tool_name, input, output,
          requested_by, actor_user_id, actor_class, invocation_context,
          status, error_code, error_message, execution_time_ms,
          secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'tool-inspect',
        turnId,
        'read_local_file',
        JSON.stringify({ prompt: 'password=toolinputsecret' }),
        JSON.stringify({ text: 'token=tooloutputsecret123' }),
        'pi',
        'user-alice',
        'user',
        'private_chat',
        'success',
        null,
        null,
        12,
        0,
        now + 2
      );

      const decisions = await cli.listActionDecisions({ turnId, includeActions: true });
      const executions = await cli.listActionExecutions({
        actionDecisionId: 'decision-inspect',
        includeAuditEntry: true,
      });
      const toolCallsWithoutPayload = await cli.listToolCalls({ turnId });
      const toolCallsWithPayload = await cli.listToolCalls({ turnId, includePayload: true });

      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        id: 'decision-inspect',
        actionCount: 1,
        evaluatorRequired: true,
        evaluatorPassed: true,
      });
      expect(JSON.stringify(decisions[0])).not.toContain('actionsecret');
      expect(JSON.stringify(decisions[0])).not.toContain('reasonsecret123');

      expect(executions[0]).toMatchObject({
        id: 'execution-inspect',
        status: 'success',
        executedMemoryId: 'mem-[REDACTED:platform_id]',
        executedJobId: 'job-[REDACTED:platform_id]',
        auditEntry: 'audit [REDACTED:password_assignment]',
      });
      expect(JSON.stringify(executions[0])).not.toContain('job-qq-123456789');
      expect(JSON.stringify(executions[0])).not.toContain('mem-qq-987654321');

      expect(toolCallsWithoutPayload[0].input).toBeUndefined();
      expect(toolCallsWithoutPayload[0].output).toBeUndefined();
      expect(JSON.stringify(toolCallsWithPayload[0])).toContain('[REDACTED:password_assignment]');
      expect(JSON.stringify(toolCallsWithPayload[0])).toContain('[REDACTED:token_assignment]');
      expect(JSON.stringify(toolCallsWithPayload[0])).not.toContain('toolinputsecret');
      expect(JSON.stringify(toolCallsWithPayload[0])).not.toContain('tooloutputsecret123');
    });

    it('should inspect jobs, attempts, and worker heartbeats with redacted details', async () => {
      const jobRepo = new JobRepository(db);
      const now = Date.now();
      const jobId = jobRepo.enqueue({
        id: 'job-inspect',
        type: 'summary',
        payload: { prompt: 'password=jobpayloadsecret' },
        idempotencyKey: 'summary:conv-inspect',
        now,
      });
      const claimed = jobRepo.claimNext({ workerId: 'worker-inspect', now: now + 1 });
      if (!claimed) {
        throw new Error('Expected job to be claimed');
      }

      jobRepo.complete({
        jobId,
        attemptId: claimed.attemptId,
        result: { output: 'token=jobresultsecret123' },
        now: now + 2,
      });
      jobRepo.heartbeat({
        workerId: 'worker-inspect',
        workerType: 'background',
        status: 'idle',
        details: { apiKey: 'api_key=heartbeatsecret' },
        now: now + 3,
      });

      const jobsHidden = await cli.listJobs({ type: 'summary' });
      const jobsIncluded = await cli.listJobs({ type: 'summary', includePayload: true });
      const attempts = await cli.listJobAttempts({ jobId, includeResult: true });
      const heartbeats = await cli.listWorkerHeartbeats({
        workerId: 'worker-inspect',
        includeDetails: true,
      });

      expect(jobsHidden).toHaveLength(1);
      expect(jobsHidden[0].payload).toBeUndefined();
      expect(jobsHidden[0].result).toBeUndefined();

      const serializedJob = JSON.stringify(jobsIncluded[0]);
      const serializedAttempt = JSON.stringify(attempts[0]);
      const serializedHeartbeat = JSON.stringify(heartbeats[0]);

      expect(serializedJob).toContain('[REDACTED:password_assignment]');
      expect(serializedJob).toContain('[REDACTED:token_assignment]');
      expect(serializedJob).not.toContain('jobpayloadsecret');
      expect(serializedJob).not.toContain('jobresultsecret123');
      expect(attempts[0]).toMatchObject({
        jobId,
        attemptNumber: 1,
        workerId: 'worker-inspect',
        status: 'completed',
      });
      expect(serializedAttempt).toContain('[REDACTED:token_assignment]');
      expect(serializedHeartbeat).toContain('[REDACTED:api_key_assignment]');
      expect(serializedHeartbeat).not.toContain('heartbeatsecret');
    });

    it('should summarize governance health with aggregate redacted counts only', async () => {
      const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
      const now = Date.now();
      const oldMemoryId = await createMemory({
        title: 'Health review old',
        content: 'Alice has an old health review value',
      });
      const replacementMemoryId = await createMemory({
        title: 'Health review replacement',
        content: 'Alice has a new health review value',
      });
      const decayMemoryId = await createMemory({
        title: 'Health decay target',
        content: 'Alice has stale health review content',
        confidence: 0.4,
        importance: 0.2,
      });
      const decayAuditId = insertMemoryDecayReviewAudit('audit-health-decay', [decayMemoryId]);

      insertMemoryReviewAudit(
        'audit-health-conflict',
        'memory.conflict.detected',
        [oldMemoryId, replacementMemoryId],
        {
          extraDetails: {
            note: `review detail token=${secret}`,
          },
        }
      );
      expect((await cli.disableMemory(decayMemoryId, { decayReviewAuditId: decayAuditId })).success).toBe(true);

      const turnId = insertTurnForInspection('turn-health-summary');
      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-health-summary',
        turnId,
        'evaluator',
        'high',
        0.7,
        1,
        0,
        JSON.stringify([{ type: 'reply_full', payload: { text: `secret ${secret}` } }]),
        JSON.stringify([`reason contains ${secret}`]),
        JSON.stringify([]),
        now
      );
      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status,
          error_code, error_message, audit_level, audit_entry, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'execution-health-summary',
        'decision-health-summary',
        'reply_full',
        'failed',
        'SEND_FAILED',
        `error token=${secret}`,
        'summary',
        `audit token=${secret}`,
        now + 1
      );
      db.prepare(
        `INSERT INTO tool_calls (
          id, turn_id, tool_name, input, output,
          requested_by, actor_user_id, actor_class, invocation_context,
          status, error_code, error_message, execution_time_ms,
          secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'tool-health-summary',
        turnId,
        'read_local_file',
        JSON.stringify({ token: secret }),
        JSON.stringify({ text: `api_key=${secret}` }),
        'pi',
        'user-alice',
        'user',
        'private_chat',
        'error',
        'TOOL_FAILED',
        `tool error ${secret}`,
        7,
        1,
        now + 2
      );
      db.prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_user_id, actor_class, invocation_context, summary,
          details, redacted, risk_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'audit-health-secret-event',
        now + 3,
        'tool',
        'full',
        `tool.${secret}.event`,
        'tool-health-summary',
        'user-alice',
        'user',
        'private_chat',
        `summary ${secret}`,
        JSON.stringify({ output: secret }),
        0,
        'high'
      );

      const jobRepo = new JobRepository(db);
      jobRepo.enqueue({
        id: 'job-health-summary',
        type: 'summary',
        payload: { prompt: `token=${secret}` },
        maxAttempts: 1,
        now,
      });
      const claimed = jobRepo.claimNext({ workerId: 'worker-health-summary', now: now + 4 });
      if (!claimed) {
        throw new Error('Expected health summary job to be claimed');
      }
      jobRepo.fail({
        jobId: 'job-health-summary',
        attemptId: claimed.attemptId,
        error: `job failed with token=${secret}`,
        now: now + 5,
      });
      jobRepo.heartbeat({
        workerId: 'worker-health-summary',
        workerType: 'background',
        status: 'error',
        currentJobId: 'job-health-summary',
        details: { token: secret },
        now: now + 6,
      });
      jobRepo.enqueue({
        id: 'job-health-expired-running',
        type: 'retention',
        payload: { prompt: `token=${secret}` },
        maxAttempts: 3,
        now: 0,
      });
      const expiredClaimed = jobRepo.claimNext({
        workerId: 'worker-health-expired-running',
        now: 1,
        leaseMs: 1,
      });
      if (!expiredClaimed) {
        throw new Error('Expected expired running health summary job to be claimed');
      }

      const summary = await cli.summarizeGovernanceHealth();
      const serialized = JSON.stringify(summary);

      expect(summary).toMatchObject({
        memoryReviews: {
          total: 2,
          resolved: 1,
          unresolved: 1,
        },
        actions: {
          decisions: {
            total: 1,
            evaluatorRequired: 1,
            evaluatorRejected: 1,
            byDecidedBy: {
              evaluator: 1,
            },
            byRiskLevel: {
              high: 1,
            },
          },
          executions: {
            total: 1,
            failedOrRejected: 1,
            byStatus: {
              failed: 1,
            },
            byActionType: {
              reply_full: 1,
            },
          },
        },
        tools: {
          total: 1,
          secretsRedacted: 1,
          failedOrRejected: 1,
          byStatus: {
            error: 1,
          },
        },
        jobs: {
          total: 2,
          running: 1,
          failed: 1,
          expiredRunningLeases: 1,
          byStatus: {
            failed: 1,
            running: 1,
          },
          byType: {
            summary: 1,
            retention: 1,
          },
        },
        workerHeartbeats: {
          total: 1,
          error: 1,
          byStatus: {
            error: 1,
          },
          byWorkerType: {
            background: 1,
          },
        },
        attention: {
          unresolvedMemoryReviews: 1,
          failedJobs: 1,
          expiredRunningLeases: 1,
          errorWorkerHeartbeats: 1,
          failedOrRejectedActions: 1,
          failedOrRejectedToolCalls: 1,
        },
      });
      expect(summary.generatedAt).toBeInstanceOf(Date);
      expect(summary.workerHeartbeats.latestHeartbeatAt).toBeInstanceOf(Date);
      expect(summary.audit.highRisk).toBe(1);
      expect(Object.keys(summary.audit.byEventType).some(
        (eventType) => eventType.includes('[REDACTED:openai_like_api_key]')
      )).toBe(true);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain('[REDACTED');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
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
      expect(explanation.memorySelections).toContainEqual(expect.objectContaining({
        memoryId,
        retrievalMethods: expect.arrayContaining(['scoped_rank', 'fts']),
        selectionReason: 'query_match',
      }));
    });

    it('should prefer stored context trace when available', async () => {
      const now = Date.now();

      db.prepare(
        `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('evt-stored-why', 'message.private', now, 'gateway', 'qq', 'conv-stored-why', '{}', now);

      db.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id, conversation_type,
          sender_id, text, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg-stored-why',
        'evt-stored-why',
        'platform-stored-why',
        'conv-stored-why',
        'private',
        'user-bob',
        'Explain stored trace',
        now
      );

      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, context_pack_id,
          pi_model, pi_provider, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'turn-stored-why',
        'conv-stored-why',
        'evt-stored-why',
        'ctx-stored-why',
        'mock-model',
        'mock-provider',
        'completed',
        now
      );

      db.prepare(
        `INSERT INTO context_traces (
          id, turn_id, conversation_id, conversation_type, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'ctx-stored-why',
        'turn-stored-why',
        'conv-stored-why',
        'private',
        null,
        JSON.stringify(['mem-candidate']),
        JSON.stringify(['mem-selected']),
        JSON.stringify([{ memoryId: 'mem-rejected', reason: 'private_only_in_group_context' }]),
        JSON.stringify(['state=active', 'visibility_scope_filter']),
        JSON.stringify(['conversation_id', 'target_user_ref']),
        JSON.stringify(['msg-stored-why']),
        JSON.stringify({
          max: 8000,
          used: 321,
          breakdown: { recentMessages: 21, memory: 100, identity: 0, system: 200 },
        }),
        JSON.stringify([
          {
            memoryId: 'mem-selected',
            scope: 'user',
            kind: 'fact',
            title: 'Stored trace memory',
            sourceContext: 'test',
          },
        ]),
        now
      );

      const explanation = await cli.explainContext({ turnId: 'turn-stored-why' });

      expect(explanation.traceSource).toBe('stored');
      expect(explanation.contextPackId).toBe('ctx-stored-why');
      expect(explanation.selectedMemoryIds).toEqual(['mem-selected']);
      expect(explanation.candidateMemoryIds).toEqual(['mem-candidate']);
      expect(explanation.rejectedMemories).toEqual([
        { memoryId: 'mem-rejected', reason: 'private_only_in_group_context' },
      ]);
      expect(explanation.recentMessageIds).toEqual(['msg-stored-why']);
      expect(explanation.tokenBudget.used).toBe(321);
      expect(explanation.memorySelections).toBeUndefined();
      expect(explanation.memories).toEqual([
        {
          memoryId: 'mem-selected',
          scope: 'user',
          kind: 'fact',
          title: 'Stored trace memory',
          sourceContext: 'test',
        },
      ]);
    });
  });

  describe('platform account unlink', () => {
    it('should atomically disable an active mapping and insert a redacted identity audit row', async () => {
      const platformAccountId = '1234567890';
      const now = Date.now();
      db.prepare(
        `INSERT INTO platform_accounts (
          platform, platform_account_id, canonical_user_id, account_type,
          verified_level, status, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'qq',
        platformAccountId,
        'user-alice',
        'private',
        'owner_verified',
        'active',
        now,
        now,
      );

      const result = await cli.unlinkPlatformAccount({ platform: 'qq', platformAccountId });

      expect(result).toEqual({
        success: true,
        message: 'Platform account mapping disabled',
      });
      expect(
        db.prepare(
          'SELECT status FROM platform_accounts WHERE platform = ? AND platform_account_id = ?'
        ).get('qq', platformAccountId)
      ).toEqual({ status: 'disabled' });

      const audit = db
        .prepare(
          `SELECT * FROM audit_log
           WHERE category = 'system' AND event_type = 'identity.platform_account.unlinked'`
        )
        .get() as {
        level: string;
        event_id: string;
        actor_user_id: string | null;
        actor_class: string;
        invocation_context: string;
        summary: string;
        details: string;
        redacted: number;
        risk_level: string;
      };
      const details = JSON.parse(audit.details) as Record<string, unknown>;

      expect(audit).toMatchObject({
        level: 'summary',
        actor_user_id: null,
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        summary: 'Governance CLI disabled one platform account mapping',
        redacted: 1,
        risk_level: 'medium',
      });
      expect(audit.event_id).toMatch(/^identity-unlink-/);
      expect(details).toMatchObject({
        platform: 'qq',
        canonicalUserId: 'user-alice',
        previousStatus: 'active',
        newStatus: 'disabled',
        redaction: 'no_raw_platform_account_id',
      });
      expect(details).not.toHaveProperty('platformAccountId');
      expect(JSON.stringify({ audit, details })).not.toContain(platformAccountId);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    });

    it('should fail unknown and inactive mappings without mutation or audit', async () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO platform_accounts (
          platform, platform_account_id, canonical_user_id, account_type,
          verified_level, status, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'qq', '2234567890', 'user-alice', 'private', 'observed', 'disabled', now, now,
        'qq', '3234567890', 'user-bob', 'group_member', 'observed', 'deleted', now, now,
      );
      const beforeMappings = db
        .prepare('SELECT * FROM platform_accounts ORDER BY platform_account_id')
        .all();
      const beforeAudit = db.prepare('SELECT * FROM audit_log ORDER BY id').all();

      const results = await Promise.all([
        cli.unlinkPlatformAccount({ platform: 'qq', platformAccountId: '4234567890' }),
        cli.unlinkPlatformAccount({ platform: 'qq', platformAccountId: '2234567890' }),
        cli.unlinkPlatformAccount({ platform: 'qq', platformAccountId: '3234567890' }),
      ]);

      expect(results).toEqual([
        { success: false, error: 'Platform account mapping not found or not active' },
        { success: false, error: 'Platform account mapping not found or not active' },
        { success: false, error: 'Platform account mapping not found or not active' },
      ]);
      expect(
        db.prepare('SELECT * FROM platform_accounts ORDER BY platform_account_id').all()
      ).toEqual(beforeMappings);
      expect(db.prepare('SELECT * FROM audit_log ORDER BY id').all()).toEqual(beforeAudit);
    });

    it('should roll back the mapping update when the audit insert fails', async () => {
      const platformAccountId = '5234567890';
      const now = Date.now();
      db.prepare(
        `INSERT INTO platform_accounts (
          platform, platform_account_id, canonical_user_id, account_type,
          verified_level, status, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'qq', platformAccountId, 'user-alice', 'private', 'observed', 'active', now, now,
      );
      db.exec(
        `CREATE TRIGGER fail_platform_account_unlink_audit
         BEFORE INSERT ON audit_log
         WHEN NEW.event_type = 'identity.platform_account.unlinked'
         BEGIN
           SELECT RAISE(ABORT, 'injected unlink audit failure');
         END;`
      );

      const result = await cli.unlinkPlatformAccount({ platform: 'qq', platformAccountId });

      expect(result).toEqual({ success: false, error: 'Platform account unlink failed' });
      expect(
        db.prepare(
          'SELECT status FROM platform_accounts WHERE platform = ? AND platform_account_id = ?'
        ).get('qq', platformAccountId)
      ).toEqual({ status: 'active' });
      expect(
        db.prepare(
          `SELECT COUNT(*) AS count FROM audit_log
           WHERE event_type = 'identity.platform_account.unlinked'`
        ).get()
      ).toEqual({ count: 0 });
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

  describe('privacy preference commands', () => {
    it('should set, list, and clear privacy opt-outs with audit rows', async () => {
      const setResult = await cli.setPrivacyOptOut({
        canonicalUserId: 'user-alice',
        preferenceType: 'proactive_dm',
        reason: 'No proactive reminders',
      });

      expect(setResult.success).toBe(true);

      const optedOut = await cli.listPrivacyPreferences({
        canonicalUserId: 'user-alice',
        state: 'opted_out',
      });

      expect(optedOut).toHaveLength(1);
      expect(optedOut[0]).toMatchObject({
        canonicalUserId: 'user-alice',
        preferenceType: 'proactive_dm',
        state: 'opted_out',
        reason: 'No proactive reminders',
      });

      const clearResult = await cli.clearPrivacyOptOut({
        canonicalUserId: 'user-alice',
        preferenceType: 'proactive_dm',
        reason: 'Allow proactive reminders again',
      });
      expect(clearResult.success).toBe(true);

      const optedIn = await cli.listPrivacyPreferences({
        canonicalUserId: 'user-alice',
        preferenceType: 'proactive_dm',
      });

      expect(optedIn).toHaveLength(1);
      expect(optedIn[0]).toMatchObject({
        state: 'opted_in',
        reason: 'Allow proactive reminders again',
      });

      const auditRows = db
        .prepare(
          `SELECT event_type, event_id, actor_class, invocation_context
           FROM audit_log
           WHERE event_id = ?
           ORDER BY timestamp ASC`
        )
        .all('user-alice:proactive_dm') as Array<{
        event_type: string;
        event_id: string;
        actor_class: string;
        invocation_context: string;
      }>;

      expect(auditRows).toHaveLength(2);
      expect(auditRows[0]).toMatchObject({
        event_type: 'privacy.preference_set',
        actor_class: 'admin',
        invocation_context: 'admin_cli',
      });
    });
  });
});
