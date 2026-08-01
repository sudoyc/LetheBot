import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationsDoctorConfig } from '../../../src/operations/doctor.js';
import {
  GovernanceOperationsCoordinator,
  type GovernanceOperationsRestoreHandoffPreview,
} from '../../../src/governance/operations-coordinator.js';
import { prepareGovernanceRestoreHandoff } from '../../../src/operations/governance-restore-handoff.js';
import { readGovernanceRestoreHandoff } from '../../../src/operations/governance-restore-handoff-reader.js';
import {
  createGovernanceRestoreHandoffConsumer,
  type GovernanceRestoreHandoffConsumer,
  type GovernanceRestoreHandoffConsumerInput,
  type GovernanceRestoreHandoffConsumerOptions,
} from '../../../src/operations/governance-restore-handoff-consumer.js';
import * as sqliteMaintenance from '../../../src/operations/sqlite-maintenance.js';
import {
  closeDatabase,
  initDatabase,
  runMigrations,
} from '../../../src/storage/database.js';

const NOW = new Date('2026-07-28T11:00:00.000Z');
const BACKUP_REF = 'A'.repeat(43);
const PREVIEW_DIGEST = 'b'.repeat(64);
const roots: string[] = [];
const config: OperationsDoctorConfig = {
  onebotTransport: 'ws',
  onebotHttpUrl: '',
  onebotWsUrl: '',
  onebotToken: '',
  onebotBotQqId: '',
  lethebotHost: '127.0.0.1',
  lethebotPort: 6700,
  lethebotHealthPath: '/healthz',
  lethebotReadinessPath: '/readyz',
  lethebotMetricsPath: '/metrics',
  lethebotEventPath: '/onebot/event',
  rawEventRetentionDays: 90,
  chatMessageRetentionDays: 30,
  auditLogRetentionDays: 180,
  disabledDeletedMemoryRetentionDays: 365,
  eventProcessingFailureRetentionDays: 14,
};

type RestoreDatabase = NonNullable<GovernanceRestoreHandoffConsumerOptions['restoreDatabase']>;

