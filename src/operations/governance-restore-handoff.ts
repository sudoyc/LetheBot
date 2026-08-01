/**
 * Durable, HTTP-disabled handoff evidence for a stopped-service restore.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const HANDOFF_DIRECTORY_NAME = '.lethebot-governance-restore-handoff';
const PENDING_FILE_NAME = 'pending.json';
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const BACKUP_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HANDOFF_LIFETIME_MS = 15 * 60 * 1_000;
const MINIMUM_TIMESTAMP_MS = 0;
const MAXIMUM_TIMESTAMP_MS = Date.parse('9999-12-31T23:44:59.999Z');
const MAXIMUM_ENVELOPE_BYTES = 2_048;

export interface GovernanceRestoreHandoffInput {
  databasePath: string;
  backupRef: string;
  previewDigest: string;
  contractVersion: 1;
  now: Date;
}

export interface GovernanceRestoreHandoffPendingReceipt {
  status: 'pending';
  handoffId: string;
  expiresAt: string;
  executionBoundary: 'stopped_service_only';
  effects: {
    restoreExecution: false;
  };
}

export interface GovernanceRestoreHandoffAttentionReceipt {
  status: 'attention_required';
  handoffId: null;
  expiresAt: null;
  executionBoundary: 'stopped_service_only';
  effects: {
    restoreExecution: false;
  };
}

export type GovernanceRestoreHandoffReceipt =
  | GovernanceRestoreHandoffPendingReceipt
  | GovernanceRestoreHandoffAttentionReceipt;

interface PreparedHandoff {
  directoryPath: string;
  content: string;
  receipt: GovernanceRestoreHandoffPendingReceipt;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

export function prepareGovernanceRestoreHandoff(
  input: GovernanceRestoreHandoffInput,
): GovernanceRestoreHandoffReceipt {
  try {
    return publishPendingHandoff(prepareHandoff(input));
  } catch {
    return attentionReceipt();
  }
}

function prepareHandoff(input: GovernanceRestoreHandoffInput): PreparedHandoff {
  if (
    !BACKUP_REFERENCE_PATTERN.test(input.backupRef)
    || !SHA256_PATTERN.test(input.previewDigest)
    || input.contractVersion !== 1
  ) {
    throw new Error('Invalid restore handoff evidence.');
  }

  const createdAtMs = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  if (
    !Number.isSafeInteger(createdAtMs)
    || createdAtMs < MINIMUM_TIMESTAMP_MS
    || createdAtMs > MAXIMUM_TIMESTAMP_MS
  ) {
    throw new Error('Invalid restore handoff time.');
  }
  if (
    typeof input.databasePath !== 'string'
    || !isAbsolute(input.databasePath)
    || resolve(input.databasePath) !== input.databasePath
  ) {
    throw new Error('Invalid restore handoff database location.');
  }

  const databaseDirectory = dirname(input.databasePath);
  assertCanonicalDirectory(databaseDirectory);
  const directoryPath = join(databaseDirectory, HANDOFF_DIRECTORY_NAME);
  const handoffId = randomBytes(32).toString('base64url');
  if (!HANDOFF_ID_PATTERN.test(handoffId)) {
    throw new Error('Invalid restore handoff identifier.');
  }

  const createdAt = new Date(createdAtMs).toISOString();
  const expiresAt = new Date(createdAtMs + HANDOFF_LIFETIME_MS).toISOString();
  const envelope = {
    schemaVersion: 1,
    state: 'pending',
    handoffId,
    backupRef: input.backupRef,
    previewDigest: input.previewDigest,
    restoreContractVersion: input.contractVersion,
    createdAt,
    expiresAt,
    executionBoundary: 'stopped_service_only',
  } as const;
  const content = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAXIMUM_ENVELOPE_BYTES) {
    throw new Error('Invalid restore handoff envelope.');
  }

  return {
    directoryPath,
    content,
    receipt: {
      status: 'pending',
      handoffId,
      expiresAt,
      executionBoundary: 'stopped_service_only',
      effects: { restoreExecution: false },
    },
  };
}

function publishPendingHandoff(prepared: PreparedHandoff): GovernanceRestoreHandoffPendingReceipt {
  const directoryIdentity = ensurePrivateHandoffDirectory(prepared.directoryPath);
  if (readdirSync(prepared.directoryPath).length !== 0) {
    throw new Error('Restore handoff state already exists.');
  }

  const pendingPath = join(prepared.directoryPath, PENDING_FILE_NAME);
  const stagingName = `.pending.${prepared.receipt.handoffId}.tmp`;
  const stagingPath = join(prepared.directoryPath, stagingName);
  let descriptor: number | undefined;
  let stagingIdentity: FileIdentity | undefined;
  try {
    descriptor = openSync(
      stagingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor);
    assertPrivateFile(opened, 1);
    const publishedIdentity = identityOf(opened);
    stagingIdentity = publishedIdentity;
    writeFileSync(descriptor, prepared.content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    assertDirectoryIdentity(prepared.directoryPath, directoryIdentity);
    if (!sameEntries(readdirSync(prepared.directoryPath), [stagingName])) {
      throw new Error('Restore handoff state raced during staging.');
    }
    assertExactFile(stagingPath, publishedIdentity, prepared.content, 1);

    linkSync(stagingPath, pendingPath);
    assertDirectoryIdentity(prepared.directoryPath, directoryIdentity);
    assertExactFile(pendingPath, publishedIdentity, prepared.content, 2);
    syncDirectory(prepared.directoryPath);

    unlinkSync(stagingPath);
    stagingIdentity = undefined;
    syncDirectory(prepared.directoryPath);

    assertDirectoryIdentity(prepared.directoryPath, directoryIdentity);
    if (!sameEntries(readdirSync(prepared.directoryPath), [PENDING_FILE_NAME])) {
      throw new Error('Restore handoff publication has an unexpected entry.');
    }
    assertExactFile(pendingPath, publishedIdentity, prepared.content, 1);
    return prepared.receipt;
  } finally {
    try {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    } finally {
      if (stagingIdentity !== undefined) {
        removeOwnedStagingFile(stagingPath, stagingIdentity, prepared.directoryPath);
      }
    }
  }
}

function ensurePrivateHandoffDirectory(directoryPath: string): FileIdentity {
  let created = false;
  try {
    mkdirSync(directoryPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }

  if (created) {
    chmodSync(directoryPath, 0o700);
  }
  const descriptor = openSync(
    directoryPath,
    constants.O_RDONLY | directoryFlag() | noFollowFlag(),
  );
  try {
    if (created) {
      fchmodSync(descriptor, 0o700);
    }
    const stats = fstatSync(descriptor);
    assertPrivateDirectory(stats);
    const identity = identityOf(stats);
    if (realpathSync(directoryPath) !== directoryPath) {
      throw new Error('Restore handoff directory is not canonical.');
    }
    if (created) {
      syncDirectory(dirname(directoryPath));
    }
    return identity;
  } finally {
    closeSync(descriptor);
  }
}

function assertCanonicalDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error('Restore handoff database directory is invalid.');
  }
}

function assertPrivateDirectory(stats: Stats): void {
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || (stats.mode & 0o7777) !== 0o700
    || !hasCurrentOwner(stats)
  ) {
    throw new Error('Restore handoff directory is not private.');
  }
}

function assertPrivateFile(stats: Stats, expectedLinks: number): void {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || (stats.mode & 0o7777) !== 0o600
    || stats.nlink !== expectedLinks
    || stats.size > MAXIMUM_ENVELOPE_BYTES
    || !hasCurrentOwner(stats)
  ) {
    throw new Error('Restore handoff file is not private.');
  }
}

function assertExactFile(
  path: string,
  expectedIdentity: FileIdentity,
  expectedContent: string,
  expectedLinks: number,
): void {
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    const stats = fstatSync(descriptor);
    assertPrivateFile(stats, expectedLinks);
    if (!identitiesEqual(identityOf(stats), expectedIdentity)) {
      throw new Error('Restore handoff file identity changed.');
    }
    const content = readFileSync(descriptor, 'utf8');
    const after = fstatSync(descriptor);
    if (
      !identitiesEqual(identityOf(after), expectedIdentity)
      || after.size !== stats.size
      || content !== expectedContent
    ) {
      throw new Error('Restore handoff file changed while being read.');
    }
  } finally {
    closeSync(descriptor);
  }
}

function removeOwnedStagingFile(
  path: string,
  expectedIdentity: FileIdentity,
  directoryPath: string,
): void {
  try {
    const stats = lstatSync(path);
    if (
      stats.isFile()
      && !stats.isSymbolicLink()
      && identitiesEqual(identityOf(stats), expectedIdentity)
      && hasCurrentOwner(stats)
    ) {
      unlinkSync(path);
      syncDirectory(directoryPath);
    }
  } catch {
    // An unsafe or changed entry is left untouched for operator reconciliation.
  }
}

function assertDirectoryIdentity(path: string, expected: FileIdentity): void {
  const stats = lstatSync(path);
  assertPrivateDirectory(stats);
  if (!identitiesEqual(identityOf(stats), expected) || realpathSync(path) !== path) {
    throw new Error('Restore handoff directory identity changed.');
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | directoryFlag() | noFollowFlag());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hasCurrentOwner(stats: Stats): boolean {
  return typeof process.getuid !== 'function' || stats.uid === process.getuid();
}

function identityOf(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameEntries(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function attentionReceipt(): GovernanceRestoreHandoffAttentionReceipt {
  return {
    status: 'attention_required',
    handoffId: null,
    expiresAt: null,
    executionBoundary: 'stopped_service_only',
    effects: { restoreExecution: false },
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
}
