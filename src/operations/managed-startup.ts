import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  calculateManagedReleaseDigest,
  managedReleaseMatches,
} from './release-artifact.js';

interface ManagedStartupAuthorization {
  schemaVersion: 2;
  operationId: string;
  releaseId: string;
  releaseDigest: string;
  rootIdentity: string;
}

interface PersistedPointerState {
  current: string | null;
  previous: string | null;
}

interface PendingActivationState {
  schemaVersion: 1 | 2;
  operationId: string;
  candidateReleaseId: string;
  candidateDigest?: string;
  originalReleaseDigest?: string | null;
  originalPointers: PersistedPointerState;
  targetPointers: PersistedPointerState;
}

interface BoundedJson {
  identity: string;
  value: unknown;
}

export interface ManagedStartupAuthorizationInput {
  rootDir: string;
  operationId: string;
  releaseId: string;
}

export interface ManagedStartupGateInput {
  rootDir: string;
  entrypointPath: string;
}

export class ManagedStartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedStartupError';
  }
}

export const MANAGED_STARTUP_DENIED_EXIT_CODE = 78;
export const MANAGED_STARTUP_PROTOCOL_VERSION = 3;

const ACTIVATION_STATE_FILE = '.activation-state.json';
const ACTIVATION_STATE_TEMP_FILE = '.activation-state.tmp';
const AUTHORIZATION_FILE = '.startup-authorization.json';
const AUTHORIZATION_CLAIMED_FILE = '.startup-authorization.claimed';
const AUTHORIZATION_TEMP_PREFIX = '.startup-authorization-';
const AUTHORIZATION_TEMP_SUFFIX = '.tmp';
const MAX_ACTIVATION_STATE_BYTES = 8 * 1024;
const MAX_AUTHORIZATION_BYTES = 2 * 1024;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function runManagedStartupGate(input: ManagedStartupGateInput): void {
  const rootDir = validateManagedRoot(input.rootDir);
  assertActivationTempMissing(rootDir);
  const state = readPendingActivationState(rootDir, true);
  if (state === undefined) {
    assertManagedStartupAuthorizationClean(rootDir);
    const releaseId = readCurrentReleaseId(rootDir);
    assertEntrypointMatches(rootDir, releaseId, input.entrypointPath);
    return;
  }

  assertNoAuthorizationTemps(rootDir);
  assertPathMissing(join(rootDir, AUTHORIZATION_CLAIMED_FILE));
  const authorizationPath = join(rootDir, AUTHORIZATION_FILE);
  const observed = readAuthorization(authorizationPath);
  validateAuthorizationAgainstState(
    rootDir,
    observed.authorization,
    state,
    input.entrypointPath,
  );

  const claimedPath = join(rootDir, AUTHORIZATION_CLAIMED_FILE);
  try {
    renameSync(authorizationPath, claimedPath);
    syncDirectory(rootDir);
  } catch (error) {
    throw startupError('Managed startup authorization could not be claimed.', error);
  }

  const claimed = readAuthorization(claimedPath);
  if (claimed.identity !== observed.identity) {
    throw new ManagedStartupError('Managed startup authorization changed while being claimed.');
  }
  const claimedState = readRequiredPendingActivationState(rootDir);
  validateAuthorizationAgainstState(
    rootDir,
    claimed.authorization,
    claimedState,
    input.entrypointPath,
  );
  if (!authorizationsEqual(observed.authorization, claimed.authorization)) {
    throw new ManagedStartupError('Managed startup authorization changed while being claimed.');
  }
}

