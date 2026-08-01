import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_SUMMARY_POLICY_CHANGE_ACTION,
  GovernanceQueryService,
  type GroupSummaryPolicyChangePreviewProjection,
  type MemoryReviewAuditEventType,
} from '../../../src/governance/query-service.js';
import { GovernanceResourceHandleRegistry } from '../../../src/http/governance-resource-handle-registry.js';
import { GovernanceScopeHandleRegistry } from '../../../src/http/governance-scope-handle-registry.js';
import { createMemoryMaintenanceProposal } from '../../../src/memory/maintenance-proposal.js';
import { AuditRepository } from '../../../src/storage/audit-repository.js';
import { initDatabase, runMigrations } from '../../../src/storage/database.js';
import { MemoryMaintenanceProposalRepository } from '../../../src/storage/memory-maintenance-proposal-repository.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';
import type { MemoryRecord } from '../../../src/types/memory.js';

const NOW = 2_000_000;

describe('GovernanceQueryService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    runMigrations(db, join(process.cwd(), 'migrations'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('owns the read-only redacted aggregate health projection', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const platformId = '123456789';
    seedHealthEvidence(db, secret, platformId);
    seedMemoryReviewEvidence(db, 'ordinary-review', '987654321');
    const service = new GovernanceQueryService(db);
    const summarizeMemoryReviews = vi.spyOn(service, 'summarizeMemoryReviews');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const summary = await service.summarizeGovernanceHealth();

    expect(summarizeMemoryReviews).toHaveBeenCalledTimes(1);
    expect(summarizeMemoryReviews).toHaveBeenCalledWith();
    expect(summary).toMatchObject({
      memoryReviews: {
        total: 3,
        resolved: 2,
        unresolved: 1,
      },
      eventProcessing: {
        failuresTotal: 2,
        byStage: {
          context: 1,
          provider: 1,
        },
        byConversationType: {
          group: 1,
          private: 1,
        },
        latestFailureAt: new Date(NOW - 10),
      },
      actions: {
        decisions: {
          total: 1,
          byDecidedBy: { evaluator: 1 },
          byRiskLevel: { high: 1 },
          evaluatorRequired: 1,
          evaluatorPassed: 0,
          evaluatorRejected: 1,
        },
        executions: {
          total: 1,
          byStatus: { failed: 1 },
          byActionType: { reply_full: 1 },
          failedOrRejected: 1,
        },
      },
      tools: {
        total: 1,
        byStatus: { timeout: 1 },
        secretsRedacted: 1,
        failedOrRejected: 1,
      },
      jobs: {
        total: 3,
        byStatus: {
          failed: 1,
          pending: 1,
          running: 1,
        },
        byType: {
          retention: 1,
          summary: 2,
        },
        pending: 1,
        running: 1,
        failed: 1,
        expiredRunningLeases: 0,
      },
      workerHeartbeats: {
        total: 1,
        byStatus: { error: 1 },
        error: 1,
        latestHeartbeatAt: new Date(NOW - 20),
      },
      audit: {
        total: 6,
        byCategory: { memory: 5, tool: 1 },
        byRiskLevel: { high: 1, medium: 5 },
        highRisk: 1,
        prohibitedRisk: 0,
      },
      attention: {
        unresolvedMemoryReviews: 1,
        failedJobs: 1,
        expiredRunningLeases: 0,
        errorWorkerHeartbeats: 1,
        failedOrRejectedActions: 1,
        failedOrRejectedToolCalls: 1,
        eventProcessingFailures: 2,
        highOrProhibitedRiskAuditEvents: 1,
      },
    });
    expect(summary.generatedAt).toBeInstanceOf(Date);

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns bounded audit inspection with exact filters and deterministic redaction', async () => {
    const platformId = '123456789';
    const secret = 'supersecret';
    const insertAudit = db.prepare(
      `INSERT INTO audit_log (
         id, timestamp, category, level, event_type, event_id,
         actor_user_id, actor_class, invocation_context,
         summary, details, redacted, risk_level, evaluator_decision_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertAudit.run(
      'audit-shared-newer',
      NOW - 10,
      'tool',
      'full',
      'tool.execute',
      `event-${platformId}`,
      `user-${platformId}`,
      'admin',
      'admin_cli',
      `Audit password=${secret}`,
      JSON.stringify({
        nested: {
          token: 'token=abcdefghijklmnop',
          user_id: Number(platformId),
          safe: 'kept',
        },
      }),
      0,
      'high',
      `decision-${platformId}`,
    );
    insertAudit.run(
      'audit-shared-older',
      NOW - 20,
      'tool',
      'summary',
      'tool.requested',
      'event-ordinary',
      null,
      null,
      null,
      'Older audit',
      '{}',
      1,
      'low',
      null,
    );
    insertAudit.run(
      'audit-shared-other',
      NOW - 5,
      'memory',
      'summary',
      'memory.updated',
      'memory-ordinary',
      null,
      null,
      null,
      'Other category',
      '{}',
      0,
      'medium',
      null,
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const hidden = await service.listAudit({ category: 'tool', limit: 1 });
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({
      id: 'audit-shared-newer',
      timestamp: new Date(NOW - 10),
      category: 'tool',
      level: 'full',
      eventType: 'tool.execute',
      details: undefined,
      detailsRedacted: true,
      redacted: true,
    });

    const included = await service.listAudit({
      category: 'tool',
      level: 'full',
      eventType: 'tool.execute',
      eventId: `event-${platformId}`,
      userId: `user-${platformId}`,
      riskLevel: 'high',
      startTime: new Date(NOW - 11),
      endTime: new Date(NOW - 9),
      includeDetails: true,
      limit: 5,
    });
    expect(included).toHaveLength(1);
    expect(included[0]).toMatchObject({
      id: 'audit-shared-newer',
      timestamp: new Date(NOW - 10),
      category: 'tool',
      level: 'full',
      eventType: 'tool.execute',
      eventId: expect.stringContaining('[REDACTED:platform_id]'),
      actor: {
        canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
        actorClass: 'admin',
        context: 'admin_cli',
      },
      summary: expect.stringContaining('[REDACTED:password_assignment]'),
      details: {
        nested: {
          token: '[REDACTED:token_assignment]',
          user_id: '[REDACTED:platform_id]',
          safe: 'kept',
        },
      },
      detailsRedacted: true,
      redacted: true,
      riskLevel: 'high',
      evaluatorDecisionId: expect.stringContaining('[REDACTED:platform_id]'),
    });
    const serialized = JSON.stringify(included);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('abcdefghijklmnop');
    expect(await service.listAudit({
      category: 'tool',
      startTime: new Date(NOW),
    })).toEqual([]);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns redacted memory provenance detail with stable source and revision order', async () => {
    const platformId = '246813579';
    const secret = 'private-memory-detail-fixture';
    const memoryId = `memory-${platformId}-detail`;
    const memories = new MemoryRepository(db);
    memories.createSync({
      id: memoryId,
      scope: 'system',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: `Detail title ${platformId}`,
      content: 'Ordinary detail content',
      state: 'active',
      confidence: 0.8,
      importance: 0.6,
      sourceContext: `admin_cli:${platformId}`,
      evaluatorDecisionId: `decision-${platformId}`,
      sources: [
        {
          sourceType: 'user_command',
          sourceId: `source-b-${platformId}`,
          sourceTimestamp: NOW - 10,
          extractedBy: 'user',
          external: true,
        },
        {
          sourceType: 'user_command',
          sourceId: `source-a-${platformId}`,
          sourceTimestamp: NOW - 10,
          extractedBy: 'worker',
          external: true,
        },
      ],
      actor: { actorClass: 'admin', context: 'admin_cli' },
      revisionReason: 'Created ordinary detail',
      auditSummary: `Created detail ${platformId}`,
    });
    await memories.disable(memoryId, {
      actor: { actorClass: 'admin', context: 'admin_cli' },
      reason: 'Disabled ordinary detail',
      auditSummary: `Disabled detail ${platformId}`,
      evaluatorDecisionId: `disable-decision-${platformId}`,
    });
    db.prepare('UPDATE memory_records SET content = ? WHERE id = ?')
      .run(`password=${secret}`, memoryId);
    const legacyRevisions = db.prepare(
      `SELECT id, previous_state, new_state
         FROM memory_revisions WHERE memory_id = ?`,
    ).all(memoryId) as Array<{
      id: string;
      previous_state: string | null;
      new_state: string;
    }>;
    const updateLegacyRevision = db.prepare(
      `UPDATE memory_revisions
          SET previous_state = ?, new_state = ?, reason = ?
        WHERE id = ?`,
    );
    for (const revision of legacyRevisions) {
      const withLegacyContent = (raw: string | null): string | null => {
        if (raw === null) {
          return null;
        }
        const value = JSON.parse(raw) as Record<string, unknown>;
        return JSON.stringify({ ...value, content: `password=${secret}` });
      };
      updateLegacyRevision.run(
        withLegacyContent(revision.previous_state),
        withLegacyContent(revision.new_state),
        `Legacy reason password=${secret}`,
        revision.id,
      );
    }
    db.prepare(
      `UPDATE audit_log SET summary = ?
        WHERE category = 'memory' AND event_id = ?`,
    ).run(`Legacy summary password=${secret}`, memoryId);
    const service = new GovernanceQueryService(db);
    const listAudit = vi.spyOn(service, 'listAudit');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    expect(await service.showMemory('missing-memory-detail')).toBeNull();
    expect(listAudit).not.toHaveBeenCalled();

    const detail = await service.showMemory(memoryId);

    expect(listAudit).toHaveBeenCalledTimes(1);
    expect(listAudit).toHaveBeenCalledWith({
      category: 'memory',
      eventId: memoryId,
      includeDetails: false,
      limit: 100,
    });
    expect(detail).toMatchObject({
      record: {
        id: expect.stringContaining('[REDACTED:platform_id]'),
        scope: 'system',
        visibility: 'owner_admin_only',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: expect.stringContaining('[REDACTED:platform_id]'),
        content: expect.stringContaining('[REDACTED:password_assignment]'),
        state: 'disabled',
        sourceContext: expect.stringContaining('[REDACTED:platform_id]'),
        evaluatorDecisionId: expect.stringContaining('[REDACTED:platform_id]'),
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
      sources: [
        {
          memoryId: expect.stringContaining('[REDACTED:platform_id]'),
          sourceType: 'user_command',
          sourceId: expect.stringMatching(/^source-a-/u),
          sourceTimestamp: new Date(NOW - 10),
          extractedBy: 'worker',
        },
        {
          memoryId: expect.stringContaining('[REDACTED:platform_id]'),
          sourceType: 'user_command',
          sourceId: expect.stringMatching(/^source-b-/u),
          sourceTimestamp: new Date(NOW - 10),
          extractedBy: 'user',
        },
      ],
      revisions: [
        {
          revisionNumber: 1,
          changeType: 'create',
          reason: expect.stringContaining('[REDACTED:password_assignment]'),
          createdAt: expect.any(Date),
        },
        {
          revisionNumber: 2,
          changeType: 'disable',
          reason: expect.stringContaining('[REDACTED:password_assignment]'),
          evaluatorDecisionId: expect.stringContaining('[REDACTED:platform_id]'),
          createdAt: expect.any(Date),
        },
      ],
      audit: [
        {
          category: 'memory',
          eventId: expect.stringContaining('[REDACTED:platform_id]'),
          details: undefined,
          detailsRedacted: true,
        },
        {
          category: 'memory',
          eventId: expect.stringContaining('[REDACTED:platform_id]'),
          details: undefined,
          detailsRedacted: true,
        },
      ],
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(secret);
    expect(detail?.revisions[0]?.newState).toMatchObject({
      id: expect.stringContaining('[REDACTED:platform_id]'),
      content: expect.stringContaining('[REDACTED:password_assignment]'),
    });
    expect(detail?.revisions[1]?.previousState).toMatchObject({
      id: expect.stringContaining('[REDACTED:platform_id]'),
      content: expect.stringContaining('[REDACTED:password_assignment]'),
    });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns the database-backed memory list with exact filters, ordering, hydration, and no writes', async () => {
    const memories = new MemoryRepository(db);
    db.prepare(
      'INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)',
    ).run('user-list', 1_000, 1_000);
    db.prepare(
      'INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)',
    ).run('user-other', 1_000, 1_000);
    db.prepare(
      'INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)',
    ).run('user-cap', 1_000, 1_000);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const createMemory = (id: string, overrides: Partial<Parameters<MemoryRepository['createSync']>[0]> = {}) =>
      memories.createSync({
        id,
        scope: 'user',
        canonicalUserId: 'user-list',
        groupId: 'group-list',
        conversationId: 'conversation-list',
        visibility: 'same_group_only',
        sensitivity: 'sensitive',
        authority: 'inferred',
        kind: 'fact',
        title: `List ${id}`,
        content: `List content ${id}`,
        state: 'active',
        confidence: 0.8,
        importance: 0.5,
        sourceContext: 'admin_cli:list',
        actor: { actorClass: 'admin', context: 'admin_cli' },
        sources: [
          {
            sourceType: 'user_command',
            sourceId: `source-${id}`,
            sourceTimestamp: 900,
            extractedBy: 'user',
            external: true,
          },
        ],
        ...overrides,
      });

    const olderTieId = createMemory('memory-list-older-tie');
    const newerTieId = createMemory('memory-list-newer-tie');
    const lowerImportanceId = createMemory('memory-list-lower-importance');
    const proposedId = createMemory('memory-list-proposed', { state: 'proposed' });
    const unrelatedId = createMemory('memory-list-unrelated', {
      canonicalUserId: 'user-other',
      groupId: 'group-other',
      conversationId: 'conversation-other',
      sourceContext: 'admin_cli:other',
      sensitivity: 'normal',
    });
    const missingId = createMemory('memory-list-missing');

    db.prepare('UPDATE memory_records SET importance = ?, created_at = ? WHERE id = ?').run(
      0.9,
      2_000,
      olderTieId,
    );
    db.prepare('UPDATE memory_records SET importance = ?, created_at = ? WHERE id = ?').run(
      0.9,
      3_000,
      newerTieId,
    );
    db.prepare('UPDATE memory_records SET importance = ?, created_at = ? WHERE id = ?').run(
      0.4,
      4_000,
      lowerImportanceId,
    );
    db.prepare('UPDATE memory_records SET importance = ?, created_at = ? WHERE id = ?').run(
      1,
      5_000,
      proposedId,
    );
    db.prepare('UPDATE memory_records SET importance = ?, created_at = ? WHERE id = ?').run(
      1,
      6_000,
      missingId,
    );
    db.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run(lowerImportanceId);

    const insertCapMemory = db.prepare(
      `INSERT INTO memory_records (
         id, scope, canonical_user_id, visibility, sensitivity, authority,
         kind, title, content, state, confidence, importance, source_context,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      insertCapMemory.run(
        `memory-list-cap-${suffix}`,
        'user',
        'user-cap',
        'private_only',
        'normal',
        'user_stated',
        'fact',
        `Cap ${suffix}`,
        `Cap content ${suffix}`,
        'active',
        0.8,
        0.5,
        'admin_cli:cap',
        10_000 + index,
        10_000 + index,
      );
    }

    const originalFindById = MemoryRepository.prototype.findById;
    const findById = vi.spyOn(MemoryRepository.prototype, 'findById');
    findById.mockImplementation(async (id) => {
      if (id === missingId) {
        return null;
      }
      return originalFindById.call(memories, id);
    });

    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const ordered = await service.listMemory({
      userId: 'user-list',
      groupId: 'group-list',
      conversationId: 'conversation-list',
      scope: 'user',
      sensitivity: 'sensitive',
      sourceContext: 'admin_cli:list',
      limit: 100,
    });
    expect(ordered.map((memory) => memory.id)).toEqual([
      newerTieId,
      olderTieId,
      lowerImportanceId,
    ]);
    expect(ordered[0]).toMatchObject({
      id: newerTieId,
      scope: 'user',
      canonicalUserId: 'user-list',
      groupId: 'group-list',
      conversationId: 'conversation-list',
      sensitivity: 'sensitive',
      sourceContext: 'admin_cli:list',
      createdAt: new Date(3_000),
    });
    expect(ordered[0]?.createdAt).toBeInstanceOf(Date);
    expect(ordered[2]?.sourceEventIds).toEqual([]);

    const sourceTypeMatched = await service.listMemory({
      sourceType: 'user_command',
      userId: 'user-list',
      limit: 100,
    });
    expect(sourceTypeMatched.map((memory) => memory.id)).toEqual([
      newerTieId,
      olderTieId,
    ]);

    const sourceIdMatched = await service.listMemory({
      sourceId: `source-${newerTieId}`,
      limit: 100,
    });
    expect(sourceIdMatched.map((memory) => memory.id)).toEqual([newerTieId]);

    const limited = await service.listMemory({
      userId: 'user-list',
      limit: 2,
    });
    expect(limited.map((memory) => memory.id)).toEqual([newerTieId]);

    const proposed = await service.listMemory({
      userId: 'user-list',
      state: 'proposed',
      limit: 100,
    });
    expect(proposed.map((memory) => memory.id)).toEqual([proposedId]);

    const defaultBound = await service.listMemory({ userId: 'user-cap' });
    expect(defaultBound).toHaveLength(100);
    expect(defaultBound[0]?.id).toBe('memory-list-cap-100');
    expect(defaultBound.at(-1)?.id).toBe('memory-list-cap-001');
    expect(ordered.map((memory) => memory.id)).not.toContain(unrelatedId);
    expect(ordered.map((memory) => memory.id)).not.toContain(missingId);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns the visible memory export filter, redaction, fixed shape, and ISO dates', async () => {
    const platformId = '246813579';
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const visible: MemoryRecord = {
      id: `memory-export-${platformId}`,
      scope: 'user',
      canonicalUserId: `user-${platformId}`,
      subjectUserId: `subject-${platformId}`,
      visibility: 'same_user_any_context',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: `Export ${secret}`,
      content: `api_key=${secret}`,
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: `admin_cli:${platformId}`,
      sourceEventIds: [`source-${platformId}`],
      evaluatorDecisionId: `decision-${platformId}`,
      createdAt: new Date(100),
      updatedAt: new Date(200),
      expiresAt: new Date(300),
    };
    const secretRecord: MemoryRecord = {
      ...visible,
      id: 'memory-export-secret',
      sensitivity: 'secret',
      title: 'Blocked secret record',
      content: 'Blocked secret content',
    };
    const prohibitedRecord: MemoryRecord = {
      ...visible,
      id: 'memory-export-prohibited',
      sensitivity: 'prohibited',
      title: 'Blocked prohibited record',
      content: 'Blocked prohibited content',
    };
    const records = [visible, secretRecord, prohibitedRecord];
    const recordsBefore = JSON.stringify(records);
    const service = new GovernanceQueryService(db);
    const listMemory = vi.spyOn(service, 'listMemory').mockResolvedValue(records);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const defaultExport = await service.exportMemory({ userId: 'user-export' });
    expect(listMemory).toHaveBeenNthCalledWith(1, {
      userId: 'user-export',
      state: 'active',
    });
    expect(defaultExport).toHaveLength(1);
    expect(Object.keys(defaultExport[0] ?? {})).toEqual([
      'id',
      'scope',
      'canonicalUserId',
      'groupId',
      'conversationId',
      'subjectUserId',
      'visibility',
      'sensitivity',
      'authority',
      'kind',
      'title',
      'content',
      'state',
      'confidence',
      'importance',
      'sourceContext',
      'sourceEventIds',
      'evaluatorDecisionId',
      'createdAt',
      'updatedAt',
      'expiresAt',
    ]);
    expect(defaultExport[0]).toMatchObject({
      id: expect.stringContaining('[REDACTED:platform_id]'),
      canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
      subjectUserId: expect.stringContaining('[REDACTED:platform_id]'),
      title: expect.stringContaining('[REDACTED:openai_like_api_key]'),
      content: '[REDACTED:api_key_assignment]',
      sourceContext: expect.stringContaining('[REDACTED:platform_id]'),
      sourceEventIds: [expect.stringContaining('[REDACTED:platform_id]')],
      evaluatorDecisionId: expect.stringContaining('[REDACTED:platform_id]'),
      createdAt: new Date(100).toISOString(),
      updatedAt: new Date(200).toISOString(),
      expiresAt: new Date(300).toISOString(),
    });
    const serialized = JSON.stringify(defaultExport);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('memory-export-secret');
    expect(serialized).not.toContain('memory-export-prohibited');

    await service.exportMemory({
      state: 'disabled',
      sourceType: 'user_command',
      sourceId: 'source-export',
      limit: 7,
    });
    expect(listMemory).toHaveBeenNthCalledWith(2, {
      state: 'disabled',
      sourceType: 'user_command',
      sourceId: 'source-export',
      limit: 7,
    });
    expect(JSON.stringify(records)).toBe(recordsBefore);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
  });

  it('owns the filtered model invocation summary without exposing or changing rows', async () => {
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-query-invocations',
      'chat.message.received',
      NOW - 100,
      'gateway',
      'qq',
      'private:query-invocations',
      '{}',
      NOW - 100,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
       ) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      'turn-query-invocations',
      'private:query-invocations',
      'raw-query-invocations',
      'model-query-invocations',
      'provider-query-invocations',
      NOW - 90,
    );
    const insertInvocation = db.prepare(
      `INSERT INTO model_invocations (
         id, turn_id, purpose, call_number, provider, model, status,
         started_at, completed_at, tokens_input, tokens_output, tokens_total,
         response_sha256, response_bytes, error_code
       ) VALUES (?, ?, 'pi_turn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertInvocation.run(
      'invocation-query-known',
      'turn-query-invocations',
      1,
      'provider-query-invocations',
      'model-query-invocations',
      'completed',
      NOW,
      NOW + 10,
      2,
      3,
      5,
      'a'.repeat(64),
      10,
      null,
    );
    insertInvocation.run(
      'invocation-query-unknown',
      'turn-query-invocations',
      2,
      'provider-query-invocations',
      'model-query-invocations',
      'completed',
      NOW,
      NOW + 20,
      null,
      null,
      null,
      'b'.repeat(64),
      20,
      null,
    );
    insertInvocation.run(
      'invocation-query-failed',
      'turn-query-invocations',
      3,
      'provider-query-invocations',
      'model-query-invocations',
      'failed',
      NOW,
      NOW + 30,
      null,
      null,
      null,
      null,
      null,
      'provider_error',
    );
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const service = new GovernanceQueryService(db);

    const completed = await service.summarizeModelInvocations({
      purpose: 'pi_turn',
      status: 'completed',
    });
    expect(completed).toEqual({
      generatedAt: expect.any(Date),
      filters: { purpose: 'pi_turn', status: 'completed' },
      total: 2,
      byPurpose: { pi_turn: 2 },
      byStatus: { completed: 2 },
      completedKnownUsage: 1,
      completedUnknownUsage: 1,
      providerLatencyMs: { count: 2, sumMs: 30, maxMs: 20 },
    });

    const failed = await service.summarizeModelInvocations({ status: 'failed' });
    expect(failed).toEqual({
      generatedAt: expect.any(Date),
      filters: { status: 'failed' },
      total: 1,
      byPurpose: { pi_turn: 1 },
      byStatus: { failed: 1 },
      completedKnownUsage: 0,
      completedUnknownUsage: 0,
      providerLatencyMs: { count: 1, sumMs: 30, maxMs: 30 },
    });
    expect(failed.generatedAt).not.toBe(completed.generatedAt);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns bounded tool-call inspection with exact filters and payload redaction', async () => {
    const platformId = '123456789';
    const secret = 'toolinputsecret';
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-query-tool-calls',
      'chat.message.received',
      NOW - 100,
      'gateway',
      'qq',
      'private:query-tool-calls',
      '{}',
      NOW - 100,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
       ) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      'turn-query-tool-calls',
      'private:query-tool-calls',
      'raw-query-tool-calls',
      'model-query-tool-calls',
      'provider-query-tool-calls',
      NOW - 90,
    );
    const insertToolCall = db.prepare(
      `INSERT INTO tool_calls (
         id, turn_id, tool_name, input, output,
         requested_by, actor_user_id, actor_class, invocation_context,
         status, error_code, error_message, execution_time_ms,
         secrets_redacted, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      insertToolCall.run(
        `tool-query-filler-${String(index).padStart(3, '0')}`,
        'turn-query-tool-calls',
        'runtime.status',
        '{}',
        null,
        'pi',
        null,
        'user',
        'private_chat',
        'success',
        null,
        null,
        index,
        0,
        NOW + index,
      );
    }
    for (const suffix of ['a', 'b']) {
      insertToolCall.run(
        `tool-query-${suffix}-${platformId}`,
        'turn-query-tool-calls',
        'workspace.read_text',
        `not-json password=${secret}`,
        JSON.stringify({ token: 'token=abcdefghijklmnop', user_id: Number(platformId) }),
        'pi',
        `user-${platformId}`,
        'user',
        'private_chat',
        'success',
        null,
        null,
        null,
        0,
        NOW + 200,
      );
    }
    insertToolCall.run(
      'tool-query-other',
      'turn-query-tool-calls',
      'workspace.read_text',
      '{}',
      null,
      'pi',
      null,
      'user',
      'private_chat',
      'error',
      'tool_error',
      'ordinary failure',
      7,
      1,
      NOW + 300,
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const hidden = await service.listToolCalls({
      turnId: 'turn-query-tool-calls',
      toolName: 'workspace.read_text',
      status: 'success',
      limit: 1,
    });
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({
      id: `tool-query-b-[REDACTED:platform_id]`,
      turnId: 'turn-query-tool-calls',
      toolName: 'workspace.read_text',
      requestedBy: 'pi',
      actor: {
        canonicalUserId: 'user-[REDACTED:platform_id]',
        actorClass: 'user',
      },
      context: 'private_chat',
      status: 'success',
      errorCode: undefined,
      errorMessage: undefined,
      executionTimeMs: undefined,
      secretsRedacted: false,
      createdAt: new Date(NOW + 200),
      input: undefined,
      output: undefined,
    });

    const included = await service.listToolCalls({
      turnId: 'turn-query-tool-calls',
      toolName: 'workspace.read_text',
      status: 'success',
      includePayload: true,
      limit: 1,
    });
    expect(included[0]).toMatchObject({
      input: 'not-json [REDACTED:password_assignment]',
      output: {
        token: '[REDACTED:token_assignment]',
        user_id: '[REDACTED:platform_id]',
      },
      secretsRedacted: true,
    });
    expect(JSON.stringify(included)).not.toContain(secret);
    expect(JSON.stringify(included)).not.toContain(platformId);

    const defaultWindow = await service.listToolCalls();
    expect(defaultWindow).toHaveLength(100);
    expect(defaultWindow[0]?.id).toBe('tool-query-other');
    expect(defaultWindow.some((row) => row.id === 'tool-query-filler-000')).toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns bounded action-decision inspection with exact filters and action redaction', async () => {
    const platformId = '234567890';
    const secret = 'actiondecisionsecret';
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-query-action-decisions',
      'chat.message.received',
      NOW - 100,
      'gateway',
      'qq',
      'private:query-action-decisions',
      '{}',
      NOW - 100,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
       ) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      'turn-query-action-decisions',
      'private:query-action-decisions',
      'raw-query-action-decisions',
      'model-query-action-decisions',
      'provider-query-action-decisions',
      NOW - 90,
    );
    const insertDecision = db.prepare(
      `INSERT INTO action_decisions (
         id, turn_id, decided_by, risk_level, confidence,
         evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      insertDecision.run(
        `decision-query-filler-${String(index).padStart(3, '0')}`,
        'turn-query-action-decisions',
        'pi',
        'low',
        0.5,
        0,
        null,
        '[]',
        null,
        null,
        NOW + index,
      );
    }
    const actions = JSON.stringify([{
      type: 'reply_full',
      priority: 1,
      target: { conversationId: `private:${platformId}`, userId: platformId },
      payload: { text: `password=${secret}` },
      constraints: { redactionLevel: 'strict' },
      reason: `token=${secret}`,
    }]);
    for (const suffix of ['a', 'b']) {
      insertDecision.run(
        `decision-query-${suffix}-${platformId}`,
        'turn-query-action-decisions',
        'evaluator',
        'high',
        0.75,
        1,
        null,
        actions,
        JSON.stringify([`reason password=${secret}`]),
        JSON.stringify([`suppressor token=${secret}`]),
        NOW + 200,
      );
    }
    insertDecision.run(
      'decision-query-malformed',
      'turn-query-action-decisions',
      'attention',
      'medium',
      0.25,
      0,
      0,
      'not-json',
      '{"not":"an-array"}',
      'not-json',
      NOW + 300,
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const hidden = await service.listActionDecisions({
      turnId: 'turn-query-action-decisions',
      decidedBy: 'evaluator',
      riskLevel: 'high',
      limit: 1,
    });
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toEqual({
      id: 'decision-query-b-[REDACTED:platform_id]',
      turnId: 'turn-query-action-decisions',
      createdAt: new Date(NOW + 200),
      decidedBy: 'evaluator',
      riskLevel: 'high',
      confidence: 0.75,
      evaluatorRequired: true,
      evaluatorPassed: undefined,
      actionCount: 1,
      actions: undefined,
      reasons: ['reason [REDACTED:password_assignment]'],
      suppressors: ['suppressor [REDACTED:token_assignment]'],
    });

    const included = await service.listActionDecisions({
      turnId: 'turn-query-action-decisions',
      decidedBy: 'evaluator',
      riskLevel: 'high',
      includeActions: true,
      limit: 1,
    });
    expect(included[0]?.actions).toEqual([expect.objectContaining({
      target: {
        conversationId: 'private:[REDACTED:platform_id]',
        userId: '[REDACTED:platform_id]',
      },
      payload: { text: '[REDACTED:password_assignment]' },
      reason: '[REDACTED:token_assignment]',
    })]);
    expect(JSON.stringify(included)).not.toContain(secret);
    expect(JSON.stringify(included)).not.toContain(platformId);

    const defaultWindow = await service.listActionDecisions();
    expect(defaultWindow).toHaveLength(100);
    expect(defaultWindow[0]).toMatchObject({
      id: 'decision-query-malformed',
      evaluatorRequired: false,
      evaluatorPassed: false,
      actionCount: 0,
      actions: undefined,
      reasons: [],
      suppressors: [],
    });
    expect(defaultWindow.some((row) => row.id === 'decision-query-filler-000')).toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns bounded action-execution inspection with exact filters and diagnostic redaction', async () => {
    const platformId = '234567890';
    const secret = 'actionexecutionsecret';
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-query-action-executions',
      'chat.message.received',
      NOW - 100,
      'gateway',
      'qq',
      'private:query-action-executions',
      '{}',
      NOW - 100,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
       ) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      'turn-query-action-executions',
      'private:query-action-executions',
      'raw-query-action-executions',
      'model-query-action-executions',
      'provider-query-action-executions',
      NOW - 90,
    );
    const insertDecision = db.prepare(
      `INSERT INTO action_decisions (
         id, turn_id, decided_by, risk_level, confidence,
         evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
       ) VALUES (?, ?, 'pi', 'medium', 0.75, 0, NULL, '[]', NULL, NULL, ?)`,
    );
    const decisionId = `decision-query-actions-${platformId}`;
    insertDecision.run(decisionId, 'turn-query-action-executions', NOW - 80);
    insertDecision.run('decision-query-actions-other', 'turn-query-action-executions', NOW - 70);

    const insertExecution = db.prepare(
      `INSERT INTO action_executions (
         id, action_decision_id, action_type, status,
         executed_message_id, executed_memory_id, executed_job_id,
         downgraded_from, downgraded_reason, error_code, error_message,
         audit_level, audit_entry, executed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      insertExecution.run(
        `execution-query-filler-${String(index).padStart(3, '0')}`,
        decisionId,
        'reply_short',
        'success',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        'summary',
        null,
        NOW + index,
      );
    }
    insertExecution.run(
      `execution-query-a-${platformId}`,
      decisionId,
      'reply_full',
      'failed',
      `message-${platformId}`,
      null,
      null,
      'reply_short',
      `reason password=${secret}`,
      `code-${platformId}`,
      `message token=${secret}`,
      'full',
      `audit password=${secret} target=${platformId}`,
      NOW + 200,
    );
    insertExecution.run(
      `execution-query-b-${platformId}`,
      decisionId,
      'reply_full',
      'failed',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'summary',
      null,
      NOW + 200,
    );
    insertExecution.run(
      'execution-query-filter-status',
      decisionId,
      'reply_full',
      'success',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'summary',
      null,
      NOW + 300,
    );
    insertExecution.run(
      'execution-query-filter-type',
      decisionId,
      'react_only',
      'failed',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'summary',
      null,
      NOW + 300,
    );
    insertExecution.run(
      'execution-query-filter-decision',
      'decision-query-actions-other',
      'reply_full',
      'failed',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'summary',
      null,
      NOW + 300,
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const hidden = await service.listActionExecutions({
      actionDecisionId: decisionId,
      actionType: 'reply_full',
      status: 'failed',
      limit: 1,
    });
    expect(hidden).toEqual([{
      id: 'execution-query-b-[REDACTED:platform_id]',
      actionDecisionId: 'decision-query-actions-[REDACTED:platform_id]',
      actionType: 'reply_full',
      status: 'failed',
      executedMessageId: undefined,
      executedMemoryId: undefined,
      executedJobId: undefined,
      downgradedFrom: undefined,
      downgradedReason: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      auditLevel: 'summary',
      auditEntry: undefined,
      executedAt: new Date(NOW + 200),
    }]);

    const included = await service.listActionExecutions({
      actionDecisionId: decisionId,
      actionType: 'reply_full',
      status: 'failed',
      includeAuditEntry: true,
      limit: 2,
    });
    expect(included).toHaveLength(2);
    expect(included[1]).toMatchObject({
      id: 'execution-query-a-[REDACTED:platform_id]',
      actionDecisionId: 'decision-query-actions-[REDACTED:platform_id]',
      executedMessageId: 'message-[REDACTED:platform_id]',
      downgradedFrom: 'reply_short',
      downgradedReason: 'reason [REDACTED:password_assignment]',
      errorCode: 'code-[REDACTED:platform_id]',
      errorMessage: 'message [REDACTED:token_assignment]',
      auditEntry: 'audit [REDACTED:password_assignment] target=[REDACTED:platform_id]',
      executedAt: new Date(NOW + 200),
    });
    expect(JSON.stringify(included)).not.toContain(secret);
    expect(JSON.stringify(included)).not.toContain(platformId);

    const defaultWindow = await service.listActionExecutions();
    expect(defaultWindow).toHaveLength(100);
    expect(defaultWindow.some((row) => row.id === 'execution-query-filler-000')).toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns Explain action and tool evidence with linked selection and stable ordering', async () => {
    const now = NOW + 400;
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-explain-evidence',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:explain-evidence',
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, context_pack_id,
         pi_model, pi_provider, status, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'turn-explain-evidence',
      'private:explain-evidence',
      'raw-explain-evidence',
      'ctx-explain-evidence',
      'mock-model',
      'mock-provider',
      'completed',
      now,
    );
    db.prepare(
      `INSERT INTO action_decisions (
         id, turn_id, decided_by, risk_level, confidence,
         evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'decision-explain-old',
      'turn-explain-evidence',
      'pi',
      'low',
      0.4,
      0,
      null,
      '[]',
      '[]',
      '[]',
      now - 2,
    );
    db.prepare(
      `INSERT INTO action_decisions (
         id, turn_id, decided_by, risk_level, confidence,
         evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'decision-explain-linked',
      'turn-explain-evidence',
      'evaluator',
      'high',
      0.9,
      1,
      1,
      JSON.stringify([{
        type: 'reply_full',
        priority: 1,
        constraints: { redactionLevel: 'strict' },
        reason: 'linked decision',
      }]),
      JSON.stringify(['selected']),
      JSON.stringify(['none']),
      now - 1,
    );
    db.prepare('UPDATE agent_turns SET action_decision_id = ? WHERE id = ?').run(
      'decision-explain-linked',
      'turn-explain-evidence',
    );
    db.prepare(
      `INSERT INTO action_executions (
         id, action_decision_id, action_type, status,
         audit_level, executed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'execution-explain-first',
      'decision-explain-linked',
      'react_only',
      'success',
      'summary',
      now,
    );
    db.prepare(
      `INSERT INTO action_executions (
         id, action_decision_id, action_type, status,
         executed_message_id, audit_level, executed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'execution-explain-second',
      'decision-explain-linked',
      'reply_full',
      'success',
      'message-explain',
      'summary',
      now + 1,
    );
    db.prepare(
      `INSERT INTO tool_calls (
         id, turn_id, tool_name, input, requested_by, actor_class,
         invocation_context, status, secrets_redacted, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'tool-explain-second',
      'turn-explain-evidence',
      'workspace.read_text',
      '{}',
      'pi',
      'user',
      'private_chat',
      'success',
      0,
      now + 1,
    );
    db.prepare(
      `INSERT INTO tool_calls (
         id, turn_id, tool_name, input, requested_by, actor_class,
         invocation_context, status, secrets_redacted, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'tool-explain-first',
      'turn-explain-evidence',
      'runtime.status',
      '{}',
      'pi',
      'user',
      'private_chat',
      'success',
      0,
      now,
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const tools = await service.explainToolCalls('turn-explain-evidence');
    const decision = await service.explainActionDecision('turn-explain-evidence');
    const executions = await service.explainActionExecutions('decision-explain-linked');

    expect(tools.map((tool) => tool.id)).toEqual([
      'tool-explain-first',
      'tool-explain-second',
    ]);
    expect(decision).toMatchObject({
      id: 'decision-explain-linked',
      decidedBy: 'evaluator',
      riskLevel: 'high',
      actionTypes: ['reply_full'],
      reasons: ['selected'],
      suppressors: ['none'],
    });
    expect(decision?.executions).toEqual(executions);
    expect(executions.map((execution) => execution.id)).toEqual([
      'execution-explain-first',
      'execution-explain-second',
    ]);
    expect(executions[0]?.effect).toBe('true_reaction');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns Explain turn resolution with exact/latest selection and nullable joined metadata', async () => {
    const insertRawEvent = db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertChatMessage = db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTurn = db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, context_pack_id,
         pi_model, pi_provider, status, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const seedRawEvent = (id: string, conversationId: string, timestamp: number): void => {
      insertRawEvent.run(
        id,
        'chat.message.received',
        timestamp,
        'gateway',
        'qq',
        conversationId,
        '{}',
        timestamp,
      );
    };
    const seedTurn = (
      id: string,
      conversationId: string,
      rawEventId: string,
      contextPackId: string | null,
      startedAt: number,
    ): void => {
      insertTurn.run(
        id,
        conversationId,
        rawEventId,
        contextPackId,
        'mock-model',
        'mock-provider',
        'completed',
        startedAt,
      );
    };

    seedRawEvent('raw-turn-resolution-exact', 'group:turn-resolution', 100);
    insertChatMessage.run(
      'message-turn-resolution-exact',
      'raw-turn-resolution-exact',
      'platform-turn-resolution-exact',
      'group:turn-resolution',
      'group',
      'group-turn-resolution',
      'user-turn-resolution',
      'synthetic message',
      100,
    );
    seedTurn(
      'turn-resolution-exact',
      'group:turn-resolution',
      'raw-turn-resolution-exact',
      'context-turn-resolution-exact',
      200,
    );

    seedRawEvent('raw-turn-resolution-distractor', 'private:turn-resolution-distractor', 300);
    seedTurn(
      'turn-resolution-distractor',
      'private:turn-resolution-distractor',
      'raw-turn-resolution-distractor',
      'context-turn-resolution-distractor',
      300,
    );

    seedRawEvent('raw-turn-resolution-latest', 'private:turn-resolution-latest', 400);
    insertChatMessage.run(
      'message-turn-resolution-latest',
      'raw-turn-resolution-latest',
      'platform-turn-resolution-latest',
      'private:turn-resolution-latest',
      'private',
      null,
      'user-turn-resolution-latest',
      'latest synthetic message',
      400,
    );
    seedTurn(
      'turn-resolution-latest',
      'private:turn-resolution-latest',
      'raw-turn-resolution-latest',
      'context-turn-resolution-latest',
      500,
    );

    seedRawEvent('raw-turn-resolution-orphan', 'private:turn-resolution-orphan', 50);
    seedTurn(
      'turn-resolution-orphan',
      'private:turn-resolution-orphan',
      'raw-turn-resolution-orphan',
      null,
      50,
    );

    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    await expect(service.resolveExplainTurn('missing-turn-resolution')).resolves.toBeNull();
    await expect(service.resolveExplainTurn('turn-resolution-exact')).resolves.toEqual({
      turnId: 'turn-resolution-exact',
      contextPackId: 'context-turn-resolution-exact',
      conversationId: 'group:turn-resolution',
      conversationType: 'group',
      groupId: 'group-turn-resolution',
      senderId: 'user-turn-resolution',
    });
    await expect(service.resolveExplainTurn('turn-resolution-orphan')).resolves.toEqual({
      turnId: 'turn-resolution-orphan',
      contextPackId: null,
      conversationId: 'private:turn-resolution-orphan',
      conversationType: null,
      groupId: null,
      senderId: null,
    });
    await expect(service.resolveExplainTurn()).resolves.toEqual({
      turnId: 'turn-resolution-latest',
      contextPackId: 'context-turn-resolution-latest',
      conversationId: 'private:turn-resolution-latest',
      conversationType: 'private',
      groupId: null,
      senderId: 'user-turn-resolution-latest',
    });

    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns bounded job inspection with exact filters, ordering, and payload redaction', async () => {
    const platformId = '345678901';
    const secret = 'jobquerysecret';
    const insertJob = db.prepare(
      `INSERT INTO jobs (
         id, type, payload, idempotency_key, status, attempts, max_attempts,
         lease_owner, lease_expires_at, heartbeat_at,
         created_at, updated_at, scheduled_at, started_at, completed_at,
         error, result
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      insertJob.run(
        `job-query-filler-${String(index).padStart(3, '0')}`,
        'retention',
        '{}',
        null,
        'pending',
        0,
        3,
        null,
        null,
        null,
        NOW + 1_000 + index,
        NOW + 1_000 + index,
        NOW + 1_000 + index,
        null,
        null,
        null,
        null,
      );
    }
    insertJob.run(
      'job-query-filter-status',
      'summary',
      '{}',
      null,
      'completed',
      1,
      3,
      null,
      null,
      null,
      NOW,
      NOW + 1,
      NOW + 50,
      NOW,
      NOW + 1,
      null,
      '{}',
    );
    insertJob.run(
      'job-query-filter-type',
      'retention',
      '{}',
      null,
      'failed',
      1,
      3,
      null,
      null,
      null,
      NOW + 5,
      NOW + 6,
      NOW + 60,
      NOW + 5,
      NOW + 6,
      'ordinary failure',
      null,
    );
    insertJob.run(
      `job-query-b-${platformId}`,
      'summary',
      `not-json password=${secret}`,
      null,
      'failed',
      0,
      3,
      null,
      null,
      null,
      NOW + 10,
      NOW + 30,
      NOW + 100,
      null,
      null,
      null,
      'not-json token=abcdefghijklmnop',
    );
    insertJob.run(
      `job-query-a-${platformId}`,
      'summary',
      JSON.stringify({
        nested: {
          token: 'token=abcdefghijklmnop',
          user_id: Number(platformId),
        },
      }),
      `summary:${platformId}`,
      'failed',
      2,
      4,
      `worker-${platformId}`,
      NOW + 50,
      NOW + 40,
      NOW + 20,
      NOW + 80,
      NOW + 100,
      NOW + 30,
      NOW + 70,
      `failure password=${secret}`,
      JSON.stringify({ nested: { text: `password=${secret}`, user_id: Number(platformId) } }),
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const hidden = await service.listJobs({
      status: 'failed',
      type: 'summary',
      limit: 1,
    });
    expect(hidden).toEqual([{
      id: 'job-query-b-[REDACTED:platform_id]',
      type: 'summary',
      status: 'failed',
      attempts: 0,
      maxAttempts: 3,
      idempotencyKey: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      createdAt: new Date(NOW + 10),
      updatedAt: new Date(NOW + 30),
      scheduledAt: new Date(NOW + 100),
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      payload: undefined,
      result: undefined,
    }]);

    const included = await service.listJobs({
      status: 'failed',
      type: 'summary',
      includePayload: true,
      limit: 2,
    });
    expect(included).toHaveLength(2);
    expect(included[0]).toMatchObject({
      payload: 'not-json [REDACTED:password_assignment]',
      result: 'not-json [REDACTED:token_assignment]',
    });
    expect(included[1]).toEqual({
      id: 'job-query-a-[REDACTED:platform_id]',
      type: 'summary',
      status: 'failed',
      attempts: 2,
      maxAttempts: 4,
      idempotencyKey: 'summary:[REDACTED:platform_id]',
      leaseOwner: 'worker-[REDACTED:platform_id]',
      leaseExpiresAt: new Date(NOW + 50),
      heartbeatAt: new Date(NOW + 40),
      createdAt: new Date(NOW + 20),
      updatedAt: new Date(NOW + 80),
      scheduledAt: new Date(NOW + 100),
      startedAt: new Date(NOW + 30),
      completedAt: new Date(NOW + 70),
      error: 'failure [REDACTED:password_assignment]',
      payload: {
        nested: {
          token: '[REDACTED:token_assignment]',
          user_id: '[REDACTED:platform_id]',
        },
      },
      result: {
        nested: {
          text: '[REDACTED:password_assignment]',
          user_id: '[REDACTED:platform_id]',
        },
      },
    });
    expect(JSON.stringify(included)).not.toContain(secret);
    expect(JSON.stringify(included)).not.toContain(platformId);

    const defaultWindow = await service.listJobs();
    expect(defaultWindow).toHaveLength(100);
    expect(defaultWindow.slice(0, 4).map((job) => job.id)).toEqual([
      'job-query-filter-status',
      'job-query-filter-type',
      'job-query-b-[REDACTED:platform_id]',
      'job-query-a-[REDACTED:platform_id]',
    ]);
    expect(defaultWindow.some((job) => job.id === 'job-query-filler-100')).toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns bounded job-attempt inspection with exact filters, ordering, and result redaction', async () => {
    const platformId = '456789012';
    const secret = 'jobattemptquerysecret';
    const jobId = `job-attempt-query-parent-${platformId}`;
    db.prepare(
      `INSERT INTO jobs (
         id, type, payload, status, attempts, max_attempts,
         created_at, updated_at, scheduled_at
       ) VALUES (?, 'summary', '{}', 'failed', 1, 4, ?, ?, ?),
                (?, 'retention', '{}', 'failed', 1, 4, ?, ?, ?)`,
    ).run(
      jobId,
      NOW,
      NOW,
      NOW,
      'job-attempt-query-other',
      NOW,
      NOW,
      NOW,
    );
    const insertAttempt = db.prepare(
      `INSERT INTO job_attempts (
         id, job_id, attempt_number, worker_id, status,
         started_at, completed_at, heartbeat_at, error, result
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      insertAttempt.run(
        `attempt-query-filler-${String(index).padStart(3, '0')}`,
        jobId,
        index + 1,
        'worker-filler',
        'running',
        NOW + index,
        null,
        null,
        null,
        null,
      );
    }
    insertAttempt.run(
      'attempt-query-filter-status',
      jobId,
      102,
      `worker-${platformId}`,
      'completed',
      NOW + 300,
      NOW + 310,
      NOW + 305,
      null,
      '{}',
    );
    insertAttempt.run(
      'attempt-query-filter-worker',
      jobId,
      103,
      'worker-other',
      'failed',
      NOW + 300,
      NOW + 310,
      NOW + 305,
      'ordinary failure',
      null,
    );
    insertAttempt.run(
      'attempt-query-filter-job',
      'job-attempt-query-other',
      1,
      `worker-${platformId}`,
      'failed',
      NOW + 300,
      NOW + 310,
      NOW + 305,
      'ordinary failure',
      null,
    );
    insertAttempt.run(
      `attempt-query-a-${platformId}`,
      jobId,
      104,
      `worker-${platformId}`,
      'failed',
      NOW + 200,
      NOW + 220,
      NOW + 210,
      `failure password=${secret}`,
      JSON.stringify({
        nested: {
          token: 'token=abcdefghijklmnop',
          user_id: Number(platformId),
        },
      }),
    );
    insertAttempt.run(
      `attempt-query-b-${platformId}`,
      jobId,
      105,
      `worker-${platformId}`,
      'failed',
      NOW + 200,
      null,
      null,
      null,
      `not-json password=${secret} user=${platformId}`,
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const hidden = await service.listJobAttempts({
      jobId,
      workerId: `worker-${platformId}`,
      status: 'failed',
      limit: 1,
    });
    expect(hidden).toEqual([{
      id: 'attempt-query-b-[REDACTED:platform_id]',
      jobId: 'job-attempt-query-parent-[REDACTED:platform_id]',
      attemptNumber: 105,
      workerId: 'worker-[REDACTED:platform_id]',
      status: 'failed',
      startedAt: new Date(NOW + 200),
      completedAt: undefined,
      heartbeatAt: undefined,
      error: undefined,
      result: undefined,
    }]);

    const included = await service.listJobAttempts({
      jobId,
      workerId: `worker-${platformId}`,
      status: 'failed',
      includeResult: true,
      limit: 2,
    });
    expect(included).toHaveLength(2);
    expect(included[0]).toMatchObject({
      result: 'not-json [REDACTED:password_assignment] user=[REDACTED:platform_id]',
    });
    expect(included[1]).toEqual({
      id: 'attempt-query-a-[REDACTED:platform_id]',
      jobId: 'job-attempt-query-parent-[REDACTED:platform_id]',
      attemptNumber: 104,
      workerId: 'worker-[REDACTED:platform_id]',
      status: 'failed',
      startedAt: new Date(NOW + 200),
      completedAt: new Date(NOW + 220),
      heartbeatAt: new Date(NOW + 210),
      error: 'failure [REDACTED:password_assignment]',
      result: {
        nested: {
          token: '[REDACTED:token_assignment]',
          user_id: '[REDACTED:platform_id]',
        },
      },
    });
    expect(JSON.stringify(included)).not.toContain(secret);
    expect(JSON.stringify(included)).not.toContain(platformId);

    const defaultWindow = await service.listJobAttempts();
    expect(defaultWindow).toHaveLength(100);
    expect(defaultWindow.slice(0, 5).map((attempt) => attempt.id)).toEqual([
      'attempt-query-filter-worker',
      'attempt-query-filter-status',
      'attempt-query-filter-job',
      'attempt-query-b-[REDACTED:platform_id]',
      'attempt-query-a-[REDACTED:platform_id]',
    ]);
    expect(defaultWindow.some((attempt) => attempt.id === 'attempt-query-filler-000')).toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns bounded worker-heartbeat inspection with exact filters, ordering, and details redaction', async () => {
    const platformId = '567890123';
    const secret = 'workerheartbeatquerysecret';
    const workerType = `background-${platformId}`;
    const jobId = `job-heartbeat-query-${platformId}`;
    db.prepare(
      `INSERT INTO jobs (
         id, type, payload, status, attempts, max_attempts,
         created_at, updated_at, scheduled_at
       ) VALUES (?, 'summary', '{}', 'running', 1, 4, ?, ?, ?)`,
    ).run(jobId, NOW, NOW, NOW);
    const insertHeartbeat = db.prepare(
      `INSERT INTO worker_heartbeats (
         worker_id, worker_type, status, current_job_id, heartbeat_at, details
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      insertHeartbeat.run(
        `worker-heartbeat-filler-${String(index).padStart(3, '0')}`,
        'filler',
        'idle',
        null,
        NOW + index,
        null,
      );
    }
    insertHeartbeat.run(
      'worker-heartbeat-filter-status',
      workerType,
      'idle',
      null,
      NOW + 300,
      '{}',
    );
    insertHeartbeat.run(
      'worker-heartbeat-filter-type',
      'maintenance',
      'error',
      null,
      NOW + 300,
      '{}',
    );
    insertHeartbeat.run(
      `worker-heartbeat-a-${platformId}`,
      workerType,
      'error',
      jobId,
      NOW + 200,
      JSON.stringify({
        nested: {
          token: 'token=abcdefghijklmnop',
          user_id: Number(platformId),
        },
      }),
    );
    insertHeartbeat.run(
      `worker-heartbeat-b-${platformId}`,
      workerType,
      'error',
      null,
      NOW + 200,
      `not-json password=${secret} user=${platformId}`,
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const hidden = await service.listWorkerHeartbeats({
      workerId: `worker-heartbeat-a-${platformId}`,
      workerType,
      status: 'error',
      limit: 1,
    });
    expect(hidden).toEqual([{
      workerId: 'worker-heartbeat-a-[REDACTED:platform_id]',
      workerType: 'background-[REDACTED:platform_id]',
      status: 'error',
      currentJobId: 'job-heartbeat-query-[REDACTED:platform_id]',
      heartbeatAt: new Date(NOW + 200),
      details: undefined,
    }]);

    const included = await service.listWorkerHeartbeats({
      workerType,
      status: 'error',
      includeDetails: true,
      limit: 2,
    });
    expect(included).toEqual([
      {
        workerId: 'worker-heartbeat-a-[REDACTED:platform_id]',
        workerType: 'background-[REDACTED:platform_id]',
        status: 'error',
        currentJobId: 'job-heartbeat-query-[REDACTED:platform_id]',
        heartbeatAt: new Date(NOW + 200),
        details: {
          nested: {
            token: '[REDACTED:token_assignment]',
            user_id: '[REDACTED:platform_id]',
          },
        },
      },
      {
        workerId: 'worker-heartbeat-b-[REDACTED:platform_id]',
        workerType: 'background-[REDACTED:platform_id]',
        status: 'error',
        currentJobId: undefined,
        heartbeatAt: new Date(NOW + 200),
        details: 'not-json [REDACTED:password_assignment] user=[REDACTED:platform_id]',
      },
    ]);
    expect(JSON.stringify(included)).not.toContain(secret);
    expect(JSON.stringify(included)).not.toContain(platformId);

    const defaultWindow = await service.listWorkerHeartbeats();
    expect(defaultWindow).toHaveLength(100);
    expect(defaultWindow.slice(0, 4).map((heartbeat) => heartbeat.workerId)).toEqual([
      'worker-heartbeat-filter-status',
      'worker-heartbeat-filter-type',
      'worker-heartbeat-a-[REDACTED:platform_id]',
      'worker-heartbeat-b-[REDACTED:platform_id]',
    ]);
    expect(defaultWindow.some((heartbeat) => heartbeat.workerId === 'worker-heartbeat-filler-000')).toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns bounded event-failure inspection with exact filters, ordering, and details redaction', async () => {
    const platformId = '678901234';
    const secret = 'eventfailurequerysecret';
    const stage = `provider-${platformId}`;
    const rawEventId = `raw-event-failure-${platformId}`;
    const turnId = `turn-event-failure-${platformId}`;
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', 'private:query', '{}', ?),
                (?, 'chat.message.received', ?, 'gateway', 'qq', 'private:other', '{}', ?)`,
    ).run(rawEventId, NOW, NOW, 'raw-event-failure-other', NOW, NOW);
    db.prepare(
      `INSERT INTO agent_turns (
         id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
       ) VALUES (?, 'private:query', ?, 'synthetic-model', 'synthetic-provider', 'failed', ?),
                (?, 'private:other', ?, 'synthetic-model', 'synthetic-provider', 'failed', ?)`,
    ).run(
      turnId,
      rawEventId,
      NOW,
      'turn-event-failure-other',
      'raw-event-failure-other',
      NOW,
    );
    const insertFailure = db.prepare(
      `INSERT INTO event_processing_failures (
         id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
         error_name, error_message_hash, message_id_hash, sender_id_hash,
         conversation_id_hash, details
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      insertFailure.run(
        `event-failure-filler-${String(index).padStart(3, '0')}`,
        null,
        null,
        NOW + index,
        'filler',
        null,
        'FillerFailure',
        `hash-filler-${index}`,
        null,
        null,
        null,
        '{}',
      );
    }
    insertFailure.run(
      'event-failure-query-filter-stage',
      rawEventId,
      turnId,
      NOW + 300,
      'context',
      'private',
      'ContextFailure',
      'hash-filter-stage',
      null,
      null,
      null,
      '{}',
    );
    insertFailure.run(
      'event-failure-query-filter-raw',
      'raw-event-failure-other',
      turnId,
      NOW + 300,
      stage,
      'private',
      'ProviderFailure',
      'hash-filter-raw',
      null,
      null,
      null,
      '{}',
    );
    insertFailure.run(
      'event-failure-query-filter-turn',
      rawEventId,
      'turn-event-failure-other',
      NOW + 300,
      stage,
      'private',
      'ProviderFailure',
      'hash-filter-turn',
      null,
      null,
      null,
      '{}',
    );
    insertFailure.run(
      `event-failure-query-a-${platformId}`,
      rawEventId,
      turnId,
      NOW + 200,
      stage,
      'private',
      `ProviderFailure-${platformId}-password=${secret}`,
      'hash-a',
      'message-hash-a',
      'sender-hash-a',
      'conversation-hash-a',
      JSON.stringify({
        nested: {
          token: 'token=abcdefghijklmnop',
          user_id: Number(platformId),
        },
      }),
    );
    insertFailure.run(
      `event-failure-query-b-${platformId}`,
      rawEventId,
      turnId,
      NOW + 200,
      stage,
      null,
      `ProviderFailure-${platformId}`,
      'hash-b',
      null,
      null,
      null,
      `not-json password=${secret} user=${platformId}`,
    );
    insertFailure.run(
      'event-failure-query-nullable',
      null,
      null,
      NOW + 400,
      'nullable',
      null,
      'NullableFailure',
      'hash-nullable',
      null,
      null,
      null,
      '{}',
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const hidden = await service.listEventProcessingFailures({
      stage,
      rawEventId,
      turnId,
      limit: 1,
    });
    expect(hidden).toEqual([{
      id: 'event-failure-query-b-[REDACTED:platform_id]',
      rawEventId: 'raw-event-failure-[REDACTED:platform_id]',
      turnId: 'turn-event-failure-[REDACTED:platform_id]',
      occurredAt: new Date(NOW + 200),
      stage: 'provider-[REDACTED:platform_id]',
      conversationType: undefined,
      errorName: 'ProviderFailure-[REDACTED:platform_id]',
      errorMessageHash: 'hash-b',
      messageIdHash: undefined,
      senderIdHash: undefined,
      conversationIdHash: undefined,
      details: undefined,
    }]);

    const included = await service.listEventProcessingFailures({
      stage,
      rawEventId,
      turnId,
      includeDetails: true,
      limit: 2,
    });
    expect(included).toEqual([
      {
        ...hidden[0],
        details: 'not-json [REDACTED:password_assignment] user=[REDACTED:platform_id]',
      },
      {
        id: 'event-failure-query-a-[REDACTED:platform_id]',
        rawEventId: 'raw-event-failure-[REDACTED:platform_id]',
        turnId: 'turn-event-failure-[REDACTED:platform_id]',
        occurredAt: new Date(NOW + 200),
        stage: 'provider-[REDACTED:platform_id]',
        conversationType: 'private',
        errorName: 'ProviderFailure-[REDACTED:platform_id]-[REDACTED:password_assignment]',
        errorMessageHash: 'hash-a',
        messageIdHash: 'message-hash-a',
        senderIdHash: 'sender-hash-a',
        conversationIdHash: 'conversation-hash-a',
        details: {
          nested: {
            token: '[REDACTED:token_assignment]',
            user_id: '[REDACTED:platform_id]',
          },
        },
      },
    ]);
    expect(JSON.stringify(included)).not.toContain(secret);
    expect(JSON.stringify(included)).not.toContain(platformId);

    const nullable = await service.listEventProcessingFailures({ stage: 'nullable' });
    expect(nullable).toEqual([{
      id: 'event-failure-query-nullable',
      rawEventId: undefined,
      turnId: undefined,
      occurredAt: new Date(NOW + 400),
      stage: 'nullable',
      conversationType: undefined,
      errorName: 'NullableFailure',
      errorMessageHash: 'hash-nullable',
      messageIdHash: undefined,
      senderIdHash: undefined,
      conversationIdHash: undefined,
      details: undefined,
    }]);

    const defaultWindow = await service.listEventProcessingFailures();
    expect(defaultWindow).toHaveLength(100);
    expect(defaultWindow.slice(0, 6).map((failure) => failure.id)).toEqual([
      'event-failure-query-nullable',
      'event-failure-query-filter-turn',
      'event-failure-query-filter-stage',
      'event-failure-query-filter-raw',
      'event-failure-query-b-[REDACTED:platform_id]',
      'event-failure-query-a-[REDACTED:platform_id]',
    ]);
    expect(defaultWindow.some((failure) => failure.id === 'event-failure-filler-000')).toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns bounded privacy-preference inspection with exact filters, ordering, and redaction', async () => {
    const platformId = '789012345';
    const secret = 'privacypreferencequerysecret';
    const targetUserId = `user-${platformId}-password=${secret}`;
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    const insertPreference = db.prepare(
      `INSERT INTO privacy_preferences (
         canonical_user_id, preference_type, state, reason,
         updated_by_user_id, updated_by_actor_class, updated_by_context,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      const userId = `privacy-filler-${String(index).padStart(3, '0')}`;
      insertUser.run(userId, NOW, NOW);
      insertPreference.run(
        userId,
        'proactive_dm',
        'opted_in',
        null,
        null,
        'admin',
        'admin_cli',
        NOW,
        NOW + index,
      );
    }
    for (const userId of [targetUserId, 'privacy-order-a', 'privacy-order-b', 'privacy-nullable']) {
      insertUser.run(userId, NOW, NOW);
    }
    insertPreference.run(
      targetUserId,
      'memory_association',
      'opted_out',
      `password=${secret} user=${platformId}`,
      `admin-${platformId}`,
      `admin-${platformId}`,
      `admin_cli password=${secret}`,
      NOW + 10,
      NOW + 200,
    );
    insertPreference.run(
      targetUserId,
      'proactive_dm',
      'opted_out',
      'ordinary target distractor',
      null,
      'admin',
      'admin_cli',
      NOW + 10,
      NOW + 200,
    );
    insertPreference.run(
      'privacy-order-a',
      'memory_association',
      'opted_out',
      'order a memory',
      null,
      'admin',
      'admin_cli',
      NOW + 20,
      NOW + 300,
    );
    insertPreference.run(
      'privacy-order-a',
      'proactive_dm',
      'opted_out',
      'order a proactive',
      null,
      'admin',
      'admin_cli',
      NOW + 20,
      NOW + 300,
    );
    insertPreference.run(
      'privacy-order-b',
      'proactive_dm',
      'opted_in',
      'order b proactive',
      null,
      'admin',
      'admin_cli',
      NOW + 20,
      NOW + 300,
    );
    insertPreference.run(
      'privacy-nullable',
      'memory_association',
      'opted_in',
      null,
      null,
      'admin',
      'admin_cli',
      NOW + 30,
      NOW + 400,
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const filtered = await service.listPrivacyPreferences({
      canonicalUserId: targetUserId,
      preferenceType: 'memory_association',
      state: 'opted_out',
      limit: 1,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({
      preferenceType: 'memory_association',
      state: 'opted_out',
      createdAt: new Date(NOW + 10),
      updatedAt: new Date(NOW + 200),
    });
    expect(filtered[0]?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(filtered[0]?.reason).toContain('[REDACTED:password_assignment]');
    expect(filtered[0]?.updatedBy?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(filtered[0]?.updatedBy?.actorClass).toContain('[REDACTED:platform_id]');
    expect(filtered[0]?.updatedBy?.context).toContain('[REDACTED:password_assignment]');
    expect(JSON.stringify(filtered)).not.toContain(secret);
    expect(JSON.stringify(filtered)).not.toContain(platformId);

    const nullable = await service.listPrivacyPreferences({
      canonicalUserId: 'privacy-nullable',
    });
    expect(nullable).toEqual([{
      canonicalUserId: 'privacy-nullable',
      preferenceType: 'memory_association',
      state: 'opted_in',
      reason: undefined,
      updatedBy: {
        canonicalUserId: undefined,
        actorClass: 'admin',
        context: 'admin_cli',
      },
      createdAt: new Date(NOW + 30),
      updatedAt: new Date(NOW + 400),
    }]);

    const limited = await service.listPrivacyPreferences({ limit: 4 });
    expect(limited.map((preference) => [
      preference.canonicalUserId,
      preference.preferenceType,
    ])).toEqual([
      ['privacy-nullable', 'memory_association'],
      ['privacy-order-a', 'memory_association'],
      ['privacy-order-a', 'proactive_dm'],
      ['privacy-order-b', 'proactive_dm'],
    ]);
    const defaultWindow = await service.listPrivacyPreferences();
    expect(defaultWindow).toHaveLength(100);
    expect(defaultWindow.some(
      (preference) => preference.canonicalUserId === 'privacy-filler-000',
    )).toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('projects exact-group summary policy status without identifiers or writes', async () => {
    const enabledGroupId = 'qq-group-456789012';
    const disabledGroupId = 'qq-group-567890123';
    const insertPolicy = db.prepare(
      `INSERT INTO group_summary_policies (
         group_id, state, generation, eligible_after, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertPolicy.run(enabledGroupId, 'enabled', 3, NOW + 20, NOW + 10, NOW + 30);
    insertPolicy.run(disabledGroupId, 'disabled', 4, null, NOW + 40, NOW + 50);
    const totalChanges = db.prepare('SELECT total_changes()').pluck();
    const changesBefore = totalChanges.get();
    const service = new GovernanceQueryService(db);

    const enabled = await service.getGroupSummaryPolicyForScope({
      kind: 'group',
      groupId: enabledGroupId,
    });
    const disabled = await service.getGroupSummaryPolicyForScope({
      kind: 'group',
      groupId: disabledGroupId,
    });
    const absent = await service.getGroupSummaryPolicyForScope({
      kind: 'group',
      groupId: 'qq-group-678901234',
    });

    expect(enabled).toEqual({
      state: 'enabled',
      stored: true,
      generation: 3,
      eligibleAfter: new Date(NOW + 20),
      createdAt: new Date(NOW + 10),
      updatedAt: new Date(NOW + 30),
    });
    expect(disabled).toEqual({
      state: 'disabled',
      stored: true,
      generation: 4,
      eligibleAfter: null,
      createdAt: new Date(NOW + 40),
      updatedAt: new Date(NOW + 50),
    });
    expect(absent).toEqual({
      state: 'disabled',
      stored: false,
      generation: null,
      eligibleAfter: null,
      createdAt: null,
      updatedAt: null,
    });
    const serialized = JSON.stringify([enabled, disabled, absent]);
    expect(serialized).not.toContain(enabledGroupId);
    expect(serialized).not.toContain(disabledGroupId);

    const prepare = vi.spyOn(db, 'prepare');
    const invalidScopes: unknown[] = [
      null,
      { kind: 'global' },
      { kind: 'user', canonicalUserId: enabledGroupId },
      { kind: 'group' },
      { kind: 'group', groupId: 123 },
      { kind: 'group', groupId: '' },
      { kind: 'group', groupId: ' padded-group' },
      { kind: 'group', groupId: 'group-with-control\n' },
      { kind: 'group', groupId: 'g'.repeat(257) },
    ];
    for (const scope of invalidScopes) {
      await expect(service.getGroupSummaryPolicyForScope(
        scope as Parameters<typeof service.getGroupSummaryPolicyForScope>[0],
      )).resolves.toBeNull();
    }
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();

    expect(totalChanges.get()).toBe(changesBefore);

    db.pragma('ignore_check_constraints = ON');
    insertPolicy.run('malformed-group', 'enabled', 0, null, NOW, NOW);
    db.pragma('ignore_check_constraints = OFF');
    const malformedChangesBefore = totalChanges.get();
    await expect(service.getGroupSummaryPolicyForScope({
      kind: 'group',
      groupId: 'malformed-group',
    })).resolves.toBeNull();
    expect(totalChanges.get()).toBe(malformedChangesBefore);
    db.prepare('DELETE FROM group_summary_policies WHERE group_id = ?').run('malformed-group');

    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('previews exact-group summary-policy changes without identifiers or writes', async () => {
    type PolicyState = 'enabled' | 'disabled';
    type PreviewService = GovernanceQueryService & {
      getGroupSummaryPolicyChangePreviewForScope(input: {
        scope: Parameters<GovernanceQueryService['getGroupSummaryPolicyForScope']>[0];
        targetState: PolicyState;
      }): Promise<GroupSummaryPolicyChangePreviewProjection | null>;
    };

    const enabledGroupId = 'qq-group-23456';
    const disabledGroupId = 'qq-group-34567';
    const absentGroupId = 'qq-group-45678';
    const exhaustedGroupId = 'qq-group-56789';
    const secret = 'sk-summarypolicypreviewabcdefghijklmnopqrstuvwxyz1234';
    const insertPolicy = db.prepare(
      `INSERT INTO group_summary_policies (
         group_id, state, generation, eligible_after, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertPolicy.run(enabledGroupId, 'enabled', 3, NOW + 20, NOW + 10, NOW + 30);
    insertPolicy.run(disabledGroupId, 'disabled', 4, null, NOW + 40, NOW + 50);
    insertPolicy.run(
      exhaustedGroupId,
      'enabled',
      Number.MAX_SAFE_INTEGER,
      NOW + 60,
      NOW + 60,
      NOW + 70,
    );
    const service = new GovernanceQueryService(db) as PreviewService;
    const statusRead = vi.spyOn(service, 'getGroupSummaryPolicyForScope');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const auditsBefore = db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get();

    await expect(service.getGroupSummaryPolicyChangePreviewForScope({
      scope: { kind: 'group', groupId: enabledGroupId },
      targetState: 'paused' as PolicyState,
    })).resolves.toBeNull();
    expect(statusRead).not.toHaveBeenCalled();

    await expect(service.getGroupSummaryPolicyChangePreviewForScope({
      scope: { kind: 'global' },
      targetState: 'enabled',
    })).resolves.toBeNull();
    await expect(service.getGroupSummaryPolicyChangePreviewForScope({
      scope: { kind: 'group', groupId: enabledGroupId },
      targetState: 'enabled',
    })).resolves.toBeNull();
    await expect(service.getGroupSummaryPolicyChangePreviewForScope({
      scope: { kind: 'group', groupId: disabledGroupId },
      targetState: 'disabled',
    })).resolves.toBeNull();
    await expect(service.getGroupSummaryPolicyChangePreviewForScope({
      scope: { kind: 'group', groupId: exhaustedGroupId },
      targetState: 'disabled',
    })).resolves.toBeNull();

    const defaultOff = await service.getGroupSummaryPolicyChangePreviewForScope({
      scope: { kind: 'group', groupId: absentGroupId },
      targetState: 'enabled',
    });
    const enable = await service.getGroupSummaryPolicyChangePreviewForScope({
      scope: { kind: 'group', groupId: disabledGroupId },
      targetState: 'enabled',
    });
    const disable = await service.getGroupSummaryPolicyChangePreviewForScope({
      scope: { kind: 'group', groupId: enabledGroupId },
      targetState: 'disabled',
    });

    expect(defaultOff).toEqual({
      action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
      current: {
        state: 'disabled',
        stored: false,
        version: { generation: null, updatedAt: null },
      },
      expected: {
        state: 'enabled',
        generation: 1,
        durableEffects: ['group_summary_policy_upsert', 'audit_event_append'],
        enforcementConsequences: [
          'policy_generation_advanced',
          'pre_enable_sources_excluded',
          'group_summary_generation_and_retrieval_enabled',
        ],
      },
      rollback: {
        supported: true,
        targetState: 'disabled',
        boundary: 'separate_group_summary_policy_change_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(enable).toEqual({
      action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
      current: {
        state: 'disabled',
        stored: true,
        version: { generation: 4, updatedAt: new Date(NOW + 50) },
      },
      expected: {
        state: 'enabled',
        generation: 5,
        durableEffects: ['group_summary_policy_upsert', 'audit_event_append'],
        enforcementConsequences: [
          'policy_generation_advanced',
          'pre_enable_sources_excluded',
          'group_summary_generation_and_retrieval_enabled',
        ],
      },
      rollback: {
        supported: true,
        targetState: 'disabled',
        boundary: 'separate_group_summary_policy_change_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(disable).toEqual({
      action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
      current: {
        state: 'enabled',
        stored: true,
        version: { generation: 3, updatedAt: new Date(NOW + 30) },
      },
      expected: {
        state: 'disabled',
        generation: 4,
        durableEffects: [
          'group_summary_policy_upsert',
          'pending_group_summary_jobs_terminalized',
          'audit_event_append',
        ],
        enforcementConsequences: [
          'policy_generation_advanced',
          'group_summary_generation_and_retrieval_disabled',
          'pending_group_summary_jobs_canceled',
        ],
      },
      rollback: {
        supported: true,
        targetState: 'enabled',
        boundary: 'separate_group_summary_policy_change_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    for (const preview of [defaultOff, enable, disable]) {
      expect(preview).not.toBeNull();
      if (!preview) continue;
      const { previewDigest, ...payload } = preview;
      expect(previewDigest).toBe(createHash('sha256')
        .update('lethebot-governance:group-summary-policy-change-preview:v1\0', 'utf8')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex'));
      expect(Object.keys(preview).sort()).toEqual([
        'action',
        'current',
        'expected',
        'previewDigest',
        'rollback',
      ]);
      const serialized = JSON.stringify(preview);
      for (const rawValue of [
        secret,
        enabledGroupId,
        disabledGroupId,
        absentGroupId,
        exhaustedGroupId,
      ]) {
        expect(serialized).not.toContain(rawValue);
      }
    }

    const repeated = await service.getGroupSummaryPolicyChangePreviewForScope({
      scope: { kind: 'group', groupId: enabledGroupId },
      targetState: 'disabled',
    });
    expect(JSON.stringify(repeated)).toBe(JSON.stringify(disable));
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(auditsBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues a bounded exact-group summary-policy scope catalog with isolated handles', async () => {
    const secret = 'sk-summarypolicycatalogabcdefghijklmnopqrstuvwxyz123456';
    const groupName = 'Synthetic private group name';
    const chatOnlyGroupId = 'qq-group-22222';
    const policyOnlyGroupId = 'qq-group-11111';
    const overlappingGroupId = 'qq-group-33333';
    const invalidPrivateGroupId = 'qq-group-44444';
    const invalidMismatchedGroupId = 'qq-group-55555';
    const insertRawEvent = db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', ?, ?, ?, ?)`,
    );
    const insertChatMessage = db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, text, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPolicy = db.prepare(
      `INSERT INTO group_summary_policies (
         group_id, state, generation, eligible_after, created_at, updated_at
       ) VALUES (?, ?, 1, ?, ?, ?)`,
    );
    let evidenceOrdinal = 0;
    const insertChatEvidence = (input: {
      groupId: string | Buffer | null;
      conversationId?: string | Buffer;
      conversationType?: 'private' | 'group';
      timestamp: number;
      platform?: string;
      text?: string;
    }): void => {
      const suffix = String(evidenceOrdinal).padStart(3, '0');
      evidenceOrdinal += 1;
      const rawEventId = `raw-summary-policy-catalog-${suffix}`;
      const messageId = `message-summary-policy-catalog-${suffix}`;
      const conversationId = input.conversationId ?? input.groupId ?? 'private-catalog';
      insertRawEvent.run(
        rawEventId,
        input.timestamp,
        input.platform ?? 'qq',
        conversationId,
        JSON.stringify({ groupName, token: secret }),
        input.timestamp,
      );
      insertChatMessage.run(
        messageId,
        rawEventId,
        messageId,
        conversationId,
        input.conversationType ?? 'group',
        input.groupId,
        'qq-user-synthetic',
        input.text ?? `${groupName} password=${secret}`,
        input.timestamp,
      );
    };
    const insertPolicyEvidence = (
      groupId: string,
      updatedAt: number,
      state: 'enabled' | 'disabled' = 'disabled',
    ): void => {
      insertPolicy.run(
        groupId,
        state,
        state === 'enabled' ? updatedAt - 1 : null,
        updatedAt - 2,
        updatedAt,
      );
    };

    insertChatEvidence({ groupId: chatOnlyGroupId, timestamp: NOW + 500 });
    insertChatEvidence({ groupId: chatOnlyGroupId, timestamp: NOW + 400 });
    insertPolicyEvidence(policyOnlyGroupId, NOW + 500, 'enabled');
    insertChatEvidence({ groupId: overlappingGroupId, timestamp: NOW + 600 });
    insertChatEvidence({ groupId: overlappingGroupId, timestamp: NOW + 550 });
    insertPolicyEvidence(overlappingGroupId, NOW + 575);

    insertChatEvidence({
      groupId: invalidPrivateGroupId,
      conversationType: 'private',
      timestamp: NOW + 10_000,
    });
    insertChatEvidence({
      groupId: invalidMismatchedGroupId,
      conversationId: 'qq-group-66666',
      timestamp: NOW + 10_001,
    });
    insertChatEvidence({ groupId: 'not-qq-group-77777', timestamp: NOW + 10_002 });
    insertChatEvidence({ groupId: ' qq-group-77777', timestamp: NOW + 10_003 });
    insertChatEvidence({ groupId: 'qq-group-77777\n', timestamp: NOW + 10_004 });
    insertChatEvidence({ groupId: 'qq-group-1234', timestamp: NOW + 10_005 });
    insertChatEvidence({ groupId: 'qq-group-1234567890123', timestamp: NOW + 10_006 });
    insertChatEvidence({ groupId: 'qq-group-1234a', timestamp: NOW + 10_007 });
    insertChatEvidence({ groupId: 'qq-group-01234', timestamp: NOW + 10_008 });
    insertChatEvidence({
      groupId: Buffer.from('qq-group-88888', 'utf8'),
      conversationId: Buffer.from('qq-group-88888', 'utf8'),
      timestamp: NOW + 10_009,
    });
    insertPolicyEvidence('not-qq-policy-99999', NOW + 20_000);
    insertPolicyEvidence('qq-group-9999', NOW + 20_001);
    insertPolicyEvidence('qq-group-1234567890123', NOW + 20_002);
    insertPolicyEvidence('qq-group-9999z', NOW + 20_003);
    insertPolicyEvidence('qq-group-99999\n', NOW + 20_004);
    insertPolicyEvidence('qq-group-02345', NOW + 20_005);
    db.pragma('ignore_check_constraints = ON');
    insertPolicy.run('qq-group-77777', 'enabled', null, NOW + 20_006, NOW + 20_006);
    db.pragma('ignore_check_constraints = OFF');

    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const sessionId = 'c'.repeat(64);
    const otherSessionId = 'd'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const readPurpose = 'governance.group_summary_policy.status.read';
    const registry = new GovernanceScopeHandleRegistry({ now: () => NOW });
    const issueHandle = vi.fn((scope: { kind: 'group'; groupId: string }) => ({
      ...registry.issue({
        sessionId,
        sessionExpiresAt,
        purpose: readPurpose,
        scope,
      }),
      rawScope: scope,
      ignoredGroupId: scope.groupId,
      ignoredSecret: secret,
      ignoredPolicyState: 'enabled',
    }));

    const catalog = await service.listGroupSummaryPolicyScopeHandles(issueHandle);
    const repeated = await service.listGroupSummaryPolicyScopeHandles(issueHandle);
    const expectedScopes = [
      { kind: 'group' as const, groupId: overlappingGroupId },
      { kind: 'group' as const, groupId: policyOnlyGroupId },
      { kind: 'group' as const, groupId: chatOnlyGroupId },
    ];

    expect(catalog).toEqual(repeated);
    expect(catalog).toEqual({
      entries: expectedScopes.map(() => ({
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
        scopeKind: 'group',
        label: 'Group summary policy',
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        expiresAt: sessionExpiresAt,
      })),
      truncated: false,
    });
    expect(issueHandle.mock.calls.map(([scope]) => scope)).toEqual([
      ...expectedScopes,
      ...expectedScopes,
    ]);
    expect(catalog.entries.map((entry) => entry.fingerprint)).toEqual(
      expectedScopes.map((scope) => createHash('sha256')
        .update('lethebot-governance:group-summary-policy-scope:v1\0', 'utf8')
        .update(JSON.stringify(scope), 'utf8')
        .digest('hex')
        .slice(0, 16)),
    );
    catalog.entries.forEach((entry, index) => {
      expect(Object.keys(entry).sort()).toEqual([
        'expiresAt',
        'fingerprint',
        'handle',
        'label',
        'scopeKind',
      ]);
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: readPurpose,
      })).toEqual(expectedScopes[index]);
      expect(registry.resolve({
        sessionId: otherSessionId,
        handle: entry.handle,
        purpose: readPurpose,
      })).toBeNull();
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'governance.group_summary_policy.change',
      })).toBeNull();
    });
    const serialized = JSON.stringify(catalog);
    for (const rawValue of [
      secret,
      groupName,
      sessionId,
      chatOnlyGroupId,
      policyOnlyGroupId,
      overlappingGroupId,
      invalidPrivateGroupId,
      invalidMismatchedGroupId,
      'enabled',
      'disabled',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    await expect(service.getGroupSummaryPolicyForScope(expectedScopes[2])).resolves.toEqual({
      state: 'disabled',
      stored: false,
      generation: null,
      eligibleAfter: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    db.prepare('DELETE FROM group_summary_policies WHERE group_id = ?').run('qq-group-77777');

    for (let index = 0; index < 97; index += 1) {
      insertChatEvidence({
        groupId: `qq-group-8${String(index).padStart(11, '0')}`,
        timestamp: NOW - index,
      });
    }
    const exactBoundChanges = db.prepare('SELECT total_changes()').pluck().get();
    const exactCallCount = issueHandle.mock.calls.length;
    const exactBound = await service.listGroupSummaryPolicyScopeHandles(issueHandle);
    expect(exactBound.entries).toHaveLength(100);
    expect(exactBound.truncated).toBe(false);
    expect(issueHandle.mock.calls).toHaveLength(exactCallCount + 100);
    expect(new Set(exactBound.entries.map((entry) => entry.fingerprint))).toHaveProperty(
      'size',
      100,
    );
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(exactBoundChanges);

    const duplicateGroupId = 'qq-group-800000000000';
    insertChatEvidence({ groupId: duplicateGroupId, timestamp: NOW + 700 });
    insertPolicyEvidence(duplicateGroupId, NOW + 650);
    const duplicateChanges = db.prepare('SELECT total_changes()').pluck().get();
    const duplicateCallCount = issueHandle.mock.calls.length;
    const deduplicated = await service.listGroupSummaryPolicyScopeHandles(issueHandle);
    expect(deduplicated.entries).toHaveLength(100);
    expect(deduplicated.truncated).toBe(false);
    expect(issueHandle.mock.calls).toHaveLength(duplicateCallCount + 100);
    expect(new Set(deduplicated.entries.map((entry) => entry.fingerprint))).toHaveProperty(
      'size',
      100,
    );
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(duplicateChanges);

    const overflowGroupId = 'qq-group-999999999999';
    insertPolicyEvidence(overflowGroupId, NOW - 100_000);
    const overflowChanges = db.prepare('SELECT total_changes()').pluck().get();
    const overflowCallCount = issueHandle.mock.calls.length;
    const bounded = await service.listGroupSummaryPolicyScopeHandles(issueHandle);
    const overflowIssuedScopes = issueHandle.mock.calls
      .slice(overflowCallCount)
      .map(([scope]) => scope);
    expect(bounded.entries).toHaveLength(100);
    expect(bounded.truncated).toBe(true);
    expect(overflowIssuedScopes).toHaveLength(100);
    expect(overflowIssuedScopes).not.toContainEqual({
      kind: 'group',
      groupId: overflowGroupId,
    });
    expect(JSON.stringify(bounded)).not.toContain('qq-group-');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(overflowChanges);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('projects an exact-user bounded privacy page without owner identifiers', async () => {
    const platformId = '456789012';
    const secret = 'scopedprivacypasswordsecret';
    const targetUserId = `privacy-scoped-user-${platformId}`;
    const updaterUserId = `privacy-updater-user-${platformId}`;
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    const insertPreference = db.prepare(
      `INSERT INTO privacy_preferences (
         canonical_user_id, preference_type, state, reason,
         updated_by_user_id, updated_by_actor_class, updated_by_context,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertUser.run(targetUserId, NOW, NOW);
    insertUser.run('privacy-scoped-empty', NOW, NOW);
    insertPreference.run(
      targetUserId,
      'memory_association',
      'opted_out',
      `password=${secret}`,
      updaterUserId,
      `admin-${platformId}`,
      `admin_cli password=${secret}`,
      NOW + 1,
      NOW + 2,
    );
    insertPreference.run(
      targetUserId,
      'proactive_dm',
      'opted_in',
      null,
      null,
      'admin',
      'admin_cli',
      NOW + 1,
      NOW + 1,
    );
    for (let index = 0; index < 101; index += 1) {
      const userId = `privacy-scoped-newer-${String(index).padStart(3, '0')}`;
      insertUser.run(userId, NOW + index + 10, NOW + index + 10);
      insertPreference.run(
        userId,
        'proactive_dm',
        'opted_in',
        null,
        null,
        'admin',
        'admin_cli',
        NOW + index + 10,
        NOW + index + 10,
      );
    }

    const service = new GovernanceQueryService(db);
    const listPrivacyPreferences = vi.spyOn(service, 'listPrivacyPreferences');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const page = await service.listPrivacyPreferencesForScope({
      kind: 'user',
      canonicalUserId: targetUserId,
    });

    expect(listPrivacyPreferences).toHaveBeenNthCalledWith(1, {
      canonicalUserId: targetUserId,
      limit: 101,
    });
    expect(page.truncated).toBe(false);
    expect(page.entries).toHaveLength(2);
    expect(page.entries.map((entry) => entry.preferenceType)).toEqual([
      'memory_association',
      'proactive_dm',
    ]);
    expect(page.entries[0]).toEqual({
      preferenceType: 'memory_association',
      state: 'opted_out',
      reason: '[REDACTED:password_assignment]',
      updatedBy: {
        actorClass: 'admin-[REDACTED:platform_id]',
        context: 'admin_cli [REDACTED:password_assignment]',
      },
      createdAt: new Date(NOW + 1),
      updatedAt: new Date(NOW + 2),
    });
    expect(Object.keys(page.entries[1] ?? {}).sort()).toEqual([
      'createdAt',
      'preferenceType',
      'reason',
      'state',
      'updatedAt',
      'updatedBy',
    ]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(targetUserId);
    expect(serialized).not.toContain(updaterUserId);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(secret);

    listPrivacyPreferences.mockClear();
    await expect(service.listPrivacyPreferencesForScope({ kind: 'global' })).resolves.toEqual({
      entries: [],
      truncated: false,
    });
    expect(listPrivacyPreferences).not.toHaveBeenCalled();

    await expect(service.listPrivacyPreferencesForScope({
      kind: 'user',
      canonicalUserId: 'privacy-scoped-empty',
    })).resolves.toEqual({ entries: [], truncated: false });
    expect(listPrivacyPreferences).toHaveBeenLastCalledWith({
      canonicalUserId: 'privacy-scoped-empty',
      limit: 101,
    });

    const boundedRows = Array.from({ length: 101 }, (_, index) => ({
      canonicalUserId: `hidden-owner-${index}`,
      preferenceType: 'proactive_dm',
      state: 'opted_in',
      reason: undefined,
      updatedBy: {
        canonicalUserId: `hidden-updater-${index}`,
        actorClass: 'admin',
        context: 'admin_cli',
      },
      createdAt: new Date(NOW + index),
      updatedAt: new Date(NOW + index),
    }));
    listPrivacyPreferences.mockResolvedValueOnce(boundedRows);
    const bounded = await service.listPrivacyPreferencesForScope({
      kind: 'user',
      canonicalUserId: targetUserId,
    });
    expect(bounded.entries).toHaveLength(100);
    expect(bounded.truncated).toBe(true);
    expect(JSON.stringify(bounded)).not.toContain('hidden-owner');
    expect(JSON.stringify(bounded)).not.toContain('hidden-updater');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('projects an exact-user privacy preference change without writes or identifiers', async () => {
    const platformId = '567890123';
    const secret = 'sk-privacy-preview-abcdefghijklmnopqrstuvwxyz';
    const defaultUserId = `privacy-preview-default-${platformId}`;
    const storedUserId = `privacy-preview-stored-${platformId}`;
    const malformedStateUserId = 'privacy-preview-malformed-state';
    const unsafeTimeUserId = 'privacy-preview-unsafe-time';
    const malformedScopeUserId = ' privacy-preview-malformed-scope ';
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    for (const userId of [
      defaultUserId,
      storedUserId,
      malformedStateUserId,
      unsafeTimeUserId,
      malformedScopeUserId,
    ]) {
      insertUser.run(userId, NOW, NOW);
    }
    const insertPreference = db.prepare(
      `INSERT INTO privacy_preferences (
         canonical_user_id, preference_type, state, reason,
         updated_by_user_id, updated_by_actor_class, updated_by_context,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertPreference.run(
      storedUserId,
      'proactive_dm',
      'opted_out',
      `password=${secret}`,
      `privacy-preview-updater-${platformId}`,
      'admin',
      `admin_cli password=${secret}`,
      NOW + 10,
      NOW + 20,
    );
    insertPreference.run(
      storedUserId,
      'memory_association',
      'opted_in',
      'Synthetic stored opt-in',
      null,
      'admin',
      'admin_cli',
      NOW + 30,
      NOW + 40,
    );
    db.pragma('ignore_check_constraints = ON');
    insertPreference.run(
      malformedStateUserId,
      'proactive_dm',
      'invalid_state',
      null,
      null,
      'admin',
      'admin_cli',
      NOW,
      NOW,
    );
    insertPreference.run(
      unsafeTimeUserId,
      'proactive_dm',
      'opted_out',
      null,
      null,
      'admin',
      'admin_cli',
      NOW,
      Number.MAX_SAFE_INTEGER,
    );
    db.pragma('ignore_check_constraints = OFF');

    const service = new GovernanceQueryService(db);
    const listPrivacyPreferences = vi.spyOn(service, 'listPrivacyPreferences');
    const listPrivacyPreferencesForScope = vi.spyOn(
      service,
      'listPrivacyPreferencesForScope',
    );
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const digest = (payload: unknown) => createHash('sha256')
      .update('lethebot-governance:privacy-preference-change-preview:v1\0', 'utf8')
      .update(JSON.stringify(payload), 'utf8')
      .digest('hex');

    const defaultPreview = await service.getPrivacyPreferenceChangePreviewForScope({
      scope: { kind: 'user', canonicalUserId: defaultUserId },
      preferenceType: 'proactive_dm',
      targetState: 'opted_out',
    });
    const repeatedDefaultPreview = await service.getPrivacyPreferenceChangePreviewForScope({
      scope: { kind: 'user', canonicalUserId: defaultUserId },
      preferenceType: 'proactive_dm',
      targetState: 'opted_out',
    });
    const expectedDefaultPayload = {
      action: 'privacy.preference.change',
      preferenceType: 'proactive_dm',
      current: {
        state: 'opted_in',
        version: {
          source: 'implicit_default',
          updatedAt: null,
        },
      },
      expected: {
        state: 'opted_out',
        durableEffects: [
          'privacy_preference_upsert',
          'audit_event_append',
        ],
        enforcementConsequences: ['preference_enforced_immediately'],
      },
      rollback: {
        supported: true,
        targetState: 'opted_in',
        boundary: 'separate_preference_change_confirmation_required',
      },
    } as const;
    expect(defaultPreview).toEqual({
      ...expectedDefaultPayload,
      previewDigest: digest(expectedDefaultPayload),
    });
    expect(repeatedDefaultPreview).toEqual(defaultPreview);

    const storedOptInPreview = await service.getPrivacyPreferenceChangePreviewForScope({
      scope: { kind: 'user', canonicalUserId: storedUserId },
      preferenceType: 'memory_association',
      targetState: 'opted_out',
    });
    const expectedStoredOptInPayload = {
      action: 'privacy.preference.change',
      preferenceType: 'memory_association',
      current: {
        state: 'opted_in',
        version: {
          source: 'stored_preference',
          updatedAt: NOW + 40,
        },
      },
      expected: {
        state: 'opted_out',
        durableEffects: [
          'privacy_preference_upsert',
          'audit_event_append',
        ],
        enforcementConsequences: ['preference_enforced_immediately'],
      },
      rollback: {
        supported: true,
        targetState: 'opted_in',
        boundary: 'separate_preference_change_confirmation_required',
      },
    } as const;
    expect(storedOptInPreview).toEqual({
      ...expectedStoredOptInPayload,
      previewDigest: digest(expectedStoredOptInPayload),
    });

    const storedOptOutPreview = await service.getPrivacyPreferenceChangePreviewForScope({
      scope: { kind: 'user', canonicalUserId: storedUserId },
      preferenceType: 'proactive_dm',
      targetState: 'opted_in',
    });
    expect(storedOptOutPreview).toMatchObject({
      action: 'privacy.preference.change',
      preferenceType: 'proactive_dm',
      current: {
        state: 'opted_out',
        version: {
          source: 'stored_preference',
          updatedAt: NOW + 20,
        },
      },
      expected: { state: 'opted_in' },
      rollback: { targetState: 'opted_out' },
    });
    expect(Object.keys(storedOptOutPreview ?? {}).sort()).toEqual([
      'action',
      'current',
      'expected',
      'preferenceType',
      'previewDigest',
      'rollback',
    ]);

    for (const input of [
      {
        scope: { kind: 'global' } as const,
        preferenceType: 'proactive_dm' as const,
        targetState: 'opted_out' as const,
      },
      {
        scope: { kind: 'user', canonicalUserId: 'privacy-preview-missing' } as const,
        preferenceType: 'proactive_dm' as const,
        targetState: 'opted_out' as const,
      },
      {
        scope: { kind: 'user', canonicalUserId: malformedScopeUserId } as const,
        preferenceType: 'proactive_dm' as const,
        targetState: 'opted_out' as const,
      },
      {
        scope: { kind: 'user', canonicalUserId: defaultUserId } as const,
        preferenceType: 'proactive_dm' as const,
        targetState: 'opted_in' as const,
      },
      {
        scope: { kind: 'user', canonicalUserId: storedUserId } as const,
        preferenceType: 'proactive_dm' as const,
        targetState: 'opted_out' as const,
      },
      {
        scope: { kind: 'user', canonicalUserId: storedUserId } as const,
        preferenceType: 'memory_association' as const,
        targetState: 'opted_in' as const,
      },
      {
        scope: { kind: 'user', canonicalUserId: malformedStateUserId } as const,
        preferenceType: 'proactive_dm' as const,
        targetState: 'opted_out' as const,
      },
      {
        scope: { kind: 'user', canonicalUserId: unsafeTimeUserId } as const,
        preferenceType: 'proactive_dm' as const,
        targetState: 'opted_in' as const,
      },
    ]) {
      await expect(
        service.getPrivacyPreferenceChangePreviewForScope(input),
      ).resolves.toBeNull();
    }
    await expect(service.getPrivacyPreferenceChangePreviewForScope({
      scope: { kind: 'user', canonicalUserId: defaultUserId },
      preferenceType: 'unsupported' as never,
      targetState: 'opted_out',
    })).resolves.toBeNull();
    await expect(service.getPrivacyPreferenceChangePreviewForScope({
      scope: { kind: 'user', canonicalUserId: defaultUserId },
      preferenceType: 'proactive_dm',
      targetState: 'unsupported' as never,
    })).resolves.toBeNull();

    const serialized = JSON.stringify({
      defaultPreview,
      repeatedDefaultPreview,
      storedOptInPreview,
      storedOptOutPreview,
    });
    for (const rawValue of [
      platformId,
      secret,
      defaultUserId,
      storedUserId,
      `privacy-preview-updater-${platformId}`,
      'Synthetic stored opt-in',
      'admin_cli',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(listPrivacyPreferences).not.toHaveBeenCalled();
    expect(listPrivacyPreferencesForScope).not.toHaveBeenCalled();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    db.prepare(
      `DELETE FROM privacy_preferences
        WHERE canonical_user_id = ? AND preference_type = ?`,
    ).run(malformedStateUserId, 'proactive_dm');
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('owns the stored Explain projection without writes or reshaping', async () => {
    const now = NOW + 500;
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'raw-shared-explain',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'group:shared-explain',
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'turn-shared-explain',
      'group:shared-explain',
      'raw-shared-explain',
      'ctx-shared-explain',
      'mock-model',
      'mock-provider',
      'completed',
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
      'ctx-shared-explain',
      'turn-shared-explain',
      'group:shared-explain',
      'group',
      'group-shared-explain',
      JSON.stringify(['memory-candidate']),
      JSON.stringify(['memory-selected']),
      JSON.stringify([{ memoryId: 'memory-rejected', reason: 'scope_filter' }]),
      JSON.stringify(['state=active', 'exact_group']),
      JSON.stringify(['current_message']),
      JSON.stringify(['message-shared-explain']),
      JSON.stringify({
        max: 8000,
        used: 321,
        breakdown: { recentMessages: 21, memory: 100, identity: 0, system: 200 },
      }),
      JSON.stringify([{
        memoryId: 'memory-selected',
        scope: 'group',
        kind: 'fact',
        title: 'Stored explain memory',
        sourceContext: 'synthetic',
      }]),
      now,
    );
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const result = await service.explainStoredContext('turn-shared-explain');

    expect(result).toEqual({
      turnId: 'turn-shared-explain',
      contextPackId: 'ctx-shared-explain',
      traceSource: 'stored',
      conversation: {
        conversationId: 'group:shared-explain',
        conversationType: 'group',
        groupId: 'group-shared-explain',
      },
      selectedMemoryIds: ['memory-selected'],
      candidateMemoryIds: ['memory-candidate'],
      rejectedMemories: [{ memoryId: 'memory-rejected', reason: 'scope_filter' }],
      filtersApplied: ['state=active', 'exact_group'],
      injectedIdentityFields: ['current_message'],
      recentMessageIds: ['message-shared-explain'],
      tokenBudget: {
        max: 8000,
        used: 321,
        breakdown: { recentMessages: 21, memory: 100, identity: 0, system: 200 },
      },
      memories: [{
        memoryId: 'memory-selected',
        scope: 'group',
        kind: 'fact',
        title: 'Stored explain memory',
        sourceContext: 'synthetic',
      }],
    });
    expect(await service.explainStoredContext('missing-shared-explain')).toBeNull();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues a bounded Explain conversation-scope catalog from consistent stored traces', async () => {
    const platformId = '864209753';
    const secret = 'sk-explaincatalogabcdefghijklmnopqrstuvwxyz123456';
    const sharedConversationId = `explain-shared-${platformId}-${secret}`;
    const otherConversationId = `explain-other-${platformId}-${secret}`;
    const sharedGroupId = `explain-group-${platformId}-${secret}`;
    const otherGroupId = `explain-other-group-${platformId}-${secret}`;

    insertExplainConversationTrace(db, {
      id: 'valid-private-older',
      conversationId: sharedConversationId,
      conversationType: 'private',
      createdAt: NOW + 100,
    });
    insertExplainConversationTrace(db, {
      id: 'valid-private-newer',
      conversationId: sharedConversationId,
      conversationType: 'private',
      createdAt: NOW + 300,
    });
    insertExplainConversationTrace(db, {
      id: 'valid-group-shared',
      conversationId: sharedConversationId,
      conversationType: 'group',
      groupId: sharedGroupId,
      createdAt: NOW + 300,
    });
    insertExplainConversationTrace(db, {
      id: 'valid-group-other',
      conversationId: otherConversationId,
      conversationType: 'group',
      groupId: otherGroupId,
      createdAt: NOW + 200,
    });

    const trimCharacters = [
      ' ',
      '\u00a0',
      '\u1680',
      '\u2000',
      '\u2001',
      '\u2002',
      '\u2003',
      '\u2004',
      '\u2005',
      '\u2006',
      '\u2007',
      '\u2008',
      '\u2009',
      '\u200a',
      '\u2028',
      '\u2029',
      '\u202f',
      '\u205f',
      '\u3000',
      '\ufeff',
    ];
    trimCharacters.forEach((character, index) => {
      insertExplainConversationTrace(db, {
        id: `invalid-conversation-trim-${index}`,
        conversationId: `${character}padded-conversation-${index}${character}`,
        conversationType: 'private',
        createdAt: NOW + 1_000 + index,
      });
      insertExplainConversationTrace(db, {
        id: `invalid-group-trim-${index}`,
        conversationId: `valid-group-conversation-${index}`,
        conversationType: 'group',
        groupId: `${character}padded-group-${index}${character}`,
        createdAt: NOW + 2_000 + index,
      });
    });
    [...Array.from({ length: 32 }, (_, index) => index), 127].forEach((code) => {
      const control = String.fromCharCode(code);
      insertExplainConversationTrace(db, {
        id: `invalid-conversation-control-${code}`,
        conversationId: `control${control}conversation-${code}`,
        conversationType: 'private',
        createdAt: NOW + 3_000 + code,
      });
      insertExplainConversationTrace(db, {
        id: `invalid-group-control-${code}`,
        conversationId: `valid-control-group-conversation-${code}`,
        conversationType: 'group',
        groupId: `control${control}group-${code}`,
        createdAt: NOW + 4_000 + code,
      });
    });
    insertExplainConversationTrace(db, {
      id: 'invalid-conversation-blank',
      conversationId: '',
      conversationType: 'private',
      createdAt: NOW + 5_000,
    });
    insertExplainConversationTrace(db, {
      id: 'invalid-conversation-non-text',
      conversationId: Buffer.from('non-text-conversation', 'utf8'),
      conversationType: 'private',
      createdAt: NOW + 5_001,
    });
    insertExplainConversationTrace(db, {
      id: 'invalid-conversation-overlong',
      conversationId: 'c'.repeat(257),
      conversationType: 'private',
      createdAt: NOW + 5_002,
    });
    insertExplainConversationTrace(db, {
      id: 'invalid-group-missing',
      conversationId: 'invalid-group-missing-conversation',
      conversationType: 'group',
      groupId: null,
      createdAt: NOW + 5_003,
    });
    insertExplainConversationTrace(db, {
      id: 'invalid-group-non-text',
      conversationId: 'invalid-group-non-text-conversation',
      conversationType: 'group',
      groupId: Buffer.from('non-text-group', 'utf8'),
      createdAt: NOW + 5_004,
    });
    insertExplainConversationTrace(db, {
      id: 'invalid-group-overlong',
      conversationId: 'invalid-group-overlong-conversation',
      conversationType: 'group',
      groupId: 'g'.repeat(257),
      createdAt: NOW + 5_005,
    });
    insertExplainConversationTrace(db, {
      id: 'invalid-private-with-group',
      conversationId: 'invalid-private-with-group-conversation',
      conversationType: 'private',
      groupId: 'unexpected-private-group',
      createdAt: NOW + 5_006,
    });
    insertExplainConversationTrace(db, {
      id: 'invalid-trace-turn-mismatch',
      conversationId: 'trace-side-conversation',
      turnConversationId: 'turn-side-conversation',
      conversationType: 'private',
      createdAt: NOW + 5_007,
    });
    insertExplainConversationTrace(db, {
      id: 'turn-without-stored-trace',
      conversationId: 'turn-only-conversation',
      conversationType: 'private',
      createdAt: NOW + 5_008,
      storeTrace: false,
    });

    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const sessionId = 'f'.repeat(64);
    const otherSessionId = 'e'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const registry = new GovernanceScopeHandleRegistry({ now: () => NOW });
    const issueHandle = vi.fn((scope: ExplainConversationCatalogScope) => ({
      ...registry.issue({
        sessionId,
        sessionExpiresAt,
        purpose: 'governance.explain.turns.read',
        scope,
      }),
      ignoredScope: scope,
      ignoredSessionId: sessionId,
      ignoredSecret: secret,
    }));

    const catalog = await service.listExplainConversationScopeHandles(issueHandle);
    const repeated = await service.listExplainConversationScopeHandles(issueHandle);
    const expectedScopes: ExplainConversationCatalogScope[] = [
      {
        kind: 'conversation',
        conversationId: sharedConversationId,
        conversationType: 'private',
      },
      {
        kind: 'conversation',
        conversationId: sharedConversationId,
        conversationType: 'group',
        groupId: sharedGroupId,
      },
      {
        kind: 'conversation',
        conversationId: otherConversationId,
        conversationType: 'group',
        groupId: otherGroupId,
      },
    ];

    expect(catalog).toEqual(repeated);
    expect(catalog).toEqual({
      entries: [
        expect.objectContaining({
          scopeKind: 'conversation',
          conversationType: 'private',
          label: 'Private conversation',
        }),
        expect.objectContaining({
          scopeKind: 'conversation',
          conversationType: 'group',
          label: 'Group conversation',
        }),
        expect.objectContaining({
          scopeKind: 'conversation',
          conversationType: 'group',
          label: 'Group conversation',
        }),
      ],
      truncated: false,
    });
    expect(issueHandle.mock.calls.map(([scope]) => scope)).toEqual([
      ...expectedScopes,
      ...expectedScopes,
    ]);
    expect(catalog.entries.map((entry) => entry.fingerprint)).toEqual(
      expectedScopes.map((scope) => createHash('sha256')
        .update('lethebot-governance:explain-conversation-scope:v1\0', 'utf8')
        .update(JSON.stringify(scope), 'utf8')
        .digest('hex')
        .slice(0, 16)),
    );
    expect(catalog.entries.every((entry) => /^[A-Za-z0-9_-]{43}$/u.test(entry.handle)))
      .toBe(true);
    expect(catalog.entries.every((entry) => entry.expiresAt === sessionExpiresAt)).toBe(true);
    catalog.entries.forEach((entry, index) => {
      expect(Object.keys(entry).sort()).toEqual([
        'conversationType',
        'expiresAt',
        'fingerprint',
        'handle',
        'label',
        'scopeKind',
      ].sort());
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'governance.explain.turns.read',
      })).toEqual(expectedScopes[index]);
      expect(registry.resolve({
        sessionId: otherSessionId,
        handle: entry.handle,
        purpose: 'governance.explain.turns.read',
      })).toBeNull();
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'governance.memory.records.read',
      })).toBeNull();
    });
    const serialized = JSON.stringify(catalog);
    for (const rawValue of [
      secret,
      sessionId,
      platformId,
      sharedConversationId,
      otherConversationId,
      sharedGroupId,
      otherGroupId,
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    for (let index = 0; index < 97; index += 1) {
      insertExplainConversationTrace(db, {
        id: `bound-${String(index).padStart(3, '0')}`,
        conversationId: `explain-bound-${String(index).padStart(3, '0')}`,
        conversationType: 'private',
        createdAt: NOW - index,
      });
    }
    const exactBoundChanges = db.prepare('SELECT total_changes()').pluck().get();
    const exactBound = await service.listExplainConversationScopeHandles(issueHandle);
    expect(exactBound.entries).toHaveLength(100);
    expect(exactBound.truncated).toBe(false);
    expect(new Set(exactBound.entries.map((entry) => entry.fingerprint))).toHaveProperty(
      'size',
      100,
    );
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(exactBoundChanges);

    insertExplainConversationTrace(db, {
      id: 'bound-duplicate-newest',
      conversationId: 'explain-bound-000',
      conversationType: 'private',
      createdAt: NOW + 10_000,
    });
    const duplicateChanges = db.prepare('SELECT total_changes()').pluck().get();
    const deduplicated = await service.listExplainConversationScopeHandles(issueHandle);
    expect(deduplicated.entries).toHaveLength(100);
    expect(deduplicated.truncated).toBe(false);
    expect(new Set(deduplicated.entries.map((entry) => entry.fingerprint))).toHaveProperty(
      'size',
      100,
    );
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(duplicateChanges);

    insertExplainConversationTrace(db, {
      id: 'bound-overflow',
      conversationId: 'explain-bound-overflow',
      conversationType: 'private',
      createdAt: NOW + 20_000,
    });
    const overflowChanges = db.prepare('SELECT total_changes()').pluck().get();
    const bounded = await service.listExplainConversationScopeHandles(issueHandle);
    expect(bounded.entries).toHaveLength(100);
    expect(bounded.truncated).toBe(true);
    expect(new Set(bounded.entries.map((entry) => entry.fingerprint))).toHaveProperty('size', 100);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(overflowChanges);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('lists bounded identifier-free Explain turns inside one exact conversation scope', async () => {
    const platformId = '975318642';
    const secret = 'sk-explainturnabcdefghijklmnopqrstuvwxyz123456';
    const conversationId = `explain-turn-${platformId}-${secret}`;
    const groupId = `explain-turn-group-${platformId}-${secret}`;
    const otherGroupId = `explain-turn-other-group-${platformId}-${secret}`;
    const insertTurn = (input: {
      id: string;
      conversationType: 'private' | 'group';
      groupId?: string | null;
      turnConversationId?: string;
      startedAt: number;
      status?: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
      completedAt?: number | null;
      storeTrace?: boolean;
    }): string => {
      insertExplainConversationTrace(db, {
        id: input.id,
        conversationId,
        turnConversationId: input.turnConversationId,
        conversationType: input.conversationType,
        groupId: input.groupId,
        createdAt: input.startedAt,
        storeTrace: input.storeTrace,
      });
      const turnId = `turn-explain-catalog-${input.id}`;
      db.prepare(
        `UPDATE agent_turns
            SET status = ?, completed_at = ?, pi_model = ?, pi_provider = ?,
                response_text = ?, tokens_input = ?, tokens_output = ?, tokens_total = ?
          WHERE id = ?`,
      ).run(
        input.status ?? 'completed',
        input.completedAt ?? null,
        `model-${platformId}`,
        `provider-${secret}`,
        `response-${platformId}-${secret}`,
        11,
        12,
        23,
        turnId,
      );
      return turnId;
    };
    const fingerprint = (turnId: string): string => createHash('sha256')
      .update('lethebot-governance:explain-turn:v1\0', 'utf8')
      .update(turnId, 'utf8')
      .digest('hex')
      .slice(0, 16);

    const olderTurnId = insertTurn({
      id: 'page-private-older',
      conversationType: 'private',
      startedAt: NOW + 100,
      status: 'failed',
      completedAt: NOW + 150,
    });
    const newerTurnId = insertTurn({
      id: 'page-private-newer',
      conversationType: 'private',
      startedAt: NOW + 300,
      status: 'completed',
      completedAt: NOW + 350,
    });
    const tieATurnId = insertTurn({
      id: 'page-private-tie-a',
      conversationType: 'private',
      startedAt: NOW + 500,
      status: 'aborted',
      completedAt: NOW + 550,
    });
    const tieBTurnId = insertTurn({
      id: 'page-private-tie-b',
      conversationType: 'private',
      startedAt: NOW + 500,
      status: 'running',
    });
    const groupTurnId = insertTurn({
      id: 'page-group-collision',
      conversationType: 'group',
      groupId,
      startedAt: NOW + 400,
      status: 'completed',
      completedAt: NOW + 450,
    });
    insertTurn({
      id: 'page-other-group',
      conversationType: 'group',
      groupId: otherGroupId,
      startedAt: NOW + 900,
    });
    insertTurn({
      id: 'page-private-with-group',
      conversationType: 'private',
      groupId,
      startedAt: NOW + 1_000,
    });
    insertTurn({
      id: 'page-group-without-group',
      conversationType: 'group',
      groupId: null,
      startedAt: NOW + 1_100,
    });
    insertTurn({
      id: 'page-turn-mismatch',
      conversationType: 'private',
      turnConversationId: 'different-turn-conversation',
      startedAt: NOW + 1_200,
    });
    insertTurn({
      id: 'page-turn-without-trace',
      conversationType: 'private',
      startedAt: NOW + 1_300,
      storeTrace: false,
    });
    const invalidDateTurnId = insertTurn({
      id: 'page-invalid-date',
      conversationType: 'private',
      startedAt: NOW + 1_400,
    });
    db.prepare('UPDATE agent_turns SET started_at = ? WHERE id = ?')
      .run('not-a-date', invalidDateTurnId);
    db.prepare(
      `INSERT INTO context_traces (
         id, turn_id, conversation_id, conversation_type, group_id,
         candidate_memory_ids, selected_memory_ids, rejected_memories,
         filters_applied, injected_identity_fields, recent_message_ids,
         token_budget, memories, created_at
       ) VALUES (?, ?, ?, 'private', NULL, '[]', '[]', '[]', '[]', '[]', '[]', '{}', '[]', ?)`,
    ).run('trace-explain-page-duplicate', newerTurnId, conversationId, NOW + 2_000);
    const codePointConversationId = '\u{1f600}'.repeat(256);
    insertExplainConversationTrace(db, {
      id: 'page-code-point-boundary',
      conversationId: codePointConversationId,
      conversationType: 'private',
      createdAt: NOW + 1_600,
    });
    const codePointTurnId = 'turn-explain-catalog-page-code-point-boundary';

    const service = new GovernanceQueryService(db);
    const resolveExplainTurn = vi.spyOn(service, 'resolveExplainTurn');
    const explainStoredContext = vi.spyOn(service, 'explainStoredContext');
    const explainActionDecision = vi.spyOn(service, 'explainActionDecision');
    const explainToolCalls = vi.spyOn(service, 'explainToolCalls');
    const privateScope = {
      kind: 'conversation',
      conversationId,
      conversationType: 'private',
    } as const;
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const page = await service.listExplainTurnsForScope(privateScope);
    const repeated = await service.listExplainTurnsForScope(privateScope);

    expect(page).toEqual(repeated);
    expect(page).toEqual({
      entries: [
        {
          fingerprint: fingerprint(tieBTurnId),
          label: 'Turn',
          traceSource: 'stored',
          status: 'running',
          startedAt: new Date(NOW + 500),
        },
        {
          fingerprint: fingerprint(tieATurnId),
          label: 'Turn',
          traceSource: 'stored',
          status: 'aborted',
          startedAt: new Date(NOW + 500),
          completedAt: new Date(NOW + 550),
        },
        {
          fingerprint: fingerprint(newerTurnId),
          label: 'Turn',
          traceSource: 'stored',
          status: 'completed',
          startedAt: new Date(NOW + 300),
          completedAt: new Date(NOW + 350),
        },
        {
          fingerprint: fingerprint(olderTurnId),
          label: 'Turn',
          traceSource: 'stored',
          status: 'failed',
          startedAt: new Date(NOW + 100),
          completedAt: new Date(NOW + 150),
        },
      ],
      truncated: false,
    });
    expect(Object.keys(page).sort()).toEqual(['entries', 'truncated']);
    page.entries.forEach((entry) => {
      expect(Object.keys(entry).sort()).toEqual([
        ...(entry.completedAt === undefined ? [] : ['completedAt']),
        'fingerprint',
        'label',
        'startedAt',
        'status',
        'traceSource',
      ].sort());
    });
    expect(await service.listExplainTurnsForScope({
      kind: 'conversation',
      conversationId,
      conversationType: 'group',
      groupId,
    })).toEqual({
      entries: [{
        fingerprint: fingerprint(groupTurnId),
        label: 'Turn',
        traceSource: 'stored',
        status: 'completed',
        startedAt: new Date(NOW + 400),
        completedAt: new Date(NOW + 450),
      }],
      truncated: false,
    });
    expect(await service.listExplainTurnsForScope({
      kind: 'conversation',
      conversationId: codePointConversationId,
      conversationType: 'private',
    })).toEqual({
      entries: [{
        fingerprint: fingerprint(codePointTurnId),
        label: 'Turn',
        traceSource: 'stored',
        status: 'completed',
        startedAt: new Date(NOW + 1_600),
      }],
      truncated: false,
    });
    for (const malformedScope of [
      { kind: 'global' },
      {
        kind: 'conversation',
        conversationId,
        conversationType: 'private',
        groupId,
      },
      { kind: 'conversation', conversationId, conversationType: 'group' },
      { kind: 'conversation', conversationId: '', conversationType: 'private' },
      { kind: 'conversation', conversationId: ` ${conversationId}`, conversationType: 'private' },
      { kind: 'conversation', conversationId: `bad\u0000scope`, conversationType: 'private' },
      { kind: 'conversation', conversationId: 'c'.repeat(257), conversationType: 'private' },
      {
        kind: 'conversation',
        conversationId,
        conversationType: 'group',
        groupId: ` ${groupId}`,
      },
    ] as const) {
      expect(await service.listExplainTurnsForScope(malformedScope)).toEqual({
        entries: [],
        truncated: false,
      });
    }
    expect(await service.listExplainTurnsForScope({
      kind: 'conversation',
      conversationId,
      conversationType: 'invalid',
      groupId,
    } as unknown as Parameters<
      GovernanceQueryService['listExplainTurnsForScope']
    >[0])).toEqual({ entries: [], truncated: false });
    expect(await service.listExplainTurnsForScope({
      kind: 'conversation',
      conversationId: '\u{1f600}'.repeat(257),
      conversationType: 'private',
    })).toEqual({ entries: [], truncated: false });
    expect(resolveExplainTurn).not.toHaveBeenCalled();
    expect(explainStoredContext).not.toHaveBeenCalled();
    expect(explainActionDecision).not.toHaveBeenCalled();
    expect(explainToolCalls).not.toHaveBeenCalled();
    const serialized = JSON.stringify(page);
    for (const rawValue of [
      platformId,
      secret,
      conversationId,
      groupId,
      olderTurnId,
      newerTurnId,
      tieATurnId,
      tieBTurnId,
      'trace-explain-page-duplicate',
      'synthetic-model',
      'synthetic-provider',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    for (let index = 0; index < 96; index += 1) {
      insertTurn({
        id: `page-bound-${String(index).padStart(3, '0')}`,
        conversationType: 'private',
        startedAt: NOW - index,
      });
    }
    const exactBoundChanges = db.prepare('SELECT total_changes()').pluck().get();
    const exactBound = await service.listExplainTurnsForScope(privateScope);
    expect(exactBound.entries).toHaveLength(100);
    expect(exactBound.truncated).toBe(false);
    expect(new Set(exactBound.entries.map((entry) => entry.fingerprint))).toHaveProperty(
      'size',
      100,
    );
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(exactBoundChanges);

    insertTurn({
      id: 'page-bound-overflow',
      conversationType: 'private',
      startedAt: NOW + 20_000,
    });
    const overflowChanges = db.prepare('SELECT total_changes()').pluck().get();
    const overflow = await service.listExplainTurnsForScope(privateScope);
    expect(overflow.entries).toHaveLength(100);
    expect(overflow.truncated).toBe(true);
    expect(new Set(overflow.entries.map((entry) => entry.fingerprint))).toHaveProperty(
      'size',
      100,
    );
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(overflowChanges);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues resource handles only for the bounded exact-conversation Explain turn page', async () => {
    const platformId = '963852741';
    const secret = 'sk-explainresourceabcdefghijklmnopqrstuvwxyz123456';
    const conversationId = `explain-resource-${platformId}-${secret}`;
    const groupId = `explain-resource-group-${platformId}-${secret}`;
    const privateScope = {
      kind: 'conversation',
      conversationId,
      conversationType: 'private',
    } as const;
    const groupScope = {
      kind: 'conversation',
      conversationId,
      conversationType: 'group',
      groupId,
    } as const;
    const targetTurnIds = Array.from({ length: 101 }, (_, index) => {
      const suffix = `resource-${String(index).padStart(3, '0')}-${platformId}-${secret}`;
      insertExplainConversationTrace(db, {
        id: suffix,
        conversationId,
        conversationType: 'private',
        createdAt: NOW + index,
      });
      return `turn-explain-catalog-${suffix}`;
    });
    const expectedTurnIds = [...targetTurnIds].reverse().slice(0, 100);
    const groupTurnId = 'turn-explain-catalog-resource-group-collision';
    insertExplainConversationTrace(db, {
      id: 'resource-group-collision',
      conversationId,
      conversationType: 'group',
      groupId,
      createdAt: NOW + 10_000,
    });
    insertExplainConversationTrace(db, {
      id: 'resource-other-group',
      conversationId,
      conversationType: 'group',
      groupId: `other-${groupId}`,
      createdAt: NOW + 20_000,
    });
    insertExplainConversationTrace(db, {
      id: 'resource-turn-mismatch',
      conversationId,
      turnConversationId: `other-${conversationId}`,
      conversationType: 'private',
      createdAt: NOW + 30_000,
    });
    insertExplainConversationTrace(db, {
      id: 'resource-without-trace',
      conversationId,
      conversationType: 'private',
      createdAt: NOW + 40_000,
      storeTrace: false,
    });
    db.prepare(
      `INSERT INTO context_traces (
         id, turn_id, conversation_id, conversation_type, group_id,
         candidate_memory_ids, selected_memory_ids, rejected_memories,
         filters_applied, injected_identity_fields, recent_message_ids,
         token_budget, memories, created_at
       ) VALUES (?, ?, ?, 'private', NULL, '[]', '[]', '[]', '[]', '[]', '[]', '{}', '[]', ?)`,
    ).run(
      'trace-explain-resource-duplicate',
      expectedTurnIds[0],
      conversationId,
      NOW + 50_000,
    );

    const service = new GovernanceQueryService(db);
    const registry = new GovernanceResourceHandleRegistry({ now: () => NOW });
    const sessionId = 'e'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const issuedInputs: Array<{
      scope: typeof privateScope | typeof groupScope;
      turnId: string;
    }> = [];
    const issueHandle = vi.fn((input: {
      scope: typeof privateScope | typeof groupScope;
      turnId: string;
    }) => {
      issuedInputs.push(input);
      return {
        ...registry.issue({
          sessionId,
          sessionExpiresAt,
          purpose: 'governance.explain.turns.read',
          resourceKind: 'explain_turn',
          resourceId: input.turnId,
          scope: input.scope,
        }),
        rawTurnId: input.turnId,
        ignoredSessionId: sessionId,
        ignoredSecret: secret,
      };
    });
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const page = await service.listExplainTurnResourceHandlePage(privateScope, issueHandle);
    const repeated = await service.listExplainTurnResourceHandlePage(privateScope, issueHandle);
    const basePage = await service.listExplainTurnsForScope(privateScope);

    expect(repeated).toEqual(page);
    expect(page.entries).toHaveLength(100);
    expect(page.truncated).toBe(true);
    expect(issuedInputs.slice(0, 100)).toEqual(expectedTurnIds.map((turnId) => ({
      scope: privateScope,
      turnId,
    })));
    expect(issuedInputs.slice(100, 200)).toEqual(issuedInputs.slice(0, 100));
    expect(issuedInputs.some((input) => input.turnId === groupTurnId)).toBe(false);
    expect(issuedInputs).not.toContainEqual(expect.objectContaining({
      turnId: 'turn-explain-catalog-resource-turn-mismatch',
    }));
    expect(issuedInputs).not.toContainEqual(expect.objectContaining({
      turnId: 'turn-explain-catalog-resource-without-trace',
    }));
    expect(issuedInputs.filter((input) => input.turnId === expectedTurnIds[0]))
      .toHaveLength(2);
    expect(page.entries.map(({ handle: _handle, handleExpiresAt: _expiresAt, ...entry }) => entry))
      .toEqual(basePage.entries);
    expect(page.truncated).toBe(basePage.truncated);
    page.entries.forEach((entry) => {
      expect(Object.keys(entry).sort()).toEqual([
        ...(entry.completedAt === undefined ? [] : ['completedAt']),
        'fingerprint',
        'handle',
        'handleExpiresAt',
        'label',
        'startedAt',
        'status',
        'traceSource',
      ].sort());
      expect(entry.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(entry.handleExpiresAt).toBe(sessionExpiresAt);
    });

    const firstEntry = page.entries[0];
    expect(firstEntry).toBeDefined();
    expect(registry.resolve({
      sessionId,
      handle: firstEntry?.handle ?? '',
      purpose: 'governance.explain.turns.read',
      resourceKind: 'explain_turn',
      scope: privateScope,
    })).toEqual({ kind: 'explain_turn', resourceId: expectedTurnIds[0] });
    expect(registry.resolve({
      sessionId: 'f'.repeat(64),
      handle: firstEntry?.handle ?? '',
      purpose: 'governance.explain.turns.read',
      resourceKind: 'explain_turn',
      scope: privateScope,
    })).toBeNull();
    expect(registry.resolve({
      sessionId,
      handle: firstEntry?.handle ?? '',
      purpose: 'governance.memory.records.read',
      resourceKind: 'explain_turn',
      scope: privateScope,
    })).toBeNull();
    expect(registry.resolve({
      sessionId,
      handle: firstEntry?.handle ?? '',
      purpose: 'governance.explain.turns.read',
      resourceKind: 'memory_record',
      scope: privateScope,
    })).toBeNull();
    expect(registry.resolve({
      sessionId,
      handle: firstEntry?.handle ?? '',
      purpose: 'governance.explain.turns.read',
      resourceKind: 'explain_turn',
      scope: groupScope,
    })).toBeNull();

    const callsBeforeGroup = issueHandle.mock.calls.length;
    const groupPage = await service.listExplainTurnResourceHandlePage(groupScope, issueHandle);
    expect(groupPage.entries).toHaveLength(1);
    expect(groupPage.truncated).toBe(false);
    expect(issuedInputs[callsBeforeGroup]).toEqual({ scope: groupScope, turnId: groupTurnId });
    const callsBeforeEmpty = issueHandle.mock.calls.length;
    await expect(service.listExplainTurnResourceHandlePage(
      { kind: 'global' },
      issueHandle,
    )).resolves.toEqual({ entries: [], truncated: false });
    await expect(service.listExplainTurnResourceHandlePage({
      kind: 'conversation',
      conversationId: ` ${conversationId}`,
      conversationType: 'private',
    }, issueHandle)).resolves.toEqual({ entries: [], truncated: false });
    expect(issueHandle).toHaveBeenCalledTimes(callsBeforeEmpty);

    const serialized = JSON.stringify({ page, repeated, groupPage });
    for (const rawValue of [
      platformId,
      secret,
      sessionId,
      conversationId,
      groupId,
      ...expectedTurnIds,
      groupTurnId,
      'trace-explain-resource-duplicate',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('projects bounded identifier-free Explain turn detail only after exact-scope selection', async () => {
    const platformId = '951753842';
    const secret = 'sk-explaindetailabcdefghijklmnopqrstuvwxyz123456';
    const conversationId = `explain-detail-${platformId}-${secret}`;
    const groupId = `explain-detail-group-${platformId}-${secret}`;
    const otherGroupId = `other-${groupId}`;
    const privateScope = {
      kind: 'conversation',
      conversationId,
      conversationType: 'private',
    } as const;
    const groupScope = {
      kind: 'conversation',
      conversationId,
      conversationType: 'group',
      groupId,
    } as const;
    insertExplainConversationTrace(db, {
      id: `detail-private-${platformId}-${secret}`,
      conversationId,
      conversationType: 'private',
      createdAt: NOW + 100,
    });
    const turnId = `turn-explain-catalog-detail-private-${platformId}-${secret}`;
    db.prepare(
      `UPDATE agent_turns
          SET status = 'completed', completed_at = ?, pi_model = ?,
              pi_provider = ?, response_text = ?, tokens_input = 11,
              tokens_output = 12, tokens_total = 23
        WHERE id = ?`,
    ).run(
      NOW + 900,
      `model-${platformId}`,
      `provider-${secret}`,
      `response-${platformId}-${secret}`,
      turnId,
    );

    const filters = Array.from({ length: 33 }, (_, index) => (
      `filter-${String(index).padStart(2, '0')}-password=${secret}-${platformId}-${'F'.repeat(120)}`
    ));
    const identityFields = Array.from({ length: 33 }, (_, index) => (
      `identity-${String(index).padStart(2, '0')}-api_key=${secret}-${platformId}-${'I'.repeat(120)}`
    ));
    const newestTraceId = `trace-explain-detail-newest-${platformId}-${secret}`;
    db.prepare(
      `INSERT INTO context_traces (
         id, turn_id, conversation_id, conversation_type, group_id,
         candidate_memory_ids, selected_memory_ids, rejected_memories,
         filters_applied, injected_identity_fields, recent_message_ids,
         token_budget, memories, created_at
       ) VALUES (?, ?, ?, 'private', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newestTraceId,
      turnId,
      conversationId,
      JSON.stringify(Array.from({ length: 35 }, (_, index) => `candidate-${index}-${secret}`)),
      JSON.stringify(Array.from({ length: 34 }, (_, index) => `selected-${index}-${secret}`)),
      JSON.stringify(Array.from({ length: 33 }, (_, index) => ({
        memoryId: `rejected-${index}-${secret}`,
        reason: `reason-${index}-${platformId}-${secret}`,
      }))),
      JSON.stringify(filters),
      JSON.stringify(identityFields),
      JSON.stringify(Array.from({ length: 36 }, (_, index) => `message-${index}-${secret}`)),
      JSON.stringify({
        max: 8192,
        used: 2048,
        breakdown: {
          recentMessages: 512,
          memory: 768,
          identity: 128,
          system: 640,
        },
        promptLayers: [{ name: `layer-${secret}`, version: platformId, tokens: 640 }],
      }),
      JSON.stringify(Array.from({ length: 37 }, (_, index) => ({
        memoryId: `included-${index}-${secret}`,
        scope: 'conversation',
        title: `title-${platformId}-${secret}`,
      }))),
      NOW + 200,
    );
    db.prepare(
      `INSERT INTO context_traces (
         id, turn_id, conversation_id, conversation_type, group_id,
         candidate_memory_ids, selected_memory_ids, rejected_memories,
         filters_applied, injected_identity_fields, recent_message_ids,
         token_budget, memories, created_at
       ) VALUES (?, ?, ?, 'group', ?, '[]', '[]', '[]', ?, '[]', '[]', '{}', '[]', ?)`,
    ).run(
      `trace-explain-detail-newer-wrong-scope-${platformId}-${secret}`,
      turnId,
      conversationId,
      groupId,
      JSON.stringify([`wrong-scope-filter-${platformId}-${secret}`]),
      NOW + 300,
    );

    insertExplainConversationTrace(db, {
      id: `detail-group-${platformId}-${secret}`,
      conversationId,
      conversationType: 'group',
      groupId,
      createdAt: NOW + 400,
    });
    const groupTurnId = `turn-explain-catalog-detail-group-${platformId}-${secret}`;
    insertExplainConversationTrace(db, {
      id: `detail-other-group-${platformId}-${secret}`,
      conversationId,
      conversationType: 'group',
      groupId: otherGroupId,
      createdAt: NOW + 500,
    });
    insertExplainConversationTrace(db, {
      id: `detail-without-trace-${platformId}-${secret}`,
      conversationId,
      conversationType: 'private',
      createdAt: NOW + 600,
      storeTrace: false,
    });
    const withoutTraceTurnId =
      `turn-explain-catalog-detail-without-trace-${platformId}-${secret}`;
    insertExplainConversationTrace(db, {
      id: `detail-mismatched-turn-${platformId}-${secret}`,
      conversationId,
      turnConversationId: `different-${conversationId}`,
      conversationType: 'private',
      createdAt: NOW + 700,
    });
    const mismatchedTurnId =
      `turn-explain-catalog-detail-mismatched-turn-${platformId}-${secret}`;
    insertExplainConversationTrace(db, {
      id: `detail-malformed-${platformId}-${secret}`,
      conversationId,
      conversationType: 'private',
      createdAt: NOW + 800,
    });
    const malformedTurnId = `turn-explain-catalog-detail-malformed-${platformId}-${secret}`;
    db.prepare(
      `UPDATE context_traces
          SET candidate_memory_ids = 'not-json', selected_memory_ids = '{}',
              rejected_memories = 'null', filters_applied = 'not-json',
              injected_identity_fields = '{}', recent_message_ids = 'null',
              token_budget = ?, memories = 'not-json'
        WHERE turn_id = ?`,
    ).run(JSON.stringify({ max: 'many', used: -1, breakdown: {} }), malformedTurnId);

    const actionTypes = [
      'reply_full',
      'reply_short',
      'react_only',
      'ask_clarification',
    ] as const;
    const actions = Array.from({ length: 33 }, (_, index) => ({
      type: actionTypes[index % actionTypes.length],
      priority: index,
      constraints: { redactionLevel: 'strict' },
      reason: `action-reason-${platformId}-${secret}`,
      payload: { text: `action-payload-${platformId}-${secret}` },
    }));
    const linkedDecisionId = `decision-explain-detail-${platformId}-${secret}`;
    db.prepare(
      `INSERT INTO action_decisions (
         id, turn_id, decided_by, risk_level, confidence,
         evaluator_required, evaluator_passed, actions, reasons, suppressors,
         created_at
       ) VALUES (?, ?, 'evaluator', 'high', 0.9, 1, 1, ?, ?, ?, ?)`,
    ).run(
      linkedDecisionId,
      turnId,
      JSON.stringify(actions),
      JSON.stringify(Array.from({ length: 34 }, (_, index) => (
        `decision-reason-${index}-${platformId}-${secret}`
      ))),
      JSON.stringify(Array.from({ length: 35 }, (_, index) => (
        `decision-suppressor-${index}-${platformId}-${secret}`
      ))),
      NOW + 100,
    );
    db.prepare(
      `INSERT INTO action_decisions (
         id, turn_id, decided_by, risk_level, confidence,
         evaluator_required, actions, reasons, suppressors, created_at
       ) VALUES (?, ?, 'pi', 'low', 0.5, 0, '[]', '[]', '[]', ?)`,
    ).run(`decision-explain-detail-newer-${secret}`, turnId, NOW + 200);
    db.prepare('UPDATE agent_turns SET action_decision_id = ? WHERE id = ?')
      .run(linkedDecisionId, turnId);
    const insertExecution = db.prepare(
      `INSERT INTO action_executions (
         id, action_decision_id, action_type, status, executed_message_id,
         downgraded_from, downgraded_reason, error_code, error_message,
         audit_level, audit_entry, executed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'summary', ?, ?)`,
    );
    for (let index = 0; index < 33; index += 1) {
      insertExecution.run(
        `execution-explain-detail-${String(index).padStart(2, '0')}-${platformId}-${secret}`,
        linkedDecisionId,
        index === 0 ? 'react_only' : actionTypes[index % actionTypes.length],
        index === 0 ? 'downgraded' : index === 1 ? 'failed' : 'success',
        index === 0 ? `message-${platformId}-${secret}` : null,
        index === 0 ? 'reply_full' : null,
        index === 0 ? `downgrade-${platformId}-${secret}` : null,
        index === 1
          ? `error-password=${secret}-${platformId}-${'E'.repeat(120)}`
          : null,
        index === 1 ? `error-message-${platformId}-${secret}` : null,
        JSON.stringify({ secret, platformId }),
        NOW + index,
      );
    }
    const insertTool = db.prepare(
      `INSERT INTO tool_calls (
         id, turn_id, tool_name, input, output, requested_by, actor_class,
         invocation_context, status, error_code, error_message,
         execution_time_ms, secrets_redacted, created_at
       ) VALUES (?, ?, ?, ?, ?, 'pi', 'user', 'private_chat', ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 33; index += 1) {
      insertTool.run(
        `tool-explain-detail-${String(index).padStart(2, '0')}-${platformId}-${secret}`,
        turnId,
        index === 0
          ? `tool-password=${secret}-${platformId}-${'T'.repeat(120)}`
          : `tool-${String(index).padStart(2, '0')}`,
        JSON.stringify({ secret, platformId }),
        JSON.stringify({ secret, platformId }),
        index === 0 ? 'error' : 'success',
        index === 0
          ? `tool-error-api_key=${secret}-${platformId}-${'C'.repeat(120)}`
          : null,
        index === 0 ? `tool-error-message-${platformId}-${secret}` : null,
        index,
        index === 0 ? 1 : 0,
        NOW + index,
      );
    }

    const service = new GovernanceQueryService(db);
    const legacyStored = vi.spyOn(service, 'explainStoredContext');
    const legacyDecision = vi.spyOn(service, 'explainActionDecision');
    const legacyTools = vi.spyOn(service, 'explainToolCalls');
    const prepare = vi.spyOn(db, 'prepare');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    prepare.mockClear();

    for (const input of [
      { scope: { kind: 'global' } as const, turnId },
      { scope: groupScope, turnId },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'group',
          groupId: otherGroupId,
        } as const,
        turnId,
      },
      { scope: privateScope, turnId: withoutTraceTurnId },
      { scope: privateScope, turnId: mismatchedTurnId },
      { scope: privateScope, turnId: 'missing-explain-detail' },
      { scope: privateScope, turnId: ` ${turnId}` },
      { scope: privateScope, turnId: `bad\u0000turn` },
      { scope: privateScope, turnId: 't'.repeat(257) },
    ]) {
      await expect(service.getExplainTurnDetailForScope(input)).resolves.toBeNull();
    }
    expect(prepare.mock.calls.map(([sql]) => String(sql)).some((sql) => (
      sql.includes('FROM action_decisions')
      || sql.includes('FROM action_executions')
      || sql.includes('FROM tool_calls')
      || sql.includes('json_each')
    ))).toBe(false);
    prepare.mockClear();

    const detail = await service.getExplainTurnDetailForScope({ scope: privateScope, turnId });
    const repeated = await service.getExplainTurnDetailForScope({ scope: privateScope, turnId });
    expect(repeated).toEqual(detail);
    expect(detail?.turn).toEqual({
      fingerprint: createHash('sha256')
        .update('lethebot-governance:explain-turn:v1\0', 'utf8')
        .update(turnId, 'utf8')
        .digest('hex')
        .slice(0, 16),
      label: 'Turn',
      traceSource: 'stored',
      status: 'completed',
      startedAt: new Date(NOW + 100),
      completedAt: new Date(NOW + 900),
    });
    expect(detail?.context).toMatchObject({
      traceSource: 'stored',
      candidateMemoryCount: 35,
      selectedMemoryCount: 34,
      rejectedMemoryCount: 33,
      recentMessageCount: 36,
      includedMemoryCount: 37,
      filtersTruncated: true,
      injectedIdentityFieldsTruncated: true,
      tokenBudget: {
        max: 8192,
        used: 2048,
        breakdown: {
          recentMessages: 512,
          memory: 768,
          identity: 128,
          system: 640,
        },
      },
    });
    expect(detail?.context.filters).toHaveLength(32);
    expect(detail?.context.injectedIdentityFields).toHaveLength(32);
    expect(detail?.context.filters[0]).toMatchObject({
      label: expect.stringContaining('[REDACTED:password_assignment]'),
      redacted: true,
      truncated: true,
    });
    expect(detail?.context.injectedIdentityFields[0]).toMatchObject({
      label: expect.stringContaining('[REDACTED:api_key_assignment]'),
      redacted: true,
      truncated: true,
    });
    expect(detail?.actionDecision).toMatchObject({
      decidedBy: 'evaluator',
      riskLevel: 'high',
      confidence: 0.9,
      evaluatorRequired: true,
      evaluatorPassed: true,
      actionCount: 33,
      actionTypesTruncated: true,
      reasonCount: 34,
      suppressorCount: 35,
      executionsTruncated: true,
    });
    expect(detail?.actionDecision?.actionTypes).toHaveLength(32);
    expect(detail?.actionDecision?.actionTypes.slice(0, 4)).toEqual(actionTypes);
    expect(detail?.actionDecision?.executions).toHaveLength(32);
    expect(detail?.actionDecision?.executions[0]).toMatchObject({
      actionType: 'react_only',
      status: 'downgraded',
      effect: 'face_message_fallback',
      executedMessage: true,
      executedMemory: false,
      scheduledJob: false,
      downgradedFrom: 'reply_full',
      errorCodeRedacted: false,
      errorCodeTruncated: false,
      executedAt: new Date(NOW),
    });
    expect(detail?.actionDecision?.executions[1]).toMatchObject({
      status: 'failed',
      errorCode: expect.stringContaining('[REDACTED:password_assignment]'),
      errorCodeRedacted: true,
      errorCodeTruncated: true,
    });
    expect(detail?.tools).toHaveLength(32);
    expect(detail?.toolsTruncated).toBe(true);
    expect(detail?.tools[0]).toMatchObject({
      toolName: expect.stringContaining('[REDACTED:password_assignment]'),
      toolNameRedacted: true,
      toolNameTruncated: true,
      requestedBy: 'pi',
      status: 'error',
      errorCode: expect.stringContaining('[REDACTED:api_key_assignment]'),
      errorCodeRedacted: true,
      errorCodeTruncated: true,
      executionTimeMs: 0,
      secretsRedacted: true,
      createdAt: new Date(NOW),
    });
    expect(Object.keys(detail ?? {}).sort()).toEqual([
      'actionDecision',
      'context',
      'tools',
      'toolsTruncated',
      'turn',
    ]);
    expect(Object.keys(detail?.context ?? {}).sort()).toEqual([
      'candidateMemoryCount',
      'filters',
      'filtersTruncated',
      'includedMemoryCount',
      'injectedIdentityFields',
      'injectedIdentityFieldsTruncated',
      'recentMessageCount',
      'rejectedMemoryCount',
      'selectedMemoryCount',
      'tokenBudget',
      'traceSource',
    ]);
    expect(Object.keys(detail?.actionDecision ?? {}).sort()).toEqual([
      'actionCount',
      'actionTypes',
      'actionTypesTruncated',
      'confidence',
      'decidedBy',
      'evaluatorPassed',
      'evaluatorRequired',
      'executions',
      'executionsTruncated',
      'reasonCount',
      'riskLevel',
      'suppressorCount',
    ]);
    expect(Object.keys(detail?.tools[0] ?? {}).sort()).toEqual([
      'createdAt',
      'errorCode',
      'errorCodeRedacted',
      'errorCodeTruncated',
      'executionTimeMs',
      'requestedBy',
      'secretsRedacted',
      'status',
      'toolName',
      'toolNameRedacted',
      'toolNameTruncated',
    ]);

    const malformed = await service.getExplainTurnDetailForScope({
      scope: privateScope,
      turnId: malformedTurnId,
    });
    expect(malformed).toMatchObject({
      context: {
        traceSource: 'stored',
        candidateMemoryCount: 0,
        selectedMemoryCount: 0,
        rejectedMemoryCount: 0,
        recentMessageCount: 0,
        includedMemoryCount: 0,
        filters: [],
        filtersTruncated: false,
        injectedIdentityFields: [],
        injectedIdentityFieldsTruncated: false,
      },
      tools: [],
      toolsTruncated: false,
    });
    expect(malformed?.context).not.toHaveProperty('tokenBudget');
    expect(malformed).not.toHaveProperty('actionDecision');
    expect((await service.getExplainTurnDetailForScope({
      scope: groupScope,
      turnId: groupTurnId,
    }))?.turn.status).toBe('completed');
    expect(legacyStored).not.toHaveBeenCalled();
    expect(legacyDecision).not.toHaveBeenCalled();
    expect(legacyTools).not.toHaveBeenCalled();

    const serialized = JSON.stringify({ detail, repeated, malformed });
    for (const rawValue of [
      platformId,
      secret,
      conversationId,
      groupId,
      turnId,
      newestTraceId,
      linkedDecisionId,
      'wrong-scope-filter-',
      'action-payload-',
      'decision-reason-',
      'decision-suppressor-',
      'downgrade-',
      'error-message-',
      'tool-error-message-',
      'candidate-',
      'selected-',
      'rejected-',
      'message-',
      'included-',
      'promptLayers',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('evaluates expired running leases at each query call', async () => {
    seedHealthEvidence(db, 'ordinary-event', 'worker-main');
    const service = new GovernanceQueryService(db);
    const summarizeMemoryReviews = vi.spyOn(service, 'summarizeMemoryReviews');
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(NOW);
    expect((await service.summarizeGovernanceHealth()).jobs.expiredRunningLeases).toBe(0);

    now.mockReturnValue(NOW + 101);
    const expired = await service.summarizeGovernanceHealth();
    expect(expired.jobs.expiredRunningLeases).toBe(1);
    expect(expired.attention.expiredRunningLeases).toBe(1);
    expect(summarizeMemoryReviews).toHaveBeenCalledTimes(2);
  });

  it('lists bounded review candidates with redacted resolution evidence and no writes', async () => {
    const secret = 'sk-reviewabcdefghijklmnopqrstuvwxyz123456';
    const platformId = '123456789';
    const evidence = seedMemoryReviewEvidence(db, secret, platformId);
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const candidates = await service.listMemoryReviewCandidates({ includeDetails: true });

    expect(candidates.map((candidate) => candidate.eventType)).toEqual([
      'memory.decay.candidates_detected',
      'memory.consolidation.candidates_detected',
      'memory.conflict.detected',
    ]);
    expect(candidates[0]).toMatchObject({
      auditId: evidence.decayAuditId,
      status: 'resolved',
      candidateCount: 1,
      resolutionAuditIds: ['audit-review-disable'],
      disabledMemoryIds: [evidence.decayMemoryId],
    });
    expect(candidates[1]).toMatchObject({
      auditId: evidence.consolidationAuditId,
      status: 'unresolved',
      candidateCount: 1,
      resolutionAuditIds: [],
    });
    expect(candidates[2]).toMatchObject({
      auditId: evidence.conflictAuditId,
      status: 'resolved',
      candidateCount: 1,
      resolutionAuditIds: ['audit-review-supersede'],
      supersededMemoryIds: ['memory-old'],
      replacementMemoryIds: ['memory-new'],
    });
    expect(candidates[2]?.details).toBeDefined();
    expect(candidates[2]?.redacted).toBe(true);

    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).toContain('[REDACTED:token_assignment]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(db.prepare('SELECT details FROM audit_log WHERE id = ?').pluck().get(
      evidence.conflictAuditId,
    )).toContain(secret);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('summarizes review filters and applies memory filtering before the final limit', async () => {
    const evidence = seedMemoryReviewEvidence(db, 'ordinary-review', '246813579');
    const service = new GovernanceQueryService(db);

    const summary = await service.summarizeMemoryReviews();
    expect(summary).toMatchObject({
      filters: { status: 'all' },
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
    expect(summary.byEventType).toEqual([
      expect.objectContaining({
        eventType: 'memory.conflict.detected',
        total: 1,
        resolved: 1,
        memoryReferences: 2,
      }),
      expect.objectContaining({
        eventType: 'memory.consolidation.candidates_detected',
        total: 1,
        unresolved: 1,
        memoryReferences: 2,
      }),
      expect.objectContaining({
        eventType: 'memory.decay.candidates_detected',
        total: 1,
        resolved: 1,
        memoryReferences: 1,
      }),
    ]);
    expect(await service.summarizeMemoryReviews({ status: 'unresolved' })).toMatchObject({
      total: 1,
      resolved: 0,
      unresolved: 1,
    });

    for (let index = 0; index < 101; index += 1) {
      insertMemoryReviewAudit(
        db,
        `audit-review-filler-${String(index).padStart(3, '0')}`,
        'memory.conflict.detected',
        NOW + index,
        { memoryIds: [`memory-filler-${index}`, `memory-filler-peer-${index}`] },
      );
    }

    const defaultWindow = await service.listMemoryReviewCandidates();
    expect(defaultWindow).toHaveLength(100);
    expect(defaultWindow.some((candidate) => candidate.auditId === evidence.conflictAuditId)).toBe(false);

    const filtered = await service.listMemoryReviewCandidates({
      memoryId: evidence.platformMemoryId,
      limit: 1,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({
      auditId: evidence.conflictAuditId,
      status: 'resolved',
    });
    expect(JSON.stringify(filtered)).not.toContain(evidence.platformMemoryId);

    const filteredSummary = await service.summarizeMemoryReviews({
      eventType: 'memory.conflict.detected',
      memoryId: evidence.platformMemoryId,
      status: 'resolved',
    });
    expect(filteredSummary).toMatchObject({
      filters: {
        eventType: 'memory.conflict.detected',
        status: 'resolved',
      },
      total: 1,
      resolved: 1,
      unresolved: 0,
      memoryReferences: 2,
    });
    expect(filteredSummary.filters.memoryId).toContain('[REDACTED:platform_id]');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('lists normalized maintenance reviews inside the exact scope before the bounded limit', async () => {
    for (let index = 0; index < 101; index += 1) {
      insertNormalizedMaintenanceProposal(db, {
        proposalId: `proposal-global-filler-${String(index).padStart(3, '0')}`,
        scope: { kind: 'global' },
        createdAt: NOW - 1_000 + index,
      });
    }
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-user-a',
      scope: { kind: 'user', canonicalUserId: 'user-a' },
      createdAt: NOW,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-user-b',
      scope: { kind: 'user', canonicalUserId: 'user-b' },
      createdAt: NOW + 1,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-group-a',
      scope: { kind: 'group', groupId: 'group-a' },
      createdAt: NOW + 2,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-private-conversation-a',
      scope: {
        kind: 'conversation',
        conversationId: 'private:user-a',
        conversationType: 'private',
      },
      createdAt: NOW + 3,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-group-conversation-a',
      scope: {
        kind: 'conversation',
        conversationId: 'group:conversation-a',
        conversationType: 'group',
        groupId: 'group-a',
      },
      createdAt: NOW + 4,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-system',
      scope: { kind: 'system' },
      createdAt: NOW + 5,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-system-rejected',
      scope: { kind: 'system' },
      createdAt: NOW + 6,
    });
    const transition = new MemoryMaintenanceProposalRepository(
      db,
      new AuditRepository(db),
    ).transitionReview({
      proposalId: 'proposal-system-rejected',
      access: { kind: 'all' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'reject',
      actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
      authorityKind: 'local_admin',
      reasonCode: 'synthetic_query_rejection',
      nowMs: NOW + 7,
    });
    expect(transition.outcome).toBe('transitioned');
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-tool',
      scope: { kind: 'tool' },
      createdAt: NOW + 8,
    });
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const userA = await service.listMemoryMaintenanceReviews({
      scope: { kind: 'user', canonicalUserId: 'user-a' },
      limit: 1,
    });
    expect(userA).toHaveLength(1);
    expect(userA[0]).toMatchObject({
      kind: 'conflict',
      effectType: 'resolve_conflict',
      lifecycleState: 'pending_review',
      scopeKind: 'user',
      candidateCount: 1,
      currentRevisionNumber: 1,
    });
    expect(userA[0]?.proposalRef).toMatch(/^[0-9a-f]{16}$/u);
    expect(await service.listMemoryMaintenanceReviews({
      scope: { kind: 'user', canonicalUserId: 'user-b' },
    })).toHaveLength(1);
    expect(await service.listMemoryMaintenanceReviews({
      scope: { kind: 'group', groupId: 'group-a' },
    })).toEqual([expect.objectContaining({ scopeKind: 'group' })]);
    expect(await service.listMemoryMaintenanceReviews({
      scope: {
        kind: 'conversation',
        conversationId: 'private:user-a',
        conversationType: 'private',
      },
    })).toEqual([expect.objectContaining({ scopeKind: 'conversation' })]);
    expect(await service.listMemoryMaintenanceReviews({
      scope: {
        kind: 'conversation',
        conversationId: 'group:conversation-a',
        conversationType: 'group',
        groupId: 'group-a',
      },
    })).toEqual([expect.objectContaining({ scopeKind: 'conversation' })]);
    expect(await service.listMemoryMaintenanceReviews({
      scope: {
        kind: 'conversation',
        conversationId: 'group:conversation-a',
        conversationType: 'group',
        groupId: 'group-b',
      },
    })).toEqual([]);
    expect(await service.listMemoryMaintenanceReviews({
      scope: { kind: 'system' },
    })).toEqual([expect.objectContaining({ scopeKind: 'system' })]);
    expect(await service.listMemoryMaintenanceReviews({
      scope: { kind: 'system' },
      states: ['rejected'],
      limit: 1,
    })).toEqual([expect.objectContaining({
      scopeKind: 'system',
      lifecycleState: 'rejected',
    })]);
    expect(await service.listMemoryMaintenanceReviews({
      scope: { kind: 'tool', toolName: 'runtime.status' },
    })).toEqual([]);

    const global = await service.listMemoryMaintenanceReviews({
      scope: { kind: 'global' },
      limit: 1_000,
    });
    expect(global).toHaveLength(100);
    expect(global.every((review) => review.scopeKind === 'global')).toBe(true);
    const globalPage = await service.listMemoryMaintenanceReviewPage({
      scope: { kind: 'global' },
    });
    expect(globalPage.entries).toHaveLength(100);
    expect(globalPage.truncated).toBe(true);
    const userPage = await service.listMemoryMaintenanceReviewPage({
      scope: { kind: 'user', canonicalUserId: 'user-a' },
    });
    expect(userPage.entries).toHaveLength(1);
    expect(userPage.truncated).toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

  });

  it('issues resource handles only from the bounded exact-scope maintenance-review page', async () => {
    for (let index = 0; index < 101; index += 1) {
      insertNormalizedMaintenanceProposal(db, {
        proposalId: `proposal-resource-system-${String(index).padStart(3, '0')}`,
        scope: { kind: 'system' },
        createdAt: NOW + index,
      });
    }
    const proposalExpiresAt = NOW + 60_000;
    db.prepare(
      'UPDATE memory_maintenance_proposals SET expires_at = ? WHERE id = ?',
    ).run(proposalExpiresAt, 'proposal-resource-system-000');
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-resource-global-outside-scope',
      scope: { kind: 'global' },
      createdAt: NOW - 2,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-resource-system-rejected',
      scope: { kind: 'system' },
      createdAt: NOW - 1,
    });
    const transition = new MemoryMaintenanceProposalRepository(
      db,
      new AuditRepository(db),
    ).transitionReview({
      proposalId: 'proposal-resource-system-rejected',
      access: { kind: 'all' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'reject',
      actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
      authorityKind: 'local_admin',
      reasonCode: 'synthetic_resource_rejection',
      nowMs: NOW + 200,
    });
    expect(transition.outcome).toBe('transitioned');
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const sessionId = '0'.repeat(64);
    const secret = 'sk-resourceissuerabcdefghijklmnopqrstuvwxyz123456';
    const issuedInputs: Array<{
      scope: NormalizedMaintenanceScope;
      proposalId: string;
    }> = [];
    const issueHandle = vi.fn((input: {
      scope: NormalizedMaintenanceScope;
      proposalId: string;
    }) => {
      issuedInputs.push(input);
      return {
        handle: Buffer.alloc(32, issuedInputs.length).toString('base64url'),
        expiresAt: NOW + 900_000,
        rawScope: input.scope,
        rawProposalId: input.proposalId,
        ignoredSessionId: sessionId,
        ignoredSecret: secret,
      };
    });

    const page = await service.listMemoryMaintenanceReviewResourceHandlePage(
      { scope: { kind: 'system' } },
      issueHandle,
    );

    expect(page.entries).toHaveLength(100);
    expect(page.truncated).toBe(true);
    expect(issueHandle).toHaveBeenCalledTimes(100);
    expect(issuedInputs[0]).toEqual({
      scope: { kind: 'system' },
      proposalId: 'proposal-resource-system-000',
    });
    expect(issuedInputs.at(-1)).toEqual({
      scope: { kind: 'system' },
      proposalId: 'proposal-resource-system-099',
    });
    expect(issuedInputs.some((input) => input.proposalId.includes('outside-scope'))).toBe(false);
    expect(issuedInputs.some((input) => input.proposalId.includes('rejected'))).toBe(false);
    expect(page.entries.every((entry) => /^[A-Za-z0-9_-]{43}$/u.test(entry.handle))).toBe(true);
    expect(page.entries.every((entry) => entry.handleExpiresAt === NOW + 900_000)).toBe(true);
    expect(page.entries[0]?.expiresAt).toEqual(new Date(proposalExpiresAt));
    expect(typeof page.entries[0]?.handleExpiresAt).toBe('number');
    expect(Object.keys(page.entries[0] ?? {}).sort()).toEqual([
      'candidateCount',
      'candidateFingerprint',
      'confidence',
      'createdAt',
      'currentRevisionNumber',
      'effectType',
      'expiresAt',
      'handle',
      'handleExpiresAt',
      'kind',
      'lifecycleState',
      'proposalRef',
      'reasonCodes',
      'revisionCount',
      'scopeKind',
      'updatedAt',
    ]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('proposal-resource-system');
    expect(serialized).not.toContain('proposal-resource-global-outside-scope');
    expect(serialized).not.toContain('proposal-resource-system-rejected');
    expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain(secret);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('returns a bounded fingerprint-only normalized maintenance review detail', async () => {
    const secret = 'sk-reviewdetailabcdefghijklmnopqrstuvwxyz123456';
    const platformId = '123456789';
    const proposalId = `proposal-${platformId}-${secret}`;
    const candidateIds = Array.from(
      { length: 33 },
      (_, index) => `memory-${platformId}-${secret}-${index}`,
    );
    const evidence = insertNormalizedMaintenanceProposal(db, {
      proposalId,
      scope: { kind: 'system' },
      createdAt: NOW,
      candidateIds,
      revisionReason: `token=${secret}`,
    });
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const listed = await service.listMemoryMaintenanceReviews({
      scope: { kind: 'system' },
    });
    const detail = await service.getMemoryMaintenanceReview({
      scope: { kind: 'system' },
      proposalId,
    });

    expect(listed).toHaveLength(1);
    expect(detail).toMatchObject({
      proposalRef: listed[0]?.proposalRef,
      kind: 'conflict',
      effectType: 'resolve_conflict',
      lifecycleState: 'pending_review',
      scopeKind: 'system',
      candidateCount: 33,
      candidatesTruncated: true,
      revisionsTruncated: false,
      effectMemoryRef: undefined,
      effectMemoryRole: null,
    });
    expect(detail?.candidates).toHaveLength(32);
    expect(detail?.candidates[0]).toMatchObject({
      candidateOrdinal: 0,
      effectRole: 'conflict_candidate',
      expectedState: 'active',
      sourceCount: 0,
    });
    expect(detail?.candidates[0]?.memoryRef).toMatch(/^[0-9a-f]{16}$/u);
    expect(detail?.revisions).toEqual([
      expect.objectContaining({
        revisionNumber: 1,
        transition: 'propose',
        previousState: null,
        newState: 'pending_review',
        actorClass: 'system_worker',
        invocationContext: 'background_worker',
        reasonCode: '[REDACTED:token_assignment]',
      }),
    ]);
    expect(await service.getMemoryMaintenanceReview({
      scope: { kind: 'global' },
      proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceReview({
      scope: { kind: 'system' },
      proposalId: 'missing-proposal',
    })).toBeNull();

    const serialized = JSON.stringify({ listed, detail });
    expect(serialized).not.toContain(proposalId);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(candidateIds[0]);
    expect(serialized).not.toContain(evidence.auditId);
    expect(serialized).toContain('[REDACTED:token_assignment]');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('projects one digest-bound pending-review approval preview without writes', async () => {
    const secret = 'sk-approvalpreviewabcdefghijklmnopqrstuvwxyz123456';
    const platformId = '123456789';
    const proposalId = `proposal-${platformId}-${secret}`;
    const canonicalUserId = `user-${platformId}-${secret}`;
    insertNormalizedMaintenanceProposal(db, {
      proposalId,
      scope: { kind: 'user', canonicalUserId },
      createdAt: NOW,
      candidateIds: [
        `memory-${platformId}-${secret}-a`,
        `memory-${platformId}-${secret}-b`,
      ],
    });
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const preview = await service.getMemoryMaintenanceApprovalPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId,
    });

    expect(preview).toMatchObject({
      action: 'memory.maintenance.review.approve',
      scope: {
        scopeKind: 'user',
      },
      proposalKind: 'conflict',
      proposalRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      proposedEffect: 'resolve_conflict',
      affectedRecords: {
        count: 2,
        fingerprint: 'a'.repeat(64),
      },
      current: {
        lifecycleState: 'pending_review',
        revisionNumber: 1,
      },
      expected: {
        lifecycleState: 'approved',
        revisionNumber: 2,
        durableEffects: [
          'proposal_state_transition',
          'proposal_revision_append',
          'audit_event_append',
        ],
        unavailableEffects: ['memory_record_mutation'],
      },
      rollback: {
        supported: false,
        boundary: 'approval_does_not_apply_memory_effects',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(preview?.scope.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    expect(Object.keys(preview ?? {}).sort()).toEqual([
      'action',
      'affectedRecords',
      'current',
      'expected',
      'previewDigest',
      'proposalKind',
      'proposalRef',
      'proposedEffect',
      'rollback',
      'scope',
    ]);
    if (!preview) {
      throw new Error('Expected maintenance approval preview');
    }
    const { previewDigest, ...digestPayload } = preview;
    expect(previewDigest).toBe(createHash('sha256')
      .update('lethebot-governance:memory-maintenance-approval-preview:v1\0', 'utf8')
      .update(JSON.stringify(digestPayload), 'utf8')
      .digest('hex'));

    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain(proposalId);
    expect(serialized).not.toContain(canonicalUserId);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(await service.getMemoryMaintenanceApprovalPreview({
      scope: { kind: 'global' },
      proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceApprovalPreview({
      scope: { kind: 'tool', toolName: 'runtime.status' },
      proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceApprovalPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId: 'missing-proposal',
    })).toBeNull();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    const transition = new MemoryMaintenanceProposalRepository(
      db,
      new AuditRepository(db),
    ).transitionReview({
      proposalId,
      access: { kind: 'all' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'approve',
      actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
      authorityKind: 'local_admin',
      reasonCode: 'synthetic_preview_state_change',
      nowMs: NOW + 1,
    });
    expect(transition.outcome).toBe('transitioned');
    if (transition.outcome !== 'transitioned') {
      throw new Error('Expected maintenance approval transition');
    }
    const confirmation = service.projectMemoryMaintenanceApprovalConfirmation({
      scope: { kind: 'user', canonicalUserId },
      proposal: transition.proposal,
      expectedRevisionNumber: 1,
    });
    expect(confirmation).toMatchObject({
      action: 'memory.maintenance.review.approve',
      outcome: 'approved',
      proposalRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      current: {
        lifecycleState: 'approved',
        revisionNumber: 2,
      },
      evidence: {
        transition: 'approve',
        revisionRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
        auditRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      memoryRecordMutation: false,
      rollback: {
        supported: false,
        boundary: 'approval_does_not_apply_memory_effects',
      },
    });
    expect(Object.keys(confirmation ?? {}).sort()).toEqual([
      'action',
      'current',
      'evidence',
      'memoryRecordMutation',
      'outcome',
      'proposalRef',
      'rollback',
    ]);
    const serializedConfirmation = JSON.stringify(confirmation);
    expect(serializedConfirmation).not.toContain(proposalId);
    expect(serializedConfirmation).not.toContain(canonicalUserId);
    expect(serializedConfirmation).not.toContain(secret);
    expect(serializedConfirmation).not.toContain(platformId);
    const approvalRevision = transition.proposal.revisions.find(
      (revision) => revision.revisionNumber === 2,
    );
    expect(serializedConfirmation).not.toContain(approvalRevision?.revisionId ?? proposalId);
    expect(serializedConfirmation).not.toContain(approvalRevision?.auditId ?? proposalId);
    expect(service.projectMemoryMaintenanceApprovalConfirmation({
      scope: { kind: 'global' },
      proposal: transition.proposal,
      expectedRevisionNumber: 1,
    })).toBeNull();
    expect(service.projectMemoryMaintenanceApprovalConfirmation({
      scope: { kind: 'user', canonicalUserId },
      proposal: transition.proposal,
      expectedRevisionNumber: 2,
    })).toBeNull();
    const changesAfterTransition = db.prepare('SELECT total_changes()').pluck().get();
    expect(await service.getMemoryMaintenanceApprovalPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId,
    })).toBeNull();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesAfterTransition);
  });

  it('projects one digest-bound pending-review rejection preview without writes', async () => {
    const secret = 'sk-rejectionpreviewabcdefghijklmnopqrstuvwxyz123456';
    const platformId = '987654321';
    const proposalId = `proposal-${platformId}-${secret}`;
    const canonicalUserId = `user-${platformId}-${secret}`;
    insertNormalizedMaintenanceProposal(db, {
      proposalId,
      scope: { kind: 'user', canonicalUserId },
      createdAt: NOW,
      candidateIds: [
        `memory-${platformId}-${secret}-a`,
        `memory-${platformId}-${secret}-b`,
      ],
    });
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const preview = await service.getMemoryMaintenanceRejectionPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId,
    });
    const repeatedPreview = await service.getMemoryMaintenanceRejectionPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId,
    });
    const approvalPreview = await service.getMemoryMaintenanceApprovalPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId,
    });
    const expirationPreview = await service.getMemoryMaintenanceExpirationPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId,
    });
    const repeatedExpirationPreview = await service.getMemoryMaintenanceExpirationPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId,
    });

    expect(preview).toMatchObject({
      action: 'memory.maintenance.review.reject',
      scope: {
        scopeKind: 'user',
      },
      proposalKind: 'conflict',
      proposalRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      proposedEffect: 'resolve_conflict',
      affectedRecords: {
        count: 2,
        fingerprint: 'a'.repeat(64),
      },
      current: {
        lifecycleState: 'pending_review',
        revisionNumber: 1,
      },
      expected: {
        lifecycleState: 'rejected',
        revisionNumber: 2,
        durableEffects: [
          'proposal_state_transition',
          'proposal_revision_append',
          'audit_event_append',
        ],
        unavailableEffects: ['memory_record_mutation'],
      },
      rollback: {
        supported: false,
        boundary: 'rejection_does_not_apply_memory_effects',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(preview?.scope.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    expect(Object.keys(preview ?? {}).sort()).toEqual([
      'action',
      'affectedRecords',
      'current',
      'expected',
      'previewDigest',
      'proposalKind',
      'proposalRef',
      'proposedEffect',
      'rollback',
      'scope',
    ]);
    if (!preview) {
      throw new Error('Expected maintenance rejection preview');
    }
    const { previewDigest, ...digestPayload } = preview;
    expect(previewDigest).toBe(createHash('sha256')
      .update('lethebot-governance:memory-maintenance-rejection-preview:v1\0', 'utf8')
      .update(JSON.stringify(digestPayload), 'utf8')
      .digest('hex'));
    expect(repeatedPreview).toEqual(preview);
    expect(previewDigest).not.toBe(approvalPreview?.previewDigest);

    expect(expirationPreview).toMatchObject({
      action: 'memory.maintenance.review.expire',
      scope: {
        scopeKind: 'user',
      },
      proposalKind: 'conflict',
      proposalRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      proposedEffect: 'resolve_conflict',
      affectedRecords: {
        count: 2,
        fingerprint: 'a'.repeat(64),
      },
      current: {
        lifecycleState: 'pending_review',
        revisionNumber: 1,
      },
      expected: {
        lifecycleState: 'expired',
        revisionNumber: 2,
        durableEffects: [
          'proposal_state_transition',
          'proposal_revision_append',
          'audit_event_append',
        ],
        unavailableEffects: ['memory_record_mutation'],
      },
      rollback: {
        supported: false,
        boundary: 'expiration_does_not_apply_memory_effects',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(expirationPreview?.scope.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    expect(Object.keys(expirationPreview ?? {}).sort()).toEqual(Object.keys(preview).sort());
    if (!expirationPreview) {
      throw new Error('Expected maintenance expiration preview');
    }
    const {
      previewDigest: expirationPreviewDigest,
      ...expirationDigestPayload
    } = expirationPreview;
    expect(expirationPreviewDigest).toBe(createHash('sha256')
      .update('lethebot-governance:memory-maintenance-expiration-preview:v1\0', 'utf8')
      .update(JSON.stringify(expirationDigestPayload), 'utf8')
      .digest('hex'));
    expect(repeatedExpirationPreview).toEqual(expirationPreview);
    expect(expirationPreviewDigest).not.toBe(previewDigest);
    expect(expirationPreviewDigest).not.toBe(approvalPreview?.previewDigest);

    const serialized = JSON.stringify({ preview, expirationPreview });
    expect(serialized).not.toContain(proposalId);
    expect(serialized).not.toContain(canonicalUserId);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(await service.getMemoryMaintenanceRejectionPreview({
      scope: { kind: 'global' },
      proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceRejectionPreview({
      scope: { kind: 'tool', toolName: 'runtime.status' },
      proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceRejectionPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId: 'missing-proposal',
    })).toBeNull();
    expect(await service.getMemoryMaintenanceExpirationPreview({
      scope: { kind: 'global' },
      proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceExpirationPreview({
      scope: { kind: 'tool', toolName: 'runtime.status' },
      proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceExpirationPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId: 'missing-proposal',
    })).toBeNull();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    const transition = new MemoryMaintenanceProposalRepository(
      db,
      new AuditRepository(db),
    ).transitionReview({
      proposalId,
      access: { kind: 'all' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'reject',
      actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
      authorityKind: 'local_admin',
      reasonCode: 'synthetic_rejection_preview_state_change',
      nowMs: NOW + 1,
    });
    expect(transition.outcome).toBe('transitioned');
    if (transition.outcome !== 'transitioned') {
      throw new Error('Expected maintenance rejection transition');
    }
    const confirmation = service.projectMemoryMaintenanceRejectionConfirmation({
      scope: { kind: 'user', canonicalUserId },
      proposal: transition.proposal,
      expectedRevisionNumber: 1,
    });
    expect(confirmation).toMatchObject({
      action: 'memory.maintenance.review.reject',
      outcome: 'rejected',
      proposalRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      current: {
        lifecycleState: 'rejected',
        revisionNumber: 2,
      },
      evidence: {
        transition: 'reject',
        revisionRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
        auditRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      memoryRecordMutation: false,
      rollback: {
        supported: false,
        boundary: 'rejection_does_not_apply_memory_effects',
      },
    });
    expect(Object.keys(confirmation ?? {}).sort()).toEqual([
      'action',
      'current',
      'evidence',
      'memoryRecordMutation',
      'outcome',
      'proposalRef',
      'rollback',
    ]);
    const serializedConfirmation = JSON.stringify(confirmation);
    expect(serializedConfirmation).not.toContain(proposalId);
    expect(serializedConfirmation).not.toContain(canonicalUserId);
    expect(serializedConfirmation).not.toContain(secret);
    expect(serializedConfirmation).not.toContain(platformId);
    const rejectionRevision = transition.proposal.revisions.find(
      (revision) => revision.revisionNumber === 2,
    );
    expect(serializedConfirmation).not.toContain(rejectionRevision?.revisionId ?? proposalId);
    expect(serializedConfirmation).not.toContain(rejectionRevision?.auditId ?? proposalId);
    expect(service.projectMemoryMaintenanceRejectionConfirmation({
      scope: { kind: 'global' },
      proposal: transition.proposal,
      expectedRevisionNumber: 1,
    })).toBeNull();
    expect(service.projectMemoryMaintenanceRejectionConfirmation({
      scope: { kind: 'user', canonicalUserId },
      proposal: transition.proposal,
      expectedRevisionNumber: 2,
    })).toBeNull();

    const expirationProposalId = `expiration-${proposalId}`;
    insertNormalizedMaintenanceProposal(db, {
      proposalId: expirationProposalId,
      scope: { kind: 'user', canonicalUserId },
      createdAt: NOW + 2,
      candidateIds: [
        `expiration-memory-${platformId}-${secret}-a`,
        `expiration-memory-${platformId}-${secret}-b`,
      ],
    });
    const expirationTransition = new MemoryMaintenanceProposalRepository(
      db,
      new AuditRepository(db),
    ).transitionReview({
      proposalId: expirationProposalId,
      access: { kind: 'all' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'expire',
      actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
      authorityKind: 'local_admin',
      reasonCode: 'synthetic_expiration_preview_state_change',
      nowMs: NOW + 3,
    });
    expect(expirationTransition.outcome).toBe('transitioned');
    if (expirationTransition.outcome !== 'transitioned') {
      throw new Error('Expected maintenance expiration transition');
    }
    const expirationConfirmation = service.projectMemoryMaintenanceExpirationConfirmation({
      scope: { kind: 'user', canonicalUserId },
      proposal: expirationTransition.proposal,
      expectedRevisionNumber: 1,
    });
    expect(expirationConfirmation).toMatchObject({
      action: 'memory.maintenance.review.expire',
      outcome: 'expired',
      proposalRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      current: {
        lifecycleState: 'expired',
        revisionNumber: 2,
      },
      evidence: {
        transition: 'expire',
        revisionRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
        auditRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      memoryRecordMutation: false,
      rollback: {
        supported: false,
        boundary: 'expiration_does_not_apply_memory_effects',
      },
    });
    expect(Object.keys(expirationConfirmation ?? {}).sort()).toEqual([
      'action',
      'current',
      'evidence',
      'memoryRecordMutation',
      'outcome',
      'proposalRef',
      'rollback',
    ]);
    const serializedExpirationConfirmation = JSON.stringify(expirationConfirmation);
    expect(serializedExpirationConfirmation).not.toContain(expirationProposalId);
    expect(serializedExpirationConfirmation).not.toContain(canonicalUserId);
    expect(serializedExpirationConfirmation).not.toContain(secret);
    expect(serializedExpirationConfirmation).not.toContain(platformId);
    const expirationRevision = expirationTransition.proposal.revisions.find(
      (revision) => revision.revisionNumber === 2,
    );
    expect(serializedExpirationConfirmation).not.toContain(
      expirationRevision?.revisionId ?? expirationProposalId,
    );
    expect(serializedExpirationConfirmation).not.toContain(
      expirationRevision?.auditId ?? expirationProposalId,
    );
    expect(service.projectMemoryMaintenanceExpirationConfirmation({
      scope: { kind: 'global' },
      proposal: expirationTransition.proposal,
      expectedRevisionNumber: 1,
    })).toBeNull();
    expect(service.projectMemoryMaintenanceExpirationConfirmation({
      scope: { kind: 'user', canonicalUserId },
      proposal: expirationTransition.proposal,
      expectedRevisionNumber: 2,
    })).toBeNull();
    const changesAfterTransition = db.prepare('SELECT total_changes()').pluck().get();
    expect(await service.getMemoryMaintenanceRejectionPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceExpirationPreview({
      scope: { kind: 'user', canonicalUserId },
      proposalId,
    })).toBeNull();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesAfterTransition);
  });

  it('projects bounded approved maintenance-application effects without writes', async () => {
    const secret = 'private-application-preview-fixture';
    const platformId = '246813579';
    const memoryIds = {
      conflictA: `memory-${platformId}-${secret}-conflict-a`,
      conflictB: `memory-${platformId}-${secret}-conflict-b`,
      consolidationRetained: `memory-${platformId}-${secret}-consolidation-retained`,
      consolidationSuperseded: `memory-${platformId}-${secret}-consolidation-superseded`,
      decay: `memory-${platformId}-${secret}-decay`,
    };
    const hiddenConflictMemoryIds = Array.from(
      { length: 31 },
      (_, index) => `memory-${platformId}-${secret}-conflict-hidden-${index}`,
    );
    const memories = new MemoryRepository(db);
    const allMemoryIds = [...Object.values(memoryIds), ...hiddenConflictMemoryIds];
    for (const [ordinal, memoryId] of allMemoryIds.entries()) {
      memories.createSync({
        id: memoryId,
        scope: 'system',
        visibility: 'owner_admin_only',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: `Synthetic application preview ${ordinal}`,
        content: `private-content-${secret}-${ordinal}`,
        state: 'active',
        confidence: 0.7,
        importance: 0.5,
        sourceContext: 'admin_cli',
        sources: [{
          sourceType: 'user_command',
          sourceId: `source-${platformId}-${ordinal}`,
          sourceTimestamp: NOW - ordinal - 1,
          extractedBy: 'admin',
          external: true,
        }],
        actor: { actorClass: 'admin', context: 'admin_cli' },
      });
    }
    const audits = new AuditRepository(db);
    const conflict = await createMemoryMaintenanceProposal(db, audits, {
      kind: 'conflict',
      candidateMemoryIds: [
        memoryIds.conflictA,
        memoryIds.conflictB,
        ...hiddenConflictMemoryIds,
      ],
      reasonCodes: ['same_boundary_title_different_content'],
      proposedEffect: {
        type: 'resolve_conflict',
        candidateMemoryIds: [
          memoryIds.conflictA,
          memoryIds.conflictB,
          ...hiddenConflictMemoryIds,
        ],
      },
      nowMs: NOW,
    });
    const consolidation = await createMemoryMaintenanceProposal(db, audits, {
      kind: 'consolidation',
      candidateMemoryIds: [
        memoryIds.consolidationRetained,
        memoryIds.consolidationSuperseded,
      ],
      reasonCodes: ['same_boundary_title_and_content'],
      proposedEffect: {
        type: 'consolidate',
        retainedMemoryId: memoryIds.consolidationRetained,
        supersedeMemoryIds: [memoryIds.consolidationSuperseded],
      },
      nowMs: NOW + 1,
    });
    const decay = await createMemoryMaintenanceProposal(db, audits, {
      kind: 'decay',
      candidateMemoryIds: [memoryIds.decay],
      reasonCodes: ['stale'],
      proposedEffect: { type: 'disable', memoryId: memoryIds.decay },
      nowMs: NOW + 2,
    });
    const proposals = new MemoryMaintenanceProposalRepository(db, audits);
    const service = new GovernanceQueryService(db);
    const conflictDetail = await service.getMemoryMaintenanceReview({
      scope: { kind: 'system' },
      proposalId: conflict.proposalId,
    });
    const conflictRefs = conflictDetail?.candidates.map((candidate) => candidate.memoryRef) ?? [];
    const hiddenConflictMemoryId = [...hiddenConflictMemoryIds].sort().at(-1) ?? '';
    const hiddenConflictRef = createHash('sha256')
      .update('lethebot-governance:memory:v1\0', 'utf8')
      .update(hiddenConflictMemoryId, 'utf8')
      .digest('hex')
      .slice(0, 16);
    expect(conflictRefs).toHaveLength(32);
    expect(new Set(conflictRefs)).toHaveProperty('size', 32);
    expect(conflictRefs).not.toContain(hiddenConflictRef);
    expect(await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: conflict.proposalId,
      retainedMemoryRef: conflictRefs[0],
    })).toBeNull();

    for (const [index, proposalId] of [
      conflict.proposalId,
      consolidation.proposalId,
      decay.proposalId,
    ].entries()) {
      const approved = proposals.transitionReview({
        proposalId,
        access: { kind: 'all' },
        expectedState: 'pending_review',
        expectedRevisionNumber: 1,
        transition: 'approve',
        actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
        authorityKind: 'local_admin',
        reasonCode: 'synthetic_application_preview_approval',
        nowMs: NOW + 10 + index,
      });
      expect(approved.outcome).toBe('transitioned');
    }
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const conflictPreview = await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: conflict.proposalId,
      retainedMemoryRef: conflictRefs[0],
    });
    const repeatedConflictPreview = await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: conflict.proposalId,
      retainedMemoryRef: conflictRefs[0],
    });
    const alternateConflictPreview = await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: conflict.proposalId,
      retainedMemoryRef: conflictRefs[1],
    });
    const consolidationPreview = await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: consolidation.proposalId,
    });
    const decayPreview = await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: decay.proposalId,
    });
    const selectedConflictMemoryId = [
      memoryIds.conflictA,
      memoryIds.conflictB,
      ...hiddenConflictMemoryIds,
    ].find((memoryId) => createHash('sha256')
      .update('lethebot-governance:memory:v1\0', 'utf8')
      .update(memoryId, 'utf8')
      .digest('hex')
      .slice(0, 16) === conflictRefs[0]);
    expect(selectedConflictMemoryId).toBeDefined();
    expect(await service.resolveMemoryMaintenanceApplication({
      scope: { kind: 'system' },
      proposalId: conflict.proposalId,
      retainedMemoryRef: conflictRefs[0],
    })).toEqual({
      preview: conflictPreview,
      retainedMemoryId: selectedConflictMemoryId,
    });
    expect(await service.resolveMemoryMaintenanceApplication({
      scope: { kind: 'system' },
      proposalId: consolidation.proposalId,
    })).toEqual({ preview: consolidationPreview });
    expect(await service.resolveMemoryMaintenanceApplication({
      scope: { kind: 'system' },
      proposalId: decay.proposalId,
    })).toEqual({ preview: decayPreview });

    const expectedDurableEffects = [
      'proposal_state_transition',
      'proposal_revision_append',
      'audit_event_append',
      'memory_record_revision_append',
      'proposal_effect_evidence_append',
    ];
    expect(conflictPreview).toMatchObject({
      action: 'memory.maintenance.apply',
      scope: {
        scopeKind: 'system',
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      proposalKind: 'conflict',
      proposalRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      proposedEffect: 'resolve_conflict',
      affectedRecords: {
        count: 33,
        fingerprint: conflict.candidateFingerprint,
        roles: [
          {
            role: 'retained',
            count: 1,
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
          {
            role: 'superseded',
            count: 32,
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        ],
      },
      selection: {
        required: true,
        retainedMemoryRef: conflictRefs[0],
      },
      current: { lifecycleState: 'approved', revisionNumber: 2 },
      expected: {
        lifecycleState: 'applied',
        revisionNumber: 3,
        durableEffects: expectedDurableEffects,
        retrievalConsequences: ['superseded_records_excluded'],
      },
      rollback: {
        supported: true,
        boundary: 'separate_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(repeatedConflictPreview).toEqual(conflictPreview);
    expect(alternateConflictPreview).toMatchObject({
      selection: { required: true, retainedMemoryRef: conflictRefs[1] },
    });
    expect(alternateConflictPreview?.previewDigest).not.toBe(conflictPreview?.previewDigest);
    expect(alternateConflictPreview?.affectedRecords.roles).not.toEqual(
      conflictPreview?.affectedRecords.roles,
    );
    expect(consolidationPreview).toMatchObject({
      action: 'memory.maintenance.apply',
      proposalKind: 'consolidation',
      proposedEffect: 'consolidate',
      affectedRecords: {
        count: 2,
        fingerprint: consolidation.candidateFingerprint,
        roles: [
          {
            role: 'retained',
            count: 1,
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
          {
            role: 'superseded',
            count: 1,
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        ],
      },
      selection: { required: false },
      current: { lifecycleState: 'approved', revisionNumber: 2 },
      expected: {
        lifecycleState: 'applied',
        revisionNumber: 3,
        durableEffects: expectedDurableEffects,
        retrievalConsequences: ['superseded_records_excluded'],
      },
      rollback: { supported: true, boundary: 'separate_confirmation_required' },
    });
    expect(decayPreview).toMatchObject({
      action: 'memory.maintenance.apply',
      proposalKind: 'decay',
      proposedEffect: 'disable',
      affectedRecords: {
        count: 1,
        fingerprint: decay.candidateFingerprint,
        roles: [{
          role: 'disabled',
          count: 1,
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }],
      },
      selection: { required: false },
      current: { lifecycleState: 'approved', revisionNumber: 2 },
      expected: {
        lifecycleState: 'applied',
        revisionNumber: 3,
        durableEffects: expectedDurableEffects,
        retrievalConsequences: ['disabled_records_excluded'],
      },
      rollback: { supported: true, boundary: 'separate_confirmation_required' },
    });
    expect(Object.keys(conflictPreview ?? {}).sort()).toEqual([
      'action',
      'affectedRecords',
      'current',
      'expected',
      'previewDigest',
      'proposalKind',
      'proposalRef',
      'proposedEffect',
      'rollback',
      'scope',
      'selection',
    ]);
    if (!conflictPreview) {
      throw new Error('Expected maintenance application preview');
    }
    const { previewDigest, ...digestPayload } = conflictPreview;
    expect(previewDigest).toBe(createHash('sha256')
      .update('lethebot-governance:memory-maintenance-application-preview:v1\0', 'utf8')
      .update(JSON.stringify(digestPayload), 'utf8')
      .digest('hex'));

    expect(await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: conflict.proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: conflict.proposalId,
      retainedMemoryRef: 'f'.repeat(16),
    })).toBeNull();
    expect(await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: conflict.proposalId,
      retainedMemoryRef: hiddenConflictRef,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: consolidation.proposalId,
      retainedMemoryRef: conflictRefs[0],
    })).toBeNull();
    expect(await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: decay.proposalId,
      retainedMemoryRef: conflictRefs[0],
    })).toBeNull();
    expect(await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'global' },
      proposalId: decay.proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'tool', toolName: 'runtime.status' },
      proposalId: decay.proposalId,
    })).toBeNull();
    expect(await service.getMemoryMaintenanceApplicationPreview({
      scope: { kind: 'system' },
      proposalId: 'missing-proposal',
    })).toBeNull();
    const serialized = JSON.stringify({
      conflictPreview,
      alternateConflictPreview,
      consolidationPreview,
      decayPreview,
    });
    for (const rawValue of [
      secret,
      platformId,
      ...allMemoryIds,
      conflict.proposalId,
      consolidation.proposalId,
      decay.proposalId,
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('projects bounded applied maintenance rollback effects without writes', async () => {
    const secret = 'private-rollback-preview-fixture';
    const platformId = '975318642';
    const memoryId = `memory-${platformId}-${secret}`;
    const memories = new MemoryRepository(db);
    memories.createSync({
      id: memoryId,
      scope: 'system',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: 'Synthetic rollback preview',
      content: `private-content-${secret}`,
      state: 'active',
      confidence: 0.7,
      importance: 0.5,
      sourceContext: 'admin_cli',
      sources: [{
        sourceType: 'user_command',
        sourceId: `source-${platformId}`,
        sourceTimestamp: NOW - 1,
        extractedBy: 'admin',
        external: true,
      }],
      actor: { actorClass: 'admin', context: 'admin_cli' },
    });
    const audits = new AuditRepository(db);
    const proposal = await createMemoryMaintenanceProposal(db, audits, {
      kind: 'decay',
      candidateMemoryIds: [memoryId],
      reasonCodes: ['stale'],
      proposedEffect: { type: 'disable', memoryId },
      nowMs: NOW,
    });
    const proposals = new MemoryMaintenanceProposalRepository(db, audits);
    expect(proposals.transitionReview({
      proposalId: proposal.proposalId,
      access: { kind: 'all' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'approve',
      actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
      authorityKind: 'local_admin',
      reasonCode: 'synthetic_rollback_preview_approval',
      nowMs: NOW + 1,
    }).outcome).toBe('transitioned');
    expect(proposals.applyApproved({
      proposalId: proposal.proposalId,
      access: { kind: 'all' },
      expectedState: 'approved',
      expectedRevisionNumber: 2,
      actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
      authorityKind: 'local_admin',
      reasonCode: 'synthetic_rollback_preview_application',
      nowMs: NOW + 2,
    }).outcome).toBe('transitioned');
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const preview = await service.getMemoryMaintenanceRollbackPreview({
      scope: { kind: 'system' },
      proposalId: proposal.proposalId,
    });
    const repeatedPreview = await service.getMemoryMaintenanceRollbackPreview({
      scope: { kind: 'system' },
      proposalId: proposal.proposalId,
    });

    const expectedDurableEffects = [
      'proposal_state_transition',
      'proposal_revision_append',
      'audit_event_append',
      'memory_record_revision_append',
      'proposal_effect_evidence_append',
    ];
    expect(preview).toMatchObject({
      action: 'memory.maintenance.rollback',
      scope: {
        scopeKind: 'system',
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      proposalKind: 'decay',
      proposalRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      proposedEffect: 'disable',
      affectedRecords: {
        count: 1,
        fingerprint: proposal.candidateFingerprint,
        roles: [{
          role: 'restored',
          count: 1,
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }],
      },
      current: { lifecycleState: 'applied', revisionNumber: 3 },
      expected: {
        lifecycleState: 'rolled_back',
        revisionNumber: 4,
        durableEffects: expectedDurableEffects,
        retrievalConsequences: ['restored_records_included'],
      },
      confirmation: {
        required: true,
        boundary: 'separate_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(repeatedPreview).toEqual(preview);
    expect(Object.keys(preview ?? {}).sort()).toEqual([
      'action',
      'affectedRecords',
      'confirmation',
      'current',
      'expected',
      'previewDigest',
      'proposalKind',
      'proposalRef',
      'proposedEffect',
      'scope',
    ]);
    if (!preview) {
      throw new Error('Expected maintenance rollback preview');
    }
    const { previewDigest, ...digestPayload } = preview;
    expect(previewDigest).toBe(createHash('sha256')
      .update('lethebot-governance:memory-maintenance-rollback-preview:v1\0', 'utf8')
      .update(JSON.stringify(digestPayload), 'utf8')
      .digest('hex'));
    for (const input of [
      { scope: { kind: 'global' } as const, proposalId: proposal.proposalId },
      {
        scope: { kind: 'tool', toolName: 'runtime.status' } as const,
        proposalId: proposal.proposalId,
      },
      { scope: { kind: 'system' } as const, proposalId: 'missing-proposal' },
    ]) {
      expect(await service.getMemoryMaintenanceRollbackPreview(input)).toBeNull();
    }
    const serialized = JSON.stringify(preview);
    for (const rawValue of [secret, platformId, memoryId, proposal.proposalId]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare(
      'SELECT state FROM memory_records WHERE id = ?',
    ).get(memoryId)).toEqual({ state: 'disabled' });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    const rollback = proposals.rollbackApplied({
      proposalId: proposal.proposalId,
      access: { kind: 'all' },
      expectedState: 'applied',
      expectedRevisionNumber: 3,
      actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
      authorityKind: 'local_admin',
      reasonCode: 'synthetic_rollback_preview_confirmation',
      nowMs: NOW + 3,
    });
    if (rollback.outcome !== 'transitioned') {
      throw new Error('Expected maintenance rollback transition');
    }
    const confirmation = service.projectMemoryMaintenanceRollbackConfirmation({
      scope: { kind: 'system' },
      proposal: rollback.proposal,
      expectedRevisionNumber: 3,
      preview,
    });
    expect(confirmation).toEqual({
      action: 'memory.maintenance.rollback',
      outcome: 'rolled_back',
      proposalKind: 'decay',
      proposalRef: preview.proposalRef,
      proposedEffect: 'disable',
      affectedRecords: preview.affectedRecords,
      current: { lifecycleState: 'rolled_back', revisionNumber: 4 },
      retrievalConsequences: ['restored_records_included'],
      evidence: {
        transition: 'rollback',
        revisionRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
        auditRef: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
      rollback: {
        supported: false,
        boundary: 'rollback_is_terminal',
      },
    });
    expect(Object.keys(confirmation ?? {}).sort()).toEqual([
      'action',
      'affectedRecords',
      'current',
      'evidence',
      'outcome',
      'proposalKind',
      'proposalRef',
      'proposedEffect',
      'retrievalConsequences',
      'rollback',
    ]);
    expect(service.projectMemoryMaintenanceRollbackConfirmation({
      scope: { kind: 'global' },
      proposal: rollback.proposal,
      expectedRevisionNumber: 3,
      preview,
    })).toBeNull();
    expect(service.projectMemoryMaintenanceRollbackConfirmation({
      scope: { kind: 'system' },
      proposal: rollback.proposal,
      expectedRevisionNumber: 2,
      preview,
    })).toBeNull();
    const serializedConfirmation = JSON.stringify(confirmation);
    for (const rawValue of [secret, platformId, memoryId, proposal.proposalId]) {
      expect(serializedConfirmation).not.toContain(rawValue);
    }
    expect(db.prepare(
      'SELECT state FROM memory_records WHERE id = ?',
    ).get(memoryId)).toEqual({ state: 'active' });
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('lists distinct maintenance-review scopes with fixed redacted labels', async () => {
    const secret = 'sk-scopecatalogabcdefghijklmnopqrstuvwxyz123456';
    const platformId = '123456789';
    const canonicalUserId = `user-${platformId}-${secret}`;
    const groupId = `group-${platformId}-${secret}`;
    const privateConversationId = `private-${platformId}-${secret}`;
    const groupConversationId = `conversation-${platformId}-${secret}`;
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-catalog-global-a',
      scope: { kind: 'global' },
      createdAt: NOW,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-catalog-global-b',
      scope: { kind: 'global' },
      createdAt: NOW + 1,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-catalog-user',
      scope: { kind: 'user', canonicalUserId },
      createdAt: NOW + 2,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-catalog-group',
      scope: { kind: 'group', groupId },
      createdAt: NOW + 3,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-catalog-private-conversation',
      scope: {
        kind: 'conversation',
        conversationId: privateConversationId,
        conversationType: 'private',
      },
      createdAt: NOW + 4,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-catalog-group-conversation',
      scope: {
        kind: 'conversation',
        conversationId: groupConversationId,
        conversationType: 'group',
        groupId,
      },
      createdAt: NOW + 5,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-catalog-system',
      scope: { kind: 'system' },
      createdAt: NOW + 6,
    });
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-catalog-tool',
      scope: { kind: 'tool' },
      createdAt: NOW + 7,
    });
    const transition = new MemoryMaintenanceProposalRepository(
      db,
      new AuditRepository(db),
    ).transitionReview({
      proposalId: 'proposal-catalog-system',
      access: { kind: 'all' },
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'reject',
      actor: { actorClass: 'admin', invocationContext: 'admin_cli' },
      authorityKind: 'local_admin',
      reasonCode: 'synthetic_catalog_rejection',
      nowMs: NOW + 8,
    });
    expect(transition.outcome).toBe('transitioned');
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const sessionId = 'a'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const registry = new GovernanceScopeHandleRegistry({ now: () => NOW });
    const issueHandle = (scope: NormalizedMaintenanceScope) => ({
      ...registry.issue({
        sessionId,
        sessionExpiresAt,
        purpose: 'memory.maintenance.review',
        scope,
      }),
      rawScope: scope,
      ignoredSessionId: sessionId,
      ignoredSecret: secret,
    });

    const catalog = await service.listMemoryMaintenanceReviewScopes();
    const repeated = await service.listMemoryMaintenanceReviewScopes();
    const issuedCatalog = await service.listMemoryMaintenanceReviewScopeHandles(issueHandle);
    const repeatedIssuedCatalog = await service.listMemoryMaintenanceReviewScopeHandles(issueHandle);

    expect(catalog).toEqual(repeated);
    expect(catalog.truncated).toBe(false);
    expect(catalog.entries).toEqual([
      expect.objectContaining({ scopeKind: 'global', label: 'Global memory' }),
      expect.objectContaining({ scopeKind: 'user', label: 'User memory' }),
      expect.objectContaining({ scopeKind: 'group', label: 'Group memory' }),
      expect.objectContaining({
        scopeKind: 'conversation',
        conversationType: 'private',
        label: 'Private conversation memory',
      }),
      expect.objectContaining({
        scopeKind: 'conversation',
        conversationType: 'group',
        label: 'Group conversation memory',
      }),
      expect.objectContaining({ scopeKind: 'system', label: 'System memory' }),
    ]);
    expect(catalog.entries.every((entry) => /^[0-9a-f]{16}$/u.test(entry.fingerprint))).toBe(true);
    expect(new Set(catalog.entries.map((entry) => entry.fingerprint))).toHaveProperty('size', 6);
    expect(issuedCatalog).toEqual(repeatedIssuedCatalog);
    expect(issuedCatalog.truncated).toBe(false);
    expect(issuedCatalog.entries.map(({ handle: _handle, expiresAt: _expiresAt, ...entry }) => entry))
      .toEqual(catalog.entries);
    expect(issuedCatalog.entries.every((entry) => /^[A-Za-z0-9_-]{43}$/u.test(entry.handle)))
      .toBe(true);
    expect(issuedCatalog.entries.every((entry) => entry.expiresAt === sessionExpiresAt)).toBe(true);
    expect(new Set(issuedCatalog.entries.map((entry) => entry.handle))).toHaveProperty('size', 6);
    const expectedScopes: NormalizedMaintenanceScope[] = [
      { kind: 'global' },
      { kind: 'user', canonicalUserId },
      { kind: 'group', groupId },
      {
        kind: 'conversation',
        conversationId: privateConversationId,
        conversationType: 'private',
      },
      {
        kind: 'conversation',
        conversationId: groupConversationId,
        conversationType: 'group',
        groupId,
      },
      { kind: 'system' },
    ];
    issuedCatalog.entries.forEach((entry, index) => {
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'memory.maintenance.review',
      })).toEqual(expectedScopes[index]);
      expect(Object.keys(entry).sort()).toEqual([
        'expiresAt',
        'fingerprint',
        'handle',
        'label',
        'scopeKind',
        ...(entry.conversationType === undefined ? [] : ['conversationType']),
      ].sort());
    });

    const serialized = JSON.stringify({ catalog, issuedCatalog });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(canonicalUserId);
    expect(serialized).not.toContain(groupId);
    expect(serialized).not.toContain(privateConversationId);
    expect(serialized).not.toContain(groupConversationId);
    expect(serialized).not.toContain('tool');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('deduplicates maintenance-review scopes before the bounded catalog limit', async () => {
    for (let index = 0; index < 2; index += 1) {
      insertNormalizedMaintenanceProposal(db, {
        proposalId: `proposal-catalog-duplicate-${index}`,
        scope: { kind: 'global' },
        createdAt: NOW + index,
      });
    }
    for (let index = 0; index < 100; index += 1) {
      insertNormalizedMaintenanceProposal(db, {
        proposalId: `proposal-catalog-user-${String(index).padStart(3, '0')}`,
        scope: {
          kind: 'user',
          canonicalUserId: `catalog-user-${String(index).padStart(3, '0')}`,
        },
        createdAt: NOW + index + 2,
      });
    }
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const catalog = await service.listMemoryMaintenanceReviewScopes();

    expect(catalog.entries).toHaveLength(100);
    expect(catalog.truncated).toBe(true);
    expect(catalog.entries.filter((entry) => entry.scopeKind === 'global')).toHaveLength(1);
    expect(catalog.entries.filter((entry) => entry.scopeKind === 'user')).toHaveLength(99);
    expect(new Set(catalog.entries.map((entry) => entry.fingerprint))).toHaveProperty('size', 100);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues a fixed Memory-record scope catalog with exact purpose-isolated handles', async () => {
    const platformId = '135792468';
    const secret = 'sk-memorycatalogabcdefghijklmnopqrstuvwxyz123456';
    const canonicalUserId = `memory-user-${platformId}-${secret}`;
    const groupId = `memory-group-${platformId}-${secret}`;
    const privateConversationId = `memory-private-${platformId}-${secret}`;
    const groupConversationId = `memory-conversation-${platformId}-${secret}`;
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-global-proposed',
      scope: 'global',
      state: 'proposed',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-global-active',
      scope: 'global',
      state: 'active',
      groupId: 'ignored-global-group',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-user-active',
      scope: 'user',
      canonicalUserId,
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-user-rejected',
      scope: 'user',
      canonicalUserId,
      state: 'rejected',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-group-superseded',
      scope: 'group',
      groupId,
      state: 'superseded',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-private-disabled',
      scope: 'conversation',
      conversationId: privateConversationId,
      state: 'disabled',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-group-conversation-deleted',
      scope: 'conversation',
      groupId,
      conversationId: groupConversationId,
      state: 'deleted',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-system-active',
      scope: 'system',
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-tool-omitted',
      scope: 'tool',
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-user-missing',
      scope: 'user',
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-group-blank',
      scope: 'group',
      groupId: '',
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-group-padded',
      scope: 'group',
      groupId: ' padded-group ',
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-group-unicode-padded',
      scope: 'group',
      groupId: '\u00a0padded-group\u00a0',
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-group-control',
      scope: 'group',
      groupId: 'control\ngroup',
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-group-non-text',
      scope: 'group',
      groupId: Buffer.from('24680', 'utf8'),
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-conversation-overlong',
      scope: 'conversation',
      conversationId: 'x'.repeat(257),
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-group-conversation-blank-group',
      scope: 'conversation',
      groupId: '',
      conversationId: 'conversation-with-invalid-group',
      state: 'active',
    });
    expect(db.prepare('SELECT COUNT(*) FROM memory_maintenance_proposals').pluck().get()).toBe(0);

    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const sessionId = 'c'.repeat(64);
    const otherSessionId = 'd'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const registry = new GovernanceScopeHandleRegistry({ now: () => NOW });
    const issuedScopes: MemoryRecordCatalogScope[] = [];
    const issueHandle = (scope: MemoryRecordCatalogScope) => {
      issuedScopes.push(scope);
      return {
        ...registry.issue({
          sessionId,
          sessionExpiresAt,
          purpose: 'governance.memory.records.read',
          scope,
        }),
        rawScope: scope,
        ignoredSessionId: sessionId,
        ignoredSecret: secret,
      };
    };

    const catalog = await service.listMemoryRecordScopeHandles(issueHandle);
    const repeated = await service.listMemoryRecordScopeHandles(issueHandle);
    const expectedScopes: MemoryRecordCatalogScope[] = [
      { kind: 'global' },
      { kind: 'user', canonicalUserId },
      { kind: 'group', groupId },
      {
        kind: 'conversation',
        conversationId: privateConversationId,
        conversationType: 'private',
      },
      {
        kind: 'conversation',
        conversationId: groupConversationId,
        conversationType: 'group',
        groupId,
      },
      { kind: 'system' },
    ];

    expect(catalog).toEqual(repeated);
    expect(catalog.truncated).toBe(false);
    expect(catalog.entries).toEqual([
      expect.objectContaining({ scopeKind: 'global', label: 'Global memory' }),
      expect.objectContaining({ scopeKind: 'user', label: 'User memory' }),
      expect.objectContaining({ scopeKind: 'group', label: 'Group memory' }),
      expect.objectContaining({
        scopeKind: 'conversation',
        conversationType: 'private',
        label: 'Private conversation memory',
      }),
      expect.objectContaining({
        scopeKind: 'conversation',
        conversationType: 'group',
        label: 'Group conversation memory',
      }),
      expect.objectContaining({ scopeKind: 'system', label: 'System memory' }),
    ]);
    expect(issuedScopes).toEqual([...expectedScopes, ...expectedScopes]);
    expect(catalog.entries.map((entry) => entry.fingerprint)).toEqual(
      expectedScopes.map((scope) => createHash('sha256')
        .update('lethebot-governance:memory-maintenance-scope:v1\0', 'utf8')
        .update(JSON.stringify(scope), 'utf8')
        .digest('hex')
        .slice(0, 16)),
    );
    expect(catalog.entries.every((entry) => /^[A-Za-z0-9_-]{43}$/u.test(entry.handle)))
      .toBe(true);
    expect(catalog.entries.every((entry) => entry.expiresAt === sessionExpiresAt)).toBe(true);
    catalog.entries.forEach((entry, index) => {
      expect(Object.keys(entry).sort()).toEqual([
        'expiresAt',
        'fingerprint',
        'handle',
        'label',
        'scopeKind',
        ...(entry.conversationType === undefined ? [] : ['conversationType']),
      ].sort());
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'governance.memory.records.read',
      })).toEqual(expectedScopes[index]);
      expect(registry.resolve({
        sessionId: otherSessionId,
        handle: entry.handle,
        purpose: 'governance.memory.records.read',
      })).toBeNull();
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'memory.maintenance.review',
      })).toBeNull();
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'governance.privacy.preferences.read',
      })).toBeNull();
    });

    const serialized = JSON.stringify(catalog);
    for (const rawValue of [
      secret,
      sessionId,
      platformId,
      canonicalUserId,
      groupId,
      privateConversationId,
      groupConversationId,
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(serialized).not.toContain('tool');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('deduplicates Memory-record scopes before the 100/101 catalog bound', async () => {
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-bound-global-active',
      scope: 'global',
      state: 'active',
    });
    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-bound-global-disabled',
      scope: 'global',
      state: 'disabled',
    });
    for (let index = 0; index < 99; index += 1) {
      insertMemoryScopeCatalogRecord(db, {
        id: `memory-scope-bound-group-${String(index).padStart(3, '0')}`,
        scope: 'group',
        groupId: `memory-scope-bound-group-${String(index).padStart(3, '0')}`,
        state: index % 2 === 0 ? 'active' : 'deleted',
      });
    }
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const registry = new GovernanceScopeHandleRegistry({ now: () => NOW });
    const sessionId = 'e'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const issuedScopes: MemoryRecordCatalogScope[] = [];
    const issueHandle = vi.fn((scope: MemoryRecordCatalogScope) => {
      issuedScopes.push(scope);
      return registry.issue({
        sessionId,
        sessionExpiresAt,
        purpose: 'governance.memory.records.read',
        scope,
      });
    });

    const exactBound = await service.listMemoryRecordScopeHandles(issueHandle);
    expect(exactBound.entries).toHaveLength(100);
    expect(exactBound.truncated).toBe(false);
    expect(exactBound.entries.filter((entry) => entry.scopeKind === 'global')).toHaveLength(1);
    expect(exactBound.entries.filter((entry) => entry.scopeKind === 'group')).toHaveLength(99);

    insertMemoryScopeCatalogRecord(db, {
      id: 'memory-scope-bound-group-099',
      scope: 'group',
      groupId: 'memory-scope-bound-group-099',
      state: 'rejected',
    });
    const bounded = await service.listMemoryRecordScopeHandles(issueHandle);

    expect(bounded.entries).toEqual(exactBound.entries);
    expect(bounded.truncated).toBe(true);
    expect(issueHandle).toHaveBeenCalledTimes(200);
    expect(issuedScopes).toHaveLength(200);
    expect(issuedScopes[0]).toEqual({ kind: 'global' });
    expect(issuedScopes[99]).toEqual({ kind: 'group', groupId: 'memory-scope-bound-group-098' });
    expect(issuedScopes[199]).toEqual({ kind: 'group', groupId: 'memory-scope-bound-group-098' });
    expect(new Set(bounded.entries.map((entry) => entry.fingerprint))).toHaveProperty('size', 100);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore + 1);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('projects a bounded exact-scope Memory-record page without raw identifiers', async () => {
    const platformId = '864209753';
    const secret = 'sk-memorypageabcdefghijklmnopqrstuvwxyz123456';
    const targetUserId = `memory-page-user-${platformId}-${secret}`;
    const otherUserId = `memory-page-other-user-${platformId}-${secret}`;
    const targetGroupId = `memory-page-group-${platformId}-${secret}`;
    const otherGroupId = `memory-page-other-group-${platformId}-${secret}`;
    const conversationId = `memory-page-conversation-${platformId}-${secret}`;
    const states: MemoryRecord['state'][] = [
      'proposed',
      'active',
      'rejected',
      'superseded',
      'disabled',
      'deleted',
    ];
    const targetIds = Array.from({ length: 101 }, (_, index) => (
      index === 0
        ? `memory-page-order-a-${platformId}-${secret}`
        : index === 1
          ? `memory-page-order-b-${platformId}-${secret}`
          : `memory-page-target-${String(index).padStart(3, '0')}-${platformId}-${secret}`
    ));

    targetIds.forEach((id, index) => {
      const visibleTextRecord = index === 2;
      insertMemoryRecordPageRecord(db, {
        id,
        scope: 'user',
        canonicalUserId: targetUserId,
        subjectUserId: `hidden-subject-${platformId}-${secret}`,
        sensitivity: index === 3 ? 'secret' : index === 4 ? 'prohibited' : 'normal',
        state: states[index % states.length] ?? 'active',
        title: visibleTextRecord
          ? `title-${platformId}-${'T'.repeat(180)} api_key=${secret}`
          : `Synthetic Memory page title ${index} api_key=${secret}`,
        content: visibleTextRecord
          ? `content-${platformId}-${'C'.repeat(540)} api_key=${secret}`
          : `Synthetic Memory page content ${index} api_key=${secret}`,
        importance: index < 2 ? 1 : index === 2 ? 0.99 : 0.5,
        createdAt: index < 2 ? NOW + 500 : NOW + 400 - index,
        updatedAt: index < 2 ? NOW + 500 : NOW + 400 - index,
        expiresAt: visibleTextRecord ? NOW + 10_000 : null,
        sourceCount: visibleTextRecord ? 2 : 0,
        revisionCount: visibleTextRecord ? 3 : 0,
      });
    });
    for (let index = 0; index < 101; index += 1) {
      insertMemoryRecordPageRecord(db, {
        id: `memory-page-global-${String(index).padStart(3, '0')}-${platformId}-${secret}`,
        scope: 'global',
        state: states[index % states.length] ?? 'active',
        importance: 1,
        createdAt: NOW + 10_000 + index,
        updatedAt: NOW + 10_000 + index,
      });
    }
    const malformedGlobalId = `memory-page-global-malformed-${platformId}-${secret}`;
    insertMemoryRecordPageRecord(db, {
      id: malformedGlobalId,
      scope: 'global',
      groupId: targetGroupId,
      state: 'active',
      importance: 1,
      createdAt: NOW + 20_000,
      updatedAt: NOW + 20_000,
    });
    const cleanSystemId = `memory-page-system-clean-${platformId}-${secret}`;
    const malformedSystemId = `memory-page-system-malformed-${platformId}-${secret}`;
    insertMemoryRecordPageRecord(db, {
      id: cleanSystemId,
      scope: 'system',
      state: 'disabled',
    });
    insertMemoryRecordPageRecord(db, {
      id: malformedSystemId,
      scope: 'system',
      canonicalUserId: otherUserId,
      state: 'active',
    });
    insertMemoryRecordPageRecord(db, {
      id: `memory-page-other-user-${platformId}-${secret}`,
      scope: 'user',
      canonicalUserId: otherUserId,
      state: 'active',
      importance: 1,
      createdAt: NOW + 30_000,
      updatedAt: NOW + 30_000,
    });
    const targetGroupMemoryId = `memory-page-target-group-${platformId}-${secret}`;
    insertMemoryRecordPageRecord(db, {
      id: targetGroupMemoryId,
      scope: 'group',
      groupId: targetGroupId,
      state: 'rejected',
    });
    insertMemoryRecordPageRecord(db, {
      id: `memory-page-other-group-${platformId}-${secret}`,
      scope: 'group',
      groupId: otherGroupId,
      state: 'active',
    });
    const privateConversationMemoryId = `memory-page-private-${platformId}-${secret}`;
    const groupConversationMemoryId = `memory-page-group-conversation-${platformId}-${secret}`;
    insertMemoryRecordPageRecord(db, {
      id: privateConversationMemoryId,
      scope: 'conversation',
      conversationId,
      state: 'superseded',
    });
    insertMemoryRecordPageRecord(db, {
      id: groupConversationMemoryId,
      scope: 'conversation',
      groupId: targetGroupId,
      conversationId,
      state: 'deleted',
    });
    insertMemoryRecordPageRecord(db, {
      id: `memory-page-other-group-conversation-${platformId}-${secret}`,
      scope: 'conversation',
      groupId: otherGroupId,
      conversationId,
      state: 'active',
    });
    insertMemoryRecordPageRecord(db, {
      id: `memory-page-tool-${platformId}-${secret}`,
      scope: 'tool',
      state: 'active',
    });

    const recordRef = (id: string) => createHash('sha256')
      .update('lethebot-governance:memory:v1\0', 'utf8')
      .update(id, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const service = new GovernanceQueryService(db);
    const listMemory = vi.spyOn(service, 'listMemory');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const page = await service.listMemoryRecordsForScope({
      kind: 'user',
      canonicalUserId: targetUserId,
    });
    const repeated = await service.listMemoryRecordsForScope({
      kind: 'user',
      canonicalUserId: targetUserId,
    });

    expect(repeated).toEqual(page);
    expect(page.entries).toHaveLength(100);
    expect(page.truncated).toBe(true);
    expect(page.entries.slice(0, 2).map((entry) => entry.recordRef)).toEqual([
      recordRef(targetIds[0] ?? ''),
      recordRef(targetIds[1] ?? ''),
    ]);
    expect([...new Set(page.entries.map((entry) => entry.state))].sort()).toEqual(
      [...states].sort(),
    );
    expect(page.entries.every((entry) => entry.scopeKind === 'user')).toBe(true);
    expect(page.entries.every((entry) => /^[0-9a-f]{16}$/u.test(entry.recordRef))).toBe(true);
    expect(page.entries.every((entry) => Array.from(entry.title).length <= 160)).toBe(true);
    expect(page.entries.every((entry) => Array.from(entry.contentPreview).length <= 512)).toBe(true);

    const visible = page.entries.find((entry) => entry.recordRef === recordRef(targetIds[2] ?? ''));
    expect(visible).toEqual({
      recordRef: recordRef(targetIds[2] ?? ''),
      scopeKind: 'user',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: expect.stringContaining('[REDACTED:platform_id]'),
      contentPreview: expect.stringContaining('[REDACTED:platform_id]'),
      state: 'rejected',
      confidence: 0.5,
      importance: 0.99,
      sourceCount: 2,
      revisionCount: 3,
      createdAt: new Date(NOW + 398),
      updatedAt: new Date(NOW + 398),
      expiresAt: new Date(NOW + 10_000),
      textHidden: false,
      titleRedacted: true,
      titleTruncated: true,
      contentRedacted: true,
      contentTruncated: true,
    });
    expect(Object.keys(visible ?? {}).sort()).toEqual([
      'authority',
      'confidence',
      'contentPreview',
      'contentRedacted',
      'contentTruncated',
      'createdAt',
      'expiresAt',
      'importance',
      'kind',
      'recordRef',
      'revisionCount',
      'scopeKind',
      'sensitivity',
      'sourceCount',
      'state',
      'textHidden',
      'title',
      'titleRedacted',
      'titleTruncated',
      'updatedAt',
      'visibility',
    ].sort());
    for (const index of [3, 4]) {
      expect(page.entries.find(
        (entry) => entry.recordRef === recordRef(targetIds[index] ?? ''),
      )).toMatchObject({
        title: '[REDACTED:restricted_memory]',
        contentPreview: '[REDACTED:restricted_memory]',
        textHidden: true,
        titleRedacted: true,
        titleTruncated: false,
        contentRedacted: true,
        contentTruncated: false,
      });
    }

    const globalPage = await service.listMemoryRecordsForScope({ kind: 'global' });
    expect(globalPage.entries).toHaveLength(100);
    expect(globalPage.truncated).toBe(true);
    expect(globalPage.entries.map((entry) => entry.recordRef))
      .not.toContain(recordRef(malformedGlobalId));
    await expect(service.listMemoryRecordsForScope({ kind: 'system' })).resolves.toEqual({
      entries: [expect.objectContaining({ recordRef: recordRef(cleanSystemId) })],
      truncated: false,
    });
    const groupPage = await service.listMemoryRecordsForScope({
      kind: 'group',
      groupId: targetGroupId,
    });
    expect(groupPage.entries.map((entry) => entry.recordRef)).toEqual([
      recordRef(targetGroupMemoryId),
    ]);
    const privateConversationPage = await service.listMemoryRecordsForScope({
      kind: 'conversation',
      conversationId,
      conversationType: 'private',
    });
    expect(privateConversationPage.entries.map((entry) => entry.recordRef)).toEqual([
      recordRef(privateConversationMemoryId),
    ]);
    const groupConversationPage = await service.listMemoryRecordsForScope({
      kind: 'conversation',
      conversationId,
      conversationType: 'group',
      groupId: targetGroupId,
    });
    expect(groupConversationPage.entries.map((entry) => entry.recordRef)).toEqual([
      recordRef(groupConversationMemoryId),
    ]);
    await expect(service.listMemoryRecordsForScope({
      kind: 'tool',
      toolName: 'runtime.status',
    })).resolves.toEqual({ entries: [], truncated: false });

    expect(listMemory).not.toHaveBeenCalled();
    const serialized = JSON.stringify({
      page,
      globalPage,
      groupPage,
      privateConversationPage,
      groupConversationPage,
    });
    for (const rawValue of [
      platformId,
      secret,
      targetUserId,
      targetGroupId,
      conversationId,
      'hidden-subject',
      'memory-page-target',
      'memory-page-global',
      'memory-page-source',
      'memory-page-revision',
      'memory_page_source_context',
      'memory-page-evaluator',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues resource handles only for the bounded exact-scope Memory-record page', async () => {
    const platformId = '246813579';
    const secret = 'sk-memoryresourceabcdefghijklmnopqrstuvwxyz123456';
    const canonicalUserId = `memory-resource-user-${platformId}-${secret}`;
    const otherUserId = `memory-resource-other-user-${platformId}-${secret}`;
    const groupId = `memory-resource-group-${platformId}-${secret}`;
    const conversationId = `memory-resource-conversation-${platformId}-${secret}`;
    const targetIds = Array.from({ length: 101 }, (_, index) => (
      `memory-resource-target-${String(index).padStart(3, '0')}-${platformId}-${secret}`
    ));
    targetIds.forEach((id, index) => {
      insertMemoryRecordPageRecord(db, {
        id,
        scope: 'user',
        canonicalUserId,
        sensitivity: index === 0 ? 'secret' : 'normal',
        state: index % 2 === 0 ? 'active' : 'disabled',
        title: `Resource title ${platformId} api_key=${secret}`,
        content: `Resource content ${platformId} password=${secret}`,
        importance: 0.5,
        createdAt: NOW,
        updatedAt: NOW,
        sourceCount: index === 1 ? 2 : 0,
        revisionCount: index === 1 ? 3 : 0,
      });
    });
    const crossScopeId = `memory-resource-cross-scope-${platformId}-${secret}`;
    insertMemoryRecordPageRecord(db, {
      id: crossScopeId,
      scope: 'user',
      canonicalUserId: otherUserId,
      state: 'active',
      importance: 1,
      createdAt: NOW + 1,
      updatedAt: NOW + 1,
    });
    const globalId = `memory-resource-global-${platformId}-${secret}`;
    const malformedGlobalId = `memory-resource-malformed-global-${platformId}-${secret}`;
    const groupMemoryId = `memory-resource-group-record-${platformId}-${secret}`;
    const privateConversationMemoryId = `memory-resource-private-${platformId}-${secret}`;
    const groupConversationMemoryId = `memory-resource-group-conversation-${platformId}-${secret}`;
    const systemMemoryId = `memory-resource-system-${platformId}-${secret}`;
    insertMemoryRecordPageRecord(db, {
      id: globalId,
      scope: 'global',
      state: 'proposed',
    });
    insertMemoryRecordPageRecord(db, {
      id: malformedGlobalId,
      scope: 'global',
      groupId,
      state: 'active',
      importance: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: groupMemoryId,
      scope: 'group',
      groupId,
      state: 'rejected',
    });
    insertMemoryRecordPageRecord(db, {
      id: privateConversationMemoryId,
      scope: 'conversation',
      conversationId,
      state: 'superseded',
    });
    insertMemoryRecordPageRecord(db, {
      id: groupConversationMemoryId,
      scope: 'conversation',
      conversationId,
      groupId,
      state: 'deleted',
    });
    insertMemoryRecordPageRecord(db, {
      id: systemMemoryId,
      scope: 'system',
      state: 'disabled',
    });
    insertMemoryRecordPageRecord(db, {
      id: `memory-resource-tool-${platformId}-${secret}`,
      scope: 'tool',
      state: 'active',
    });

    const service = new GovernanceQueryService(db);
    const registry = new GovernanceResourceHandleRegistry({ now: () => NOW });
    const sessionId = 'f'.repeat(64);
    const otherSessionId = '0'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const issuedInputs: Array<{
      scope: MemoryRecordCatalogScope;
      memoryId: string;
    }> = [];
    const issueHandle = vi.fn((input: {
      scope: MemoryRecordCatalogScope;
      memoryId: string;
    }) => {
      issuedInputs.push(input);
      return {
        ...registry.issue({
          sessionId,
          sessionExpiresAt,
          purpose: 'governance.memory.records.read',
          resourceKind: 'memory_record',
          resourceId: input.memoryId,
          scope: input.scope,
        }),
        rawScope: input.scope,
        rawMemoryId: input.memoryId,
        ignoredSessionId: sessionId,
        ignoredSecret: secret,
      };
    });
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const userScope: MemoryRecordCatalogScope = { kind: 'user', canonicalUserId };

    const page = await service.listMemoryRecordResourceHandlePage(userScope, issueHandle);
    const repeated = await service.listMemoryRecordResourceHandlePage(userScope, issueHandle);
    const basePage = await service.listMemoryRecordsForScope(userScope);

    expect(repeated).toEqual(page);
    expect(page.entries).toHaveLength(100);
    expect(page.truncated).toBe(true);
    expect(issueHandle).toHaveBeenCalledTimes(200);
    expect(issuedInputs.slice(0, 100)).toEqual(targetIds.slice(0, 100).map((memoryId) => ({
      scope: userScope,
      memoryId,
    })));
    expect(issuedInputs.slice(100)).toEqual(issuedInputs.slice(0, 100));
    expect(issuedInputs.some((input) => input.memoryId === targetIds[100])).toBe(false);
    expect(issuedInputs.some((input) => input.memoryId === crossScopeId)).toBe(false);
    expect(page.entries.map(({ handle: _handle, handleExpiresAt: _expiry, ...record }) => record))
      .toEqual(basePage.entries);
    expect(page.truncated).toBe(basePage.truncated);
    expect(Object.keys(page.entries[0] ?? {}).sort()).toEqual([
      ...Object.keys(basePage.entries[0] ?? {}),
      'handle',
      'handleExpiresAt',
    ].sort());
    expect(page.entries.every((entry) => /^[A-Za-z0-9_-]{43}$/u.test(entry.handle))).toBe(true);
    expect(page.entries.every((entry) => entry.handleExpiresAt === sessionExpiresAt)).toBe(true);
    expect(page.entries[0]).toMatchObject({
      title: '[REDACTED:restricted_memory]',
      contentPreview: '[REDACTED:restricted_memory]',
      textHidden: true,
    });
    expect(page.entries[1]).toMatchObject({ sourceCount: 2, revisionCount: 3 });
    page.entries.forEach((entry, index) => {
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'governance.memory.records.read',
        resourceKind: 'memory_record',
        scope: userScope,
      })).toEqual({ kind: 'memory_record', resourceId: targetIds[index] });
    });
    const firstHandle = page.entries[0]?.handle ?? '';
    expect(registry.resolve({
      sessionId: otherSessionId,
      handle: firstHandle,
      purpose: 'governance.memory.records.read',
      resourceKind: 'memory_record',
      scope: userScope,
    })).toBeNull();
    expect(registry.resolve({
      sessionId,
      handle: firstHandle,
      purpose: 'memory.maintenance.review',
      resourceKind: 'memory_record',
      scope: userScope,
    })).toBeNull();
    expect(registry.resolve({
      sessionId,
      handle: firstHandle,
      purpose: 'governance.memory.records.read',
      resourceKind: 'memory_maintenance_review',
      scope: userScope,
    })).toBeNull();
    expect(registry.resolve({
      sessionId,
      handle: firstHandle,
      purpose: 'governance.memory.records.read',
      resourceKind: 'memory_record',
      scope: { kind: 'global' },
    })).toBeNull();

    const supportedRecords: Array<{
      scope: MemoryRecordCatalogScope;
      memoryId: string;
    }> = [
      { scope: { kind: 'global' }, memoryId: globalId },
      { scope: { kind: 'group', groupId }, memoryId: groupMemoryId },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'private',
        },
        memoryId: privateConversationMemoryId,
      },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'group',
          groupId,
        },
        memoryId: groupConversationMemoryId,
      },
      { scope: { kind: 'system' }, memoryId: systemMemoryId },
    ];
    for (const expected of supportedRecords) {
      const callCount = issueHandle.mock.calls.length;
      const scopedPage = await service.listMemoryRecordResourceHandlePage(
        expected.scope,
        issueHandle,
      );
      expect(scopedPage.entries).toHaveLength(1);
      expect(scopedPage.truncated).toBe(false);
      expect(issuedInputs[callCount]).toEqual(expected);
    }
    expect(issuedInputs.some((input) => input.memoryId === malformedGlobalId)).toBe(false);
    const callsBeforeEmptyScopes = issueHandle.mock.calls.length;
    await expect(service.listMemoryRecordResourceHandlePage(
      { kind: 'group', groupId: 'memory-resource-empty-group' },
      issueHandle,
    )).resolves.toEqual({ entries: [], truncated: false });
    await expect(service.listMemoryRecordResourceHandlePage(
      { kind: 'tool', toolName: 'runtime.status' },
      issueHandle,
    )).resolves.toEqual({ entries: [], truncated: false });
    expect(issueHandle).toHaveBeenCalledTimes(callsBeforeEmptyScopes);

    const serialized = JSON.stringify({ page, repeated });
    for (const rawValue of [
      platformId,
      secret,
      sessionId,
      canonicalUserId,
      groupId,
      conversationId,
      'memory-resource-target',
      'memory-resource-cross-scope',
      'memory-page-source',
      'memory-page-revision',
      'memory_page_source_context',
      'memory-page-evaluator',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('projects bounded exact-scope Memory provenance without raw identifiers', async () => {
    const platformId = '975310864';
    const secret = 'sk-memorydetailabcdefghijklmnopqrstuvwxyz123456';
    const canonicalUserId = `memory-detail-user-${platformId}-${secret}`;
    const otherUserId = `memory-detail-other-user-${platformId}-${secret}`;
    const groupId = `memory-detail-group-${platformId}-${secret}`;
    const conversationId = `memory-detail-conversation-${platformId}-${secret}`;
    const memoryId = `memory-detail-target-${platformId}-${secret}`;
    const restrictedMemoryId = `memory-detail-restricted-${platformId}-${secret}`;
    insertMemoryRecordPageRecord(db, {
      id: memoryId,
      scope: 'user',
      canonicalUserId,
      subjectUserId: `memory-detail-subject-${platformId}-${secret}`,
      state: 'disabled',
      title: `Memory ${platformId} ${'T'.repeat(170)}`,
      content: `password=${secret} ${'C'.repeat(520)}`,
      confidence: 0.7,
      importance: 0.9,
      createdAt: NOW + 1,
      updatedAt: NOW + 2,
      expiresAt: NOW + 10_000,
    });
    insertMemoryRecordPageRecord(db, {
      id: restrictedMemoryId,
      scope: 'user',
      canonicalUserId,
      sensitivity: 'secret',
      state: 'rejected',
      title: `Restricted ${platformId} ${secret}`,
      content: `Restricted content ${platformId} ${secret}`,
    });
    const otherMemoryId = `memory-detail-other-${platformId}-${secret}`;
    insertMemoryRecordPageRecord(db, {
      id: otherMemoryId,
      scope: 'user',
      canonicalUserId: otherUserId,
      state: 'active',
    });
    const cleanGlobalId = `memory-detail-global-${platformId}-${secret}`;
    const malformedGlobalId = `memory-detail-global-malformed-${platformId}-${secret}`;
    const systemMemoryId = `memory-detail-system-${platformId}-${secret}`;
    const groupMemoryId = `memory-detail-group-record-${platformId}-${secret}`;
    const privateConversationMemoryId = `memory-detail-private-${platformId}-${secret}`;
    const groupConversationMemoryId = `memory-detail-group-conversation-${platformId}-${secret}`;
    insertMemoryRecordPageRecord(db, {
      id: cleanGlobalId,
      scope: 'global',
      state: 'active',
    });
    insertMemoryRecordPageRecord(db, {
      id: malformedGlobalId,
      scope: 'global',
      groupId,
      state: 'active',
    });
    insertMemoryRecordPageRecord(db, {
      id: systemMemoryId,
      scope: 'system',
      state: 'proposed',
    });
    insertMemoryRecordPageRecord(db, {
      id: groupMemoryId,
      scope: 'group',
      groupId,
      state: 'superseded',
    });
    insertMemoryRecordPageRecord(db, {
      id: privateConversationMemoryId,
      scope: 'conversation',
      conversationId,
      state: 'active',
    });
    insertMemoryRecordPageRecord(db, {
      id: groupConversationMemoryId,
      scope: 'conversation',
      conversationId,
      groupId,
      state: 'deleted',
    });

    const sourceIds = Array.from({ length: 33 }, (_, index) => (
      `memory-detail-source-${String(index).padStart(2, '0')}-${platformId}-${secret}`
    ));
    const insertSource = db.prepare(
      `INSERT INTO memory_sources (
         memory_id, source_type, source_id, source_timestamp, extracted_by,
         resolution_state
       ) VALUES (?, 'user_command', ?, ?, ?, 'external')`,
    );
    sourceIds.forEach((sourceId, index) => {
      insertSource.run(
        memoryId,
        sourceId,
        NOW + Math.floor(index / 2),
        index === 0 ? 'worker' : index === 1 ? 'user' : `extractor-${secret}`,
      );
    });
    insertSource.run(
      restrictedMemoryId,
      `memory-detail-restricted-source-${platformId}-${secret}`,
      NOW,
      'worker',
    );

    const revisionIds = Array.from({ length: 33 }, (_, index) => (
      `memory-detail-revision-${String(index).padStart(2, '0')}-${platformId}-${secret}`
    ));
    const insertRevision = db.prepare(
      `INSERT INTO memory_revisions (
         id, memory_id, revision_number, change_type, previous_state, new_state,
         reason, actor, evaluator_decision_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    revisionIds.forEach((revisionId, index) => {
      insertRevision.run(
        revisionId,
        memoryId,
        index + 1,
        index === 0 ? 'create' : 'update',
        index === 0
          ? null
          : JSON.stringify({ state: 'active', content: `password=${secret}` }),
        JSON.stringify({
          state: index % 2 === 0 ? 'active' : 'disabled',
          content: `password=${secret}`,
          owner: canonicalUserId,
        }),
        `Revision ${platformId} ${'R'.repeat(180)} password=${secret}`,
        index === 0 ? 'worker' : canonicalUserId,
        `memory-detail-revision-evaluator-${platformId}-${secret}`,
        NOW + index,
      );
    });
    insertRevision.run(
      `memory-detail-restricted-revision-${platformId}-${secret}`,
      restrictedMemoryId,
      1,
      'create',
      null,
      JSON.stringify({ state: 'rejected', content: secret }),
      `Restricted reason ${platformId} ${secret}`,
      'worker',
      null,
      NOW,
    );

    const auditIds = Array.from({ length: 33 }, (_, index) => (
      `memory-detail-audit-${String(index).padStart(2, '0')}-${platformId}-${secret}`
    ));
    const insertAudit = db.prepare(
      `INSERT INTO audit_log (
         id, timestamp, category, level, event_type, event_id,
         actor_user_id, actor_class, invocation_context,
         summary, details, redacted, risk_level, evaluator_decision_id
       ) VALUES (?, ?, 'memory', 'summary', ?, ?, ?, 'admin', 'admin_http',
                 ?, ?, 1, 'medium', ?)`,
    );
    auditIds.forEach((auditId, index) => {
      insertAudit.run(
        auditId,
        NOW + index,
        `memory.update.${platformId}`,
        memoryId,
        canonicalUserId,
        `Audit ${platformId} ${'A'.repeat(280)} token=${secret}`,
        JSON.stringify({ memoryId, sourceId: sourceIds[index], secret }),
        `memory-detail-audit-evaluator-${platformId}-${secret}`,
      );
    });
    insertAudit.run(
      `memory-detail-restricted-audit-${platformId}-${secret}`,
      NOW,
      'memory.create',
      restrictedMemoryId,
      canonicalUserId,
      `Restricted summary ${platformId} ${secret}`,
      JSON.stringify({ restrictedMemoryId, secret }),
      null,
    );

    const reference = (purpose: string, value: string) => createHash('sha256')
      .update(`lethebot-governance:${purpose}:v1\0`, 'utf8')
      .update(value, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const service = new GovernanceQueryService(db);
    const showMemory = vi.spyOn(service, 'showMemory');
    const listMemoryRecordsForScope = vi.spyOn(service, 'listMemoryRecordsForScope');
    const prepare = vi.spyOn(db, 'prepare');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    prepare.mockClear();

    await expect(service.getMemoryRecordDetailForScope({
      scope: { kind: 'user', canonicalUserId },
      memoryId: otherMemoryId,
    })).resolves.toBeNull();
    await expect(service.getMemoryRecordDetailForScope({
      scope: { kind: 'global' },
      memoryId: malformedGlobalId,
    })).resolves.toBeNull();
    await expect(service.getMemoryRecordDetailForScope({
      scope: { kind: 'tool', toolName: 'runtime.status' },
      memoryId,
    })).resolves.toBeNull();
    await expect(service.getMemoryRecordDetailForScope({
      scope: { kind: 'user', canonicalUserId },
      memoryId: 'missing-memory-detail',
    })).resolves.toBeNull();
    expect(prepare.mock.calls.map(([sql]) => String(sql)).some((sql) => (
      sql.includes('FROM memory_sources')
      || sql.includes('FROM memory_revisions')
      || sql.includes('FROM audit_log')
    ))).toBe(false);
    prepare.mockClear();

    const detail = await service.getMemoryRecordDetailForScope({
      scope: { kind: 'user', canonicalUserId },
      memoryId,
    });
    const repeated = await service.getMemoryRecordDetailForScope({
      scope: { kind: 'user', canonicalUserId },
      memoryId,
    });
    expect(repeated).toEqual(detail);
    expect(detail?.record).toEqual({
      recordRef: reference('memory', memoryId),
      scopeKind: 'user',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: expect.stringContaining('[REDACTED:platform_id]'),
      contentPreview: expect.stringContaining('[REDACTED:password_assignment]'),
      state: 'disabled',
      confidence: 0.7,
      importance: 0.9,
      sourceCount: 33,
      revisionCount: 33,
      createdAt: new Date(NOW + 1),
      updatedAt: new Date(NOW + 2),
      expiresAt: new Date(NOW + 10_000),
      textHidden: false,
      titleRedacted: true,
      titleTruncated: true,
      contentRedacted: true,
      contentTruncated: true,
    });
    expect(detail?.sources).toHaveLength(32);
    expect(detail?.sourcesTruncated).toBe(true);
    expect(detail?.sources[0]).toEqual({
      sourceRef: reference('memory-source', `${memoryId}\0${sourceIds[0] ?? ''}`),
      sourceType: 'user_command',
      resolutionState: 'external',
      extractorClass: 'worker',
      sourceTimestamp: new Date(NOW),
    });
    expect(detail?.sources[1]).toEqual({
      sourceRef: reference('memory-source', `${memoryId}\0${sourceIds[1] ?? ''}`),
      sourceType: 'user_command',
      resolutionState: 'external',
      extractorClass: 'user',
      sourceTimestamp: new Date(NOW),
    });
    expect(detail?.sources[2]?.extractorClass).toBe('other');
    expect(detail?.revisions).toHaveLength(32);
    expect(detail?.revisionsTruncated).toBe(true);
    expect(detail?.revisions[0]).toEqual({
      revisionRef: reference('memory-revision', revisionIds[0] ?? ''),
      revisionNumber: 1,
      changeType: 'create',
      actorClass: 'worker',
      newLifecycleState: 'active',
      reason: expect.stringContaining('[REDACTED:platform_id]'),
      reasonRedacted: true,
      reasonTruncated: true,
      evaluatorLinked: true,
      createdAt: new Date(NOW),
    });
    expect(detail?.revisions[1]).toMatchObject({
      previousLifecycleState: 'active',
      newLifecycleState: 'disabled',
      actorClass: 'other',
    });
    expect(detail?.audit).toHaveLength(32);
    expect(detail?.auditTruncated).toBe(true);
    expect(detail?.audit[0]).toEqual({
      auditRef: reference('memory-audit', auditIds[32] ?? ''),
      timestamp: new Date(NOW + 32),
      level: 'summary',
      eventType: 'memory.update.[REDACTED:platform_id]',
      summary: expect.stringContaining('[REDACTED:platform_id]'),
      riskLevel: 'medium',
      summaryRedacted: true,
      summaryTruncated: true,
      evaluatorLinked: true,
      detailsHidden: true,
    });

    const recordRefFor = async (
      scope: Parameters<typeof service.getMemoryRecordDetailForScope>[0]['scope'],
      id: string,
    ): Promise<string | undefined> => (
      await service.getMemoryRecordDetailForScope({ scope, memoryId: id })
    )?.record.recordRef;
    await expect(recordRefFor({ kind: 'global' }, cleanGlobalId))
      .resolves.toBe(reference('memory', cleanGlobalId));
    await expect(recordRefFor({ kind: 'system' }, systemMemoryId))
      .resolves.toBe(reference('memory', systemMemoryId));
    await expect(recordRefFor({ kind: 'group', groupId }, groupMemoryId))
      .resolves.toBe(reference('memory', groupMemoryId));
    await expect(recordRefFor({
      kind: 'conversation',
      conversationId,
      conversationType: 'private',
    }, privateConversationMemoryId)).resolves.toBe(reference('memory', privateConversationMemoryId));
    await expect(recordRefFor({
      kind: 'conversation',
      conversationId,
      conversationType: 'group',
      groupId,
    }, groupConversationMemoryId)).resolves.toBe(reference('memory', groupConversationMemoryId));
    await expect(recordRefFor({
      kind: 'conversation',
      conversationId,
      conversationType: 'private',
    }, groupConversationMemoryId)).resolves.toBeUndefined();

    const restricted = await service.getMemoryRecordDetailForScope({
      scope: { kind: 'user', canonicalUserId },
      memoryId: restrictedMemoryId,
    });
    expect(restricted?.record).toMatchObject({
      title: '[REDACTED:restricted_memory]',
      contentPreview: '[REDACTED:restricted_memory]',
      textHidden: true,
    });
    expect(restricted?.revisions[0]).toMatchObject({
      reason: '[REDACTED:restricted_memory]',
      reasonRedacted: true,
      reasonTruncated: false,
    });
    expect(restricted?.audit[0]).toMatchObject({
      summary: '[REDACTED:restricted_memory]',
      summaryRedacted: true,
      summaryTruncated: false,
      detailsHidden: true,
    });

    expect(showMemory).not.toHaveBeenCalled();
    expect(listMemoryRecordsForScope).not.toHaveBeenCalled();
    const serialized = JSON.stringify({ detail, restricted });
    for (const rawValue of [
      platformId,
      secret,
      canonicalUserId,
      memoryId,
      restrictedMemoryId,
      'memory-detail-subject',
      'memory-detail-source-',
      'memory-detail-revision-',
      'memory-detail-audit-',
      'memory_page_source_context',
      'memory-page-evaluator',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(serialized).not.toContain('previousState');
    expect(serialized).not.toContain('newState');
    expect(serialized).not.toContain('details":');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('previews an exact-scope memory-record forget without mutation', async () => {
    const platformId = '864209753';
    const secret = 'sk-memoryforgetabcdefghijklmnopqrstuvwxyz123456';
    const canonicalUserId = `memory-forget-user-${platformId}-${secret}`;
    const otherUserId = `memory-forget-other-user-${platformId}-${secret}`;
    const groupId = `memory-forget-group-${platformId}-${secret}`;
    const conversationId = `memory-forget-conversation-${platformId}-${secret}`;
    const targetMemoryId = `memory-forget-target-${platformId}-${secret}`;
    const otherUserMemoryId = `memory-forget-other-user-record-${platformId}-${secret}`;
    const globalMemoryId = `memory-forget-global-${platformId}-${secret}`;
    const malformedGlobalMemoryId = `memory-forget-malformed-global-${platformId}-${secret}`;
    const groupMemoryId = `memory-forget-group-record-${platformId}-${secret}`;
    const privateConversationMemoryId = `memory-forget-private-${platformId}-${secret}`;
    const groupConversationMemoryId = `memory-forget-group-conversation-${platformId}-${secret}`;
    const systemMemoryId = `memory-forget-system-${platformId}-${secret}`;
    const deletedMemoryId = `memory-forget-deleted-${platformId}-${secret}`;
    const missingRevisionMemoryId = `memory-forget-no-revision-${platformId}-${secret}`;
    const fractionalRevisionMemoryId = `memory-forget-fractional-${platformId}-${secret}`;
    const zeroRevisionMemoryId = `memory-forget-zero-${platformId}-${secret}`;
    const unsafeRevisionMemoryId = `memory-forget-unsafe-${platformId}-${secret}`;
    const validLongMemoryId = String.fromCodePoint(0x1f600).repeat(256);

    insertMemoryRecordPageRecord(db, {
      id: targetMemoryId,
      scope: 'user',
      canonicalUserId,
      subjectUserId: `memory-forget-subject-${platformId}-${secret}`,
      title: `Memory forget title ${platformId}`,
      content: `api_key=${secret}`,
      state: 'active',
      revisionCount: 3,
    });
    insertMemoryRecordPageRecord(db, {
      id: otherUserMemoryId,
      scope: 'user',
      canonicalUserId: otherUserId,
      state: 'active',
      revisionCount: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: globalMemoryId,
      scope: 'global',
      state: 'proposed',
      revisionCount: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: malformedGlobalMemoryId,
      scope: 'global',
      groupId,
      state: 'active',
      revisionCount: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: groupMemoryId,
      scope: 'group',
      groupId,
      state: 'rejected',
      revisionCount: 2,
    });
    insertMemoryRecordPageRecord(db, {
      id: privateConversationMemoryId,
      scope: 'conversation',
      conversationId,
      state: 'superseded',
      revisionCount: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: groupConversationMemoryId,
      scope: 'conversation',
      conversationId,
      groupId,
      state: 'disabled',
      revisionCount: 4,
    });
    insertMemoryRecordPageRecord(db, {
      id: systemMemoryId,
      scope: 'system',
      state: 'active',
      revisionCount: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: deletedMemoryId,
      scope: 'user',
      canonicalUserId,
      state: 'deleted',
      revisionCount: 1,
    });
    for (const memoryId of [
      missingRevisionMemoryId,
      fractionalRevisionMemoryId,
      zeroRevisionMemoryId,
      unsafeRevisionMemoryId,
    ]) {
      insertMemoryRecordPageRecord(db, {
        id: memoryId,
        scope: 'user',
        canonicalUserId,
        state: 'active',
      });
    }
    insertMemoryRecordPageRecord(db, {
      id: validLongMemoryId,
      scope: 'system',
      state: 'active',
      revisionCount: 1,
    });

    const insertRevision = db.prepare(
      `INSERT INTO memory_revisions (
         id, memory_id, revision_number, change_type, previous_state, new_state,
         reason, actor, evaluator_decision_id, created_at
       ) VALUES (?, ?, ?, 'update', '{}', '{}', 'Synthetic invalid revision',
                 'system', NULL, ?)`,
    );
    insertRevision.run(
      `memory-forget-fractional-revision-${platformId}-${secret}`,
      fractionalRevisionMemoryId,
      1.5,
      NOW,
    );
    insertRevision.run(
      `memory-forget-zero-revision-${platformId}-${secret}`,
      zeroRevisionMemoryId,
      0,
      NOW,
    );
    insertRevision.run(
      `memory-forget-unsafe-revision-${platformId}-${secret}`,
      unsafeRevisionMemoryId,
      Number.MAX_SAFE_INTEGER,
      NOW,
    );

    const reference = (purpose: string, value: string) => createHash('sha256')
      .update(`lethebot-governance:${purpose}:v1\0`, 'utf8')
      .update(value, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const service = new GovernanceQueryService(db);
    const listMemory = vi.spyOn(service, 'listMemory');
    const listMemoryRecordsForScope = vi.spyOn(service, 'listMemoryRecordsForScope');
    const getMemoryRecordDetailForScope = vi.spyOn(service, 'getMemoryRecordDetailForScope');
    const showMemory = vi.spyOn(service, 'showMemory');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const preview = await service.getMemoryRecordForgetPreviewForScope({
      scope: { kind: 'user', canonicalUserId },
      memoryId: targetMemoryId,
    });
    const repeated = await service.getMemoryRecordForgetPreviewForScope({
      scope: { kind: 'user', canonicalUserId },
      memoryId: targetMemoryId,
    });

    expect(repeated).toEqual(preview);
    expect(preview).toEqual({
      action: 'memory.record.forget',
      recordRef: reference('memory-record-forget', targetMemoryId),
      scopeKind: 'user',
      current: {
        lifecycleState: 'active',
        revisionNumber: 3,
      },
      expected: {
        lifecycleState: 'deleted',
        revisionNumber: 4,
        durableEffects: [
          'memory_record_state_transition',
          'memory_revision_append',
          'audit_event_append',
        ],
        retrievalConsequences: ['deleted_record_excluded'],
      },
      rollback: {
        supported: true,
        boundary: 'separate_restore_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(Object.keys(preview ?? {}).sort()).toEqual([
      'action',
      'current',
      'expected',
      'previewDigest',
      'recordRef',
      'rollback',
      'scopeKind',
    ]);
    expect(preview?.recordRef).not.toBe(reference('memory', targetMemoryId));
    const { previewDigest, ...digestPayload } = preview ?? { previewDigest: '' };
    expect(previewDigest).toBe(createHash('sha256')
      .update('lethebot-governance:memory-record-forget-preview:v1\0', 'utf8')
      .update(JSON.stringify(digestPayload), 'utf8')
      .digest('hex'));

    const supported = [
      {
        scope: { kind: 'global' } as const,
        memoryId: globalMemoryId,
        scopeKind: 'global',
        lifecycleState: 'proposed',
        revisionNumber: 1,
      },
      {
        scope: { kind: 'group', groupId } as const,
        memoryId: groupMemoryId,
        scopeKind: 'group',
        lifecycleState: 'rejected',
        revisionNumber: 2,
      },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'private',
        } as const,
        memoryId: privateConversationMemoryId,
        scopeKind: 'conversation',
        lifecycleState: 'superseded',
        revisionNumber: 1,
      },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'group',
          groupId,
        } as const,
        memoryId: groupConversationMemoryId,
        scopeKind: 'conversation',
        lifecycleState: 'disabled',
        revisionNumber: 4,
      },
      {
        scope: { kind: 'system' } as const,
        memoryId: systemMemoryId,
        scopeKind: 'system',
        lifecycleState: 'active',
        revisionNumber: 1,
      },
    ];
    const supportedPreviews: unknown[] = [];
    for (const expected of supported) {
      const supportedPreview = service.getMemoryRecordForgetPreviewForScope({
        scope: expected.scope,
        memoryId: expected.memoryId,
      });
      supportedPreviews.push(await supportedPreview);
      await expect(supportedPreview).resolves.toMatchObject({
        scopeKind: expected.scopeKind,
        current: {
          lifecycleState: expected.lifecycleState,
          revisionNumber: expected.revisionNumber,
        },
        expected: {
          lifecycleState: 'deleted',
          revisionNumber: expected.revisionNumber + 1,
        },
      });
    }
    await expect(service.getMemoryRecordForgetPreviewForScope({
      scope: { kind: 'system' },
      memoryId: validLongMemoryId,
    })).resolves.toMatchObject({ scopeKind: 'system' });

    for (const input of [
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: otherUserMemoryId,
      },
      {
        scope: { kind: 'global' },
        memoryId: malformedGlobalMemoryId,
      },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'private',
        },
        memoryId: groupConversationMemoryId,
      },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'group',
          groupId,
        },
        memoryId: privateConversationMemoryId,
      },
      {
        scope: { kind: 'tool', toolName: 'runtime.status' },
        memoryId: targetMemoryId,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: 'memory-forget-missing',
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: deletedMemoryId,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: missingRevisionMemoryId,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: fractionalRevisionMemoryId,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: zeroRevisionMemoryId,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: unsafeRevisionMemoryId,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: '',
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: ` ${targetMemoryId}`,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: `${targetMemoryId} `,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: `memory-forget-control-${String.fromCodePoint(1)}`,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: 'x'.repeat(257),
      },
    ] as const) {
      await expect(service.getMemoryRecordForgetPreviewForScope(input)).resolves.toBeNull();
    }

    expect(listMemory).not.toHaveBeenCalled();
    expect(listMemoryRecordsForScope).not.toHaveBeenCalled();
    expect(getMemoryRecordDetailForScope).not.toHaveBeenCalled();
    expect(showMemory).not.toHaveBeenCalled();
    const serialized = JSON.stringify({ preview, repeated, supportedPreviews });
    for (const rawValue of [
      platformId,
      secret,
      canonicalUserId,
      groupId,
      conversationId,
      targetMemoryId,
      'memory-forget-subject',
      'Memory forget title',
      'memory_page_source_context',
      'memory-page-evaluator',
      'memory-page-revision',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('previews an exact-scope memory-record restore without mutation', async () => {
    const platformId = '975318642';
    const secret = 'sk-memoryrestoreabcdefghijklmnopqrstuvwxyz123456';
    const canonicalUserId = `memory-restore-user-${platformId}-${secret}`;
    const otherUserId = `memory-restore-other-user-${platformId}-${secret}`;
    const groupId = `memory-restore-group-${platformId}-${secret}`;
    const conversationId = `memory-restore-conversation-${platformId}-${secret}`;
    const targetMemoryId = `memory-restore-target-${platformId}-${secret}`;
    const otherUserMemoryId = `memory-restore-other-user-record-${platformId}-${secret}`;
    const globalMemoryId = `memory-restore-global-${platformId}-${secret}`;
    const malformedGlobalMemoryId = `memory-restore-malformed-global-${platformId}-${secret}`;
    const groupMemoryId = `memory-restore-group-record-${platformId}-${secret}`;
    const privateConversationMemoryId = `memory-restore-private-${platformId}-${secret}`;
    const groupConversationMemoryId =
      `memory-restore-group-conversation-${platformId}-${secret}`;
    const systemMemoryId = `memory-restore-system-${platformId}-${secret}`;
    const proposedMemoryId = `memory-restore-proposed-${platformId}-${secret}`;
    const activeMemoryId = `memory-restore-active-${platformId}-${secret}`;
    const supersededMemoryId = `memory-restore-superseded-${platformId}-${secret}`;
    const missingRevisionMemoryId = `memory-restore-no-revision-${platformId}-${secret}`;
    const fractionalRevisionMemoryId = `memory-restore-fractional-${platformId}-${secret}`;
    const zeroRevisionMemoryId = `memory-restore-zero-${platformId}-${secret}`;
    const unsafeRevisionMemoryId = `memory-restore-unsafe-${platformId}-${secret}`;
    const validLongMemoryId = String.fromCodePoint(0x1f600).repeat(256);

    insertMemoryRecordPageRecord(db, {
      id: targetMemoryId,
      scope: 'user',
      canonicalUserId,
      subjectUserId: `memory-restore-subject-${platformId}-${secret}`,
      title: `Memory restore title ${platformId}`,
      content: `api_key=${secret}`,
      state: 'deleted',
      revisionCount: 3,
    });
    insertMemoryRecordPageRecord(db, {
      id: otherUserMemoryId,
      scope: 'user',
      canonicalUserId: otherUserId,
      state: 'deleted',
      revisionCount: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: globalMemoryId,
      scope: 'global',
      state: 'disabled',
      revisionCount: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: malformedGlobalMemoryId,
      scope: 'global',
      groupId,
      state: 'deleted',
      revisionCount: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: groupMemoryId,
      scope: 'group',
      groupId,
      state: 'rejected',
      revisionCount: 2,
    });
    insertMemoryRecordPageRecord(db, {
      id: privateConversationMemoryId,
      scope: 'conversation',
      conversationId,
      state: 'disabled',
      revisionCount: 1,
    });
    insertMemoryRecordPageRecord(db, {
      id: groupConversationMemoryId,
      scope: 'conversation',
      conversationId,
      groupId,
      state: 'deleted',
      revisionCount: 4,
    });
    insertMemoryRecordPageRecord(db, {
      id: systemMemoryId,
      scope: 'system',
      state: 'rejected',
      revisionCount: 1,
    });
    for (const [memoryId, state] of [
      [proposedMemoryId, 'proposed'],
      [activeMemoryId, 'active'],
      [supersededMemoryId, 'superseded'],
    ] as const) {
      insertMemoryRecordPageRecord(db, {
        id: memoryId,
        scope: 'user',
        canonicalUserId,
        state,
        revisionCount: 1,
      });
    }
    for (const memoryId of [
      missingRevisionMemoryId,
      fractionalRevisionMemoryId,
      zeroRevisionMemoryId,
      unsafeRevisionMemoryId,
    ]) {
      insertMemoryRecordPageRecord(db, {
        id: memoryId,
        scope: 'user',
        canonicalUserId,
        state: 'deleted',
      });
    }
    insertMemoryRecordPageRecord(db, {
      id: validLongMemoryId,
      scope: 'system',
      state: 'deleted',
      revisionCount: 1,
    });

    const insertRevision = db.prepare(
      `INSERT INTO memory_revisions (
         id, memory_id, revision_number, change_type, previous_state, new_state,
         reason, actor, evaluator_decision_id, created_at
       ) VALUES (?, ?, ?, 'update', '{}', '{}', 'Synthetic invalid revision',
                 'system', NULL, ?)`,
    );
    insertRevision.run(
      `memory-restore-fractional-revision-${platformId}-${secret}`,
      fractionalRevisionMemoryId,
      1.5,
      NOW,
    );
    insertRevision.run(
      `memory-restore-zero-revision-${platformId}-${secret}`,
      zeroRevisionMemoryId,
      0,
      NOW,
    );
    insertRevision.run(
      `memory-restore-unsafe-revision-${platformId}-${secret}`,
      unsafeRevisionMemoryId,
      Number.MAX_SAFE_INTEGER,
      NOW,
    );

    const reference = (purpose: string, value: string) => createHash('sha256')
      .update(`lethebot-governance:${purpose}:v1\0`, 'utf8')
      .update(value, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const service = new GovernanceQueryService(db);
    const listMemory = vi.spyOn(service, 'listMemory');
    const listMemoryRecordsForScope = vi.spyOn(service, 'listMemoryRecordsForScope');
    const getMemoryRecordDetailForScope = vi.spyOn(service, 'getMemoryRecordDetailForScope');
    const getMemoryRecordForgetPreviewForScope = vi.spyOn(
      service,
      'getMemoryRecordForgetPreviewForScope',
    );
    const showMemory = vi.spyOn(service, 'showMemory');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const preview = await service.getMemoryRecordRestorePreviewForScope({
      scope: { kind: 'user', canonicalUserId },
      memoryId: targetMemoryId,
    });
    const repeated = await service.getMemoryRecordRestorePreviewForScope({
      scope: { kind: 'user', canonicalUserId },
      memoryId: targetMemoryId,
    });

    expect(repeated).toEqual(preview);
    expect(preview).toEqual({
      action: 'memory.record.restore',
      recordRef: reference('memory-record-restore', targetMemoryId),
      scopeKind: 'user',
      current: {
        lifecycleState: 'deleted',
        revisionNumber: 3,
      },
      expected: {
        lifecycleState: 'active',
        revisionNumber: 4,
        durableEffects: [
          'memory_record_state_transition',
          'memory_revision_append',
          'audit_event_append',
        ],
        retrievalConsequences: ['restored_records_included'],
      },
      rollback: {
        supported: true,
        boundary: 'separate_forget_confirmation_required',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(Object.keys(preview ?? {}).sort()).toEqual([
      'action',
      'current',
      'expected',
      'previewDigest',
      'recordRef',
      'rollback',
      'scopeKind',
    ]);
    expect(preview?.recordRef).not.toBe(reference('memory', targetMemoryId));
    expect(preview?.recordRef).not.toBe(reference('memory-record-forget', targetMemoryId));
    const { previewDigest, ...digestPayload } = preview ?? { previewDigest: '' };
    expect(previewDigest).toBe(createHash('sha256')
      .update('lethebot-governance:memory-record-restore-preview:v1\0', 'utf8')
      .update(JSON.stringify(digestPayload), 'utf8')
      .digest('hex'));

    const supported = [
      {
        scope: { kind: 'global' } as const,
        memoryId: globalMemoryId,
        scopeKind: 'global',
        lifecycleState: 'disabled',
        revisionNumber: 1,
      },
      {
        scope: { kind: 'group', groupId } as const,
        memoryId: groupMemoryId,
        scopeKind: 'group',
        lifecycleState: 'rejected',
        revisionNumber: 2,
      },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'private',
        } as const,
        memoryId: privateConversationMemoryId,
        scopeKind: 'conversation',
        lifecycleState: 'disabled',
        revisionNumber: 1,
      },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'group',
          groupId,
        } as const,
        memoryId: groupConversationMemoryId,
        scopeKind: 'conversation',
        lifecycleState: 'deleted',
        revisionNumber: 4,
      },
      {
        scope: { kind: 'system' } as const,
        memoryId: systemMemoryId,
        scopeKind: 'system',
        lifecycleState: 'rejected',
        revisionNumber: 1,
      },
    ];
    const supportedPreviews: unknown[] = [];
    for (const expected of supported) {
      const supportedPreview = service.getMemoryRecordRestorePreviewForScope({
        scope: expected.scope,
        memoryId: expected.memoryId,
      });
      supportedPreviews.push(await supportedPreview);
      await expect(supportedPreview).resolves.toMatchObject({
        scopeKind: expected.scopeKind,
        current: {
          lifecycleState: expected.lifecycleState,
          revisionNumber: expected.revisionNumber,
        },
        expected: {
          lifecycleState: 'active',
          revisionNumber: expected.revisionNumber + 1,
        },
      });
    }
    await expect(service.getMemoryRecordRestorePreviewForScope({
      scope: { kind: 'system' },
      memoryId: validLongMemoryId,
    })).resolves.toMatchObject({ scopeKind: 'system' });

    for (const input of [
      {
        scope: { kind: 'user', canonicalUserId: otherUserId },
        memoryId: targetMemoryId,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: otherUserMemoryId,
      },
      {
        scope: { kind: 'global' },
        memoryId: malformedGlobalMemoryId,
      },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'private',
        },
        memoryId: groupConversationMemoryId,
      },
      {
        scope: {
          kind: 'conversation',
          conversationId,
          conversationType: 'group',
          groupId,
        },
        memoryId: privateConversationMemoryId,
      },
      {
        scope: { kind: 'tool', toolName: 'runtime.status' },
        memoryId: targetMemoryId,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: 'memory-restore-missing',
      },
      ...[proposedMemoryId, activeMemoryId, supersededMemoryId].map((memoryId) => ({
        scope: { kind: 'user' as const, canonicalUserId },
        memoryId,
      })),
      ...[
        missingRevisionMemoryId,
        fractionalRevisionMemoryId,
        zeroRevisionMemoryId,
        unsafeRevisionMemoryId,
      ].map((memoryId) => ({
        scope: { kind: 'user' as const, canonicalUserId },
        memoryId,
      })),
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: '',
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: ` ${targetMemoryId}`,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: `${targetMemoryId} `,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: `memory-restore-control-${String.fromCodePoint(1)}`,
      },
      {
        scope: { kind: 'user', canonicalUserId },
        memoryId: 'x'.repeat(257),
      },
    ] as const) {
      await expect(service.getMemoryRecordRestorePreviewForScope(input)).resolves.toBeNull();
    }

    expect(listMemory).not.toHaveBeenCalled();
    expect(listMemoryRecordsForScope).not.toHaveBeenCalled();
    expect(getMemoryRecordDetailForScope).not.toHaveBeenCalled();
    expect(getMemoryRecordForgetPreviewForScope).not.toHaveBeenCalled();
    expect(showMemory).not.toHaveBeenCalled();
    const serialized = JSON.stringify({ preview, repeated, supportedPreviews });
    for (const rawValue of [
      platformId,
      secret,
      canonicalUserId,
      groupId,
      conversationId,
      targetMemoryId,
      'memory-restore-subject',
      'Memory restore title',
      'memory_page_source_context',
      'memory-page-evaluator',
      'memory-page-revision',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues a bounded privacy user-scope catalog with purpose-isolated handles', async () => {
    const platformId = '123456789';
    const secret = 'sk-privacyabcdefghijklmnopqrstuvwxyz123456';
    const canonicalUserIds = Array.from({ length: 101 }, (_, index) => (
      index === 100
        ? `privacy-scope-user-${platformId}`
        : `privacy-scope-user-${String(index).padStart(3, '0')}`
    ));
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    canonicalUserIds.forEach((canonicalUserId, index) => {
      insertUser.run(canonicalUserId, NOW + index, NOW + Math.floor(index / 2));
    });
    db.prepare(
      `INSERT INTO privacy_preferences (
         canonical_user_id, preference_type, state, reason,
         updated_by_user_id, updated_by_actor_class, updated_by_context,
         created_at, updated_at
       ) VALUES (?, 'memory_association', 'opted_out', ?, NULL, 'admin',
                 'admin_cli', ?, ?)`,
    ).run(canonicalUserIds[100], secret, NOW, NOW);
    insertNormalizedMaintenanceProposal(db, {
      proposalId: 'proposal-privacy-scope-overlap',
      scope: { kind: 'user', canonicalUserId: canonicalUserIds[100] ?? '' },
      createdAt: NOW + 200,
    });

    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const sessionId = 'b'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const registry = new GovernanceScopeHandleRegistry({ now: () => NOW });
    const issuedScopes: Array<{ kind: 'user'; canonicalUserId: string }> = [];
    const issueHandle = (scope: { kind: 'user'; canonicalUserId: string }) => {
      issuedScopes.push(scope);
      return {
        ...registry.issue({
          sessionId,
          sessionExpiresAt,
          purpose: 'governance.privacy.preferences.read',
          scope,
        }),
        rawScope: scope,
        ignoredSessionId: sessionId,
        ignoredSecret: secret,
      };
    };

    const catalog = await service.listPrivacyPreferenceScopeHandles(issueHandle);
    const repeated = await service.listPrivacyPreferenceScopeHandles(issueHandle);

    expect(catalog).toEqual(repeated);
    expect(catalog.entries).toHaveLength(100);
    expect(catalog.truncated).toBe(true);
    expect(issuedScopes).toHaveLength(200);
    expect(issuedScopes.slice(0, 3)).toEqual([
      { kind: 'user', canonicalUserId: canonicalUserIds[100] },
      { kind: 'user', canonicalUserId: canonicalUserIds[98] },
      { kind: 'user', canonicalUserId: canonicalUserIds[99] },
    ]);
    expect(issuedScopes.slice(0, 100)).toContainEqual({
      kind: 'user',
      canonicalUserId: canonicalUserIds[50],
    });
    expect(new Set(issuedScopes.slice(0, 100).map((scope) => scope.canonicalUserId)))
      .toHaveProperty('size', 100);
    expect(catalog.entries.every((entry) => entry.scopeKind === 'user')).toBe(true);
    expect(catalog.entries.every((entry) => entry.label === 'User privacy')).toBe(true);
    expect(catalog.entries.every((entry) => /^[0-9a-f]{16}$/u.test(entry.fingerprint)))
      .toBe(true);
    expect(new Set(catalog.entries.map((entry) => entry.fingerprint)))
      .toHaveProperty('size', 100);
    expect(catalog.entries.every((entry) => /^[A-Za-z0-9_-]{43}$/u.test(entry.handle)))
      .toBe(true);
    expect(catalog.entries.every((entry) => entry.expiresAt === sessionExpiresAt)).toBe(true);
    catalog.entries.forEach((entry, index) => {
      expect(Object.keys(entry).sort()).toEqual([
        'expiresAt',
        'fingerprint',
        'handle',
        'label',
        'scopeKind',
      ]);
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'governance.privacy.preferences.read',
      })).toEqual(issuedScopes[index]);
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'memory.maintenance.review',
      })).toBeNull();
    });

    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain(platformId);
    expect(canonicalUserIds.some((canonicalUserId) => serialized.includes(canonicalUserId)))
      .toBe(false);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues a bounded display-profile user catalog without exposing identifiers', async () => {
    const platformId = '246801357';
    const secret = 'sk-displayprofileabcdefghijklmnopqrstuvwxyz123456';
    const validUserIds = Array.from(
      { length: 101 },
      (_, index) => `display-profile-user-${String(index).padStart(3, '0')}`,
    );
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, 'platform_provided')`,
    );
    const insertHistory = db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    );

    validUserIds.forEach((canonicalUserId, index) => {
      insertUser.run(canonicalUserId, NOW + index, NOW + index);
      if (index < 100 && index % 2 === 0) {
        insertProfile.run(
          canonicalUserId,
          `profile-group-${platformId}-${secret}-${index}`,
          `Profile ${platformId} password=${secret}`,
          NOW + index,
        );
      } else if (index < 100) {
        insertHistory.run(
          `profile-history-${index}`,
          canonicalUserId,
          `history-group-${platformId}-${secret}-${index}`,
          `History ${platformId} password=${secret}`,
          NOW + index,
        );
      }
    });
    insertHistory.run(
      'profile-history-duplicate',
      validUserIds[0],
      `duplicate-group-${platformId}-${secret}`,
      `Duplicate ${platformId} password=${secret}`,
      NOW + 500,
    );
    insertUser.run('display-profile-canonical-only', NOW + 600, NOW + 600);

    const malformedIds: Array<string | Buffer> = [
      '',
      ' padded-display-profile-user',
      'display-profile-user-padded ',
      '\u00a0display-profile-user-unicode-padded\u00a0',
      `display-profile-control-${String.fromCodePoint(1)}`,
      'display-profile-control\nnewline',
      `display-profile-nul-${String.fromCodePoint(0)}`,
      'x'.repeat(257),
      Buffer.from('display-profile-buffer-user', 'utf8'),
    ];
    malformedIds.forEach((canonicalUserId, index) => {
      insertUser.run(canonicalUserId, NOW + 700 + index, NOW + 700 + index);
      insertProfile.run(
        canonicalUserId,
        '',
        `Malformed ${platformId} password=${secret}`,
        NOW + 700 + index,
      );
    });

    type DisplayProfileScope = { kind: 'user'; canonicalUserId: string };
    const service = new GovernanceQueryService(db);
    const sessionId = 'e'.repeat(64);
    const otherSessionId = 'f'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const purpose = 'governance.display_profile.targets.read';
    const registry = new GovernanceScopeHandleRegistry({ now: () => NOW });
    const issueHandle = vi.fn((scope: DisplayProfileScope) => ({
      ...registry.issue({ sessionId, sessionExpiresAt, purpose, scope }),
      rawScope: scope,
      ignoredSessionId: sessionId,
      ignoredSecret: secret,
    }));

    const exactChanges = db.prepare('SELECT total_changes()').pluck().get();
    const exact = await service.listDisplayProfileScopeHandles(issueHandle);

    expect(exact.entries).toHaveLength(100);
    expect(exact.truncated).toBe(false);
    expect(issueHandle).toHaveBeenCalledTimes(100);
    expect(issueHandle.mock.calls.map(([scope]) => scope)).toEqual(
      validUserIds.slice(0, 100).map((canonicalUserId) => ({
        kind: 'user',
        canonicalUserId,
      })),
    );
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(exactChanges);

    insertHistory.run(
      'profile-history-overflow',
      validUserIds[100],
      `overflow-group-${platformId}-${secret}`,
      `Overflow ${platformId} password=${secret}`,
      NOW + 900,
    );
    const boundedChanges = db.prepare('SELECT total_changes()').pluck().get();
    const bounded = await service.listDisplayProfileScopeHandles(issueHandle);
    const repeated = await service.listDisplayProfileScopeHandles(issueHandle);

    expect(bounded.entries).toEqual(exact.entries);
    expect(repeated).toEqual(bounded);
    expect(bounded.truncated).toBe(true);
    expect(issueHandle).toHaveBeenCalledTimes(300);
    expect(issueHandle.mock.calls.slice(100).map(([scope]) => scope)).toEqual([
      ...validUserIds.slice(0, 100).map((canonicalUserId) => ({
        kind: 'user' as const,
        canonicalUserId,
      })),
      ...validUserIds.slice(0, 100).map((canonicalUserId) => ({
        kind: 'user' as const,
        canonicalUserId,
      })),
    ]);
    expect(new Set(bounded.entries.map((entry) => entry.fingerprint))).toHaveProperty(
      'size',
      100,
    );
    bounded.entries.forEach((entry, index) => {
      const expectedScope = {
        kind: 'user' as const,
        canonicalUserId: validUserIds[index] ?? '',
      };
      expect(entry).toEqual({
        fingerprint: createHash('sha256')
          .update('lethebot-governance:memory-maintenance-scope:v1\0', 'utf8')
          .update(JSON.stringify(expectedScope), 'utf8')
          .digest('hex')
          .slice(0, 16),
        scopeKind: 'user',
        label: 'User display data',
        handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        expiresAt: sessionExpiresAt,
      });
      expect(Object.keys(entry).sort()).toEqual([
        'expiresAt',
        'fingerprint',
        'handle',
        'label',
        'scopeKind',
      ]);
      expect(registry.resolve({ sessionId, handle: entry.handle, purpose })).toEqual(
        expectedScope,
      );
      expect(registry.resolve({
        sessionId: otherSessionId,
        handle: entry.handle,
        purpose,
      })).toBeNull();
      for (const foreignPurpose of [
        'governance.privacy.preferences.read',
        'governance.memory.records.read',
        'memory.maintenance.review',
      ]) {
        expect(registry.resolve({
          sessionId,
          handle: entry.handle,
          purpose: foreignPurpose,
        })).toBeNull();
      }
    });

    const serialized = JSON.stringify({ exact, bounded, repeated });
    for (const rawValue of [
      platformId,
      secret,
      sessionId,
      'display-profile-user-',
      'display-profile-canonical-only',
      'profile-group-',
      'history-group-',
      'Malformed',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(boundedChanges);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('lists bounded display-profile targets for an exact user without exposing profile data', async () => {
    const canonicalUserId = 'display-target-user';
    const otherUserId = 'display-target-other-user';
    const boundUserId = 'display-target-bound-user';
    const historyBoundUserId = 'display-target-history-bound-user';
    const secret = 'sk-displaytargetabcdefghijklmnopqrstuvwxyz123456';
    const platformId = '246801357';
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    for (const userId of [canonicalUserId, otherUserId, boundUserId, historyBoundUserId]) {
      insertUser.run(userId, NOW, NOW);
    }
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertHistory = db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    insertProfile.run(
      canonicalUserId,
      '',
      `Private profile ${platformId} password=${secret}`,
      NOW + 10,
      'user_set',
    );
    insertHistory.run(
      'display-target-private-open',
      canonicalUserId,
      '',
      `Private open history ${platformId} password=${secret}`,
      NOW + 3,
      null,
    );
    insertHistory.run(
      'display-target-private-closed',
      canonicalUserId,
      '',
      `Private closed history ${platformId} password=${secret}`,
      NOW + 4,
      NOW + 5,
    );

    insertProfile.run(
      canonicalUserId,
      'alpha-group',
      `Alpha profile ${platformId} password=${secret}`,
      NOW + 20,
      'platform_provided',
    );
    insertHistory.run(
      'display-target-alpha-invalid-history',
      canonicalUserId,
      'alpha-group',
      `Invalid alpha history ${platformId} password=${secret}`,
      'invalid-date',
      null,
    );

    insertHistory.run(
      'display-target-beta-closed',
      canonicalUserId,
      'beta-group',
      `Beta history ${platformId} password=${secret}`,
      NOW + 30,
      NOW + 31,
    );
    insertProfile.run(
      canonicalUserId,
      'beta-group',
      `Invalid beta profile ${platformId} password=${secret}`,
      8_640_000_000_000_001,
      'platform_provided',
    );

    insertProfile.run(
      canonicalUserId,
      'gamma-group',
      `Gamma profile ${platformId} password=${secret}`,
      NOW + 40,
      'inferred',
    );
    insertHistory.run(
      'display-target-gamma-open',
      canonicalUserId,
      'gamma-group',
      `Gamma history ${platformId} password=${secret}`,
      NOW + 41,
      null,
    );

    insertProfile.run(
      canonicalUserId,
      'invalid-profile-only',
      `Invalid profile metadata ${platformId} password=${secret}`,
      'invalid-date',
      'platform_provided',
    );
    insertHistory.run(
      'display-target-invalid-history-only',
      canonicalUserId,
      'invalid-history-only',
      `Invalid history only ${platformId} password=${secret}`,
      NOW + 60,
      NOW + 59,
    );

    const malformedTargets: Array<string | Buffer> = [
      ' padded-display-target',
      'display-target-padded ',
      '\u00a0display-target-unicode-padded\u00a0',
      `display-target-control-${String.fromCodePoint(1)}`,
      'display-target-control\nnewline',
      `display-target-nul-${String.fromCodePoint(0)}`,
      'g'.repeat(257),
      Buffer.from('display-target-buffer', 'utf8'),
    ];
    malformedTargets.forEach((target, index) => {
      insertProfile.run(
        canonicalUserId,
        target,
        `Malformed target ${index} ${platformId} password=${secret}`,
        NOW + 100 + index,
        'platform_provided',
      );
    });
    insertProfile.run(
      otherUserId,
      'cross-user-group',
      `Cross-user profile ${platformId} password=${secret}`,
      NOW + 200,
      'platform_provided',
    );

    insertProfile.run(
      boundUserId,
      '',
      `Bound private profile ${platformId} password=${secret}`,
      NOW + 300,
      'platform_provided',
    );
    const boundGroupIds = Array.from(
      { length: 100 },
      (_, index) => `bound-group-${String(index).padStart(3, '0')}`,
    );
    boundGroupIds.slice(0, 99).forEach((groupId, index) => {
      insertProfile.run(
        boundUserId,
        groupId,
        `Bound profile ${index} ${platformId} password=${secret}`,
        NOW + 400 + index,
        'platform_provided',
      );
    });

    const historyBoundGroupId = 'history-bound-group';
    for (let index = 0; index < 100; index += 1) {
      insertHistory.run(
        `display-target-history-bound-${String(index).padStart(3, '0')}`,
        historyBoundUserId,
        historyBoundGroupId,
        `History bound ${index} ${platformId} password=${secret}`,
        NOW + 1_000 + index,
        null,
      );
    }

    const service = new GovernanceQueryService(db);
    const listDisplayProfileScopeHandles = vi.spyOn(
      service,
      'listDisplayProfileScopeHandles',
    );
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const prepare = vi.spyOn(db, 'prepare');
    const invalidScopes: unknown[] = [
      null,
      { kind: 'global' },
      { kind: 'group', groupId: 'alpha-group' },
      { kind: 'user' },
      { kind: 'user', canonicalUserId: 123 },
      { kind: 'user', canonicalUserId: '' },
      { kind: 'user', canonicalUserId: ' padded-display-target-user' },
      { kind: 'user', canonicalUserId: 'display-target-user\u00a0' },
      { kind: 'user', canonicalUserId: 'display-target-user\n' },
      { kind: 'user', canonicalUserId: 'u'.repeat(257) },
    ];
    for (const scope of invalidScopes) {
      await expect(service.listDisplayProfileTargetsForScope(
        scope as Parameters<typeof service.listDisplayProfileTargetsForScope>[0],
      )).resolves.toEqual({ entries: [], truncated: false });
    }
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();

    const targetFingerprint = (userId: string, sourceGroupId: string): string => createHash(
      'sha256',
    )
      .update('lethebot-governance:display-profile-target:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId: userId, sourceGroupId }), 'utf8')
      .digest('hex')
      .slice(0, 16);
    const core = await service.listDisplayProfileTargetsForScope({
      kind: 'user',
      canonicalUserId,
    });
    const repeated = await service.listDisplayProfileTargetsForScope({
      kind: 'user',
      canonicalUserId,
    });

    expect(core).toEqual({
      entries: [
        {
          fingerprint: targetFingerprint(canonicalUserId, ''),
          targetKind: 'private_or_global',
          label: 'Private/global display data',
          currentProfile: {
            present: true,
            trust: 'user_set',
            observedAt: new Date(NOW + 10),
          },
          history: {
            count: 2,
            truncated: false,
            lifecycle: 'mixed',
            latestObservedAt: new Date(NOW + 4),
          },
        },
        {
          fingerprint: targetFingerprint(canonicalUserId, 'alpha-group'),
          targetKind: 'group',
          label: 'Group display data',
          currentProfile: {
            present: true,
            trust: 'platform_provided',
            observedAt: new Date(NOW + 20),
          },
          history: {
            count: 0,
            truncated: false,
            lifecycle: 'absent',
            latestObservedAt: null,
          },
        },
        {
          fingerprint: targetFingerprint(canonicalUserId, 'beta-group'),
          targetKind: 'group',
          label: 'Group display data',
          currentProfile: {
            present: false,
            trust: null,
            observedAt: null,
          },
          history: {
            count: 1,
            truncated: false,
            lifecycle: 'closed',
            latestObservedAt: new Date(NOW + 30),
          },
        },
        {
          fingerprint: targetFingerprint(canonicalUserId, 'gamma-group'),
          targetKind: 'group',
          label: 'Group display data',
          currentProfile: {
            present: true,
            trust: 'inferred',
            observedAt: new Date(NOW + 40),
          },
          history: {
            count: 1,
            truncated: false,
            lifecycle: 'open',
            latestObservedAt: new Date(NOW + 41),
          },
        },
      ],
      truncated: false,
    });
    expect(repeated).toEqual(core);

    const exactBound = await service.listDisplayProfileTargetsForScope({
      kind: 'user',
      canonicalUserId: boundUserId,
    });
    expect(exactBound.entries).toHaveLength(100);
    expect(exactBound.truncated).toBe(false);
    expect(exactBound.entries.map((entry) => entry.fingerprint)).toEqual([
      targetFingerprint(boundUserId, ''),
      ...boundGroupIds.slice(0, 99).map((groupId) => targetFingerprint(boundUserId, groupId)),
    ]);
    insertProfile.run(
      boundUserId,
      boundGroupIds[99],
      `Bound overflow ${platformId} password=${secret}`,
      NOW + 999,
      'platform_provided',
    );
    const bounded = await service.listDisplayProfileTargetsForScope({
      kind: 'user',
      canonicalUserId: boundUserId,
    });
    expect(bounded.entries).toEqual(exactBound.entries);
    expect(bounded.truncated).toBe(true);

    const exactHistoryBound = await service.listDisplayProfileTargetsForScope({
      kind: 'user',
      canonicalUserId: historyBoundUserId,
    });
    expect(exactHistoryBound).toEqual({
      entries: [{
        fingerprint: targetFingerprint(historyBoundUserId, historyBoundGroupId),
        targetKind: 'group',
        label: 'Group display data',
        currentProfile: { present: false, trust: null, observedAt: null },
        history: {
          count: 100,
          truncated: false,
          lifecycle: 'open',
          latestObservedAt: new Date(NOW + 1_099),
        },
      }],
      truncated: false,
    });
    insertHistory.run(
      'display-target-history-bound-overflow',
      historyBoundUserId,
      historyBoundGroupId,
      `History overflow ${platformId} password=${secret}`,
      NOW + 999,
      null,
    );
    const boundedHistory = await service.listDisplayProfileTargetsForScope({
      kind: 'user',
      canonicalUserId: historyBoundUserId,
    });
    expect(boundedHistory.entries[0]?.history).toEqual({
      count: 100,
      truncated: true,
      lifecycle: 'open',
      latestObservedAt: new Date(NOW + 1_099),
    });

    for (const page of [core, repeated, exactBound, bounded, exactHistoryBound, boundedHistory]) {
      expect(Object.keys(page).sort()).toEqual(['entries', 'truncated']);
      for (const entry of page.entries) {
        expect(Object.keys(entry).sort()).toEqual([
          'currentProfile',
          'fingerprint',
          'history',
          'label',
          'targetKind',
        ]);
        expect(Object.keys(entry.currentProfile).sort()).toEqual([
          'observedAt',
          'present',
          'trust',
        ]);
        expect(Object.keys(entry.history).sort()).toEqual([
          'count',
          'latestObservedAt',
          'lifecycle',
          'truncated',
        ]);
        expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
        expect(entry).not.toHaveProperty('handle');
        expect(entry).not.toHaveProperty('expiresAt');
      }
    }
    expect(listDisplayProfileScopeHandles).not.toHaveBeenCalled();

    const serialized = JSON.stringify({
      core,
      repeated,
      exactBound,
      bounded,
      exactHistoryBound,
      boundedHistory,
    });
    for (const rawValue of [
      canonicalUserId,
      otherUserId,
      boundUserId,
      historyBoundUserId,
      secret,
      platformId,
      'alpha-group',
      'beta-group',
      'gamma-group',
      'bound-group-',
      historyBoundGroupId,
      'invalid-profile-only',
      'invalid-history-only',
      'cross-user-group',
      'Private profile',
      'history',
    ]) {
      if (rawValue === 'history') {
        continue;
      }
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(
      changesBefore + 2,
    );
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('issues bounded display-profile target resource handles without exposing target identifiers', async () => {
    const platformId = '864209753';
    const secret = 'sk-displaytargethandleabcdefghijklmnopqrstuvwxyz123456';
    const canonicalUserId = `display-target-handle-user-${platformId}-${secret}`;
    const otherUserId = `display-target-handle-other-${platformId}-${secret}`;
    const scope = { kind: 'user' as const, canonicalUserId };
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    insertUser.run(canonicalUserId, NOW, NOW);
    insertUser.run(otherUserId, NOW, NOW);
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertHistory = db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    insertProfile.run(
      canonicalUserId,
      '',
      `Private target ${platformId} password=${secret}`,
      NOW,
      'user_set',
    );
    const groupIds = Array.from(
      { length: 100 },
      (_, index) => `display-target-handle-group-${String(index).padStart(3, '0')}`,
    );
    groupIds.forEach((groupId, index) => {
      insertProfile.run(
        canonicalUserId,
        groupId,
        `Group target ${index} ${platformId} password=${secret}`,
        NOW + index + 1,
        'platform_provided',
      );
    });
    insertHistory.run(
      'display-target-handle-duplicate-history',
      canonicalUserId,
      groupIds[0],
      `Duplicate target ${platformId} password=${secret}`,
      NOW + 200,
      null,
    );
    insertProfile.run(
      canonicalUserId,
      ' padded-display-target-handle',
      `Malformed target ${platformId} password=${secret}`,
      NOW + 300,
      'platform_provided',
    );
    insertProfile.run(
      canonicalUserId,
      'display-target-handle-invalid-metadata',
      `Invalid metadata ${platformId} password=${secret}`,
      'invalid-date',
      'platform_provided',
    );
    insertProfile.run(
      otherUserId,
      'display-target-handle-cross-user',
      `Cross-user target ${platformId} password=${secret}`,
      NOW + 400,
      'platform_provided',
    );

    const service = new GovernanceQueryService(db);
    const registry = new GovernanceResourceHandleRegistry({ now: () => NOW });
    const sessionId = '1'.repeat(64);
    const otherSessionId = '2'.repeat(64);
    const sessionExpiresAt = NOW + 900_000;
    const issuedInputs: Array<{
      scope: typeof scope;
      targetId: string;
    }> = [];
    const issueHandle = vi.fn((input: { scope: typeof scope; targetId: string }) => {
      issuedInputs.push(input);
      return {
        ...registry.issue({
          sessionId,
          sessionExpiresAt,
          purpose: 'governance.display_profile.targets.read',
          resourceKind: 'display_profile_target',
          resourceId: input.targetId,
          scope: input.scope,
        }),
        rawTargetId: input.targetId,
        rawScope: input.scope,
        ignoredSecret: secret,
      };
    });
    const targetId = (sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target-resource:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId, sourceGroupId }), 'utf8')
      .digest('hex');
    const selectedGroupIds = groupIds.slice(0, 99);
    const expectedTargetIds = ['', ...selectedGroupIds].map(targetId);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const page = await service.listDisplayProfileTargetResourceHandlePage(
      scope,
      issueHandle,
    );
    const repeated = await service.listDisplayProfileTargetResourceHandlePage(
      scope,
      issueHandle,
    );
    const basePage = await service.listDisplayProfileTargetsForScope(scope);

    expect(repeated).toEqual(page);
    expect(page.entries).toHaveLength(100);
    expect(page.truncated).toBe(true);
    expect(issueHandle).toHaveBeenCalledTimes(200);
    expect(issuedInputs.slice(0, 100)).toEqual(expectedTargetIds.map((expectedId) => ({
      scope,
      targetId: expectedId,
    })));
    expect(issuedInputs.slice(100)).toEqual(issuedInputs.slice(0, 100));
    expect(issuedInputs.every((input) => Object.keys(input).sort().join(',') === 'scope,targetId'))
      .toBe(true);
    expect(new Set(expectedTargetIds)).toHaveProperty('size', 100);
    expect(expectedTargetIds.every((expectedId) => /^[0-9a-f]{64}$/u.test(expectedId)))
      .toBe(true);
    expect(issuedInputs.some((input) => input.targetId === targetId(groupIds[99] as string)))
      .toBe(false);
    expect(issuedInputs.some((input) => input.targetId === targetId(
      ' padded-display-target-handle',
    ))).toBe(false);
    expect(issuedInputs.some((input) => input.targetId === targetId(
      'display-target-handle-invalid-metadata',
    ))).toBe(false);
    expect(page.entries.map(({ handle: _handle, handleExpiresAt: _expiry, ...entry }) => entry))
      .toEqual(basePage.entries);
    expect(page.truncated).toBe(basePage.truncated);
    page.entries.forEach((entry, index) => {
      expect(Object.keys(entry).sort()).toEqual([
        ...Object.keys(basePage.entries[index] ?? {}),
        'handle',
        'handleExpiresAt',
      ].sort());
      expect(entry.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(entry.handleExpiresAt).toBe(sessionExpiresAt);
      expect(entry).not.toHaveProperty('targetId');
      expect(entry).not.toHaveProperty('rawTargetId');
      expect(entry.fingerprint).not.toBe(expectedTargetIds[index]);
      expect(registry.resolve({
        sessionId,
        handle: entry.handle,
        purpose: 'governance.display_profile.targets.read',
        resourceKind: 'display_profile_target',
        scope,
      })).toEqual({
        kind: 'display_profile_target',
        resourceId: expectedTargetIds[index],
      });
    });

    const firstHandle = page.entries[0]?.handle ?? '';
    expect(registry.resolve({
      sessionId: otherSessionId,
      handle: firstHandle,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'display_profile_target',
      scope,
    })).toBeNull();
    expect(registry.resolve({
      sessionId,
      handle: firstHandle,
      purpose: 'governance.privacy.preferences.read',
      resourceKind: 'display_profile_target',
      scope,
    })).toBeNull();
    expect(registry.resolve({
      sessionId,
      handle: firstHandle,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'memory_record',
      scope,
    })).toBeNull();
    expect(registry.resolve({
      sessionId,
      handle: firstHandle,
      purpose: 'governance.display_profile.targets.read',
      resourceKind: 'display_profile_target',
      scope: { kind: 'user', canonicalUserId: otherUserId },
    })).toBeNull();

    const callsBeforeInvalid = issueHandle.mock.calls.length;
    const prepare = vi.spyOn(db, 'prepare');
    for (const invalidScope of [
      null,
      { kind: 'global' },
      { kind: 'user', canonicalUserId: ' padded-display-target-handle-user' },
    ]) {
      await expect(service.listDisplayProfileTargetResourceHandlePage(
        invalidScope as never,
        issueHandle,
      )).resolves.toEqual({ entries: [], truncated: false });
    }
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    await expect(service.listDisplayProfileTargetResourceHandlePage(
      { kind: 'user', canonicalUserId: 'display-target-handle-empty-user' },
      issueHandle,
    )).resolves.toEqual({ entries: [], truncated: false });
    expect(issueHandle).toHaveBeenCalledTimes(callsBeforeInvalid);

    const serialized = JSON.stringify({ page, repeated });
    for (const rawValue of [
      canonicalUserId,
      otherUserId,
      platformId,
      secret,
      sessionId,
      'display-target-handle-group-',
      'padded-display-target-handle',
      'display-target-handle-invalid-metadata',
      'display-target-handle-cross-user',
      ...expectedTargetIds,
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('returns bounded redacted display-profile target detail only for the exact user and full target authority', async () => {
    const canonicalUserId = 'display-target-detail-user';
    const otherUserId = 'display-target-detail-other-user';
    const platformId = '735194286';
    const secret = 'sk-displaytargetdetailabcdefghijklmnopqrstuvwxyz123456';
    const scope = { kind: 'user' as const, canonicalUserId };
    const groupId = 'a-display-target-detail-group';
    const historyOnlyGroupId = 'b-display-target-detail-history-only';
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    insertUser.run(canonicalUserId, NOW, NOW);
    insertUser.run(otherUserId, NOW, NOW);
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertHistory = db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const longDisplayValue = (label: string): string => (
      `${label} ${platformId} password=${secret} ${'\u{1F642}'.repeat(180)}`
    );

    insertProfile.run(
      canonicalUserId,
      '',
      'Private display value',
      NOW + 1,
      'user_set',
    );
    insertProfile.run(
      canonicalUserId,
      groupId,
      longDisplayValue('Current group display'),
      NOW + 2,
      'platform_provided',
    );
    insertHistory.run(
      'display-target-detail-history-only',
      canonicalUserId,
      historyOnlyGroupId,
      'History-only display value',
      NOW + 3,
      null,
    );

    const overflowGroupIds = Array.from(
      { length: 98 },
      (_, index) => `z-display-target-detail-${String(index).padStart(3, '0')}`,
    );
    overflowGroupIds.forEach((sourceGroupId, index) => {
      insertProfile.run(
        canonicalUserId,
        sourceGroupId,
        `Bounded display ${index}`,
        NOW + 10 + index,
        'inferred',
      );
    });
    insertProfile.run(
      canonicalUserId,
      'display-target-detail-malformed',
      'Malformed target display',
      'invalid-date',
      'user_set',
    );
    insertProfile.run(
      otherUserId,
      groupId,
      'Other user display value',
      NOW + 4,
      'user_set',
    );

    const validHistoryRows = Array.from({ length: 33 }, (_, index) => {
      const observedAt = index >= 31 ? NOW + 500 : NOW + 100 + index;
      return {
        id: `display-target-detail-history-${String(index).padStart(2, '0')}`,
        value: index === 32
          ? longDisplayValue('Latest group history')
          : `Group history value ${index}`,
        observedAt,
        observedUntil: index % 2 === 0 ? null : observedAt + 10,
      };
    });
    for (const row of validHistoryRows) {
      insertHistory.run(
        row.id,
        canonicalUserId,
        groupId,
        row.value,
        row.observedAt,
        row.observedUntil,
      );
    }
    insertHistory.run(
      ' padded-display-target-detail-history',
      canonicalUserId,
      groupId,
      'Malformed history identifier',
      NOW + 800,
      null,
    );
    insertHistory.run(
      'display-target-detail-history-blob',
      canonicalUserId,
      groupId,
      Buffer.from(`Malformed history value ${platformId} password=${secret}`, 'utf8'),
      NOW + 801,
      null,
    );
    insertHistory.run(
      'display-target-detail-history-invalid-lifecycle',
      canonicalUserId,
      groupId,
      'Malformed history lifecycle',
      NOW + 802,
      NOW + 801,
    );

    const targetIdFor = (userId: string, sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target-resource:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId: userId, sourceGroupId }), 'utf8')
      .digest('hex');
    const historyFingerprintFor = (historyId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-nickname-history:v1\0', 'utf8')
      .update(historyId, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const privateTargetId = targetIdFor(canonicalUserId, '');
    const groupTargetId = targetIdFor(canonicalUserId, groupId);
    const historyOnlyTargetId = targetIdFor(canonicalUserId, historyOnlyGroupId);
    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const basePage = await service.listDisplayProfileTargetsForScope(scope);
    const baseByFingerprint = new Map(
      basePage.entries.map((entry) => [entry.fingerprint, entry]),
    );
    const targetFingerprintFor = (sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId, sourceGroupId }), 'utf8')
      .digest('hex')
      .slice(0, 16);
    const basePrivateTarget = baseByFingerprint.get(targetFingerprintFor(''));
    const baseGroupTarget = baseByFingerprint.get(targetFingerprintFor(groupId));
    const baseHistoryOnlyTarget = baseByFingerprint.get(
      targetFingerprintFor(historyOnlyGroupId),
    );
    expect(basePrivateTarget).toBeDefined();
    expect(baseGroupTarget).toBeDefined();
    expect(baseHistoryOnlyTarget).toBeDefined();
    expect(basePage.entries).toHaveLength(100);
    expect(basePage.truncated).toBe(true);

    const listScopes = vi.spyOn(service, 'listDisplayProfileScopeHandles');
    const listTargets = vi.spyOn(service, 'listDisplayProfileTargetsForScope');
    const listTargetHandles = vi.spyOn(
      service,
      'listDisplayProfileTargetResourceHandlePage',
    );
    const prepare = vi.spyOn(db, 'prepare');
    for (const invalidScope of [
      null,
      { kind: 'global' },
      { kind: 'user', canonicalUserId: '' },
      { kind: 'user', canonicalUserId: ` ${canonicalUserId}` },
      { kind: 'user', canonicalUserId: `${canonicalUserId}\n` },
      { kind: 'user', canonicalUserId: 'u'.repeat(257) },
    ]) {
      await expect(service.getDisplayProfileTargetDetailForScope({
        scope: invalidScope as never,
        targetId: groupTargetId,
      })).resolves.toBeNull();
    }
    for (const invalidTargetId of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      ` ${groupTargetId}`,
      `${groupTargetId} `,
    ]) {
      await expect(service.getDisplayProfileTargetDetailForScope({
        scope,
        targetId: invalidTargetId,
      })).resolves.toBeNull();
    }
    expect(prepare).not.toHaveBeenCalled();

    const unselectedTargetId = targetIdFor(
      canonicalUserId,
      overflowGroupIds.at(-1) ?? '',
    );
    for (const input of [
      {
        scope,
        targetId: targetIdFor(otherUserId, groupId),
      },
      {
        scope: { kind: 'user' as const, canonicalUserId: otherUserId },
        targetId: groupTargetId,
      },
      {
        scope,
        targetId: unselectedTargetId,
      },
      {
        scope,
        targetId: targetIdFor(canonicalUserId, 'display-target-detail-malformed'),
      },
      {
        scope,
        targetId: targetIdFor(canonicalUserId, 'display-target-detail-missing'),
      },
    ]) {
      await expect(service.getDisplayProfileTargetDetailForScope(input)).resolves.toBeNull();
    }
    expect(prepare.mock.calls.map(([sql]) => String(sql)).some((sql) => (
      sql.includes('current_display_name') || sql.includes('SELECT id, display_name')
    ))).toBe(false);
    prepare.mockClear();

    const detail = await service.getDisplayProfileTargetDetailForScope({
      scope,
      targetId: groupTargetId,
    });
    const repeated = await service.getDisplayProfileTargetDetailForScope({
      scope,
      targetId: groupTargetId,
    });
    const privateDetail = await service.getDisplayProfileTargetDetailForScope({
      scope,
      targetId: privateTargetId,
    });
    const historyOnlyDetail = await service.getDisplayProfileTargetDetailForScope({
      scope,
      targetId: historyOnlyTargetId,
    });

    expect(repeated).toEqual(detail);
    expect(detail?.target).toEqual(baseGroupTarget);
    expect(privateDetail?.target).toEqual(basePrivateTarget);
    expect(historyOnlyDetail?.target).toEqual(baseHistoryOnlyTarget);
    expect(Object.keys(detail ?? {}).sort()).toEqual([
      'currentDisplay',
      'nicknameHistory',
      'nicknameHistoryTruncated',
      'target',
    ]);
    expect(detail?.currentDisplay).toMatchObject({
      redacted: true,
      truncated: true,
    });
    expect(Array.from(detail?.currentDisplay?.value ?? '')).toHaveLength(160);
    expect(detail?.currentDisplay?.value).toContain('[REDACTED:');
    expect(privateDetail?.currentDisplay).toEqual({
      value: 'Private display value',
      redacted: false,
      truncated: false,
    });
    expect(privateDetail?.nicknameHistory).toEqual([]);
    expect(privateDetail?.nicknameHistoryTruncated).toBe(false);
    expect(historyOnlyDetail?.currentDisplay).toBeNull();
    expect(historyOnlyDetail?.nicknameHistory).toEqual([{
      fingerprint: historyFingerprintFor('display-target-detail-history-only'),
      value: 'History-only display value',
      redacted: false,
      truncated: false,
      observedAt: new Date(NOW + 3),
      observedUntil: null,
    }]);
    expect(historyOnlyDetail?.nicknameHistoryTruncated).toBe(false);

    const expectedHistoryOrder = [...validHistoryRows].sort((left, right) => (
      right.observedAt - left.observedAt
      || (left.id < right.id ? 1 : left.id === right.id ? 0 : -1)
    ));
    expect(detail?.nicknameHistory).toHaveLength(32);
    expect(detail?.nicknameHistoryTruncated).toBe(true);
    expect(detail?.nicknameHistory.map((entry) => entry.fingerprint)).toEqual(
      expectedHistoryOrder.slice(0, 32).map((row) => historyFingerprintFor(row.id)),
    );
    expect(detail?.nicknameHistory.map((entry) => ({
      observedAt: entry.observedAt,
      observedUntil: entry.observedUntil,
    }))).toEqual(expectedHistoryOrder.slice(0, 32).map((row) => ({
      observedAt: new Date(row.observedAt),
      observedUntil: row.observedUntil === null ? null : new Date(row.observedUntil),
    })));
    expect(detail?.nicknameHistory[0]).toMatchObject({
      fingerprint: historyFingerprintFor('display-target-detail-history-32'),
      redacted: true,
      truncated: true,
    });
    expect(Array.from(detail?.nicknameHistory[0]?.value ?? '')).toHaveLength(160);
    expect(detail?.nicknameHistory[1]).toMatchObject({
      fingerprint: historyFingerprintFor('display-target-detail-history-31'),
      value: 'Group history value 31',
      redacted: false,
      truncated: false,
    });
    for (const entry of detail?.nicknameHistory ?? []) {
      expect(Object.keys(entry).sort()).toEqual([
        'fingerprint',
        'observedAt',
        'observedUntil',
        'redacted',
        'truncated',
        'value',
      ]);
      expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
      expect(Array.from(entry.value).length).toBeLessThanOrEqual(160);
    }

    expect(listScopes).not.toHaveBeenCalled();
    expect(listTargets).not.toHaveBeenCalled();
    expect(listTargetHandles).not.toHaveBeenCalled();
    const serialized = JSON.stringify({ detail, repeated, privateDetail, historyOnlyDetail });
    for (const rawValue of [
      canonicalUserId,
      otherUserId,
      platformId,
      secret,
      groupId,
      historyOnlyGroupId,
      'z-display-target-detail-',
      'display-target-detail-malformed',
      'display-target-detail-history-',
      privateTargetId,
      groupTargetId,
      historyOnlyTargetId,
      unselectedTargetId,
      'Malformed history',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('previews exact display-profile target redaction with stable irreversible effects', async () => {
    const canonicalUserId = 'display-target-redaction-preview-user';
    const otherUserId = 'display-target-redaction-preview-other-user';
    const platformId = '746205193';
    const secret = 'sk-displaytargetredactionabcdefghijklmnopqrstuvwxyz12';
    const scope = { kind: 'user' as const, canonicalUserId };
    const groupId = 'a-display-target-redaction-preview-group';
    const historyOnlyGroupId = 'b-display-target-redaction-preview-history';
    const redactedGroupId = 'c-display-target-redaction-preview-redacted';
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    insertUser.run(canonicalUserId, NOW, NOW);
    insertUser.run(otherUserId, NOW, NOW);
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertHistory = db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const groupDisplayValue = `Group display ${platformId} password=${secret}`;
    insertProfile.run(canonicalUserId, '', 'Private display', NOW + 1, 'user_set');
    insertProfile.run(
      canonicalUserId,
      groupId,
      groupDisplayValue,
      NOW + 2,
      'platform_provided',
    );
    insertProfile.run(
      canonicalUserId,
      redactedGroupId,
      '[redacted]',
      NOW + 3,
      'user_set',
    );
    insertProfile.run(otherUserId, groupId, 'Other display', NOW + 4, 'user_set');
    insertHistory.run(
      'redaction-preview-history-open',
      canonicalUserId,
      groupId,
      'Open history',
      NOW + 10,
      null,
    );
    insertHistory.run(
      'redaction-preview-history-closed',
      canonicalUserId,
      groupId,
      'Closed history',
      NOW + 11,
      NOW + 12,
    );
    insertHistory.run(
      ' redaction-preview-history-malformed-id',
      canonicalUserId,
      groupId,
      'Malformed identifier history',
      NOW + 13,
      null,
    );
    insertHistory.run(
      'redaction-preview-history-blob',
      canonicalUserId,
      groupId,
      Buffer.from(`Blob history ${platformId} password=${secret}`, 'utf8'),
      NOW + 14,
      null,
    );
    insertHistory.run(
      'redaction-preview-history-invalid-lifecycle',
      canonicalUserId,
      groupId,
      'Invalid lifecycle history',
      NOW + 16,
      NOW + 15,
    );
    insertHistory.run(
      'redaction-preview-history-only',
      canonicalUserId,
      historyOnlyGroupId,
      'History-only display',
      NOW + 20,
      null,
    );
    insertHistory.run(
      'redaction-preview-history-already-redacted',
      canonicalUserId,
      redactedGroupId,
      '[redacted]',
      NOW + 21,
      NOW + 22,
    );

    const overflowGroupIds = Array.from(
      { length: 97 },
      (_, index) => `z-display-target-redaction-${String(index).padStart(3, '0')}`,
    );
    overflowGroupIds.forEach((sourceGroupId, index) => {
      insertProfile.run(
        canonicalUserId,
        sourceGroupId,
        `Overflow display ${index}`,
        NOW + 100 + index,
        'inferred',
      );
    });
    insertProfile.run(
      canonicalUserId,
      ' malformed-display-target-redaction',
      'Malformed target display',
      NOW + 500,
      'user_set',
    );

    const targetIdFor = (userId: string, sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target-resource:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId: userId, sourceGroupId }), 'utf8')
      .digest('hex');
    const targetFingerprintFor = (sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId, sourceGroupId }), 'utf8')
      .digest('hex')
      .slice(0, 16);
    const privateTargetId = targetIdFor(canonicalUserId, '');
    const groupTargetId = targetIdFor(canonicalUserId, groupId);
    const historyOnlyTargetId = targetIdFor(canonicalUserId, historyOnlyGroupId);
    const redactedTargetId = targetIdFor(canonicalUserId, redactedGroupId);
    const unselectedTargetId = targetIdFor(
      canonicalUserId,
      overflowGroupIds.at(-1) ?? '',
    );
    const service = new GovernanceQueryService(db);
    const basePage = await service.listDisplayProfileTargetsForScope(scope);
    const baseByFingerprint = new Map(
      basePage.entries.map((entry) => [entry.fingerprint, entry]),
    );
    const baseGroupTarget = baseByFingerprint.get(targetFingerprintFor(groupId));
    const basePrivateTarget = baseByFingerprint.get(targetFingerprintFor(''));
    const baseHistoryOnlyTarget = baseByFingerprint.get(
      targetFingerprintFor(historyOnlyGroupId),
    );
    const baseRedactedTarget = baseByFingerprint.get(targetFingerprintFor(redactedGroupId));
    expect(baseGroupTarget).toBeDefined();
    expect(basePrivateTarget).toBeDefined();
    expect(baseHistoryOnlyTarget).toBeDefined();
    expect(baseRedactedTarget).toBeDefined();
    expect(basePage.entries).toHaveLength(100);
    expect(basePage.truncated).toBe(true);

    const changesBeforePreview = db.prepare('SELECT total_changes()').pluck().get();
    const preview = await service.getDisplayProfileTargetRedactionPreviewForScope({
      scope,
      targetId: groupTargetId,
    });
    const repeated = await service.getDisplayProfileTargetRedactionPreviewForScope({
      scope,
      targetId: groupTargetId,
    });
    expect(repeated).toEqual(preview);
    expect(preview).toEqual({
      action: 'display_profile.redact',
      target: baseGroupTarget,
      current: {
        displayProfileRows: 1,
        nicknameHistoryRows: 5,
        openNicknameHistoryRows: 3,
        snapshotFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      expected: {
        affectedRows: {
          displayProfiles: 1,
          nicknameHistory: 5,
          total: 6,
        },
        durableEffects: [
          'display_profile_rows_redacted',
          'nickname_history_rows_redacted',
          'open_nickname_history_rows_closed',
          'audit_event_append',
        ],
        privacyConsequences: [
          'display_values_enforced_as_redacted',
          'open_history_intervals_closed',
        ],
      },
      rollback: {
        supported: false,
        boundary: 'redacted_display_values_are_not_recoverable',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(Object.keys(preview ?? {}).sort()).toEqual([
      'action',
      'current',
      'expected',
      'previewDigest',
      'rollback',
      'target',
    ]);
    const { previewDigest, ...previewPayload } = preview ?? { previewDigest: '' };
    expect(previewDigest).toBe(createHash('sha256')
      .update('lethebot-governance:display-profile-redaction-preview:v1\0', 'utf8')
      .update(JSON.stringify(previewPayload), 'utf8')
      .digest('hex'));
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforePreview);

    const privatePreview = await service.getDisplayProfileTargetRedactionPreviewForScope({
      scope,
      targetId: privateTargetId,
    });
    expect(privatePreview).toMatchObject({
      target: basePrivateTarget,
      current: {
        displayProfileRows: 1,
        nicknameHistoryRows: 0,
        openNicknameHistoryRows: 0,
      },
      expected: {
        affectedRows: { displayProfiles: 1, nicknameHistory: 0, total: 1 },
        durableEffects: ['display_profile_rows_redacted', 'audit_event_append'],
        privacyConsequences: ['display_values_enforced_as_redacted'],
      },
    });
    const historyOnlyPreview =
      await service.getDisplayProfileTargetRedactionPreviewForScope({
        scope,
        targetId: historyOnlyTargetId,
      });
    expect(historyOnlyPreview).toMatchObject({
      target: baseHistoryOnlyTarget,
      current: {
        displayProfileRows: 0,
        nicknameHistoryRows: 1,
        openNicknameHistoryRows: 1,
      },
      expected: {
        affectedRows: { displayProfiles: 0, nicknameHistory: 1, total: 1 },
        durableEffects: [
          'nickname_history_rows_redacted',
          'open_nickname_history_rows_closed',
          'audit_event_append',
        ],
        privacyConsequences: [
          'display_values_enforced_as_redacted',
          'open_history_intervals_closed',
        ],
      },
    });
    const redactedPreview = await service.getDisplayProfileTargetRedactionPreviewForScope({
      scope,
      targetId: redactedTargetId,
    });
    expect(redactedPreview).toMatchObject({
      target: baseRedactedTarget,
      current: {
        displayProfileRows: 1,
        nicknameHistoryRows: 1,
        openNicknameHistoryRows: 0,
      },
      expected: {
        affectedRows: { displayProfiles: 1, nicknameHistory: 1, total: 2 },
        durableEffects: [
          'display_profile_rows_redacted',
          'nickname_history_rows_redacted',
          'audit_event_append',
        ],
        privacyConsequences: ['display_values_enforced_as_redacted'],
      },
    });

    const listScopes = vi.spyOn(service, 'listDisplayProfileScopeHandles');
    const listTargets = vi.spyOn(service, 'listDisplayProfileTargetsForScope');
    const listTargetHandles = vi.spyOn(
      service,
      'listDisplayProfileTargetResourceHandlePage',
    );
    const readDetail = vi.spyOn(service, 'getDisplayProfileTargetDetailForScope');
    const prepare = vi.spyOn(db, 'prepare');
    for (const invalidScope of [
      null,
      { kind: 'global' },
      { kind: 'user', canonicalUserId: '' },
      { kind: 'user', canonicalUserId: ` ${canonicalUserId}` },
      { kind: 'user', canonicalUserId: `${canonicalUserId}\n` },
      { kind: 'user', canonicalUserId: 'u'.repeat(257) },
    ]) {
      await expect(service.getDisplayProfileTargetRedactionPreviewForScope({
        scope: invalidScope as never,
        targetId: groupTargetId,
      })).resolves.toBeNull();
    }
    for (const invalidTargetId of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      ` ${groupTargetId}`,
      `${groupTargetId} `,
    ]) {
      await expect(service.getDisplayProfileTargetRedactionPreviewForScope({
        scope,
        targetId: invalidTargetId,
      })).resolves.toBeNull();
    }
    expect(prepare).not.toHaveBeenCalled();

    for (const input of [
      { scope, targetId: targetIdFor(otherUserId, groupId) },
      {
        scope: { kind: 'user' as const, canonicalUserId: otherUserId },
        targetId: groupTargetId,
      },
      { scope, targetId: unselectedTargetId },
      {
        scope,
        targetId: targetIdFor(canonicalUserId, ' malformed-display-target-redaction'),
      },
      { scope, targetId: targetIdFor(canonicalUserId, 'missing-redaction-target') },
    ]) {
      await expect(service.getDisplayProfileTargetRedactionPreviewForScope(input))
        .resolves.toBeNull();
    }
    expect(prepare.mock.calls.map(([sql]) => String(sql)).some((sql) => (
      sql.includes('current_display_name_type') || sql.includes('history_id_type')
    ))).toBe(false);
    prepare.mockRestore();

    const assertSnapshotChanged = async (
      mutate: () => void,
      restore: () => void,
    ): Promise<void> => {
      mutate();
      const changed = await service.getDisplayProfileTargetRedactionPreviewForScope({
        scope,
        targetId: groupTargetId,
      });
      expect(changed?.current.snapshotFingerprint)
        .not.toBe(preview?.current.snapshotFingerprint);
      expect(changed?.previewDigest).not.toBe(preview?.previewDigest);
      restore();
      await expect(service.getDisplayProfileTargetRedactionPreviewForScope({
        scope,
        targetId: groupTargetId,
      })).resolves.toEqual(preview);
    };
    await assertSnapshotChanged(
      () => {
        db.prepare(
          `UPDATE display_profiles SET current_display_name = ?
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(Buffer.from('changed-type', 'utf8'), canonicalUserId, groupId);
      },
      () => {
        db.prepare(
          `UPDATE display_profiles SET current_display_name = ?
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(groupDisplayValue, canonicalUserId, groupId);
      },
    );
    await assertSnapshotChanged(
      () => {
        db.prepare(
          `UPDATE display_profiles SET observed_at = ?, trust = 'inferred'
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(NOW + 600, canonicalUserId, groupId);
      },
      () => {
        db.prepare(
          `UPDATE display_profiles SET observed_at = ?, trust = 'platform_provided'
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(NOW + 2, canonicalUserId, groupId);
      },
    );
    await assertSnapshotChanged(
      () => {
        db.prepare(
          `UPDATE nickname_history SET observed_until = ? WHERE id = ?`,
        ).run(NOW + 700, 'redaction-preview-history-open');
      },
      () => {
        db.prepare(
          `UPDATE nickname_history SET observed_until = NULL WHERE id = ?`,
        ).run('redaction-preview-history-open');
      },
    );
    await assertSnapshotChanged(
      () => {
        db.prepare(
          `UPDATE nickname_history SET display_name = ? WHERE id = ?`,
        ).run('Changed history value', 'redaction-preview-history-closed');
      },
      () => {
        db.prepare(
          `UPDATE nickname_history SET display_name = ? WHERE id = ?`,
        ).run('Closed history', 'redaction-preview-history-closed');
      },
    );
    await assertSnapshotChanged(
      () => {
        insertHistory.run(
          'redaction-preview-history-added',
          canonicalUserId,
          groupId,
          'Added history',
          NOW + 800,
          null,
        );
      },
      () => {
        db.prepare('DELETE FROM nickname_history WHERE id = ?')
          .run('redaction-preview-history-added');
      },
    );
    await assertSnapshotChanged(
      () => {
        db.prepare('DELETE FROM nickname_history WHERE id = ?')
          .run('redaction-preview-history-closed');
      },
      () => {
        insertHistory.run(
          'redaction-preview-history-closed',
          canonicalUserId,
          groupId,
          'Closed history',
          NOW + 11,
          NOW + 12,
        );
      },
    );

    expect(listScopes).not.toHaveBeenCalled();
    expect(listTargets).not.toHaveBeenCalled();
    expect(listTargetHandles).not.toHaveBeenCalled();
    expect(readDetail).not.toHaveBeenCalled();
    const serialized = JSON.stringify({
      preview,
      repeated,
      privatePreview,
      historyOnlyPreview,
      redactedPreview,
    });
    for (const rawValue of [
      canonicalUserId,
      otherUserId,
      groupId,
      historyOnlyGroupId,
      redactedGroupId,
      platformId,
      secret,
      groupDisplayValue,
      'Open history',
      'Closed history',
      'Malformed identifier history',
      'Blob history',
      'Invalid lifecycle history',
      'redaction-preview-history-',
      privateTargetId,
      groupTargetId,
      historyOnlyTargetId,
      redactedTargetId,
      unselectedTargetId,
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    const changesAfterFixtureDrift = db.prepare('SELECT total_changes()').pluck().get();
    await service.getDisplayProfileTargetRedactionPreviewForScope({
      scope,
      targetId: groupTargetId,
    });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesAfterFixtureDrift);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('resolves exact display-profile mutation selectors without changing public previews', async () => {
    const canonicalUserId = 'display-target-mutation-selector-user';
    const otherUserId = 'display-target-mutation-selector-other';
    const groupId = 'a-display-target-mutation-selector-group';
    const historyOnlyGroupId = 'b-display-target-mutation-selector-history';
    const scope = { kind: 'user' as const, canonicalUserId };
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    insertUser.run(canonicalUserId, NOW, NOW);
    insertUser.run(otherUserId, NOW, NOW);
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    insertProfile.run(canonicalUserId, '', 'Private selector display', NOW + 1, 'user_set');
    insertProfile.run(
      canonicalUserId,
      groupId,
      'Group selector display',
      NOW + 2,
      'platform_provided',
    );
    insertProfile.run(otherUserId, groupId, 'Other selector display', NOW + 3, 'user_set');
    db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(
      'display-target-mutation-selector-history',
      canonicalUserId,
      historyOnlyGroupId,
      'History-only selector display',
      NOW + 4,
    );
    const overflowGroupIds = Array.from(
      { length: 98 },
      (_, index) => `z-display-target-mutation-selector-${String(index).padStart(3, '0')}`,
    );
    overflowGroupIds.forEach((sourceGroupId, index) => {
      insertProfile.run(
        canonicalUserId,
        sourceGroupId,
        `Overflow selector display ${index}`,
        NOW + 100 + index,
        'inferred',
      );
    });
    insertProfile.run(
      canonicalUserId,
      ' malformed-display-target-mutation-selector',
      'Malformed selector display',
      NOW + 500,
      'user_set',
    );

    const targetIdFor = (userId: string, sourceGroupId: string): string => createHash('sha256')
      .update('lethebot-governance:display-profile-target-resource:v1\0', 'utf8')
      .update(JSON.stringify({ canonicalUserId: userId, sourceGroupId }), 'utf8')
      .digest('hex');
    const privateTargetId = targetIdFor(canonicalUserId, '');
    const groupTargetId = targetIdFor(canonicalUserId, groupId);
    const historyOnlyTargetId = targetIdFor(canonicalUserId, historyOnlyGroupId);
    const unselectedTargetId = targetIdFor(
      canonicalUserId,
      overflowGroupIds.at(-1) ?? '',
    );
    const service = new GovernanceQueryService(db);
    const pageBefore = await service.listDisplayProfileTargetsForScope(scope);
    const previewBefore = await service.getDisplayProfileTargetRedactionPreviewForScope({
      scope,
      targetId: groupTargetId,
    });
    expect(pageBefore.entries).toHaveLength(100);
    expect(pageBefore.truncated).toBe(true);
    const changesBeforeSelections = db.prepare('SELECT total_changes()').pluck().get();

    await expect(service.resolveDisplayProfileTargetRedactionMutationForScope({
      scope,
      targetId: privateTargetId,
    })).resolves.toEqual({
      canonicalUserId,
      groupId: null,
      targetId: privateTargetId,
    });
    const groupSelection = await service
      .resolveDisplayProfileTargetRedactionMutationForScope({
        scope,
        targetId: groupTargetId,
      });
    expect(groupSelection).toEqual({
      canonicalUserId,
      groupId,
      targetId: groupTargetId,
    });
    await expect(service.resolveDisplayProfileTargetRedactionMutationForScope({
      scope,
      targetId: historyOnlyTargetId,
    })).resolves.toEqual({
      canonicalUserId,
      groupId: historyOnlyGroupId,
      targetId: historyOnlyTargetId,
    });
    await expect(service.resolveDisplayProfileTargetRedactionMutationForScope({
      scope,
      targetId: groupTargetId,
    })).resolves.toEqual(groupSelection);

    const prepare = vi.spyOn(db, 'prepare');
    for (const invalidScope of [
      null,
      { kind: 'global' },
      { kind: 'user', canonicalUserId: '' },
      { kind: 'user', canonicalUserId: ` ${canonicalUserId}` },
      { kind: 'user', canonicalUserId: `${canonicalUserId}\n` },
      { kind: 'user', canonicalUserId: 'u'.repeat(257) },
    ]) {
      await expect(service.resolveDisplayProfileTargetRedactionMutationForScope({
        scope: invalidScope as never,
        targetId: groupTargetId,
      })).resolves.toBeNull();
    }
    for (const invalidTargetId of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      ` ${groupTargetId}`,
      `${groupTargetId} `,
    ]) {
      await expect(service.resolveDisplayProfileTargetRedactionMutationForScope({
        scope,
        targetId: invalidTargetId,
      })).resolves.toBeNull();
    }
    expect(prepare).not.toHaveBeenCalled();

    for (const input of [
      { scope, targetId: targetIdFor(otherUserId, groupId) },
      {
        scope: { kind: 'user' as const, canonicalUserId: otherUserId },
        targetId: groupTargetId,
      },
      { scope, targetId: unselectedTargetId },
      {
        scope,
        targetId: targetIdFor(
          canonicalUserId,
          ' malformed-display-target-mutation-selector',
        ),
      },
      { scope, targetId: targetIdFor(canonicalUserId, 'missing-mutation-selector') },
    ]) {
      await expect(service.resolveDisplayProfileTargetRedactionMutationForScope(input))
        .resolves.toBeNull();
    }
    prepare.mockRestore();

    await expect(service.listDisplayProfileTargetsForScope(scope)).resolves.toEqual(pageBefore);
    await expect(service.getDisplayProfileTargetRedactionPreviewForScope({
      scope,
      targetId: groupTargetId,
    })).resolves.toEqual(previewBefore);
    expect(JSON.stringify({ pageBefore, previewBefore })).not.toContain(canonicalUserId);
    expect(JSON.stringify({ pageBefore, previewBefore })).not.toContain(groupId);
    expect(JSON.stringify({ pageBefore, previewBefore })).not.toContain(groupTargetId);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeSelections);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('previews exact active platform-account unlink without exposing identity', async () => {
    const activeAccountId = '813579246';
    const groupAccountId = '824680357';
    const temporaryAccountId = '835791468';
    const disabledAccountId = '846802579';
    const deletedAccountId = '857913680';
    const malformedTypeAccountId = '868024791';
    const malformedTimeAccountId = '879135802';
    const reversedTimeAccountId = '880246913';
    const malformedUserAccountId = '891357024';
    const missingAccountId = '802468135';
    const secret = 'sk-platformunlinkpreviewabcdefghijklmnopqrstuvwxyz12';
    const activeUserId = `platform-unlink-preview-user-${secret}`;
    const alternateUserId = 'platform-unlink-preview-alternate-user';
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    for (const canonicalUserId of [
      activeUserId,
      alternateUserId,
      'platform-unlink-preview-group-user',
      'platform-unlink-preview-temporary-user',
      'platform-unlink-preview-disabled-user',
      'platform-unlink-preview-deleted-user',
      'platform-unlink-preview-malformed-type-user',
      'platform-unlink-preview-malformed-time-user',
      'platform-unlink-preview-reversed-time-user',
      ' malformed-platform-unlink-preview-user',
    ]) {
      insertUser.run(canonicalUserId, NOW, NOW);
    }
    const insertAccount = db.prepare(
      `INSERT INTO platform_accounts (
         platform, platform_account_id, canonical_user_id, account_type,
         verified_level, status, first_seen_at, last_seen_at
       ) VALUES ('qq', ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertAccount.run(
      activeAccountId,
      activeUserId,
      'private',
      'owner_verified',
      'active',
      NOW - 100,
      NOW,
    );
    insertAccount.run(
      groupAccountId,
      'platform-unlink-preview-group-user',
      'group_member',
      'observed',
      'active',
      NOW - 200,
      NOW - 10,
    );
    insertAccount.run(
      temporaryAccountId,
      'platform-unlink-preview-temporary-user',
      'temp_session',
      'self_claimed',
      'active',
      NOW - 300,
      NOW - 20,
    );
    insertAccount.run(
      disabledAccountId,
      'platform-unlink-preview-disabled-user',
      'private',
      'observed',
      'disabled',
      NOW - 400,
      NOW - 30,
    );
    insertAccount.run(
      deletedAccountId,
      'platform-unlink-preview-deleted-user',
      'private',
      'observed',
      'deleted',
      NOW - 500,
      NOW - 40,
    );
    db.pragma('ignore_check_constraints = ON');
    insertAccount.run(
      malformedTypeAccountId,
      'platform-unlink-preview-malformed-type-user',
      'invalid_type',
      'observed',
      'active',
      NOW - 600,
      NOW - 50,
    );
    insertAccount.run(
      malformedTimeAccountId,
      'platform-unlink-preview-malformed-time-user',
      'private',
      'observed',
      'active',
      -1,
      NOW - 60,
    );
    insertAccount.run(
      reversedTimeAccountId,
      'platform-unlink-preview-reversed-time-user',
      'private',
      'observed',
      'active',
      NOW,
      NOW - 1,
    );
    insertAccount.run(
      malformedUserAccountId,
      ' malformed-platform-unlink-preview-user',
      'private',
      'observed',
      'active',
      NOW - 700,
      NOW - 70,
    );
    db.pragma('ignore_check_constraints = OFF');

    const service = new GovernanceQueryService(db);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();
    const preview = await service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: activeAccountId,
    });
    const repeated = await service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: activeAccountId,
    });

    expect(repeated).toEqual(preview);
    expect(preview).toEqual({
      action: 'identity.platform_account.unlink',
      account: {
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
        platform: 'qq',
        accountType: 'private',
        verifiedLevel: 'owner_verified',
        status: 'active',
        firstSeenAt: new Date(NOW - 100),
        lastSeenAt: new Date(NOW),
      },
      current: {
        snapshotFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      expected: {
        status: 'disabled',
        durableEffects: ['platform_account_status_disabled', 'audit_event_append'],
        identityConsequences: ['future_identity_resolution_blocked'],
        privacyConsequences: ['platform_account_mapping_retained'],
      },
      rollback: {
        supported: false,
        boundary: 'platform_account_relink_not_available',
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(Object.keys(preview ?? {}).sort()).toEqual([
      'account',
      'action',
      'current',
      'expected',
      'previewDigest',
      'rollback',
    ]);
    expect(preview?.account.fingerprint).toBe(createHash('sha256')
      .update('lethebot-governance:platform-account-unlink-target:v1\0', 'utf8')
      .update(JSON.stringify({
        platform: 'qq',
        platformAccountId: activeAccountId,
        canonicalUserId: activeUserId,
      }), 'utf8')
      .digest('hex')
      .slice(0, 16));
    const { previewDigest, ...previewPayload } = preview ?? { previewDigest: '' };
    expect(previewDigest).toBe(createHash('sha256')
      .update('lethebot-governance:platform-account-unlink-preview:v1\0', 'utf8')
      .update(JSON.stringify(previewPayload), 'utf8')
      .digest('hex'));

    await expect(service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: groupAccountId,
    })).resolves.toMatchObject({
      account: { accountType: 'group_member', verifiedLevel: 'observed' },
    });
    await expect(service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: temporaryAccountId,
    })).resolves.toMatchObject({
      account: { accountType: 'temp_session', verifiedLevel: 'self_claimed' },
    });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);

    const prepare = vi.spyOn(db, 'prepare');
    for (const input of [
      { platform: 'discord', platformAccountId: activeAccountId },
      { platform: 'qq', platformAccountId: '' },
      { platform: 'qq', platformAccountId: '1234' },
      { platform: 'qq', platformAccountId: '01234' },
      { platform: 'qq', platformAccountId: '1234567890123' },
      { platform: 'qq', platformAccountId: '1234a' },
      { platform: 'qq', platformAccountId: ` ${activeAccountId}` },
      { platform: 'qq', platformAccountId: `${activeAccountId} ` },
    ]) {
      await expect(service.getPlatformAccountUnlinkPreview(input as never)).resolves.toBeNull();
    }
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();

    for (const platformAccountId of [
      missingAccountId,
      disabledAccountId,
      deletedAccountId,
      malformedTypeAccountId,
      malformedTimeAccountId,
      reversedTimeAccountId,
      malformedUserAccountId,
    ]) {
      await expect(service.getPlatformAccountUnlinkPreview({
        platform: 'qq',
        platformAccountId,
      })).resolves.toBeNull();
    }
    db.prepare(
      `UPDATE platform_accounts SET account_type = 'private'
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(malformedTypeAccountId);

    db.prepare(
      `UPDATE platform_accounts SET verified_level = 'self_claimed'
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(activeAccountId);
    const changedVerification = await service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: activeAccountId,
    });
    expect(changedVerification?.current.snapshotFingerprint)
      .not.toBe(preview?.current.snapshotFingerprint);
    expect(changedVerification?.previewDigest).not.toBe(preview?.previewDigest);
    db.prepare(
      `UPDATE platform_accounts SET verified_level = 'owner_verified'
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(activeAccountId);

    db.prepare(
      `UPDATE platform_accounts SET last_seen_at = ?
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(NOW + 1, activeAccountId);
    const changedTime = await service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: activeAccountId,
    });
    expect(changedTime?.current.snapshotFingerprint)
      .not.toBe(preview?.current.snapshotFingerprint);
    expect(changedTime?.previewDigest).not.toBe(preview?.previewDigest);
    db.prepare(
      `UPDATE platform_accounts SET last_seen_at = ?
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(NOW, activeAccountId);

    db.prepare(
      `UPDATE platform_accounts SET canonical_user_id = ?
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(alternateUserId, activeAccountId);
    const changedOwner = await service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: activeAccountId,
    });
    expect(changedOwner?.account.fingerprint).not.toBe(preview?.account.fingerprint);
    expect(changedOwner?.current.snapshotFingerprint)
      .not.toBe(preview?.current.snapshotFingerprint);
    expect(changedOwner?.previewDigest).not.toBe(preview?.previewDigest);
    db.prepare(
      `UPDATE platform_accounts SET canonical_user_id = ?
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(activeUserId, activeAccountId);

    db.prepare(
      `UPDATE platform_accounts SET first_seen_at = CAST(first_seen_at AS BLOB)
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(activeAccountId);
    await expect(service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: activeAccountId,
    })).resolves.toBeNull();
    db.prepare(
      `UPDATE platform_accounts SET first_seen_at = ?
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(NOW - 100, activeAccountId);
    await expect(service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: activeAccountId,
    })).resolves.toEqual(preview);

    const serialized = JSON.stringify({ preview, repeated });
    for (const rawValue of [
      activeAccountId,
      activeUserId,
      alternateUserId,
      secret,
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBeGreaterThan(changesBefore);
    const changesAfterFixtureDrift = db.prepare('SELECT total_changes()').pluck().get();
    await service.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: activeAccountId,
    });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesAfterFixtureDrift);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});

type NormalizedMaintenanceScope =
  | { kind: 'global' }
  | { kind: 'user'; canonicalUserId: string }
  | { kind: 'group'; groupId: string }
  | {
    kind: 'conversation';
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
  }
  | { kind: 'tool' }
  | { kind: 'system' };

type MemoryRecordCatalogScope = Exclude<NormalizedMaintenanceScope, { kind: 'tool' }>;

type ExplainConversationCatalogScope =
  | {
    kind: 'conversation';
    conversationId: string;
    conversationType: 'private';
  }
  | {
    kind: 'conversation';
    conversationId: string;
    conversationType: 'group';
    groupId: string;
  };

function insertExplainConversationTrace(
  db: Database.Database,
  input: {
    id: string;
    conversationId: string | Buffer;
    turnConversationId?: string | Buffer;
    conversationType: 'private' | 'group';
    groupId?: string | Buffer | null;
    createdAt: number;
    storeTrace?: boolean;
  },
): void {
  const rawEventId = `raw-explain-catalog-${input.id}`;
  const turnId = `turn-explain-catalog-${input.id}`;
  const traceId = `trace-explain-catalog-${input.id}`;
  db.prepare(
    `INSERT INTO raw_events (
       id, type, timestamp, source, platform, conversation_id, payload, created_at
     ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, '{}', ?)`,
  ).run(rawEventId, input.createdAt, `raw-${input.id}`, input.createdAt);
  db.prepare(
    `INSERT INTO agent_turns (
       id, conversation_id, trigger_event_id, context_pack_id,
       pi_model, pi_provider, status, started_at
     ) VALUES (?, ?, ?, ?, 'synthetic-model', 'synthetic-provider', 'completed', ?)`,
  ).run(
    turnId,
    input.turnConversationId ?? input.conversationId,
    rawEventId,
    input.storeTrace === false ? null : traceId,
    input.createdAt,
  );
  if (input.storeTrace === false) {
    return;
  }
  db.prepare(
    `INSERT INTO context_traces (
       id, turn_id, conversation_id, conversation_type, group_id,
       candidate_memory_ids, selected_memory_ids, rejected_memories,
       filters_applied, injected_identity_fields, recent_message_ids,
       token_budget, memories, created_at
     ) VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '{}', '[]', ?)`,
  ).run(
    traceId,
    turnId,
    input.conversationId,
    input.conversationType,
    input.groupId ?? null,
    input.createdAt,
  );
}

function insertMemoryScopeCatalogRecord(
  db: Database.Database,
  input: {
    id: string;
    scope: MemoryRecord['scope'];
    canonicalUserId?: string | null;
    groupId?: string | Buffer | null;
    conversationId?: string | null;
    state: MemoryRecord['state'];
  },
): void {
  if (typeof input.canonicalUserId === 'string') {
    db.prepare(
      `INSERT OR IGNORE INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run(input.canonicalUserId, NOW, NOW);
  }
  db.prepare(
    `INSERT INTO memory_records (
       id, scope, canonical_user_id, group_id, conversation_id,
       visibility, sensitivity, authority, kind, title, content, state,
       confidence, importance, source_context, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'owner_admin_only', 'normal', 'system',
               'fact', 'Synthetic scope title', 'Synthetic scope content', ?,
               0.5, 0.5, 'synthetic_memory_scope_catalog', ?, ?)`,
  ).run(
    input.id,
    input.scope,
    input.canonicalUserId ?? null,
    input.groupId ?? null,
    input.conversationId ?? null,
    input.state,
    NOW,
    NOW,
  );
}

function insertMemoryRecordPageRecord(
  db: Database.Database,
  input: {
    id: string;
    scope: MemoryRecord['scope'];
    canonicalUserId?: string | null;
    groupId?: string | null;
    conversationId?: string | null;
    subjectUserId?: string | null;
    visibility?: MemoryRecord['visibility'];
    sensitivity?: MemoryRecord['sensitivity'];
    authority?: MemoryRecord['authority'];
    kind?: MemoryRecord['kind'];
    title?: string;
    content?: string;
    state: MemoryRecord['state'];
    confidence?: number;
    importance?: number;
    createdAt?: number;
    updatedAt?: number;
    expiresAt?: number | null;
    sourceCount?: number;
    revisionCount?: number;
  },
): void {
  if (input.canonicalUserId) {
    db.prepare(
      `INSERT OR IGNORE INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run(input.canonicalUserId, NOW, NOW);
  }
  db.prepare(
    `INSERT INTO memory_records (
       id, scope, canonical_user_id, group_id, conversation_id, subject_user_id,
       visibility, sensitivity, authority, kind, title, content, state,
       confidence, importance, source_context, evaluator_decision_id,
       created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.scope,
    input.canonicalUserId ?? null,
    input.groupId ?? null,
    input.conversationId ?? null,
    input.subjectUserId ?? null,
    input.visibility ?? 'owner_admin_only',
    input.sensitivity ?? 'normal',
    input.authority ?? 'system',
    input.kind ?? 'fact',
    input.title ?? 'Synthetic Memory page title',
    input.content ?? 'Synthetic Memory page content',
    input.state,
    input.confidence ?? 0.5,
    input.importance ?? 0.5,
    'memory_page_source_context',
    'memory-page-evaluator',
    input.createdAt ?? NOW,
    input.updatedAt ?? NOW,
    input.expiresAt ?? null,
  );
  for (let index = 0; index < (input.sourceCount ?? 0); index += 1) {
    db.prepare(
      `INSERT INTO memory_sources (
         memory_id, source_type, source_id, source_timestamp, extracted_by,
         resolution_state
       ) VALUES (?, 'user_command', ?, ?, 'user', 'external')`,
    ).run(input.id, `memory-page-source-${index}`, NOW + index);
  }
  for (let index = 0; index < (input.revisionCount ?? 0); index += 1) {
    db.prepare(
      `INSERT INTO memory_revisions (
         id, memory_id, revision_number, change_type, previous_state, new_state,
         reason, actor, evaluator_decision_id, created_at
       ) VALUES (?, ?, ?, 'update', '{}', '{}', ?, ?, ?, ?)`,
    ).run(
      `memory-page-revision-${index}-${input.id}`,
      input.id,
      index + 1,
      `memory-page-revision-reason-${index}`,
      'memory-page-revision-actor',
      'memory-page-revision-evaluator',
      NOW + index,
    );
  }
}

function insertNormalizedMaintenanceProposal(
  db: Database.Database,
  input: {
    proposalId: string;
    scope: NormalizedMaintenanceScope;
    createdAt: number;
    candidateIds?: string[];
    revisionReason?: string;
  },
): { auditId: string } {
  const auditId = `${input.proposalId}:audit`;
  const candidateIds = input.candidateIds ?? [`${input.proposalId}:memory`];
  const canonicalUserId = input.scope.kind === 'user' ? input.scope.canonicalUserId : null;
  const groupId = input.scope.kind === 'group'
    ? input.scope.groupId
    : input.scope.kind === 'conversation' && input.scope.conversationType === 'group'
      ? input.scope.groupId ?? null
      : null;
  const conversationId = input.scope.kind === 'conversation'
    ? input.scope.conversationId
    : null;

  db.transaction(() => {
    if (canonicalUserId) {
      db.prepare(
        `INSERT OR IGNORE INTO canonical_users (id, created_at, last_seen_at)
         VALUES (?, ?, ?)`,
      ).run(canonicalUserId, input.createdAt, input.createdAt);
    }
    db.prepare(
      `INSERT INTO audit_log (
         id, timestamp, category, level, event_type, event_id,
         summary, details, redacted, risk_level
       ) VALUES (?, ?, 'memory', 'redacted_full', 'memory.maintenance.proposed',
                 ?, ?, '{}', 1, 'medium')`,
    ).run(auditId, input.createdAt, input.proposalId, `Proposal ${input.proposalId}`);

    const insertMemory = db.prepare(
      `INSERT INTO memory_records (
         id, scope, canonical_user_id, group_id, conversation_id,
         visibility, sensitivity, authority, kind, title, content, state,
         confidence, importance, source_context, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'owner_admin_only', 'normal', 'system',
                 'fact', 'Synthetic title', 'Synthetic content', 'active',
                 0.5, 0.5, 'synthetic_query_fixture', ?, ?)`,
    );
    for (const candidateId of candidateIds) {
      insertMemory.run(
        candidateId,
        input.scope.kind,
        canonicalUserId,
        groupId,
        conversationId,
        input.createdAt,
        input.createdAt,
      );
    }

    db.prepare(
      `INSERT INTO memory_maintenance_proposals (
         id, kind, effect_type, lifecycle_state, scope, canonical_user_id,
         group_id, conversation_id, subject_user_id, candidate_fingerprint,
         confidence, effect_memory_id, effect_memory_role,
         current_revision_number, created_at, updated_at, expires_at,
         created_audit_id
       ) VALUES (?, 'conflict', 'resolve_conflict', 'pending_review', ?, ?, ?, ?,
                 NULL, ?, 0.5, NULL, NULL, 1, ?, ?, NULL, ?)`,
    ).run(
      input.proposalId,
      input.scope.kind,
      canonicalUserId,
      groupId,
      conversationId,
      'a'.repeat(64),
      input.createdAt,
      input.createdAt,
      auditId,
    );
    const insertCandidate = db.prepare(
      `INSERT INTO memory_maintenance_proposal_candidates (
         proposal_id, proposal_kind, candidate_ordinal, memory_id, effect_role,
         expected_state, record_fingerprint, source_count, source_fingerprint
       ) VALUES (?, 'conflict', ?, ?, 'conflict_candidate', 'active', ?, 0, ?)`,
    );
    candidateIds.forEach((candidateId, index) => {
      insertCandidate.run(
        input.proposalId,
        index,
        candidateId,
        'b'.repeat(64),
        'c'.repeat(64),
      );
    });
    db.prepare(
      `INSERT INTO memory_maintenance_proposal_reasons (
         proposal_id, proposal_kind, reason_ordinal, reason_code
       ) VALUES (?, 'conflict', 0, 'same_boundary_title_different_content')`,
    ).run(input.proposalId);
    db.prepare(
      `INSERT INTO memory_maintenance_proposal_revisions (
         id, proposal_id, proposal_kind, revision_number, transition,
         previous_state, new_state, actor_user_id, actor_class,
         invocation_context, reason_code, audit_id, created_at
       ) VALUES (?, ?, 'conflict', 1, 'propose', NULL, 'pending_review', NULL,
                 'system_worker', 'background_worker', ?, ?, ?)`,
    ).run(
      `${input.proposalId}:revision:1`,
      input.proposalId,
      input.revisionReason ?? 'scan_proposal_created',
      auditId,
      input.createdAt,
    );
  }).immediate();

  return { auditId };
}

function seedMemoryReviewEvidence(
  db: Database.Database,
  secret: string,
  platformId: string,
): {
  conflictAuditId: string;
  consolidationAuditId: string;
  decayAuditId: string;
  decayMemoryId: string;
  platformMemoryId: string;
} {
  const conflictAuditId = 'audit-review-conflict';
  const consolidationAuditId = 'audit-review-consolidation';
  const decayAuditId = 'audit-review-decay';
  const platformMemoryId = `memory-${platformId}`;
  const decayMemoryId = 'memory-decay';

  insertMemoryReviewAudit(
    db,
    conflictAuditId,
    'memory.conflict.detected',
    NOW - 300,
    {
      candidates: [{ memoryIds: [platformMemoryId, 'memory-new'] }],
      note: `token=${secret}`,
      userId: Number(platformId),
    },
  );
  insertMemoryReviewAudit(
    db,
    consolidationAuditId,
    'memory.consolidation.candidates_detected',
    NOW - 200,
    { groups: [{ memoryIds: ['memory-copy-a', 'memory-copy-b'] }] },
  );
  insertMemoryReviewAudit(
    db,
    decayAuditId,
    'memory.decay.candidates_detected',
    NOW - 100,
    { candidates: [{ memoryId: decayMemoryId }] },
  );
  insertReviewResolutionAudit(db, {
    id: 'audit-review-supersede',
    eventType: 'memory.supersede',
    eventId: 'memory-old',
    timestamp: NOW - 50,
    details: {
      reviewAuditId: conflictAuditId,
      replacementMemoryId: 'memory-new',
    },
  });
  insertReviewResolutionAudit(db, {
    id: 'audit-review-disable',
    eventType: 'memory.disable',
    eventId: decayMemoryId,
    timestamp: NOW - 40,
    details: { decayReviewAuditId: decayAuditId },
  });

  return {
    conflictAuditId,
    consolidationAuditId,
    decayAuditId,
    decayMemoryId,
    platformMemoryId,
  };
}

function insertMemoryReviewAudit(
  db: Database.Database,
  id: string,
  eventType: MemoryReviewAuditEventType,
  timestamp: number,
  details: unknown,
): void {
  db.prepare(
    `INSERT INTO audit_log (
       id, timestamp, category, level, event_type, event_id,
       summary, details, redacted, risk_level
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    timestamp,
    'memory',
    'summary',
    eventType,
    `event-${id}`,
    `Review ${id}`,
    JSON.stringify(details),
    1,
    'medium',
  );
}

function insertReviewResolutionAudit(
  db: Database.Database,
  input: {
    id: string;
    eventType: 'memory.supersede' | 'memory.disable';
    eventId: string;
    timestamp: number;
    details: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (
       id, timestamp, category, level, event_type, event_id,
       summary, details, redacted, risk_level
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.timestamp,
    'memory',
    'summary',
    input.eventType,
    input.eventId,
    `Resolution ${input.id}`,
    JSON.stringify(input.details),
    1,
    'medium',
  );
}

function seedHealthEvidence(
  db: Database.Database,
  auditEventType: string,
  workerType: string,
): void {
  db.prepare(
    `INSERT INTO raw_events (
       id, type, timestamp, source, platform, conversation_id, payload, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'raw-query-health',
    'chat.message.received',
    NOW - 100,
    'gateway',
    'qq',
    'private:query-health',
    '{}',
    NOW - 100,
  );
  db.prepare(
    `INSERT INTO agent_turns (
       id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'turn-query-health',
    'private:query-health',
    'raw-query-health',
    'synthetic-model',
    'synthetic-provider',
    'failed',
    NOW - 90,
  );
  db.prepare(
    `INSERT INTO action_decisions (
       id, turn_id, decided_by, risk_level, confidence,
       evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'decision-query-health',
    'turn-query-health',
    'evaluator',
    'high',
    0.7,
    1,
    0,
    '[]',
    '[]',
    '[]',
    NOW - 80,
  );
  db.prepare(
    `INSERT INTO action_executions (
       id, action_decision_id, action_type, status, audit_level, executed_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'execution-query-health',
    'decision-query-health',
    'reply_full',
    'failed',
    'summary',
    NOW - 70,
  );
  db.prepare(
    `INSERT INTO tool_calls (
       id, turn_id, tool_name, input, requested_by, actor_class,
       invocation_context, status, secrets_redacted, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'tool-query-health',
    'turn-query-health',
    'workspace.read_text',
    '{}',
    'pi',
    'user',
    'private_chat',
    'timeout',
    1,
    NOW - 60,
  );

  const insertJob = db.prepare(
    `INSERT INTO jobs (
       id, type, payload, status, attempts, max_attempts,
       lease_owner, lease_expires_at, created_at, updated_at, scheduled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertJob.run(
    'job-query-pending',
    'summary',
    '{}',
    'pending',
    0,
    3,
    null,
    null,
    NOW - 50,
    NOW - 50,
    NOW - 50,
  );
  insertJob.run(
    'job-query-failed',
    'summary',
    '{}',
    'failed',
    1,
    3,
    null,
    null,
    NOW - 40,
    NOW - 40,
    NOW - 40,
  );
  insertJob.run(
    'job-query-running',
    'retention',
    '{}',
    'running',
    1,
    3,
    'worker-query-health',
    NOW + 100,
    NOW - 30,
    NOW - 30,
    NOW - 30,
  );
  db.prepare(
    `INSERT INTO worker_heartbeats (
       worker_id, worker_type, status, current_job_id, heartbeat_at, details
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'worker-query-health',
    workerType,
    'error',
    'job-query-running',
    NOW - 20,
    '{}',
  );
  db.prepare(
    `INSERT INTO audit_log (
       id, timestamp, category, level, event_type, event_id,
       summary, details, redacted, risk_level
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'audit-query-health',
    NOW - 15,
    'tool',
    'summary',
    auditEventType,
    'tool-query-health',
    'Synthetic aggregate evidence',
    '{}',
    1,
    'high',
  );

  const insertFailure = db.prepare(
    `INSERT INTO event_processing_failures (
       id, occurred_at, stage, conversation_type,
       error_name, error_message_hash, details
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertFailure.run(
    'failure-query-context',
    NOW - 20,
    'context',
    'private',
    'ContextFailure',
    'hash-context',
    '{}',
  );
  insertFailure.run(
    'failure-query-provider',
    NOW - 10,
    'provider',
    'group',
    'ProviderFailure',
    'hash-provider',
    '{}',
  );
}
