import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runReleasePreflight,
  type ReleasePreflightDiagnosticCode,
  type ReleaseSchemaContract,
} from '../scripts/release-preflight.js';
import { verifySqliteIntegrity } from './sqlite-maintenance.js';
import { closeDatabase, getSchemaVersion, initDatabase } from '../storage/database.js';
import {
  assertManagedStartupAuthorizationClean,
  assertManagedStartupAuthorizationOwned,
  clearManagedStartupAuthorization,
  completeManagedStartupAuthorization,
  persistManagedStartupAuthorization,
} from './managed-startup.js';
import {
  calculateManagedReleaseDigest,
  managedReleaseMatches,
} from './release-artifact.js';

export type ApplicationProbeKind = 'health' | 'readiness';

export interface ApplicationSupervisor {
  assertReady?(): void | Promise<void>;
  stop(): Promise<void>;
  start(input: { rootDir: string; releaseId: string }): Promise<void>;
}

export interface ApplicationProbe {
  check(kind: ApplicationProbeKind): Promise<void>;
}

export interface ActivateApplicationReleaseOptions {
  rootDir: string;
  releaseId: string;
  supervisor: ApplicationSupervisor;
  probe: ApplicationProbe;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

export interface RecoverInterruptedApplicationReleaseOptions {
  rootDir: string;
  supervisor: ApplicationSupervisor;
  probe: ApplicationProbe;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

export interface ConfirmApplicationReleaseOptions {
  rootDir: string;
  releaseId: string;
  operationId: string;
  supervisor: ApplicationSupervisor;
  probe: ApplicationProbe;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

export interface ApplicationReleaseActivationResult {
  releaseId: string;
  operationId: string;
  previousReleaseId?: string;
  confirmationRequired: true;
}

export interface ApplicationReleaseRecoveryResult {
  recovered: boolean;
  restarted: boolean;
}

export interface ApplicationReleaseConfirmationResult {
  confirmed: boolean;
  releaseId: string;
}

export type ApplicationReleaseErrorCode =
  | 'invalid-layout'
  | 'invalid-release-id'
  | 'invalid-candidate'
  | 'preflight-failed'
  | 'schema-incompatible'
  | 'activation-locked'
  | 'already-current'
  | 'confirmation-required'
  | 'stop-failed'
  | 'activation-failed'
  | 'rollback-failed'
  | 'invalid-recovery-state'
  | 'recovery-failed'
  | 'cleanup-failed';

interface ApplicationReleaseErrorOptions {
  cause?: unknown;
  diagnostics?: ReleasePreflightDiagnosticCode[];
}

export class ApplicationReleaseError extends Error {
  readonly diagnostics: ReleasePreflightDiagnosticCode[];

  constructor(
    readonly code: ApplicationReleaseErrorCode,
    message: string,
    options: ApplicationReleaseErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApplicationReleaseError';
    this.diagnostics = options.diagnostics ?? [];
  }
}

export class ApplicationRollbackError extends ApplicationReleaseError {
  constructor(
    readonly rollbackFailures: string[],
    cause?: unknown,
  ) {
    super(
      'rollback-failed',
      'Application activation failed and the previous release could not be fully restored.',
      { cause },
    );
    this.name = 'ApplicationRollbackError';
  }
}

export class ApplicationRecoveryError extends ApplicationReleaseError {
  constructor(
    code: 'invalid-recovery-state' | 'recovery-failed',
    message: string,
    cause?: unknown,
  ) {
    super(code, message, cause === undefined ? {} : { cause });
    this.name = 'ApplicationRecoveryError';
  }
}

export class ApplicationReleaseCleanupError extends ApplicationReleaseError {
  readonly operationCode: ApplicationReleaseErrorCode | undefined;
  readonly rollbackFailures: string[];