export function persistManagedStartupAuthorization(
  input: ManagedStartupAuthorizationInput,
): void {
  const rootDir = validateManagedRoot(input.rootDir);
  assertActivationTempMissing(rootDir);
  const state = readRequiredPendingActivationState(rootDir);
  if (state.operationId !== input.operationId || !OPERATION_ID_PATTERN.test(input.operationId)) {
    throw new ManagedStartupError('Managed startup authorization has a foreign operation owner.');
  }

  reconcileOwnedAuthorizationTemp(rootDir, input.operationId);
  assertPathMissing(join(rootDir, AUTHORIZATION_FILE));
  assertPathMissing(join(rootDir, AUTHORIZATION_CLAIMED_FILE));

  const releaseDir = join(rootDir, 'releases', input.releaseId);
  let releaseDigest: string;
  try {
    releaseDigest = calculateManagedReleaseDigest(releaseDir);
  } catch (error) {
    throw startupError('Managed startup release artifacts are invalid or missing.', error);
  }
  const authorization = validateAuthorization({
    schemaVersion: 2,
    operationId: input.operationId,
    releaseId: input.releaseId,
    releaseDigest,
    rootIdentity: managedRootIdentity(rootDir),
  });
  validateAuthorizationAgainstState(rootDir, authorization, state, undefined);

  const temporaryPath = authorizationTempPath(rootDir, input.operationId);
  const authorizationPath = join(rootDir, AUTHORIZATION_FILE);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(authorization)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, authorizationPath);
    syncDirectory(rootDir);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    removeOwnedRegularFileIfPresent(temporaryPath);
    throw startupError('Managed startup authorization could not be persisted.', error);
  }
}

export function completeManagedStartupAuthorization(
  rootDir: string,
  operationId: string,
): void {
  const validatedRoot = validateManagedRoot(rootDir);
  const state = readRequiredPendingActivationState(validatedRoot);
  if (state.operationId !== operationId || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new ManagedStartupError('Managed startup authorization has a foreign operation owner.');
  }
  assertNoAuthorizationTemps(validatedRoot);
  assertPathMissing(join(validatedRoot, AUTHORIZATION_FILE));

  const claimedPath = join(validatedRoot, AUTHORIZATION_CLAIMED_FILE);
  const claimed = readAuthorization(claimedPath);
  if (claimed.authorization.operationId !== operationId) {
    throw new ManagedStartupError('Managed startup authorization has a foreign operation owner.');
  }
  validateAuthorizationAgainstState(validatedRoot, claimed.authorization, state, undefined);
  if (managedEntryObjectIdentity(claimedPath) !== claimed.identity) {
    throw new ManagedStartupError('Managed startup authorization changed before completion.');
  }
  rmSync(claimedPath);
  syncDirectory(validatedRoot);
}

export function clearManagedStartupAuthorization(rootDir: string, operationId: string): void {
  const validatedRoot = validateManagedRoot(rootDir);
  const state = readRequiredPendingActivationState(validatedRoot);
  if (state.operationId !== operationId || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new ManagedStartupError('Managed startup authorization has a foreign operation owner.');
  }

  let removed = reconcileOwnedAuthorizationTemp(validatedRoot, operationId);
  for (const name of [AUTHORIZATION_FILE, AUTHORIZATION_CLAIMED_FILE]) {
    const path = join(validatedRoot, name);
    if (pathKind(path) === 'missing') {
      continue;
    }
    const observed = readAuthorization(path);
    if (observed.authorization.operationId !== operationId) {
      throw new ManagedStartupError('Managed startup authorization has a foreign operation owner.');
    }
    if (managedEntryObjectIdentity(path) !== observed.identity) {
      throw new ManagedStartupError('Managed startup authorization changed before cleanup.');
    }
    rmSync(path);
    removed = true;
  }
  if (removed) {
    syncDirectory(validatedRoot);
  }
}

export function assertManagedStartupAuthorizationClean(rootDir: string): void {
  assertPathMissing(join(rootDir, AUTHORIZATION_FILE));
  assertPathMissing(join(rootDir, AUTHORIZATION_CLAIMED_FILE));
  assertNoAuthorizationTemps(rootDir);
}

