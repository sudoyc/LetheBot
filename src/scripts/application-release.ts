import Database from 'better-sqlite3';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  activateApplicationRelease,
  ApplicationReleaseCleanupError,
  ApplicationReleaseError,
  ApplicationRollbackError,
  confirmApplicationRelease,
  recoverInterruptedApplicationRelease,
  type ApplicationProbe,
  type ApplicationProbeKind,
  type ApplicationSupervisor,
} from '../operations/application-release.js';
import {
  MANAGED_STARTUP_PROTOCOL_VERSION,
  ManagedStartupError,
  runManagedStartupGate,
} from '../operations/managed-startup.js';
import { calculateManagedReleaseDigest } from '../operations/release-artifact.js';
import { CURRENT_SCHEMA_VERSION } from '../storage/schema-version.js';

type ApplicationManager = 'systemd' | 'pm2';
interface CommandOptions {
  env?: NodeJS.ProcessEnv;
}

interface CommandResult {
  stdout: string;
}

type CommandRunner = (
  program: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult | void>;

interface ManagedReleaseCliOptions {
  rootDir: string;
  manager: ApplicationManager;
  baseUrl: string;
  healthPath: string;
  readinessPath: string;
  probeTimeoutMs: number;
  lockTimeoutMs: number;
}

interface ActivateCliOptions extends ManagedReleaseCliOptions {
  command: 'activate';
  releaseId: string;
}

interface RecoverCliOptions extends ManagedReleaseCliOptions {
  command: 'recover';
}

interface ConfirmCliOptions extends ManagedReleaseCliOptions {
  command: 'confirm';
  releaseId: string;
  operationId: string;
}

interface RehearseCliOptions {
  command: 'rehearse';
}

interface RehearseCrossVersionCliOptions {
  command: 'rehearse-cross-version';
  priorReleaseDir: string;
  candidateReleaseDir: string;
}

type ApplicationReleaseCliOptions =
  | ActivateCliOptions
  | RecoverCliOptions
  | ConfirmCliOptions
  | RehearseCliOptions
  | RehearseCrossVersionCliOptions;

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

interface CrossVersionRehearsalResult {
  success: boolean;
  temporary: boolean;
  releasesDistinct: boolean;
  rollback: {
    candidateFailureObserved: boolean;
    candidateSchemaObserved: boolean;
    candidateColumnObserved: boolean;
    databaseRestored: boolean;
    metadataRestored: boolean;
    pointersRestored: boolean;
    priorReady: boolean;
  };
  crashRecovery: {
    pendingCandidateObserved: boolean;
    restartDeniedWithoutPermit: boolean;
    recovered: boolean;
    databaseRestored: boolean;
    metadataRestored: boolean;
    pointersRestored: boolean;
    priorReady: boolean;
  };
  confirmation: {
    pendingCandidateObserved: boolean;
    wrongConfirmationRejected: boolean;
    wrongConfirmationPreservedState: boolean;
    exactConfirmationSucceeded: boolean;
    recoveryPointRemoved: boolean;
    markerFreeRestartReady: boolean;
    candidateSchemaObserved: boolean;
    candidateColumnObserved: boolean;
  };
  sharedDatabase: {
    priorLedgerObserved: boolean;
    priorColumnAbsent: boolean;
    candidateLedgerObserved: boolean;
    sentinelPreserved: boolean;
    integrityOk: boolean;
    foreignKeysClean: boolean;
  };
  cleanup: {
    operationArtifactsRemoved: boolean;
    processesStopped: boolean;
    workspaceRemoved: boolean;
  };
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:6700';
const DEFAULT_HEALTH_PATH = '/healthz';
const DEFAULT_READINESS_PATH = '/readyz';
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const MAX_PROBE_TIMEOUT_MS = 120_000;
const MAX_LOCK_TIMEOUT_MS = 60_000;
const PROBE_RETRY_MS = 250;
const REQUEST_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const REHEARSAL_PROBE_TIMEOUT_MS = 2_500;
const REHEARSAL_STOP_TIMEOUT_MS = 5_000;
const REHEARSAL_SENTINEL_ID = 'release-rehearsal-sentinel';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function parseApplicationReleaseCliArgs(args: string[]): ApplicationReleaseCliOptions {
  const command = args[0];
  if (command === 'rehearse') {
    if (args.length !== 1) {
      throw new Error('Invalid application release arguments.');
    }
    return { command };
  }
  if (command === 'rehearse-cross-version') {
    const values = parseExactValueOptions(
      args.slice(1),
      new Set(['--prior-release', '--candidate-release']),
    );
    const priorReleaseDir = values.get('--prior-release');
    const candidateReleaseDir = values.get('--candidate-release');
    if (
      !priorReleaseDir
      || !candidateReleaseDir
      || !isAbsolute(priorReleaseDir)
      || !isAbsolute(candidateReleaseDir)
    ) {
      throw new Error('Invalid application release arguments.');
    }
    return {
      command,
      priorReleaseDir: resolve(priorReleaseDir),
      candidateReleaseDir: resolve(candidateReleaseDir),
    };
  }
  if (command !== 'activate' && command !== 'recover' && command !== 'confirm') {
    throw new Error('Invalid application release arguments.');
  }

  const values = new Map<string, string>();
  const valueOptions = new Set([
    '--root',
    '--release',
    '--operation-id',
    '--manager',
    '--base-url',
    '--health-path',
    '--readiness-path',
    '--probe-timeout-ms',
    '--lock-timeout-ms',
  ]);

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) {
      throw new Error('Invalid application release arguments.');
    }
    if (argument === '--') {
      continue;
    }

    const equalsIndex = argument.indexOf('=');
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (!valueOptions.has(option) || values.has(option)) {
      throw new Error('Invalid application release arguments.');
    }

    const value = equalsIndex === -1 ? args[index + 1] : argument.slice(equalsIndex + 1);
    if (!value || value.startsWith('--')) {
      throw new Error('Invalid application release arguments.');
    }
    values.set(option, value);
    if (equalsIndex === -1) {
      index += 1;
    }
  }

  const rootDir = values.get('--root');
  const releaseId = values.get('--release');
  const operationId = values.get('--operation-id');
  const manager = values.get('--manager');
  if (
    !rootDir
    || !isAbsolute(rootDir)
    || (command === 'activate' ? !releaseId || operationId !== undefined : false)
    || (command === 'recover' ? releaseId !== undefined || operationId !== undefined : false)
    || (command === 'confirm' ? !releaseId || !operationId : false)
    || (manager !== 'systemd' && manager !== 'pm2')
  ) {
    throw new Error('Invalid application release arguments.');
  }

  const baseUrl = validateBaseUrl(values.get('--base-url') ?? DEFAULT_BASE_URL);
  const healthPath = validateEndpointPath(values.get('--health-path') ?? DEFAULT_HEALTH_PATH);
  const readinessPath = validateEndpointPath(
    values.get('--readiness-path') ?? DEFAULT_READINESS_PATH,
  );
  buildProbeUrl(baseUrl, healthPath);
  buildProbeUrl(baseUrl, readinessPath);

  const commonOptions: ManagedReleaseCliOptions = {
    rootDir: resolve(rootDir),
    manager,
    baseUrl,
    healthPath,
    readinessPath,
    probeTimeoutMs: parseBoundedInteger(
      values.get('--probe-timeout-ms'),
      DEFAULT_PROBE_TIMEOUT_MS,
      MAX_PROBE_TIMEOUT_MS,
    ),
    lockTimeoutMs: parseBoundedInteger(
      values.get('--lock-timeout-ms'),
      DEFAULT_LOCK_TIMEOUT_MS,
      MAX_LOCK_TIMEOUT_MS,
    ),
  };
  if (command === 'recover') {
    return { command, ...commonOptions };
  }
  if (command === 'confirm') {
    return {
      command,
      ...commonOptions,
      releaseId: releaseId as string,
      operationId: operationId as string,
    };
  }
  return {
    command,
    ...commonOptions,
    releaseId: releaseId as string,
  };
}