  constructor(
    readonly operationError: unknown,
    cleanupError: unknown,
  ) {
    super(
      'cleanup-failed',
      'Application activation lock cleanup could not be verified.',
      {
        cause: new AggregateError(
          operationError === undefined ? [cleanupError] : [operationError, cleanupError],
          'Application activation lock cleanup failed.',
        ),
      },
    );
    this.name = 'ApplicationReleaseCleanupError';
    this.operationCode = operationError instanceof ApplicationReleaseError
      ? operationError.code
      : undefined;
    this.rollbackFailures = operationError instanceof ApplicationRollbackError
      ? operationError.rollbackFailures
      : [];
  }
}

interface ManagedPointerState {
  current?: string;
  previous?: string;
}

interface PersistedPointerState {
  current: string | null;
  previous: string | null;
}

interface LegacyApplicationActivationState {
  schemaVersion: 1;
  operationId: string;
  operationKind: 'activation';
  candidateReleaseId: string;
  originalPointers: PersistedPointerState;
  targetPointers: PersistedPointerState;
}

type ApplicationActivationPhase =
  | 'intent_recorded'
  | 'snapshot_ready'
  | 'awaiting_confirmation'
  | 'rollback_completed'
  | 'confirming';

interface ApplicationRollbackSnapshot {
  sourceExisted: boolean;
  sha256: string | null;
  schemaVersion: number | null;
  sourceMode: number | null;
  sourceUid: number | null;
  sourceGid: number | null;
}

interface ApplicationActivationStateV2 {
  schemaVersion: 2;
  operationId: string;
  operationKind: 'activation';
  phase: ApplicationActivationPhase;
  candidateReleaseId: string;
  candidateDigest: string;
  originalReleaseDigest: string | null;
  originalPointers: PersistedPointerState;
  targetPointers: PersistedPointerState;
  rollbackSnapshot: ApplicationRollbackSnapshot | null;
}

type ApplicationActivationState = LegacyApplicationActivationState | ApplicationActivationStateV2;

interface ValidatedOperationTemporaryLink {
  path: string;
  identity: string;
}

interface ActivationLockOwner {
  schemaVersion: 1;
  pid: number;
  processIdentity: string;
  nonce: string;
}

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 100;
const MAX_LOCK_TIMEOUT_MS = 60_000;
const MAX_LOCK_RETRY_MS = 1_000;
const ACTIVATION_STATE_FILE = '.activation-state.json';
const ACTIVATION_STATE_TEMP_FILE = '.activation-state.tmp';
const MAX_ACTIVATION_STATE_BYTES = 8 * 1024;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ROLLBACK_DIRECTORY = '.release-rollback';
const ROLLBACK_PENDING_SUFFIX = '.pending.db';
const RESTORE_PENDING_PREFIX = '.release-restore-';
const ACTIVATION_LOCK_FILE = '.activation.lock';
const ACTIVATION_LOCK_TEMP_PREFIX = '.activation-lock-';
const ACTIVATION_LOCK_TEMP_V2_PREFIX = '.activation-lock-v2.';
const ACTIVATION_LOCK_TEMP_SUFFIX = '.tmp';
const ACTIVATION_LOCK_QUARANTINE_PREFIX = '.activation-lock-quarantine-';
const MAX_ACTIVATION_LOCK_BYTES = 2 * 1024;

export async function activateApplicationRelease(
  options: ActivateApplicationReleaseOptions,
): Promise<ApplicationReleaseActivationResult> {
  const rootDir = resolve(options.rootDir);
  const releaseId = validateReleaseId(options.releaseId);
  const lockTimeoutMs = validateDuration(
    options.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    MAX_LOCK_TIMEOUT_MS,
  );
  const lockRetryMs = validateDuration(
    options.lockRetryMs,
    DEFAULT_LOCK_RETRY_MS,
    MAX_LOCK_RETRY_MS,
  );

  validateManagedLayout(rootDir);
  const candidateDir = join(rootDir, 'releases', releaseId);
  const candidateIdentity = validateCandidate(candidateDir);

  const preflight = runReleasePreflight(candidateDir);
  if (!preflight.ok || preflight.schemaContract === undefined) {
    throw new ApplicationReleaseError(
      'preflight-failed',
      'Candidate release failed the offline release preflight.',
      { diagnostics: preflight.diagnostics.map((diagnostic) => diagnostic.code) },
    );
  }

  const releaseLock = await acquireActivationLock(rootDir, lockTimeoutMs, lockRetryMs);
  let activationResult: ApplicationReleaseActivationResult | undefined;
  let operationError: unknown;
  try {
    await recoverPendingApplicationRelease({
      rootDir,
      supervisor: options.supervisor,
      probe: options.probe,
      recoverAwaitingConfirmation: false,
    });

    if (!candidateStillMatches(candidateDir, candidateIdentity)) {
      throw new ApplicationReleaseError(
        'invalid-candidate',
        'Candidate release changed while waiting for the activation lock.',
      );
    }

    assertCandidateDatabaseCompatibility(rootDir, preflight.schemaContract);

    const originalPointers: ManagedPointerState = {
      current: readManagedPointer(rootDir, 'current'),
      previous: readManagedPointer(rootDir, 'previous'),
    };
    validateCleanPointerState(originalPointers);

    if (originalPointers.current === releaseId) {
      throw new ApplicationReleaseError(
        'already-current',
        'Candidate release is already active.',
      );
    }

    try {
      await options.supervisor.assertReady?.();
    } catch (error) {
      throw new ApplicationReleaseError(
        'invalid-layout',
        'Managed application supervisor assets are invalid or missing.',
        { cause: error },
      );
    }

    const originalReleaseDigest = originalPointers.current === undefined
      ? null
      : calculateOriginalReleaseDigest(rootDir, originalPointers.current);
    let activationState = createActivationState(
      originalPointers,
      releaseId,
      candidateIdentity,
      originalReleaseDigest,
    );
    try {
      persistActivationState(rootDir, activationState);
    } catch (error) {
      if (error instanceof ApplicationRecoveryError) {
        throw error;
      }
      throw new ApplicationRecoveryError(
        'recovery-failed',
        'Durable application release intent could not be persisted.',
        error,
      );
    }
    let pointerPublicationStarted = false;
    let candidateStartAttempted = false;
    try {
      if (originalPointers.current !== undefined) {
        try {
          await options.supervisor.stop();
        } catch (error) {
          throw new ApplicationReleaseError(
            'stop-failed',
            'The active application could not be stopped; release pointers were not changed.',
            { cause: error },
          );
        }
      }

      const stoppedPointers = readPointerStateForRecovery(rootDir);
      if (!pointerStatesEqual(
        persistPointerState(stoppedPointers),
        activationState.originalPointers,
      )) {
        throw new ApplicationRecoveryError(
          'invalid-recovery-state',
          'Managed release pointers changed before candidate publication.',
        );
      }

      if (!candidateStillMatches(candidateDir, candidateIdentity)) {
        throw new ApplicationReleaseError(
          'invalid-candidate',
          'Candidate release changed after the durable activation intent was recorded.',
        );
      }

      const rollbackSnapshot = await createRollbackSnapshot(rootDir, activationState.operationId);
      const snapshotReadyState: ApplicationActivationStateV2 = {
        ...activationState,
        phase: 'snapshot_ready',
        rollbackSnapshot,
      };
      try {
        replaceActivationState(rootDir, activationState, snapshotReadyState);
      } catch (error) {
        removeRollbackSnapshot(rootDir, snapshotReadyState, true);
        throw error;
      }
      activationState = snapshotReadyState;

      if (!candidateStillMatches(candidateDir, activationState.candidateDigest)) {
        throw new ApplicationReleaseError(
          'invalid-candidate',
          'Candidate release changed while the rollback snapshot was created.',
        );
      }

      pointerPublicationStarted = true;
      publishCandidatePointers(rootDir, activationState);

      persistManagedStartupAuthorization({
        rootDir,
        operationId: activationState.operationId,
        releaseId: activationState.candidateReleaseId,
      });
      candidateStartAttempted = true;
      await options.supervisor.start({
        rootDir,
        releaseId: activationState.candidateReleaseId,
      });
      await options.probe.check('health');
      completeManagedStartupAuthorization(rootDir, activationState.operationId);
      await options.probe.check('readiness');
      if (!candidateStillMatches(candidateDir, activationState.candidateDigest)) {
        throw new ApplicationReleaseError(
          'invalid-candidate',
          'Candidate release changed while activation readiness was checked.',
        );
      }
      const committedPointers = readPointerStateForRecovery(rootDir);
      if (!pointerStatesEqual(
        persistPointerState(committedPointers),
        activationState.targetPointers,
      )) {
        throw new ApplicationRecoveryError(
          'invalid-recovery-state',
          'Managed release pointers changed before activation completion.',
        );
      }
      const awaitingConfirmationState: ApplicationActivationStateV2 = {
        ...activationState,
        phase: 'awaiting_confirmation',
      };
      replaceActivationState(rootDir, activationState, awaitingConfirmationState);
      activationState = awaitingConfirmationState;
    } catch (error) {
      if (
        error instanceof ApplicationReleaseError
        && (
          error.code === 'stop-failed'
          || (!pointerPublicationStarted && error.code === 'invalid-recovery-state')
        )
      ) {
        throw error;
      }
      const rollbackFailures = await rollbackApplicationRelease({
        rootDir,
        activationState,
        candidateStartAttempted,
        supervisor: options.supervisor,
        probe: options.probe,
      });

      if (rollbackFailures.length > 0) {
        throw new ApplicationRollbackError(rollbackFailures, error);
      }

      if (error instanceof ApplicationReleaseError && error.code === 'invalid-candidate') {
        throw error;
      }

      throw new ApplicationReleaseError(
        'activation-failed',
        'Candidate activation failed; the previous release state was restored.',
        { cause: error },
      );
    }

    activationResult = {
      releaseId,
      operationId: activationState.operationId,
      confirmationRequired: true,
      ...(originalPointers.current === undefined
        ? {}
        : { previousReleaseId: originalPointers.current }),
    };
  } catch (error) {
    operationError = error;
  }

  try {
    releaseLock.release();
  } catch (cleanupError) {
    throw new ApplicationReleaseCleanupError(operationError, cleanupError);
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  if (activationResult === undefined) {
    throw new ApplicationReleaseError(
      'activation-failed',
      'Application activation ended without a result.',
    );
  }
  return activationResult;
}

function assertCandidateDatabaseCompatibility(
  rootDir: string,
  contract: ReleaseSchemaContract,
): void {
  const databasePath = join(rootDir, 'shared', 'data', 'lethebot.db');
  if (!optionalRegularFileExists(databasePath, 'shared database', 'invalid-layout')) {
    assertNoDatabaseSidecars(databasePath, 'invalid-layout');
    if (contract.adoptsLegacyUnversioned) {
      return;
    }
    throwSchemaIncompatible();
  }

  let db;
  try {
    db = initDatabase({ path: databasePath, readonly: true });
    const version = getSchemaVersion(db);
    if (version === 0) {
      if (!contract.adoptsLegacyUnversioned) {
        throwSchemaIncompatible();
      }
      return;
    }
    if (version < contract.minReadableVersion || version > contract.maxReadableVersion) {
      throwSchemaIncompatible();
    }
  } catch (error) {
    if (error instanceof ApplicationReleaseError) {
      throw error;
    }
    throwSchemaIncompatible(error);
  } finally {
    if (db?.open) {
      closeDatabase(db);
    }
  }
}

function throwSchemaIncompatible(cause?: unknown): never {
  throw new ApplicationReleaseError(
    'schema-incompatible',
    'Candidate release cannot read the shared database schema.',
    cause === undefined ? {} : { cause },
  );
}

export async function recoverInterruptedApplicationRelease(
  options: RecoverInterruptedApplicationReleaseOptions,
): Promise<ApplicationReleaseRecoveryResult> {
  const rootDir = resolve(options.rootDir);
  const lockTimeoutMs = validateDuration(
    options.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    MAX_LOCK_TIMEOUT_MS,
  );
  const lockRetryMs = validateDuration(
    options.lockRetryMs,
    DEFAULT_LOCK_RETRY_MS,
    MAX_LOCK_RETRY_MS,
  );

  validateManagedLayout(rootDir);
  const releaseLock = await acquireActivationLock(rootDir, lockTimeoutMs, lockRetryMs);
  let recoveryResult: ApplicationReleaseRecoveryResult | undefined;
  let operationError: unknown;
  try {
    recoveryResult = await recoverPendingApplicationRelease({
      rootDir,
      supervisor: options.supervisor,
      probe: options.probe,
      recoverAwaitingConfirmation: true,
    });
  } catch (error) {
    operationError = error;
  }

  try {
    releaseLock.release();
  } catch (cleanupError) {
    throw new ApplicationReleaseCleanupError(operationError, cleanupError);
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  return recoveryResult ?? { recovered: false, restarted: false };
}

export async function confirmApplicationRelease(
  options: ConfirmApplicationReleaseOptions,
): Promise<ApplicationReleaseConfirmationResult> {
  const rootDir = resolve(options.rootDir);
  const releaseId = validateReleaseId(options.releaseId);
  const operationId = validateOperationId(options.operationId);
  const lockTimeoutMs = validateDuration(
    options.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    MAX_LOCK_TIMEOUT_MS,
  );
  const lockRetryMs = validateDuration(
    options.lockRetryMs,
    DEFAULT_LOCK_RETRY_MS,
    MAX_LOCK_RETRY_MS,
  );

  validateManagedLayout(rootDir);
  const releaseLock = await acquireActivationLock(rootDir, lockTimeoutMs, lockRetryMs);
  let confirmationResult: ApplicationReleaseConfirmationResult | undefined;
  let operationError: unknown;
  try {
    reconcileActivationStateTemp(rootDir);
    let activationState = readActivationState(rootDir);
    if (
      activationState === undefined
      || activationState.schemaVersion !== 2
      || (
        activationState.phase !== 'awaiting_confirmation'
        && activationState.phase !== 'confirming'
      )
    ) {
      throw new ApplicationReleaseError(
        'confirmation-required',
        'There is no candidate release awaiting confirmation.',
      );
    }
    if (
      activationState.candidateReleaseId !== releaseId
      || activationState.operationId !== operationId
    ) {
      throw new ApplicationReleaseError(
        'confirmation-required',
        'The pending candidate does not match the requested release confirmation.',
      );
    }

    const observedPointers = readPointerStateForRecovery(rootDir);
    if (!pointerStatesEqual(persistPointerState(observedPointers), activationState.targetPointers)) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'Managed release pointers changed before release confirmation.',
      );
    }

    const candidateDir = join(rootDir, 'releases', activationState.candidateReleaseId);
    if (!candidateStillMatches(candidateDir, activationState.candidateDigest)) {
      throw new ApplicationReleaseError(
        'invalid-candidate',
        'Candidate release changed before release confirmation.',
      );
    }
    const preflight = runReleasePreflight(candidateDir);
    if (!preflight.ok || preflight.schemaContract === undefined) {
      throw new ApplicationReleaseError(
        'preflight-failed',
        'Candidate release failed the offline release preflight during confirmation.',
        { diagnostics: preflight.diagnostics.map((diagnostic) => diagnostic.code) },
      );
    }
    assertCandidateDatabaseCompatibility(rootDir, preflight.schemaContract);
    const resumingConfirmation = activationState.phase === 'confirming';
    if (!resumingConfirmation) {
      await validateRollbackSnapshot(rootDir, activationState);
      await options.probe.check('health');
      await options.probe.check('readiness');
      if (!candidateStillMatches(candidateDir, activationState.candidateDigest)) {
        throw new ApplicationReleaseError(
          'invalid-candidate',
          'Candidate release changed while release confirmation was checked.',
        );
      }
      const confirmingState: ApplicationActivationStateV2 = {
        ...activationState,
        phase: 'confirming',
      };
      replaceActivationState(rootDir, activationState, confirmingState);
      activationState = confirmingState;
    } else {
      try {
        await restartReleaseUnderPendingState(
          rootDir,
          activationState,
          activationState.candidateReleaseId,
          options.supervisor,
          options.probe,
        );
      } catch (error) {
        throw new ApplicationRecoveryError(
          'recovery-failed',
          'Interrupted release confirmation could not restart the confirmed release.',
          error,
        );
      }
      if (!candidateStillMatches(candidateDir, activationState.candidateDigest)) {
        throw new ApplicationReleaseError(
          'invalid-candidate',
          'Candidate release changed while confirmation was resumed.',
        );
      }
    }
    finalizeActivationStateCleanup(rootDir, activationState);
    confirmationResult = {
      confirmed: true,
      releaseId: activationState.candidateReleaseId,
    };
  } catch (error) {
    operationError = error;
  }

  try {
    releaseLock.release();
  } catch (cleanupError) {
    throw new ApplicationReleaseCleanupError(operationError, cleanupError);
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (confirmationResult === undefined) {
    throw new ApplicationReleaseError(
      'confirmation-required',
      'Application release confirmation ended without a result.',
    );
  }
  return confirmationResult;
}

async function recoverPendingApplicationRelease(options: {
  rootDir: string;
  supervisor: ApplicationSupervisor;
  probe: ApplicationProbe;
  recoverAwaitingConfirmation: boolean;
}): Promise<ApplicationReleaseRecoveryResult> {
  reconcileActivationStateTemp(options.rootDir);
  let activationState = readActivationState(options.rootDir);
  if (activationState === undefined) {
    removeUnpublishedActivationStateTemp(options.rootDir);
    assertManagedStartupAuthorizationClean(options.rootDir);
    assertNoUnownedOperationTemps(options.rootDir);
    assertNoOrphanRollbackArtifacts(options.rootDir);
    assertNoOrphanRestoreArtifacts(options.rootDir);
    validateCleanPointerState(readPointerState(options.rootDir));
    return { recovered: false, restarted: false };
  }

  if (
    activationState.schemaVersion === 2
    && (activationState.phase === 'awaiting_confirmation' || activationState.phase === 'confirming')
    && (!options.recoverAwaitingConfirmation || activationState.phase === 'confirming')
  ) {
    throw new ApplicationReleaseError(
      'confirmation-required',
      'The current release must be explicitly confirmed before another activation.',
    );
  }

  const observedPointers = readPointerStateForRecovery(options.rootDir);
  validateRecoverablePointerState(activationState, observedPointers);
  validateOperationTemporaryLinks(options.rootDir, activationState);
  assertOriginalReleaseMatches(options.rootDir, activationState);

  if (activationState.schemaVersion === 2 && activationState.phase === 'rollback_completed') {
    if (!pointerStatesEqual(persistPointerState(observedPointers), activationState.originalPointers)) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'Completed rollback pointers no longer match their durable activation state.',
      );
    }
    if (activationState.originalPointers.current !== null) {
      try {
        await restartReleaseUnderPendingState(
          options.rootDir,
          activationState,
          activationState.originalPointers.current,
          options.supervisor,
          options.probe,
        );
      } catch (error) {
        throw new ApplicationRecoveryError(
          'recovery-failed',
          'Completed rollback recovery could not restart the original release.',
          error,
        );
      }
    }
    finalizeActivationStateCleanup(options.rootDir, activationState);
    return {
      recovered: true,
      restarted: activationState.originalPointers.current !== null,
    };
  }

