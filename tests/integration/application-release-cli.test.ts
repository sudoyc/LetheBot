import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createApplicationProbe,
  createApplicationSupervisor,
  parseApplicationReleaseCliArgs,
} from '../../src/scripts/application-release.js';
import { MANAGED_STARTUP_PROTOCOL_VERSION } from '../../src/operations/managed-startup.js';

interface RehearsalResult {
  success: boolean;
  temporary: boolean;
  activation: {
    success: boolean;
    currentIsCandidate: boolean;
    previousIsPrior: boolean;
    priorStoppedBeforeSwitch: boolean;
    candidateStartedAfterSwitch: boolean;
    candidateHealthBeforeReadiness: boolean;
  };
  rollback: {
    candidateFailureObserved: boolean;
    success: boolean;
    currentRestored: boolean;
    previousRestored: boolean;
    candidateStoppedBeforeRestore: boolean;
    priorStartedAfterRestore: boolean;
    priorHealthBeforeReadiness: boolean;
  };
  sharedDatabase: {
    pathUnchanged: boolean;
    contentUnchanged: boolean;
    legacyAdopted: boolean;
    schemaVersionStable: boolean;
    sentinelPreserved: boolean;
    integrityOk: boolean;
    foreignKeysClean: boolean;
  };
  runtime: {
    builtEntrypoints: boolean;
    activationReleasesStarted: number;
    rollbackReleasesStarted: number;
  };
  cleanup: {
    lockRemoved: boolean;
    temporaryLinksRemoved: boolean;
    processesStopped: boolean;
    workspaceRemoved: boolean;
  };
}

