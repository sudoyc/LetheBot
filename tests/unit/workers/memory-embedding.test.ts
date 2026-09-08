import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingError, type EmbeddingBatch, type EmbeddingProvider } from '../../../src/memory/embedding.js';
import { initDatabase, runMigrations } from '../../../src/storage/database.js';
import { JobRepository } from '../../../src/storage/job-repository.js';
import { MemoryEmbeddingRepository } from '../../../src/storage/memory-embedding-repository.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';
import { MemoryEmbeddingWorker } from '../../../src/workers/memory-embedding.js';

const identity = {
  provider: 'local_transformers' as const, model: 'synthetic/model', modelRevision: 'a'.repeat(64),
  dimensions: 3, indexVersion: 1,
};
const vector = new Float32Array([1, 0, 0]);

describe('durable embedding worker', () => {
  let directory: string;
  let db: Database.Database;
  let memories: MemoryRepository;
  let index: MemoryEmbeddingRepository;
  let jobs: JobRepository;
  const embed = vi.fn<EmbeddingProvider['embed']>();
  const provider: EmbeddingProvider = { identity, embed, async close() {} };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'lethebot-embedding-worker-'));
    reopen();
    db.exec("INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES ('owner', 1, 1)");
    for (const id of ['memory-a', 'memory-b']) {
      await memories.create({
        id, scope: 'user', canonicalUserId: 'owner', kind: 'fact', title: id,
        content: `Synthetic preference ${id}`, state: 'active', sensitivity: 'normal',
        visibility: 'private_only', authority: 'user_stated', confidence: 0.9, importance: 0.5,
        actor: { actorClass: 'admin', context: 'admin_cli' }, sourceContext: 'admin_cli:synthetic',
        sources: [{ sourceType: 'user_command', sourceId: `source-${id}`, external: true }],
      });
    }
    embed.mockReset().mockImplementation(async (texts) => batch(texts.length));
  });
  afterEach(() => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function reopen() {
    db = initDatabase({ path: join(directory, 'worker.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    memories = new MemoryRepository(db);
    index = new MemoryEmbeddingRepository(db, memories);
    jobs = new JobRepository(db);
  }

  function claim() {
    jobs.enqueue({ type: 'embedding', payload: {} });
    const claimed = jobs.claimNext({ workerId: 'synthetic-worker', leaseMs: 60_000 });
    assert(claimed);
    return {
      jobId: claimed.job.id, jobAttemptId: claimed.attemptId,
      attemptNumber: claimed.attemptNumber, now: Date.now(),
    };
  }

  function batch(count: number): EmbeddingBatch {
    return { identity, vectors: Array.from({ length: count }, () => vector), durationMs: 1, peakRssBytes: 100 };
  }

  it('writes a whole batch with provenance unchanged and skips it after restart', async () => {
    const execution = claim();
    const truth = ['memory_records', 'memory_sources', 'memory_revisions', 'audit_log']
      .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    expect(await new MemoryEmbeddingWorker(db, index, provider).run(execution)).toMatchObject({ indexed: 2, stale: 0 });
    expect(['memory_records', 'memory_sources', 'memory_revisions', 'audit_log']
      .map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(truth);
    db.close();
    reopen();
    expect(await new MemoryEmbeddingWorker(db, index, provider).run(execution)).toMatchObject({ indexed: 0, scanned: 2 });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) FROM memory_embeddings').pluck().get()).toBe(2);
  });

  it('revalidates a deletion made through a concurrent connection during inference', async () => {
    const execution = claim();
    embed.mockImplementationOnce(async (texts) => {
      const connection = initDatabase({ path: join(directory, 'worker.db') });
      try { await new MemoryRepository(connection).delete('memory-a'); }
      finally { connection.close(); }
      return batch(texts.length);
    });
    expect(await new MemoryEmbeddingWorker(db, index, provider).run(execution)).toMatchObject({ indexed: 1, stale: 1 });
    expect(db.prepare('SELECT memory_id FROM memory_embeddings').pluck().all()).toEqual(['memory-b']);
  });

  it('fences a lost lease after inference and permits a fresh attempt to converge', async () => {
    const execution = claim();
    embed.mockImplementationOnce(async (texts) => {
      db.prepare('UPDATE jobs SET lease_expires_at = 0 WHERE id = ?').run(execution.jobId);
      return batch(texts.length);
    });
    const worker = new MemoryEmbeddingWorker(db, index, provider);
    await expect(worker.run(execution)).rejects.toThrow('authority unavailable');
    expect(db.prepare('SELECT COUNT(*) FROM memory_embeddings').pluck().get()).toBe(0);
    const retry = jobs.claimNext({ workerId: 'replacement', leaseMs: 60_000 });
    assert(retry);
    await expect(worker.run(execution)).rejects.toThrow('authority unavailable');
    expect(await worker.run({ jobId: retry.job.id, jobAttemptId: retry.attemptId, attemptNumber: retry.attemptNumber, now: Date.now() }))
      .toMatchObject({ indexed: 2 });
    expect(db.prepare('SELECT status FROM job_attempts WHERE id = ?').pluck().get(execution.jobAttemptId)).toBe('failed');
  });

  it('rolls back earlier vectors in a batch when a later vector is malformed', async () => {
    const execution = claim();
    embed.mockResolvedValueOnce({ ...batch(2), vectors: [vector, new Float32Array([Number.NaN, 0, 0])] });
    await expect(new MemoryEmbeddingWorker(db, index, provider).run(execution)).rejects.toThrow('invalid_vector');
    expect(db.prepare('SELECT COUNT(*) FROM memory_embeddings').pluck().get()).toBe(0);
  });

  it('cancels without writes and retries without duplicate vectors', async () => {
    const execution = claim();
    embed.mockRejectedValueOnce(new EmbeddingError('cancelled'));
    const worker = new MemoryEmbeddingWorker(db, index, provider);
    await expect(worker.run(execution)).rejects.toThrow('cancelled');
    expect(db.prepare('SELECT COUNT(*) FROM memory_embeddings').pluck().get()).toBe(0);
    expect(await worker.run(execution)).toMatchObject({ indexed: 2 });
    expect(await worker.run(execution)).toMatchObject({ indexed: 0 });
  });

  it('disables queued writes without calling the model or altering stored vectors', async () => {
    const execution = claim();
    const worker = new MemoryEmbeddingWorker(db, index, provider, false);
    expect(await worker.run(execution)).toMatchObject({ status: 'disabled', indexed: 0 });
    expect(embed).not.toHaveBeenCalled();
    expect(await new MemoryEmbeddingWorker(db, index, provider).run(execution)).toMatchObject({ indexed: 2 });
    const rows = db.prepare('SELECT * FROM memory_embeddings').all();
    expect(await worker.run(execution)).toMatchObject({ status: 'disabled' });
    expect(db.prepare('SELECT * FROM memory_embeddings').all()).toEqual(rows);
  });
});