function parseExactValueOptions(
  args: string[],
  valueOptions: ReadonlySet<string>,
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument || argument === '--') {
      if (argument === '--') {
        continue;
      }
      throw new Error('Invalid application release arguments.');
    }
    const equalsIndex = argument.indexOf('=');
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (!valueOptions.has(option) || values.has(option)) {
      throw new Error('Invalid application release arguments.');
    }
    const value = equalsIndex === -1 ? args[index + 1] : argument.slice(equalsIndex + 1);
    if (!value || value.startsWith('--')) {
      throw new Error('Invalid application release arguments.');
    }
    values.set(option, value);
    if (equalsIndex === -1) {
      index += 1;
    }
  }
  if (values.size !== valueOptions.size) {
    throw new Error('Invalid application release arguments.');
  }
  return values;
}

export function createApplicationSupervisor(
  manager: ApplicationManager,
  rootDir: string,
  runner: CommandRunner = runCommand,
  assetOwnerUid?: number,
): ApplicationSupervisor {
  const expectedUid = assetOwnerUid
    ?? (manager === 'systemd' ? 0 : process.getuid?.());
  if (expectedUid === undefined || !Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    throw new Error('Managed startup gate owner cannot be established.');
  }

  if (manager === 'systemd') {
    let ready = false;
    const ensureReady = async (): Promise<void> => {
      if (ready) {
        return;
      }
      assertManagedStartupAssets(rootDir, expectedUid);
      const unit = await runner('systemctl', ['cat', 'lethebot']);
      assertSystemdUnitBinding(rootDir, unit);
      ready = true;
    };
    return {
      async assertReady(): Promise<void> {
        await ensureReady();
      },
      async stop(): Promise<void> {
        await ensureReady();
        await runner('systemctl', ['stop', 'lethebot']);
      },
      async start(input): Promise<void> {
        await ensureReady();
        assertSupervisorStartInput(rootDir, input);
        await runner('systemctl', ['start', 'lethebot']);
      },
    };
  }

  const ecosystemPath = join(rootDir, 'shared', 'ecosystem.config.cjs');
  let ecosystemStats;
  try {
    ecosystemStats = lstatSync(ecosystemPath);
  } catch {
    throw new Error('Managed PM2 ecosystem configuration is invalid or missing.');
  }
  if (!ecosystemStats.isFile() || ecosystemStats.isSymbolicLink()) {
    throw new Error('Managed PM2 ecosystem configuration is invalid or missing.');
  }
  const controlEnvironment = createPm2ControlEnvironment();
  const ensureReady = (): void => {
    assertManagedStartupAssets(rootDir, expectedUid);
    assertPm2EcosystemBinding(rootDir, ecosystemPath, expectedUid);
  };
  return {
    assertReady(): void {
      ensureReady();
    },
    async stop(): Promise<void> {
      ensureReady();
      try {
        await runner('pm2', ['delete', 'lethebot'], { env: controlEnvironment });
      } catch (deleteError) {
        let pidResult: CommandResult | void;
        try {
          pidResult = await runner('pm2', ['pid', 'lethebot'], { env: controlEnvironment });
        } catch {
          throw deleteError;
        }
        if (!pm2PidConfirmsAbsent(pidResult)) {
          throw deleteError;
        }
      }
    },
    async start(input): Promise<void> {
      ensureReady();
      assertSupervisorStartInput(rootDir, input);
      await runner('pm2', ['start', ecosystemPath], { env: controlEnvironment });
    },
  };
}

function assertManagedStartupAssets(rootDir: string, expectedUid: number): void {
  const binDir = join(rootDir, 'shared', 'bin');
  for (const path of [rootDir, join(rootDir, 'shared'), binDir]) {
    assertTrustedManagedPath(path, 'directory', expectedUid);
  }
  for (const name of [
    'managed-startup.js',
    'release-artifact.js',
    'package.json',
    'manifest.json',
  ]) {
    assertTrustedManagedPath(join(binDir, name), 'file', expectedUid);
  }
  assertTrustedManagedPath(join(rootDir, 'shared', 'runtime.env'), 'file', expectedUid);
  if (readFileSync(join(binDir, 'package.json'), 'utf8') !== '{"private":true,"type":"module"}\n') {
    throw new Error('Managed startup gate assets are invalid or missing.');
  }
  assertManagedStartupManifest(binDir);
}

function assertManagedStartupManifest(binDir: string): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(binDir, 'manifest.json'), 'utf8')) as unknown;
  } catch {
    throw new Error('Managed startup gate manifest is invalid.');
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'protocolVersion', 'files'])
    || value.schemaVersion !== 1
    || value.protocolVersion !== MANAGED_STARTUP_PROTOCOL_VERSION
    || !isRecord(value.files)
    || !hasExactKeys(value.files, ['managed-startup.js', 'release-artifact.js'])
  ) {
    throw new Error('Managed startup gate manifest is invalid.');
  }
  for (const name of ['managed-startup.js', 'release-artifact.js'] as const) {
    const expected = value.files[name];
    const actual = createHash('sha256').update(readFileSync(join(binDir, name))).digest('hex');
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
      throw new Error('Managed startup gate manifest is invalid.');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function assertTrustedManagedPath(
  path: string,
  kind: 'file' | 'directory',
  expectedUid: number,
): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error('Managed startup gate assets are invalid or missing.');
  }
  const kindMatches = kind === 'file' ? stats.isFile() : stats.isDirectory();
  if (
    !kindMatches
    || stats.isSymbolicLink()
    || stats.uid !== expectedUid
    || (stats.mode & 0o022) !== 0
  ) {
    throw new Error('Managed startup gate assets are invalid or missing.');
  }
}

function assertSystemdUnitBinding(rootDir: string, result: CommandResult | void): void {
  if (result === undefined) {
    throw new Error('Managed systemd unit binding could not be verified.');
  }
  const literal = (value: string): string => JSON.stringify(value);
  const currentDir = join(rootDir, 'current');
  const sharedDir = join(rootDir, 'shared');
  const entrypointPath = join(currentDir, 'dist/index.js');
  const expected = [
    'User=lethebot',
    `WorkingDirectory=${literal(currentDir)}`,
    `EnvironmentFile=${literal(join(sharedDir, 'runtime.env'))}`,
    'UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT',
    `ExecCondition=+/usr/bin/env ${literal(process.execPath)} ${literal(join(sharedDir, 'bin/managed-startup.js'))} ${literal('condition')} ${literal(`--root=${rootDir}`)} ${literal(`--entrypoint=${entrypointPath}`)}`,
    `ExecStart=${literal('/usr/bin/env')} ${literal('NODE_ENV=production')} ${literal(`LETHEBOT_DB_PATH=${join(sharedDir, 'data/lethebot.db')}`)} ${literal(process.execPath)} ${literal(entrypointPath)}`,
  ];
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
  for (const directive of expected) {
    const name = directive.slice(0, directive.indexOf('=') + 1);
    if (lines.filter((line) => line.startsWith(name)).length !== 1 || !lines.includes(directive)) {
      throw new Error('Managed systemd unit is not bound to the requested deployment root.');
    }
  }
}

function assertPm2EcosystemBinding(
  rootDir: string,
  ecosystemPath: string,
  expectedUid: number,
): void {
  assertTrustedManagedPath(ecosystemPath, 'file', expectedUid);
  const content = readFileSync(ecosystemPath, 'utf8');
  const required = [
    `script: ${JSON.stringify(join(rootDir, 'shared/bin/managed-startup.js'))}`,
    `interpreter: ${JSON.stringify(process.execPath)}`,
    JSON.stringify('launch'),
    JSON.stringify(`--root=${rootDir}`),
    JSON.stringify(`--entrypoint=${join(rootDir, 'current/dist/index.js')}`),
    'stop_exit_codes: [78]',
    `LETHEBOT_DB_PATH: ${JSON.stringify(join(rootDir, 'shared/data/lethebot.db'))}`,
  ];
  if (required.some((value) => !content.includes(value))) {
    throw new Error('Managed PM2 ecosystem is not bound to the requested deployment root.');
  }
}

