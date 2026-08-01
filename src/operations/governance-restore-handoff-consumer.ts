/**
 * HTTP-disabled stopped-service restore handoff consumer.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { GovernanceOperationsRestoreHandoffPreview } from '../governance/operations-coordinator.js';
import {
  getGovernanceRestoreHandoffDirectoryForOperations,
  parseGovernanceRestoreHandoffEnvelopeForOperations,
  readGovernanceRestoreHandoffEnvelopeForOperations,
  type GovernanceRestoreHandoffEnvelope,
} from './governance-restore-handoff-reader.js';
import * as sqliteMaintenance from './sqlite-maintenance.js';

const PENDING_FILE = 'pending.json';
const CLAIM_FILE = 'claim.json';
const COMPLETED_FILE = 'completed.json';
const BACKUP_DIRECTORY = '.lethebot-governance-backups';
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CLAIM_STAGE_PATTERN = /^\.claim\.json\.([A-Za-z0-9_-]{43})\.tmp$/u;
const COMPLETED_STAGE_PATTERN = /^\.completed\.json\.([A-Za-z0-9_-]{43})\.tmp$/u;
const MAX_STATE_BYTES = 2_048;
const MAX_TIMESTAMP_MS = Date.parse('9999-12-31T23:59:59.999Z');
const MAX_RESTORE_ATTEMPTS = 2;

type RestoreDatabase = typeof sqliteMaintenance.restoreSqliteDatabase;
type AttentionOutcome =
  | 'already_consumed'
  | 'attention_required'
  | 'recovery_required'
  | 'artifact_changed'
  | 'stop_proof_required';

export interface GovernanceRestoreStopProof {
  status: 'stopped';
  databasePath: string;
  observedAt: Date;
}

export interface GovernanceRestoreHandoffConsumerInput {
  now: Date;
  stopProof: GovernanceRestoreStopProof;
}

export interface GovernanceRestoreHandoffConsumerOptions {
  databasePath: string;
  resolveBackup: (backupRef: string) => GovernanceOperationsRestoreHandoffPreview | null;
  restoreDatabase?: RestoreDatabase;
}

interface ReceiptBase {
  handoffId: string | null;
  contractVersion: 1 | null;
  executionBoundary: 'stopped_service_only';
  effects: {
    restoreExecution: boolean;
    handoffConsumed: boolean;
  };
}

export interface GovernanceRestoreHandoffCompletedReceipt extends ReceiptBase {
  status: 'completed';
  outcome: 'restored';
  handoffId: string;
  contractVersion: 1;
  effects: { restoreExecution: true; handoffConsumed: true };
}

export interface GovernanceRestoreHandoffRecoveredReceipt extends ReceiptBase {
  status: 'recovered';
  outcome: 'recovered';
  handoffId: string;
  contractVersion: 1;
  effects: { restoreExecution: false; handoffConsumed: true };
}

export interface GovernanceRestoreHandoffAttentionReceipt extends ReceiptBase {
  status: 'attention_required';
  outcome: AttentionOutcome;
  effects: { restoreExecution: false; handoffConsumed: boolean };
}

export type GovernanceRestoreHandoffConsumerReceipt =
  | GovernanceRestoreHandoffCompletedReceipt
  | GovernanceRestoreHandoffRecoveredReceipt
  | GovernanceRestoreHandoffAttentionReceipt;

export interface GovernanceRestoreHandoffConsumer {
  consume(input: GovernanceRestoreHandoffConsumerInput): GovernanceRestoreHandoffConsumerReceipt;
}

interface ClaimState {
  schemaVersion: 1;
  state: 'claimed';
  envelope: GovernanceRestoreHandoffEnvelope;
  attempts: number;
  backupArtifactDigest: string;
  backupSizeBytes: number;
  targetBeforeDigest: string;
  targetBeforeSizeBytes: number;
}

interface CompletedState {
  schemaVersion: 1;
  state: 'completed';
  handoffId: string;
  restoreContractVersion: 1;
  executionBoundary: 'stopped_service_only';
}

interface FileOptions {
  links?: number;
  mode?: number;
  maxBytes?: number;
  canonical?: boolean;
}

interface FileSnapshot {
  bytes: Buffer;
  stats: Stats;
}

interface RestorePreflight {
  backupPath: string;
  backupDigest: string;
  backupSize: number;
  targetDigest: string;
  targetSize: number;
}

const claimShellSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.literal('claimed'),
  envelope: z.unknown(),
  attempts: z.number().int().min(0).max(MAX_RESTORE_ATTEMPTS),
  backupArtifactDigest: z.string().regex(SHA256_PATTERN),
  backupSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  targetBeforeDigest: z.string().regex(SHA256_PATTERN),
  targetBeforeSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const completedSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.literal('completed'),
  handoffId: z.string().regex(ID_PATTERN),
  restoreContractVersion: z.literal(1),
  executionBoundary: z.literal('stopped_service_only'),
}).strict();

export function createGovernanceRestoreHandoffConsumer(
  options: GovernanceRestoreHandoffConsumerOptions,
): GovernanceRestoreHandoffConsumer {
  const databasePath = validateDatabasePath(options.databasePath);
  const restoreDatabase = options.restoreDatabase ?? sqliteMaintenance.restoreSqliteDatabase;

  return {
    consume(input) {
      if (!validStopProof(input, databasePath)) {
        return attention('stop_proof_required');
      }
      try {
        return consumeStopped(
          databasePath,
          input.now,
          options.resolveBackup,
          restoreDatabase,
        );
      } catch {
        return attention('attention_required');
      }
    },
  };
}

function consumeStopped(
  databasePath: string,
  now: Date,
  resolveBackup: GovernanceRestoreHandoffConsumerOptions['resolveBackup'],
  restoreDatabase: RestoreDatabase,
): GovernanceRestoreHandoffConsumerReceipt {
  const directory = getGovernanceRestoreHandoffDirectoryForOperations(databasePath);
  assertPrivateDirectory(directory);
  const entries = recoverStaging(directory);

  if (entries.includes(COMPLETED_FILE)) {
    const completed = readCompleted(directory);
    if (entries.some((entry) => ![COMPLETED_FILE, CLAIM_FILE, PENDING_FILE].includes(entry))) {
      return attention('recovery_required', completed.handoffId, true);
    }
    cleanupCompleted(directory, completed.handoffId);
    return attention('already_consumed', completed.handoffId, true);
  }

  if (entries.includes(CLAIM_FILE)) {
    if (entries.some((entry) => entry !== CLAIM_FILE && entry !== PENDING_FILE)) {
      return attention('recovery_required');
    }
    const claim = readClaim(directory);
    if (entries.includes(PENDING_FILE)) {
      const pending = parseEnvelopeFile(join(directory, PENDING_FILE));
      if (JSON.stringify(pending) !== JSON.stringify(claim.envelope)) {
        return attention('attention_required', claim.envelope.handoffId, true);
      }
      unlinkSync(join(directory, PENDING_FILE));
      syncDirectory(directory);
    }
    return resumeClaim(databasePath, directory, claim, resolveBackup, restoreDatabase);
  }

  if (!sameEntries(entries, [PENDING_FILE])) {
    return attention('attention_required');
  }
  const envelope = readGovernanceRestoreHandoffEnvelopeForOperations({
    databasePath,
    now,
  }).envelope;
  const preflight = preflightRestore(databasePath, envelope, resolveBackup);
  const claim: ClaimState = {
    schemaVersion: 1,
    state: 'claimed',
    envelope,
    attempts: 0,
    backupArtifactDigest: preflight.backupDigest,
    backupSizeBytes: preflight.backupSize,
    targetBeforeDigest: preflight.targetDigest,
    targetBeforeSizeBytes: preflight.targetSize,
  };
  publishEntry(directory, CLAIM_FILE, canonicalJson(claim), envelope.handoffId);
  const pending = parseEnvelopeFile(join(directory, PENDING_FILE));
  if (JSON.stringify(pending) !== JSON.stringify(envelope)) {
    throw new Error('Pending envelope changed while being claimed.');
  }
  unlinkSync(join(directory, PENDING_FILE));
  syncDirectory(directory);
  return executeClaim(databasePath, directory, claim, preflight, restoreDatabase);
}

function resumeClaim(
  databasePath: string,
  directory: string,
  claim: ClaimState,
  resolveBackup: GovernanceRestoreHandoffConsumerOptions['resolveBackup'],
  restoreDatabase: RestoreDatabase,
): GovernanceRestoreHandoffConsumerReceipt {
  const preflight = preflightRestore(databasePath, claim.envelope, resolveBackup);
  if (
    preflight.backupDigest !== claim.backupArtifactDigest
    || preflight.backupSize !== claim.backupSizeBytes
  ) {
    return attention('artifact_changed', claim.envelope.handoffId, true);
  }
  return executeClaim(databasePath, directory, claim, preflight, restoreDatabase);
}

function executeClaim(
  databasePath: string,
  directory: string,
  claim: ClaimState,
  preflight: RestorePreflight,
  restoreDatabase: RestoreDatabase,
): GovernanceRestoreHandoffConsumerReceipt {
  const target = snapshotTarget(databasePath);
  if (target.digest === claim.backupArtifactDigest && target.bytes.length === claim.backupSizeBytes) {
    try {
      publishCompleted(directory, claim.envelope);
      return recovered(claim.envelope.handoffId);
    } catch {
      return attention('recovery_required', claim.envelope.handoffId, true);
    }
  }
  if (
    target.digest !== claim.targetBeforeDigest
    || target.bytes.length !== claim.targetBeforeSizeBytes
  ) {
    return attention('artifact_changed', claim.envelope.handoffId, true);
  }
  if (claim.attempts >= MAX_RESTORE_ATTEMPTS) {
    return attention('recovery_required', claim.envelope.handoffId, true);
  }

  const attempted: ClaimState = { ...claim, attempts: claim.attempts + 1 };
  try {
    replaceClaim(directory, attempted);
    const result = restoreDatabase({
      backupPath: preflight.backupPath,
      targetPath: databasePath,
      overwrite: true,
    });
    if (
      !result.integrityOk
      || result.foreignKeyViolations !== 0
      || result.restoredSizeBytes !== preflight.backupSize
    ) {
      throw new Error('Restore verification evidence is invalid.');
    }
    const restored = snapshotTarget(databasePath);
    if (restored.digest !== preflight.backupDigest || restored.bytes.length !== preflight.backupSize) {
      throw new Error('Restored database does not match the verified backup.');
    }
    publishCompleted(directory, claim.envelope);
    return completed(claim.envelope.handoffId);
  } catch {
    return attention('recovery_required', claim.envelope.handoffId, true);
  }
}

function preflightRestore(
  databasePath: string,
  envelope: GovernanceRestoreHandoffEnvelope,
  resolveBackup: GovernanceRestoreHandoffConsumerOptions['resolveBackup'],
): RestorePreflight {
  const sourcePath = assertTarget(databasePath);
  assertNoSidecars(databasePath);
  const first = resolveBackup(envelope.backupRef);
  assertPreview(first, envelope);
  const backupDirectory = join(dirname(sourcePath), BACKUP_DIRECTORY);
  assertPrivateDirectory(backupDirectory);
  const backupPath = join(backupDirectory, `${envelope.backupRef}.db`);
  const backup = readPrivateFile(backupPath, { mode: 0o600 });
  const backupDigest = sha256(backup.bytes);
  if (backup.bytes.length !== first.artifact.sizeBytes) {
    throw new Error('Verified backup size changed.');
  }
  const second = resolveBackup(envelope.backupRef);
  assertPreview(second, envelope);
  if (second.previewDigest !== first.previewDigest || second.artifact.sizeBytes !== backup.bytes.length) {
    throw new Error('Verified backup changed while being read.');
  }
  if (sqliteMaintenance.countSqliteForeignKeyViolations(backupPath) !== 0) {
    throw new Error('Verified backup has foreign key violations.');
  }
  const target = snapshotTarget(databasePath);
  return {
    backupPath,
    backupDigest,
    backupSize: backup.bytes.length,
    targetDigest: target.digest,
    targetSize: target.bytes.length,
  };
}

function publishCompleted(directory: string, envelope: GovernanceRestoreHandoffEnvelope): void {
  const state: CompletedState = {
    schemaVersion: 1,
    state: 'completed',
    handoffId: envelope.handoffId,
    restoreContractVersion: 1,
    executionBoundary: 'stopped_service_only',
  };
  publishEntry(directory, COMPLETED_FILE, canonicalJson(state), envelope.handoffId);
  cleanupCompleted(directory, envelope.handoffId);
  if (!sameEntries(readdirSync(directory).sort(), [COMPLETED_FILE])) {
    throw new Error('Completed state has unexpected entries.');
  }
}

function cleanupCompleted(directory: string, handoffId: string): void {
  const pendingPath = join(directory, PENDING_FILE);
  const pendingExists = pathExists(pendingPath);
  if (pendingExists) {
    if (parseEnvelopeFile(pendingPath).handoffId !== handoffId) {
      throw new Error('Foreign pending envelope is present.');
    }
  }
  const claimPath = join(directory, CLAIM_FILE);
  const claimExists = pathExists(claimPath);
  if (claimExists) {
    if (readClaim(directory).envelope.handoffId !== handoffId) {
      throw new Error('Foreign claim is present.');
    }
  }
  if (pendingExists) {
    unlinkSync(pendingPath);
  }
  if (claimExists) {
    unlinkSync(claimPath);
  }
  syncDirectory(directory);
}

function readClaim(directory: string): ClaimState {
  return parseClaim(readStateFile(join(directory, CLAIM_FILE)));
}

function parseClaim(content: string): ClaimState {
  const shell = claimShellSchema.parse(JSON.parse(content));
  const envelope = parseGovernanceRestoreHandoffEnvelopeForOperations(
    `${JSON.stringify(shell.envelope)}\n`,
  );
  const claim: ClaimState = { ...shell, envelope };
  if (canonicalJson(claim) !== content) {
    throw new Error('Claim state is not canonical.');
  }
  return claim;
}

function readCompleted(directory: string): CompletedState {
  return parseCompleted(readStateFile(join(directory, COMPLETED_FILE)));
}

function parseCompleted(content: string): CompletedState {
  const state = completedSchema.parse(JSON.parse(content));
  if (canonicalJson(state) !== content) {
    throw new Error('Completed state is not canonical.');
  }
  return state;
}

function parseEnvelopeFile(path: string): GovernanceRestoreHandoffEnvelope {
  return parseGovernanceRestoreHandoffEnvelopeForOperations(readStateFile(path));
}

function readStateFile(path: string): string {
  return readPrivateFile(path, { mode: 0o600, maxBytes: MAX_STATE_BYTES }).bytes.toString('utf8');
}

function replaceClaim(directory: string, claim: ClaimState): void {
  const target = join(directory, CLAIM_FILE);
  readStateFile(target);
  const staging = join(directory, `.${CLAIM_FILE}.${claim.envelope.handoffId}.tmp`);
  writeStaging(staging, canonicalJson(claim));
  renameSync(staging, target);
  syncDirectory(directory);
  if (readStateFile(target) !== canonicalJson(claim)) {
    throw new Error('Claim update was not published.');
  }
}

function publishEntry(directory: string, name: string, content: string, operationId: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    throw new Error('Handoff state is oversized.');
  }
  const target = join(directory, name);
  const staging = join(directory, `.${name}.${operationId}.tmp`);
  writeStaging(staging, content);
  try {
    try {
      linkSync(staging, target);
    } catch (error) {
      if (!hasCode(error, 'EEXIST') || readStateFile(target) !== content) {
        throw error;
      }
    }
  } finally {
    removeStaging(staging, content);
  }
  syncDirectory(directory);
  if (readStateFile(target) !== content) {
    throw new Error('Handoff state was not published.');
  }
}

function recoverStaging(directory: string): string[] {
  const entries = readdirSync(directory).sort();
  const stages = entries.filter((entry) => CLAIM_STAGE_PATTERN.test(entry)
    || COMPLETED_STAGE_PATTERN.test(entry));
  if (stages.length === 0) {
    return entries;
  }
  if (stages.length !== 1) {
    throw new Error('Multiple handoff staging files are present.');
  }
  const stageName = stages[0];
  if (!stageName) {
    throw new Error('Handoff staging name is invalid.');
  }
  const claimMatch = CLAIM_STAGE_PATTERN.exec(stageName);
  const completedMatch = COMPLETED_STAGE_PATTERN.exec(stageName);
  const operationId = claimMatch?.[1] ?? completedMatch?.[1];
  if (!operationId) {
    throw new Error('Handoff staging owner is invalid.');
  }
  const stagePath = join(directory, stageName);
  const targetPath = join(directory, claimMatch ? CLAIM_FILE : COMPLETED_FILE);
  const targetExists = pathExists(targetPath);
  const stage = readPrivateFile(stagePath, {
    links: targetExists && sameInode(stagePath, targetPath) ? 2 : 1,
    mode: 0o600,
    maxBytes: MAX_STATE_BYTES,
  });
  const content = stage.bytes.toString('utf8');
  const stagedId = claimMatch
    ? parseClaim(content).envelope.handoffId
    : parseCompleted(content).handoffId;
  if (stagedId !== operationId) {
    throw new Error('Handoff staging owner does not match its content.');
  }

  if (!targetExists) {
    linkSync(stagePath, targetPath);
  } else if (!sameInode(stagePath, targetPath)) {
    if (!claimMatch) {
      throw new Error('Completed staging conflicts with existing state.');
    }
    const current = readClaim(directory);
    const staged = parseClaim(content);
    if (
      JSON.stringify(current.envelope) !== JSON.stringify(staged.envelope)
      || current.backupArtifactDigest !== staged.backupArtifactDigest
      || current.backupSizeBytes !== staged.backupSizeBytes
      || current.targetBeforeDigest !== staged.targetBeforeDigest
      || current.targetBeforeSizeBytes !== staged.targetBeforeSizeBytes
      || staged.attempts !== current.attempts + 1
    ) {
      throw new Error('Claim staging is not the next owned attempt.');
    }
    renameSync(stagePath, targetPath);
    syncDirectory(directory);
    return readdirSync(directory).sort();
  }
  unlinkSync(stagePath);
  syncDirectory(directory);
  if (readStateFile(targetPath) !== content) {
    throw new Error('Recovered handoff staging changed.');
  }
  return readdirSync(directory).sort();
}

function writeStaging(path: string, content: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function removeStaging(path: string, content: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.nlink !== 1 && stats.nlink !== 2) {
      throw new Error('Handoff staging link count is invalid.');
    }
    const file = readPrivateFile(path, {
      links: stats.nlink,
      mode: 0o600,
      maxBytes: MAX_STATE_BYTES,
    });
    if (file.bytes.toString('utf8') === content) {
      unlinkSync(path);
    }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

function assertPreview(
  preview: GovernanceOperationsRestoreHandoffPreview | null,
  envelope: GovernanceRestoreHandoffEnvelope,
): asserts preview is GovernanceOperationsRestoreHandoffPreview {
  if (
    preview === null
    || preview.action !== 'prepare_restore_handoff'
    || preview.currentState !== 'verified_backup_available'
    || preview.contractVersion !== envelope.restoreContractVersion
    || preview.previewDigest !== envelope.previewDigest
    || preview.artifact.integrity !== 'verified'
    || !Number.isSafeInteger(preview.artifact.sizeBytes)
    || preview.artifact.sizeBytes <= 0
    || preview.effects.databaseMutation
    || preview.effects.artifactMutation
    || preview.effects.restoreExecution
    || !preview.effects.serviceStopRequired
    || !preview.restore.available
    || preview.restore.executionBoundary !== 'stopped_service_only'
    || preview.rollback.available
    || preview.rollback.reason !== 'no_in_process_effect'
  ) {
    throw new Error('Backup does not match the exact B23I preview.');
  }
}

function assertTarget(databasePath: string): string {
  const canonical = realpathSync(databasePath);
  if (canonical !== databasePath) {
    throw new Error('Database path is not canonical.');
  }
  assertPrivateFile(lstatSync(databasePath));
  return canonical;
}

function snapshotTarget(databasePath: string): { bytes: Buffer; digest: string } {
  assertNoSidecars(databasePath);
  const bytes = readPrivateFile(databasePath, { canonical: false }).bytes;
  return { bytes, digest: sha256(bytes) };
}

function readPrivateFile(path: string, options: FileOptions = {}): FileSnapshot {
  const expectedLinks = options.links ?? 1;
  const before = lstatSync(path);
  assertPrivateFile(before, options);
  if (options.canonical !== false && realpathSync(path) !== path) {
    throw new Error('Private file path is not canonical.');
  }
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    const opened = fstatSync(descriptor);
    assertPrivateFile(opened, options);
    if (before.dev !== opened.dev || before.ino !== opened.ino || opened.nlink !== expectedLinks) {
      throw new Error('Private file changed while opening.');
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== bytes.length) {
      throw new Error('Private file changed while reading.');
    }
    return { bytes, stats: after };
  } finally {
    closeSync(descriptor);
  }
}

function assertPrivateFile(stats: Stats, options: FileOptions = {}): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== (options.links ?? 1)
    || (options.mode !== undefined && (stats.mode & 0o7777) !== options.mode)
    || (uid !== null && stats.uid !== uid)
    || !Number.isSafeInteger(stats.size)
    || stats.size <= 0
    || stats.size > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Private file is unsafe.');
  }
}

function assertPrivateDirectory(path: string): void {
  const stats = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || (stats.mode & 0o7777) !== 0o700
    || (uid !== null && stats.uid !== uid)
    || realpathSync(path) !== path
  ) {
    throw new Error('Private directory is unsafe.');
  }
}

function validStopProof(input: GovernanceRestoreHandoffConsumerInput, databasePath: string): boolean {
  const nowMs = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  const proof = input.stopProof;
  if (
    !Number.isSafeInteger(nowMs)
    || nowMs < 0
    || nowMs > MAX_TIMESTAMP_MS
    || typeof proof !== 'object'
    || proof === null
    || proof.status !== 'stopped'
    || proof.databasePath !== databasePath
    || !(proof.observedAt instanceof Date)
  ) {
    return false;
  }
  const observedAt = proof.observedAt.getTime();
  return Number.isSafeInteger(observedAt) && observedAt >= 0 && observedAt <= nowMs;
}

function validateDatabasePath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error('Configured database path is invalid.');
  }
  return path;
}

function assertNoSidecars(databasePath: string): void {
  if (pathExists(`${databasePath}-wal`) || pathExists(`${databasePath}-shm`)) {
    throw new Error('Database sidecar is present.');
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function sameInode(leftPath: string, rightPath: string): boolean {
  const left = lstatSync(leftPath);
  const right = lstatSync(rightPath);
  return left.dev === right.dev && left.ino === right.ino;
}

function completed(handoffId: string): GovernanceRestoreHandoffCompletedReceipt {
  return {
    status: 'completed',
    outcome: 'restored',
    handoffId,
    contractVersion: 1,
    executionBoundary: 'stopped_service_only',
    effects: { restoreExecution: true, handoffConsumed: true },
  };
}

function recovered(handoffId: string): GovernanceRestoreHandoffRecoveredReceipt {
  return {
    status: 'recovered',
    outcome: 'recovered',
    handoffId,
    contractVersion: 1,
    executionBoundary: 'stopped_service_only',
    effects: { restoreExecution: false, handoffConsumed: true },
  };
}

function attention(
  outcome: AttentionOutcome,
  handoffId: string | null = null,
  handoffConsumed = false,
): GovernanceRestoreHandoffAttentionReceipt {
  return {
    status: 'attention_required',
    outcome,
    handoffId,
    contractVersion: handoffId === null ? null : 1,
    executionBoundary: 'stopped_service_only',
    effects: { restoreExecution: false, handoffConsumed },
  };
}

function canonicalJson(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | directoryFlag() | noFollowFlag());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sameEntries(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
}
