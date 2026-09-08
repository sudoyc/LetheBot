import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../memory/embedding.js';
import type { MemoryEmbeddingRepository } from '../storage/memory-embedding-repository.js';
import type { BackgroundTaskExecutionContext } from './background.js';

export class MemoryEmbeddingWorker {
  constructor(
    private readonly db: Database.Database,
    private readonly index: MemoryEmbeddingRepository,
    private readonly provider: EmbeddingProvider,
    private readonly enabled = true,
  ) {}

  async run(execution: BackgroundTaskExecutionContext, afterId?: string): Promise<{
    status: 'disabled' | 'completed'; indexed: number; unchanged: number; stale: number;
    scanned: number; nextCursor?: string; durationMs?: number; dimensions?: number;
  }> {
    if (!this.enabled) return { status: 'disabled', indexed: 0, unchanged: 0, stale: 0, scanned: 0 };
    this.assertExecution(execution);
    const identity = this.provider.identity ?? (await this.provider.embed(['memory index version'], { timeoutMs: 15_000 })).identity;
    this.assertExecution(execution);
    const batch = this.index.pendingBatch(identity, afterId);
    const result = { status: 'completed' as const, indexed: 0, unchanged: 0, stale: 0, scanned: batch.scanned, nextCursor: batch.nextCursor };
    if (batch.snapshots.length === 0) return result;
    const vectors = await this.provider.embed(batch.snapshots.map((snapshot) => snapshot.text), { timeoutMs: 15_000 });
    if (vectors.vectors.length !== batch.snapshots.length) throw new Error('Embedding batch mismatch');
    this.db.transaction(() => {
      this.assertExecution(execution);
      for (const [i, snapshot] of batch.snapshots.entries()) {
        const vector = vectors.vectors[i];
        if (!vector) throw new Error('Embedding batch mismatch');
        const outcome = this.index.write(snapshot, vectors.identity, vector, () => this.assertExecution(execution));
        if (outcome === 'written') result.indexed += 1;
        else result[outcome] += 1;
      }
    }).immediate();
    return { ...result, durationMs: vectors.durationMs, dimensions: vectors.identity.dimensions };
  }

  assertExecution(execution: BackgroundTaskExecutionContext): void {
    const current = this.db.prepare(`SELECT 1 FROM jobs j JOIN job_attempts a ON a.job_id = j.id
      WHERE j.id = ? AND a.id = ? AND j.type = 'embedding' AND j.status = 'running'
        AND a.status = 'running' AND a.attempt_number = ? AND j.attempts = a.attempt_number
        AND j.lease_owner = a.worker_id AND j.lease_expires_at > ?`)
      .get(execution.jobId, execution.jobAttemptId, execution.attemptNumber, Date.now());
    if (!current) throw new Error('Embedding job authority unavailable');
  }
}