export function assertManagedStartupAuthorizationOwned(
  rootDir: string,
  operationId: string,
): void {
  const validatedRoot = validateManagedRoot(rootDir);
  const state = readRequiredPendingActivationState(validatedRoot);
  if (state.operationId !== operationId || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new ManagedStartupError('Managed startup authorization has a foreign operation owner.');
  }
  const expectedTemp = `${AUTHORIZATION_TEMP_PREFIX}${operationId}${AUTHORIZATION_TEMP_SUFFIX}`;
  const temps = authorizationTempNames(validatedRoot);
  if (temps.some((name) => name !== expectedTemp)) {
    throw new ManagedStartupError('Managed startup authorization has a foreign operation owner.');
  }
  if (temps.includes(expectedTemp)) {
    const stats = lstatSync(join(validatedRoot, expectedTemp));
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ManagedStartupError('Managed startup authorization temp is not a regular file.');
    }
  }

  let publishedArtifacts = 0;
  for (const name of [AUTHORIZATION_FILE, AUTHORIZATION_CLAIMED_FILE]) {
    const path = join(validatedRoot, name);
    if (pathKind(path) === 'missing') {
      continue;
    }
    publishedArtifacts += 1;
    if (readAuthorization(path).authorization.operationId !== operationId) {
      throw new ManagedStartupError('Managed startup authorization has a foreign operation owner.');
    }
  }
  if (publishedArtifacts > 1) {
    throw new ManagedStartupError('Managed startup authorization has conflicting artifacts.');
  }
}

function validateAuthorizationAgainstState(
  rootDir: string,
  authorization: ManagedStartupAuthorization,
  state: PendingActivationState,
  entrypointPath: string | undefined,
): void {
  if (authorization.operationId !== state.operationId) {
    throw new ManagedStartupError('Managed startup authorization does not match the pending operation.');
  }
  if (authorization.rootIdentity !== managedRootIdentity(rootDir)) {
    throw new ManagedStartupError('Managed startup authorization does not match the deployment root.');
  }
  const currentReleaseId = readCurrentReleaseId(rootDir);
  if (authorization.releaseId !== currentReleaseId) {
    throw new ManagedStartupError('Managed startup authorization does not match the current release.');
  }
  if (
    state.schemaVersion === 2
    && currentReleaseId === state.candidateReleaseId
    && authorization.releaseDigest !== state.candidateDigest
  ) {
    throw new ManagedStartupError('Managed startup authorization does not match the candidate digest.');
  }
  if (
    state.schemaVersion === 2
    && currentReleaseId === state.originalPointers.current
    && authorization.releaseDigest !== state.originalReleaseDigest
  ) {
    throw new ManagedStartupError('Managed startup authorization does not match the rollback digest.');
  }
  if (!managedReleaseMatches(
    join(rootDir, 'releases', currentReleaseId),
    authorization.releaseDigest,
  )) {
    throw new ManagedStartupError('Managed startup release changed after authorization.');
  }
  if (entrypointPath !== undefined) {
    assertEntrypointMatches(rootDir, currentReleaseId, entrypointPath);
  }
}

function assertEntrypointMatches(rootDir: string, releaseId: string, entrypointPath: string): void {
  const expectedPath = join(rootDir, 'releases', releaseId, 'dist', 'index.js');
  try {
    const expectedStats = lstatSync(expectedPath);
    if (!expectedStats.isFile() || expectedStats.isSymbolicLink()) {
      throw new Error('not a managed entrypoint');
    }
    if (realpathSync(entrypointPath) !== realpathSync(expectedPath)) {
      throw new Error('entrypoint mismatch');
    }
  } catch (error) {
    throw startupError('Managed startup entrypoint does not match the authorized release.', error);
  }
}

function readCurrentReleaseId(rootDir: string): string {
  const currentPath = join(rootDir, 'current');
  try {
    const stats = lstatSync(currentPath);
    if (!stats.isSymbolicLink()) {
      throw new Error('current is not a symbolic link');
    }
    const target = readlinkSync(currentPath);
    const prefix = 'releases/';
    if (!target.startsWith(prefix)) {
      throw new Error('current target is outside releases');
    }
    const releaseId = target.slice(prefix.length);
    if (!isValidReleaseId(releaseId) || target !== `${prefix}${releaseId}`) {
      throw new Error('current target is invalid');
    }
    assertReleaseDirectory(rootDir, releaseId);
    return releaseId;
  } catch (error) {
    throw startupError('Managed current release pointer is invalid.', error);
  }
}

