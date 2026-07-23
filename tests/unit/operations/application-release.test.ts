import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateApplicationRelease,
  ApplicationRecoveryError,
  ApplicationReleaseError,
  confirmApplicationRelease,
  recoverInterruptedApplicationRelease,
  type ApplicationProbe,
  type ApplicationSupervisor,
} from '../../../src/operations/application-release.js';
import {
  closeDatabase,
  initDatabase,
  recordSchemaVersion,
  runMigration,
} from '../../../src/storage/database.js';
import { runManagedStartupGate } from '../../../src/operations/managed-startup.js';

interface ManagedReleaseFixture {
  baseDir: string;
  rootDir: string;
}

interface LifecycleBehavior {
  stop?: (call: number) => void | Promise<void>;
  start?: (call: number) => void | Promise<void>;
  probe?: (kind: 'health' | 'readiness', call: number) => void | Promise<void>;
}

interface ActivationStateRecord {
  schemaVersion: 1;
  operationId: string;
  operationKind: 'activation';
  candidateReleaseId: string;
  originalPointers: {
    current: string | null;
    previous: string | null;
  };
  targetPointers: {
    current: string;
    previous: string | null;
  };
}

const ACTIVATION_OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_OPERATION_ID = '22222222-2222-4222-8222-222222222222';

function currentLinuxProcessIdentity(): string {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const commandEnd = stat.lastIndexOf(')');
  const startTimeTicks = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
  return `linux:${bootId}:${startTimeTicks}`;
}

function currentProcessIdentity(): string {
  return process.platform === 'linux'
    ? currentLinuxProcessIdentity()
    : `pid:${process.pid}`;
}

function activationLockTempFixture(owner: {
  pid: number;
  processIdentity: string;
  nonce: string;
}): { name: string; content: string } {
  const content = `${JSON.stringify({ schemaVersion: 1, ...owner })}\n`;
  return {
    name: [
      '.activation-lock-v2.',
      owner.nonce,
      '.',
      owner.pid,
      '.',
      Buffer.from(owner.processIdentity, 'utf8').toString('base64url'),
      '.tmp',
    ].join(''),
    content,
  };
}