interface ReadyFixture {
  root: string;
  dataDirectory: string;
  databasePath: string;
  backupRef: string;
  backupPath: string;
  backupBytes: Buffer;
  backupMode: number;
  preview: GovernanceOperationsRestoreHandoffPreview | null;
  handoffId: string;
  handoffDirectory: string;
  pendingPath: string;
  pendingBytes: Buffer;
  unrelatedPath: string;
  resolveBackup: (backupRef: string) => GovernanceOperationsRestoreHandoffPreview | null;
  createConsumer: (options?: {
    resolveBackup?: ReadyFixture['resolveBackup'];
    restoreDatabase?: RestoreDatabase;
  }) => GovernanceRestoreHandoffConsumer;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('governance restore handoff consumer', () => {
  it('consumes one exact migrated handoff and preserves backup, audit, and unrelated state', async () => {
    const fixture = await createReadyFixture();
    const consumer = fixture.createConsumer();
    const receipt = consumeStopped(consumer, fixture.databasePath);

    expect(receipt).toEqual({
      status: 'completed',
      outcome: 'restored',
      handoffId: fixture.handoffId,
      contractVersion: 1,
      executionBoundary: 'stopped_service_only',
      effects: { restoreExecution: true, handoffConsumed: true },
    });
    expect(readGovernanceRestoreHandoff({ databasePath: fixture.databasePath, now: NOW }).status)
      .toBe('attention_required');
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['completed.json']);
    expect(lstatSync(join(fixture.handoffDirectory, 'completed.json')).mode & 0o7777).toBe(0o600);
    expect(readFileSync(fixture.backupPath)).toEqual(fixture.backupBytes);
    expect(lstatSync(fixture.backupPath).mode).toBe(fixture.backupMode);
    expect(readFileSync(fixture.unrelatedPath, 'utf8')).toBe('unrelated-must-survive\n');

    const restored = initDatabase({ path: fixture.databasePath, readonly: true });
    try {
      expect(countRawEvent(restored, 'backup-sentinel')).toBe(1);
      expect(countRawEvent(restored, 'target-only-after-backup')).toBe(0);
      expect(countAudit(restored, 'backup-audit')).toBe(1);
      expect(countAudit(restored, 'target-only-audit')).toBe(0);
      expect(restored.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(restored);
    }

    const repeated = consumeStopped(consumer, fixture.databasePath);
    expect(repeated).toMatchObject({
      status: 'attention_required',
      outcome: 'already_consumed',
      effects: { restoreExecution: false, handoffConsumed: true },
    });
    const serialized = JSON.stringify([receipt, repeated]);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain(fixture.backupRef);
    expect(serialized).not.toContain(fixture.preview?.previewDigest);
  });

  it('rejects missing, running, mismatched, and future stop proofs before owner calls', () => {
    const root = createRoot('stop-proof');
    const databasePath = join(root, 'missing.db');
    const resolveBackup = vi.fn(() => null);
    const restoreDatabase = vi.fn(() => {
      throw new Error('restore must not run');
    });
    const consumer = createGovernanceRestoreHandoffConsumer({
      databasePath,
      resolveBackup,
      restoreDatabase,
    });
    const invalidProofs: unknown[] = [
      undefined,
      { status: 'running', databasePath, observedAt: NOW },
      { status: 'stopped', databasePath: join(root, 'other.db'), observedAt: NOW },
      { status: 'stopped', databasePath, observedAt: new Date(NOW.getTime() + 1) },
    ];

    for (const stopProof of invalidProofs) {
      const receipt = consumer.consume({ now: NOW, stopProof } as unknown as GovernanceRestoreHandoffConsumerInput);
      expect(receipt).toEqual({
        status: 'attention_required',
        outcome: 'stop_proof_required',
        handoffId: null,
        contractVersion: null,
        executionBoundary: 'stopped_service_only',
        effects: { restoreExecution: false, handoffConsumed: false },
      });
    }
    expect(resolveBackup).not.toHaveBeenCalled();
    expect(restoreDatabase).not.toHaveBeenCalled();
    expect(existsSync(databasePath)).toBe(false);
  });

  it.each([
    ['expired', (_fixture: EnvelopeFixture) => new Date(NOW.getTime() + 15 * 60 * 1_000)],
    ['malformed', (fixture: EnvelopeFixture) => {
      writeFileSync(fixture.pendingPath, '{malformed}\n', { mode: 0o600 });
      return NOW;
    }],
    ['foreign version', (fixture: EnvelopeFixture) => {
      const envelope = JSON.parse(readFileSync(fixture.pendingPath, 'utf8')) as Record<string, unknown>;
      envelope.restoreContractVersion = 2;
      writeFileSync(fixture.pendingPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
      return NOW;
    }],
  ])('preserves an %s pending envelope without resolving or restoring', (_label, mutate) => {
    const fixture = createEnvelopeFixture();
    const now = mutate(fixture);
    const before = readFileSync(fixture.pendingPath);
    const beforeStats = lstatSync(fixture.pendingPath);
    const resolveBackup = vi.fn(() => null);
    const restoreDatabase = vi.fn(() => {
      throw new Error('restore must not run');
    });
    const consumer = createGovernanceRestoreHandoffConsumer({
      databasePath: fixture.databasePath,
      resolveBackup,
      restoreDatabase,
    });

    expect(consumer.consume({
      now,
      stopProof: { status: 'stopped', databasePath: fixture.databasePath, observedAt: now },
    }).status).toBe('attention_required');
    expect(resolveBackup).not.toHaveBeenCalled();
    expect(restoreDatabase).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pendingPath)).toEqual(before);
    expect(lstatSync(fixture.pendingPath).ino).toBe(beforeStats.ino);
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['pending.json']);
  });