function assertSupervisorStartInput(
  rootDir: string,
  input: { rootDir: string; releaseId: string },
): void {
  if (resolve(input.rootDir) !== resolve(rootDir) || readCurrentRelease(rootDir) !== input.releaseId) {
    throw new Error('Managed supervisor start does not match the published release pointer.');
  }
}

export function createApplicationProbe(options: {
  baseUrl: string;
  healthPath: string;
  readinessPath: string;
  timeoutMs: number;
}): ApplicationProbe {
  return {
    async check(kind): Promise<void> {
      const path = kind === 'health' ? options.healthPath : options.readinessPath;
      const expectedStatus = kind === 'health' ? 'ok' : 'ready';
      await waitForEndpoint(
        buildProbeUrl(options.baseUrl, path),
        expectedStatus,
        options.timeoutMs,
      );
    },
  };
}

async function runCommand(
  program: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveCommand, rejectCommand) => {
    execFile(
      program,
      args,
      {
        encoding: 'utf8',
        env: options.env ?? process.env,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      },
      (error, stdout) => {
        if (error) {
          rejectCommand(new Error('Application supervisor command failed.', { cause: error }));
          return;
        }
        resolveCommand({ stdout });
      },
    );
  });
}

function pm2PidConfirmsAbsent(result: CommandResult | void): boolean {
  if (result === undefined) {
    return false;
  }
  return result.stdout.trim() === '';
}

async function waitForEndpoint(
  url: string,
  expectedStatus: 'ok' | 'ready',
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Application endpoint probe timed out.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(REQUEST_TIMEOUT_MS, remainingMs),
    );
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json() as unknown;
        if (hasExpectedStatus(body, expectedStatus)) {
          return;
        }
      }
    } catch {
      // Retry until the bounded probe deadline.
    } finally {
      clearTimeout(timeout);
    }

    const retryRemainingMs = deadline - Date.now();
    if (retryRemainingMs <= 0) {
      throw new Error('Application endpoint probe timed out.');
    }
    await delay(Math.min(PROBE_RETRY_MS, retryRemainingMs));
  }
}

function hasExpectedStatus(value: unknown, expectedStatus: string): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).status === expectedStatus;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid application release arguments.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new Error('Invalid application release arguments.');
  }
  return url.toString();
}

function validateEndpointPath(value: string): string {
  if (
    !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
  ) {
    throw new Error('Invalid application release arguments.');
  }
  return value;
}

function buildProbeUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const target = new URL(validateEndpointPath(path), base);
  if (target.origin !== base.origin) {
    throw new Error('Invalid application release endpoint.');
  }
  return target.toString();
}

function parseBoundedInteger(
  value: string | undefined,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error('Invalid application release arguments.');
  }
  return parsed;
}

function createPm2ControlEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'PM2_HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL']) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

interface RehearsalDatabaseSnapshot {
  versionRows: Array<{ version: number; applied_at: number }>;
  sentinelFingerprint?: string;
  contentFingerprint: string;
  metadataFingerprint: string;
  delayedAttentionSchema: boolean;
  integrityOk: boolean;
  foreignKeysClean: boolean;
}

interface RehearsalLifecycle {
  events: string[];
  startedReleases: string[];
  supervisor: ApplicationSupervisor;
  probe: ApplicationProbe;
  startInitialAndProbe(): Promise<void>;
  crashCurrent(): Promise<void>;
  stopForCleanup(): Promise<boolean>;
  forceKillNow(): void;
}