function readAuthorization(path: string): {
  authorization: ManagedStartupAuthorization;
  identity: string;
} {
  const observed = readBoundedJson(path, MAX_AUTHORIZATION_BYTES, true);
  return {
    authorization: validateAuthorization(observed.value),
    identity: observed.identity,
  };
}

function validateAuthorization(value: unknown): ManagedStartupAuthorization {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'operationId',
      'releaseId',
      'releaseDigest',
      'rootIdentity',
    ])
    || value.schemaVersion !== 2
    || typeof value.operationId !== 'string'
    || !OPERATION_ID_PATTERN.test(value.operationId)
    || typeof value.releaseId !== 'string'
    || !isValidReleaseId(value.releaseId)
    || typeof value.releaseDigest !== 'string'
    || !SHA256_PATTERN.test(value.releaseDigest)
    || typeof value.rootIdentity !== 'string'
    || value.rootIdentity.length > 1024
  ) {
    throw new ManagedStartupError('Managed startup authorization is invalid.');
  }
  return {
    schemaVersion: 2,
    operationId: value.operationId,
    releaseId: value.releaseId,
    releaseDigest: value.releaseDigest,
    rootIdentity: value.rootIdentity,
  };
}

function readPendingActivationState(
  rootDir: string,
  allowMissing: boolean,
): PendingActivationState | undefined {
  const path = join(rootDir, ACTIVATION_STATE_FILE);
  if (allowMissing && pathKind(path) === 'missing') {
    return undefined;
  }
  const observed = readBoundedJson(path, MAX_ACTIVATION_STATE_BYTES, false);
  return validatePendingActivationState(observed.value, rootDir);
}

function readRequiredPendingActivationState(rootDir: string): PendingActivationState {
  const state = readPendingActivationState(rootDir, false);
  if (state === undefined) {
    throw new ManagedStartupError('Managed activation state is missing.');
  }
  return state;
}

function validatePendingActivationState(value: unknown, rootDir: string): PendingActivationState {
  if (!isRecord(value)) {
    throw new ManagedStartupError('Managed activation state is invalid.');
  }
  const legacy = value.schemaVersion === 1;
  const expectedKeys = legacy
    ? [
        'schemaVersion',
        'operationId',
        'operationKind',
        'candidateReleaseId',
        'originalPointers',
        'targetPointers',
      ]
    : [
        'schemaVersion',
        'operationId',
        'operationKind',
        'phase',
        'candidateReleaseId',
        'candidateDigest',
        'originalReleaseDigest',
        'originalPointers',
        'targetPointers',
        'rollbackSnapshot',
      ];
  if (
    !hasExactKeys(value, expectedKeys)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || value.operationKind !== 'activation'
    || typeof value.operationId !== 'string'
    || !OPERATION_ID_PATTERN.test(value.operationId)
    || typeof value.candidateReleaseId !== 'string'
    || !isValidReleaseId(value.candidateReleaseId)
  ) {
    throw new ManagedStartupError('Managed activation state is invalid.');
  }

  const originalPointers = validatePointerState(value.originalPointers);
  const targetPointers = validatePointerState(value.targetPointers);
  if (
    (originalPointers.current === null && originalPointers.previous !== null)
    || (originalPointers.current !== null && originalPointers.current === originalPointers.previous)
    || originalPointers.current === value.candidateReleaseId
    || targetPointers.current !== value.candidateReleaseId
    || targetPointers.previous !== originalPointers.current
  ) {
    throw new ManagedStartupError('Managed activation state pointers are incoherent.');
  }

  for (const releaseId of new Set([
    value.candidateReleaseId,
    originalPointers.current,
    originalPointers.previous,
  ])) {
    if (releaseId !== null) {
      assertReleaseDirectory(rootDir, releaseId);
    }
  }

  if (!legacy) {
    validateV2ActivationMetadata(value);
  }
  return {
    schemaVersion: value.schemaVersion,
    operationId: value.operationId,
    candidateReleaseId: value.candidateReleaseId,
    ...(legacy ? {} : { candidateDigest: value.candidateDigest as string }),
    ...(legacy ? {} : { originalReleaseDigest: value.originalReleaseDigest as string | null }),
    originalPointers,
    targetPointers,
  };
}

