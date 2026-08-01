import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditRepository } from '../../../src/storage/audit-repository';
import { closeDatabase, initDatabase, runMigrations } from '../../../src/storage/database';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { MemoryDecayWorker } from '../../../src/workers/memory-decay';

const NOW_MS = Date.UTC(2031, 0, 4);
const STALE_BEFORE_MS = NOW_MS - 180 * 24 * 60 * 60 * 1_000;

describe('MemoryDecayWorker maintenance proposals', () => {
  let root: string;
  let db: Database.Database;
  let memories: MemoryRepository;
  let worker: MemoryDecayWorker;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-memory-decay-'));
    db = initDatabase({ path: join(root, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    memories = new MemoryRepository(db);
    worker = new MemoryDecayWorker(db, new AuditRepository(db));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('emits a stable proposed disable on retry without changing retrieval state', async () => {
    createDecayMemory();

    const scanInput = {
      staleBeforeMs: STALE_BEFORE_MS,
      maxConfidence: 0.5,
      maxImportance: 0.3,
      nowMs: NOW_MS,
    };
    const first = await worker.scan({ jobId: 'job-decay-first', ...scanInput });
    const retry = await worker.scan({
      jobId: 'job-decay-retry',
      ...scanInput,
      nowMs: NOW_MS + 1,
    });

    expect(first.proposals).toHaveLength(1);
    expect(first.proposals[0]).toMatchObject({
      kind: 'decay',
      candidateMemoryIds: ['mem-decay-target'],
      reasonCodes: ['stale', 'low_confidence', 'low_importance'],
      confidence: 0.4,
      proposedEffect: {
        type: 'disable',
        memoryId: 'mem-decay-target',
      },
      sourceSet: [
        {
          memoryId: 'mem-decay-target',
          sourceCount: 2,
          sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
      candidateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposalId: expect.stringMatching(/^memory-maintenance-decay-v1-[a-f0-9]{64}$/),
    });
    expect(retry.proposals.map((proposal) => proposal.proposalId)).toEqual(
      first.proposals.map((proposal) => proposal.proposalId),
    );

    const proposal = first.proposals[0];
    if (!proposal) {
      throw new Error('expected decay proposal');
    }
    const proposalId = proposal.proposalId;
    expect(retry.proposals[0]?.proposalAuditId).toBe(proposal.proposalAuditId);
    expect(db.prepare(
      `SELECT kind, effect_type, lifecycle_state, scope, effect_memory_id,
              effect_memory_role, current_revision_number, created_audit_id
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(proposalId)).toEqual({
      kind: 'decay',
      effect_type: 'disable',
      lifecycle_state: 'pending_review',
      scope: 'system',
      effect_memory_id: 'mem-decay-target',
      effect_memory_role: 'disable_target',
      current_revision_number: 1,
      created_audit_id: proposal.proposalAuditId,
    });
    expect(db.prepare(
      `SELECT candidate_ordinal, memory_id, effect_role, expected_state,
              record_fingerprint, source_count, source_fingerprint
         FROM memory_maintenance_proposal_candidates WHERE proposal_id = ?`,
    ).all(proposalId)).toEqual([
      {
        candidate_ordinal: 0,
        memory_id: 'mem-decay-target',
        effect_role: 'disable_target',
        expected_state: 'active',
        record_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        source_count: 2,
        source_fingerprint: proposal.sourceSet[0]?.sourceFingerprint,
      },
    ]);
    expect(db.prepare(
      `SELECT reason_ordinal, reason_code
         FROM memory_maintenance_proposal_reasons
        WHERE proposal_id = ? ORDER BY reason_ordinal`,
    ).all(proposalId)).toEqual([
      { reason_ordinal: 0, reason_code: 'stale' },
      { reason_ordinal: 1, reason_code: 'low_confidence' },
      { reason_ordinal: 2, reason_code: 'low_importance' },
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
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?').get('mem-decay-target'))
      .toEqual({ state: 'active' });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?',
    ).get('mem-decay-target')).toEqual({ count: 1 });

    const proposalAudit = db.prepare(
      `SELECT details FROM audit_log
        WHERE event_type = 'memory.maintenance.proposed' AND event_id = ?`,
    ).get(proposalId) as { details: string };
    const serialized = JSON.stringify({ first, retry, proposalAudit });
    expect(serialized).not.toContain('Synthetic stale content');
    expect(serialized).not.toContain('source-decay-1');
    expect(serialized).not.toContain('source-decay-2');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rolls back proposal and audit rows when normalized candidate insertion fails', async () => {
    createDecayMemory();
    db.exec(`
      CREATE TRIGGER fail_synthetic_maintenance_candidate
      BEFORE INSERT ON memory_maintenance_proposal_candidates
      BEGIN
        SELECT RAISE(ABORT, 'synthetic maintenance candidate failure');
      END;
    `);

    await expect(worker.scan({
      jobId: 'job-decay-failed',
      staleBeforeMs: STALE_BEFORE_MS,
      maxConfidence: 0.5,
      maxImportance: 0.3,
      nowMs: NOW_MS,
    })).rejects.toThrow('synthetic maintenance candidate failure');

    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_maintenance_proposals) AS proposals,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_candidates) AS candidates,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_reasons) AS reasons,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_revisions) AS revisions,
         (SELECT COUNT(*) FROM audit_log
           WHERE event_type = 'memory.maintenance.proposed') AS proposal_audits`,
    ).get()).toEqual({
      proposals: 0,
      candidates: 0,
      reasons: 0,
      revisions: 0,
      proposal_audits: 0,
    });
    expect(db.prepare(
      'SELECT state FROM memory_records WHERE id = ?',
    ).get('mem-decay-target')).toEqual({ state: 'active' });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?',
    ).get('mem-decay-target')).toEqual({ count: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  function createDecayMemory(): void {
    memories.createSync({
      id: 'mem-decay-target',
      scope: 'system',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: 'Synthetic stale title',
      content: 'Synthetic stale content',
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'source-decay-1',
          sourceTimestamp: STALE_BEFORE_MS - 2_000,
          extractedBy: 'worker',
          external: true,
        },
        {
          sourceType: 'user_command',
          sourceId: 'source-decay-2',
          sourceTimestamp: STALE_BEFORE_MS - 1_000,
          extractedBy: 'worker',
          external: true,
        },
      ],
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });
    db.prepare('UPDATE memory_records SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(STALE_BEFORE_MS - 5_000, STALE_BEFORE_MS - 1, 'mem-decay-target');
  }
});
