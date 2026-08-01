import { describe, expect, it } from 'vitest';
import { validateReleasePackManifest } from '../../../src/scripts/release-pack-check.js';

const migrationFiles = [
  '001_initial_schema.sql',
  '002_governed_context.sql',
] as const;
const requiredPaths = [
  'LICENSE',
  'README.md',
  'dist/cli/main.js',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/version.js',
  'package.json',
  ...migrationFiles.map((fileName) => `migrations/${fileName}`),
];

function files(paths: readonly string[]): Array<{ path: string; size: number }> {
  return paths.map((path) => ({ path, size: 1 }));
}

describe('release pack check', () => {
  it.each([
    ['npm object output', { lethebot: { files: files(requiredPaths) } }],
    ['npm array output', [{ files: files(requiredPaths) }]],
  ])('accepts all required publish artifacts from %s', (_label, manifest) => {
    expect(validateReleasePackManifest(manifest, migrationFiles)).toEqual({
      ok: true,
      fileCount: requiredPaths.length,
      diagnostics: [],
    });
  });

  it('rejects a package missing a runtime artifact', () => {
    const manifest = {
      lethebot: {
        files: files(requiredPaths.filter((path) => path !== 'dist/version.js')),
      },
    };

    const result = validateReleasePackManifest(manifest, migrationFiles);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'missing-pack-file',
    );
  });

  it.each([
    'data/lethebot.db',
    '.env.production',
    'logs/runtime.log',
    'coverage/index.html',
  ])('rejects forbidden local artifact %s', (forbiddenPath) => {
    const manifest = {
      lethebot: {
        files: files([...requiredPaths, forbiddenPath]),
      },
    };

    const result = validateReleasePackManifest(manifest, migrationFiles);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'forbidden-pack-file',
    );
  });

  it.each([
    null,
    {},
    [],
    [{ files: [{ path: '' }] }],
    [{ files: [{ size: 1 }] }],
    [{ files: [] }, { files: [] }],
  ])('rejects malformed npm pack output %#', (manifest) => {
    expect(validateReleasePackManifest(manifest, migrationFiles)).toEqual({
      ok: false,
      fileCount: 0,
      diagnostics: [{
        code: 'invalid-pack-manifest',
        message: 'Npm returned an invalid dry-run release manifest.',
      }],
    });
  });
});