function validateV2ActivationMetadata(value: Record<string, unknown>): void {
  if (
    value.phase !== 'intent_recorded'
    && value.phase !== 'snapshot_ready'
    && value.phase !== 'awaiting_confirmation'
    && value.phase !== 'rollback_completed'
    && value.phase !== 'confirming'
  ) {
    throw new ManagedStartupError('Managed activation state phase is invalid.');
  }
  if (typeof value.candidateDigest !== 'string' || !SHA256_PATTERN.test(value.candidateDigest)) {
    throw new ManagedStartupError('Managed activation candidate digest is invalid.');
  }
  const originalPointers = validatePointerState(value.originalPointers);
  if (
    originalPointers.current === null
      ? value.originalReleaseDigest !== null
      : typeof value.originalReleaseDigest !== 'string'
        || !SHA256_PATTERN.test(value.originalReleaseDigest)
  ) {
    throw new ManagedStartupError('Managed activation rollback digest is invalid.');
  }
  const snapshot = validateRollbackSnapshot(value.rollbackSnapshot);
  if (
    value.phase === 'intent_recorded'
      ? snapshot !== null
      : value.phase !== 'rollback_completed' && snapshot === null
  ) {
    throw new ManagedStartupError('Managed activation rollback snapshot is incoherent.');
  }
}

function validateRollbackSnapshot(value: unknown): object | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    'sourceExisted',
    'sha256',
    'schemaVersion',
    'sourceMode',
    'sourceUid',
    'sourceGid',
  ])) {
    throw new ManagedStartupError('Managed activation rollback snapshot is invalid.');
  }
  if (typeof value.sourceExisted !== 'boolean') {
    throw new ManagedStartupError('Managed activation rollback snapshot is invalid.');
  }
  if (!value.sourceExisted) {
    if (
      value.sha256 !== null
      || value.schemaVersion !== null
      || value.sourceMode !== null
      || value.sourceUid !== null
      || value.sourceGid !== null
    ) {
      throw new ManagedStartupError('Managed activation rollback snapshot is invalid.');
    }
    return value;
  }
  if (
    typeof value.sha256 !== 'string'
    || !SHA256_PATTERN.test(value.sha256)
    || typeof value.schemaVersion !== 'number'
    || !Number.isSafeInteger(value.schemaVersion)
    || value.schemaVersion < 0
    || typeof value.sourceMode !== 'number'
    || !Number.isSafeInteger(value.sourceMode)
    || value.sourceMode < 0
    || value.sourceMode > 0o777
    || typeof value.sourceUid !== 'number'
    || !Number.isSafeInteger(value.sourceUid)
    || value.sourceUid < 0
    || typeof value.sourceGid !== 'number'
    || !Number.isSafeInteger(value.sourceGid)
    || value.sourceGid < 0
  ) {
    throw new ManagedStartupError('Managed activation rollback snapshot is invalid.');
  }
  return value;
}

function validatePointerState(value: unknown): PersistedPointerState {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['current', 'previous'])
    || !isNullableReleaseId(value.current)
    || !isNullableReleaseId(value.previous)
  ) {
    throw new ManagedStartupError('Managed activation pointer state is invalid.');
  }
  return { current: value.current, previous: value.previous };
}

