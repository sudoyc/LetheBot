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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareGovernanceRestoreHandoff } from '../../../src/operations/governance-restore-handoff.js';
import { readGovernanceRestoreHandoff } from '../../../src/operations/governance-restore-handoff-reader.js';

const BACKUP_REF = 'A'.repeat(43);
const PREVIEW_DIGEST = 'b'.repeat(64);
const NOW = new Date('2026-07-28T10:00:00.000Z');
const ATTENTION_RECEIPT = {
  status: 'attention_required',
  handoffId: null,
  expiresAt: null,
  contractVersion: null,
  executionBoundary: 'stopped_service_only',
  effects: { restoreExecution: false },
} as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createPublishedFixture(now = NOW): {
  root: string;
  databasePath: string;
  directoryPath: string;
  pendingPath: string;
  handoffId: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-governance-restore-handoff-reader-'));
  roots.push(root);
  const dataDirectory = join(root, 'data');
  mkdirSync(dataDirectory, { mode: 0o700 });
  const databasePath = join(dataDirectory, 'lethebot.db');
  const published = prepareGovernanceRestoreHandoff({
    databasePath,
    backupRef: BACKUP_REF,
    previewDigest: PREVIEW_DIGEST,
    contractVersion: 1,
    now,
  });
  if (published.status !== 'pending') {
    throw new Error('Fixture handoff was not published.');
  }
  const directoryPath = join(dataDirectory, '.lethebot-governance-restore-handoff');
  return {
    root,
    databasePath,
    directoryPath,
    pendingPath: join(directoryPath, 'pending.json'),
    handoffId: published.handoffId,
  };
}

function expectAttention(databasePath: string): void {
  const receipt = readGovernanceRestoreHandoff({ databasePath, now: NOW });
  expect(receipt).toEqual(ATTENTION_RECEIPT);
}