const schemaContract = {
  contractVersion: 1,
  targetVersion: 6,
  minReadableVersion: 1,
  maxReadableVersion: 6,
  adoptsLegacyUnversioned: true,
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeRelease(releaseDir: string): void {
  mkdirSync(join(releaseDir, 'dist'), { recursive: true });
  mkdirSync(join(releaseDir, 'migrations'), { recursive: true });
  mkdirSync(join(releaseDir, 'node_modules'), { recursive: true });
  writeFileSync(join(releaseDir, 'dist/index.js'), 'export {};\n', 'utf8');
  writeFileSync(join(releaseDir, 'migrations/001_initial_schema.sql'), 'SELECT 1;\n', 'utf8');
  writeFileSync(
    join(releaseDir, 'migrations/002_evaluator_authority_ownership.sql'),
    'SELECT 2;\n',
    'utf8',
  );
  writeFileSync(
    join(releaseDir, 'migrations/003_evaluator_model_invocations.sql'),
    'SELECT 3;\n',
    'utf8',
  );
  writeFileSync(
    join(releaseDir, 'migrations/004_evaluator_correction_attempts.sql'),
    'SELECT 4;\n',
    'utf8',
  );
  writeFileSync(
    join(releaseDir, 'migrations/005_delayed_attention.sql'),
    'SELECT 5;\n',
    'utf8',
  );
  writeFileSync(
    join(releaseDir, 'migrations/006_group_summary_policy.sql'),
    'SELECT 6;\n',
    'utf8',
  );
  writeFileSync(
    join(releaseDir, 'package.json'),
    `${JSON.stringify({
      packageManager: 'pnpm@9.0.0',
      lethebotSchema: schemaContract,
    })}\n`,
    'utf8',
  );
  writeFileSync(join(releaseDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
}

function createManagedReleaseFixture(includeCandidate = true): ManagedReleaseFixture {
  const baseDir = mkdtempSync(join(tmpdir(), 'lethebot-application-release-'));
  temporaryRoots.push(baseDir);

  const rootDir = join(baseDir, 'deployment');
  mkdirSync(join(rootDir, 'releases'), { recursive: true });
  mkdirSync(join(rootDir, 'shared', 'data'), { recursive: true });
  mkdirSync(join(rootDir, 'shared', 'logs'), { recursive: true });
  writeFileSync(join(rootDir, 'shared', 'runtime.env'), 'NODE_ENV=production\n', 'utf8');
  writeRelease(join(rootDir, 'releases', 'A'));
  if (includeCandidate) {
    writeRelease(join(rootDir, 'releases', 'B'));
  }
  symlinkSync('releases/A', join(rootDir, 'current'));

  return { baseDir, rootDir };
}

function createLifecycle(behavior: LifecycleBehavior = {}): {
  events: string[];
  supervisor: ApplicationSupervisor;
  probe: ApplicationProbe;
} {
  const events: string[] = [];
  let stopCalls = 0;
  let startCalls = 0;
  const probeCalls: Record<'health' | 'readiness', number> = {
    health: 0,
    readiness: 0,
  };

  const supervisor: ApplicationSupervisor = {
    async stop(): Promise<void> {
      stopCalls += 1;
      events.push('stop');
      await behavior.stop?.(stopCalls);
    },
    async start(input): Promise<void> {
      startCalls += 1;
      events.push('start');
      runManagedStartupGate({
        rootDir: input.rootDir,
        entrypointPath: join(input.rootDir, 'releases', input.releaseId, 'dist', 'index.js'),
      });
      await behavior.start?.(startCalls);
    },
  };
  const probe: ApplicationProbe = {
    async check(kind): Promise<void> {
      probeCalls[kind] += 1;
      events.push(`probe:${kind}`);
      await behavior.probe?.(kind, probeCalls[kind]);
    },
  };

  return { events, supervisor, probe };
}

function expectRelativeLink(rootDir: string, name: 'current' | 'previous', target: string): void {
  const path = join(rootDir, name);
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readlinkSync(path)).toBe(target);
}

function expectCleanRoot(rootDir: string, entries: string[]): void {
  expect(readdirSync(rootDir).sort()).toEqual(entries.sort());
}

function setManagedPointers(
  rootDir: string,
  currentReleaseId: string | null,
  previousReleaseId: string | null,
): void {
  for (const [pointer, releaseId] of [
    ['current', currentReleaseId],
    ['previous', previousReleaseId],
  ] as const) {
    rmSync(join(rootDir, pointer), { force: true });
    if (releaseId !== null) {
      symlinkSync(`releases/${releaseId}`, join(rootDir, pointer));
    }
  }
}

function seedActivationState(
  rootDir: string,
  options: {
    operationId?: string;
    candidateReleaseId?: string;
    originalCurrent?: string | null;
    originalPrevious?: string | null;
  } = {},
): ActivationStateRecord {
  const candidateReleaseId = options.candidateReleaseId ?? 'B';
  const originalCurrent = options.originalCurrent === undefined ? 'A' : options.originalCurrent;
  const originalPrevious = options.originalPrevious ?? null;
  const record: ActivationStateRecord = {
    schemaVersion: 1,
    operationId: options.operationId ?? ACTIVATION_OPERATION_ID,
    operationKind: 'activation',
    candidateReleaseId,
    originalPointers: {
      current: originalCurrent,
      previous: originalPrevious,
    },
    targetPointers: {
      current: candidateReleaseId,
      previous: originalCurrent,
    },
  };
  writeFileSync(
    join(rootDir, '.activation-state.json'),
    `${JSON.stringify(record)}\n`,
    'utf8',
  );
  return record;
}

function expectNoManagedPointers(rootDir: string): void {
  expect(existsSync(join(rootDir, 'current'))).toBe(false);
  expect(existsSync(join(rootDir, 'previous'))).toBe(false);
}

describe('application release activation', () => {
  it('publishes and starts a first release without inventing a previous pointer', async () => {
    const { rootDir } = createManagedReleaseFixture();
    rmSync(join(rootDir, 'current'));
    const { events, supervisor, probe } = createLifecycle();

    await activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe });

    expect(events).toEqual(['start', 'probe:health', 'probe:readiness']);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expectCleanRoot(rootDir, [
      '.activation-state.json',
      '.release-rollback',
      'current',
      'releases',
      'shared',
    ]);
  });

  it('activates A to B in lifecycle order with atomic managed pointers and cleanup', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle();

    await activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe });

    expect(events).toEqual(['stop', 'start', 'probe:health', 'probe:readiness']);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expectRelativeLink(rootDir, 'previous', 'releases/A');
    expectCleanRoot(rootDir, [
      '.activation-state.json',
      '.release-rollback',
      'current',
      'previous',
      'releases',
      'shared',
    ]);
  });

  it('retains rollback state until explicit confirmation and blocks another activation', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle();

    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    });
    expect(activation).toMatchObject({
      releaseId: 'B',
      confirmationRequired: true,
    });
    expect(activation.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const state = JSON.parse(
      readFileSync(join(rootDir, '.activation-state.json'), 'utf8'),
    ) as { schemaVersion: number; phase: string };
    expect(state).toMatchObject({ schemaVersion: 2, phase: 'awaiting_confirmation' });
    expect(lstatSync(join(rootDir, '.release-rollback')).mode & 0o777).toBe(0o700);

    events.length = 0;
    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'confirmation-required' });
    expect(events).toEqual([]);

    await expect(confirmApplicationRelease({
      rootDir,
      releaseId: activation.releaseId,
      operationId: activation.operationId,
      supervisor,
      probe,
    })).resolves.toEqual({
      confirmed: true,
      releaseId: 'B',
    });
    expect(events).toEqual(['probe:health', 'probe:readiness']);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expectRelativeLink(rootDir, 'previous', 'releases/A');
    expectCleanRoot(rootDir, ['current', 'previous', 'releases', 'shared']);
  });

  it('discards a valid interrupted confirmation transition and confirms idempotently', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle();
    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    });
    const state = JSON.parse(
      readFileSync(join(rootDir, '.activation-state.json'), 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      join(rootDir, '.activation-state.tmp'),
      `${JSON.stringify({ ...state, phase: 'confirming' })}\n`,
      'utf8',
    );

    events.length = 0;
    await expect(confirmApplicationRelease({
      rootDir,
      releaseId: activation.releaseId,
      operationId: activation.operationId,
      supervisor,
      probe,
    })).resolves.toMatchObject({ confirmed: true, releaseId: 'B' });

    expect(events).toEqual(['probe:health', 'probe:readiness']);
    expectCleanRoot(rootDir, ['current', 'previous', 'releases', 'shared']);
  });

  it('restarts through the gate when confirmation cleanup was interrupted', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const activationLifecycle = createLifecycle();
    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor: activationLifecycle.supervisor,
      probe: activationLifecycle.probe,
    });
    const statePath = join(rootDir, '.activation-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(statePath, `${JSON.stringify({ ...state, phase: 'confirming' })}\n`, 'utf8');
    const resumed = createLifecycle();

    await expect(confirmApplicationRelease({
      rootDir,
      releaseId: activation.releaseId,
      operationId: activation.operationId,
      supervisor: resumed.supervisor,
      probe: resumed.probe,
    })).resolves.toEqual({ confirmed: true, releaseId: 'B' });

    expect(resumed.events).toEqual(['stop', 'start', 'probe:health', 'probe:readiness']);
    expectCleanRoot(rootDir, ['current', 'previous', 'releases', 'shared']);
  });

  it('fails closed on an activation temp that is not a valid state successor', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle();
    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    });
    const state = JSON.parse(
      readFileSync(join(rootDir, '.activation-state.json'), 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      join(rootDir, '.activation-state.tmp'),
      `${JSON.stringify({
        ...state,
        phase: 'confirming',
        candidateDigest: '0'.repeat(64),
      })}\n`,
      'utf8',
    );

    events.length = 0;
    await expect(confirmApplicationRelease({
      rootDir,
      releaseId: activation.releaseId,
      operationId: activation.operationId,
      supervisor,
      probe,
    })).rejects.toMatchObject({ code: 'invalid-recovery-state' });

    expect(events).toEqual([]);
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(true);
    expect(existsSync(join(rootDir, '.activation-state.tmp'))).toBe(true);
  });

  it('binds confirmation to the exact activation operation without probing a mismatch', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle();
    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    });
    events.length = 0;

    await expect(confirmApplicationRelease({
      rootDir,
      releaseId: 'B',
      operationId: FOREIGN_OPERATION_ID,
      supervisor,
      probe,
    })).rejects.toMatchObject({ code: 'confirmation-required' });

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(true);
    await expect(confirmApplicationRelease({
      rootDir,
      releaseId: activation.releaseId,
      operationId: activation.operationId,
      supervisor,
      probe,
    })).resolves.toMatchObject({ confirmed: true, releaseId: 'B' });
  });

  it('refuses to confirm candidate bytes changed after activation', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle();
    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    });
    events.length = 0;
    writeFileSync(
      join(rootDir, 'releases', 'B', 'dist', 'late-change.js'),
      'export const changed = true;\n',
      'utf8',
    );

    await expect(confirmApplicationRelease({
      rootDir,
      releaseId: activation.releaseId,
      operationId: activation.operationId,
      supervisor,
      probe,
    })).rejects.toMatchObject({ code: 'invalid-candidate' });

    expect(events).toEqual([]);
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(true);
    expectRelativeLink(rootDir, 'current', 'releases/B');
  });

  it('rejects a dangling shared database instead of recording an absent snapshot', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const databasePath = join(rootDir, 'shared', 'data', 'lethebot.db');
    symlinkSync('missing-database', databasePath);
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'invalid-layout' });

    expect(events).toEqual([]);
    expect(lstatSync(databasePath).isSymbolicLink()).toBe(true);
    expectRelativeLink(rootDir, 'current', 'releases/A');
  });

  it('removes a stopped rollback journal before restoring the prior database', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const databasePath = join(rootDir, 'shared', 'data', 'lethebot.db');
    const db = initDatabase({ path: databasePath });
    try {
      runMigration(db, join(process.cwd(), 'migrations/001_initial_schema.sql'));
    } finally {
      closeDatabase(db);
    }
    const journalPath = `${databasePath}-journal`;
    const { supervisor, probe } = createLifecycle({
      start: (call) => {
        if (call === 1) {
          writeFileSync(journalPath, 'synthetic stopped journal', 'utf8');
        }
      },
      probe: (kind, call) => {
        if (kind === 'readiness' && call === 1) {
          throw new Error('synthetic candidate readiness failure');
        }
      },
    });

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'activation-failed' });

    expect(existsSync(journalPath)).toBe(false);
    expectRelativeLink(rootDir, 'current', 'releases/A');
  });

  it('rejects a candidate missing a preflight artifact without lifecycle or pointer changes', async () => {
    const { rootDir } = createManagedReleaseFixture();
    unlinkSync(join(rootDir, 'releases', 'B', 'dist', 'index.js'));
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toBeInstanceOf(ApplicationReleaseError);

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('reports existing-file metadata failures through release preflight diagnostics', async () => {
    const { rootDir } = createManagedReleaseFixture();
    writeFileSync(join(rootDir, 'releases', 'B', 'package.json'), '{"packageManager":', 'utf8');
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({
      code: 'preflight-failed',
      diagnostics: ['unloadable-dist-entrypoint', 'invalid-package-json'],
    });

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
  });

  it('rejects a future shared schema before lifecycle or pointer changes', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const dbPath = join(rootDir, 'shared', 'data', 'lethebot.db');
    const db = initDatabase({ path: dbPath });
    try {
      runMigration(db, join(process.cwd(), 'migrations/001_initial_schema.sql'));
      recordSchemaVersion(db, 2, 'Current schema');
      recordSchemaVersion(db, 3, 'Current evaluator invocation schema');
      recordSchemaVersion(db, 4, 'Current correction-attempt schema');
      recordSchemaVersion(db, 5, 'Current delayed-attention schema');
      recordSchemaVersion(db, 6, 'Current group-summary-policy schema');
      recordSchemaVersion(db, 7, 'Future schema');
      db.exec(`
        CREATE TABLE release_guard_sentinel (value TEXT NOT NULL);
        INSERT INTO release_guard_sentinel (value) VALUES ('preserved');
      `);
    } finally {
      closeDatabase(db);
    }
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'schema-incompatible' });

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(false);
    const unchanged = initDatabase({ path: dbPath, readonly: true });
    try {
      expect(unchanged.prepare('SELECT version FROM schema_version ORDER BY version').all())
        .toEqual([
          { version: 1 },
          { version: 2 },
          { version: 3 },
          { version: 4 },
          { version: 5 },
          { version: 6 },
          { version: 7 },
        ]);
      expect(unchanged.prepare('SELECT value FROM release_guard_sentinel').get())
        .toEqual({ value: 'preserved' });
    } finally {
      closeDatabase(unchanged);
    }
  });

  it('rejects a traversal release id even when it resolves to a valid release', async () => {
    const { baseDir, rootDir } = createManagedReleaseFixture(false);
    writeRelease(join(baseDir, 'outside'));
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      activateApplicationRelease({
        rootDir,
        releaseId: '../../outside',
        supervisor,
        probe,
      }),
    ).rejects.toBeInstanceOf(ApplicationReleaseError);

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('classifies a malformed managed current pointer as invalid layout', async () => {
    const { rootDir } = createManagedReleaseFixture();
    unlinkSync(join(rootDir, 'current'));
    symlinkSync('releases/../A', join(rootDir, 'current'));
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'invalid-layout' });

    expect(events).toEqual([]);
    expect(readlinkSync(join(rootDir, 'current'))).toBe('releases/../A');
    expect(existsSync(join(rootDir, '.activation.lock'))).toBe(false);
  });

  it('rejects a candidate symlink that escapes the managed releases directory', async () => {
    const { baseDir, rootDir } = createManagedReleaseFixture(false);
    writeRelease(join(baseDir, 'outside'));
    symlinkSync('../../outside', join(rootDir, 'releases', 'B'));
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toBeInstanceOf(ApplicationReleaseError);

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('rejects a candidate artifact directory symlink that escapes the release', async () => {
    const { baseDir, rootDir } = createManagedReleaseFixture();
    const outsideDist = join(baseDir, 'outside-dist');
    mkdirSync(outsideDist);
    writeFileSync(join(outsideDist, 'index.js'), 'export {};\n', 'utf8');
    rmSync(join(rootDir, 'releases', 'B', 'dist'), { recursive: true });
    symlinkSync('../../../outside-dist', join(rootDir, 'releases', 'B', 'dist'));
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toBeInstanceOf(ApplicationReleaseError);

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('rejects a runtime dependency link that escapes the dependency tree', async () => {
    const { baseDir, rootDir } = createManagedReleaseFixture();
    const outsideDependency = join(baseDir, 'outside-dependency.js');
    writeFileSync(outsideDependency, 'export {};\n', 'utf8');
    symlinkSync(
      '../../../../outside-dependency.js',
      join(rootDir, 'releases', 'B', 'node_modules', 'outside.js'),
    );
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'invalid-candidate' });

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('times out on an existing activation lock without touching lifecycle or pointers', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const lockPath = join(rootDir, '.activation.lock');
    mkdirSync(lockPath);
    const { events, supervisor, probe } = createLifecycle();
    const startedAt = Date.now();

    await expect(
      activateApplicationRelease({
        rootDir,
        releaseId: 'B',
        supervisor,
        probe,
        lockTimeoutMs: 20,
        lockRetryMs: 1,
      }),
    ).rejects.toBeInstanceOf(ApplicationReleaseError);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
    expectCleanRoot(rootDir, ['.activation.lock', 'current', 'releases', 'shared']);
  });

  it('reclaims an activation lock whose recorded process no longer exists', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const lockPath = join(rootDir, '.activation.lock');
    writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      processIdentity: 'linux:stale:1',
      nonce: ACTIVATION_OPERATION_ID,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    const { supervisor, probe } = createLifecycle();

    await expect(activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
      lockTimeoutMs: 100,
      lockRetryMs: 1,
    })).resolves.toMatchObject({ releaseId: 'B', confirmationRequired: true });

    expect(existsSync(lockPath)).toBe(false);
    expectRelativeLink(rootDir, 'current', 'releases/B');
  });

  it.skipIf(process.platform !== 'linux')(
    'reclaims an activation lock after PID identity reuse',
    async () => {
      const { rootDir } = createManagedReleaseFixture();
      const lockPath = join(rootDir, '.activation.lock');
      writeFileSync(lockPath, `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        processIdentity: 'linux:stale-boot:1',
        nonce: ACTIVATION_OPERATION_ID,
      })}\n`, { encoding: 'utf8', mode: 0o600 });
      const { supervisor, probe } = createLifecycle();

      await expect(activateApplicationRelease({
        rootDir,
        releaseId: 'B',
        supervisor,
        probe,
      })).resolves.toMatchObject({ releaseId: 'B' });

      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'does not reclaim a lock owned by the live process identity',
    async () => {
      const { rootDir } = createManagedReleaseFixture();
      const lockPath = join(rootDir, '.activation.lock');
      writeFileSync(lockPath, `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        processIdentity: currentLinuxProcessIdentity(),
        nonce: ACTIVATION_OPERATION_ID,
      })}\n`, { encoding: 'utf8', mode: 0o600 });
      const { events, supervisor, probe } = createLifecycle();

      await expect(activateApplicationRelease({
        rootDir,
        releaseId: 'B',
        supervisor,
        probe,
        lockTimeoutMs: 20,
        lockRetryMs: 1,
      })).rejects.toMatchObject({ code: 'activation-locked' });

      expect(events).toEqual([]);
      expect(existsSync(lockPath)).toBe(true);
    },
  );

  it('removes a stale activation-lock candidate before acquiring the lock', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const temporaryLock = join(
      rootDir,
      `.activation-lock-${ACTIVATION_OPERATION_ID}.tmp`,
    );
    writeFileSync(temporaryLock, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      processIdentity: 'linux:stale:1',
      nonce: ACTIVATION_OPERATION_ID,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    const { supervisor, probe } = createLifecycle();

    await expect(activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    })).resolves.toMatchObject({ releaseId: 'B' });

    expect(existsSync(temporaryLock)).toBe(false);
    expect(existsSync(join(rootDir, '.activation.lock'))).toBe(false);
  });

  it('preserves a partial legacy activation-lock candidate for operator review', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const temporaryLock = join(
      rootDir,
      `.activation-lock-${ACTIVATION_OPERATION_ID}.tmp`,
    );
    writeFileSync(temporaryLock, '{"schemaVersion":', { mode: 0o600 });
    const { supervisor, probe } = createLifecycle();

    await expect(activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    })).rejects.toMatchObject({ code: 'activation-locked' });

    expect(existsSync(temporaryLock)).toBe(true);
  });

  it('preserves a live zero-byte v2 activation-lock candidate without blocking acquisition', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const fixture = activationLockTempFixture({
      pid: process.pid,
      processIdentity: currentProcessIdentity(),
      nonce: ACTIVATION_OPERATION_ID,
    });
    const temporaryLock = join(rootDir, fixture.name);
    writeFileSync(temporaryLock, '', { mode: 0o600 });
    const { supervisor, probe } = createLifecycle();

    await expect(activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    })).resolves.toMatchObject({ releaseId: 'B' });

    expect(existsSync(temporaryLock)).toBe(true);
    expect(existsSync(join(rootDir, '.activation.lock'))).toBe(false);
  });

  it('reclaims a partial v2 activation-lock candidate whose process is absent', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const fixture = activationLockTempFixture({
      pid: 2_147_483_647,
      processIdentity: 'linux:stale:1',
      nonce: ACTIVATION_OPERATION_ID,
    });
    const temporaryLock = join(rootDir, fixture.name);
    writeFileSync(temporaryLock, fixture.content.slice(0, 24), { mode: 0o600 });
    const { supervisor, probe } = createLifecycle();

    await expect(activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    })).resolves.toMatchObject({ releaseId: 'B' });

    expect(existsSync(temporaryLock)).toBe(false);
  });

  it('reclaims a partial v2 activation-lock candidate after PID identity reuse', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const fixture = activationLockTempFixture({
      pid: process.pid,
      processIdentity: 'linux:stale-boot:1',
      nonce: ACTIVATION_OPERATION_ID,
    });
    const temporaryLock = join(rootDir, fixture.name);
    writeFileSync(temporaryLock, fixture.content.slice(0, 32), { mode: 0o600 });
    const { supervisor, probe } = createLifecycle();

    await expect(activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    })).resolves.toMatchObject({ releaseId: 'B' });

    expect(existsSync(temporaryLock)).toBe(false);
  });

  it('preserves and rejects v2 activation-lock metadata that disagrees with its owner name', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const fixture = activationLockTempFixture({
      pid: 2_147_483_647,
      processIdentity: 'linux:stale:1',
      nonce: ACTIVATION_OPERATION_ID,
    });
    const temporaryLock = join(rootDir, fixture.name);
    const foreign = activationLockTempFixture({
      pid: 2_147_483_647,
      processIdentity: 'linux:stale:1',
      nonce: FOREIGN_OPERATION_ID,
    });
    writeFileSync(temporaryLock, foreign.content, { mode: 0o600 });
    const { events, supervisor, probe } = createLifecycle();

    await expect(activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    })).rejects.toMatchObject({ code: 'activation-locked' });

    expect(events).toEqual([]);
    expect(readFileSync(temporaryLock, 'utf8')).toBe(foreign.content);
  });

  it('reclaims a stale activation-lock quarantine left after rename', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const quarantine = join(
      rootDir,
      `.activation-lock-quarantine-${ACTIVATION_OPERATION_ID}`,
    );
    writeFileSync(quarantine, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      processIdentity: 'linux:stale:1',
      nonce: ACTIVATION_OPERATION_ID,
    })}\n`, { mode: 0o600 });
    const { supervisor, probe } = createLifecycle();

    await expect(activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
    })).resolves.toMatchObject({ releaseId: 'B' });

    expect(existsSync(quarantine)).toBe(false);
  });

  it('preserves ambiguous activation-lock quarantine state', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const quarantine = join(
      rootDir,
      `.activation-lock-quarantine-${ACTIVATION_OPERATION_ID}`,
    );
    writeFileSync(quarantine, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      processIdentity: 'linux:stale:1',
      nonce: ACTIVATION_OPERATION_ID,
    })}\n`, { mode: 0o600 });
    mkdirSync(join(rootDir, '.activation.lock'));
    const { events, supervisor, probe } = createLifecycle();

    await expect(activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
      lockTimeoutMs: 20,
      lockRetryMs: 1,
    })).rejects.toMatchObject({ code: 'activation-locked' });

    expect(events).toEqual([]);
    expect(existsSync(quarantine)).toBe(true);
    expect(lstatSync(join(rootDir, '.activation.lock')).isDirectory()).toBe(true);
  });

  it('revalidates candidate identity after waiting for the activation lock', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const lockPath = join(rootDir, '.activation.lock');
    mkdirSync(lockPath);
    const { events, supervisor, probe } = createLifecycle();

    const activation = activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor,
      probe,
      lockTimeoutMs: 500,
      lockRetryMs: 1,
    });
    const candidateDir = join(rootDir, 'releases', 'B');
    renameSync(candidateDir, join(rootDir, 'releases', 'B-replaced'));
    writeRelease(candidateDir);
    rmSync(lockPath, { recursive: true });

    await expect(activation).rejects.toBeInstanceOf(ApplicationReleaseError);

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('retains recovery state and cleans its lock when stopping the prior release fails', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle({
      stop: () => {
        throw new Error('synthetic stop failure');
      },
    });

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toBeInstanceOf(ApplicationReleaseError);

    expect(events).toEqual(['stop']);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expect(lstatSync(join(rootDir, '.activation-state.json')).mode & 0o777).toBe(0o600);
    expectCleanRoot(rootDir, [
      '.activation-state.json',
      'current',
      'releases',
      'shared',
    ]);
  });

  it('revalidates the candidate after stopping and restarts the untouched prior release', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const importedRuntimePath = join(rootDir, 'releases', 'B', 'dist', 'worker.js');
    writeFileSync(importedRuntimePath, 'export const version = "before";\n', 'utf8');
    const { events, supervisor, probe } = createLifecycle({
      stop: (call) => {
        if (call !== 1) {
          return;
        }
        writeFileSync(importedRuntimePath, 'export const version = "after";\n', 'utf8');
      },
    });

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'invalid-candidate' });

    expect(events).toEqual(['stop', 'start', 'probe:health', 'probe:readiness']);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('rolls readiness failure back to A with exact lifecycle order and cleanup', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle({
      probe: (kind, call) => {
        if (kind === 'readiness' && call === 1) {
          throw new Error('synthetic candidate readiness failure');
        }
      },
    });

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'activation-failed' });

    expect(events).toEqual([
      'stop',
      'start',
      'probe:health',
      'probe:readiness',
      'stop',
      'start',
      'probe:health',
      'probe:readiness',
    ]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('restores a candidate-mutated database before restarting the prior release', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const databasePath = join(rootDir, 'shared', 'data', 'lethebot.db');
    const initial = initDatabase({ path: databasePath });
    try {
      runMigration(initial, join(process.cwd(), 'migrations/001_initial_schema.sql'));
      initial.exec(`
        CREATE TABLE release_rollback_sentinel (value TEXT NOT NULL);
        INSERT INTO release_rollback_sentinel (value) VALUES ('before');
      `);
    } finally {
      closeDatabase(initial);
    }
    chmodSync(databasePath, 0o640);

    let priorObservedRestoredDatabase = false;
    const { events, supervisor, probe } = createLifecycle({
      start: (call) => {
        if (call === 1) {
          const candidate = initDatabase({ path: databasePath });
          try {
            recordSchemaVersion(candidate, 2, 'Synthetic candidate schema');
            candidate.exec(`
              UPDATE release_rollback_sentinel SET value = 'candidate-mutated';
              CREATE TABLE candidate_only_table (value TEXT NOT NULL);
            `);
          } finally {
            closeDatabase(candidate);
          }
          return;
        }

        const prior = initDatabase({ path: databasePath, readonly: true });
        try {
          expect(lstatSync(databasePath).mode & 0o777).toBe(0o640);
          expect(prior.prepare('SELECT version FROM schema_version ORDER BY version').all())
            .toEqual([{ version: 1 }]);
          expect(prior.prepare('SELECT value FROM release_rollback_sentinel').get())
            .toEqual({ value: 'before' });
          expect(prior.prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'candidate_only_table'",
          ).get()).toEqual({ count: 0 });
          priorObservedRestoredDatabase = true;
        } finally {
          closeDatabase(prior);
        }
      },
      probe: (kind, call) => {
        if (kind === 'readiness' && call === 1) {
          throw new Error('synthetic candidate readiness failure');
        }
      },
    });

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'activation-failed' });

    expect(priorObservedRestoredDatabase).toBe(true);
    expect(events).toEqual([
      'stop',
      'start',
      'probe:health',
      'probe:readiness',
      'stop',
      'start',
      'probe:health',
      'probe:readiness',
    ]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('restores the original previous pointer when candidate readiness fails', async () => {
    const { rootDir } = createManagedReleaseFixture();
    writeRelease(join(rootDir, 'releases', 'C'));
    symlinkSync('releases/C', join(rootDir, 'previous'));
    const { supervisor, probe } = createLifecycle({
      probe: (kind, call) => {
        if (kind === 'readiness' && call === 1) {
          throw new Error('synthetic candidate readiness failure');
        }
      },
    });

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({ code: 'activation-failed' });

    expectRelativeLink(rootDir, 'current', 'releases/A');
    expectRelativeLink(rootDir, 'previous', 'releases/C');
    expectCleanRoot(rootDir, ['current', 'previous', 'releases', 'shared']);
  });

  it('does not restart the prior release when the failed candidate cannot be stopped', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle({
      stop: (call) => {
        if (call === 2) {
          throw new Error('synthetic candidate stop failure');
        }
      },
      probe: (kind, call) => {
        if (kind === 'readiness' && call === 1) {
          throw new Error('synthetic candidate readiness failure');
        }
      },
    });

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({
      code: 'rollback-failed',
      rollbackFailures: ['stop-candidate'],
    });

    expect(events).toEqual([
      'stop',
      'start',
      'probe:health',
      'probe:readiness',
      'stop',
    ]);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expectRelativeLink(rootDir, 'previous', 'releases/A');
    expectCleanRoot(rootDir, [
      '.activation-state.json',
      '.release-rollback',
      'current',
      'previous',
      'releases',
      'shared',
    ]);
  });

  it('preserves a replacement lock and reports cleanup failure separately', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const lockPath = join(rootDir, '.activation.lock');
    const { events, supervisor, probe } = createLifecycle({
      probe: (kind, call) => {
        if (kind !== 'readiness' || call !== 1) {
          return;
        }
        rmSync(lockPath, { recursive: true });
        mkdirSync(lockPath);
      },
    });

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({
      code: 'cleanup-failed',
      operationError: undefined,
    });

    expect(events).toEqual(['stop', 'start', 'probe:health', 'probe:readiness']);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expectRelativeLink(rootDir, 'previous', 'releases/A');
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
    expectCleanRoot(rootDir, [
      '.activation-state.json',
      '.activation.lock',
      '.release-rollback',
      'current',
      'previous',
      'releases',
      'shared',
    ]);
  });

  it('preserves rollback and cleanup phases when both fail', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const lockPath = join(rootDir, '.activation.lock');
    const { events, supervisor, probe } = createLifecycle({
      stop: (call) => {
        if (call !== 2) {
          return;
        }
        rmSync(lockPath, { recursive: true });
        mkdirSync(lockPath);
      },
      start: (call) => {
        if (call === 2) {
          throw new Error('synthetic rollback restart failure');
        }
      },
      probe: (kind, call) => {
        if (kind === 'readiness' && call === 1) {
          throw new Error('synthetic candidate readiness failure');
        }
      },
    });

    await expect(
      activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
    ).rejects.toMatchObject({
      code: 'cleanup-failed',
      operationCode: 'rollback-failed',
      rollbackFailures: ['restart-previous'],
    });

    expect(events).toEqual([
      'stop',
      'start',
      'probe:health',
      'probe:readiness',
      'stop',
      'start',
    ]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(true);
  });

  it.each(['restart', 'probe'] as const)(
    'reports rollback %s failure explicitly and retains recovery state',
    async (failure) => {
      const { rootDir } = createManagedReleaseFixture();
      const { events, supervisor, probe } = createLifecycle({
        start: (call) => {
          if (failure === 'restart' && call === 2) {
            throw new Error('synthetic rollback restart failure');
          }
        },
        probe: (kind, call) => {
          if (kind === 'readiness' && call === 1) {
            throw new Error('synthetic candidate readiness failure');
          }
          if (failure === 'probe' && kind === 'health' && call === 2) {
            throw new Error('synthetic rollback probe failure');
          }
        },
      });

      await expect(
        activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
      ).rejects.toMatchObject({
        code: 'rollback-failed',
        rollbackFailures: [
          failure === 'restart' ? 'restart-previous' : 'probe-previous-health',
        ],
      });

      expect(events).toEqual(
        failure === 'restart'
          ? ['stop', 'start', 'probe:health', 'probe:readiness', 'stop', 'start']
          : [
              'stop',
              'start',
              'probe:health',
              'probe:readiness',
              'stop',
              'start',
              'probe:health',
            ],
      );
      expectRelativeLink(rootDir, 'current', 'releases/A');
      expect(existsSync(join(rootDir, 'previous'))).toBe(false);
      expectCleanRoot(rootDir, [
        '.activation-state.json',
        '.release-rollback',
        '.startup-authorization.claimed',
        'current',
        'releases',
        'shared',
      ]);
    },
  );
});