  it.each(['foreign sibling', 'permissive pending'])(
    'preserves unsafe %s state before owner calls',
    (kind) => {
      const fixture = createEnvelopeFixture();
      const foreignPath = join(fixture.handoffDirectory, 'foreign.txt');
      if (kind === 'foreign sibling') {
        writeFileSync(foreignPath, 'foreign-must-survive\n', { mode: 0o600 });
      } else {
        chmodSync(fixture.pendingPath, 0o644);
      }
      const before = readFileSync(fixture.pendingPath);
      const beforeMode = lstatSync(fixture.pendingPath).mode;
      const resolveBackup = vi.fn(() => null);
      const restoreDatabase = vi.fn(() => {
        throw new Error('restore must not run');
      });
      const consumer = createGovernanceRestoreHandoffConsumer({
        databasePath: fixture.databasePath,
        resolveBackup,
        restoreDatabase,
      });

      expect(consumeStopped(consumer, fixture.databasePath).status).toBe('attention_required');
      expect(resolveBackup).not.toHaveBeenCalled();
      expect(restoreDatabase).not.toHaveBeenCalled();
      expect(readFileSync(fixture.pendingPath)).toEqual(before);
      expect(lstatSync(fixture.pendingPath).mode).toBe(beforeMode);
      if (kind === 'foreign sibling') {
        expect(readFileSync(foreignPath, 'utf8')).toBe('foreign-must-survive\n');
      }
    },
  );