describe('governance restore handoff reader', () => {
  it('reopens a published pending envelope with fixed path-free evidence', () => {
    const fixture = createPublishedFixture();
    const { databasePath, handoffId } = fixture;
    const reopened = readGovernanceRestoreHandoff({ databasePath, now: NOW });

    expect(reopened).toEqual({
      status: 'pending',
      handoffId,
      expiresAt: '2026-07-28T10:15:00.000Z',
      contractVersion: 1,
      executionBoundary: 'stopped_service_only',
      effects: { restoreExecution: false },
    });
    expect(Object.keys(reopened).sort()).toEqual([
      'contractVersion',
      'effects',
      'executionBoundary',
      'expiresAt',
      'handoffId',
      'status',
    ]);
    expect(JSON.stringify(reopened)).not.toContain(BACKUP_REF);
    expect(JSON.stringify(reopened)).not.toContain(PREVIEW_DIGEST);
    expect(JSON.stringify(reopened)).not.toContain(fixture.root);
  });

  it('reopens the same envelope from a fresh process without consuming it', () => {
    const fixture = createPublishedFixture();
    const script = [
      "import { readGovernanceRestoreHandoff } from './src/operations/governance-restore-handoff-reader.ts';",
      'const result = readGovernanceRestoreHandoff({ databasePath: process.env.LETHEBOT_HANDOFF_DB, now: new Date(process.env.LETHEBOT_HANDOFF_NOW) });',
      'process.stdout.write(JSON.stringify(result));',
    ].join('\n');
    const child = spawnSync('pnpm', ['exec', 'tsx', '-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETHEBOT_HANDOFF_DB: fixture.databasePath,
        LETHEBOT_HANDOFF_NOW: NOW.toISOString(),
      },
      encoding: 'utf8',
    });

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      status: 'pending',
      handoffId: fixture.handoffId,
      expiresAt: '2026-07-28T10:15:00.000Z',
      contractVersion: 1,
      executionBoundary: 'stopped_service_only',
      effects: { restoreExecution: false },
    });
    expect(readdirSync(fixture.directoryPath)).toEqual(['pending.json']);
    expect(lstatSync(fixture.pendingPath).nlink).toBe(1);
  });

  it.each([
    ['before creation', new Date('2026-07-28T09:59:59.999Z')],
    ['at expiry', new Date('2026-07-28T10:15:00.000Z')],
    ['after expiry', new Date('2026-07-28T10:16:00.000Z')],
  ])('returns fixed attention for a handoff %s', (_label, now) => {
    const fixture = createPublishedFixture();
    const before = readFileSync(fixture.pendingPath);

    expect(readGovernanceRestoreHandoff({ databasePath: fixture.databasePath, now }))
      .toEqual(ATTENTION_RECEIPT);
    expect(readFileSync(fixture.pendingPath)).toEqual(before);
    expect(readdirSync(fixture.directoryPath)).toEqual(['pending.json']);
  });

  it.each([
    ['malformed JSON', '{not-json}\n'],
    ['wrong schema version', '{"schemaVersion":2}\n'],
    ['extra envelope key', `${JSON.stringify({
      schemaVersion: 1,
      state: 'pending',
      handoffId: 'A'.repeat(43),
      backupRef: BACKUP_REF,
      previewDigest: PREVIEW_DIGEST,
      restoreContractVersion: 1,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-07-28T10:15:00.000Z',
      executionBoundary: 'stopped_service_only',
      extra: true,
    })}\n`],
    ['invalid digest', `${JSON.stringify({
      schemaVersion: 1,
      state: 'pending',
      handoffId: 'A'.repeat(43),
      backupRef: BACKUP_REF,
      previewDigest: 'C'.repeat(64),
      restoreContractVersion: 1,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-07-28T10:15:00.000Z',
      executionBoundary: 'stopped_service_only',
    })}\n`],
    ['non-canonical framing', `${JSON.stringify({
      schemaVersion: 1,
      state: 'pending',
      handoffId: 'A'.repeat(43),
      backupRef: BACKUP_REF,
      previewDigest: PREVIEW_DIGEST,
      restoreContractVersion: 1,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-07-28T10:15:00.000Z',
      executionBoundary: 'stopped_service_only',
    })}  \n`],
  ])('preserves and rejects %s envelope bytes', (_label, content) => {
    const fixture = createPublishedFixture();
    writeFileSync(fixture.pendingPath, content, { mode: 0o600 });
    const before = readFileSync(fixture.pendingPath);
    const inode = lstatSync(fixture.pendingPath).ino;

    expectAttention(fixture.databasePath);
    expect(readFileSync(fixture.pendingPath)).toEqual(before);
    expect(lstatSync(fixture.pendingPath).ino).toBe(inode);
    expect(readdirSync(fixture.directoryPath)).toEqual(['pending.json']);
  });

  it.each(['directory', 'symlink', 'permissive'])(
    'returns attention for an unsafe pending %s without repair',
    (kind) => {
      const fixture = createPublishedFixture();
      unlinkSync(fixture.pendingPath);
      const outside = join(fixture.root, `outside-${kind}`);
      if (kind === 'directory') {
        mkdirSync(fixture.pendingPath, { mode: 0o700 });
      } else if (kind === 'symlink') {
        writeFileSync(outside, 'outside-sentinel\n', { mode: 0o600 });
        symlinkSync(outside, fixture.pendingPath);
      } else {
        writeFileSync(fixture.pendingPath, 'permissive-sentinel\n', { mode: 0o644 });
      }
      const before = lstatSync(fixture.pendingPath);
      const content = before.isFile() ? readFileSync(fixture.pendingPath) : null;

      expectAttention(fixture.databasePath);
      expect(lstatSync(fixture.pendingPath).ino).toBe(before.ino);
      expect(lstatSync(fixture.pendingPath).mode).toBe(before.mode);
      if (content !== null) {
        expect(readFileSync(fixture.pendingPath)).toEqual(content);
      }
      if (kind === 'symlink') {
        expect(readFileSync(outside, 'utf8')).toBe('outside-sentinel\n');
      }
    },
  );

  it('rejects a multi-link pending entry without changing either link', () => {
    const fixture = createPublishedFixture();
    unlinkSync(fixture.pendingPath);
    const outside = join(fixture.root, 'linked-pending');
    writeFileSync(outside, 'linked-sentinel\n', { mode: 0o600 });
    linkSync(outside, fixture.pendingPath);
    const before = lstatSync(outside);

    expectAttention(fixture.databasePath);
    expect(lstatSync(outside).ino).toBe(before.ino);
    expect(lstatSync(outside).nlink).toBe(2);
    expect(lstatSync(fixture.pendingPath).nlink).toBe(2);
  });

  it('rejects an unexpected staging sibling without cleaning it up', () => {
    const fixture = createPublishedFixture();
    const stagingPath = join(fixture.directoryPath, '.pending.foreign.tmp');
    writeFileSync(stagingPath, 'foreign-staging\n', { mode: 0o600 });
    const before = lstatSync(stagingPath);

    expectAttention(fixture.databasePath);
    expect(lstatSync(stagingPath).ino).toBe(before.ino);
    expect(readFileSync(stagingPath, 'utf8')).toBe('foreign-staging\n');
    expect(readdirSync(fixture.directoryPath).sort()).toEqual([
      '.pending.foreign.tmp',
      'pending.json',
    ]);
  });

  it('rejects an oversized pending entry without truncating it', () => {
    const fixture = createPublishedFixture();
    const oversized = `${'x'.repeat(2_049)}\n`;
    writeFileSync(fixture.pendingPath, oversized, { mode: 0o600 });
    const before = lstatSync(fixture.pendingPath);

    expectAttention(fixture.databasePath);
    expect(lstatSync(fixture.pendingPath).ino).toBe(before.ino);
    expect(readFileSync(fixture.pendingPath, 'utf8')).toBe(oversized);
  });

  it('rejects unsafe handoff directories without touching outside state', () => {
    for (const kind of ['file', 'symlink', 'permissive'] as const) {
      const fixture = createPublishedFixture();
      rmSync(fixture.directoryPath, { recursive: true, force: true });
      const outside = join(fixture.root, `outside-directory-${kind}`);
      if (kind === 'file') {
        writeFileSync(fixture.directoryPath, 'directory-sentinel\n', { mode: 0o600 });
      } else if (kind === 'symlink') {
        mkdirSync(outside, { mode: 0o700 });
        symlinkSync(outside, fixture.directoryPath);
      } else {
        mkdirSync(fixture.directoryPath, { mode: 0o755 });
      }
      const before = lstatSync(fixture.directoryPath);

      expectAttention(fixture.databasePath);
      expect(lstatSync(fixture.directoryPath).ino).toBe(before.ino);
      expect(lstatSync(fixture.directoryPath).mode).toBe(before.mode);
      if (kind === 'symlink') {
        expect(readdirSync(outside)).toEqual([]);
      }
    }
  });

  it.runIf(typeof process.getuid === 'function')(
    'rejects apparent wrong-owner directory and pending entry without repair',
    () => {
      const fixture = createPublishedFixture();
      const directoryBefore = lstatSync(fixture.directoryPath);
      const directoryUid = vi.spyOn(process, 'getuid').mockReturnValue(directoryBefore.uid + 1);
      try {
        expectAttention(fixture.databasePath);
      } finally {
        directoryUid.mockRestore();
      }
      expect(lstatSync(fixture.directoryPath).ino).toBe(directoryBefore.ino);

      const pendingBefore = lstatSync(fixture.pendingPath);
      const pendingUid = vi.spyOn(process, 'getuid')
        .mockReturnValueOnce(directoryBefore.uid)
        .mockReturnValueOnce(directoryBefore.uid)
        .mockReturnValue(pendingBefore.uid + 1);
      try {
        expectAttention(fixture.databasePath);
      } finally {
        pendingUid.mockRestore();
      }
      expect(lstatSync(fixture.pendingPath).ino).toBe(pendingBefore.ino);
      expect(readdirSync(fixture.directoryPath)).toEqual(['pending.json']);
    },
  );

  it('rejects a foreign sibling binding without creating or deleting state', () => {
    const fixture = createPublishedFixture();
    const otherRoot = mkdtempSync(join(tmpdir(), 'lethebot-governance-restore-handoff-other-'));
    roots.push(otherRoot);
    const otherData = join(otherRoot, 'data');
    mkdirSync(otherData, { mode: 0o700 });
    const otherDatabasePath = join(otherData, 'lethebot.db');

    expectAttention(otherDatabasePath);
    expect(existsSync(join(otherData, '.lethebot-governance-restore-handoff'))).toBe(false);
    expect(readdirSync(fixture.directoryPath)).toEqual(['pending.json']);
  });

  it('does not read or change database and backup artifacts', () => {
    const fixture = createPublishedFixture();
    const backupDirectory = join(fixture.root, 'data', '.lethebot-governance-backups');
    const backupPath = join(backupDirectory, `${BACKUP_REF}.db`);
    mkdirSync(backupDirectory, { mode: 0o700 });
    writeFileSync(fixture.databasePath, 'database-sentinel\n', { mode: 0o600 });
    writeFileSync(backupPath, 'backup-sentinel\n', { mode: 0o600 });
    chmodSync(fixture.databasePath, 0o000);
    const databaseBefore = lstatSync(fixture.databasePath);
    const backupBefore = lstatSync(backupPath);

    expect(readGovernanceRestoreHandoff({ databasePath: fixture.databasePath, now: NOW }).status)
      .toBe('pending');
    expect(lstatSync(fixture.databasePath).ino).toBe(databaseBefore.ino);
    expect(lstatSync(fixture.databasePath).mode).toBe(databaseBefore.mode);
    expect(lstatSync(backupPath).ino).toBe(backupBefore.ino);
    expect(lstatSync(backupPath).mode).toBe(backupBefore.mode);
    chmodSync(fixture.databasePath, 0o600);
    expect(readFileSync(fixture.databasePath, 'utf8')).toBe('database-sentinel\n');
    expect(readFileSync(backupPath, 'utf8')).toBe('backup-sentinel\n');
  });

  it.each([
    ['missing parent', '/tmp/lethebot-reader-missing-parent/lethebot.db'],
    ['relative path', 'relative/lethebot.db'],
    ['invalid time', undefined],
  ])('maps %s owner exceptions to fixed evidence', (_label, databasePath) => {
    if (databasePath === undefined) {
      expect(readGovernanceRestoreHandoff({
        databasePath: '/tmp/lethebot-reader-invalid-time.db',
        now: new Date(Number.NaN),
      })).toEqual(ATTENTION_RECEIPT);
    } else {
      expectAttention(databasePath);
      expect(JSON.stringify(readGovernanceRestoreHandoff({ databasePath, now: NOW })))
        .not.toContain(databasePath);
    }
  });
});