async function runApplicationReleaseRehearsal(): Promise<RehearsalResult> {
  const workspace = mkdtempSync(join(tmpdir(), 'lethebot-application-release-rehearsal-'));
  let result: Omit<RehearsalResult, 'cleanup'> | undefined;
  let cleanupBeforeRemoval = { lockRemoved: false, temporaryLinksRemoved: false };
  let activationLifecycle: RehearsalLifecycle | undefined;
  let rollbackLifecycle: RehearsalLifecycle | undefined;
  let processesStopped = false;
  const forceKillChildren = (): void => {
    activationLifecycle?.forceKillNow();
    rollbackLifecycle?.forceKillNow();
  };
  process.once('exit', forceKillChildren);

  try {
    const [activationPort, rollbackPort] = await Promise.all([
      reserveLoopbackPort(),
      reserveLoopbackPort(),
    ]);
    const activationRoot = join(workspace, 'activation');
    const rollbackRoot = join(workspace, 'rollback');
    prepareRehearsalRoot(activationRoot);
    prepareRehearsalRoot(rollbackRoot);

    const activationDbPath = join(activationRoot, 'shared', 'data', 'lethebot.db');
    const rollbackDbPath = join(rollbackRoot, 'shared', 'data', 'lethebot.db');
    const activationDbBefore = inspectRehearsalDatabase(activationDbPath);
    const rollbackDbBefore = inspectRehearsalDatabase(rollbackDbPath);
    activationLifecycle = createRehearsalLifecycle(activationRoot, activationPort);
    await activationLifecycle.startInitialAndProbe();
    const activationAfterPrior = inspectRehearsalDatabase(activationDbPath);
    const activation = await activateApplicationRelease({
      rootDir: activationRoot,
      releaseId: 'B',
      supervisor: activationLifecycle.supervisor,
      probe: activationLifecycle.probe,
    });
    const activationAfterCandidate = inspectRehearsalDatabase(activationDbPath);
    await confirmApplicationRelease({
      rootDir: activationRoot,
      releaseId: activation.releaseId,
      operationId: activation.operationId,
      supervisor: activationLifecycle.supervisor,
      probe: activationLifecycle.probe,
    });

    rollbackLifecycle = createRehearsalLifecycle(rollbackRoot, rollbackPort, true);
    await rollbackLifecycle.startInitialAndProbe();
    const rollbackAfterPrior = inspectRehearsalDatabase(rollbackDbPath);
    let candidateFailureObserved = false;
    try {
      await activateApplicationRelease({
        rootDir: rollbackRoot,
        releaseId: 'B',
        supervisor: rollbackLifecycle.supervisor,
        probe: rollbackLifecycle.probe,
      });
    } catch (error) {
      if (error instanceof ApplicationRollbackError) {
        throw error;
      }
      candidateFailureObserved = error instanceof ApplicationReleaseError;
    }
    if (!candidateFailureObserved) {
      throw new Error('Application rollback rehearsal did not observe candidate failure.');
    }
    const rollbackAfterRestore = inspectRehearsalDatabase(rollbackDbPath);

    const activationEvents = activationLifecycle.events;
    const rollbackEvents = rollbackLifecycle.events;
    const activationExpected = [
      'stop:A',
      'start:B',
      'probe:health:B',
      'probe:readiness:B',
      'probe:health:B',
      'probe:readiness:B',
    ];
    const rollbackExpected = [
      'stop:A',
      'start:B',
      'probe:health:B',
      'probe:readiness:B',
      'stop:B',
      'start:A',
      'probe:health:A',
      'probe:readiness:A',
    ];
    const legacyAdopted = isCurrentLedger(activationAfterPrior)
      && isCurrentLedger(rollbackAfterPrior);
    const schemaVersionStable = sameVersionLedger(activationAfterPrior, activationAfterCandidate)
      && sameVersionLedger(rollbackAfterPrior, rollbackAfterRestore);
    const sentinelPreserved = sameSentinel(activationDbBefore, activationAfterPrior)
      && sameSentinel(activationAfterPrior, activationAfterCandidate)
      && sameSentinel(rollbackDbBefore, rollbackAfterPrior)
      && sameSentinel(rollbackAfterPrior, rollbackAfterRestore);
    const contentUnchanged = activationAfterPrior.contentFingerprint
      === activationAfterCandidate.contentFingerprint
      && rollbackAfterPrior.contentFingerprint === rollbackAfterRestore.contentFingerprint;
    const integrityOk = [
      activationAfterPrior,
      activationAfterCandidate,
      rollbackAfterPrior,
      rollbackAfterRestore,
    ].every((snapshot) => snapshot.integrityOk);
    const foreignKeysClean = [
      activationAfterPrior,
      activationAfterCandidate,
      rollbackAfterPrior,
      rollbackAfterRestore,
    ].every((snapshot) => snapshot.foreignKeysClean);
    const builtEntrypoints = arraysEqual(activationLifecycle.startedReleases, ['A', 'B'])
      && arraysEqual(rollbackLifecycle.startedReleases, ['A', 'B', 'A']);

    result = {
      success: arraysEqual(activationEvents, activationExpected)
        && arraysEqual(rollbackEvents, rollbackExpected),
      temporary: true,
      activation: {
        success: arraysEqual(activationEvents, activationExpected),
        currentIsCandidate: readCurrentRelease(activationRoot) === 'B',
        previousIsPrior: readPreviousRelease(activationRoot) === 'A',
        priorStoppedBeforeSwitch: activationEvents[0] === 'stop:A',
        candidateStartedAfterSwitch: activationEvents[1] === 'start:B',
        candidateHealthBeforeReadiness:
          activationEvents.indexOf('probe:health:B')
          < activationEvents.indexOf('probe:readiness:B'),
      },
      rollback: {
        candidateFailureObserved,
        success: arraysEqual(rollbackEvents, rollbackExpected),
        currentRestored: readCurrentRelease(rollbackRoot) === 'A',
        previousRestored: readPreviousRelease(rollbackRoot) === undefined,
        candidateStoppedBeforeRestore:
          rollbackEvents.indexOf('stop:B') < rollbackEvents.indexOf('start:A'),
        priorStartedAfterRestore: rollbackEvents.includes('start:A'),
        priorHealthBeforeReadiness:
          rollbackEvents.indexOf('probe:health:A')
          < rollbackEvents.indexOf('probe:readiness:A'),
      },
      sharedDatabase: {
        pathUnchanged:
          existsSync(activationDbPath) && existsSync(rollbackDbPath),
        contentUnchanged,
        legacyAdopted,
        schemaVersionStable,
        sentinelPreserved,
        integrityOk,
        foreignKeysClean,
      },
      runtime: {
        builtEntrypoints,
        activationReleasesStarted: activationLifecycle.startedReleases.length,
        rollbackReleasesStarted: rollbackLifecycle.startedReleases.length,
      },
    };

    cleanupBeforeRemoval = {
      lockRemoved:
        !existsSync(join(activationRoot, '.activation.lock'))
        && !existsSync(join(rollbackRoot, '.activation.lock')),
      temporaryLinksRemoved:
        hasNoTemporaryLinks(activationRoot) && hasNoTemporaryLinks(rollbackRoot),
    };
  } finally {
    const stopped = await Promise.all([
      activationLifecycle?.stopForCleanup() ?? Promise.resolve(true),
      rollbackLifecycle?.stopForCleanup() ?? Promise.resolve(true),
    ]);
    processesStopped = stopped.every(Boolean);
    process.off('exit', forceKillChildren);
    rmSync(workspace, { recursive: true, force: true });
  }

  if (!result) {
    throw new Error('Application rollback rehearsal did not complete.');
  }

  const finalResult: RehearsalResult = {
    ...result,
    cleanup: {
      ...cleanupBeforeRemoval,
      processesStopped,
      workspaceRemoved: !existsSync(workspace),
    },
  };
  finalResult.success = finalResult.success
    && finalResult.activation.currentIsCandidate
    && finalResult.activation.previousIsPrior
    && finalResult.rollback.currentRestored
    && finalResult.rollback.previousRestored
    && finalResult.sharedDatabase.pathUnchanged
    && finalResult.sharedDatabase.contentUnchanged
    && finalResult.sharedDatabase.legacyAdopted
    && finalResult.sharedDatabase.integrityOk
    && finalResult.sharedDatabase.foreignKeysClean
    && finalResult.runtime.builtEntrypoints
    && finalResult.cleanup.lockRemoved
    && finalResult.cleanup.temporaryLinksRemoved
    && finalResult.cleanup.processesStopped
    && finalResult.cleanup.workspaceRemoved;
  return finalResult;
}

