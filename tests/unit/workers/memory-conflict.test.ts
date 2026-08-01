import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditRepository } from '../../../src/storage/audit-repository';
import { closeDatabase, initDatabase, runMigrations } from '../../../src/storage/database';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { MemoryConflictWorker } from '../../../src/workers/memory-conflict';

const NOW_MS = Date.UTC(2031, 0, 2);

describe('MemoryConflictWorker maintenance proposals', () => {
  let root: string;
  let db: Database.Database;
  let memories: MemoryRepository;
  let worker: MemoryConflictWorker;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-memory-conflict-'));
    db = initDatabase({ path: join(root, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    memories = new MemoryRepository(db);
    worker = new MemoryConflictWorker(db, new AuditRepository(db));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('emits one stable source-bound proposal on retry without mutating active memories', async () => {
    createMemory({
      id: 'mem-conflict-a',
      content: 'Synthetic conflict value A',
      confidence: 0.8,
      sourceIds: ['source-conflict-a-1', 'source-conflict-a-2'],
    });
    createMemory({
      id: 'mem-conflict-b',
      content: 'Synthetic conflict value B',
      confidence: 0.6,
      sourceIds: ['source-conflict-b-1'],
    });

    const first = await worker.detect({
      jobId: 'job-conflict-first',
      sinceMs: NOW_MS - 10_000,
      nowMs: NOW_MS,
    });
    const retry = await worker.detect({
      jobId: 'job-conflict-retry',
      sinceMs: NOW_MS - 10_000,
      nowMs: NOW_MS + 1,
    });

    expect(first.proposals).toHaveLength(1);
    expect(first.proposals[0]).toMatchObject({
      kind: 'conflict',
      candidateMemoryIds: ['mem-conflict-a', 'mem-conflict-b'],
      reasonCodes: ['same_boundary_title_different_content'],
      confidence: 0.6,
      proposedEffect: {
        type: 'resolve_conflict',
        candidateMemoryIds: ['mem-conflict-a', 'mem-conflict-b'],
      },
      sourceSet: [
        {
          memoryId: 'mem-conflict-a',
          sourceCount: 2,
          sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          memoryId: 'mem-conflict-b',
          sourceCount: 1,
          sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
      candidateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposalId: expect.stringMatching(/^memory-maintenance-conflict-v1-[a-f0-9]{64}$/),
    });
    expect(retry.proposals.map((proposal) => proposal.proposalId)).toEqual(
      first.proposals.map((proposal) => proposal.proposalId),
    );

    const proposal = first.proposals[0];
    if (!proposal) {
      throw new Error('expected conflict proposal');
    }
    const proposalId = proposal.proposalId;
    expect(retry.proposals[0]?.proposalAuditId).toBe(proposal.proposalAuditId);
    expect(db.prepare(
      `SELECT id, kind, effect_type, lifecycle_state, scope,
              canonical_user_id, group_id, conversation_id, subject_user_id,
              candidate_fingerprint, confidence, effect_memory_id,
              effect_memory_role, current_revision_number, created_at,
              updated_at, expires_at, created_audit_id
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(proposalId)).toEqual({
      id: proposalId,
      kind: 'conflict',
      effect_type: 'resolve_conflict',
      lifecycle_state: 'pending_review',
      scope: 'system',
      canonical_user_id: null,
      group_id: null,
      conversation_id: null,
      subject_user_id: null,
      candidate_fingerprint: proposal.candidateFingerprint,
      confidence: 0.6,
      effect_memory_id: null,
      effect_memory_role: null,
      current_revision_number: 1,
      created_at: NOW_MS,
      updated_at: NOW_MS,
      expires_at: null,
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
        memory_id: 'mem-conflict-a',
        effect_role: 'conflict_candidate',
        expected_state: 'active',
        record_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        source_count: 2,
        source_fingerprint: proposal.sourceSet[0]?.sourceFingerprint,
      },
      {
        candidate_ordinal: 1,
        memory_id: 'mem-conflict-b',
        effect_role: 'conflict_candidate',
        expected_state: 'active',
        record_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        source_count: 1,
        source_fingerprint: proposal.sourceSet[1]?.sourceFingerprint,
      },
    ]);
    expect(db.prepare(
      `SELECT reason_ordinal, reason_code
         FROM memory_maintenance_proposal_reasons
        WHERE proposal_id = ? ORDER BY reason_ordinal`,
    ).all(proposalId)).toEqual([
      {
        reason_ordinal: 0,
        reason_code: 'same_boundary_title_different_content',
      },
    ]);
    expect(db.prepare(
      `SELECT proposal_id, proposal_kind, revision_number, transition,
              previous_state, new_state, actor_user_id, actor_class,
              invocation_context, reason_code, audit_id, created_at
         FROM memory_maintenance_proposal_revisions WHERE proposal_id = ?`,
    ).get(proposalId)).toEqual({
      proposal_id: proposalId,
      proposal_kind: 'conflict',
      revision_number: 1,
      transition: 'propose',
      previous_state: null,
      new_state: 'pending_review',
      actor_user_id: null,
      actor_class: 'system_worker',
      invocation_context: 'background_worker',
      reason_code: 'scan_proposal_created',
      audit_id: proposal.proposalAuditId,
      created_at: NOW_MS,
    });
    expect(db.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_log
        WHERE event_type = 'memory.maintenance.proposed' AND event_id = ?`,
    ).get(proposalId)).toEqual({ count: 1 });
    expect(memoryStates()).toEqual([
      { id: 'mem-conflict-a', state: 'active' },
      { id: 'mem-conflict-b', state: 'active' },
    ]);
    expect(revisionCounts()).toEqual([
      { memory_id: 'mem-conflict-a', count: 1 },
      { memory_id: 'mem-conflict-b', count: 1 },
    ]);

    const proposalAudit = db.prepare(
      `SELECT details FROM audit_log
        WHERE event_type = 'memory.maintenance.proposed' AND event_id = ?`,
    ).get(proposalId) as { details: string };
    const serialized = JSON.stringify({ first, retry, proposalAudit });
    expect(serialized).not.toContain('Synthetic conflict value A');
    expect(serialized).not.toContain('Synthetic conflict value B');
    expect(serialized).not.toContain('source-conflict-a-1');
    expect(serialized).not.toContain('source-conflict-b-1');

    db.pragma('foreign_keys = OFF');
    try {
      db.prepare(
        'DELETE FROM memory_maintenance_proposal_revisions WHERE proposal_id = ?',
      ).run(proposalId);
      db.prepare(
        'DELETE FROM memory_maintenance_proposal_reasons WHERE proposal_id = ?',
      ).run(proposalId);
      db.prepare(
        'DELETE FROM memory_maintenance_proposal_candidates WHERE proposal_id = ?',
      ).run(proposalId);
      db.prepare(
        'DELETE FROM memory_maintenance_proposals WHERE id = ?',
      ).run(proposalId);
    } finally {
      db.pragma('foreign_keys = ON');
    }
    const recovered = await worker.detect({
      jobId: 'job-conflict-audit-only-recovery',
      sinceMs: NOW_MS - 10_000,
      nowMs: NOW_MS + 2,
    });
    expect(recovered.proposals[0]?.proposalAuditId).toBe(proposal.proposalAuditId);
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_maintenance_proposals WHERE id = ?) AS proposals,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_candidates
           WHERE proposal_id = ?) AS candidates,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_reasons
           WHERE proposal_id = ?) AS reasons,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_revisions
           WHERE proposal_id = ?) AS revisions,
         (SELECT COUNT(*) FROM audit_log
           WHERE event_type = 'memory.maintenance.proposed'
             AND event_id = ?) AS proposal_audits`,
    ).get(proposalId, proposalId, proposalId, proposalId, proposalId)).toEqual({
      proposals: 1,
      candidates: 2,
      reasons: 1,
      revisions: 1,
      proposal_audits: 1,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  function createMemory(input: {
    id: string;
    content: string;
    confidence: number;
    sourceIds: string[];
  }): void {
    memories.createSync({
      id: input.id,
      scope: 'system',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: 'Synthetic conflict title',
      content: input.content,
      state: 'active',
      confidence: input.confidence,
      importance: 0.7,
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

  function memoryStates(): Array<{ id: string; state: string }> {
    return db.prepare(
      `SELECT id, state FROM memory_records
        WHERE id IN ('mem-conflict-a', 'mem-conflict-b') ORDER BY id`,
    ).all() as Array<{ id: string; state: string }>;
  }

  function revisionCounts(): Array<{ memory_id: string; count: number }> {
    return db.prepare(
      `SELECT memory_id, COUNT(*) AS count
         FROM memory_revisions
        WHERE memory_id IN ('mem-conflict-a', 'mem-conflict-b')
        GROUP BY memory_id ORDER BY memory_id`,
    ).all() as Array<{ memory_id: string; count: number }>;
  }
});