function readBoundedJson(path: string, maximumBytes: number, privateFile: boolean): BoundedJson {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile()
      || stats.size > maximumBytes
      || (privateFile && (stats.mode & 0o777) !== 0o600)
    ) {
      throw new ManagedStartupError('Managed startup state is not a bounded regular file.');
    }
    const content = readFileSync(descriptor, 'utf8');
    const identity = `${stats.dev}:${stats.ino}`;
    const after = fstatSync(descriptor);
    if (`${after.dev}:${after.ino}` !== identity || after.size !== stats.size) {
      throw new ManagedStartupError('Managed startup state changed while being read.');
    }
    return { identity, value: JSON.parse(content) as unknown };
  } catch (error) {
    throw startupError('Managed startup state is missing, unreadable, or invalid.', error);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function validateManagedRoot(rootDir: string): string {
  if (!isAbsolute(rootDir) || resolve(rootDir) !== rootDir) {
    throw new ManagedStartupError('Managed deployment root must be an absolute normalized path.');
  }
  try {
    const stats = lstatSync(rootDir);
    if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(rootDir) !== rootDir) {
      throw new Error('not a canonical managed root directory');
    }
  } catch (error) {
    throw startupError('Managed deployment root is invalid or missing.', error);
  }
  return rootDir;
}

function managedRootIdentity(rootDir: string): string {
  const stats = lstatSync(rootDir);
  return `${realpathSync(rootDir)}:${stats.dev}:${stats.ino}`;
}

function assertReleaseDirectory(rootDir: string, releaseId: string): void {
  try {
    const stats = lstatSync(join(rootDir, 'releases', releaseId));
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('not a managed release directory');
    }
  } catch (error) {
    throw startupError('Managed activation state references an invalid release.', error);
  }
}

function assertActivationTempMissing(rootDir: string): void {
  assertPathMissing(join(rootDir, ACTIVATION_STATE_TEMP_FILE));
}

function assertNoAuthorizationTemps(rootDir: string): void {
  if (authorizationTempNames(rootDir).length > 0) {
    throw new ManagedStartupError('Managed startup has an unexpected pending artifact.');
  }
}

function reconcileOwnedAuthorizationTemp(rootDir: string, operationId: string): boolean {
  const expectedName = `${AUTHORIZATION_TEMP_PREFIX}${operationId}${AUTHORIZATION_TEMP_SUFFIX}`;
  const names = authorizationTempNames(rootDir);
  if (names.some((name) => name !== expectedName)) {
    throw new ManagedStartupError('Managed startup authorization has a foreign operation owner.');
  }
  if (!names.includes(expectedName)) {
    return false;
  }
  const path = join(rootDir, expectedName);
  removeOwnedRegularFileIfPresent(path);
  syncDirectory(rootDir);
  return true;
}

function authorizationTempNames(rootDir: string): string[] {
  return readdirSync(rootDir)
    .filter((name) => {
      return name.startsWith(AUTHORIZATION_TEMP_PREFIX)
        && name.endsWith(AUTHORIZATION_TEMP_SUFFIX);
    });
}

function authorizationTempPath(rootDir: string, operationId: string): string {
  return join(
    rootDir,
    `${AUTHORIZATION_TEMP_PREFIX}${operationId}${AUTHORIZATION_TEMP_SUFFIX}`,
  );
}

function removeOwnedRegularFileIfPresent(path: string): void {
  if (pathKind(path) === 'missing') {
    return;
  }
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ManagedStartupError('Managed startup authorization temp is not a regular file.');
  }
  rmSync(path);
}

function assertPathMissing(path: string): void {
  if (pathKind(path) !== 'missing') {
    throw new ManagedStartupError('Managed startup has an unexpected pending artifact.');
  }
}

function pathKind(path: string): 'missing' | 'present' {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    if (isMissingError(error)) {
      return 'missing';
    }
    throw startupError('Managed startup state could not be inspected.', error);
  }
}

function managedEntryObjectIdentity(path: string): string {
  const stats = lstatSync(path);
  return `${stats.dev}:${stats.ino}`;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function authorizationsEqual(
  left: ManagedStartupAuthorization,
  right: ManagedStartupAuthorization,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.operationId === right.operationId
    && left.releaseId === right.releaseId
    && left.releaseDigest === right.releaseDigest
    && left.rootIdentity === right.rootIdentity;
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

function isNullableReleaseId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && isValidReleaseId(value));
}

