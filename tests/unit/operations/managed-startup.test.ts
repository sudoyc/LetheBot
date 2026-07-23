import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertManagedStartupAuthorizationClean,
  clearManagedStartupAuthorization,
  completeManagedStartupAuthorization,
  ManagedStartupError,
  persistManagedStartupAuthorization,
  runManagedStartupGate,
} from '../../../src/operations/managed-startup.js';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createManagedRoot(pending = true): {
  rootDir: string;
  candidateEntrypoint: string;
  priorEntrypoint: string;
} {
  const rootDir = mkdtempSync(join(tmpdir(), 'lethebot-managed-startup-'));
  roots.push(rootDir);
  const priorEntrypoint = join(rootDir, 'releases', 'A', 'dist', 'index.js');
  const candidateEntrypoint = join(rootDir, 'releases', 'B', 'dist', 'index.js');
  for (const releaseId of ['A', 'B']) {
    const releaseDir = join(rootDir, 'releases', releaseId);
    mkdirSync(join(releaseDir, 'dist'), { recursive: true });
    mkdirSync(join(releaseDir, 'migrations'), { recursive: true });
    mkdirSync(join(releaseDir, 'node_modules'), { recursive: true });
    writeFileSync(join(releaseDir, 'dist/index.js'), 'export {};\n', 'utf8');
    writeFileSync(join(releaseDir, 'migrations/001_initial_schema.sql'), 'SELECT 1;\n', 'utf8');
    writeFileSync(join(releaseDir, 'package.json'), '{"type":"module"}\n', 'utf8');
    writeFileSync(join(releaseDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
  }
  symlinkSync(pending ? 'releases/B' : 'releases/A', join(rootDir, 'current'));
  if (pending) {
    writeActivationState(rootDir);
  }
  return { rootDir, candidateEntrypoint, priorEntrypoint };
}

function writeActivationState(rootDir: string): void {
  writeFileSync(
    join(rootDir, '.activation-state.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      operationKind: 'activation',
      candidateReleaseId: 'B',
      originalPointers: { current: 'A', previous: null },
      targetPointers: { current: 'B', previous: 'A' },
    })}\n`,
    'utf8',
  );
}

describe('managed startup authorization', () => {
  it('allows unmanaged and marker-free managed startup without a permit', () => {
    const { rootDir, priorEntrypoint } = createManagedRoot(false);

    expect(() => runManagedStartupGate({
      rootDir,
      entrypointPath: priorEntrypoint,
    })).not.toThrow();
  });

  it('consumes an exact pending-operation permit once', () => {
    const { rootDir, candidateEntrypoint } = createManagedRoot();

    persistManagedStartupAuthorization({
      rootDir,
      operationId: OPERATION_ID,
      releaseId: 'B',
    });
    expect(lstatSync(join(rootDir, '.startup-authorization.json')).mode & 0o777).toBe(0o600);

    expect(() => runManagedStartupGate({
      rootDir,
      entrypointPath: candidateEntrypoint,
    })).not.toThrow();
    expect(existsSync(join(rootDir, '.startup-authorization.claimed'))).toBe(true);
    expect(() => runManagedStartupGate({
      rootDir,
      entrypointPath: candidateEntrypoint,
    })).toThrow(ManagedStartupError);
    completeManagedStartupAuthorization(rootDir, OPERATION_ID);
    expect(() => assertManagedStartupAuthorizationClean(rootDir)).not.toThrow();
    expect(() => runManagedStartupGate({
      rootDir,
      entrypointPath: candidateEntrypoint,
    })).toThrow(ManagedStartupError);
  });

  it('rejects permits for another operation, current release, or real entrypoint', () => {
    const { rootDir, priorEntrypoint } = createManagedRoot();

    expect(() => persistManagedStartupAuthorization({
      rootDir,
      operationId: OTHER_OPERATION_ID,
      releaseId: 'B',
    })).toThrow(ManagedStartupError);
    expect(() => persistManagedStartupAuthorization({
      rootDir,
      operationId: OPERATION_ID,
      releaseId: 'A',
    })).toThrow(ManagedStartupError);

    persistManagedStartupAuthorization({
      rootDir,
      operationId: OPERATION_ID,
      releaseId: 'B',
    });
    expect(() => runManagedStartupGate({
      rootDir,
      entrypointPath: priorEntrypoint,
    })).toThrow(ManagedStartupError);
    expect(existsSync(join(rootDir, '.startup-authorization.json'))).toBe(true);
  });

  it.each([
    '.activation-state.tmp',
    `.startup-authorization-${OPERATION_ID}.tmp`,
    '.startup-authorization.claimed',
  ])('fails closed when %s exists', (name) => {
    const { rootDir, candidateEntrypoint } = createManagedRoot();
    writeFileSync(join(rootDir, name), '{}\n', { mode: 0o600 });

    expect(() => runManagedStartupGate({
      rootDir,
      entrypointPath: candidateEntrypoint,
    })).toThrow(ManagedStartupError);
  });

  it('retains a claimed permit after an interrupted consumer and clears it by operation', () => {
    const { rootDir, candidateEntrypoint } = createManagedRoot();
    persistManagedStartupAuthorization({
      rootDir,
      operationId: OPERATION_ID,
      releaseId: 'B',
    });
    runManagedStartupGate({ rootDir, entrypointPath: candidateEntrypoint });

    expect(() => runManagedStartupGate({
      rootDir,
      entrypointPath: candidateEntrypoint,
    })).toThrow(ManagedStartupError);
    expect(() => clearManagedStartupAuthorization(rootDir, OTHER_OPERATION_ID))
      .toThrow(ManagedStartupError);
    clearManagedStartupAuthorization(rootDir, OPERATION_ID);
    expect(() => assertManagedStartupAuthorizationClean(rootDir)).not.toThrow();
  });

  it('rejects malformed, over-permissive, and symlink permits', () => {
    const { rootDir, candidateEntrypoint } = createManagedRoot();
    const path = join(rootDir, '.startup-authorization.json');
    persistManagedStartupAuthorization({
      rootDir,
      operationId: OPERATION_ID,
      releaseId: 'B',
    });
    const validAuthorization = readFileSync(path);
    writeFileSync(path, '{not-json}\n', { mode: 0o600 });
    expect(() => runManagedStartupGate({ rootDir, entrypointPath: candidateEntrypoint }))
      .toThrow(ManagedStartupError);

    rmSync(path);
    writeFileSync(path, validAuthorization, { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => runManagedStartupGate({ rootDir, entrypointPath: candidateEntrypoint }))
      .toThrow(ManagedStartupError);

    rmSync(path);
    const outside = join(rootDir, 'outside-auth');
    writeFileSync(outside, validAuthorization, { mode: 0o600 });
    symlinkSync('outside-auth', path);
    expect(() => runManagedStartupGate({ rootDir, entrypointPath: candidateEntrypoint }))
      .toThrow(ManagedStartupError);
  });

  it('rejects release bytes changed after the startup permit was issued', () => {
    const { rootDir, candidateEntrypoint } = createManagedRoot();
    persistManagedStartupAuthorization({
      rootDir,
      operationId: OPERATION_ID,
      releaseId: 'B',
    });
    writeFileSync(candidateEntrypoint, 'export const changed = true;\n', 'utf8');

    expect(() => runManagedStartupGate({ rootDir, entrypointPath: candidateEntrypoint }))
      .toThrow(ManagedStartupError);
    expect(existsSync(join(rootDir, '.startup-authorization.json'))).toBe(true);
  });

  it('rejects runtime dependencies changed after the startup permit was issued', () => {
    const { rootDir, candidateEntrypoint } = createManagedRoot();
    const dependencyPath = join(rootDir, 'releases', 'B', 'node_modules', 'runtime.js');
    writeFileSync(dependencyPath, 'before\n', 'utf8');
    persistManagedStartupAuthorization({
      rootDir,
      operationId: OPERATION_ID,
      releaseId: 'B',
    });
    writeFileSync(dependencyPath, 'after!\n', 'utf8');

    expect(() => runManagedStartupGate({ rootDir, entrypointPath: candidateEntrypoint }))
      .toThrow(ManagedStartupError);
    expect(existsSync(join(rootDir, '.startup-authorization.json'))).toBe(true);
  });

  it('rejects over-permissive runtime dependencies', () => {
    const { rootDir, candidateEntrypoint } = createManagedRoot();
    const dependencyPath = join(rootDir, 'releases', 'B', 'node_modules', 'runtime.js');
    writeFileSync(dependencyPath, 'export {};\n', { mode: 0o666 });
    chmodSync(dependencyPath, 0o666);

    expect(() => persistManagedStartupAuthorization({
      rootDir,
      operationId: OPERATION_ID,
      releaseId: 'B',
    })).toThrow(ManagedStartupError);
    expect(() => runManagedStartupGate({ rootDir, entrypointPath: candidateEntrypoint }))
      .toThrow(ManagedStartupError);
  });
});