describe('application release CLI', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-application-release-cli-'));
  });

  afterEach(() => {
    delete process.env.APPLICATION_RELEASE_TEST_SECRET;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeManagedStartupAssets(root: string): void {
    const binDir = join(root, 'shared', 'bin');
    mkdirSync(binDir, { recursive: true });
    const managedStartup = 'export {};\n';
    const releaseArtifact = 'export {};\n';
    writeFileSync(join(binDir, 'managed-startup.js'), managedStartup, 'utf8');
    writeFileSync(join(binDir, 'release-artifact.js'), releaseArtifact, 'utf8');
    writeFileSync(join(binDir, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');
    writeFileSync(join(binDir, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      protocolVersion: MANAGED_STARTUP_PROTOCOL_VERSION,
      files: {
        'managed-startup.js': createHash('sha256').update(managedStartup).digest('hex'),
        'release-artifact.js': createHash('sha256').update(releaseArtifact).digest('hex'),
      },
    })}\n`, 'utf8');
    writeFileSync(join(root, 'shared', 'runtime.env'), 'NODE_ENV=production\n', 'utf8');
  }

  function writePm2Ecosystem(root: string): void {
    writeFileSync(join(root, 'shared', 'ecosystem.config.cjs'), `module.exports = { apps: [{
  script: ${JSON.stringify(join(root, 'shared/bin/managed-startup.js'))},
  interpreter: ${JSON.stringify(process.execPath)},
  args: [${JSON.stringify('launch')}, ${JSON.stringify(`--root=${root}`)}, ${JSON.stringify(`--entrypoint=${join(root, 'current/dist/index.js')}`)}],
  stop_exit_codes: [78],
  env: { LETHEBOT_DB_PATH: ${JSON.stringify(join(root, 'shared/data/lethebot.db'))} }
}] };\n`, 'utf8');
  }

  function systemdUnitForRoot(root: string): string {
    const literal = (value: string): string => JSON.stringify(value);
    const currentDir = join(root, 'current');
    const sharedDir = join(root, 'shared');
    const entrypoint = join(currentDir, 'dist/index.js');
    return [
      'User=lethebot',
      `WorkingDirectory=${literal(currentDir)}`,
      `EnvironmentFile=${literal(join(sharedDir, 'runtime.env'))}`,
      'UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT',
      `ExecCondition=+/usr/bin/env ${literal(process.execPath)} ${literal(join(sharedDir, 'bin/managed-startup.js'))} ${literal('condition')} ${literal(`--root=${root}`)} ${literal(`--entrypoint=${entrypoint}`)}`,
      `ExecStart=${literal('/usr/bin/env')} ${literal('NODE_ENV=production')} ${literal(`LETHEBOT_DB_PATH=${join(sharedDir, 'data/lethebot.db')}`)} ${literal(process.execPath)} ${literal(entrypoint)}`,
      '',
    ].join('\n');
  }

  function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const script = join(process.cwd(), 'src/scripts/application-release.ts');
    const result = spawnSync(tsxBin, [script, ...args], {
      cwd: testDir,
      env: {
        ...process.env,
        LETHEBOT_TEST: 'true',
        LOG_LEVEL: 'fatal',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      status: result.status,
    };
  }

  it('rehearses successful activation and readiness-triggered rollback with aggregate-only evidence', () => {
    const beforeEntries = readdirSync(testDir);
    const result = spawnSync('pnpm', [
      '--silent',
      'ops:rehearse-application-rollback',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe('');
    expect(result.stdout.trim().startsWith('{')).toBe(true);

    const rehearsal = JSON.parse(result.stdout.trim()) as RehearsalResult;
    expect(rehearsal).toMatchObject({
      success: true,
      temporary: true,
      activation: {
        success: true,
        currentIsCandidate: true,
        previousIsPrior: true,
        priorStoppedBeforeSwitch: true,
        candidateStartedAfterSwitch: true,
        candidateHealthBeforeReadiness: true,
      },
      rollback: {
        candidateFailureObserved: true,
        success: true,
        currentRestored: true,
        previousRestored: true,
        candidateStoppedBeforeRestore: true,
        priorStartedAfterRestore: true,
        priorHealthBeforeReadiness: true,
      },
      sharedDatabase: {
        pathUnchanged: true,
        contentUnchanged: true,
        legacyAdopted: true,
        schemaVersionStable: true,
        sentinelPreserved: true,
        integrityOk: true,
        foreignKeysClean: true,
      },
      runtime: {
        builtEntrypoints: true,
        activationReleasesStarted: 2,
        rollbackReleasesStarted: 3,
      },
      cleanup: {
        lockRemoved: true,
        temporaryLinksRemoved: true,
        processesStopped: true,
        workspaceRemoved: true,
      },
    });

    expect(readdirSync(testDir)).toEqual(beforeEntries);
    expect(result.stdout).not.toContain(tmpdir());
    expect(result.stdout).not.toContain(testDir);
    expect(result.stdout).not.toContain('releases/');
    expect(result.stdout).not.toContain('dist/index.js');
    expect(result.stdout).not.toContain('lethebot.db');
    expect(result.stdout).not.toContain('shared-database-sentinel');
    expect(result.stdout).not.toContain('release-rehearsal-sentinel');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it.each([
    'unknown option',
    'missing root',
    'relative root',
    'invalid manager',
  ])('rejects %s before mutating the deployment root', (failureKind) => {
    const root = join(testDir, 'managed-root');
    const relativeRoot = 'sk-relative-root-qq-1234567890';
    const sensitiveOption = 'sk-cli-option-secret-qq-1234567890';
    const baseArgs = ['activate', `--root=${root}`, '--release=release-b', '--manager=systemd'];
    let args: string[];

    if (failureKind === 'unknown option') {
      args = [...baseArgs, `--unknown=${sensitiveOption}`];
    } else if (failureKind === 'missing root') {
      args = ['activate', '--release=release-b', '--manager=systemd'];
    } else if (failureKind === 'relative root') {
      args = ['activate', `--root=${relativeRoot}`, '--release=release-b', '--manager=systemd'];
    } else {
      args = ['activate', `--root=${root}`, '--release=release-b', `--manager=${sensitiveOption}`];
    }

    const beforeEntries = readdirSync(testDir);
    const result = runCli(args);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    expect(result.stderr.length).toBeLessThan(1_024);
    expect(result.stderr).not.toContain(testDir);
    expect(result.stderr).not.toContain(relativeRoot);
    expect(result.stderr).not.toContain(sensitiveOption);
    expect(result.stderr).not.toContain('1234567890');
    expect(result.stderr).not.toContain('src/scripts');
    expect(result.stderr).not.toContain('\n    at ');
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(testDir, relativeRoot))).toBe(false);
    expect(readdirSync(testDir)).toEqual(beforeEntries);
  });

  it('maps systemd and PM2 lifecycle calls to fixed non-shell commands', async () => {
    const calls: Array<{ program: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner = async (
      program: string,
      args: string[],
      options?: { env?: NodeJS.ProcessEnv },
    ): Promise<{ stdout: string }> => {
      calls.push({ program, args, env: options?.env });
      return { stdout: args[0] === 'cat' ? systemdUnitForRoot(root) : '' };
    };
    const root = join(testDir, 'managed-root');
    mkdirSync(join(root, 'shared'), { recursive: true });
    writePm2Ecosystem(root);
    writeManagedStartupAssets(root);
    mkdirSync(join(root, 'releases', 'A'), { recursive: true });
    symlinkSync('releases/A', join(root, 'current'));
    process.env.APPLICATION_RELEASE_TEST_SECRET = 'must-not-reach-pm2';

    const systemd = createApplicationSupervisor(
      'systemd',
      root,
      runner,
      process.getuid?.() ?? 0,
    );
    await systemd.stop();
    await systemd.start({ rootDir: root, releaseId: 'A' });

    const pm2 = createApplicationSupervisor('pm2', root, runner);
    await pm2.stop();
    await pm2.start({ rootDir: root, releaseId: 'A' });

    expect(calls.map(({ program, args }) => ({ program, args }))).toEqual([
      { program: 'systemctl', args: ['cat', 'lethebot'] },
      { program: 'systemctl', args: ['stop', 'lethebot'] },
      { program: 'systemctl', args: ['start', 'lethebot'] },
      { program: 'pm2', args: ['delete', 'lethebot'] },
      { program: 'pm2', args: ['start', join(root, 'shared', 'ecosystem.config.cjs')] },
    ]);
    expect(calls[3]?.env).not.toHaveProperty('APPLICATION_RELEASE_TEST_SECRET');
    expect(calls[4]?.env).not.toHaveProperty('APPLICATION_RELEASE_TEST_SECRET');
    delete process.env.APPLICATION_RELEASE_TEST_SECRET;
  });

  it('treats PM2 delete as idempotent only when pid confirms the app is absent', async () => {
    const root = join(testDir, 'managed-root');
    mkdirSync(join(root, 'shared'), { recursive: true });
    writePm2Ecosystem(root);
    writeManagedStartupAssets(root);
    const calls: string[] = [];
    const absentRunner = async (_program: string, args: string[]) => {
      calls.push(args.join(' '));
      if (args[0] === 'delete') {
        throw new Error('process absent');
      }
      return { stdout: '' };
    };

    await createApplicationSupervisor('pm2', root, absentRunner).stop();
    expect(calls).toEqual(['delete lethebot', 'pid lethebot']);

    const presentRunner = async (_program: string, args: string[]) => {
      if (args[0] === 'delete') {
        throw new Error('delete failed');
      }
      return { stdout: '0\n' };
    };
    await expect(createApplicationSupervisor('pm2', root, presentRunner).stop())
      .rejects.toThrow('delete failed');
  });

  it('rejects a systemd unit bound to another managed root before lifecycle work', async () => {
    const root = join(testDir, 'managed-root');
    mkdirSync(join(root, 'shared'), { recursive: true });
    writeManagedStartupAssets(root);
    const calls: string[] = [];
    const runner = async (program: string, args: string[]) => {
      calls.push(`${program} ${args.join(' ')}`);
      return { stdout: systemdUnitForRoot(join(testDir, 'other-root')) };
    };
    const supervisor = createApplicationSupervisor(
      'systemd',
      root,
      runner,
      process.getuid?.() ?? 0,
    );

    await expect(supervisor.stop())
      .rejects.toThrow('Managed systemd unit is not bound to the requested deployment root');
    expect(calls).toEqual(['systemctl cat lethebot']);
  });

  it('rejects a PM2 ecosystem missing the managed launch mode before lifecycle work', async () => {
    const root = join(testDir, 'managed-root');
    mkdirSync(join(root, 'shared'), { recursive: true });
    writeManagedStartupAssets(root);
    writePm2Ecosystem(root);
    const ecosystemPath = join(root, 'shared', 'ecosystem.config.cjs');
    writeFileSync(
      ecosystemPath,
      readFileSync(ecosystemPath, 'utf8').replace(`${JSON.stringify('launch')}, `, ''),
      'utf8',
    );
    const runner = async (): Promise<{ stdout: string }> => {
      throw new Error('lifecycle must not run');
    };
    const supervisor = createApplicationSupervisor('pm2', root, runner);

    await expect(supervisor.stop())
      .rejects.toThrow('Managed PM2 ecosystem is not bound to the requested deployment root');
  });

  it('rejects an old gate protocol and writable gate asset before lifecycle work', async () => {
    for (const mutation of ['protocol', 'mode'] as const) {
      const root = join(testDir, `managed-${mutation}`);
      mkdirSync(join(root, 'shared'), { recursive: true });
      writeManagedStartupAssets(root);
      writePm2Ecosystem(root);
      if (mutation === 'protocol') {
        const manifestPath = join(root, 'shared', 'bin', 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, protocolVersion: 2 })}\n`);
      } else {
        chmodSync(join(root, 'shared', 'bin', 'managed-startup.js'), 0o775);
      }
      const runner = async (): Promise<{ stdout: string }> => {
        throw new Error('lifecycle must not run');
      };
      const supervisor = createApplicationSupervisor('pm2', root, runner);

      await expect(supervisor.stop()).rejects.toThrow('Managed startup gate');
    }
  });

  it('requires the expected aggregate status from health and readiness endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready' }) });
    vi.stubGlobal('fetch', fetchMock);
    const probe = createApplicationProbe({
      baseUrl: 'http://127.0.0.1:6700',
      healthPath: '/healthz',
      readinessPath: '/readyz',
      timeoutMs: 1_000,
    });

    await probe.check('health');
    await probe.check('readiness');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:6700/healthz',
      'http://127.0.0.1:6700/readyz',
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({ redirect: 'manual' }),
      expect.objectContaining({ redirect: 'manual' }),
    ]);
  });

  it('retries a wrong status and rejects at the configured probe deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'not_ready' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const probe = createApplicationProbe({
      baseUrl: 'http://127.0.0.1:6700',
      healthPath: '/healthz',
      readinessPath: '/readyz',
      timeoutMs: 500,
    });

    const rejection = expect(probe.check('health')).rejects.toThrow(
      'Application endpoint probe timed out.',
    );
    await vi.advanceTimersByTimeAsync(500);
    await rejection;

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it.each(['//example.invalid/healthz', '/\\example.invalid/healthz'])(
    'rejects network-path probe endpoint %s before making a request',
    (healthPath) => {
      expect(() => parseApplicationReleaseCliArgs([
        'activate',
        '--root=/srv/lethebot',
        '--release=B',
        '--manager=systemd',
        `--health-path=${healthPath}`,
      ])).toThrow('Invalid application release arguments');
    },
  );

  it('parses explicit recovery without accepting a candidate release', () => {
    expect(parseApplicationReleaseCliArgs([
      'recover',
      '--root=/srv/lethebot',
      '--manager=systemd',
    ])).toMatchObject({
      command: 'recover',
      rootDir: '/srv/lethebot',
      manager: 'systemd',
    });
    expect(() => parseApplicationReleaseCliArgs([
      'recover',
      '--root=/srv/lethebot',
      '--release=B',
      '--manager=systemd',
    ])).toThrow('Invalid application release arguments');
  });

  it('parses explicit confirmation without accepting a candidate release', () => {
    expect(parseApplicationReleaseCliArgs([
      'confirm',
      '--root=/srv/lethebot',
      '--release=B',
      '--operation-id=00000000-0000-4000-8000-000000000001',
      '--manager=systemd',
    ])).toMatchObject({
      command: 'confirm',
      rootDir: '/srv/lethebot',
      releaseId: 'B',
      operationId: '00000000-0000-4000-8000-000000000001',
      manager: 'systemd',
    });
    expect(() => parseApplicationReleaseCliArgs([
      'confirm',
      '--root=/srv/lethebot',
      '--manager=systemd',
    ])).toThrow('Invalid application release arguments');
  });

  it('parses only two absolute release directories for cross-version rehearsal', () => {
    expect(parseApplicationReleaseCliArgs([
      'rehearse-cross-version',
      '--prior-release=/srv/lethebot/releases/A',
      '--candidate-release=/srv/lethebot/releases/B',
    ])).toEqual({
      command: 'rehearse-cross-version',
      priorReleaseDir: '/srv/lethebot/releases/A',
      candidateReleaseDir: '/srv/lethebot/releases/B',
    });

    for (const args of [
      ['rehearse-cross-version', '--prior-release=relative', '--candidate-release=/tmp/B'],
      ['rehearse-cross-version', '--prior-release=/tmp/A'],
      [
        'rehearse-cross-version',
        '--prior-release=/tmp/A',
        '--candidate-release=/tmp/B',
        '--manager=systemd',
      ],
    ]) {
      expect(() => parseApplicationReleaseCliArgs(args)).toThrow(
        'Invalid application release arguments',
      );
    }
  });

  it('rejects invalid cross-version release inputs without exposing either path', () => {
    const prior = join(testDir, 'sk-prior-qq-1234567890');
    const candidate = join(testDir, 'sk-candidate-qq-1234567890');
    mkdirSync(prior);
    mkdirSync(candidate);

    const result = runCli([
      'rehearse-cross-version',
      `--prior-release=${prior}`,
      `--candidate-release=${candidate}`,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Application release command failed.');
    expect(result.stderr).not.toContain(testDir);
    expect(result.stderr).not.toContain('1234567890');
  });

  it('rejects PM2 activation before lifecycle work when its managed artifact is missing', () => {
    expect(() => createApplicationSupervisor('pm2', join(testDir, 'missing-root')))
      .toThrow('Managed PM2 ecosystem configuration is invalid or missing');
  });

  it('accepts the pnpm separator without echoing a managed root', () => {
    const root = join(testDir, 'managed-root');
    const result = spawnSync('pnpm', [
      '--silent',
      'ops:activate-release',
      '--',
      `--root=${root}`,
      '--release=B',
      '--manager=systemd',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Application release failed: invalid-layout.\n');
    expect(result.stderr).not.toContain(root);
    expect(existsSync(root)).toBe(false);
  });

  it('exposes explicit recovery through a path-redacted package command', () => {
    const root = join(testDir, 'managed-recovery-root');
    const result = spawnSync('pnpm', [
      '--silent',
      'ops:recover-release',
      '--',
      `--root=${root}`,
      '--manager=systemd',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Application release failed: invalid-layout.\n');
    expect(result.stderr).not.toContain(root);
    expect(existsSync(root)).toBe(false);
  });

  it('exposes explicit confirmation through a path-redacted package command', () => {
    const root = join(testDir, 'managed-confirm-root');
    const result = spawnSync('pnpm', [
      '--silent',
      'ops:confirm-release',
      '--',
      `--root=${root}`,
      '--release=B',
      '--operation-id=00000000-0000-4000-8000-000000000001',
      '--manager=systemd',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Application release failed: invalid-layout.\n');
    expect(result.stderr).not.toContain(root);
    expect(existsSync(root)).toBe(false);
  });

  it('reports a marker-free recovery as aggregate-only no-op JSON', () => {
    const root = join(testDir, 'managed-clean-root');
    mkdirSync(join(root, 'releases'), { recursive: true });
    mkdirSync(join(root, 'shared', 'data'), { recursive: true });
    mkdirSync(join(root, 'shared', 'logs'), { recursive: true });
    writeFileSync(join(root, 'shared', 'runtime.env'), 'NODE_ENV=production\n', 'utf8');

    const result = runCli([
      'recover',
      `--root=${root}`,
      '--manager=systemd',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      manager: 'systemd',
      recovered: false,
      restarted: false,
      healthChecked: false,
      readinessChecked: false,
    });
    expect(result.stdout).not.toContain(root);
  });

});
