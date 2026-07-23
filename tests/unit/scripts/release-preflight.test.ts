import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReleasePreflight } from '../../../src/scripts/release-preflight.js';

const temporaryRoots: string[] = [];
const schemaContract = {
  contractVersion: 1,
  targetVersion: 6,
  minReadableVersion: 1,
  maxReadableVersion: 6,
  adoptsLegacyUnversioned: true,
};

function createProjectFixture(options: {
  packageJson?: string;
  lockfile?: string;
} = {}): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'lethebot-release-preflight-'));
  temporaryRoots.push(projectRoot);

  mkdirSync(join(projectRoot, 'dist'), { recursive: true });
  mkdirSync(join(projectRoot, 'migrations'), { recursive: true });
  writeFileSync(join(projectRoot, 'dist/index.js'), 'export {};\n', 'utf8');
  writeFileSync(join(projectRoot, 'migrations/001_initial_schema.sql'), 'SELECT 1;\n', 'utf8');
  writeFileSync(join(projectRoot, 'migrations/002_governed_context.sql'), 'SELECT 2;\n', 'utf8');
  writeFileSync(join(projectRoot, 'migrations/003_evaluator_invocations.sql'), 'SELECT 3;\n', 'utf8');
  writeFileSync(join(projectRoot, 'migrations/004_evaluator_corrections.sql'), 'SELECT 4;\n', 'utf8');
  writeFileSync(join(projectRoot, 'migrations/005_delayed_attention.sql'), 'SELECT 5;\n', 'utf8');
  writeFileSync(join(projectRoot, 'migrations/006_group_summary_policy.sql'), 'SELECT 6;\n', 'utf8');
  writeFileSync(
    join(projectRoot, 'package.json'),
    options.packageJson ?? JSON.stringify({
      packageManager: 'pnpm@9.0.0',
      lethebotSchema: schemaContract,
    }),
    'utf8',
  );
  writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), options.lockfile ?? "lockfileVersion: '9.0'\n", 'utf8');

  return projectRoot;
}