describe('application release crash recovery', () => {
  it('discards a partial unpublished initial intent before marker-free recovery', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const temporaryPath = join(rootDir, '.activation-state.tmp');
    writeFileSync(temporaryPath, '{"schemaVersion":2,', { mode: 0o600 });
    const { events, supervisor, probe } = createLifecycle();

    await expect(recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }))
      .resolves.toEqual({ recovered: false, restarted: false });

    expect(events).toEqual([]);
    expect(existsSync(temporaryPath)).toBe(false);
    expectRelativeLink(rootDir, 'current', 'releases/A');
  });

  it('preserves a partial initial intent paired with an unexplained artifact', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const temporaryPath = join(rootDir, '.activation-state.tmp');
    writeFileSync(temporaryPath, '{"schemaVersion":2,', { mode: 0o600 });
    mkdirSync(join(rootDir, '.release-rollback'));
    writeFileSync(join(rootDir, '.release-rollback', 'foreign.db'), 'foreign', 'utf8');
    const { events, supervisor, probe } = createLifecycle();

    await expect(recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }))
      .rejects.toMatchObject({ code: 'invalid-recovery-state' });

    expect(events).toEqual([]);
    expect(existsSync(temporaryPath)).toBe(true);
  });

  it('replays the canonical state after a partial successor write', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const activation = createLifecycle();
    await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor: activation.supervisor,
      probe: activation.probe,
    });
    const temporaryPath = join(rootDir, '.activation-state.tmp');
    writeFileSync(temporaryPath, '{"schemaVersion":2,', { mode: 0o600 });
    const recovery = createLifecycle();

    await expect(recoverInterruptedApplicationRelease({
      rootDir,
      supervisor: recovery.supervisor,
      probe: recovery.probe,
    })).resolves.toEqual({ recovered: true, restarted: true });

    expect(existsSync(temporaryPath)).toBe(false);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('restarts the prior release before clearing a completed rollback state', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const activationLifecycle = createLifecycle();
    await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor: activationLifecycle.supervisor,
      probe: activationLifecycle.probe,
    });
    const statePath = join(rootDir, '.activation-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(statePath, `${JSON.stringify({ ...state, phase: 'rollback_completed' })}\n`);
    setManagedPointers(rootDir, 'A', null);
    const recovery = createLifecycle();

    await expect(recoverInterruptedApplicationRelease({
      rootDir,
      supervisor: recovery.supervisor,
      probe: recovery.probe,
    })).resolves.toEqual({ recovered: true, restarted: true });

    expect(recovery.events).toEqual(['stop', 'start', 'probe:health', 'probe:readiness']);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('refuses recovery through a prior release changed after activation', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const activationLifecycle = createLifecycle();
    await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor: activationLifecycle.supervisor,
      probe: activationLifecycle.probe,
    });
    writeFileSync(
      join(rootDir, 'releases', 'A', 'dist', 'late-change.js'),
      'export const changed = true;\n',
      'utf8',
    );
    const recovery = createLifecycle();

    await expect(recoverInterruptedApplicationRelease({
      rootDir,
      supervisor: recovery.supervisor,
      probe: recovery.probe,
    })).rejects.toMatchObject({ code: 'invalid-recovery-state' });

    expect(recovery.events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(true);
  });

  it('discards an unpublished initial intent temp before a marker-free recovery', async () => {
    const { rootDir } = createManagedReleaseFixture();
    seedActivationState(rootDir);
    renameSync(
      join(rootDir, '.activation-state.json'),
      join(rootDir, '.activation-state.tmp'),
    );
    const { events, supervisor, probe } = createLifecycle();

    await expect(recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }))
      .resolves.toEqual({ recovered: false, restarted: false });

    expect(events).toEqual([]);
    expect(existsSync(join(rootDir, '.activation-state.tmp'))).toBe(false);
    expectRelativeLink(rootDir, 'current', 'releases/A');
  });

  it('removes an operation-owned interrupted restore candidate before retrying rollback', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const lifecycle = createLifecycle();
    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor: lifecycle.supervisor,
      probe: lifecycle.probe,
    });
    const restoreCandidate = join(
      rootDir,
      'shared',
      'data',
      `.release-restore-${activation.operationId}.db`,
    );
    writeFileSync(restoreCandidate, 'interrupted-copy', 'utf8');
    const recovery = createLifecycle();

    await expect(recoverInterruptedApplicationRelease({
      rootDir,
      supervisor: recovery.supervisor,
      probe: recovery.probe,
    })).resolves.toEqual({ recovered: true, restarted: true });

    expect(existsSync(restoreCandidate)).toBe(false);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(false);
  });

  it('replaces a partial restore candidate from an existing database snapshot', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const databasePath = join(rootDir, 'shared', 'data', 'lethebot.db');
    const initial = initDatabase({ path: databasePath });
    try {
      runMigration(initial, join(process.cwd(), 'migrations/001_initial_schema.sql'));
      initial.exec(`
        CREATE TABLE release_restore_sentinel (value TEXT NOT NULL);
        INSERT INTO release_restore_sentinel (value) VALUES ('before');
      `);
    } finally {
      closeDatabase(initial);
    }
    const activationLifecycle = createLifecycle();
    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor: activationLifecycle.supervisor,
      probe: activationLifecycle.probe,
    });
    const mutated = initDatabase({ path: databasePath });
    try {
      recordSchemaVersion(mutated, 2, 'Synthetic candidate schema');
      mutated.exec("UPDATE release_restore_sentinel SET value = 'candidate';");
    } finally {
      closeDatabase(mutated);
    }
    const restoreCandidate = join(
      rootDir,
      'shared',
      'data',
      `.release-restore-${activation.operationId}.db`,
    );
    writeFileSync(restoreCandidate, 'partial-copy', { mode: 0o600 });
    let priorObservedRestore = false;
    const recovery = createLifecycle({
      start: () => {
        const prior = initDatabase({ path: databasePath, readonly: true });
        try {
          expect(prior.prepare('SELECT version FROM schema_version ORDER BY version').all())
            .toEqual([{ version: 1 }]);
          expect(prior.prepare('SELECT value FROM release_restore_sentinel').get())
            .toEqual({ value: 'before' });
          priorObservedRestore = true;
        } finally {
          closeDatabase(prior);
        }
      },
    });

    await expect(recoverInterruptedApplicationRelease({
      rootDir,
      supervisor: recovery.supervisor,
      probe: recovery.probe,
    })).resolves.toEqual({ recovered: true, restarted: true });

    expect(priorObservedRestore).toBe(true);
    expect(existsSync(restoreCandidate)).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('cleans a published snapshot whose snapshot-ready state was not published', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const databasePath = join(rootDir, 'shared', 'data', 'lethebot.db');
    const initial = initDatabase({ path: databasePath });
    try {
      runMigration(initial, join(process.cwd(), 'migrations/001_initial_schema.sql'));
      initial.exec(`
        CREATE TABLE release_snapshot_sentinel (value TEXT NOT NULL);
        INSERT INTO release_snapshot_sentinel (value) VALUES ('before');
      `);
    } finally {
      closeDatabase(initial);
    }
    const activationLifecycle = createLifecycle();
    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor: activationLifecycle.supervisor,
      probe: activationLifecycle.probe,
    });
    const statePath = join(rootDir, '.activation-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(statePath, `${JSON.stringify({
      ...state,
      phase: 'intent_recorded',
      rollbackSnapshot: null,
    })}\n`, 'utf8');
    setManagedPointers(rootDir, 'A', null);
    const snapshotPath = join(rootDir, '.release-rollback', `${activation.operationId}.db`);
    expect(existsSync(snapshotPath)).toBe(true);
    let priorObservedOriginal = false;
    const recovery = createLifecycle({
      start: () => {
        const prior = initDatabase({ path: databasePath, readonly: true });
        try {
          expect(prior.prepare('SELECT value FROM release_snapshot_sentinel').get())
            .toEqual({ value: 'before' });
          priorObservedOriginal = true;
        } finally {
          closeDatabase(prior);
        }
      },
    });

    await expect(recoverInterruptedApplicationRelease({
      rootDir,
      supervisor: recovery.supervisor,
      probe: recovery.probe,
    })).resolves.toEqual({ recovered: true, restarted: true });

    expect(priorObservedOriginal).toBe(true);
    expect(existsSync(snapshotPath)).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('removes an operation-owned pending snapshot from a pre-publication crash', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const activationLifecycle = createLifecycle();
    const activation = await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor: activationLifecycle.supervisor,
      probe: activationLifecycle.probe,
    });
    const statePath = join(rootDir, '.activation-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      statePath,
      `${JSON.stringify({ ...state, phase: 'intent_recorded', rollbackSnapshot: null })}\n`,
      'utf8',
    );
    setManagedPointers(rootDir, 'A', null);
    const pendingSnapshot = join(
      rootDir,
      '.release-rollback',
      `${activation.operationId}.pending.db`,
    );
    writeFileSync(pendingSnapshot, 'interrupted-backup', 'utf8');
    const recovery = createLifecycle();

    await expect(recoverInterruptedApplicationRelease({
      rootDir,
      supervisor: recovery.supervisor,
      probe: recovery.probe,
    })).resolves.toEqual({ recovered: true, restarted: true });

    expect(existsSync(pendingSnapshot)).toBe(false);
    expectCleanRoot(rootDir, ['current', 'releases', 'shared']);
  });

  it('rejects an orphan restore artifact without lifecycle work', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const orphan = join(rootDir, 'shared', 'data', '.release-restore-foreign.db');
    writeFileSync(orphan, 'orphan', 'utf8');
    const { events, supervisor, probe } = createLifecycle();

    await expect(recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }))
      .rejects.toMatchObject({ code: 'invalid-recovery-state' });

    expect(events).toEqual([]);
    expect(readFileSync(orphan, 'utf8')).toBe('orphan');
  });

  it('is a lifecycle-free no-op when no durable intent exists', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }),
    ).resolves.toEqual({ recovered: false, restarted: false });

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
  });

  it('rejects a dangling rollback directory without lifecycle work', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const rollbackPath = join(rootDir, '.release-rollback');
    symlinkSync('missing-rollback-directory', rollbackPath);
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }),
    ).rejects.toMatchObject({ code: 'invalid-recovery-state' });

    expect(events).toEqual([]);
    expect(lstatSync(rollbackPath).isSymbolicLink()).toBe(true);
    expectRelativeLink(rootDir, 'current', 'releases/A');
  });

  it('rejects target pointers paired with an intent-recorded v2 state', async () => {
    const { rootDir } = createManagedReleaseFixture();
    const lifecycle = createLifecycle();
    await activateApplicationRelease({
      rootDir,
      releaseId: 'B',
      supervisor: lifecycle.supervisor,
      probe: lifecycle.probe,
    });
    const statePath = join(rootDir, '.activation-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    state.phase = 'intent_recorded';
    state.rollbackSnapshot = null;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');
    lifecycle.events.length = 0;

    await expect(recoverInterruptedApplicationRelease({
      rootDir,
      supervisor: lifecycle.supervisor,
      probe: lifecycle.probe,
    })).rejects.toMatchObject({ code: 'invalid-recovery-state' });

    expect(lifecycle.events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expectRelativeLink(rootDir, 'previous', 'releases/A');
  });

  it('restores A/C from the A/A activation intermediate state', async () => {
    const { rootDir } = createManagedReleaseFixture();
    writeRelease(join(rootDir, 'releases', 'C'));
    setManagedPointers(rootDir, 'A', 'A');
    seedActivationState(rootDir, { originalPrevious: 'C' });
    const { events, supervisor, probe } = createLifecycle();

    await recoverInterruptedApplicationRelease({ rootDir, supervisor, probe });

    expect(events).toEqual(['stop', 'start', 'probe:health', 'probe:readiness']);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expectRelativeLink(rootDir, 'previous', 'releases/C');
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(false);
  });

  it('restores A/C from target B/A without changing shared data or release directories', async () => {
    const { rootDir } = createManagedReleaseFixture();
    writeRelease(join(rootDir, 'releases', 'C'));
    const databasePath = join(rootDir, 'shared', 'data', 'lethebot.db');
    writeFileSync(databasePath, 'durable-state\n', 'utf8');
    setManagedPointers(rootDir, 'B', 'A');
    seedActivationState(rootDir, { originalPrevious: 'C' });
    const databaseIdentity = lstatSync(databasePath);
    const databaseContents = readFileSync(databasePath);
    const releaseDirectories = readdirSync(join(rootDir, 'releases'))
      .sort()
      .map((releaseId) => {
        const identity = lstatSync(join(rootDir, 'releases', releaseId));
        return { releaseId, dev: identity.dev, ino: identity.ino };
      });
    const { events, supervisor, probe } = createLifecycle();

    await recoverInterruptedApplicationRelease({ rootDir, supervisor, probe });

    expect(events).toEqual(['stop', 'start', 'probe:health', 'probe:readiness']);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expectRelativeLink(rootDir, 'previous', 'releases/C');
    expect(lstatSync(databasePath)).toMatchObject({
      dev: databaseIdentity.dev,
      ino: databaseIdentity.ino,
    });
    expect(readFileSync(databasePath)).toEqual(databaseContents);
    expect(
      readdirSync(join(rootDir, 'releases'))
        .sort()
        .map((releaseId) => {
          const identity = lstatSync(join(rootDir, 'releases', releaseId));
          return { releaseId, dev: identity.dev, ino: identity.ino };
        }),
    ).toEqual(releaseDirectories);
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(false);
    expect(existsSync(join(rootDir, '.release-rollback'))).toBe(false);
  });

  it('restores A/C from the B/C partial rollback state', async () => {
    const { rootDir } = createManagedReleaseFixture();
    writeRelease(join(rootDir, 'releases', 'C'));
    setManagedPointers(rootDir, 'B', 'C');
    seedActivationState(rootDir, { originalPrevious: 'C' });
    const { events, supervisor, probe } = createLifecycle();

    await recoverInterruptedApplicationRelease({ rootDir, supervisor, probe });

    expect(events).toEqual(['stop', 'start', 'probe:health', 'probe:readiness']);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expectRelativeLink(rootDir, 'previous', 'releases/C');
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(false);
  });

  it('removes both pointers when recovering an interrupted first activation', async () => {
    const { rootDir } = createManagedReleaseFixture();
    setManagedPointers(rootDir, 'B', null);
    seedActivationState(rootDir, { originalCurrent: null, originalPrevious: null });
    const { events, supervisor, probe } = createLifecycle();

    await recoverInterruptedApplicationRelease({ rootDir, supervisor, probe });

    expect(events).toEqual(['stop']);
    expectNoManagedPointers(rootDir);
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(false);
  });

  it('removes orphan pointer links owned by the recorded operation', async () => {
    const { rootDir } = createManagedReleaseFixture();
    setManagedPointers(rootDir, 'B', 'A');
    const state = seedActivationState(rootDir);
    const ownedCurrent = join(rootDir, `.activation-${state.operationId}-current.tmp`);
    const ownedPrevious = join(rootDir, `.activation-${state.operationId}-previous.tmp`);
    symlinkSync('releases/B', ownedCurrent);
    symlinkSync('releases/A', ownedPrevious);
    const { supervisor, probe } = createLifecycle();

    await recoverInterruptedApplicationRelease({ rootDir, supervisor, probe });

    expect(existsSync(ownedCurrent)).toBe(false);
    expect(existsSync(ownedPrevious)).toBe(false);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expect(existsSync(join(rootDir, 'previous'))).toBe(false);
  });

  it('rejects a foreign operation temp link without deleting or running lifecycle work', async () => {
    const { rootDir } = createManagedReleaseFixture();
    setManagedPointers(rootDir, 'B', 'A');
    seedActivationState(rootDir);
    const foreignCurrent = join(
      rootDir,
      `.activation-${FOREIGN_OPERATION_ID}-current.tmp`,
    );
    symlinkSync('releases/B', foreignCurrent);
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }),
    ).rejects.toMatchObject({ code: 'invalid-recovery-state' });

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expectRelativeLink(rootDir, 'previous', 'releases/A');
    expect(readlinkSync(foreignCurrent)).toBe('releases/B');
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(true);
  });

  it.each(['start', 'probe'] as const)(
    'retains the marker after a recovery %s failure and removes it after a successful retry',
    async (failure) => {
      const { rootDir } = createManagedReleaseFixture();
      writeRelease(join(rootDir, 'releases', 'C'));
      setManagedPointers(rootDir, 'B', 'A');
      seedActivationState(rootDir, { originalPrevious: 'C' });
      const { events, supervisor, probe } = createLifecycle({
        start: (call) => {
          if (failure === 'start' && call === 1) {
            throw new Error('synthetic recovery start failure');
          }
        },
        probe: (kind, call) => {
          if (failure === 'probe' && kind === 'health' && call === 1) {
            throw new Error('synthetic recovery probe failure');
          }
        },
      });

      const firstRecovery = recoverInterruptedApplicationRelease({
        rootDir,
        supervisor,
        probe,
      });
      await expect(firstRecovery).rejects.toBeInstanceOf(ApplicationRecoveryError);
      await expect(firstRecovery).rejects.toMatchObject({ code: 'recovery-failed' });

      expectRelativeLink(rootDir, 'current', 'releases/A');
      expectRelativeLink(rootDir, 'previous', 'releases/C');
      expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(true);

      await recoverInterruptedApplicationRelease({ rootDir, supervisor, probe });

      expect(events).toEqual(
        failure === 'start'
          ? ['stop', 'start', 'stop', 'start', 'probe:health', 'probe:readiness']
          : [
              'stop',
              'start',
              'probe:health',
              'stop',
              'start',
              'probe:health',
              'probe:readiness',
            ],
      );
      expectRelativeLink(rootDir, 'current', 'releases/A');
      expectRelativeLink(rootDir, 'previous', 'releases/C');
      expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(false);
    },
  );

  it('rejects a malformed marker without lifecycle or pointer changes', async () => {
    const { rootDir } = createManagedReleaseFixture();
    writeRelease(join(rootDir, 'releases', 'C'));
    setManagedPointers(rootDir, 'A', 'C');
    const markerPath = join(rootDir, '.activation-state.json');
    writeFileSync(markerPath, '{"schemaVersion":1', 'utf8');
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }),
    ).rejects.toMatchObject({ code: 'invalid-recovery-state' });

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expectRelativeLink(rootDir, 'previous', 'releases/C');
    expect(readFileSync(markerPath, 'utf8')).toBe('{"schemaVersion":1');
  });

  it('rejects an internally inconsistent marker without lifecycle or pointer changes', async () => {
    const { rootDir } = createManagedReleaseFixture();
    writeRelease(join(rootDir, 'releases', 'C'));
    setManagedPointers(rootDir, 'A', 'C');
    const state = seedActivationState(rootDir, { originalPrevious: 'C' });
    state.targetPointers.current = 'C';
    const markerPath = join(rootDir, '.activation-state.json');
    writeFileSync(markerPath, `${JSON.stringify(state)}\n`, 'utf8');
    const markerContents = readFileSync(markerPath, 'utf8');
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }),
    ).rejects.toBeInstanceOf(ApplicationRecoveryError);

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/A');
    expectRelativeLink(rootDir, 'previous', 'releases/C');
    expect(readFileSync(markerPath, 'utf8')).toBe(markerContents);
  });

  it('rejects a valid marker with an unexplained pointer pair without touching it', async () => {
    const { rootDir } = createManagedReleaseFixture();
    writeRelease(join(rootDir, 'releases', 'C'));
    setManagedPointers(rootDir, 'C', 'B');
    seedActivationState(rootDir, { originalPrevious: 'C' });
    const markerPath = join(rootDir, '.activation-state.json');
    const markerContents = readFileSync(markerPath, 'utf8');
    const { events, supervisor, probe } = createLifecycle();

    await expect(
      recoverInterruptedApplicationRelease({ rootDir, supervisor, probe }),
    ).rejects.toMatchObject({ code: 'invalid-recovery-state' });

    expect(events).toEqual([]);
    expectRelativeLink(rootDir, 'current', 'releases/C');
    expectRelativeLink(rootDir, 'previous', 'releases/B');
    expect(readFileSync(markerPath, 'utf8')).toBe(markerContents);
  });

  it.each([
    { label: 'duplicate', current: 'A', previous: 'A' },
    { label: 'previous-only', current: null, previous: 'A' },
  ] as const)(
    'rejects a marker-free $label layout before automatic recovery or activation',
    async ({ current, previous }) => {
      const { rootDir } = createManagedReleaseFixture();
      setManagedPointers(rootDir, current, previous);
      const { events, supervisor, probe } = createLifecycle();

      await expect(
        activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe }),
      ).rejects.toMatchObject({ code: 'invalid-layout' });

      expect(events).toEqual([]);
      if (current === null) {
        expect(existsSync(join(rootDir, 'current'))).toBe(false);
      } else {
        expectRelativeLink(rootDir, 'current', `releases/${current}`);
      }
      expectRelativeLink(rootDir, 'previous', `releases/${previous}`);
      expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(false);
    },
  );

  it('automatically recovers a pending activation before activating the candidate', async () => {
    const { rootDir } = createManagedReleaseFixture();
    writeRelease(join(rootDir, 'releases', 'C'));
    setManagedPointers(rootDir, 'B', 'A');
    seedActivationState(rootDir, { originalPrevious: 'C' });
    const { events, supervisor, probe } = createLifecycle();

    await activateApplicationRelease({ rootDir, releaseId: 'B', supervisor, probe });

    expect(events).toEqual([
      'stop',
      'start',
      'probe:health',
      'probe:readiness',
      'stop',
      'start',
      'probe:health',
      'probe:readiness',
    ]);
    expectRelativeLink(rootDir, 'current', 'releases/B');
    expectRelativeLink(rootDir, 'previous', 'releases/A');
    expect(existsSync(join(rootDir, '.activation-state.json'))).toBe(true);
    expect(existsSync(join(rootDir, '.release-rollback'))).toBe(true);
  });
});
