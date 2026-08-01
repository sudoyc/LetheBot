import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryMaintenanceProposal,
  type MemoryMaintenanceProposalKind,
  type MemoryMaintenanceProposedEffect,
  type MemoryMaintenanceReasonCode,
} from '../../../src/memory/maintenance-proposal.js';
import { AuditRepository } from '../../../src/storage/audit-repository.js';
import {
  closeDatabase,
  initDatabase,
  runMigrations,
} from '../../../src/storage/database.js';
import { MemoryMaintenanceProposalRepository } from '../../../src/storage/memory-maintenance-proposal-repository.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';

const BASE_TIME = Date.parse('2032-01-02T00:00:00.000Z');

describe('MemoryMaintenanceProposalRepository review lifecycle', () => {
  let root: string;
  let databasePath: string;
  let db: Database.Database;
  let proposals: MemoryMaintenanceProposalRepository;
  let memories: MemoryRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-maintenance-review-'));
    databasePath = join(root, 'test.db');
    db = openDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads bounded normalized proposals in deterministic review order without payloads', async () => {
    const first = await createProposal('memory-review-list-first', BASE_TIME);
    const second = await createProposal('memory-review-list-second', BASE_TIME + 1);
    await createProposal('memory-review-list-third', BASE_TIME + 2);

    const listed = proposals.listForReview({
      access: { kind: 'all' },
      states: ['pending_review'],
      limit: 2,
    });
    const total = proposals.countForReview({
      access: { kind: 'all' },
      states: ['pending_review'],
    });
    const read = proposals.findForReview({
      proposalId: first,
      access: { kind: 'all' },
    });

    expect(listed.map((proposal) => proposal.proposalId)).toEqual([first, second]);
    expect(total).toBe(3);
    expect(read).toMatchObject({
      proposalId: first,
      kind: 'decay',
      effectType: 'disable',
      lifecycleState: 'pending_review',
      scope: {
        scope: 'system',
        canonicalUserId: null,
        groupId: null,
        conversationId: null,
        subjectUserId: null,
      },
      currentRevisionNumber: 1,
      candidates: [{
        candidateOrdinal: 0,
        memoryId: 'memory-review-list-first',
        effectRole: 'disable_target',
        expectedState: 'active',
        sourceCount: 1,
      }],
      reasonCodes: ['stale'],
      revisions: [{
        revisionNumber: 1,
        transition: 'propose',
        previousState: null,
        newState: 'pending_review',
        actorUserId: null,
        actorClass: 'system_worker',
        invocationContext: 'background_worker',
        reasonCode: 'scan_proposal_created',
      }],
    });
    expect(JSON.stringify({ listed, read })).not.toContain('payload-memory-review-list-first');
    expect(JSON.stringify({ listed, read })).not.toContain('source-memory-review-list-first');
    expectIntegrity();
  });

  it('records approve, reject, and both expire paths once across retry and reopen', async () => {
    const approved = await createProposal('memory-review-approved', BASE_TIME);
    const rejected = await createProposal('memory-review-rejected', BASE_TIME + 1);
    const expiredPending = await createProposal('memory-review-expired-pending', BASE_TIME + 2);

    const approveInput = reviewInput(approved, 'pending_review', 1, 'approve', 'operator_approved');
    expect(proposals.transitionReview(approveInput).outcome).toBe('transitioned');
    expect(proposals.transitionReview(approveInput).outcome).toBe('unchanged');

    closeDatabase(db);
    db = openDatabase(false);
    expect(proposals.transitionReview(approveInput).outcome).toBe('unchanged');
    expect(proposals.transitionReview(reviewInput(
      approved,
      'approved',
      2,
      'expire',
      'operator_expired_approved',
      BASE_TIME + 20,
    )).outcome).toBe('transitioned');
    expect(proposals.transitionReview(reviewInput(
      rejected,
      'pending_review',
      1,
      'reject',
      'operator_rejected',
      BASE_TIME + 21,
    )).outcome).toBe('transitioned');
    expect(proposals.transitionReview(reviewInput(
      expiredPending,
      'pending_review',
      1,
      'expire',
      'operator_expired_pending',
      BASE_TIME + 22,
    )).outcome).toBe('transitioned');

    expect(db.prepare(
      `SELECT id, lifecycle_state, current_revision_number,
              CASE WHEN expires_at IS NULL THEN 0 ELSE 1 END AS has_expiry
         FROM memory_maintenance_proposals ORDER BY created_at, id`,
    ).all()).toEqual([
      { id: approved, lifecycle_state: 'expired', current_revision_number: 3, has_expiry: 1 },
      { id: rejected, lifecycle_state: 'rejected', current_revision_number: 2, has_expiry: 0 },
      { id: expiredPending, lifecycle_state: 'expired', current_revision_number: 2, has_expiry: 1 },
    ]);
    expect(db.prepare(
      `SELECT proposal_id, revision_number, transition, previous_state, new_state,
              actor_user_id, actor_class, invocation_context, reason_code
         FROM memory_maintenance_proposal_revisions
        WHERE revision_number > 1
        ORDER BY created_at, proposal_id, revision_number`,
    ).all()).toEqual([
      {
        proposal_id: approved,
        revision_number: 2,
        transition: 'approve',
        previous_state: 'pending_review',
        new_state: 'approved',
        actor_user_id: null,
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        reason_code: 'operator_approved',
      },
      {
        proposal_id: approved,
        revision_number: 3,
        transition: 'expire',
        previous_state: 'approved',
        new_state: 'expired',
        actor_user_id: null,
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        reason_code: 'operator_expired_approved',
      },
      {
        proposal_id: rejected,
        revision_number: 2,
        transition: 'reject',
        previous_state: 'pending_review',
        new_state: 'rejected',
        actor_user_id: null,
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        reason_code: 'operator_rejected',
      },
      {
        proposal_id: expiredPending,
        revision_number: 2,
        transition: 'expire',
        previous_state: 'pending_review',
        new_state: 'expired',
        actor_user_id: null,
        actor_class: 'admin',
        invocation_context: 'admin_cli',
        reason_code: 'operator_expired_pending',
      },
    ]);
    expect(db.prepare(
      `SELECT event_type, COUNT(*) AS count FROM audit_log
        WHERE event_type LIKE 'memory.maintenance.%'
        GROUP BY event_type ORDER BY event_type`,
    ).all()).toEqual([
      { event_type: 'memory.maintenance.approved', count: 1 },
      { event_type: 'memory.maintenance.expired', count: 2 },
      { event_type: 'memory.maintenance.proposed', count: 3 },
      { event_type: 'memory.maintenance.rejected', count: 1 },
    ]);
    expectNoMemoryEffects(3);
    expectIntegrity();
  });

  it('allows one competing decision and rolls back an injected revision failure', async () => {
    const competing = await createProposal('memory-review-competing', BASE_TIME);
    const failing = await createProposal('memory-review-failing', BASE_TIME + 1);
    const otherDb = initDatabase({ path: databasePath });
    const otherRepository = new MemoryMaintenanceProposalRepository(
      otherDb,
      new AuditRepository(otherDb),
    );

    try {
      expect(proposals.transitionReview(reviewInput(
        competing,
        'pending_review',
        1,
        'approve',
        'first_winner',
      )).outcome).toBe('transitioned');
      expect(otherRepository.transitionReview(reviewInput(
        competing,
        'pending_review',
        1,
        'reject',
        'second_loser',
      )).outcome).toBe('stale');
    } finally {
      closeDatabase(otherDb);
    }
    expect(db.prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(competing)).toEqual({ lifecycle_state: 'approved', current_revision_number: 2 });

    db.exec(`
      CREATE TRIGGER fail_synthetic_maintenance_review_revision
      BEFORE INSERT ON memory_maintenance_proposal_revisions
      WHEN NEW.proposal_id = '${failing}' AND NEW.revision_number = 2
      BEGIN
        SELECT RAISE(ABORT, 'synthetic maintenance review revision failure');
      END;
    `);
    expect(() => proposals.transitionReview(reviewInput(
      failing,
      'pending_review',
      1,
      'approve',
      'must_roll_back',
    ))).toThrow('synthetic maintenance review revision failure');

    expect(db.prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(failing)).toEqual({ lifecycle_state: 'pending_review', current_revision_number: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM audit_log
        WHERE event_id = ? AND event_type <> 'memory.maintenance.proposed'`,
    ).get(failing)).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_maintenance_proposal_revisions
        WHERE proposal_id = ?`,
    ).get(failing)).toEqual({ count: 1 });
    expectNoMemoryEffects(2);
    expectIntegrity();
  });

  it('applies consolidation, decay, and an explicit conflict choice with linked revisions', async () => {
    const consolidation = await createApplyProposal({
      kind: 'consolidation',
      memoryIds: ['memory-apply-consolidation-old', 'memory-apply-consolidation-retained'],
      proposedEffect: {
        type: 'consolidate',
        retainedMemoryId: 'memory-apply-consolidation-retained',
        supersedeMemoryIds: ['memory-apply-consolidation-old'],
      },
      reasonCodes: ['same_boundary_title_and_content'],
      nowMs: BASE_TIME + 100,
    });
    const decay = await createApplyProposal({
      kind: 'decay',
      memoryIds: ['memory-apply-decay'],
      proposedEffect: { type: 'disable', memoryId: 'memory-apply-decay' },
      reasonCodes: ['stale'],
      nowMs: BASE_TIME + 101,
    });
    const conflict = await createApplyProposal({
      kind: 'conflict',
      memoryIds: ['memory-apply-conflict-old', 'memory-apply-conflict-retained'],
      proposedEffect: {
        type: 'resolve_conflict',
        candidateMemoryIds: ['memory-apply-conflict-old', 'memory-apply-conflict-retained'],
      },
      reasonCodes: ['same_boundary_title_different_content'],
      nowMs: BASE_TIME + 102,
    });
    approveProposal(consolidation, BASE_TIME + 110);
    approveProposal(decay, BASE_TIME + 111);
    approveProposal(conflict, BASE_TIME + 112);

    expect(proposals.applyApproved(applyInput(
      consolidation,
      'apply_consolidation',
      BASE_TIME + 120,
    )).outcome).toBe('transitioned');
    expect(proposals.applyApproved(applyInput(
      decay,
      'apply_decay',
      BASE_TIME + 121,
    )).outcome).toBe('transitioned');
    expect(proposals.applyApproved(applyInput(
      conflict,
      'apply_conflict',
      BASE_TIME + 122,
      'memory-apply-conflict-retained',
    )).outcome).toBe('transitioned');

    expect(db.prepare(
      `SELECT id, state FROM memory_records
        WHERE id LIKE 'memory-apply-%' ORDER BY id`,
    ).all()).toEqual([
      { id: 'memory-apply-conflict-old', state: 'superseded' },
      { id: 'memory-apply-conflict-retained', state: 'active' },
      { id: 'memory-apply-consolidation-old', state: 'superseded' },
      { id: 'memory-apply-consolidation-retained', state: 'active' },
      { id: 'memory-apply-decay', state: 'disabled' },
    ]);
    expect(db.prepare(
      `SELECT e.proposal_id, e.memory_id, e.effect_role, r.change_type,
              r.revision_number
         FROM memory_maintenance_proposal_revision_effects AS e
         JOIN memory_revisions AS r ON r.id = e.memory_revision_id
        ORDER BY e.proposal_id, e.memory_id`,
    ).all()).toEqual([
      {
        proposal_id: conflict,
        memory_id: 'memory-apply-conflict-old',
        effect_role: 'superseded',
        change_type: 'supersede',
        revision_number: 2,
      },
      {
        proposal_id: conflict,
        memory_id: 'memory-apply-conflict-retained',
        effect_role: 'retained',
        change_type: 'update',
        revision_number: 2,
      },
      {
        proposal_id: consolidation,
        memory_id: 'memory-apply-consolidation-old',
        effect_role: 'superseded',
        change_type: 'supersede',
        revision_number: 2,
      },
      {
        proposal_id: consolidation,
        memory_id: 'memory-apply-consolidation-retained',
        effect_role: 'retained',
        change_type: 'update',
        revision_number: 2,
      },
      {
        proposal_id: decay,
        memory_id: 'memory-apply-decay',
        effect_role: 'disabled',
        change_type: 'disable',
        revision_number: 2,
      },
    ]);
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_sources
        WHERE memory_id LIKE 'memory-apply-%'`,
    ).get()).toEqual({ count: 5 });
    expect((await memories.retrieve({ state: 'active', limit: 20 }))
      .map((memory) => memory.id).sort())
      .toEqual([
        'memory-apply-conflict-retained',
        'memory-apply-consolidation-retained',
      ]);
    expect(db.prepare(
      `SELECT event_type, COUNT(*) AS count FROM audit_log
        WHERE event_type IN (
          'memory.update', 'memory.supersede', 'memory.disable',
          'memory.maintenance.applied'
        )
        GROUP BY event_type ORDER BY event_type`,
    ).all()).toEqual([
      { event_type: 'memory.disable', count: 1 },
      { event_type: 'memory.maintenance.applied', count: 3 },
      { event_type: 'memory.supersede', count: 2 },
      { event_type: 'memory.update', count: 2 },
    ]);
    expect(db.prepare(
      `SELECT lifecycle_state, current_revision_number, COUNT(*) AS count
         FROM memory_maintenance_proposals
        GROUP BY lifecycle_state, current_revision_number`,
    ).all()).toEqual([{ lifecycle_state: 'applied', current_revision_number: 3, count: 3 }]);
    expectIntegrity();
  });

  it('makes exact apply retry reopen-safe and gives one competing conflict choice authority', async () => {
    const decay = await createApplyProposal({
      kind: 'decay',
      memoryIds: ['memory-apply-retry'],
      proposedEffect: { type: 'disable', memoryId: 'memory-apply-retry' },
      reasonCodes: ['stale'],
      nowMs: BASE_TIME + 200,
    });
    approveProposal(decay, BASE_TIME + 201);
    const retryInput = applyInput(decay, 'apply_retry', BASE_TIME + 202);
    expect(proposals.applyApproved(retryInput).outcome).toBe('transitioned');
    const committedCounts = lifecycleCounts();
    expect(proposals.applyApproved(retryInput).outcome).toBe('unchanged');

    closeDatabase(db);
    db = openDatabase(false);
    expect(proposals.applyApproved(retryInput).outcome).toBe('unchanged');
    expect(lifecycleCounts()).toEqual(committedCounts);

    const conflict = await createApplyProposal({
      kind: 'conflict',
      memoryIds: ['memory-apply-race-a', 'memory-apply-race-b'],
      proposedEffect: {
        type: 'resolve_conflict',
        candidateMemoryIds: ['memory-apply-race-a', 'memory-apply-race-b'],
      },
      reasonCodes: ['same_boundary_title_different_content'],
      nowMs: BASE_TIME + 210,
    });
    approveProposal(conflict, BASE_TIME + 211);
    const otherDb = initDatabase({ path: databasePath });
    const otherRepository = new MemoryMaintenanceProposalRepository(
      otherDb,
      new AuditRepository(otherDb),
    );
    try {
      expect(proposals.applyApproved(applyInput(
        conflict,
        'apply_race',
        BASE_TIME + 212,
        'memory-apply-race-a',
      )).outcome).toBe('transitioned');
      expect(otherRepository.applyApproved(applyInput(
        conflict,
        'apply_race',
        BASE_TIME + 213,
        'memory-apply-race-b',
      )).outcome).toBe('stale');
    } finally {
      closeDatabase(otherDb);
    }
    expect(db.prepare(
      `SELECT id, state FROM memory_records
        WHERE id IN ('memory-apply-race-a', 'memory-apply-race-b') ORDER BY id`,
    ).all()).toEqual([
      { id: 'memory-apply-race-a', state: 'active' },
      { id: 'memory-apply-race-b', state: 'superseded' },
    ]);
    expect(db.prepare(
      `SELECT effect_role, memory_id
         FROM memory_maintenance_proposal_revision_effects
        WHERE proposal_id = ? ORDER BY memory_id`,
    ).all(conflict)).toEqual([
      { effect_role: 'retained', memory_id: 'memory-apply-race-a' },
      { effect_role: 'superseded', memory_id: 'memory-apply-race-b' },
    ]);
    expectIntegrity();
  });

  it('rejects stale candidate record, source, and state snapshots without apply effects', async () => {
    const recordStale = await createApprovedDecay('memory-apply-stale-record', BASE_TIME + 300);
    const sourceStale = await createApprovedDecay('memory-apply-stale-source', BASE_TIME + 301);
    const stateStale = await createApprovedDecay('memory-apply-stale-state', BASE_TIME + 302);
    const conflict = await createApplyProposal({
      kind: 'conflict',
      memoryIds: ['memory-apply-selection-a', 'memory-apply-selection-b'],
      proposedEffect: {
        type: 'resolve_conflict',
        candidateMemoryIds: ['memory-apply-selection-a', 'memory-apply-selection-b'],
      },
      reasonCodes: ['same_boundary_title_different_content'],
      nowMs: BASE_TIME + 303,
    });
    approveProposal(conflict, BASE_TIME + 304);

    db.prepare('UPDATE memory_records SET importance = importance + 0.01 WHERE id = ?')
      .run('memory-apply-stale-record');
    db.prepare('UPDATE memory_sources SET source_timestamp = source_timestamp + 1 WHERE memory_id = ?')
      .run('memory-apply-stale-source');
    memories.disableSync('memory-apply-stale-state', {
      actor: { actorClass: 'admin', context: 'admin_cli' },
      reason: 'Synthetic independent state change',
    });
    const before = lifecycleCounts();

    expect(proposals.applyApproved(applyInput(
      recordStale,
      'stale_record',
      BASE_TIME + 310,
    )).outcome).toBe('stale');
    expect(proposals.applyApproved(applyInput(
      sourceStale,
      'stale_source',
      BASE_TIME + 311,
    )).outcome).toBe('stale');
    expect(proposals.applyApproved(applyInput(
      stateStale,
      'stale_state',
      BASE_TIME + 312,
    )).outcome).toBe('stale');
    expect(() => proposals.applyApproved(applyInput(
      conflict,
      'missing_selection',
      BASE_TIME + 313,
    ))).toThrow('conflict application requires one retained candidate');
    expect(() => proposals.applyApproved(applyInput(
      conflict,
      'invalid_selection',
      BASE_TIME + 314,
      'memory-not-a-candidate',
    ))).toThrow('conflict retained memory is not a proposal candidate');

    expect(lifecycleCounts()).toEqual(before);
    expect(db.prepare(
      `SELECT id, lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals
        WHERE id IN (?, ?, ?, ?) ORDER BY id`,
    ).all(recordStale, sourceStale, stateStale, conflict)).toEqual(
      [recordStale, sourceStale, stateStale, conflict]
        .sort()
        .map((id) => ({ id, lifecycle_state: 'approved', current_revision_number: 2 })),
    );
    expectIntegrity();
  });

  it.each(['memory', 'audit', 'proposal_revision', 'effect_link'] as const)(
    'rolls back every apply mutation when the %s stage fails',
    async (stage) => {
      const memoryId = `memory-apply-failure-${stage}`;
      const proposalId = await createApprovedDecay(memoryId, BASE_TIME + 400);
      const triggerName = `fail_synthetic_maintenance_apply_${stage}`;
      const triggerTarget = {
        memory: `BEFORE UPDATE OF state ON memory_records
          WHEN NEW.id = '${memoryId}'`,
        audit: `BEFORE INSERT ON audit_log
          WHEN NEW.event_type = 'memory.maintenance.applied'
           AND NEW.event_id = '${proposalId}'`,
        proposal_revision: `BEFORE INSERT ON memory_maintenance_proposal_revisions
          WHEN NEW.proposal_id = '${proposalId}' AND NEW.transition = 'apply'`,
        effect_link: `BEFORE INSERT ON memory_maintenance_proposal_revision_effects
          WHEN NEW.proposal_id = '${proposalId}' AND NEW.transition = 'apply'`,
      }[stage];
      db.exec(`
        CREATE TRIGGER ${triggerName}
        ${triggerTarget}
        BEGIN
          SELECT RAISE(ABORT, 'synthetic maintenance apply ${stage} failure');
        END;
      `);
      const before = lifecycleCounts();

      expect(() => proposals.applyApproved(applyInput(
        proposalId,
        `failure_${stage}`,
        BASE_TIME + 410,
      ))).toThrow(`synthetic maintenance apply ${stage} failure`);

      expect(lifecycleCounts()).toEqual(before);
      expect(db.prepare(
        'SELECT state FROM memory_records WHERE id = ?',
      ).get(memoryId)).toEqual({ state: 'active' });
      expect(db.prepare(
        `SELECT lifecycle_state, current_revision_number
           FROM memory_maintenance_proposals WHERE id = ?`,
      ).get(proposalId)).toEqual({ lifecycle_state: 'approved', current_revision_number: 2 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM audit_log
          WHERE (event_id = ? AND event_type = 'memory.disable')
             OR (event_id = ? AND event_type = 'memory.maintenance.applied')`,
      ).get(memoryId, proposalId)).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_maintenance_proposal_revision_effects
          WHERE proposal_id = ?`,
      ).get(proposalId)).toEqual({ count: 0 });
      db.exec(`DROP TRIGGER ${triggerName}`);
      expectIntegrity();
    },
  );

  it('rolls back conflict, consolidation, and decay through linked restore revisions', async () => {
    const consolidation = await createApplyProposal({
      kind: 'consolidation',
      memoryIds: ['memory-rollback-consolidation-old', 'memory-rollback-consolidation-retained'],
      proposedEffect: {
        type: 'consolidate',
        retainedMemoryId: 'memory-rollback-consolidation-retained',
        supersedeMemoryIds: ['memory-rollback-consolidation-old'],
      },
      reasonCodes: ['same_boundary_title_and_content'],
      nowMs: BASE_TIME + 500,
    });
    const decay = await createApplyProposal({
      kind: 'decay',
      memoryIds: ['memory-rollback-decay'],
      proposedEffect: { type: 'disable', memoryId: 'memory-rollback-decay' },
      reasonCodes: ['stale'],
      nowMs: BASE_TIME + 501,
    });
    const conflict = await createApplyProposal({
      kind: 'conflict',
      memoryIds: ['memory-rollback-conflict-old', 'memory-rollback-conflict-retained'],
      proposedEffect: {
        type: 'resolve_conflict',
        candidateMemoryIds: ['memory-rollback-conflict-old', 'memory-rollback-conflict-retained'],
      },
      reasonCodes: ['same_boundary_title_different_content'],
      nowMs: BASE_TIME + 502,
    });
    approveProposal(consolidation, BASE_TIME + 510);
    approveProposal(decay, BASE_TIME + 511);
    approveProposal(conflict, BASE_TIME + 512);
    expect(proposals.applyApproved(applyInput(
      consolidation,
      'rollback_fixture_consolidation',
      BASE_TIME + 520,
    )).outcome).toBe('transitioned');
    expect(proposals.applyApproved(applyInput(
      decay,
      'rollback_fixture_decay',
      BASE_TIME + 521,
    )).outcome).toBe('transitioned');
    expect(proposals.applyApproved(applyInput(
      conflict,
      'rollback_fixture_conflict',
      BASE_TIME + 522,
      'memory-rollback-conflict-retained',
    )).outcome).toBe('transitioned');

    expect(proposals.rollbackApplied(rollbackInput(
      consolidation,
      'rollback_consolidation',
      BASE_TIME + 530,
    )).outcome).toBe('transitioned');
    expect(proposals.rollbackApplied(rollbackInput(
      decay,
      'rollback_decay',
      BASE_TIME + 531,
    )).outcome).toBe('transitioned');
    expect(proposals.rollbackApplied(rollbackInput(
      conflict,
      'rollback_conflict',
      BASE_TIME + 532,
    )).outcome).toBe('transitioned');

    expect(db.prepare(
      `SELECT id, state FROM memory_records
        WHERE id LIKE 'memory-rollback-%' ORDER BY id`,
    ).all()).toEqual([
      { id: 'memory-rollback-conflict-old', state: 'active' },
      { id: 'memory-rollback-conflict-retained', state: 'active' },
      { id: 'memory-rollback-consolidation-old', state: 'active' },
      { id: 'memory-rollback-consolidation-retained', state: 'active' },
      { id: 'memory-rollback-decay', state: 'active' },
    ]);
    expect((await memories.retrieve({ state: 'active', limit: 20 }))
      .map((memory) => memory.id)
      .filter((id) => id.startsWith('memory-rollback-'))
      .sort()).toEqual([
        'memory-rollback-conflict-old',
        'memory-rollback-conflict-retained',
        'memory-rollback-consolidation-old',
        'memory-rollback-consolidation-retained',
        'memory-rollback-decay',
      ]);
    expect(db.prepare(
      `SELECT e.proposal_id, e.memory_id, e.effect_role, r.change_type,
              r.revision_number
         FROM memory_maintenance_proposal_revision_effects AS e
         JOIN memory_revisions AS r ON r.id = e.memory_revision_id
        WHERE e.transition = 'rollback'
        ORDER BY e.proposal_id, e.memory_id`,
    ).all()).toEqual([
      {
        proposal_id: conflict,
        memory_id: 'memory-rollback-conflict-old',
        effect_role: 'restored',
        change_type: 'restore',
        revision_number: 3,
      },
      {
        proposal_id: conflict,
        memory_id: 'memory-rollback-conflict-retained',
        effect_role: 'restored',
        change_type: 'restore',
        revision_number: 3,
      },
      {
        proposal_id: consolidation,
        memory_id: 'memory-rollback-consolidation-old',
        effect_role: 'restored',
        change_type: 'restore',
        revision_number: 3,
      },
      {
        proposal_id: consolidation,
        memory_id: 'memory-rollback-consolidation-retained',
        effect_role: 'restored',
        change_type: 'restore',
        revision_number: 3,
      },
      {
        proposal_id: decay,
        memory_id: 'memory-rollback-decay',
        effect_role: 'restored',
        change_type: 'restore',
        revision_number: 3,
      },
    ]);
    expect(db.prepare(
      `SELECT event_type, COUNT(*) AS count FROM audit_log
        WHERE event_type IN ('memory.restore', 'memory.maintenance.rolled_back')
        GROUP BY event_type ORDER BY event_type`,
    ).all()).toEqual([
      { event_type: 'memory.maintenance.rolled_back', count: 3 },
      { event_type: 'memory.restore', count: 5 },
    ]);
    expect(db.prepare(
      `SELECT lifecycle_state, current_revision_number, COUNT(*) AS count
         FROM memory_maintenance_proposals
        GROUP BY lifecycle_state, current_revision_number`,
    ).all()).toEqual([{ lifecycle_state: 'rolled_back', current_revision_number: 4, count: 3 }]);
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM memory_sources
        WHERE memory_id LIKE 'memory-rollback-%'`,
    ).get()).toEqual({ count: 5 });
    expectIntegrity();
  });

  it('makes exact rollback retry reopen-safe and allows one competing rollback winner', async () => {
    const retryProposal = await createAppliedDecay('memory-rollback-retry', BASE_TIME + 600);
    const retry = rollbackInput(retryProposal, 'rollback_retry', BASE_TIME + 610);
    expect(proposals.rollbackApplied(retry).outcome).toBe('transitioned');
    const committedCounts = lifecycleCounts();
    expect(proposals.rollbackApplied(retry).outcome).toBe('unchanged');

    closeDatabase(db);
    db = openDatabase(false);
    expect(proposals.rollbackApplied(retry).outcome).toBe('unchanged');
    expect(lifecycleCounts()).toEqual(committedCounts);

    const competing = await createAppliedDecay('memory-rollback-race', BASE_TIME + 620);
    const otherDb = initDatabase({ path: databasePath });
    const otherRepository = new MemoryMaintenanceProposalRepository(
      otherDb,
      new AuditRepository(otherDb),
    );
    try {
      expect(proposals.rollbackApplied(rollbackInput(
        competing,
        'rollback_winner',
        BASE_TIME + 630,
      )).outcome).toBe('transitioned');
      expect(otherRepository.rollbackApplied(rollbackInput(
        competing,
        'rollback_loser',
        BASE_TIME + 631,
      )).outcome).toBe('stale');
    } finally {
      closeDatabase(otherDb);
    }
    expect(db.prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(competing)).toEqual({ lifecycle_state: 'rolled_back', current_revision_number: 4 });
    expect(db.prepare(
      `SELECT transition, effect_role, COUNT(*) AS count
         FROM memory_maintenance_proposal_revision_effects
        WHERE proposal_id = ? GROUP BY transition, effect_role ORDER BY transition`,
    ).all(competing)).toEqual([
      { transition: 'apply', effect_role: 'disabled', count: 1 },
      { transition: 'rollback', effect_role: 'restored', count: 1 },
    ]);
    expectIntegrity();
  });

  it('rejects rollback after record, source, latest-revision, or apply-effect drift', async () => {
    const recordStale = await createAppliedDecay('memory-rollback-stale-record', BASE_TIME + 700);
    const sourceStale = await createAppliedDecay('memory-rollback-stale-source', BASE_TIME + 701);
    const revisionStale = await createAppliedDecay('memory-rollback-stale-revision', BASE_TIME + 702);
    const effectStale = await createAppliedDecay('memory-rollback-stale-effect', BASE_TIME + 703);

    db.prepare('UPDATE memory_records SET content = content || ? WHERE id = ?')
      .run('-changed', 'memory-rollback-stale-record');
    db.prepare('UPDATE memory_sources SET source_timestamp = source_timestamp + 1 WHERE memory_id = ?')
      .run('memory-rollback-stale-source');
    await memories.restore('memory-rollback-stale-revision', {
      actor: { actorClass: 'admin', context: 'admin_cli' },
      reason: 'Synthetic post-apply lifecycle change',
    });
    db.prepare(
      `DELETE FROM memory_maintenance_proposal_revision_effects
        WHERE proposal_id = ? AND transition = 'apply'`,
    ).run(effectStale);
    const before = lifecycleCounts();

    for (const [proposalId, reasonCode] of [
      [recordStale, 'rollback_stale_record'],
      [sourceStale, 'rollback_stale_source'],
      [revisionStale, 'rollback_stale_revision'],
      [effectStale, 'rollback_stale_effect'],
    ] as const) {
      expect(proposals.rollbackApplied(rollbackInput(
        proposalId,
        reasonCode,
        BASE_TIME + 710,
      )).outcome).toBe('stale');
    }

    expect(lifecycleCounts()).toEqual(before);
    expect(db.prepare(
      `SELECT id, lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals
        WHERE id IN (?, ?, ?, ?) ORDER BY id`,
    ).all(recordStale, sourceStale, revisionStale, effectStale)).toEqual(
      [recordStale, sourceStale, revisionStale, effectStale]
        .sort()
        .map((id) => ({ id, lifecycle_state: 'applied', current_revision_number: 3 })),
    );
    expectIntegrity();
  });

  it.each(['memory', 'audit', 'proposal_revision', 'effect_link'] as const)(
    'rolls back every rollback mutation when the %s stage fails',
    async (stage) => {
      const memoryId = `memory-rollback-failure-${stage}`;
      const proposalId = await createAppliedDecay(memoryId, BASE_TIME + 800);
      const triggerName = `fail_synthetic_maintenance_rollback_${stage}`;
      const triggerTarget = {
        memory: `BEFORE UPDATE OF state ON memory_records
          WHEN NEW.id = '${memoryId}'`,
        audit: `BEFORE INSERT ON audit_log
          WHEN NEW.event_type = 'memory.maintenance.rolled_back'
           AND NEW.event_id = '${proposalId}'`,
        proposal_revision: `BEFORE INSERT ON memory_maintenance_proposal_revisions
          WHEN NEW.proposal_id = '${proposalId}' AND NEW.transition = 'rollback'`,
        effect_link: `BEFORE INSERT ON memory_maintenance_proposal_revision_effects
          WHEN NEW.proposal_id = '${proposalId}' AND NEW.transition = 'rollback'`,
      }[stage];
      db.exec(`
        CREATE TRIGGER ${triggerName}
        ${triggerTarget}
        BEGIN
          SELECT RAISE(ABORT, 'synthetic maintenance rollback ${stage} failure');
        END;
      `);
      const before = lifecycleCounts();

      expect(() => proposals.rollbackApplied(rollbackInput(
        proposalId,
        `rollback_failure_${stage}`,
        BASE_TIME + 810,
      ))).toThrow(`synthetic maintenance rollback ${stage} failure`);

      expect(lifecycleCounts()).toEqual(before);
      expect(db.prepare(
        'SELECT state FROM memory_records WHERE id = ?',
      ).get(memoryId)).toEqual({ state: 'disabled' });
      expect(db.prepare(
        `SELECT lifecycle_state, current_revision_number
           FROM memory_maintenance_proposals WHERE id = ?`,
      ).get(proposalId)).toEqual({ lifecycle_state: 'applied', current_revision_number: 3 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM audit_log
          WHERE (event_id = ? AND event_type = 'memory.restore')
             OR (event_id = ? AND event_type = 'memory.maintenance.rolled_back')`,
      ).get(memoryId, proposalId)).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM memory_maintenance_proposal_revision_effects
          WHERE proposal_id = ? AND transition = 'rollback'`,
      ).get(proposalId)).toEqual({ count: 0 });
      db.exec(`DROP TRIGGER ${triggerName}`);
      expectIntegrity();
    },
  );

  function openDatabase(migrate = true): Database.Database {
    const opened = initDatabase({ path: databasePath });
    if (migrate) {
      runMigrations(opened, join(process.cwd(), 'migrations'));
    }
    proposals = new MemoryMaintenanceProposalRepository(opened, new AuditRepository(opened));
    memories = new MemoryRepository(opened);
    return opened;
  }

  async function createProposal(memoryId: string, nowMs: number): Promise<string> {
    createCandidateMemory(memoryId, nowMs);
    const proposal = await createMemoryMaintenanceProposal(db, new AuditRepository(db), {
      kind: 'decay',
      candidateMemoryIds: [memoryId],
      reasonCodes: ['stale'],
      proposedEffect: { type: 'disable', memoryId },
      nowMs,
    });
    return proposal.proposalId;
  }

  function createCandidateMemory(memoryId: string, nowMs: number): void {
    memories.createSync({
      id: memoryId,
      scope: 'system',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: `Synthetic title ${memoryId}`,
      content: `payload-${memoryId}`,
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'admin_cli',
      sources: [{
        sourceType: 'user_command',
        sourceId: `source-${memoryId}`,
        sourceTimestamp: nowMs - 1,
        extractedBy: 'admin',
        external: true,
      }],
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });
  }

  async function createApplyProposal(input: {
    kind: MemoryMaintenanceProposalKind;
    memoryIds: string[];
    proposedEffect: MemoryMaintenanceProposedEffect;
    reasonCodes: MemoryMaintenanceReasonCode[];
    nowMs: number;
  }): Promise<string> {
    input.memoryIds.forEach((memoryId, index) => {
      createCandidateMemory(memoryId, input.nowMs - input.memoryIds.length + index);
    });
    const proposal = await createMemoryMaintenanceProposal(db, new AuditRepository(db), {
      kind: input.kind,
      candidateMemoryIds: input.memoryIds,
      reasonCodes: input.reasonCodes,
      proposedEffect: input.proposedEffect,
      nowMs: input.nowMs,
    });
    return proposal.proposalId;
  }

  async function createApprovedDecay(memoryId: string, nowMs: number): Promise<string> {
    const proposalId = await createProposal(memoryId, nowMs);
    approveProposal(proposalId, nowMs + 1);
    return proposalId;
  }

  async function createAppliedDecay(memoryId: string, nowMs: number): Promise<string> {
    const proposalId = await createApprovedDecay(memoryId, nowMs);
    expect(proposals.applyApproved(applyInput(
      proposalId,
      'applied_for_rollback_test',
      nowMs + 2,
    )).outcome).toBe('transitioned');
    return proposalId;
  }

  function approveProposal(proposalId: string, nowMs: number): void {
    expect(proposals.transitionReview(reviewInput(
      proposalId,
      'pending_review',
      1,
      'approve',
      'approved_for_apply_test',
      nowMs,
    )).outcome).toBe('transitioned');
  }

  function applyInput(
    proposalId: string,
    reasonCode: string,
    nowMs: number,
    retainedMemoryId?: string,
  ) {
    return {
      proposalId,
      access: { kind: 'all' as const },
      expectedState: 'approved' as const,
      expectedRevisionNumber: 2,
      actor: {
        actorClass: 'admin' as const,
        invocationContext: 'admin_cli' as const,
      },
      authorityKind: 'local_admin' as const,
      reasonCode,
      nowMs,
      ...(retainedMemoryId === undefined ? {} : { retainedMemoryId }),
    };
  }

  function rollbackInput(
    proposalId: string,
    reasonCode: string,
    nowMs: number,
  ) {
    return {
      proposalId,
      access: { kind: 'all' as const },
      expectedState: 'applied' as const,
      expectedRevisionNumber: 3,
      actor: {
        actorClass: 'admin' as const,
        invocationContext: 'admin_cli' as const,
      },
      authorityKind: 'local_admin' as const,
      reasonCode,
      nowMs,
    };
  }

  function lifecycleCounts(): Record<string, number> {
    return db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_records) AS memories,
         (SELECT COUNT(*) FROM memory_sources) AS sources,
         (SELECT COUNT(*) FROM memory_revisions) AS memory_revisions,
         (SELECT COUNT(*) FROM audit_log) AS audits,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_revisions) AS proposal_revisions,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_revision_effects) AS effects`,
    ).get() as Record<string, number>;
  }

  function reviewInput(
    proposalId: string,
    expectedState: 'pending_review' | 'approved',
    expectedRevisionNumber: number,
    transition: 'approve' | 'reject' | 'expire',
    reasonCode: string,
    nowMs = BASE_TIME + 10,
  ) {
    return {
      proposalId,
      access: { kind: 'all' as const },
      expectedState,
      expectedRevisionNumber,
      transition,
      actor: {
        actorClass: 'admin' as const,
        invocationContext: 'admin_cli' as const,
      },
      authorityKind: 'local_admin' as const,
      reasonCode,
      nowMs,
    };
  }

  function expectNoMemoryEffects(memoryCount: number): void {
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_records WHERE state = 'active') AS active_memories,
         (SELECT COUNT(*) FROM memory_revisions) AS memory_revisions,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_revision_effects) AS effects`,
    ).get()).toEqual({
      active_memories: memoryCount,
      memory_revisions: memoryCount,
      effects: 0,
    });
  }

  function expectIntegrity(): void {
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  }
});