  it('leaves a digest-drifted envelope pending before claim or restore', async () => {
    const fixture = await createReadyFixture({ handoffDigest: 'c'.repeat(64) });
    const before = readFileSync(fixture.pendingPath);
    const restoreDatabase = vi.fn(() => {
      throw new Error('restore must not run');
    });

    expect(consumeStopped(fixture.createConsumer({ restoreDatabase }), fixture.databasePath).status)
      .toBe('attention_required');
    expect(restoreDatabase).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pendingPath)).toEqual(before);
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['pending.json']);
  });

  it.each(['-wal', '-shm'])('leaves pending state and a target %s sidecar untouched', async (suffix) => {
    const fixture = await createReadyFixture();
    const sidecarPath = `${fixture.databasePath}${suffix}`;
    writeFileSync(sidecarPath, 'sidecar-must-survive\n', { mode: 0o600 });
    const before = readFileSync(fixture.pendingPath);
    const resolveBackup = vi.fn(fixture.resolveBackup);
    const restoreDatabase = vi.fn(() => {
      throw new Error('restore must not run');
    });

    const receipt = consumeStopped(
      fixture.createConsumer({ resolveBackup, restoreDatabase }),
      fixture.databasePath,
    );
    expect(receipt.status).toBe('attention_required');
    expect(resolveBackup).not.toHaveBeenCalled();
    expect(restoreDatabase).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pendingPath)).toEqual(before);
    expect(readFileSync(sidecarPath, 'utf8')).toBe('sidecar-must-survive\n');
  });

  it('rejects corrupt or unsafe managed artifacts before claim', async () => {
    for (const kind of ['corrupt', 'symlink'] as const) {
      const fixture = await createReadyFixture();
      if (kind === 'corrupt') {
        writeFileSync(fixture.backupPath, 'not-a-sqlite-database\n', { mode: 0o600 });
      } else {
        const outside = join(fixture.root, 'outside-backup.db');
        writeFileSync(outside, fixture.backupBytes, { mode: 0o600 });
        unlinkSync(fixture.backupPath);
        symlinkSync(outside, fixture.backupPath);
      }
      const before = readFileSync(fixture.pendingPath);
      const restoreDatabase = vi.fn(() => {
        throw new Error('restore must not run');
      });

      expect(consumeStopped(fixture.createConsumer({ restoreDatabase }), fixture.databasePath).status)
        .toBe('attention_required');
      expect(restoreDatabase).not.toHaveBeenCalled();
      expect(readFileSync(fixture.pendingPath)).toEqual(before);
      expect(readdirSync(fixture.handoffDirectory)).toEqual(['pending.json']);
    }
  });

  it('rejects an FK-invalid but integrity-clean backup before claim', async () => {
    const fixture = await createReadyFixture({ mutateBackup: addForeignKeyViolation });
    expect(fixture.preview).not.toBeNull();
    const before = readFileSync(fixture.pendingPath);
    const restoreDatabase = vi.fn(() => {
      throw new Error('restore must not run');
    });

    expect(consumeStopped(fixture.createConsumer({ restoreDatabase }), fixture.databasePath).status)
      .toBe('attention_required');
    expect(restoreDatabase).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pendingPath)).toEqual(before);
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['pending.json']);
  });

  it('recovers a committed claim once and normalizes the pending-plus-claim crash window', async () => {
    const fixture = await createReadyFixture();
    let restoreCalls = 0;
    const restoreDatabase = vi.fn((options: Parameters<RestoreDatabase>[0]) => {
      restoreCalls += 1;
      if (restoreCalls === 1) {
        throw new Error('synthetic pre-effect interruption');
      }
      return sqliteMaintenance.restoreSqliteDatabase(options);
    });
    const consumer = fixture.createConsumer({ restoreDatabase });

    const first = consumeStopped(consumer, fixture.databasePath);
    expect(first).toMatchObject({ status: 'attention_required', outcome: 'recovery_required' });
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['claim.json']);
    writeFileSync(fixture.pendingPath, fixture.pendingBytes, { mode: 0o600 });
    expect(readdirSync(fixture.handoffDirectory).sort()).toEqual(['claim.json', 'pending.json']);

    const second = consumeStopped(consumer, fixture.databasePath);
    expect(second).toMatchObject({ status: 'completed', outcome: 'restored' });
    expect(restoreDatabase).toHaveBeenCalledTimes(2);
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['completed.json']);

    expect(consumeStopped(consumer, fixture.databasePath).outcome).toBe('already_consumed');
    expect(restoreDatabase).toHaveBeenCalledTimes(2);
  });

  it('recovers an operation-owned claim staging file without an extra restore', async () => {
    const fixture = await createReadyFixture();
    const restoreDatabase = vi.fn((options: Parameters<RestoreDatabase>[0]) => {
      if (restoreDatabase.mock.calls.length === 1) {
        throw new Error('synthetic pre-effect interruption');
      }
      return sqliteMaintenance.restoreSqliteDatabase(options);
    });
    const consumer = fixture.createConsumer({ restoreDatabase });
    expect(consumeStopped(consumer, fixture.databasePath).outcome).toBe('recovery_required');
    renameSync(
      join(fixture.handoffDirectory, 'claim.json'),
      join(fixture.handoffDirectory, `.claim.json.${fixture.handoffId}.tmp`),
    );

    expect(consumeStopped(consumer, fixture.databasePath).status).toBe('completed');
    expect(restoreDatabase).toHaveBeenCalledTimes(2);
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['completed.json']);
  });

  it('does not repeat restore when the target was replaced before an owner interruption', async () => {
    const fixture = await createReadyFixture();
    const restoreDatabase = vi.fn((options: Parameters<RestoreDatabase>[0]) => {
      sqliteMaintenance.restoreSqliteDatabase(options);
      throw new Error('synthetic post-effect interruption');
    });
    const consumer = fixture.createConsumer({ restoreDatabase });

    expect(consumeStopped(consumer, fixture.databasePath).outcome).toBe('recovery_required');
    const recovered = consumeStopped(consumer, fixture.databasePath);
    expect(recovered).toMatchObject({
      status: 'recovered',
      outcome: 'recovered',
      effects: { restoreExecution: false, handoffConsumed: true },
    });
    expect(restoreDatabase).toHaveBeenCalledTimes(1);
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['completed.json']);
  });

  it('recovers completion staging after the restore effect without a duplicate call', async () => {
    const fixture = await createReadyFixture();
    const restoreDatabase = vi.fn((options: Parameters<RestoreDatabase>[0]) => {
      sqliteMaintenance.restoreSqliteDatabase(options);
      throw new Error('synthetic publication interruption');
    });
    const consumer = fixture.createConsumer({ restoreDatabase });
    expect(consumeStopped(consumer, fixture.databasePath).outcome).toBe('recovery_required');
    writeFileSync(
      join(fixture.handoffDirectory, `.completed.json.${fixture.handoffId}.tmp`),
      `${JSON.stringify({
        schemaVersion: 1,
        state: 'completed',
        handoffId: fixture.handoffId,
        restoreContractVersion: 1,
        executionBoundary: 'stopped_service_only',
      })}\n`,
      { mode: 0o600 },
    );

    const recovered = consumeStopped(consumer, fixture.databasePath);
    expect(recovered).toMatchObject({
      status: 'attention_required',
      outcome: 'already_consumed',
      effects: { restoreExecution: false, handoffConsumed: true },
    });
    expect(restoreDatabase).toHaveBeenCalledTimes(1);
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['completed.json']);
  });

  it('bounds pre-effect recovery to one retry and never makes a third restore call', async () => {
    const fixture = await createReadyFixture();
    const restoreDatabase = vi.fn(() => {
      throw new Error('synthetic persistent interruption');
    });
    const consumer = fixture.createConsumer({ restoreDatabase });

    expect(consumeStopped(consumer, fixture.databasePath).outcome).toBe('recovery_required');
    expect(consumeStopped(consumer, fixture.databasePath).outcome).toBe('recovery_required');
    expect(consumeStopped(consumer, fixture.databasePath).outcome).toBe('recovery_required');
    expect(restoreDatabase).toHaveBeenCalledTimes(2);
    expect(readdirSync(fixture.handoffDirectory)).toEqual(['claim.json']);
  });
});