async function runCrossVersionRehearsal(
  priorReleaseDir: string,
  candidateReleaseDir: string,
): Promise<CrossVersionRehearsalResult> {
  const releases = validateCrossVersionReleaseDirectories(
    priorReleaseDir,
    candidateReleaseDir,
  );
  const workspace = mkdtempSync(join(tmpdir(), 'lethebot-cross-version-rehearsal-'));
  const lifecycles: RehearsalLifecycle[] = [];
  let result: Omit<CrossVersionRehearsalResult, 'cleanup'> | undefined;
  let operationArtifactsRemoved = false;
  let processesStopped = false;
  const forceKillChildren = (): void => {
    for (const lifecycle of lifecycles) {
      lifecycle.forceKillNow();
    }
  };
  process.once('exit', forceKillChildren);

  try {
    const ports = await Promise.all([
      reserveLoopbackPort(),
      reserveLoopbackPort(),
      reserveLoopbackPort(),
    ]);
    const rollbackRoot = join(workspace, 'rollback');
    const recoveryRoot = join(workspace, 'recovery');
    const confirmationRoot = join(workspace, 'confirmation');
    for (const rootDir of [rollbackRoot, recoveryRoot, confirmationRoot]) {
      prepareCrossVersionRoot(rootDir, releases.prior, releases.candidate);
    }

    const rollbackDbPath = managedRehearsalDatabasePath(rollbackRoot);
    let rollbackCandidateSnapshot: RehearsalDatabaseSnapshot | undefined;
    const rollbackLifecycle = createRehearsalLifecycle(
      rollbackRoot,
      ports[0] as number,
      true,
      (kind, releaseId) => {
        if (kind === 'readiness' && releaseId === 'B' && !rollbackCandidateSnapshot) {
          rollbackCandidateSnapshot = inspectRehearsalDatabase(rollbackDbPath);
        }
      },
    );
    lifecycles.push(rollbackLifecycle);
    await rollbackLifecycle.startInitialAndProbe();
    const rollbackPriorSnapshot = inspectRehearsalDatabase(rollbackDbPath);
    let candidateFailureObserved = false;
    try {
      await activateApplicationRelease({
        rootDir: rollbackRoot,
        releaseId: 'B',
        supervisor: rollbackLifecycle.supervisor,
        probe: rollbackLifecycle.probe,
      });
    } catch (error) {
      candidateFailureObserved = error instanceof ApplicationReleaseError
        && error.code === 'activation-failed';
      if (!candidateFailureObserved) {
        throw error;
      }
    }
    const rollbackRestoredSnapshot = inspectRehearsalDatabase(rollbackDbPath);

    const recoveryDbPath = managedRehearsalDatabasePath(recoveryRoot);
    const recoveryLifecycle = createRehearsalLifecycle(recoveryRoot, ports[1] as number);
    lifecycles.push(recoveryLifecycle);
    await recoveryLifecycle.startInitialAndProbe();
    const recoveryPriorSnapshot = inspectRehearsalDatabase(recoveryDbPath);
    const recoveryActivation = await activateApplicationRelease({
      rootDir: recoveryRoot,
      releaseId: 'B',
      supervisor: recoveryLifecycle.supervisor,
      probe: recoveryLifecycle.probe,
    });
    const recoveryCandidateSnapshot = inspectRehearsalDatabase(recoveryDbPath);
    const recoveryPendingObserved = hasPendingRecoveryPoint(recoveryRoot);
    await recoveryLifecycle.crashCurrent();
    let restartDeniedWithoutPermit = false;
    try {
      await recoveryLifecycle.supervisor.start({ rootDir: recoveryRoot, releaseId: 'B' });
    } catch (error) {
      restartDeniedWithoutPermit = error instanceof ManagedStartupError;
    }
    if (!restartDeniedWithoutPermit) {
      throw new Error('Pending candidate restart was not denied by the startup gate.');
    }
    const recovery = await recoverInterruptedApplicationRelease({
      rootDir: recoveryRoot,
      supervisor: recoveryLifecycle.supervisor,
      probe: recoveryLifecycle.probe,
    });
    const recoveryRestoredSnapshot = inspectRehearsalDatabase(recoveryDbPath);

    const confirmationDbPath = managedRehearsalDatabasePath(confirmationRoot);
    const confirmationLifecycle = createRehearsalLifecycle(confirmationRoot, ports[2] as number);
    lifecycles.push(confirmationLifecycle);
    await confirmationLifecycle.startInitialAndProbe();
    const confirmationPriorSnapshot = inspectRehearsalDatabase(confirmationDbPath);
    const confirmationActivation = await activateApplicationRelease({
      rootDir: confirmationRoot,
      releaseId: 'B',
      supervisor: confirmationLifecycle.supervisor,
      probe: confirmationLifecycle.probe,
    });
    const confirmationCandidateSnapshot = inspectRehearsalDatabase(confirmationDbPath);
    const confirmationPendingObserved = hasPendingRecoveryPoint(confirmationRoot);
    const pendingStateBeforeWrongConfirmation = fingerprintPendingRecoveryPoint(confirmationRoot);
    let wrongConfirmationRejected = false;
    try {
      await confirmApplicationRelease({
        rootDir: confirmationRoot,
        releaseId: confirmationActivation.releaseId,
        operationId: differentOperationId(confirmationActivation.operationId),
        supervisor: confirmationLifecycle.supervisor,
        probe: confirmationLifecycle.probe,
      });
    } catch (error) {
      wrongConfirmationRejected = error instanceof ApplicationReleaseError
        && error.code === 'confirmation-required';
    }
    const wrongConfirmationPreservedState = pendingStateBeforeWrongConfirmation !== undefined
      && pendingStateBeforeWrongConfirmation === fingerprintPendingRecoveryPoint(confirmationRoot);
    const confirmation = await confirmApplicationRelease({
      rootDir: confirmationRoot,
      releaseId: confirmationActivation.releaseId,
      operationId: confirmationActivation.operationId,
      supervisor: confirmationLifecycle.supervisor,
      probe: confirmationLifecycle.probe,
    });
    const recoveryPointRemoved = !hasPendingRecoveryPoint(confirmationRoot)
      && hasNoCrossVersionOperationArtifacts(confirmationRoot);
    await confirmationLifecycle.crashCurrent();
    await confirmationLifecycle.supervisor.start({ rootDir: confirmationRoot, releaseId: 'B' });
    await confirmationLifecycle.probe.check('health');
    await confirmationLifecycle.probe.check('readiness');
    const confirmationRestartSnapshot = inspectRehearsalDatabase(confirmationDbPath);

    const rollbackDatabaseRestored = sameRehearsalDatabase(
      rollbackPriorSnapshot,
      rollbackRestoredSnapshot,
    );
    const recoveryDatabaseRestored = sameRehearsalDatabase(
      recoveryPriorSnapshot,
      recoveryRestoredSnapshot,
    );
    const rollbackPointersRestored = readCurrentRelease(rollbackRoot) === 'A'
      && readPreviousRelease(rollbackRoot) === undefined;
    const recoveryPointersRestored = readCurrentRelease(recoveryRoot) === 'A'
      && readPreviousRelease(recoveryRoot) === undefined;
    const rollbackPriorReady = releaseReadyAfterStart(rollbackLifecycle.events, 'A');
    const recoveryPriorReady = releaseReadyAfterStart(recoveryLifecycle.events, 'A');
    const markerFreeRestartReady = releaseReadyAfterStart(confirmationLifecycle.events, 'B');
    const allSnapshots = [
      rollbackPriorSnapshot,
      rollbackCandidateSnapshot,
      rollbackRestoredSnapshot,
      recoveryPriorSnapshot,
      recoveryCandidateSnapshot,
      recoveryRestoredSnapshot,
      confirmationPriorSnapshot,
      confirmationCandidateSnapshot,
      confirmationRestartSnapshot,
    ].filter((snapshot): snapshot is RehearsalDatabaseSnapshot => snapshot !== undefined);
    const priorSnapshots = [
      rollbackPriorSnapshot,
      recoveryPriorSnapshot,
      confirmationPriorSnapshot,
      rollbackRestoredSnapshot,
      recoveryRestoredSnapshot,
    ];
    const candidateSnapshots = [
      rollbackCandidateSnapshot,
      recoveryCandidateSnapshot,
      confirmationCandidateSnapshot,
      confirmationRestartSnapshot,
    ];
    const priorLedgerObserved = priorSnapshots.every(isPriorLedger);
    const priorColumnAbsent = priorSnapshots.every((snapshot) => !snapshot.delayedAttentionSchema);
    const candidateLedgerObserved = candidateSnapshots.every(
      (snapshot) => snapshot !== undefined && isCurrentLedger(snapshot),
    );
    const candidateColumnObserved = candidateSnapshots.every(
      (snapshot) => snapshot?.delayedAttentionSchema === true,
    );
    const sentinelPreserved = allSnapshots.every(
      (snapshot) => sameSentinel(rollbackPriorSnapshot, snapshot),
    );
    const integrityOk = allSnapshots.every((snapshot) => snapshot.integrityOk);
    const foreignKeysClean = allSnapshots.every((snapshot) => snapshot.foreignKeysClean);

    result = {
      success: candidateFailureObserved
        && rollbackDatabaseRestored
        && rollbackPriorSnapshot.metadataFingerprint
          === rollbackRestoredSnapshot.metadataFingerprint
        && rollbackPointersRestored
        && rollbackPriorReady
        && recoveryPendingObserved
        && restartDeniedWithoutPermit
        && recovery.recovered
        && recovery.restarted
        && recoveryDatabaseRestored
        && recoveryPriorSnapshot.metadataFingerprint
          === recoveryRestoredSnapshot.metadataFingerprint
        && recoveryPointersRestored
        && recoveryPriorReady
        && confirmationPendingObserved
        && wrongConfirmationRejected
        && wrongConfirmationPreservedState
        && confirmation.confirmed
        && recoveryPointRemoved
        && markerFreeRestartReady
        && priorLedgerObserved
        && priorColumnAbsent
        && candidateLedgerObserved
        && candidateColumnObserved
        && sentinelPreserved
        && integrityOk
        && foreignKeysClean,
      temporary: true,
      releasesDistinct: true,
      rollback: {
        candidateFailureObserved,
        candidateSchemaObserved:
          rollbackCandidateSnapshot !== undefined && isCurrentLedger(rollbackCandidateSnapshot),
        candidateColumnObserved: rollbackCandidateSnapshot?.delayedAttentionSchema === true,
        databaseRestored: rollbackDatabaseRestored,
        metadataRestored: rollbackPriorSnapshot.metadataFingerprint
          === rollbackRestoredSnapshot.metadataFingerprint,
        pointersRestored: rollbackPointersRestored,
        priorReady: rollbackPriorReady,
      },
      crashRecovery: {
        pendingCandidateObserved: recoveryPendingObserved,
        restartDeniedWithoutPermit,
        recovered: recovery.recovered && recovery.restarted,
        databaseRestored: recoveryDatabaseRestored,
        metadataRestored: recoveryPriorSnapshot.metadataFingerprint
          === recoveryRestoredSnapshot.metadataFingerprint,
        pointersRestored: recoveryPointersRestored,
        priorReady: recoveryPriorReady,
      },
      confirmation: {
        pendingCandidateObserved: confirmationPendingObserved,
        wrongConfirmationRejected,
        wrongConfirmationPreservedState,
        exactConfirmationSucceeded: confirmation.confirmed,
        recoveryPointRemoved,
        markerFreeRestartReady,
        candidateSchemaObserved: isCurrentLedger(confirmationRestartSnapshot),
        candidateColumnObserved: confirmationRestartSnapshot.delayedAttentionSchema,
      },
      sharedDatabase: {
        priorLedgerObserved,
        priorColumnAbsent,
        candidateLedgerObserved,
        sentinelPreserved,
        integrityOk,
        foreignKeysClean,
      },
    };

    operationArtifactsRemoved = [rollbackRoot, recoveryRoot, confirmationRoot]
      .every(hasNoCrossVersionOperationArtifacts);
    if (!operationArtifactsRemoved) {
      result.success = false;
    }
    void recoveryActivation;
  } finally {
    const stopped = await Promise.all(lifecycles.map((lifecycle) => lifecycle.stopForCleanup()));
    processesStopped = stopped.every(Boolean);
    process.off('exit', forceKillChildren);
    rmSync(workspace, { recursive: true, force: true });
  }

  if (!result) {
    throw new Error('Cross-version application release rehearsal did not complete.');
  }
  const finalResult: CrossVersionRehearsalResult = {
    ...result,
    cleanup: {
      operationArtifactsRemoved,
      processesStopped,
      workspaceRemoved: !existsSync(workspace),
    },
  };
  finalResult.success = finalResult.success
    && finalResult.cleanup.operationArtifactsRemoved
    && finalResult.cleanup.processesStopped
    && finalResult.cleanup.workspaceRemoved;
  return finalResult;
}

