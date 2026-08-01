import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, initDatabase, runMigrations } from '../../../src/storage/database';
import {
  createRuntimeStatusTool,
  type RuntimeStatusLocalState,
} from '../../../src/tools/builtins/runtime-status';
import { ToolRegistry } from '../../../src/tools/registry';
import type { ToolHandlerRequest } from '../../../src/types/tool';

const HEALTHY_STATE: RuntimeStatusLocalState = {
  health: 'ok',
  readiness: 'ready',
  database: 'ok',
  gateway: 'ready',
  pendingEvents: 2,
  eventFailures: 1,
};

describe('built-in runtime.status tool', () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-runtime-status-tool-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigrations(db, join(__dirname, '../../../migrations'));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('declares exact read-only metadata and private owner/admin permissions', () => {
    const entry = createRuntimeStatusTool({
      database: db,
      readRuntimeState: () => HEALTHY_STATE,
    });
    const registry = new ToolRegistry();
    registry.register(entry);

    expect(entry).toMatchObject({
      name: 'runtime.status',
      capabilities: ['read_local'],
      evaluatorPolicy: 'bypass',
      auditLevel: 'redacted_full',
      outputSensitivity: 'normal',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
        maxRuntimeMs: 1000,
        maxOutputBytes: 4096,
      },
      piSchema: {
        output: {
          properties: {
            activity: {
              properties: {
                pendingEvents: { type: ['number', 'null'] },
                eventFailures: { type: ['number', 'null'] },
                pendingJobs: { type: ['number', 'null'] },
                runningJobs: { type: ['number', 'null'] },
                failedJobs: { type: ['number', 'null'] },
                idleWorkers: { type: ['number', 'null'] },
                runningWorkers: { type: ['number', 'null'] },
                stoppingWorkers: { type: ['number', 'null'] },
                errorWorkers: { type: ['number', 'null'] },
              },
              additionalProperties: false,
            },
          },
        },
      },
    });
    expect(registry.checkPermission('runtime.status', { actorClass: 'owner' }, 'private_chat'))
      .toBe(true);
    expect(registry.checkPermission('runtime.status', { actorClass: 'admin' }, 'private_chat'))
      .toBe(true);
    expect(registry.checkPermission(
      'runtime.status',
      { actorClass: 'trusted_user' },
      'private_chat',
    )).toBe(false);
    expect(registry.checkPermission('runtime.status', { actorClass: 'user' }, 'private_chat'))
      .toBe(false);
    expect(registry.checkPermission('runtime.status', { actorClass: 'owner' }, 'group_chat'))
      .toBe(false);
  });

  it('returns only fixed aggregate state without writing local data', async () => {
    seedRuntimeRows(db);
    const readRuntimeState = vi.fn(() => ({
      ...HEALTHY_STATE,
      diagnostic: 'api_key=sk-runtime-status-secret-abcdefghijklmnopqrstuvwxyz qq-1234567890',
    }));
    const entry = createRuntimeStatusTool({ database: db, readRuntimeState });
    const beforeChanges = readTotalChanges(db);

    const output = await entry.handler(toolRequest({}));

    expect(output).toEqual({
      status: 'ok',
      readiness: 'ready',
      database: 'ok',
      gateway: 'ready',
      activity: {
        pendingEvents: 2,
        eventFailures: 1,
        pendingJobs: 1,
        runningJobs: 1,
        failedJobs: 1,
        idleWorkers: 1,
        runningWorkers: 1,
        stoppingWorkers: 1,
        errorWorkers: 1,
      },
      reason: null,
    });
    expect(JSON.stringify(output)).not.toContain('runtime-status-secret');
    expect(JSON.stringify(output)).not.toContain('1234567890');
    expect(readRuntimeState).toHaveBeenCalledTimes(1);
    expect(readTotalChanges(db)).toBe(beforeChanges);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('uses a fixed unavailable result without leaking reader diagnostics', async () => {
    const secret = 'api_key=sk-runtime-reader-secret-abcdefghijklmnopqrstuvwxyz qq-1234567890';
    const entry = createRuntimeStatusTool({
      database: db,
      readRuntimeState: () => {
        throw new Error(secret);
      },
    });
    const beforeChanges = readTotalChanges(db);

    const output = await entry.handler(toolRequest({}));

    expect(output).toEqual({
      status: 'unavailable',
      readiness: 'unknown',
      database: 'unknown',
      gateway: 'unknown',
      activity: {
        pendingEvents: null,
        eventFailures: null,
        pendingJobs: null,
        runningJobs: null,
        failedJobs: null,
        idleWorkers: null,
        runningWorkers: null,
        stoppingWorkers: null,
        errorWorkers: null,
      },
      reason: 'runtime_status_unavailable',
    });
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(readTotalChanges(db)).toBe(beforeChanges);
  });

  it('uses a fixed unavailable result without leaking database diagnostics', async () => {
    const secret = 'api_key=sk-runtime-database-secret-abcdefghijklmnopqrstuvwxyz qq-1234567890';
    const database = {
      prepare: () => {
        throw new Error(secret);
      },
    } as unknown as Database.Database;
    const entry = createRuntimeStatusTool({
      database,
      readRuntimeState: () => HEALTHY_STATE,
    });

    const output = await entry.handler(toolRequest({}));

    expect(output).toEqual({
      status: 'unavailable',
      readiness: 'unknown',
      database: 'unknown',
      gateway: 'unknown',
      activity: {
        pendingEvents: null,
        eventFailures: null,
        pendingJobs: null,
        runningJobs: null,
        failedJobs: null,
        idleWorkers: null,
        runningWorkers: null,
        stoppingWorkers: null,
        errorWorkers: null,
      },
      reason: 'runtime_status_unavailable',
    });
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it.each([null, [], '', { unexpected: true }])(
    'rejects non-empty-object input before reading runtime state: %j',
    async (input) => {
      const readRuntimeState = vi.fn(() => HEALTHY_STATE);
      const entry = createRuntimeStatusTool({ database: db, readRuntimeState });

      await expect(entry.handler(toolRequest(input)))
        .rejects.toThrow('runtime.status input must be an empty object');
      expect(readRuntimeState).not.toHaveBeenCalled();
    },
  );
});

function toolRequest(input: unknown): ToolHandlerRequest {
  return {
    toolCallId: 'tool-call-runtime-status',
    turnId: 'turn-runtime-status',
    toolName: 'runtime.status',
    signal: new AbortController().signal,
    input,
    actor: { actorClass: 'owner' },
    context: 'private_chat',
  };
}

function seedRuntimeRows(db: Database.Database): void {
  const insertJob = db.prepare(
    `INSERT INTO jobs (
       id, type, payload, status, attempts, max_attempts,
       created_at, updated_at, scheduled_at
     ) VALUES (?, 'retention', '{}', ?, 0, 1, ?, ?, ?)`,
  );
  const now = Date.now();
  insertJob.run('job-runtime-pending', 'pending', now, now, now);
  insertJob.run('job-runtime-running', 'running', now, now, now);
  insertJob.run('job-runtime-failed', 'failed', now, now, now);

  const insertWorker = db.prepare(
    `INSERT INTO worker_heartbeats (
       worker_id, worker_type, status, current_job_id, heartbeat_at, details
     ) VALUES (?, 'synthetic', ?, NULL, ?, NULL)`,
  );
  for (const status of ['idle', 'running', 'stopping', 'error']) {
    insertWorker.run(`worker-runtime-${status}`, status, now);
  }
}

function readTotalChanges(db: Database.Database): number {
  return db.prepare('SELECT total_changes()').pluck().get() as number;
}
