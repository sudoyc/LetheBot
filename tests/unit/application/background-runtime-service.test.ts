import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundRuntimeService } from '../../../src/application/background-runtime-service.js';
import { AttentionEngine } from '../../../src/attention/engine.js';
import { DelayedAttentionService } from '../../../src/attention/delayed-attention-service.js';
import { TurnAdmissionController } from '../../../src/pi/turn-admission-controller.js';
import { AuditRepository } from '../../../src/storage/audit-repository.js';
import { initDatabase, runMigrations } from '../../../src/storage/database.js';
import { GroupSummaryPolicyRepository } from '../../../src/storage/group-summary-policy-repository.js';
import { IdentityRepository } from '../../../src/storage/identity-repository.js';
import { JobRepository } from '../../../src/storage/job-repository.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';
import { MemoryExtractionWorker } from '../../../src/workers/memory-extraction.js';

describe('BackgroundRuntimeService', () => {
  let db: Database.Database;
  const services: BackgroundRuntimeService[] = [];

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    runMigrations(db, join(process.cwd(), 'migrations'));
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.stopAndDrain()));
    services.length = 0;
    db.close();
  });

  it('owns the exact maintenance and interactive durable worker lanes', () => {
    const { service, jobRepository } = createService(db, false);
    services.push(service);

    const maintenanceWorker = Reflect.get(service, 'backgroundWorker') as object;
    const interactiveWorker = Reflect.get(service, 'interactiveBackgroundWorker') as object;

    expect(Reflect.get(maintenanceWorker, 'jobRepository')).toBe(jobRepository);
    expect(Reflect.get(maintenanceWorker, 'workerId')).toBe('lethebot-background-main');
    expect(Reflect.get(maintenanceWorker, 'claimTypes')).toBeUndefined();
    expect(Reflect.get(maintenanceWorker, 'excludedClaimTypes')).toEqual(['attention_recheck']);
    expect(Reflect.get(interactiveWorker, 'jobRepository')).toBe(jobRepository);
    expect(Reflect.get(interactiveWorker, 'workerId')).toBe('lethebot-background-interactive');
    expect(Reflect.get(interactiveWorker, 'claimTypes')).toEqual(['attention_recheck']);
    expect(Reflect.get(interactiveWorker, 'excludedClaimTypes')).toBeUndefined();
  });

  it.each([
    { summaryEnabled: false, expectedCount: 7 },
    { summaryEnabled: true, expectedCount: 8 },
  ])(
    'registers the exact scheduler catalog when summaryEnabled=$summaryEnabled',
    ({ summaryEnabled, expectedCount }) => {
      const { service } = createService(db, summaryEnabled);
      services.push(service);

      service.registerJobs();

      const scheduler = Reflect.get(service, 'workerScheduler') as object;
      const jobs = Reflect.get(scheduler, 'jobs') as Map<string, unknown>;
      expect([...jobs.keys()]).toEqual([
        'durable-interactive-job-processor',
        'durable-background-job-processor',
        ...(summaryEnabled ? ['summary-discovery'] : []),
        'retention-maintenance',
        'admin-digest-maintenance',
        'memory-conflict-maintenance',
        'memory-decay-maintenance',
        'memory-consolidation-maintenance',
      ]);
      expect(jobs.size).toBe(expectedCount);
    },
  );

  it('rejects malformed retention task values without echoing payload contents', () => {
    const { service } = createService(db, false);
    services.push(service);
    const parse = Reflect.get(service, 'retentionPolicyFromPayload') as (
      payload: Record<string, unknown>,
    ) => Record<string, number | undefined>;

    expect(parse.call(service, {
      rawEventsDays: 0,
      chatMessagesDays: 90,
      auditLogDays: 365,
      disabledDeletedMemoryDays: 90,
      eventProcessingFailuresDays: 90,
    })).toEqual({
      rawEventsDays: 0,
      chatMessagesDays: 90,
      auditLogDays: 365,
      disabledDeletedMemoryDays: 90,
      eventProcessingFailuresDays: 90,
    });

    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, 'secret-retention-value']) {
      expect(() => parse.call(service, { rawEventsDays: invalid }))
        .toThrow('Background task retention requires nonnegative integer payload.rawEventsDays');
      try {
        parse.call(service, { rawEventsDays: invalid });
      } catch (error) {
        expect(String(error)).not.toContain(String(invalid));
      }
    }
  });
});

function createService(
  db: Database.Database,
  backgroundSummaryEnabled: boolean,
): {
  service: BackgroundRuntimeService;
  jobRepository: JobRepository;
} {
  const jobRepository = new JobRepository(db);
  const memoryRepository = new MemoryRepository(db);
  const identityRepository = new IdentityRepository(db);
  const auditRepository = new AuditRepository(db);
  const memoryExtractor = new MemoryExtractionWorker(db, memoryRepository);

  return {
    service: new BackgroundRuntimeService({
      db,
      jobRepository,
      memoryRepository,
      identityRepository,
      auditRepository,
      groupSummaryPolicyRepository: new GroupSummaryPolicyRepository(db),
      attentionEngine: new AttentionEngine(),
      delayedAttentionService: new DelayedAttentionService(db, jobRepository),
      turnAdmissionController: new TurnAdmissionController(1),
      test: true,
      backgroundSummaryEnabled,
      piProvider: 'mock',
      piModel: 'mock',
      piTurnTimeoutMs: 30_000,
      retentionPolicy: {},
      getPiRuntime: () => ({
        async runTurn(input) {
          return {
            turnId: input.turnId,
            responseText: '',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 0, output: 0, total: 0 },
            status: 'completed',
          };
        },
      }),
      getMemoryExtractor: () => memoryExtractor,
      handleConversationTurn: async () => 'completed',
    }),
    jobRepository,
  };
}