function validateCrossVersionReleaseDirectories(
  priorReleaseDir: string,
  candidateReleaseDir: string,
): { prior: string; candidate: string } {
  let prior: string;
  let candidate: string;
  try {
    prior = realpathSync(priorReleaseDir);
    candidate = realpathSync(candidateReleaseDir);
    if (
      prior === candidate
      || !lstatSync(prior).isDirectory()
      || !lstatSync(candidate).isDirectory()
      || !lstatSync(realpathSync(join(prior, 'node_modules'))).isDirectory()
      || !lstatSync(realpathSync(join(candidate, 'node_modules'))).isDirectory()
      || calculateManagedReleaseDigest(prior) === calculateManagedReleaseDigest(candidate)
    ) {
      throw new Error('invalid cross-version release directories');
    }
  } catch (error) {
    throw new Error('Cross-version release inputs are invalid.', { cause: error });
  }
  return { prior, candidate };
}

function prepareCrossVersionRoot(
  rootDir: string,
  priorReleaseDir: string,
  candidateReleaseDir: string,
): void {
  mkdirSync(join(rootDir, 'releases'), { recursive: true });
  mkdirSync(join(rootDir, 'shared', 'data'), { recursive: true });
  mkdirSync(join(rootDir, 'shared', 'logs'), { recursive: true });
  writeFileSync(join(rootDir, 'shared', 'runtime.env'), 'NODE_ENV=production\n', 'utf8');
  prepareCrossVersionDatabase(managedRehearsalDatabasePath(rootDir));
  copyCrossVersionRelease(priorReleaseDir, join(rootDir, 'releases', 'A'));
  copyCrossVersionRelease(candidateReleaseDir, join(rootDir, 'releases', 'B'));
  symlinkSync('releases/A', join(rootDir, 'current'));
}

function prepareCrossVersionDatabase(databasePath: string): void {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE release_rehearsal_sentinel (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO release_rehearsal_sentinel (id, value) VALUES (?, ?)',
    ).run(REHEARSAL_SENTINEL_ID, 'synthetic-preserved-value');
  } finally {
    db.close();
  }
  chmodSync(databasePath, 0o600);
}

