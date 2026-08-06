import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { runWorkerSchedulerSoak } from '../../../src/operations/worker-soak.js';
import { closeDatabase, initDatabase, runMigrations } from '../../../src/storage/database.js';
import { JobRepository } from '../../../src/storage/job-repository.js';

describe('runWorkerSchedulerSoak', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    runMigrations(db, join(process.cwd(), 'migrations'));
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('sustains, drains, and audits an isolated scheduler workload', async () => {
    const result = await runWorkerSchedulerSoak({
      db,
      durationMs: 500,
      intervalMs: 20,
      workerId: 'unit-worker-soak',
    });

    expect(result.success).toBe(true);
    expect(result.load).toMatchObject({
      windows: 3,
      emptyPolls: 0,
    });
    expect(result.load.enqueuedByWindow.every((count) => count >= 1)).toBe(true);
    expect(result.load.completedByWindow.every((count) => count >= 1)).toBe(true);
    expect(result.drain.timedOut).toBe(false);
    expect(result.schedulerErrors).toEqual({ producer: 0, consumer: 0, total: 0 });
    expect(result.jobs).toMatchObject({
      pending: 0,
      running: 0,
      failed: 0,
    });
    expect(result.jobAttempts).toMatchObject({
      running: 0,
      failed: 1,
      plannedRetryObserved: true,
    });
    expect(result.leaseExtensions.observed).toBe(true);
    expect(result.workerHeartbeat).toEqual({
      workerType: 'background',
      status: 'idle',
      currentJobIdPresent: false,
    });
    expect(result.foreignKeyViolations).toBe(0);
  });

  it('rejects pre-existing durable worker state before claiming jobs', async () => {
    new JobRepository(db).enqueue({
      type: 'retention',
      payload: { unrelated: true },
      idempotencyKey: 'unrelated-worker-state',
    });

    await expect(runWorkerSchedulerSoak({
      db,
      durationMs: 500,
      intervalMs: 20,
    })).rejects.toThrow('Worker soak requires empty durable worker tables');
  });

  it('reports producer persistence failures without contaminating durable state', async () => {
    db.exec(`
      CREATE TRIGGER fail_worker_soak_load_insert
      BEFORE INSERT ON jobs
      WHEN NEW.idempotency_key LIKE 'worker-soak:%:load:1'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic producer failure');
      END;
    `);

    const result = await runWorkerSchedulerSoak({
      db,
      durationMs: 500,
      intervalMs: 20,
    });

    expect(result.success).toBe(false);
    expect(result.schedulerErrors).toEqual({ producer: 1, consumer: 0, total: 1 });
    expect(result.isolation.clean).toBe(true);
    expect(result.jobs.pending).toBe(0);
    expect(result.jobs.running).toBe(0);
    expect(result.foreignKeyViolations).toBe(0);
  });
});
