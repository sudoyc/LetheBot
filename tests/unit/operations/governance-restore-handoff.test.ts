import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  prepareGovernanceRestoreHandoff,
  type GovernanceRestoreHandoffInput,
  type GovernanceRestoreHandoffReceipt,
} from '../../../src/operations/governance-restore-handoff.js';

const BACKUP_REF = 'A'.repeat(43);
const PREVIEW_DIGEST = 'b'.repeat(64);
const NOW = new Date('2026-07-28T09:00:00.000Z');
const ATTENTION_RECEIPT = {
  status: 'attention_required',
  handoffId: null,
  expiresAt: null,
  executionBoundary: 'stopped_service_only',
  effects: { restoreExecution: false },
} as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(): { databasePath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-governance-restore-handoff-'));
  roots.push(root);
  const dataDirectory = join(root, 'data');
  mkdirSync(dataDirectory, { mode: 0o700 });
  return { databasePath: join(dataDirectory, 'lethebot.db'), root };
}

function handoffDirectory(databasePath: string): string {
  return join(dirname(databasePath), '.lethebot-governance-restore-handoff');
}

function validInput(
  databasePath: string,
  overrides: Partial<GovernanceRestoreHandoffInput> = {},
): GovernanceRestoreHandoffInput {
  return {
    databasePath,
    backupRef: BACKUP_REF,
    previewDigest: PREVIEW_DIGEST,
    contractVersion: 1,
    now: NOW,
    ...overrides,
  };
}

function prepareInvalid(input: unknown): GovernanceRestoreHandoffReceipt {
  return prepareGovernanceRestoreHandoff(input as GovernanceRestoreHandoffInput);
}

