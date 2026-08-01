import type Database from 'better-sqlite3';
import type { ToolHandlerRequest, ToolRegistryEntry } from '../../types/tool.js';

export interface RuntimeStatusLocalState {
  health: 'ok' | 'degraded';
  readiness: 'ready' | 'not_ready';
  database: 'ok' | 'unavailable';
  gateway: 'ready' | 'not_ready';
  pendingEvents: number;
  eventFailures: number;
}

export interface RuntimeStatusDependencies {
  database: Database.Database;
  readRuntimeState: () => RuntimeStatusLocalState;
}

interface RuntimeStatusCounts {
  pending_jobs: number;
  running_jobs: number;
  failed_jobs: number;
  idle_workers: number;
  running_workers: number;
  stopping_workers: number;
  error_workers: number;
}

interface RuntimeStatusActivity {
  pendingEvents: number | null;
  eventFailures: number | null;
  pendingJobs: number | null;
  runningJobs: number | null;
  failedJobs: number | null;
  idleWorkers: number | null;
  runningWorkers: number | null;
  stoppingWorkers: number | null;
  errorWorkers: number | null;
}

export interface RuntimeStatusOutput {
  status: 'ok' | 'degraded' | 'unavailable';
  readiness: 'ready' | 'not_ready' | 'unknown';
  database: 'ok' | 'unavailable' | 'unknown';
  gateway: 'ready' | 'not_ready' | 'unknown';
  activity: RuntimeStatusActivity;
  reason: 'runtime_status_unavailable' | null;
}

const UNAVAILABLE_ACTIVITY: RuntimeStatusActivity = {
  pendingEvents: null,
  eventFailures: null,
  pendingJobs: null,
  runningJobs: null,
  failedJobs: null,
  idleWorkers: null,
  runningWorkers: null,
  stoppingWorkers: null,
  errorWorkers: null,
};

export function createRuntimeStatusTool(
  dependencies: RuntimeStatusDependencies,
): ToolRegistryEntry {
  return {
    name: 'runtime.status',
    version: '1.0.0',
    description: 'Report bounded aggregate health and local work-queue status.',
    capabilities: ['read_local'],
    permissions: {
      allowedActors: ['owner', 'admin'],
      allowedContexts: ['private_chat'],
    },
    evaluatorPolicy: 'bypass',
    auditLevel: 'redacted_full',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 1000,
      maxOutputBytes: 4096,
    },
    outputSensitivity: 'normal',
    piSchema: {
      input: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded', 'unavailable'] },
          readiness: { type: 'string', enum: ['ready', 'not_ready', 'unknown'] },
          database: { type: 'string', enum: ['ok', 'unavailable', 'unknown'] },
          gateway: { type: 'string', enum: ['ready', 'not_ready', 'unknown'] },
          activity: {
            type: 'object',
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
            required: [
              'pendingEvents',
              'eventFailures',
              'pendingJobs',
              'runningJobs',
              'failedJobs',
              'idleWorkers',
              'runningWorkers',
              'stoppingWorkers',
              'errorWorkers',
            ],
            additionalProperties: false,
          },
          reason: { type: ['string', 'null'] },
        },
        required: ['status', 'readiness', 'database', 'gateway', 'activity', 'reason'],
        additionalProperties: false,
      },
    },
    handler: createRuntimeStatusHandler(dependencies),
  };
}

export function createRuntimeStatusHandler(
  dependencies: RuntimeStatusDependencies,
): ToolRegistryEntry['handler'] {
  return async (request: ToolHandlerRequest): Promise<RuntimeStatusOutput> => {
    assertEmptyInput(request.input);

    try {
      const local = dependencies.readRuntimeState();
      if (!isValidLocalState(local) || local.database !== 'ok') {
        return unavailableRuntimeStatus();
      }
      const counts = dependencies.database.prepare(
        `SELECT
           (SELECT COUNT(*) FROM jobs WHERE status = 'pending') AS pending_jobs,
           (SELECT COUNT(*) FROM jobs WHERE status = 'running') AS running_jobs,
           (SELECT COUNT(*) FROM jobs WHERE status = 'failed') AS failed_jobs,
           (SELECT COUNT(*) FROM worker_heartbeats WHERE status = 'idle') AS idle_workers,
           (SELECT COUNT(*) FROM worker_heartbeats WHERE status = 'running') AS running_workers,
           (SELECT COUNT(*) FROM worker_heartbeats WHERE status = 'stopping') AS stopping_workers,
           (SELECT COUNT(*) FROM worker_heartbeats WHERE status = 'error') AS error_workers`,
      ).get() as RuntimeStatusCounts;
      if (!Object.values(counts).every(isCount)) {
        return unavailableRuntimeStatus();
      }

      return {
        status: local.health,
        readiness: local.readiness,
        database: local.database,
        gateway: local.gateway,
        activity: {
          pendingEvents: local.pendingEvents,
          eventFailures: local.eventFailures,
          pendingJobs: counts.pending_jobs,
          runningJobs: counts.running_jobs,
          failedJobs: counts.failed_jobs,
          idleWorkers: counts.idle_workers,
          runningWorkers: counts.running_workers,
          stoppingWorkers: counts.stopping_workers,
          errorWorkers: counts.error_workers,
        },
        reason: null,
      };
    } catch {
      return unavailableRuntimeStatus();
    }
  };
}

function assertEmptyInput(input: unknown): void {
  if (
    typeof input !== 'object'
    || input === null
    || Array.isArray(input)
    || Object.keys(input).length !== 0
  ) {
    throw new Error('runtime.status input must be an empty object');
  }
}

function isValidLocalState(value: RuntimeStatusLocalState): boolean {
  return (value.health === 'ok' || value.health === 'degraded')
    && (value.readiness === 'ready' || value.readiness === 'not_ready')
    && (value.database === 'ok' || value.database === 'unavailable')
    && (value.gateway === 'ready' || value.gateway === 'not_ready')
    && isCount(value.pendingEvents)
    && isCount(value.eventFailures);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function unavailableRuntimeStatus(): RuntimeStatusOutput {
  return {
    status: 'unavailable',
    readiness: 'unknown',
    database: 'unknown',
    gateway: 'unknown',
    activity: { ...UNAVAILABLE_ACTIVITY },
    reason: 'runtime_status_unavailable',
  };
}