afterEach(() => {
  for (const projectRoot of temporaryRoots.splice(0)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('release preflight', () => {
  it('accepts the required artifacts and matching exact pnpm metadata', () => {
    const result = runReleasePreflight(createProjectFixture());

    expect(result).toEqual({
      ok: true,
      checkedFileCount: 4,
      diagnostics: [],
      schemaContract,
    });
  });

  it('rejects a built entrypoint whose ESM dependency graph cannot load', () => {
    const projectRoot = createProjectFixture();
    writeFileSync(
      join(projectRoot, 'dist/index.js'),
      "import './missing-runtime-dependency.js';\n",
      'utf8',
    );

    const result = runReleasePreflight(projectRoot);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'unloadable-dist-entrypoint',
    );
  });

  it.each([
    ['dist/index.js', 'missing-dist-entrypoint'],
    ['migrations/001_initial_schema.sql', 'invalid-migration-set'],
    ['migrations/002_governed_context.sql', 'invalid-migration-set'],
    ['migrations/003_evaluator_invocations.sql', 'invalid-migration-set'],
    ['migrations/004_evaluator_corrections.sql', 'invalid-migration-set'],
    ['migrations/005_delayed_attention.sql', 'invalid-migration-set'],
    ['migrations/006_group_summary_policy.sql', 'invalid-migration-set'],
    ['package.json', 'missing-package-manifest'],
    ['pnpm-lock.yaml', 'missing-lockfile'],
  ])('fails closed when %s is missing', (relativePath, expectedCode) => {
    const projectRoot = createProjectFixture();
    rmSync(join(projectRoot, relativePath));

    const result = runReleasePreflight(projectRoot);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(expectedCode);
  });

  it.each([
    ['007_future.sql', 'SELECT 7;\n'],
    ['migration.sql', 'SELECT 7;\n'],
  ])('rejects an invalid migration-set member %s', (fileName, sql) => {
    const projectRoot = createProjectFixture();
    writeFileSync(join(projectRoot, 'migrations', fileName), sql, 'utf8');

    const result = runReleasePreflight(projectRoot);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'invalid-migration-set',
    );
  });

  it('parses package.json structurally and rejects malformed JSON', () => {
    const result = runReleasePreflight(createProjectFixture({ packageJson: '{"packageManager":' }));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('invalid-package-json');
  });

  it.each([
    [undefined, 'a missing contract'],
    [{ ...schemaContract, unexpected: true }, 'extra fields'],
    [{ ...schemaContract, minReadableVersion: 0 }, 'a minimum below version 1'],
    [{ ...schemaContract, minReadableVersion: 2 }, 'a narrowed minimum'],
    [{ ...schemaContract, minReadableVersion: 7 }, 'a minimum above the target'],
    [{ ...schemaContract, maxReadableVersion: 1 }, 'a maximum below the target'],
    [{ ...schemaContract, maxReadableVersion: 7 }, 'a maximum above the target'],
    [{ ...schemaContract, targetVersion: 2.5 }, 'a non-integer target'],
    [{ ...schemaContract, minReadableVersion: 1.5 }, 'a non-integer minimum'],
    [{ ...schemaContract, maxReadableVersion: 2.5 }, 'a non-integer maximum'],
    [{ ...schemaContract, adoptsLegacyUnversioned: false }, 'legacy adoption disabled'],
  ])('rejects package.json with %s schema metadata (%s)', (lethebotSchema) => {
    const result = runReleasePreflight(createProjectFixture({
      packageJson: JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        ...(lethebotSchema === undefined ? {} : { lethebotSchema }),
      }),
    }));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'invalid-schema-contract',
    );
  });

  it.each([
    [{}, 'missing packageManager'],
    [{ packageManager: 'npm@9.0.0' }, 'a different package manager'],
    [{ packageManager: 'pnpm@^9.0.0' }, 'a version range'],
    [{ packageManager: 'pnpm@9.0' }, 'an incomplete version'],
  ])('rejects package.json with $1', (manifest) => {
    const result = runReleasePreflight(
      createProjectFixture({ packageJson: JSON.stringify(manifest) }),
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('invalid-package-manager');
  });

  it('rejects a pnpm major that differs from the lockfile version major', () => {
    const result = runReleasePreflight(
      createProjectFixture({
        packageJson: JSON.stringify({
          packageManager: 'pnpm@10.1.2',
          lethebotSchema: schemaContract,
        }),
        lockfile: "lockfileVersion: '9.0'\n",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'package-lock-major-mismatch',
    );
  });

  it.each([
    ['', 'an absent version'],
    ['lockfileVersion: latest\n', 'a nonnumeric version'],
    ["settings:\n  lockfileVersion: '9.0'\n", 'a nested version'],
  ])('rejects a lockfile with %s', (lockfile) => {
    const result = runReleasePreflight(createProjectFixture({ lockfile }));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'invalid-lockfile-version',
    );
  });

  it('defaults the CLI root to cwd and prints only bounded aggregate success', () => {
    const projectRoot = createProjectFixture();
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const script = join(process.cwd(), 'src/scripts/release-preflight.ts');

    const result = spawnSync(tsxBin, [script], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'Release preflight passed: 4 required files; pnpm/lockfile and schema contract valid.\n',
    );
    expect(result.stdout).not.toContain(projectRoot);
  });

  it('exits nonzero with bounded diagnostics that do not expose the project root', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'sk-secret-qq-1234567890-'));
    temporaryRoots.push(projectRoot);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const script = join(process.cwd(), 'src/scripts/release-preflight.ts');

    const result = spawnSync(tsxBin, [script], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Release preflight failed: 4 issue(s).');
    expect(result.stderr).not.toContain(projectRoot);
    expect(result.stderr).not.toContain('sk-secret');
    expect(result.stderr).not.toContain('1234567890');
    expect(result.stderr.length).toBeLessThan(1_024);
    expect(result.stderr.trim().split('\n')).toHaveLength(5);
  });
});