  try {
    await options.supervisor.assertReady?.();
  } catch (error) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Managed application supervisor assets are invalid or missing.',
      error,
    );
  }

  try {
    await options.supervisor.stop();
  } catch (error) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'Interrupted application release recovery could not stop the managed service.',
      error,
    );
  }

  const stoppedPointers = readPointerStateForRecovery(options.rootDir);
  if (!pointerStatesEqual(persistPointerState(stoppedPointers), persistPointerState(observedPointers))) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Managed release pointers changed while stopping for recovery.',
    );
  }
  const stoppedState = readActivationState(options.rootDir);
  if (stoppedState === undefined || !activationStatesEqual(stoppedState, activationState)) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release intent changed while stopping for recovery.',
    );
  }

  try {
    clearManagedStartupAuthorization(options.rootDir, activationState.operationId);
  } catch (error) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Interrupted application release recovery found invalid startup authorization state.',
      error,
    );
  }

  try {
    await restoreRollbackDatabase(options.rootDir, activationState);
  } catch (error) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'Interrupted application release recovery could not restore the shared database.',
      error,
    );
  }

  try {
    const temporaryLinks = validateOperationTemporaryLinks(options.rootDir, activationState);
    removeOperationTemporaryLinks(options.rootDir, temporaryLinks);
    restoreManagedPointer(
      options.rootDir,
      'current',
      nullableReleaseId(activationState.originalPointers.current),
      activationState.operationId,
    );
  } catch (error) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'Interrupted application release recovery could not restore the current pointer.',
      error,
    );
  }

  try {
    restoreManagedPointer(
      options.rootDir,
      'previous',
      nullableReleaseId(activationState.originalPointers.previous),
      activationState.operationId,
    );
  } catch (error) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'Interrupted application release recovery could not restore the previous pointer.',
      error,
    );
  }

  const restarted = activationState.originalPointers.current !== null;
  if (restarted) {
    const restartFailures = await startAndProbePrevious(
      options.rootDir,
      activationState,
      activationState.originalPointers.current as string,
      options.supervisor,
      options.probe,
    );
    if (restartFailures.length > 0) {
      throw new ApplicationRecoveryError(
        'recovery-failed',
        'Interrupted application release recovery could not restart the original release.',
      );
    }
  }

  try {
    const restoredPointers = readPointerStateForRecovery(options.rootDir);
    if (!pointerStatesEqual(
      persistPointerState(restoredPointers),
      activationState.originalPointers,
    )) {
      throw new Error('recovered pointers changed before durable intent cleanup');
    }
    if (activationState.schemaVersion === 2) {
      const rollbackCompletedState: ApplicationActivationStateV2 = {
        ...activationState,
        phase: 'rollback_completed',
      };
      replaceActivationState(options.rootDir, activationState, rollbackCompletedState);
      activationState = rollbackCompletedState;
    }
    finalizeActivationStateCleanup(options.rootDir, activationState);
  } catch (error) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'Interrupted application release recovery could not clear its durable intent.',
      error,
    );
  }
  return { recovered: true, restarted };
}

function createActivationState(
  originalPointers: ManagedPointerState,
  candidateReleaseId: string,
  candidateDigest: string,
  originalReleaseDigest: string | null,
): ApplicationActivationStateV2 {
  return {
    schemaVersion: 2,
    operationId: randomUUID(),
    operationKind: 'activation',
    phase: 'intent_recorded',
    candidateReleaseId,
    candidateDigest,
    originalReleaseDigest,
    originalPointers: persistPointerState(originalPointers),
    targetPointers: {
      current: candidateReleaseId,
      previous: originalPointers.current ?? null,
    },
    rollbackSnapshot: null,
  };
}

function calculateOriginalReleaseDigest(rootDir: string, releaseId: string): string {
  try {
    return calculateManagedReleaseDigest(join(rootDir, 'releases', releaseId));
  } catch (error) {
    throw new ApplicationReleaseError(
      'invalid-layout',
      'The original release cannot be bound for rollback.',
      { cause: error },
    );
  }
}

function persistPointerState(pointers: ManagedPointerState): PersistedPointerState {
  return {
    current: pointers.current ?? null,
    previous: pointers.previous ?? null,
  };
}

function nullableReleaseId(releaseId: string | null): string | undefined {
  return releaseId ?? undefined;
}

function validateCleanPointerState(pointers: ManagedPointerState): void {
  if (
    (pointers.current === undefined && pointers.previous !== undefined)
    || (pointers.current !== undefined && pointers.current === pointers.previous)
  ) {
    throw new ApplicationReleaseError(
      'invalid-layout',
      'Managed release pointers require interrupted-operation recovery.',
    );
  }
}

function readPointerState(rootDir: string): ManagedPointerState {
  return {
    current: readManagedPointer(rootDir, 'current'),
    previous: readManagedPointer(rootDir, 'previous'),
  };
}

function readPointerStateForRecovery(rootDir: string): ManagedPointerState {
  try {
    return readPointerState(rootDir);
  } catch (error) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Interrupted application release pointers are invalid.',
      error,
    );
  }
}

