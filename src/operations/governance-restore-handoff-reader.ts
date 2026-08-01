/**
 * Read-only validation of a durable stopped-service restore handoff.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const HANDOFF_DIRECTORY_NAME = '.lethebot-governance-restore-handoff';
const PENDING_FILE_NAME = 'pending.json';
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const BACKUP_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HANDOFF_LIFETIME_MS = 15 * 60 * 1_000;
const MAXIMUM_TIMESTAMP_MS = Date.parse('9999-12-31T23:44:59.999Z');
const MAXIMUM_EXPIRY_TIMESTAMP_MS = MAXIMUM_TIMESTAMP_MS + HANDOFF_LIFETIME_MS;
const MAXIMUM_ENVELOPE_BYTES = 2_048;

export interface GovernanceRestoreHandoffReaderInput {
  databasePath: string;
  now?: Date;
}

export interface GovernanceRestoreHandoffReaderPendingReceipt {
  status: 'pending';
  handoffId: string;
  expiresAt: string;
  contractVersion: 1;
  executionBoundary: 'stopped_service_only';
  effects: {
    restoreExecution: false;
  };
}

export interface GovernanceRestoreHandoffReaderAttentionReceipt {
  status: 'attention_required';
  handoffId: null;
  expiresAt: null;
  contractVersion: null;
  executionBoundary: 'stopped_service_only';
  effects: {
    restoreExecution: false;
  };
}

export type GovernanceRestoreHandoffReaderReceipt =
  | GovernanceRestoreHandoffReaderPendingReceipt
  | GovernanceRestoreHandoffReaderAttentionReceipt;

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface GovernanceRestoreHandoffEnvelope {
  schemaVersion: 1;
  state: 'pending';
  handoffId: string;
  backupRef: string;
  previewDigest: string;
  restoreContractVersion: 1;
  createdAt: string;
  expiresAt: string;
  executionBoundary: 'stopped_service_only';
}

/**
 * Strict envelope access for the stopped-service Operations owner.
 *
 * The public reader below intentionally projects this value away. Keeping the
 * parser and filesystem checks here prevents the consumer from accepting a
 * weaker handoff schema.
 */
export function readGovernanceRestoreHandoffEnvelopeForOperations(input: {
  databasePath: string;
  now: Date;
}): {
  directoryPath: string;
  envelope: GovernanceRestoreHandoffEnvelope;
} {
  const nowMs = validateInput(input);
  const directoryPath = resolveHandoffDirectory(input.databasePath);
  const envelope = readEnvelope(directoryPath, PENDING_FILE_NAME, [PENDING_FILE_NAME]);
  const createdAtMs = validateEnvelope(envelope);
  const expiresAtMs = Date.parse(envelope.expiresAt);
  if (nowMs < createdAtMs || nowMs >= expiresAtMs) {
    throw new Error('Restore handoff is outside its pending lifetime.');
  }
  return { directoryPath, envelope };
}

export function getGovernanceRestoreHandoffDirectoryForOperations(
  databasePath: string,
): string {
  validateInput({ databasePath, now: new Date(0) });
  return resolveHandoffDirectory(databasePath);
}

export function parseGovernanceRestoreHandoffEnvelopeForOperations(
  content: string,
): GovernanceRestoreHandoffEnvelope {
  return parseEnvelope(content);
}

export function readGovernanceRestoreHandoff(
  input: GovernanceRestoreHandoffReaderInput,
): GovernanceRestoreHandoffReaderReceipt {
  try {
    const now = input.now === undefined ? new Date() : input.now;
    const { envelope } = readGovernanceRestoreHandoffEnvelopeForOperations({
      databasePath: input.databasePath,
      now,
    });
    return {
      status: 'pending',
      handoffId: envelope.handoffId,
      expiresAt: envelope.expiresAt,
      contractVersion: envelope.restoreContractVersion,
      executionBoundary: envelope.executionBoundary,
      effects: { restoreExecution: false },
    };
  } catch {
    return attentionReceipt();
  }
}

function validateInput(input: GovernanceRestoreHandoffReaderInput): number {
  if (
    typeof input.databasePath !== 'string'
    || !isAbsolute(input.databasePath)
    || resolve(input.databasePath) !== input.databasePath
  ) {
    throw new Error('Invalid restore handoff database location.');
  }
  const now = input.now === undefined ? new Date() : input.now;
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAXIMUM_EXPIRY_TIMESTAMP_MS) {
    throw new Error('Invalid restore handoff time.');
  }
  return nowMs;
}

function resolveHandoffDirectory(databasePath: string): string {
  const databaseDirectory = dirname(databasePath);
  assertCanonicalDirectory(databaseDirectory);
  return join(databaseDirectory, HANDOFF_DIRECTORY_NAME);
}