function copyCrossVersionRelease(sourceDir: string, releaseDir: string): void {
  mkdirSync(releaseDir, { recursive: true });
  cpSync(join(sourceDir, 'dist'), join(releaseDir, 'dist'), { recursive: true });
  cpSync(join(sourceDir, 'migrations'), join(releaseDir, 'migrations'), { recursive: true });
  cpSync(join(sourceDir, 'package.json'), join(releaseDir, 'package.json'));
  cpSync(join(sourceDir, 'pnpm-lock.yaml'), join(releaseDir, 'pnpm-lock.yaml'));
  symlinkSync(
    realpathSync(join(sourceDir, 'node_modules')),
    join(releaseDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function managedRehearsalDatabasePath(rootDir: string): string {
  return join(rootDir, 'shared', 'data', 'lethebot.db');
}

function isPriorLedger(snapshot: RehearsalDatabaseSnapshot): boolean {
  const priorVersions = Array.from(
    { length: CURRENT_SCHEMA_VERSION - 1 },
    (_, index) => String(index + 1),
  );
  return arraysEqual(snapshot.versionRows.map((row) => String(row.version)), priorVersions);
}

function sameRehearsalDatabase(
  left: RehearsalDatabaseSnapshot,
  right: RehearsalDatabaseSnapshot,
): boolean {
  return sameVersionLedger(left, right)
    && left.contentFingerprint === right.contentFingerprint
    && sameSentinel(left, right)
    && left.integrityOk
    && right.integrityOk
    && left.foreignKeysClean
    && right.foreignKeysClean;
}

function releaseReadyAfterStart(events: string[], releaseId: string): boolean {
  const start = events.lastIndexOf(`start:${releaseId}`);
  const health = events.lastIndexOf(`probe:health:${releaseId}`);
  const readiness = events.lastIndexOf(`probe:readiness:${releaseId}`);
  return start !== -1 && start < health && health < readiness;
}

function hasPendingRecoveryPoint(rootDir: string): boolean {
  const rollbackDir = join(rootDir, '.release-rollback');
  return existsSync(join(rootDir, '.activation-state.json'))
    && existsSync(rollbackDir)
    && readdirSync(rollbackDir).some((entry) => entry.endsWith('.db'));
}

function fingerprintPendingRecoveryPoint(rootDir: string): string | undefined {
  const statePath = join(rootDir, '.activation-state.json');
  const rollbackDir = join(rootDir, '.release-rollback');
  if (!existsSync(statePath) || !existsSync(rollbackDir)) {
    return undefined;
  }
  const hash = createHash('sha256');
  hash.update(readFileSync(statePath));
  for (const entry of readdirSync(rollbackDir).sort()) {
    const path = join(rollbackDir, entry);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return undefined;
    }
    hash.update(entry);
    hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}

function differentOperationId(operationId: string): string {
  const first = '00000000-0000-4000-8000-000000000001';
  return operationId === first ? '00000000-0000-4000-8000-000000000002' : first;
}

function hasNoCrossVersionOperationArtifacts(rootDir: string): boolean {
  if (existsSync(join(rootDir, '.release-rollback'))) {
    return false;
  }
  const rootEntries = readdirSync(rootDir);
  if (rootEntries.some((entry) => {
    return entry === '.activation-state.json'
      || entry === '.activation-state.tmp'
      || entry === '.activation.lock'
      || entry.startsWith('.activation-lock-')
      || entry.startsWith('.startup-authorization')
      || entry.startsWith('.current.tmp-')
      || entry.startsWith('.previous.tmp-');
  })) {
    return false;
  }
  return !readdirSync(join(rootDir, 'shared', 'data'))
    .some((entry) => entry.startsWith('.release-restore-'));
}

function prepareRehearsalRoot(rootDir: string): void {
  mkdirSync(join(rootDir, 'releases'), { recursive: true });
  mkdirSync(join(rootDir, 'shared', 'data'), { recursive: true });
  mkdirSync(join(rootDir, 'shared', 'logs'), { recursive: true });
  writeFileSync(join(rootDir, 'shared', 'runtime.env'), 'NODE_ENV=production\n', 'utf8');
  symlinkSync(
    join(PROJECT_ROOT, 'node_modules'),
    join(rootDir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  prepareRehearsalDatabase(join(rootDir, 'shared', 'data', 'lethebot.db'));
  copyRehearsalRelease(join(rootDir, 'releases', 'A'));
  copyRehearsalRelease(join(rootDir, 'releases', 'B'));
  symlinkSync('releases/A', join(rootDir, 'current'));
}

function prepareRehearsalDatabase(databasePath: string): void {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(PROJECT_ROOT, 'migrations', '001_initial_schema.sql'), 'utf8'));
    db.exec(`
      CREATE TABLE release_rehearsal_sentinel (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    db.prepare(
      'INSERT INTO release_rehearsal_sentinel (id, value) VALUES (?, ?)',
    ).run(REHEARSAL_SENTINEL_ID, 'synthetic-preserved-value');
  } finally {
    db.close();
  }
  chmodSync(databasePath, 0o600);
}

function copyRehearsalRelease(releaseDir: string): void {
  mkdirSync(releaseDir, { recursive: true });
  cpSync(join(PROJECT_ROOT, 'dist'), join(releaseDir, 'dist'), { recursive: true });
  cpSync(join(PROJECT_ROOT, 'migrations'), join(releaseDir, 'migrations'), { recursive: true });
  cpSync(join(PROJECT_ROOT, 'package.json'), join(releaseDir, 'package.json'));
  cpSync(join(PROJECT_ROOT, 'pnpm-lock.yaml'), join(releaseDir, 'pnpm-lock.yaml'));
  symlinkSync('../../node_modules', join(releaseDir, 'node_modules'), 'dir');
}

function createRehearsalLifecycle(
  rootDir: string,
  port: number,
  failCandidateReadiness = false,
  onProbe?: (kind: ApplicationProbeKind, releaseId: string) => void,
): RehearsalLifecycle {
  const events: string[] = [];
  const startedReleases: string[] = [];
  const realProbe = createApplicationProbe({
    baseUrl: `http://127.0.0.1:${port}`,
    healthPath: '/healthz',
    readinessPath: '/readyz',
    timeoutMs: REHEARSAL_PROBE_TIMEOUT_MS,
  });
  let child: ChildProcess | undefined;
  let crashedCurrent = false;

  const startCurrent = async (): Promise<void> => {
    if (child && child.exitCode === null && child.signalCode === null) {
      throw new Error('Rehearsal process is already running.');
    }
    const releaseId = readCurrentRelease(rootDir);
    const entrypointPath = join(rootDir, 'current', 'dist', 'index.js');
    runManagedStartupGate({ rootDir, entrypointPath });
    events.push(`start:${releaseId}`);
    startedReleases.push(releaseId);
    crashedCurrent = false;
    const readinessPath = failCandidateReadiness && releaseId === 'B'
      ? '/rehearsal-candidate-not-ready'
      : '/readyz';
    child = spawn(
      process.execPath,
      [entrypointPath],
      {
        cwd: join(rootDir, 'current'),
        env: createRehearsalEnvironment(rootDir, port, readinessPath),
        stdio: 'ignore',
      },
    );
    child.once('error', () => undefined);
  };

  const stopCurrent = async (strict: boolean): Promise<boolean> => {
    const running = child;
    if (!running) {
      if (crashedCurrent) {
        crashedCurrent = false;
        return true;
      }
      if (strict) {
        throw new Error('Rehearsal process is not running.');
      }
      return true;
    }
    const alreadyExited = running.exitCode !== null || running.signalCode !== null;
    if (alreadyExited) {
      child = undefined;
      if (strict) {
        throw new Error('Rehearsal process exited before supervisor stop.');
      }
      return true;
    }

    const gracefulExit = waitForChildExit(running, REHEARSAL_STOP_TIMEOUT_MS);
    running.kill('SIGTERM');
    if (await gracefulExit) {
      child = undefined;
      return true;
    }

    const forcedExit = waitForChildExit(running, REHEARSAL_STOP_TIMEOUT_MS);
    running.kill('SIGKILL');
    const stopped = await forcedExit;
    if (stopped) {
      child = undefined;
    }
    if (strict) {
      throw new Error('Rehearsal process did not stop gracefully.');
    }
    return stopped;
  };

  const supervisor: ApplicationSupervisor = {
    async stop(): Promise<void> {
      events.push(`stop:${readCurrentRelease(rootDir)}`);
      await stopCurrent(true);
    },
    start: startCurrent,
  };
  const probe: ApplicationProbe = {
    async check(kind: ApplicationProbeKind): Promise<void> {
      const releaseId = readCurrentRelease(rootDir);
      events.push(`probe:${kind}:${releaseId}`);
      onProbe?.(kind, releaseId);
      await realProbe.check(kind);
    },
  };

  return {
    events,
    startedReleases,
    supervisor,
    probe,
    async startInitialAndProbe(): Promise<void> {
      await startCurrent();
      await probe.check('health');
      await probe.check('readiness');
      events.length = 0;
    },
    async crashCurrent(): Promise<void> {
      const running = child;
      if (!running || running.exitCode !== null || running.signalCode !== null) {
        child = undefined;
        crashedCurrent = true;
        return;
      }
      const exited = waitForChildExit(running, REHEARSAL_STOP_TIMEOUT_MS);
      running.kill('SIGKILL');
      if (!await exited) {
        throw new Error('Rehearsal process did not stop after a simulated crash.');
      }
      child = undefined;
      crashedCurrent = true;
    },
    async stopForCleanup(): Promise<boolean> {
      return stopCurrent(false);
    },
    forceKillNow(): void {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    },
  };
}

function createRehearsalEnvironment(
  rootDir: string,
  port: number,
  readinessPath: string,
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    LOG_LEVEL: 'fatal',
    LETHEBOT_TEST: 'true',
    LETHEBOT_BACKGROUND_SUMMARY_ENABLED: 'false',
    LETHEBOT_DB_PATH: join(rootDir, 'shared', 'data', 'lethebot.db'),
    LETHEBOT_HOST: '127.0.0.1',
    LETHEBOT_PORT: String(port),
    LETHEBOT_HEALTH_PATH: '/healthz',
    LETHEBOT_READINESS_PATH: readinessPath,
    LETHEBOT_METRICS_PATH: '/metrics',
    LETHEBOT_EVENT_PATH: '/onebot/event',
    PI_PROVIDER: 'mock',
    PI_MODEL: 'mock',
    PI_BASE_URL: 'http://127.0.0.1:9',
    ONEBOT_TRANSPORT: 'http',
    ONEBOT_HTTP_URL: 'http://127.0.0.1:9',
    ONEBOT_WS_URL: 'ws://127.0.0.1:9',
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Could not reserve a rehearsal loopback port.');
  }
  return port;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolveExit) => {
    const handleExit = (): void => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off('exit', handleExit);
      resolveExit(false);
    }, timeoutMs);
    child.once('exit', handleExit);
  });
}

