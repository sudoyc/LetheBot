import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditRepository } from '../../../src/storage/audit-repository';
import { closeDatabase, initDatabase, runMigrations } from '../../../src/storage/database';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { MemoryConsolidationWorker } from '../../../src/workers/memory-consolidation';

const NOW_MS = Date.UTC(2031, 0, 3);

describe('MemoryConsolidationWorker maintenance proposals', () => {
  let root: string;
  let dbPath: string;
  let db: Database.Database;
  let memories: MemoryRepository;
  let worker: MemoryConsolidationWorker;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-memory-consolidation-'));
    dbPath = join(root, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigrations(db, join(process.cwd(), 'migrations'));
    memories = new MemoryRepository(db);
    worker = new MemoryConsolidationWorker(db, new AuditRepository(db));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('emits one stable consolidation preview with all source sets and no automatic supersede', async () => {
    createMemory({
      id: 'mem-consolidate-a',
      confidence: 0.9,
      sourceIds: ['source-consolidate-a'],
    });
    createMemory({
      id: 'mem-consolidate-b',
      confidence: 0.7,
      sourceIds: ['source-consolidate-b-1', 'source-consolidate-b-2'],
    });

    const first = await worker.scan({ jobId: 'job-consolidate-first', nowMs: NOW_MS });
    closeDatabase(db);
    db = initDatabase({ path: dbPath });
    worker = new MemoryConsolidationWorker(db, new AuditRepository(db));
    const retry = await worker.scan({ jobId: 'job-consolidate-retry', nowMs: NOW_MS + 1 });

    expect(first.proposals).toHaveLength(1);
    expect(first.proposals[0]).toMatchObject({
      kind: 'consolidation',
      candidateMemoryIds: ['mem-consolidate-a', 'mem-consolidate-b'],
      reasonCodes: ['same_boundary_title_and_content'],
      confidence: 0.7,
      proposedEffect: {
        type: 'consolidate',
        retainedMemoryId: 'mem-consolidate-a',
        supersedeMemoryIds: ['mem-consolidate-b'],
      },
      sourceSet: [
        {
          memoryId: 'mem-consolidate-a',
          sourceCount: 1,
          sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          memoryId: 'mem-consolidate-b',
          sourceCount: 2,
          sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
      candidateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposalId: expect.stringMatching(/^memory-maintenance-consolidation-v1-[a-f0-9]{64}$/),
    });
    expect(retry.proposals.map((proposal) => proposal.proposalId)).toEqual(
      first.proposals.map((proposal) => proposal.proposalId),
    );

    const proposal = first.proposals[0];
    if (!proposal) {
      throw new Error('expected consolidation proposal');
    }
    const proposalId = proposal.proposalId;
    expect(retry.proposals[0]?.proposalAuditId).toBe(proposal.proposalAuditId);
    expect(db.prepare(
      `SELECT kind, effect_type, lifecycle_state, scope, effect_memory_id,
              effect_memory_role, current_revision_number, created_audit_id
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(proposalId)).toEqual({
      kind: 'consolidation',
      effect_type: 'consolidate',
      lifecycle_state: 'pending_review',
      scope: 'system',
      effect_memory_id: 'mem-consolidate-a',
      effect_memory_role: 'retained',
      current_revision_number: 1,
      created_audit_id: proposal.proposalAuditId,
    });
    expect(db.prepare(
      `SELECT candidate_ordinal, memory_id, effect_role, expected_state,
              record_fingerprint, source_count, source_fingerprint
         FROM memory_maintenance_proposal_candidates
        WHERE proposal_id = ? ORDER BY candidate_ordinal`,
    ).all(proposalId)).toEqual([
      {
        candidate_ordinal: 0,
        memory_id: 'mem-consolidate-a',
        effect_role: 'retained',
        expected_state: 'active',
        record_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        source_count: 1,
        source_fingerprint: proposal.sourceSet[0]?.sourceFingerprint,
      },
      {
        candidate_ordinal: 1,
        memory_id: 'mem-consolidate-b',
        effect_role: 'supersede',
        expected_state: 'active',
        record_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        source_count: 2,
        source_fingerprint: proposal.sourceSet[1]?.sourceFingerprint,
      },
    ]);
    expect(db.prepare(
      `SELECT reason_ordinal, reason_code
         FROM memory_maintenance_proposal_reasons WHERE proposal_id = ?`,
    ).all(proposalId)).toEqual([
      {
        reason_ordinal: 0,
        reason_code: 'same_boundary_title_and_content',
      },
    ]);
    expect(db.prepare(
      `SELECT revision_number, transition, previous_state, new_state,
              actor_class, invocation_context, reason_code, audit_id
         FROM memory_maintenance_proposal_revisions WHERE proposal_id = ?`,
    ).get(proposalId)).toEqual({
      revision_number: 1,
      transition: 'propose',
      previous_state: null,
      new_state: 'pending_review',
      actor_class: 'system_worker',
      invocation_context: 'background_worker',
      reason_code: 'scan_proposal_created',
      audit_id: proposal.proposalAuditId,
    });
    expect(db.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_log
        WHERE event_type = 'memory.maintenance.proposed' AND event_id = ?`,
    ).get(proposalId)).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT id, state FROM memory_records
        WHERE id IN ('mem-consolidate-a', 'mem-consolidate-b') ORDER BY id`,
    ).all()).toEqual([
      { id: 'mem-consolidate-a', state: 'active' },
      { id: 'mem-consolidate-b', state: 'active' },
    ]);
    expect(db.prepare(
      `SELECT memory_id, COUNT(*) AS count
         FROM memory_revisions
        WHERE memory_id IN ('mem-consolidate-a', 'mem-consolidate-b')
        GROUP BY memory_id ORDER BY memory_id`,
    ).all()).toEqual([
      { memory_id: 'mem-consolidate-a', count: 1 },
      { memory_id: 'mem-consolidate-b', count: 1 },
    ]);

    const proposalAudit = db.prepare(
      `SELECT details FROM audit_log
        WHERE event_type = 'memory.maintenance.proposed' AND event_id = ?`,
    ).get(proposalId) as { details: string };
    const serialized = JSON.stringify({ first, retry, proposalAudit });
    expect(serialized).not.toContain('Synthetic duplicate content');
    expect(serialized).not.toContain('source-consolidate-a');
    expect(serialized).not.toContain('source-consolidate-b-1');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  function createMemory(input: {
    id: string;
    confidence: number;
    sourceIds: string[];
  }): void {
    memories.createSync({
      id: input.id,
      scope: 'system',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'summary',
      title: 'Synthetic duplicate title',
      content: 'Synthetic duplicate content',
      state: 'active',
      confidence: input.confidence,
      importance: 0.6,
      sourceContext: 'admin_cli',
      sources: input.sourceIds.map((sourceId, index) => ({
        sourceType: 'user_command',
        sourceId,
        sourceTimestamp: NOW_MS - 5_000 + index,
        extractedBy: 'worker',
        external: true,
      })),
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });
    db.prepare('UPDATE memory_records SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(NOW_MS - 5_000, NOW_MS - 1_000, input.id);
  }
});