interface ReadyFixtureOptions {
  handoffDigest?: string;
  mutateBackup?: (backupPath: string) => void;
}

async function createReadyFixture(options: ReadyFixtureOptions = {}): Promise<ReadyFixture> {
  const root = createRoot('ready');
  const dataDirectory = join(root, 'data');
  mkdirSync(dataDirectory, { mode: 0o700 });
  const databasePath = join(dataDirectory, 'lethebot.db');
  const db = initDatabase({ path: databasePath });
  let closed = false;
  try {
    runMigrations(db, join(process.cwd(), 'migrations'));
    insertRawEvent(db, 'backup-sentinel');
    insertAudit(db, 'backup-audit');
    const coordinator = new GovernanceOperationsCoordinator({ db, dbPath: databasePath, config });
    const backup = await coordinator.createServerOwnedVerifiedBackup();
    if (backup.backupRef === null) {
      throw new Error('Fixture managed backup was not created.');
    }
    const backupRef = backup.backupRef;
    const backupPath = join(dataDirectory, '.lethebot-governance-backups', `${backupRef}.db`);
    options.mutateBackup?.(backupPath);
    const preview = coordinator.previewServerOwnedBackupRestore(backupRef);
    const handoff = prepareGovernanceRestoreHandoff({
      databasePath,
      backupRef,
      previewDigest: options.handoffDigest ?? preview?.previewDigest ?? PREVIEW_DIGEST,
      contractVersion: 1,
      now: NOW,
    });
    if (handoff.status !== 'pending') {
      throw new Error('Fixture handoff was not published.');
    }
    insertRawEvent(db, 'target-only-after-backup');
    insertAudit(db, 'target-only-audit');
    closeDatabase(db);
    closed = true;

    const handoffDirectory = join(dataDirectory, '.lethebot-governance-restore-handoff');
    const pendingPath = join(handoffDirectory, 'pending.json');
    const unrelatedPath = join(dataDirectory, 'unrelated.txt');
    writeFileSync(unrelatedPath, 'unrelated-must-survive\n', { mode: 0o600 });
    const resolveBackup = (reference: string): GovernanceOperationsRestoreHandoffPreview | null => (
      coordinator.previewServerOwnedBackupRestore(reference)
    );
    return {
      root,
      dataDirectory,
      databasePath,
      backupRef,
      backupPath,
      backupBytes: readFileSync(backupPath),
      backupMode: lstatSync(backupPath).mode,
      preview,
      handoffId: handoff.handoffId,
      handoffDirectory,
      pendingPath,
      pendingBytes: readFileSync(pendingPath),
      unrelatedPath,
      resolveBackup,
      createConsumer: (consumerOptions = {}) => createGovernanceRestoreHandoffConsumer({
        databasePath,
        resolveBackup: consumerOptions.resolveBackup ?? resolveBackup,
        ...(consumerOptions.restoreDatabase === undefined
          ? {}
          : { restoreDatabase: consumerOptions.restoreDatabase }),
      }),
    };
  } finally {
    if (!closed) {
      closeDatabase(db);
    }
  }
}