function inspectRehearsalDatabase(databasePath: string): RehearsalDatabaseSnapshot {
  const stats = lstatSync(databasePath);
  const db = new Database(databasePath, { readonly: true });
  try {
    db.pragma('foreign_keys = ON');
    const versionRows = db.prepare(
      'SELECT version, applied_at FROM schema_version ORDER BY version',
    ).all() as Array<{ version: number; applied_at: number }>;
    const sentinel = db.prepare(
      'SELECT id, value FROM release_rehearsal_sentinel WHERE id = ?',
    ).get(REHEARSAL_SENTINEL_ID) as { id: string; value: string } | undefined;
    const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    return {
      versionRows,
      sentinelFingerprint: sentinel === undefined
        ? undefined
        : createHash('sha256').update(JSON.stringify(sentinel)).digest('hex'),
      contentFingerprint: fingerprintRehearsalDatabase(db),
      metadataFingerprint: `${stats.mode & 0o777}:${stats.uid}:${stats.gid}`,
      delayedAttentionSchema: hasDelayedAttentionSchema(db),
      integrityOk:
        integrityRows.length === 1 && Object.values(integrityRows[0] ?? {})[0] === 'ok',
      foreignKeysClean: db.prepare('PRAGMA foreign_key_check').all().length === 0,
    };
  } finally {
    db.close();
  }
}

function hasDelayedAttentionSchema(db: Database.Database): boolean {
  return hasTableColumns(db, 'attention_candidates', [
    'source_raw_event_id',
    'source_chat_message_id',
    'job_id',
    'conversation_id',
    'conversation_type',
    'group_id',
    'candidate_kind',
    'policy_version',
    'observed_at',
    'not_before_at',
    'expires_at',
  ])
    && hasTableColumns(db, 'attention_decisions', [
      'candidate_id',
      'job_id',
      'job_attempt_id',
      'outcome',
      'decided_at',
    ])
    && hasTableColumns(db, 'attention_suppressors', [
      'decision_id',
      'candidate_id',
      'decision_outcome',
      'code',
      'evidence_chat_message_id',
      'observed_count',
      'window_ms',
      'created_at',
    ]);
}

function hasTableColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`)
    .all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function hasTableColumns(
  db: Database.Database,
  tableName: string,
  columnNames: string[],
): boolean {
  return columnNames.every((columnName) => hasTableColumn(db, tableName, columnName));
}

function fingerprintRehearsalDatabase(db: Database.Database): string {
  const hash = createHash('sha256');
  const objects = db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  ).all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
  hash.update(JSON.stringify(objects));

  for (const object of objects) {
    if (object.type !== 'table') {
      continue;
    }
    const rows = db.prepare(`SELECT * FROM ${quoteSqlIdentifier(object.name)}`).all();
    const serializedRows = rows.map((row) => JSON.stringify(row)).sort();
    hash.update(object.name);
    hash.update(JSON.stringify(serializedRows));
  }
  return hash.digest('hex');
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function isCurrentLedger(snapshot: RehearsalDatabaseSnapshot): boolean {
  const currentVersions = Array.from(
    { length: CURRENT_SCHEMA_VERSION },
    (_, index) => String(index + 1),
  );
  return arraysEqual(snapshot.versionRows.map((row) => String(row.version)), currentVersions);
}

function sameVersionLedger(
  left: RehearsalDatabaseSnapshot,
  right: RehearsalDatabaseSnapshot,
): boolean {
  return left.versionRows.length === right.versionRows.length
    && left.versionRows.every((row, index) => {
      const other = right.versionRows[index];
      return other !== undefined
        && row.version === other.version
        && row.applied_at === other.applied_at;
    });
}

function sameSentinel(left: RehearsalDatabaseSnapshot, right: RehearsalDatabaseSnapshot): boolean {
  return left.sentinelFingerprint !== undefined
    && left.sentinelFingerprint === right.sentinelFingerprint;
}

function readCurrentRelease(rootDir: string): string {
  return readManagedRelease(rootDir, 'current') ?? '';
}

function readPreviousRelease(rootDir: string): string | undefined {
  return readManagedRelease(rootDir, 'previous');
}

function readManagedRelease(rootDir: string, pointer: 'current' | 'previous'): string | undefined {
  const pointerPath = join(rootDir, pointer);
  if (!existsSync(pointerPath)) {
    return undefined;
  }
  const target = readlinkSync(pointerPath);
  return target.startsWith('releases/') ? target.slice('releases/'.length) : undefined;
}

function hasNoTemporaryLinks(rootDir: string): boolean {
  return readdirSync(rootDir).every((entry) => {
    return entry !== '.activation-state.json'
      && entry !== '.activation-state.tmp'
      && !(entry.startsWith('.activation-') && entry.endsWith('.tmp'))
      && !entry.startsWith('.current.tmp-')
      && !entry.startsWith('.previous.tmp-');
  });
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function main(): Promise<void> {
  let options: ApplicationReleaseCliOptions;
  try {
    options = parseApplicationReleaseCliArgs(process.argv.slice(2));
  } catch {
    process.stderr.write('Invalid application release arguments.\n');
    process.exitCode = 1;
    return;
  }

  try {
    if (options.command === 'rehearse') {
      const rehearsal = await runApplicationReleaseRehearsal();
      process.stdout.write(`${JSON.stringify(rehearsal)}\n`);
      if (!rehearsal.success) {
        process.exitCode = 1;
      }
      return;
    }
    if (options.command === 'rehearse-cross-version') {
      const rehearsal = await runCrossVersionRehearsal(
        options.priorReleaseDir,
        options.candidateReleaseDir,
      );
      process.stdout.write(`${JSON.stringify(rehearsal)}\n`);
      if (!rehearsal.success) {
        process.exitCode = 1;
      }
      return;
    }

    const probe = createApplicationProbe({
      baseUrl: options.baseUrl,
      healthPath: options.healthPath,
      readinessPath: options.readinessPath,
      timeoutMs: options.probeTimeoutMs,
    });
    if (options.command === 'confirm') {
      const supervisor = createApplicationSupervisor(options.manager, options.rootDir);
      const confirmation = await confirmApplicationRelease({
        rootDir: options.rootDir,
        releaseId: options.releaseId,
        operationId: options.operationId,
        supervisor,
        probe,
        lockTimeoutMs: options.lockTimeoutMs,
      });
      process.stdout.write(`${JSON.stringify({
        success: true,
        manager: options.manager,
        confirmed: confirmation.confirmed,
        healthChecked: true,
        readinessChecked: true,
      })}\n`);
      return;
    }

    const supervisor = createApplicationSupervisor(options.manager, options.rootDir);
    if (options.command === 'recover') {
      const recovery = await recoverInterruptedApplicationRelease({
        rootDir: options.rootDir,
        supervisor,
        probe,
        lockTimeoutMs: options.lockTimeoutMs,
      });
      process.stdout.write(`${JSON.stringify({
        success: true,
        manager: options.manager,
        recovered: recovery.recovered,
        restarted: recovery.restarted,
        healthChecked: recovery.restarted,
        readinessChecked: recovery.restarted,
      })}\n`);
      return;
    }

    const activation = await activateApplicationRelease({
      rootDir: options.rootDir,
      releaseId: options.releaseId,
      supervisor,
      probe,
      lockTimeoutMs: options.lockTimeoutMs,
    });
    process.stdout.write(`${JSON.stringify({
      success: true,
      manager: options.manager,
      previousReleasePresent: activation.previousReleaseId !== undefined,
      confirmationRequired: activation.confirmationRequired,
      operationId: activation.operationId,
      healthChecked: true,
      readinessChecked: true,
    })}\n`);
  } catch (error) {
    if (error instanceof ApplicationReleaseCleanupError) {
      const operation = error.operationCode === undefined
        ? 'activation-result-unknown'
        : error.operationCode;
      const rollback = error.rollbackFailures.length === 0
        ? ''
        : `(${error.rollbackFailures.join(',')})`;
      process.stderr.write(
        `Application release failed: cleanup-failed after ${operation}${rollback}.\n`,
      );
    } else if (error instanceof ApplicationRollbackError) {
      process.stderr.write(
        `Application release failed: rollback-failed (${error.rollbackFailures.join(',')}).\n`,
      );
    } else if (error instanceof ApplicationReleaseError) {
      process.stderr.write(`Application release failed: ${error.code}.\n`);
    } else {
      process.stderr.write('Application release command failed.\n');
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main();
}