function persistActivationState(rootDir: string, state: ApplicationActivationState): void {
  const statePath = join(rootDir, ACTIVATION_STATE_FILE);
  const temporaryPath = join(rootDir, ACTIVATION_STATE_TEMP_FILE);
  if (managedPathKind(statePath) !== 'missing') {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'A durable application release intent already exists.',
    );
  }
  removeUnpublishedActivationStateTemp(rootDir);

  const serialized = `${JSON.stringify(state)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, serialized, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, statePath);
    syncDirectory(rootDir);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function replaceActivationState(
  rootDir: string,
  expected: ApplicationActivationState,
  replacement: ApplicationActivationState,
): void {
  const statePath = join(rootDir, ACTIVATION_STATE_FILE);
  const temporaryPath = join(rootDir, ACTIVATION_STATE_TEMP_FILE);
  if (managedPathKind(temporaryPath) !== 'missing') {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'A durable application release intent has an unexpected temporary file.',
    );
  }

  const stateIdentity = managedEntryIdentity(statePath);
  const current = readActivationState(rootDir);
  if (current === undefined || !activationStatesEqual(current, expected)) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release intent changed before its state transition.',
    );
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(replacement)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (managedEntryIdentity(statePath) !== stateIdentity) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'Durable application release intent ownership changed before its state transition.',
      );
    }
    renameSync(temporaryPath, statePath);
    syncDirectory(rootDir);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function readActivationState(rootDir: string): ApplicationActivationState | undefined {
  return readActivationStateFile(join(rootDir, ACTIVATION_STATE_FILE), rootDir, true);
}

function readActivationStateFile(
  statePath: string,
  rootDir: string,
  allowMissing: boolean,
): ApplicationActivationState | undefined {
  let stats;
  try {
    stats = lstatSync(statePath);
  } catch (error) {
    if (allowMissing && isMissingError(error)) {
      return undefined;
    }
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release intent could not be inspected.',
      error,
    );
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_ACTIVATION_STATE_BYTES) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release intent is not a bounded regular file.',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
  } catch (error) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release intent is not valid JSON.',
      error,
    );
  }
  try {
    return validateActivationState(value, rootDir);
  } catch (error) {
    if (error instanceof ApplicationRecoveryError) {
      throw error;
    }
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release intent has an invalid schema.',
      error,
    );
  }
}

function reconcileActivationStateTemp(rootDir: string): void {
  const temporaryPath = join(rootDir, ACTIVATION_STATE_TEMP_FILE);
  if (managedPathKind(temporaryPath) === 'missing') {
    return;
  }

  const temporaryIdentity = managedEntryObjectIdentity(temporaryPath);
  let temporary: ApplicationActivationState | undefined;
  try {
    temporary = readActivationStateFile(temporaryPath, rootDir, false);
  } catch (error) {
    if (!isRecoverablePartialActivationStateTemp(temporaryPath)) {
      throw error;
    }
    const current = readActivationState(rootDir);
    if (current === undefined) {
      validateCleanPointerState(readPointerStateForRecovery(rootDir));
      assertManagedStartupAuthorizationClean(rootDir);
      assertNoUnownedOperationTemps(rootDir);
      assertNoOrphanRollbackArtifacts(rootDir);
      assertNoOrphanRestoreArtifacts(rootDir);
    } else {
      if (
        current.schemaVersion !== 2
        || current.phase === 'confirming'
        || current.phase === 'rollback_completed'
      ) {
        throw error;
      }
      validateRecoverablePointerState(current, readPointerStateForRecovery(rootDir));
      validateOperationTemporaryLinks(rootDir, current);
      assertManagedStartupAuthorizationOwned(rootDir, current.operationId);
      assertOperationDatabaseArtifactsOwned(rootDir, current.operationId);
    }
    if (managedEntryObjectIdentity(temporaryPath) !== temporaryIdentity) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'Durable application release temporary intent changed before reconciliation.',
      );
    }
    rmSync(temporaryPath);
    syncDirectory(rootDir);
    return;
  }
  if (temporary === undefined) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release temporary intent is missing.',
    );
  }
  const current = readActivationState(rootDir);
  if (current !== undefined && !isDiscardableStateSuccessor(current, temporary)) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release temporary intent is not a valid successor.',
    );
  }
  if (current === undefined && !isInitialActivationState(temporary)) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Unpublished application release intent is not an initial state.',
    );
  }

  rmSync(temporaryPath);
  syncDirectory(rootDir);
}

function isRecoverablePartialActivationStateTemp(path: string): boolean {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || (stats.mode & 0o777) !== 0o600
    || stats.size > MAX_ACTIVATION_STATE_BYTES
  ) {
    return false;
  }
  try {
    JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return false;
  } catch {
    return true;
  }
}

function assertOperationDatabaseArtifactsOwned(rootDir: string, operationId: string): void {
  const rollbackDirectory = join(rootDir, ROLLBACK_DIRECTORY);
  if (managedPathKind(rollbackDirectory) !== 'missing') {
    const stats = lstatSync(rollbackDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'The managed rollback artifact is invalid.',
      );
    }
    const allowedBases = new Set([
      `${operationId}.db`,
      `${operationId}${ROLLBACK_PENDING_SUFFIX}`,
    ]);
    const allowedEntries = new Set<string>();
    for (const base of allowedBases) {
      allowedEntries.add(base);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        allowedEntries.add(`${base}${suffix}`);
      }
    }
    if (readdirSync(rollbackDirectory).some((entry) => !allowedEntries.has(entry))) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'The managed rollback directory contains a foreign artifact.',
      );
    }
  }

  const expectedRestore = `${RESTORE_PENDING_PREFIX}${operationId}.db`;
  const foreignRestore = readdirSync(join(rootDir, 'shared', 'data')).some((entry) => {
    if (!entry.startsWith(RESTORE_PENDING_PREFIX)) {
      return false;
    }
    return entry !== expectedRestore
      && entry !== `${expectedRestore}-wal`
      && entry !== `${expectedRestore}-shm`
      && entry !== `${expectedRestore}-journal`;
  });
  if (foreignRestore) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The shared database directory contains a foreign restore artifact.',
    );
  }
}

function isInitialActivationState(state: ApplicationActivationState): boolean {
  return state.schemaVersion === 1
    || (state.phase === 'intent_recorded' && state.rollbackSnapshot === null);
}

function isDiscardableStateSuccessor(
  current: ApplicationActivationState,
  successor: ApplicationActivationState,
): boolean {
  if (
    current.schemaVersion !== 2
    || successor.schemaVersion !== 2
    || current.operationId !== successor.operationId
    || current.candidateReleaseId !== successor.candidateReleaseId
    || current.candidateDigest !== successor.candidateDigest
    || current.originalReleaseDigest !== successor.originalReleaseDigest
    || !pointerStatesEqual(current.originalPointers, successor.originalPointers)
    || !pointerStatesEqual(current.targetPointers, successor.targetPointers)
  ) {
    return false;
  }

  const allowedSuccessors: Record<ApplicationActivationPhase, ApplicationActivationPhase[]> = {
    intent_recorded: ['snapshot_ready', 'rollback_completed'],
    snapshot_ready: ['awaiting_confirmation', 'rollback_completed'],
    awaiting_confirmation: ['confirming', 'rollback_completed'],
    confirming: [],
    rollback_completed: [],
  };
  return allowedSuccessors[current.phase].includes(successor.phase);
}

function validateActivationState(value: unknown, rootDir: string): ApplicationActivationState {
  if (!isRecord(value)) {
    throw new Error('invalid activation state object');
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
  if (!hasExactKeys(value, expectedKeys)) {
    throw new Error('invalid activation state object');
  }
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || value.operationKind !== 'activation'
    || typeof value.operationId !== 'string'
    || !OPERATION_ID_PATTERN.test(value.operationId)
    || typeof value.candidateReleaseId !== 'string'
    || !isValidReleaseId(value.candidateReleaseId)
  ) {
    throw new Error('invalid activation state identity');
  }

  const originalPointers = validatePersistedPointerState(value.originalPointers);
  const targetPointers = validatePersistedPointerState(value.targetPointers);
  if (
    originalPointers.current === null && originalPointers.previous !== null
    || originalPointers.current !== null
      && originalPointers.current === originalPointers.previous
    || originalPointers.current === value.candidateReleaseId
    || targetPointers.current !== value.candidateReleaseId
    || targetPointers.previous !== originalPointers.current
  ) {
    throw new Error('incoherent activation state pointers');
  }

  for (const releaseId of new Set([
    value.candidateReleaseId,
    originalPointers.current,
    originalPointers.previous,
  ])) {
    if (releaseId !== null) {
      assertRecoveryReleaseDirectory(rootDir, releaseId);
    }
  }

  if (legacy) {
    return {
      schemaVersion: 1,
      operationId: value.operationId as string,
      operationKind: 'activation',
      candidateReleaseId: value.candidateReleaseId as string,
      originalPointers,
      targetPointers,
    };
  }

  const phase = validateActivationPhase(value.phase);
  if (typeof value.candidateDigest !== 'string' || !SHA256_PATTERN.test(value.candidateDigest)) {
    throw new Error('invalid activation candidate digest');
  }
  if (
    originalPointers.current === null
      ? value.originalReleaseDigest !== null
      : typeof value.originalReleaseDigest !== 'string'
        || !SHA256_PATTERN.test(value.originalReleaseDigest)
  ) {
    throw new Error('invalid activation original release digest');
  }
  const rollbackSnapshot = validateRollbackSnapshotMetadata(value.rollbackSnapshot);
  if (
    phase === 'intent_recorded'
      ? rollbackSnapshot !== null
      : phase !== 'rollback_completed' && rollbackSnapshot === null
  ) {
    throw new Error('incoherent activation rollback snapshot state');
  }

  return {
    schemaVersion: 2,
    operationId: value.operationId as string,
    operationKind: 'activation',
    phase,
    candidateReleaseId: value.candidateReleaseId as string,
    candidateDigest: value.candidateDigest,
    originalReleaseDigest: value.originalReleaseDigest as string | null,
    originalPointers,
    targetPointers,
    rollbackSnapshot,
  };
}

function validateActivationPhase(value: unknown): ApplicationActivationPhase {
  if (
    value !== 'intent_recorded'
    && value !== 'snapshot_ready'
    && value !== 'awaiting_confirmation'
    && value !== 'rollback_completed'
    && value !== 'confirming'
  ) {
    throw new Error('invalid activation phase');
  }
  return value;
}

function validateRollbackSnapshotMetadata(value: unknown): ApplicationRollbackSnapshot | null {
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
    throw new Error('invalid rollback snapshot metadata');
  }
  if (typeof value.sourceExisted !== 'boolean') {
    throw new Error('invalid rollback snapshot source state');
  }
  if (!value.sourceExisted) {
    if (
      value.sha256 !== null
      || value.schemaVersion !== null
      || value.sourceMode !== null
      || value.sourceUid !== null
      || value.sourceGid !== null
    ) {
      throw new Error('invalid absent rollback snapshot metadata');
    }
    return {
      sourceExisted: false,
      sha256: null,
      schemaVersion: null,
      sourceMode: null,
      sourceUid: null,
      sourceGid: null,
    };
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
    throw new Error('invalid present rollback snapshot metadata');
  }
  return {
    sourceExisted: true,
    sha256: value.sha256,
    schemaVersion: value.schemaVersion,
    sourceMode: value.sourceMode,
    sourceUid: value.sourceUid,
    sourceGid: value.sourceGid,
  };
}

function validatePersistedPointerState(value: unknown): PersistedPointerState {
  if (!isRecord(value) || !hasExactKeys(value, ['current', 'previous'])) {
    throw new Error('invalid persisted pointer state');
  }
  if (!isNullableReleaseId(value.current) || !isNullableReleaseId(value.previous)) {
    throw new Error('invalid persisted release id');
  }
  return { current: value.current, previous: value.previous };
}

function isNullableReleaseId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && isValidReleaseId(value));
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

function assertRecoveryReleaseDirectory(rootDir: string, releaseId: string): void {
  try {
    const stats = lstatSync(join(rootDir, 'releases', releaseId));
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('not a managed release directory');
    }
  } catch (error) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release intent references an invalid release.',
      error,
    );
  }
}

function validateRecoverablePointerState(
  state: ApplicationActivationState,
  observed: ManagedPointerState,
): void {
  const observedPersisted = persistPointerState(observed);
  const intermediate: PersistedPointerState = {
    current: state.originalPointers.current,
    previous: state.originalPointers.current,
  };
  const partialRollback: PersistedPointerState = {
    current: state.targetPointers.current,
    previous: state.originalPointers.previous,
  };
  const allowed = state.schemaVersion === 1
    ? [state.originalPointers, intermediate, state.targetPointers, partialRollback]
    : allowedPointerStatesForPhase(state, intermediate);
  if (!allowed.some((candidate) => pointerStatesEqual(observedPersisted, candidate))) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Managed release pointers do not match the durable application release intent.',
    );
  }
}

function allowedPointerStatesForPhase(
  state: ApplicationActivationStateV2,
  intermediate: PersistedPointerState,
): PersistedPointerState[] {
  switch (state.phase) {
    case 'intent_recorded':
    case 'rollback_completed':
      return [state.originalPointers];
    case 'snapshot_ready':
    case 'awaiting_confirmation':
      return [state.originalPointers, intermediate, state.targetPointers];
    case 'confirming':
      return [state.targetPointers];
  }
}

function pointerStatesEqual(left: PersistedPointerState, right: PersistedPointerState): boolean {
  return left.current === right.current && left.previous === right.previous;
}

function activationStatesEqual(
  left: ApplicationActivationState,
  right: ApplicationActivationState,
): boolean {
  if (
    left.schemaVersion !== right.schemaVersion
    || left.operationId !== right.operationId
    || left.operationKind !== right.operationKind
    || left.candidateReleaseId !== right.candidateReleaseId
    || !pointerStatesEqual(left.originalPointers, right.originalPointers)
    || !pointerStatesEqual(left.targetPointers, right.targetPointers)
  ) {
    return false;
  }
  if (left.schemaVersion === 1 || right.schemaVersion === 1) {
    return left.schemaVersion === 1 && right.schemaVersion === 1;
  }
  return left.candidateDigest === right.candidateDigest
    && left.originalReleaseDigest === right.originalReleaseDigest
    && left.phase === right.phase
    && rollbackSnapshotsEqual(left.rollbackSnapshot, right.rollbackSnapshot);
}

function rollbackSnapshotsEqual(
  left: ApplicationRollbackSnapshot | null,
  right: ApplicationRollbackSnapshot | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.sourceExisted === right.sourceExisted
      && left.sha256 === right.sha256
      && left.schemaVersion === right.schemaVersion
      && left.sourceMode === right.sourceMode
      && left.sourceUid === right.sourceUid
      && left.sourceGid === right.sourceGid;
}

function validateOperationTemporaryLinks(
  rootDir: string,
  state: ApplicationActivationState,
): ValidatedOperationTemporaryLink[] {
  const currentTargets = new Set<string>([state.candidateReleaseId]);
  if (state.originalPointers.current !== null) {
    currentTargets.add(state.originalPointers.current);
  }
  const previousTargets = new Set<string>();
  if (state.targetPointers.previous !== null) {
    previousTargets.add(state.targetPointers.previous);
  }
  if (state.originalPointers.previous !== null) {
    previousTargets.add(state.originalPointers.previous);
  }
  const expected = new Map<string, Set<string>>([
    [operationTemporaryLinkName(state.operationId, 'current'), currentTargets],
    [operationTemporaryLinkName(state.operationId, 'previous'), previousTargets],
  ]);
  const found: ValidatedOperationTemporaryLink[] = [];
  for (const entry of readdirSync(rootDir)) {
    if (!isOperationTemporaryEntry(entry)) {
      continue;
    }
    const allowedTargets = expected.get(entry);
    if (allowedTargets === undefined) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'An application release temporary link is not owned by the durable intent.',
      );
    }
    const path = join(rootDir, entry);
    const stats = lstatSync(path);
    if (!stats.isSymbolicLink()) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'An application release temporary entry is not a symbolic link.',
      );
    }
    const target = readlinkSync(path);
    if (![...allowedTargets].some((releaseId) => target === managedReleaseTarget(releaseId))) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'An application release temporary link has an invalid target.',
      );
    }
    found.push({ path, identity: managedEntryIdentity(path) });
  }
  return found;
}

function removeOperationTemporaryLinks(
  rootDir: string,
  links: ValidatedOperationTemporaryLink[],
): void {
  for (const link of links) {
    if (managedEntryIdentity(link.path) !== link.identity) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'Application release temporary link ownership changed before cleanup.',
      );
    }
    rmSync(link.path);
  }
  if (links.length > 0) {
    syncDirectory(rootDir);
  }
}

function assertNoUnownedOperationTemps(rootDir: string): void {
  if (readdirSync(rootDir).some(isOperationTemporaryEntry)) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Application release temporary links exist without a durable intent.',
    );
  }
}

function isOperationTemporaryEntry(entry: string): boolean {
  return (entry.startsWith('.activation-') && entry.endsWith('.tmp')
      && entry !== ACTIVATION_STATE_TEMP_FILE
      && !entry.startsWith(ACTIVATION_LOCK_TEMP_PREFIX))
    || entry.startsWith('.current.tmp-')
    || entry.startsWith('.previous.tmp-');
}

function operationTemporaryLinkName(
  operationId: string,
  pointer: 'current' | 'previous',
): string {
  return `.activation-${operationId}-${pointer}.tmp`;
}

function removeUnpublishedActivationStateTemp(rootDir: string): void {
  const temporaryPath = join(rootDir, ACTIVATION_STATE_TEMP_FILE);
  const kind = managedPathKind(temporaryPath);
  if (kind === 'missing') {
    return;
  }
  if (kind !== 'file') {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Application release intent temporary state is not a regular file.',
    );
  }
  rmSync(temporaryPath);
  syncDirectory(rootDir);
}

function managedPathKind(path: string): 'missing' | 'file' | 'other' {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink() ? 'file' : 'other';
  } catch (error) {
    if (isMissingError(error)) {
      return 'missing';
    }
    throw error;
  }
}

function clearActivationState(rootDir: string, expected: ApplicationActivationState): void {
  const statePath = join(rootDir, ACTIVATION_STATE_FILE);
  const stateIdentity = managedEntryIdentity(statePath);
  const actual = readActivationState(rootDir);
  if (actual === undefined || !activationStatesEqual(actual, expected)) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release intent changed before completion.',
    );
  }
  if (managedEntryIdentity(statePath) !== stateIdentity) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'Durable application release intent ownership changed before cleanup.',
    );
  }
  rmSync(statePath);
  syncDirectory(rootDir);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function createRollbackSnapshot(
  rootDir: string,
  operationId: string,
): Promise<ApplicationRollbackSnapshot> {
  const directoryPath = prepareRollbackDirectory(rootDir);
  const databasePath = managedDatabasePath(rootDir);
  if (!optionalRegularFileExists(databasePath, 'shared database', 'invalid-layout')) {
    assertNoDatabaseSidecars(databasePath, 'invalid-layout');
    syncDirectory(directoryPath);
    return {
      sourceExisted: false,
      sha256: null,
      schemaVersion: null,
      sourceMode: null,
      sourceUid: null,
      sourceGid: null,
    };
  }
  assertRegularFile(databasePath, 'shared database', 'invalid-layout');
  const sourceStats = lstatSync(databasePath);
  const sourceIdentity = managedEntryIdentity(databasePath);

  const snapshotPath = rollbackSnapshotPath(rootDir, operationId);
  const pendingPath = rollbackSnapshotPendingPath(rootDir, operationId);
  assertManagedPathMissing(snapshotPath, 'rollback snapshot');
  assertManagedPathMissing(pendingPath, 'rollback snapshot candidate');
  const source = initDatabase({ path: databasePath, readonly: true });
  try {
    await source.backup(pendingPath);
  } finally {
    closeDatabase(source);
  }
  if (managedEntryIdentity(databasePath) !== sourceIdentity) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The shared database changed while its rollback snapshot was created.',
    );
  }
  chmodSync(pendingPath, 0o600);
  const pending = inspectRollbackDatabase(pendingPath);
  if (!pending.integrityOk || pending.foreignKeyViolations !== 0) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'The pre-activation database snapshot candidate failed verification.',
    );
  }
  removeStoppedDatabaseSidecars(pendingPath);
  fsyncFile(pendingPath);
  renameSync(pendingPath, snapshotPath);
  fsyncFile(snapshotPath);
  syncDirectory(directoryPath);
  const inspected = inspectRollbackDatabase(snapshotPath);
  if (!inspected.integrityOk || inspected.foreignKeyViolations !== 0) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'The pre-activation database snapshot failed verification.',
    );
  }
  const sha256 = await hashRegularFile(snapshotPath);
  removeStoppedDatabaseSidecars(snapshotPath);
  syncDirectory(directoryPath);
  return {
    sourceExisted: true,
    sha256,
    schemaVersion: inspected.schemaVersion,
    sourceMode: sourceStats.mode & 0o777,
    sourceUid: sourceStats.uid,
    sourceGid: sourceStats.gid,
  };
}

async function restoreRollbackDatabase(
  rootDir: string,
  state: ApplicationActivationState,
): Promise<void> {
  if (
    state.schemaVersion === 1
    || state.phase === 'intent_recorded'
    || state.phase === 'rollback_completed'
  ) {
    return;
  }
  const snapshot = state.rollbackSnapshot;
  if (snapshot === null) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The activation state does not contain rollback snapshot metadata.',
    );
  }
  await validateRollbackSnapshot(rootDir, state);

  const databasePath = managedDatabasePath(rootDir);
  const restoreCandidatePath = restoreCandidatePathForOperation(rootDir, state.operationId);
  removeOwnedRestoreCandidate(rootDir, state.operationId);
  removeStoppedDatabaseSidecars(databasePath);
  optionalRegularFileExists(databasePath, 'shared database', 'invalid-recovery-state');
  if (!snapshot.sourceExisted) {
    removeStoppedDatabaseFile(databasePath);
    syncDirectory(join(rootDir, 'shared', 'data'));
    return;
  }

  copyFileSync(
    rollbackSnapshotPath(rootDir, state.operationId),
    restoreCandidatePath,
    constants.COPYFILE_EXCL,
  );
  applyRollbackDatabaseMetadata(restoreCandidatePath, snapshot);
  const candidate = inspectRollbackDatabase(restoreCandidatePath);
  if (
    !candidate.integrityOk
    || candidate.foreignKeyViolations !== 0
    || candidate.schemaVersion !== snapshot.schemaVersion
    || await hashRegularFile(restoreCandidatePath) !== snapshot.sha256
  ) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'The restore candidate does not match the pre-activation snapshot.',
    );
  }
  removeStoppedDatabaseSidecars(restoreCandidatePath);
  fsyncFile(restoreCandidatePath);
  renameSync(restoreCandidatePath, databasePath);
  removeStoppedDatabaseSidecars(rollbackSnapshotPath(rootDir, state.operationId));
  fsyncFile(databasePath);
  syncDirectory(join(rootDir, 'shared', 'data'));
  const restored = inspectRollbackDatabase(databasePath);
  assertRollbackDatabaseMetadata(databasePath, snapshot);
  if (
    !restored.integrityOk
    || restored.foreignKeyViolations !== 0
    || restored.schemaVersion !== snapshot.schemaVersion
    || await hashRegularFile(databasePath) !== snapshot.sha256
  ) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'The restored shared database does not match the pre-activation snapshot.',
    );
  }
}

function applyRollbackDatabaseMetadata(
  path: string,
  snapshot: ApplicationRollbackSnapshot,
): void {
  if (
    snapshot.sourceMode === null
    || snapshot.sourceUid === null
    || snapshot.sourceGid === null
  ) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The rollback snapshot is missing database ownership metadata.',
    );
  }
  const stats = lstatSync(path);
  if (process.platform !== 'win32' && (stats.uid !== snapshot.sourceUid || stats.gid !== snapshot.sourceGid)) {
    chownSync(path, snapshot.sourceUid, snapshot.sourceGid);
  }
  chmodSync(path, snapshot.sourceMode);
}

function assertRollbackDatabaseMetadata(
  path: string,
  snapshot: ApplicationRollbackSnapshot,
): void {
  if (
    snapshot.sourceMode === null
    || snapshot.sourceUid === null
    || snapshot.sourceGid === null
  ) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The rollback snapshot is missing database ownership metadata.',
    );
  }
  const stats = lstatSync(path);
  if (
    (stats.mode & 0o777) !== snapshot.sourceMode
    || (process.platform !== 'win32'
      && (stats.uid !== snapshot.sourceUid || stats.gid !== snapshot.sourceGid))
  ) {
    throw new ApplicationRecoveryError(
      'recovery-failed',
      'The restored shared database ownership does not match the pre-activation database.',
    );
  }
}

async function validateRollbackSnapshot(
  rootDir: string,
  state: ApplicationActivationStateV2,
): Promise<void> {
  const snapshot = state.rollbackSnapshot;
  if (snapshot === null) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The activation state does not contain rollback snapshot metadata.',
    );
  }
  const path = rollbackSnapshotPath(rootDir, state.operationId);
  if (!snapshot.sourceExisted) {
    if (managedPathKind(path) !== 'missing') {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'An unexpected rollback snapshot exists for an originally absent database.',
      );
    }
    return;
  }
  assertRegularFile(path, 'rollback snapshot', 'invalid-recovery-state');
  const inspected = inspectRollbackDatabase(path);
  const actualHash = await hashRegularFile(path);
  removeStoppedDatabaseSidecars(path);
  if (
    !inspected.integrityOk
    || inspected.foreignKeyViolations !== 0
    || inspected.schemaVersion !== snapshot.schemaVersion
    || actualHash !== snapshot.sha256
  ) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The rollback snapshot does not match its durable activation metadata.',
    );
  }
}

function inspectRollbackDatabase(path: string): {
  integrityOk: boolean;
  foreignKeyViolations: number;
  schemaVersion: number;
} {
  const integrityOk = verifySqliteIntegrity(path).ok;
  const db = initDatabase({ path, readonly: true });
  try {
    return {
      integrityOk,
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
      schemaVersion: getSchemaVersion(db),
    };
  } finally {
    closeDatabase(db);
  }
}

function prepareRollbackDirectory(rootDir: string): string {
  const path = join(rootDir, ROLLBACK_DIRECTORY);
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || readdirSync(path).length !== 0) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'The managed rollback directory is not empty and private.',
      );
    }
    chmodSync(path, 0o700);
    return path;
  } catch (error) {
    if (!isMissingError(error)) {
      throw error;
    }
  }
  mkdirSync(path, { mode: 0o700 });
  syncDirectory(rootDir);
  return path;
}

function finalizeActivationStateCleanup(
  rootDir: string,
  state: ApplicationActivationState,
): void {
  if (state.schemaVersion === 2) {
    removeOwnedRestoreCandidate(rootDir, state.operationId);
    removeRollbackSnapshot(
      rootDir,
      state,
      state.phase === 'rollback_completed' || state.phase === 'confirming',
    );
  }
  clearActivationState(rootDir, state);
}

function removeRollbackSnapshot(
  rootDir: string,
  state: ApplicationActivationStateV2,
  allowMissing: boolean,
): void {
  const directoryPath = join(rootDir, ROLLBACK_DIRECTORY);
  const snapshotPath = rollbackSnapshotPath(rootDir, state.operationId);
  const pendingPath = rollbackSnapshotPendingPath(rootDir, state.operationId);
  if (optionalRegularFileExists(
    pendingPath,
    'rollback snapshot candidate',
    'invalid-recovery-state',
  )) {
    removeStoppedDatabaseSidecars(pendingPath);
    rmSync(pendingPath);
    syncDirectory(directoryPath);
  }
  if (optionalRegularFileExists(
    snapshotPath,
    'rollback snapshot',
    'invalid-recovery-state',
  )) {
    removeStoppedDatabaseSidecars(snapshotPath);
    rmSync(snapshotPath);
    syncDirectory(directoryPath);
  } else if (state.rollbackSnapshot?.sourceExisted && !allowMissing) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The durable rollback snapshot is missing.',
    );
  }
  if (managedPathKind(directoryPath) !== 'missing') {
    const stats = lstatSync(directoryPath);
    if (!stats.isDirectory() || stats.isSymbolicLink() || readdirSync(directoryPath).length !== 0) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'The managed rollback directory contains an unexpected entry.',
      );
    }
    rmdirSync(directoryPath);
    syncDirectory(rootDir);
  }
}

function removeStoppedDatabaseSidecars(databasePath: string): void {
  let removed = false;
  for (const path of databaseSidecarPaths(databasePath)) {
    if (managedPathKind(path) === 'missing') {
      continue;
    }
    assertRegularFile(path, 'shared database sidecar', 'invalid-recovery-state');
    rmSync(path);
    removed = true;
  }
  if (removed) {
    syncDirectory(resolve(databasePath, '..'));
  }
}

function assertNoDatabaseSidecars(
  databasePath: string,
  code: ApplicationReleaseErrorCode,
): void {
  for (const path of databaseSidecarPaths(databasePath)) {
    if (optionalRegularFileExists(path, 'shared database sidecar', code)) {
      throw new ApplicationReleaseError(
        code,
        'A shared database sidecar exists without its main database.',
      );
    }
  }
}

function databaseSidecarPaths(databasePath: string): string[] {
  return [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
}

function removeStoppedDatabaseFile(databasePath: string): void {
  if (!optionalRegularFileExists(databasePath, 'shared database', 'invalid-recovery-state')) {
    return;
  }
  assertRegularFile(databasePath, 'shared database', 'invalid-recovery-state');
  rmSync(databasePath);
}

function assertNoOrphanRollbackArtifacts(rootDir: string): void {
  if (managedPathKind(join(rootDir, ROLLBACK_DIRECTORY)) !== 'missing') {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'A managed rollback artifact exists without a durable activation intent.',
    );
  }
}

function assertNoOrphanRestoreArtifacts(rootDir: string): void {
  const dataDirectory = join(rootDir, 'shared', 'data');
  if (readdirSync(dataDirectory).some((entry) => entry.startsWith(RESTORE_PENDING_PREFIX))) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'A managed database restore artifact exists without a durable activation intent.',
    );
  }
}

function removeOwnedRestoreCandidate(rootDir: string, operationId: string): void {
  const dataDirectory = join(rootDir, 'shared', 'data');
  const expectedName = `${RESTORE_PENDING_PREFIX}${operationId}.db`;
  const expectedPath = join(dataDirectory, expectedName);
  removeStoppedDatabaseSidecars(expectedPath);
  const restoreEntries = readdirSync(dataDirectory)
    .filter((entry) => entry.startsWith(RESTORE_PENDING_PREFIX));
  if (restoreEntries.some((entry) => entry !== expectedName)) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The shared database directory contains a foreign restore artifact.',
    );
  }

  if (optionalRegularFileExists(
    expectedPath,
    'database restore candidate',
    'invalid-recovery-state',
  )) {
    rmSync(expectedPath);
    syncDirectory(dataDirectory);
  }
}

function assertManagedPathMissing(path: string, label: string): void {
  if (managedPathKind(path) !== 'missing') {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      `The managed ${label} already exists.`,
    );
  }
}

function managedDatabasePath(rootDir: string): string {
  return join(rootDir, 'shared', 'data', 'lethebot.db');
}

function rollbackSnapshotPath(rootDir: string, operationId: string): string {
  return join(rootDir, ROLLBACK_DIRECTORY, `${operationId}.db`);
}

function rollbackSnapshotPendingPath(rootDir: string, operationId: string): string {
  return join(rootDir, ROLLBACK_DIRECTORY, `${operationId}${ROLLBACK_PENDING_SUFFIX}`);
}

function restoreCandidatePathForOperation(rootDir: string, operationId: string): string {
  return join(rootDir, 'shared', 'data', `${RESTORE_PENDING_PREFIX}${operationId}.db`);
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function hashRegularFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = createReadStream(path, {
    fd: descriptor,
    autoClose: true,
  });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function validateReleaseId(releaseId: string): string {
  if (!isValidReleaseId(releaseId)) {
    throw new ApplicationReleaseError(
      'invalid-release-id',
      'Release id must be a single managed release directory name.',
    );
  }
  return releaseId;
}

function validateOperationId(operationId: string): string {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new ApplicationReleaseError(
      'confirmation-required',
      'Release confirmation requires a valid activation operation id.',
    );
  }
  return operationId;
}

function isValidReleaseId(releaseId: string): boolean {
  return RELEASE_ID_PATTERN.test(releaseId) && releaseId !== '.' && releaseId !== '..';
}

function validateDuration(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const selected = value ?? defaultValue;
  if (!Number.isInteger(selected) || selected <= 0 || selected > maximum) {
    throw new ApplicationReleaseError(
      'invalid-layout',
      'Activation timing must be a bounded positive integer.',
    );
  }
  return selected;
}

function validateManagedLayout(rootDir: string): void {
  assertDirectory(rootDir, 'deployment root');
  assertDirectory(join(rootDir, 'releases'), 'releases directory');
  assertDirectory(join(rootDir, 'shared'), 'shared directory');
  assertDirectory(join(rootDir, 'shared', 'data'), 'shared data directory');
  assertDirectory(join(rootDir, 'shared', 'logs'), 'shared logs directory');
  assertRegularFile(join(rootDir, 'shared', 'runtime.env'), 'shared runtime environment');
}

function validateCandidate(candidateDir: string): string {
  try {
    return calculateManagedReleaseDigest(candidateDir);
  } catch (error) {
    throw new ApplicationReleaseError(
      'invalid-candidate',
      'Candidate runtime artifacts are invalid or missing.',
      { cause: error },
    );
  }
}

function managedEntryIdentity(path: string): string {
  const stats = lstatSync(path);
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function managedEntryObjectIdentity(path: string): string {
  const stats = lstatSync(path);
  return `${stats.dev}:${stats.ino}`;
}

function candidateStillMatches(candidateDir: string, expectedIdentity: string): boolean {
  const preflight = runReleasePreflight(candidateDir);
  if (!preflight.ok) {
    return false;
  }
  return managedReleaseMatches(candidateDir, expectedIdentity);
}

function assertDirectory(
  path: string,
  label: string,
  code: ApplicationReleaseErrorCode = 'invalid-layout',
): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('not a managed directory');
    }
  } catch (error) {
    throw new ApplicationReleaseError(code, `Required ${label} is invalid or missing.`, {
      cause: error,
    });
  }
}

function assertRegularFile(
  path: string,
  label: string,
  code: ApplicationReleaseErrorCode = 'invalid-layout',
): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('not a managed regular file');
    }
  } catch (error) {
    throw new ApplicationReleaseError(code, `Required ${label} is invalid or missing.`, {
      cause: error,
    });
  }
}

function optionalRegularFileExists(
  path: string,
  label: string,
  code: ApplicationReleaseErrorCode,
): boolean {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw new ApplicationReleaseError(code, `Optional ${label} could not be inspected.`, {
      cause: error,
    });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ApplicationReleaseError(code, `Optional ${label} is not a managed regular file.`);
  }
  return true;
}

async function acquireActivationLock(
  rootDir: string,
  timeoutMs: number,
  retryMs: number,
): Promise<{ release(): void }> {
  const lockPath = join(rootDir, ACTIVATION_LOCK_FILE);
  const deadline = Date.now() + timeoutMs;
  reconcileStaleActivationLockQuarantine(rootDir, lockPath);
  reconcileStaleActivationLockTemps(rootDir);
  const owner = createActivationLockOwner();
  const serializedOwner = `${JSON.stringify(owner)}\n`;

  while (true) {
    const temporaryPath = join(rootDir, activationLockTempName(owner));
    let descriptor: number | undefined;
    let temporaryIdentity: string | undefined;
    let lockPublished = false;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      temporaryIdentity = fileDescriptorObjectIdentity(descriptor);
      writeFileSync(descriptor, serializedOwner, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      if (
        managedEntryObjectIdentity(temporaryPath) !== temporaryIdentity
        || !activationLockOwnersEqual(readActivationLockOwner(temporaryPath), owner)
      ) {
        throw new Error('Activation lock candidate changed before publication.');
      }
      linkSync(temporaryPath, lockPath);
      lockPublished = true;
      if (
        managedEntryObjectIdentity(lockPath) !== temporaryIdentity
        || !activationLockOwnersEqual(readActivationLockOwner(lockPath), owner)
      ) {
        throw new Error('Activation lock changed during publication.');
      }
      removeOwnedActivationLockTemp(temporaryPath, temporaryIdentity);
      syncDirectory(rootDir);
      const lockIdentity = managedEntryObjectIdentity(lockPath);
      return {
        release(): void {
          removeOwnedActivationLock(rootDir, lockPath, owner, lockIdentity);
        },
      };
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      const cleanupErrors: unknown[] = [];
      if (temporaryIdentity !== undefined) {
        try {
          removeOwnedActivationLockTemp(temporaryPath, temporaryIdentity);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (lockPublished) {
        try {
          removeOwnedActivationLock(rootDir, lockPath, owner);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new ApplicationReleaseError(
          'activation-locked',
          'The activation lock failed during publication and could not be cleaned up.',
          { cause: new AggregateError([error, ...cleanupErrors]) },
        );
      }
      if (!isAlreadyExistsError(error)) {
        throw new ApplicationReleaseError(
          'activation-locked',
          'The activation lock could not be acquired.',
          { cause: error },
        );
      }

      if (tryReclaimStaleActivationLock(lockPath, rootDir)) {
        continue;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ApplicationReleaseError(
          'activation-locked',
          'Another application activation still owns the bounded activation lock.',
        );
      }
      await delay(Math.min(retryMs, remainingMs));
    }
  }
}

function reconcileStaleActivationLockTemps(rootDir: string): void {
  let removed = false;
  for (const entry of readdirSync(rootDir)) {
    if (
      !entry.startsWith(ACTIVATION_LOCK_TEMP_PREFIX)
      || !entry.endsWith(ACTIVATION_LOCK_TEMP_SUFFIX)
    ) {
      continue;
    }
    const path = join(rootDir, entry);
    if (entry.startsWith(ACTIVATION_LOCK_TEMP_V2_PREFIX)) {
      const owner = parseActivationLockTempOwner(entry);
      const snapshot = readActivationLockTempSnapshot(path);
      const expectedContent = serializeActivationLockOwner(owner);
      if (!expectedContent.startsWith(snapshot.content)) {
        throw new ApplicationReleaseError(
          'activation-locked',
          'An activation lock candidate has invalid partial owner metadata.',
        );
      }
      let processIdentity: string | null;
      try {
        processIdentity = readProcessIdentity(owner.pid);
      } catch (error) {
        throw new ApplicationReleaseError(
          'activation-locked',
          'An activation lock candidate owner could not be verified.',
          { cause: error },
        );
      }
      if (processIdentity !== owner.processIdentity) {
        removeStableActivationLockTemp(path, snapshot);
        removed = true;
      }
      continue;
    }

    const nonce = entry.slice(
      ACTIVATION_LOCK_TEMP_PREFIX.length,
      -ACTIVATION_LOCK_TEMP_SUFFIX.length,
    );
    if (!OPERATION_ID_PATTERN.test(nonce)) {
      throw new ApplicationReleaseError(
        'activation-locked',
        'An activation lock candidate has an invalid owner name.',
      );
    }
    const snapshot = readActivationLockTempSnapshot(path);
    let owner: ActivationLockOwner;
    let processIdentity: string | null;
    try {
      owner = parseActivationLockOwner(snapshot.content);
      processIdentity = readProcessIdentity(owner.pid);
    } catch (error) {
      throw new ApplicationReleaseError(
        'activation-locked',
        'A legacy activation lock candidate requires operator reconciliation.',
        { cause: error },
      );
    }
    if (owner.nonce !== nonce) {
      throw new ApplicationReleaseError(
        'activation-locked',
        'An activation lock candidate has a mismatched owner.',
      );
    }
    if (processIdentity === owner.processIdentity) {
      continue;
    }
    removeStableActivationLockTemp(path, snapshot);
    removed = true;
  }
  if (removed) {
    syncDirectory(rootDir);
  }
}

function reconcileStaleActivationLockQuarantine(rootDir: string, lockPath: string): void {
  const entries = readdirSync(rootDir)
    .filter((entry) => entry.startsWith(ACTIVATION_LOCK_QUARANTINE_PREFIX));
  if (entries.length === 0) {
    return;
  }
  if (entries.length !== 1 || managedPathKind(lockPath) !== 'missing') {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock quarantine requires operator reconciliation.',
    );
  }

  const entry = entries[0] as string;
  const path = join(rootDir, entry);
  let owner: ActivationLockOwner;
  let identity: string;
  let processIdentity: string | null;
  try {
    owner = readActivationLockOwner(path);
    identity = managedEntryObjectIdentity(path);
    processIdentity = readProcessIdentity(owner.pid);
  } catch (error) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock quarantine could not be reconciled.',
      { cause: error },
    );
  }
  if (
    entry !== `${ACTIVATION_LOCK_QUARANTINE_PREFIX}${owner.nonce}`
    || processIdentity === owner.processIdentity
    || managedEntryObjectIdentity(path) !== identity
    || !activationLockOwnersEqual(readActivationLockOwner(path), owner)
  ) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock quarantine requires operator reconciliation.',
    );
  }
  rmSync(path);
  syncDirectory(rootDir);
}

interface ActivationLockTempSnapshot {
  identity: string;
  content: string;
}

function readActivationLockTempSnapshot(path: string): ActivationLockTempSnapshot {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock candidate could not be inspected.',
      { cause: error },
    );
  }
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || (stats.mode & 0o777) !== 0o600
    || stats.size > MAX_ACTIVATION_LOCK_BYTES
  ) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock candidate is not a private bounded regular file.',
    );
  }
  const identity = managedEntryIdentity(path);
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock candidate could not be read.',
      { cause: error },
    );
  }
  if (managedEntryIdentity(path) !== identity) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock candidate changed while being inspected.',
    );
  }
  return { identity, content };
}

function removeStableActivationLockTemp(
  path: string,
  expected: ActivationLockTempSnapshot,
): void {
  const observed = readActivationLockTempSnapshot(path);
  if (observed.identity !== expected.identity || observed.content !== expected.content) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock candidate changed before reconciliation.',
    );
  }
  rmSync(path);
}

function createActivationLockOwner(): ActivationLockOwner {
  const processIdentity = readProcessIdentity(process.pid);
  if (processIdentity === null) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'The activation lock owner identity could not be established.',
    );
  }
  return {
    schemaVersion: 1,
    pid: process.pid,
    processIdentity,
    nonce: randomUUID(),
  };
}

function activationLockTempName(owner: ActivationLockOwner): string {
  const encodedIdentity = Buffer.from(owner.processIdentity, 'utf8').toString('base64url');
  return [
    ACTIVATION_LOCK_TEMP_V2_PREFIX,
    owner.nonce,
    '.',
    owner.pid,
    '.',
    encodedIdentity,
    ACTIVATION_LOCK_TEMP_SUFFIX,
  ].join('');
}

function parseActivationLockTempOwner(entry: string): ActivationLockOwner {
  const body = entry.slice(
    ACTIVATION_LOCK_TEMP_V2_PREFIX.length,
    -ACTIVATION_LOCK_TEMP_SUFFIX.length,
  );
  const parts = body.split('.');
  if (parts.length !== 3) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock candidate has an invalid owner name.',
    );
  }
  const [nonce, pidText, encodedIdentity] = parts;
  const pid = Number(pidText);
  let processIdentity: string;
  try {
    processIdentity = Buffer.from(encodedIdentity as string, 'base64url').toString('utf8');
  } catch (error) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock candidate has an invalid owner name.',
      { cause: error },
    );
  }
  const owner: ActivationLockOwner = {
    schemaVersion: 1,
    pid,
    processIdentity,
    nonce: nonce as string,
  };
  if (
    !OPERATION_ID_PATTERN.test(owner.nonce)
    || !/^[1-9]\d*$/.test(pidText as string)
    || !Number.isSafeInteger(owner.pid)
    || owner.processIdentity.length < 1
    || owner.processIdentity.length > 512
    || Buffer.from(owner.processIdentity, 'utf8').toString('base64url') !== encodedIdentity
    || activationLockTempName(owner) !== entry
  ) {
    throw new ApplicationReleaseError(
      'activation-locked',
      'An activation lock candidate has an invalid owner name.',
    );
  }
  return owner;
}

function serializeActivationLockOwner(owner: ActivationLockOwner): string {
  return `${JSON.stringify(owner)}\n`;
}

function fileDescriptorObjectIdentity(descriptor: number): string {
  const stats = fstatSync(descriptor);
  return `${stats.dev}:${stats.ino}`;
}

function removeOwnedActivationLockTemp(path: string, expectedIdentity: string): void {
  const kind = managedPathKind(path);
  if (kind === 'missing') {
    return;
  }
  if (managedEntryObjectIdentity(path) !== expectedIdentity) {
    throw new Error('Activation lock candidate ownership changed before cleanup.');
  }
  rmSync(path);
}

function tryReclaimStaleActivationLock(lockPath: string, rootDir: string): boolean {
  let lockIdentity: string;
  let owner: ActivationLockOwner;
  try {
    lockIdentity = managedEntryObjectIdentity(lockPath);
    owner = readActivationLockOwner(lockPath);
  } catch {
    return false;
  }

  let currentIdentity: string | null;
  try {
    currentIdentity = readProcessIdentity(owner.pid);
  } catch {
    return false;
  }
  if (currentIdentity === owner.processIdentity) {
    return false;
  }

  try {
    removeOwnedActivationLock(rootDir, lockPath, owner, lockIdentity);
    return true;
  } catch {
    return false;
  }
}

function removeOwnedActivationLock(
  rootDir: string,
  lockPath: string,
  expectedOwner: ActivationLockOwner,
  expectedIdentity?: string,
): void {
  const observedIdentity = managedEntryObjectIdentity(lockPath);
  if (
    (expectedIdentity !== undefined && observedIdentity !== expectedIdentity)
    || !activationLockOwnersEqual(readActivationLockOwner(lockPath), expectedOwner)
  ) {
    throw new Error('Activation lock ownership changed before cleanup.');
  }

  const quarantinePath = join(
    rootDir,
    `${ACTIVATION_LOCK_QUARANTINE_PREFIX}${expectedOwner.nonce}`,
  );
  assertManagedPathMissing(quarantinePath, 'activation lock quarantine');
  renameSync(lockPath, quarantinePath);
  syncDirectory(rootDir);

  if (
    managedEntryObjectIdentity(quarantinePath) !== observedIdentity
    || !activationLockOwnersEqual(readActivationLockOwner(quarantinePath), expectedOwner)
  ) {
    if (managedPathKind(lockPath) === 'missing') {
      renameSync(quarantinePath, lockPath);
      syncDirectory(rootDir);
    }
    throw new Error('Activation lock replacement was quarantined during cleanup.');
  }

  rmSync(quarantinePath);
  syncDirectory(rootDir);
}

function readActivationLockOwner(path: string): ActivationLockOwner {
  const stats = lstatSync(path);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size < 1
    || stats.size > MAX_ACTIVATION_LOCK_BYTES
    || (stats.mode & 0o777) !== 0o600
  ) {
    throw new Error('invalid activation lock owner file');
  }
  return parseActivationLockOwner(readFileSync(path, 'utf8'));
}

function parseActivationLockOwner(content: string): ActivationLockOwner {
  const value = JSON.parse(content) as unknown;
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'pid', 'processIdentity', 'nonce'])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.processIdentity !== 'string'
    || value.processIdentity.length < 1
    || value.processIdentity.length > 512
    || typeof value.nonce !== 'string'
    || !OPERATION_ID_PATTERN.test(value.nonce)
  ) {
    throw new Error('invalid activation lock owner metadata');
  }
  return {
    schemaVersion: 1,
    pid: value.pid as number,
    processIdentity: value.processIdentity,
    nonce: value.nonce,
  };
}

function activationLockOwnersEqual(
  left: ActivationLockOwner,
  right: ActivationLockOwner,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.pid === right.pid
    && left.processIdentity === right.processIdentity
    && left.nonce === right.nonce;
}

function readProcessIdentity(pid: number): string | null {
  if (process.platform === 'linux') {
    let bootId: string;
    let stat: string;
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      if (isMissingError(error)) {
        return null;
      }
      throw error;
    }
    const commandEnd = stat.lastIndexOf(')');
    const fields = commandEnd === -1
      ? []
      : stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTimeTicks = fields[19];
    if (!bootId || !startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
      throw new Error('invalid process identity metadata');
    }
    return `linux:${bootId}:${startTimeTicks}`;
  }

  try {
    process.kill(pid, 0);
    return `pid:${pid}`;
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ESRCH'
    ) {
      return null;
    }
    return `pid:${pid}`;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function readManagedPointer(
  rootDir: string,
  pointer: 'current' | 'previous',
): string | undefined {
  const pointerPath = join(rootDir, pointer);
  let stats;
  try {
    stats = lstatSync(pointerPath);
  } catch (error) {
    if (isMissingError(error)) {
      return undefined;
    }
    throw new ApplicationReleaseError(
      'invalid-layout',
      `Managed ${pointer} pointer could not be inspected.`,
      { cause: error },
    );
  }

  if (!stats.isSymbolicLink()) {
    throw new ApplicationReleaseError(
      'invalid-layout',
      `Managed ${pointer} pointer must be a symbolic link.`,
    );
  }

  const target = readlinkSync(pointerPath);
  const prefix = 'releases/';
  if (!target.startsWith(prefix)) {
    throw new ApplicationReleaseError(
      'invalid-layout',
      `Managed ${pointer} pointer has an invalid target.`,
    );
  }

  const releaseId = target.slice(prefix.length);
  let validatedReleaseId: string;
  try {
    validatedReleaseId = validateReleaseId(releaseId);
  } catch (error) {
    throw new ApplicationReleaseError(
      'invalid-layout',
      `Managed ${pointer} pointer has an invalid target.`,
      { cause: error },
    );
  }
  if (target !== managedReleaseTarget(validatedReleaseId)) {
    throw new ApplicationReleaseError(
      'invalid-layout',
      `Managed ${pointer} pointer has an invalid target.`,
    );
  }
  assertDirectory(join(rootDir, 'releases', releaseId), `${pointer} release`, 'invalid-layout');
  return releaseId;
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function managedReleaseTarget(releaseId: string): string {
  return `releases/${releaseId}`;
}

function publishCandidatePointers(
  rootDir: string,
  state: ApplicationActivationState,
): void {
  const previousReleaseId = nullableReleaseId(state.targetPointers.previous);
  if (previousReleaseId === undefined) {
    removeManagedPointer(rootDir, 'previous');
  } else {
    replaceManagedPointer(rootDir, 'previous', previousReleaseId, state.operationId);
  }
  replaceManagedPointer(rootDir, 'current', state.candidateReleaseId, state.operationId);
}

async function rollbackApplicationRelease(options: {
  rootDir: string;
  activationState: ApplicationActivationState;
  candidateStartAttempted: boolean;
  supervisor: ApplicationSupervisor;
  probe: ApplicationProbe;
}): Promise<string[]> {
  const failures: string[] = [];
  let activationState = options.activationState;

  if (options.candidateStartAttempted) {
    try {
      await options.supervisor.stop();
    } catch {
      failures.push('stop-candidate');
      return failures;
    }
  }

  try {
    assertOriginalReleaseMatches(options.rootDir, activationState);
  } catch {
    failures.push('validate-previous-release');
    return failures;
  }

  try {
    clearManagedStartupAuthorization(options.rootDir, activationState.operationId);
  } catch {
    failures.push('clear-start-authorization');
    return failures;
  }

  try {
    await restoreRollbackDatabase(options.rootDir, activationState);
  } catch {
    failures.push('restore-database');
    return failures;
  }

  try {
    const temporaryLinks = validateOperationTemporaryLinks(
      options.rootDir,
      activationState,
    );
    removeOperationTemporaryLinks(options.rootDir, temporaryLinks);
  } catch {
    failures.push('cleanup-temporary-links');
    return failures;
  }

  try {
    restoreManagedPointer(
      options.rootDir,
      'current',
      nullableReleaseId(activationState.originalPointers.current),
      activationState.operationId,
    );
  } catch {
    failures.push('restore-current');
    return failures;
  }

  try {
    restoreManagedPointer(
      options.rootDir,
      'previous',
      nullableReleaseId(activationState.originalPointers.previous),
      activationState.operationId,
    );
  } catch {
    failures.push('restore-previous');
    return failures;
  }

  if (activationState.originalPointers.current !== null) {
    failures.push(...await startAndProbePrevious(
      options.rootDir,
      activationState,
      activationState.originalPointers.current,
      options.supervisor,
      options.probe,
    ));
  }
  if (failures.length > 0) {
    return failures;
  }

  try {
    const restoredPointers = readPointerStateForRecovery(options.rootDir);
    if (!pointerStatesEqual(
      persistPointerState(restoredPointers),
      activationState.originalPointers,
    )) {
      throw new Error('restored pointers changed before activation intent cleanup');
    }
    if (activationState.schemaVersion === 2) {
      const rollbackCompletedState: ApplicationActivationStateV2 = {
        ...activationState,
        phase: 'rollback_completed',
      };
      replaceActivationState(options.rootDir, activationState, rollbackCompletedState);
      activationState = rollbackCompletedState;
    }
    finalizeActivationStateCleanup(options.rootDir, activationState);
  } catch {
    failures.push('clear-recovery-state');
  }
  return failures;
}

function assertOriginalReleaseMatches(
  rootDir: string,
  state: ApplicationActivationState,
): void {
  if (state.schemaVersion === 1 || state.originalPointers.current === null) {
    return;
  }
  if (
    state.originalReleaseDigest === null
    || !managedReleaseMatches(
      join(rootDir, 'releases', state.originalPointers.current),
      state.originalReleaseDigest,
    )
  ) {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'The original release changed after the activation intent was recorded.',
    );
  }
}

async function startAndProbePrevious(
  rootDir: string,
  activationState: ApplicationActivationState,
  releaseId: string,
  supervisor: ApplicationSupervisor,
  probe: ApplicationProbe,
): Promise<string[]> {
  try {
    persistManagedStartupAuthorization({
      rootDir,
      operationId: activationState.operationId,
      releaseId,
    });
    await supervisor.start({ rootDir, releaseId });
  } catch {
    return ['restart-previous'];
  }

  try {
    await probe.check('health');
    completeManagedStartupAuthorization(rootDir, activationState.operationId);
  } catch {
    return ['probe-previous-health'];
  }

  try {
    await probe.check('readiness');
  } catch {
    return ['probe-previous-readiness'];
  }
  return [];
}

async function restartReleaseUnderPendingState(
  rootDir: string,
  state: ApplicationActivationState,
  releaseId: string,
  supervisor: ApplicationSupervisor,
  probe: ApplicationProbe,
): Promise<void> {
  await supervisor.assertReady?.();
  await supervisor.stop();
  clearManagedStartupAuthorization(rootDir, state.operationId);
  persistManagedStartupAuthorization({
    rootDir,
    operationId: state.operationId,
    releaseId,
  });
  await supervisor.start({ rootDir, releaseId });
  await probe.check('health');
  completeManagedStartupAuthorization(rootDir, state.operationId);
  await probe.check('readiness');
}

function restoreManagedPointer(
  rootDir: string,
  pointer: 'current' | 'previous',
  releaseId: string | undefined,
  operationId: string,
): void {
  if (releaseId === undefined) {
    removeManagedPointer(rootDir, pointer);
    return;
  }
  replaceManagedPointer(rootDir, pointer, releaseId, operationId);
}

function replaceManagedPointer(
  rootDir: string,
  pointer: 'current' | 'previous',
  releaseId: string,
  operationId: string,
): void {
  const temporaryPath = join(rootDir, operationTemporaryLinkName(operationId, pointer));
  if (managedPathKind(temporaryPath) !== 'missing') {
    throw new ApplicationRecoveryError(
      'invalid-recovery-state',
      'An application release temporary link already exists.',
    );
  }
  let temporaryIdentity: string | undefined;
  let operationError: unknown;
  try {
    symlinkSync(managedReleaseTarget(releaseId), temporaryPath);
    temporaryIdentity = managedEntryIdentity(temporaryPath);
    syncDirectory(rootDir);
    renameSync(temporaryPath, join(rootDir, pointer));
    temporaryIdentity = undefined;
    syncDirectory(rootDir);
  } catch (error) {
    operationError = error;
  }
  if (temporaryIdentity !== undefined) {
    let cleanupError: unknown;
    try {
      if (managedEntryIdentity(temporaryPath) !== temporaryIdentity) {
        throw new Error('temporary link ownership changed');
      }
      rmSync(temporaryPath);
      syncDirectory(rootDir);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError !== undefined) {
      throw new ApplicationRecoveryError(
        'invalid-recovery-state',
        'Application release temporary link cleanup could not be verified.',
        operationError === undefined
          ? cleanupError
          : new AggregateError([operationError, cleanupError]),
      );
    }
  }
  if (operationError !== undefined) {
    throw operationError;
  }
}

function removeManagedPointer(
  rootDir: string,
  pointer: 'current' | 'previous',
): void {
  const pointerPath = join(rootDir, pointer);
  try {
    const stats = lstatSync(pointerPath);
    if (!stats.isSymbolicLink()) {
      throw new ApplicationReleaseError(
        'invalid-layout',
        `Managed ${pointer} pointer must be a symbolic link.`,
      );
    }
  } catch (error) {
    if (isMissingError(error)) {
      return;
    }
    throw error;
  }
  rmSync(pointerPath);
  syncDirectory(rootDir);
}