interface EnvelopeFixture {
  databasePath: string;
  handoffDirectory: string;
  pendingPath: string;
}

function createEnvelopeFixture(): EnvelopeFixture {
  const root = createRoot('envelope');
  const dataDirectory = join(root, 'data');
  mkdirSync(dataDirectory, { mode: 0o700 });
  const databasePath = join(dataDirectory, 'lethebot.db');
  writeFileSync(databasePath, 'target-sentinel\n', { mode: 0o600 });
  const handoff = prepareGovernanceRestoreHandoff({
    databasePath,
    backupRef: BACKUP_REF,
    previewDigest: PREVIEW_DIGEST,
    contractVersion: 1,
    now: NOW,
  });
  if (handoff.status !== 'pending') {
    throw new Error('Envelope fixture was not published.');
  }
  const handoffDirectory = join(dataDirectory, '.lethebot-governance-restore-handoff');
  return {
    databasePath,
    handoffDirectory,
    pendingPath: join(handoffDirectory, 'pending.json'),
  };
}

function createRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `lethebot-governance-restore-${label}-`));
  roots.push(root);
  return root;
}

function consumeStopped(
  consumer: GovernanceRestoreHandoffConsumer,
  databasePath: string,
) {
  return consumer.consume({
    now: NOW,
    stopProof: { status: 'stopped', databasePath, observedAt: NOW },
  });
}

function insertRawEvent(db: ReturnType<typeof initDatabase>, id: string): void {
  db.prepare(
    `INSERT INTO raw_events (
       id, type, timestamp, source, platform, conversation_id, payload, created_at
     ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', 'private:fixture', '{}', ?)`,
  ).run(id, NOW.getTime(), NOW.getTime());
}

function insertAudit(db: ReturnType<typeof initDatabase>, id: string): void {
  db.prepare(
    `INSERT INTO audit_log (
       id, timestamp, category, level, event_type, event_id, summary, redacted
     ) VALUES (?, ?, 'system', 'summary', 'fixture', ?, 'synthetic fixture', 1)`,
  ).run(id, NOW.getTime(), id);
}

function countRawEvent(db: ReturnType<typeof initDatabase>, id: string): number {
  return db.prepare('SELECT COUNT(*) FROM raw_events WHERE id = ?').pluck().get(id) as number;
}

function countAudit(db: ReturnType<typeof initDatabase>, id: string): number {
  return db.prepare('SELECT COUNT(*) FROM audit_log WHERE id = ?').pluck().get(id) as number;
}

function addForeignKeyViolation(backupPath: string): void {
  const db = initDatabase({ path: backupPath });
  try {
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id,
         conversation_type, sender_id, text, timestamp
       ) VALUES (
         'orphan-chat', 'missing-raw', 'orphan-platform', 'private:fixture',
         'private', 'fixture-user', 'orphan', ?
       )`,
    ).run(NOW.getTime());
  } finally {
    closeDatabase(db);
    chmodSync(backupPath, 0o600);
  }
}