describe('governance restore handoff', () => {
  it('publishes one private pending envelope without executing restore', () => {
    const { databasePath } = createFixture();

    const receipt = prepareGovernanceRestoreHandoff(validInput(databasePath));

    const directoryPath = handoffDirectory(databasePath);
    const pendingPath = join(directoryPath, 'pending.json');
    const firstRead = readFileSync(pendingPath);
    const envelope = JSON.parse(firstRead.toString('utf8')) as unknown;

    expect(receipt).toEqual({
      status: 'pending',
      handoffId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expiresAt: '2026-07-28T09:15:00.000Z',
      executionBoundary: 'stopped_service_only',
      effects: { restoreExecution: false },
    });
    expect(envelope).toEqual({
      schemaVersion: 1,
      state: 'pending',
      handoffId: receipt.handoffId,
      backupRef: BACKUP_REF,
      previewDigest: PREVIEW_DIGEST,
      restoreContractVersion: 1,
      createdAt: NOW.toISOString(),
      expiresAt: receipt.expiresAt,
      executionBoundary: 'stopped_service_only',
    });
    expect(lstatSync(directoryPath).mode & 0o7777).toBe(0o700);
    expect(lstatSync(pendingPath).mode & 0o7777).toBe(0o600);
    expect(lstatSync(pendingPath).nlink).toBe(1);
    expect(readdirSync(directoryPath)).toEqual(['pending.json']);
    expect(readFileSync(pendingPath)).toEqual(firstRead);
    expect(firstRead.toString('utf8').endsWith('\n')).toBe(true);
  });

  it('preserves private modes under a restrictive umask and accepts an existing private directory', () => {
    const first = createFixture();
    const second = createFixture();
    mkdirSync(handoffDirectory(second.databasePath), { mode: 0o700 });
    const originalUmask = process.umask(0o777);
    try {
      expect(prepareGovernanceRestoreHandoff(validInput(first.databasePath)).status)
        .toBe('pending');
      expect(prepareGovernanceRestoreHandoff(validInput(second.databasePath)).status)
        .toBe('pending');
    } finally {
      process.umask(originalUmask);
    }

    for (const { databasePath } of [first, second]) {
      const directoryPath = handoffDirectory(databasePath);
      const pendingPath = join(directoryPath, 'pending.json');
      expect(lstatSync(directoryPath).mode & 0o7777).toBe(0o700);
      expect(lstatSync(pendingPath).mode & 0o7777).toBe(0o600);
      expect(lstatSync(pendingPath).nlink).toBe(1);
      expect(readdirSync(directoryPath)).toEqual(['pending.json']);
    }
  });

  it('issues independent random 256-bit handoff identifiers', () => {
    const first = createFixture();
    const second = createFixture();

    const firstReceipt = prepareGovernanceRestoreHandoff(validInput(first.databasePath));
    const secondReceipt = prepareGovernanceRestoreHandoff(validInput(second.databasePath));

    expect(firstReceipt.status).toBe('pending');
    expect(secondReceipt.status).toBe('pending');
    expect(firstReceipt.handoffId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(secondReceipt.handoffId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(firstReceipt.handoffId).not.toBe(secondReceipt.handoffId);
  });

  it('never overwrites or repairs an existing pending envelope', () => {
    const { databasePath } = createFixture();
    const firstReceipt = prepareGovernanceRestoreHandoff(validInput(databasePath));
    const pendingPath = join(handoffDirectory(databasePath), 'pending.json');
    const firstBytes = readFileSync(pendingPath);
    const firstStats = lstatSync(pendingPath);

    const repeatedReceipt = prepareGovernanceRestoreHandoff(validInput(databasePath, {
      backupRef: 'C'.repeat(43),
      previewDigest: 'd'.repeat(64),
      now: new Date('2026-07-28T09:01:00.000Z'),
    }));

    expect(firstReceipt.status).toBe('pending');
    expect(repeatedReceipt).toEqual(ATTENTION_RECEIPT);
    expect(readFileSync(pendingPath)).toEqual(firstBytes);
    expect(lstatSync(pendingPath).ino).toBe(firstStats.ino);
    expect(lstatSync(pendingPath).nlink).toBe(1);
    expect(readdirSync(handoffDirectory(databasePath))).toEqual(['pending.json']);
  });

  it.each([
    ['short backup reference', { backupRef: 'short' }],
    ['non-base64url backup reference', { backupRef: `${'A'.repeat(42)}/` }],
    ['short preview digest', { previewDigest: 'b'.repeat(63) }],
    ['uppercase preview digest', { previewDigest: 'B'.repeat(64) }],
    ['foreign contract version', { contractVersion: 2 }],
    ['invalid time', { now: new Date(Number.NaN) }],
    ['pre-epoch time', { now: new Date(-1) }],
    ['time without bounded expiry', { now: new Date('9999-12-31T23:45:00.000Z') }],
  ])('rejects %s before filesystem mutation', (_name, override) => {
    const { databasePath } = createFixture();
    const input = { ...validInput(databasePath), ...override };

    expect(prepareInvalid(input)).toEqual(ATTENTION_RECEIPT);
    expect(existsSync(handoffDirectory(databasePath))).toBe(false);
    expect(JSON.stringify(prepareInvalid(input))).not.toContain(String(Object.values(override)[0]));
  });

  it('rejects absent, relative, and non-normalized database locations without leaking them', () => {
    const { databasePath, root } = createFixture();
    const inputs: unknown[] = [
      undefined,
      validInput('relative/lethebot.db'),
      validInput(`${dirname(databasePath)}/../data/./lethebot.db`),
      validInput(join(root, 'missing', 'lethebot.db')),
    ];

    for (const input of inputs) {
      const receipt = prepareInvalid(input);
      expect(receipt).toEqual(ATTENTION_RECEIPT);
      expect(JSON.stringify(receipt)).not.toContain(root);
    }
    expect(existsSync(handoffDirectory(databasePath))).toBe(false);
  });

  it.each(['file', 'symlink', 'permissive'])('rejects an unsafe %s handoff directory unchanged', (kind) => {
    const { databasePath, root } = createFixture();
    const directoryPath = handoffDirectory(databasePath);
    const outsidePath = join(root, 'outside-handoff');
    mkdirSync(outsidePath, { mode: 0o700 });
    if (kind === 'file') {
      writeFileSync(directoryPath, 'directory-sentinel\n', { mode: 0o600 });
    } else if (kind === 'symlink') {
      symlinkSync(outsidePath, directoryPath);
    } else {
      mkdirSync(directoryPath, { mode: 0o755 });
    }
    const beforeKind = lstatSync(directoryPath);

    expect(prepareGovernanceRestoreHandoff(validInput(databasePath))).toEqual(ATTENTION_RECEIPT);
    const afterKind = lstatSync(directoryPath);
    expect(afterKind.ino).toBe(beforeKind.ino);
    expect(afterKind.mode).toBe(beforeKind.mode);
    if (kind === 'file') {
      expect(readFileSync(directoryPath, 'utf8')).toBe('directory-sentinel\n');
    }
    expect(readdirSync(outsidePath)).toEqual([]);
  });

  it.runIf(typeof process.getuid === 'function')(
    'rejects an apparent wrong-owner directory without repair',
    () => {
      const { databasePath } = createFixture();
      const directoryPath = handoffDirectory(databasePath);
      mkdirSync(directoryPath, { mode: 0o700 });
      const before = lstatSync(directoryPath);
      const getuid = vi.spyOn(process, 'getuid').mockReturnValue(before.uid + 1);
      try {
        expect(prepareGovernanceRestoreHandoff(validInput(databasePath)))
          .toEqual(ATTENTION_RECEIPT);
      } finally {
        getuid.mockRestore();
      }
      expect(lstatSync(directoryPath).ino).toBe(before.ino);
      expect(lstatSync(directoryPath).mode).toBe(before.mode);
      expect(readdirSync(directoryPath)).toEqual([]);
    },
  );

  it.each(['regular', 'permissive', 'directory', 'symlink', 'multi-link', 'staging'])(
    'preserves an existing unsafe or malformed %s pending entry',
    (kind) => {
      const { databasePath, root } = createFixture();
      const directoryPath = handoffDirectory(databasePath);
      const pendingPath = join(directoryPath, 'pending.json');
      mkdirSync(directoryPath, { mode: 0o700 });
      if (kind === 'directory') {
        mkdirSync(pendingPath, { mode: 0o700 });
      } else if (kind === 'symlink') {
        const outside = join(root, 'outside-pending');
        writeFileSync(outside, 'outside-sentinel\n', { mode: 0o600 });
        symlinkSync(outside, pendingPath);
      } else if (kind === 'multi-link') {
        const outside = join(root, 'linked-pending');
        writeFileSync(outside, 'linked-sentinel\n', { mode: 0o600 });
        linkSync(outside, pendingPath);
      } else if (kind === 'staging') {
        writeFileSync(join(directoryPath, '.pending.foreign.tmp'), 'foreign\n', { mode: 0o600 });
      } else {
        writeFileSync(pendingPath, '{malformed}\n', {
          mode: kind === 'permissive' ? 0o644 : 0o600,
        });
      }
      const entries = readdirSync(directoryPath);
      const snapshots = entries.map((entry) => {
        const path = join(directoryPath, entry);
        const stats = lstatSync(path);
        return {
          entry,
          ino: stats.ino,
          mode: stats.mode,
          content: stats.isFile() ? readFileSync(path) : null,
        };
      });

      expect(prepareGovernanceRestoreHandoff(validInput(databasePath))).toEqual(ATTENTION_RECEIPT);
      expect(readdirSync(directoryPath)).toEqual(entries);
      for (const snapshot of snapshots) {
        const path = join(directoryPath, snapshot.entry);
        expect(lstatSync(path).ino).toBe(snapshot.ino);
        expect(lstatSync(path).mode).toBe(snapshot.mode);
        if (snapshot.content !== null) {
          expect(readFileSync(path)).toEqual(snapshot.content);
        }
      }
    },
  );

  it('does not read or change database and managed-backup artifacts', () => {
    const { databasePath } = createFixture();
    const backupDirectory = join(dirname(databasePath), '.lethebot-governance-backups');
    const backupPath = join(backupDirectory, `${BACKUP_REF}.db`);
    mkdirSync(backupDirectory, { mode: 0o700 });
    writeFileSync(databasePath, 'database-sentinel\n', { mode: 0o600 });
    writeFileSync(backupPath, 'backup-sentinel\n', { mode: 0o600 });
    chmodSync(databasePath, 0o000);
    const databaseStats = lstatSync(databasePath);
    const backupStats = lstatSync(backupPath);

    expect(prepareGovernanceRestoreHandoff(validInput(databasePath)).status).toBe('pending');
    expect(lstatSync(databasePath).ino).toBe(databaseStats.ino);
    expect(lstatSync(databasePath).mode).toBe(databaseStats.mode);
    expect(lstatSync(backupPath).ino).toBe(backupStats.ino);
    expect(lstatSync(backupPath).mode).toBe(backupStats.mode);
    chmodSync(databasePath, 0o600);
    expect(readFileSync(databasePath)).toEqual(Buffer.from('database-sentinel\n'));
    expect(readFileSync(backupPath)).toEqual(Buffer.from('backup-sentinel\n'));
  });
});