function readEnvelope(
  directoryPath: string,
  fileName: string,
  expectedEntries: string[],
): GovernanceRestoreHandoffEnvelope {
  const directoryIdentity = openPrivateDirectory(directoryPath);
  if (!sameEntries(readdirSync(directoryPath).sort(), [...expectedEntries].sort())) {
    throw new Error('Restore handoff directory has unexpected entries.');
  }
  const pendingPath = join(directoryPath, fileName);
  const entry = lstatSync(pendingPath);
  assertPrivateFile(entry);
  const fileIdentity = identityOf(entry);
  const descriptor = openSync(pendingPath, constants.O_RDONLY | noFollowFlag());
  try {
    const stats = fstatSync(descriptor);
    assertPrivateFile(stats);
    if (!identitiesEqual(fileIdentity, identityOf(stats))) {
      throw new Error('Restore handoff changed while opening.');
    }
    const content = readFileSync(descriptor, 'utf8');
    const after = fstatSync(descriptor);
    if (
      !identitiesEqual(fileIdentity, identityOf(after))
      || after.size !== stats.size
      || Buffer.byteLength(content, 'utf8') !== stats.size
    ) {
      throw new Error('Restore handoff changed while being read.');
    }
    const envelope = parseEnvelope(content);
    assertDirectoryIdentity(directoryPath, directoryIdentity);
    const currentEntry = lstatSync(pendingPath);
    assertPrivateFile(currentEntry);
    if (
      !identitiesEqual(fileIdentity, identityOf(currentEntry))
      || !sameEntries(readdirSync(directoryPath).sort(), [...expectedEntries].sort())
    ) {
      throw new Error('Restore handoff directory changed while being read.');
    }
    return envelope;
  } finally {
    closeSync(descriptor);
  }
}

function openPrivateDirectory(path: string): FileIdentity {
  const lstat = lstatSync(path);
  assertPrivateDirectory(lstat);
  const descriptor = openSync(path, constants.O_RDONLY | directoryFlag() | noFollowFlag());
  try {
    const opened = fstatSync(descriptor);
    assertPrivateDirectory(opened);
    if (
      !identitiesEqual(identityOf(lstat), identityOf(opened))
      || realpathSync(path) !== path
    ) {
      throw new Error('Restore handoff directory changed while opening.');
    }
    return identityOf(opened);
  } finally {
    closeSync(descriptor);
  }
}

function parseEnvelope(content: string): GovernanceRestoreHandoffEnvelope {
  if (!content.endsWith('\n') || content.slice(0, -1).includes('\n')) {
    throw new Error('Restore handoff envelope has invalid framing.');
  }
  const value: unknown = JSON.parse(content.slice(0, -1));
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'state',
      'handoffId',
      'backupRef',
      'previewDigest',
      'restoreContractVersion',
      'createdAt',
      'expiresAt',
      'executionBoundary',
    ])
    || value.schemaVersion !== 1
    || value.state !== 'pending'
    || typeof value.handoffId !== 'string'
    || !HANDOFF_ID_PATTERN.test(value.handoffId)
    || typeof value.backupRef !== 'string'
    || !BACKUP_REFERENCE_PATTERN.test(value.backupRef)
    || typeof value.previewDigest !== 'string'
    || !SHA256_PATTERN.test(value.previewDigest)
    || value.restoreContractVersion !== 1
    || typeof value.createdAt !== 'string'
    || typeof value.expiresAt !== 'string'
    || value.executionBoundary !== 'stopped_service_only'
  ) {
    throw new Error('Restore handoff envelope is invalid.');
  }
  const envelope: GovernanceRestoreHandoffEnvelope = {
    schemaVersion: 1,
    state: 'pending',
    handoffId: value.handoffId,
    backupRef: value.backupRef,
    previewDigest: value.previewDigest,
    restoreContractVersion: 1,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    executionBoundary: 'stopped_service_only',
  };
  if (JSON.stringify(envelope) + '\n' !== content) {
    throw new Error('Restore handoff envelope is not canonical.');
  }
  return envelope;
}

function validateEnvelope(envelope: GovernanceRestoreHandoffEnvelope): number {
  const createdAtMs = parseTimestamp(envelope.createdAt);
  const expiresAtMs = parseTimestamp(envelope.expiresAt);
  if (
    expiresAtMs !== createdAtMs + HANDOFF_LIFETIME_MS
    || createdAtMs > MAXIMUM_TIMESTAMP_MS
    || expiresAtMs > MAXIMUM_EXPIRY_TIMESTAMP_MS
  ) {
    throw new Error('Restore handoff timestamps are invalid.');
  }
  return createdAtMs;
}

function parseTimestamp(value: string): number {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error('Restore handoff timestamp is not canonical.');
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isSafeInteger(timestamp)
    || timestamp < 0
    || new Date(timestamp).toISOString() !== value
  ) {
    throw new Error('Restore handoff timestamp is invalid.');
  }
  return timestamp;
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

function assertPrivateFile(stats: Stats): void {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || (stats.mode & 0o7777) !== 0o600
    || stats.nlink !== 1
    || stats.size > MAXIMUM_ENVELOPE_BYTES
    || !hasCurrentOwner(stats)
  ) {
    throw new Error('Restore handoff file is not private.');
  }
}

function assertDirectoryIdentity(path: string, expected: FileIdentity): void {
  const stats = lstatSync(path);
  assertPrivateDirectory(stats);
  if (!identitiesEqual(identityOf(stats), expected) || realpathSync(path) !== path) {
    throw new Error('Restore handoff directory identity changed.');
  }
}

function attentionReceipt(): GovernanceRestoreHandoffReaderAttentionReceipt {
  return {
    status: 'attention_required',
    handoffId: null,
    expiresAt: null,
    contractVersion: null,
    executionBoundary: 'stopped_service_only',
    effects: { restoreExecution: false },
  };
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

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
}
