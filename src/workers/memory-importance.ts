import type Database from 'better-sqlite3';
import { z } from 'zod';
import { readMemoryImportanceEvidence } from '../memory/importance.js';
import { hashMemoryMaintenanceValue, readMemoryMaintenanceCandidateSnapshot } from '../memory/maintenance-candidate-snapshot.js';
import { AuditRepository } from '../storage/audit-repository.js';
import { hasActiveJobAttemptAuthority, JobRepository } from '../storage/job-repository.js';
import { MemoryMaintenanceProposalRepository } from '../storage/memory-maintenance-proposal-repository.js';
import { NonRetryableBackgroundTaskError, type BackgroundTaskExecutionContext } from './background.js';

const BATCH_SIZE = 20;
const payloadSchema = z.object({
  windowEndAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  windowEndOrder: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  afterMemoryId: z.string().min(1).max(256).optional(),
}).strict();

export class MemoryImportanceWorker {
  constructor(private readonly db: Database.Database, private readonly enabled = false) {}

  run(execution: BackgroundTaskExecutionContext): {
    status: 'disabled' | 'completed'; proposed: number; unchanged: number; skipped: number; scanned: number;
  } {
    const result = { status: 'completed' as 'disabled' | 'completed', proposed: 0, unchanged: 0, skipped: 0, scanned: 0 };
    if (!this.enabled) return { ...result, status: 'disabled' };
    return this.db.transaction(() => {
      const nowMs = Date.now();
      const row = this.db.prepare(`SELECT j.payload FROM jobs j JOIN job_attempts a ON a.job_id = j.id
        WHERE j.id = ? AND a.id = ? AND j.type = 'importance' AND j.status = 'running'
          AND a.status = 'running' AND a.attempt_number = ? AND j.attempts = a.attempt_number
          AND j.lease_owner = a.worker_id AND j.lease_expires_at > ?`)
        .get(execution.jobId, execution.jobAttemptId, execution.attemptNumber, nowMs) as { payload: string } | undefined;
      if (!row) throw new Error('Importance job authority unavailable');
      let parsed: unknown;
      try { parsed = JSON.parse(row.payload); } catch { throw new NonRetryableBackgroundTaskError('Invalid importance window'); }
      const payload = payloadSchema.safeParse(parsed);
      if (!payload.success || payload.data.windowEndAt > nowMs) throw new NonRetryableBackgroundTaskError('Invalid importance window');
      const window = payload.data;
      const ids = this.db.prepare(`SELECT id FROM memory_records WHERE state = 'active'
        AND scope = 'user' AND kind = 'preference' AND id > ? ORDER BY id LIMIT ?`)
        .pluck().all(window.afterMemoryId ?? '', BATCH_SIZE + 1) as string[];
      const repository = new MemoryMaintenanceProposalRepository(this.db, new AuditRepository(this.db));
      for (const memoryId of ids.slice(0, BATCH_SIZE)) {
        result.scanned += 1;
        const evidence = readMemoryImportanceEvidence(this.db, memoryId, window, nowMs);
        if (!evidence) { result.skipped += 1; continue; }
        const snapshot = readMemoryMaintenanceCandidateSnapshot(this.db, [memoryId]);
        const proposalId = `memory-maintenance-importance-v1-${hashMemoryMaintenanceValue({
          candidateFingerprint: snapshot.candidateFingerprint, evidenceFingerprint: evidence.evidenceFingerprint,
        })}`;
        const exists = this.db.prepare('SELECT 1 FROM memory_maintenance_proposals WHERE id = ?').get(proposalId);
        repository.createOrGet({
          proposal: { proposalId, kind: 'importance', candidateMemoryIds: [memoryId], sourceSet: snapshot.sourceSet,
            reasonCodes: ['repeated_first_party_evidence'], confidence: evidence.confidence,
            proposedEffect: { type: 'adjust_importance', memoryId, importance: evidence.proposedImportance },
            candidateFingerprint: snapshot.candidateFingerprint },
          scope: snapshot.scope, candidates: snapshot.candidates, importance: evidence,
          jobAttemptId: execution.jobAttemptId, nowMs,
        });
        if (exists) result.unchanged += 1;
        else result.proposed += 1;
      }
      if (ids.length > BATCH_SIZE) {
        const afterMemoryId = ids[BATCH_SIZE - 1];
        new JobRepository(this.db).enqueue({ type: 'importance', payload: { ...window, afterMemoryId },
          idempotencyKey: `importance-next:${execution.jobId}:${afterMemoryId}` });
      }
      if (!hasActiveJobAttemptAuthority(this.db, {
        jobId: execution.jobId, attemptId: execution.jobAttemptId, now: Date.now(),
      })) throw new Error('Importance job authority unavailable');
      return result;
    }).immediate();
  }
}