function isValidReleaseId(value: string): boolean {
  return RELEASE_ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function startupError(message: string, cause: unknown): ManagedStartupError {
  return new ManagedStartupError(message, { cause });
}

interface ManagedStartupCliOptions {
  mode: 'condition' | 'launch';
  rootDir: string;
  entrypointPath: string;
}

function parseManagedStartupCliArgs(args: string[]): ManagedStartupCliOptions {
  const mode = args[0];
  const values = new Map<string, string>();
  for (const argument of args.slice(1)) {
    const separator = argument.indexOf('=');
    if (separator <= 2) {
      throw new ManagedStartupError('Managed startup arguments are invalid.');
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if ((name !== '--root' && name !== '--entrypoint') || values.has(name) || !value) {
      throw new ManagedStartupError('Managed startup arguments are invalid.');
    }
    values.set(name, value);
  }
  const rootDir = values.get('--root');
  const entrypointPath = values.get('--entrypoint');
  if (
    (mode !== 'condition' && mode !== 'launch')
    || values.size !== 2
    || rootDir === undefined
    || entrypointPath === undefined
  ) {
    throw new ManagedStartupError('Managed startup arguments are invalid.');
  }
  return { mode, rootDir, entrypointPath };
}

async function launchManagedApplication(options: ManagedStartupCliOptions): Promise<number> {
  const child = spawn(process.execPath, [options.entrypointPath], {
    cwd: join(options.rootDir, 'current'),
    env: process.env,
    stdio: 'inherit',
  });
  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) {
    process.on(signal, forwardSignal);
  }
  try {
    return await new Promise<number>((resolveExit) => {
      child.once('error', () => resolveExit(1));
      child.once('exit', (code) => resolveExit(code ?? 1));
    });
  } finally {
    for (const signal of signals) {
      process.off(signal, forwardSignal);
    }
  }
}

async function main(): Promise<void> {
  let options: ManagedStartupCliOptions;
  try {
    assertInstalledGateManifest();
    options = parseManagedStartupCliArgs(process.argv.slice(2));
    runManagedStartupGate(options);
  } catch {
    process.stderr.write('Managed startup denied.\n');
    process.exitCode = process.argv[2] === 'condition' ? 1 : MANAGED_STARTUP_DENIED_EXIT_CODE;
    return;
  }
  if (options.mode === 'launch') {
    process.exitCode = await launchManagedApplication(options);
  }
}

function assertInstalledGateManifest(): void {
  const modulePath = fileURLToPath(import.meta.url);
  const binDir = dirname(modulePath);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(binDir, 'manifest.json'), 'utf8')) as unknown;
  } catch (error) {
    throw startupError('Managed startup gate manifest is missing or invalid.', error);
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'protocolVersion', 'files'])
    || value.schemaVersion !== 1
    || value.protocolVersion !== MANAGED_STARTUP_PROTOCOL_VERSION
    || !isRecord(value.files)
    || !hasExactKeys(value.files, ['managed-startup.js', 'release-artifact.js'])
  ) {
    throw new ManagedStartupError('Managed startup gate manifest is invalid.');
  }
  for (const name of ['managed-startup.js', 'release-artifact.js'] as const) {
    const expected = value.files[name];
    if (
      typeof expected !== 'string'
      || !SHA256_PATTERN.test(expected)
      || createHash('sha256').update(readFileSync(join(binDir, name))).digest('hex') !== expected
    ) {
      throw new ManagedStartupError('Managed startup gate asset digest is invalid.');
    }
  }
}

function isMainModuleInvocation(moduleUrl: string, invokedPath: string | undefined): boolean {
  if (!invokedPath) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invokedPath);
  } catch {
    return moduleUrl === pathToFileURL(invokedPath).href;
  }
}

if (isMainModuleInvocation(import.meta.url, process.argv[1])) {
  void main();
}
