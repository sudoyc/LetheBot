import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { readMigrationPlan } from '../storage/migration-plan.js';
import { CURRENT_SCHEMA_VERSION } from '../storage/schema-version.js';

export type ReleasePackDiagnosticCode =
  | 'pack-command-failed'
  | 'invalid-pack-manifest'
  | 'invalid-migration-set'
  | 'missing-pack-file'
  | 'forbidden-pack-file';

export interface ReleasePackDiagnostic {
  code: ReleasePackDiagnosticCode;
  message: string;
}

export interface ReleasePackCheckResult {
  ok: boolean;
  fileCount: number;
  diagnostics: ReleasePackDiagnostic[];
}

const STATIC_REQUIRED_FILES = [
  'LICENSE',
  'README.md',
  'dist/cli/main.js',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/version.js',
  'package.json',
] as const;
const FORBIDDEN_PACK_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.git|backups?|coverage|data|logs?)(?:\/|$)|\.(?:db|db-(?:shm|wal)|log|sqlite3?|sqlite3?-(?:shm|wal))$/i;
const MAX_PACK_OUTPUT_BYTES = 8 * 1024 * 1024;

const DIAGNOSTIC_MESSAGES: Record<ReleasePackDiagnosticCode, string> = {
  'pack-command-failed': 'Npm could not produce the dry-run release manifest.',
  'invalid-pack-manifest': 'Npm returned an invalid dry-run release manifest.',
  'invalid-migration-set': 'Migration files do not match the schema target.',
  'missing-pack-file': 'The release package is missing one or more required files.',
  'forbidden-pack-file': 'The release package contains a forbidden local or sensitive file.',
};

const PackFileSchema = z.object({
  path: z.string().min(1),
}).passthrough();
const PackMetadataSchema = z.object({
  files: z.array(PackFileSchema),
}).passthrough();
const PackManifestSchema = z.union([
  z.array(PackMetadataSchema).length(1).transform(([metadata]) => metadata),
  z.record(z.string(), PackMetadataSchema).refine(
    (manifest) => Object.keys(manifest).length === 1,
  ).transform((manifest) => Object.values(manifest)[0]),
]);

export function validateReleasePackManifest(
  manifest: unknown,
  migrationFileNames: readonly string[],
): ReleasePackCheckResult {
  const parsedManifest = PackManifestSchema.safeParse(manifest);
  if (!parsedManifest.success || parsedManifest.data === undefined) {
    return {
      ok: false,
      fileCount: 0,
      diagnostics: [{
        code: 'invalid-pack-manifest',
        message: DIAGNOSTIC_MESSAGES['invalid-pack-manifest'],
      }],
    };
  }

  const paths = parsedManifest.data.files.map((file) => file.path.replaceAll('\\', '/'));

  const pathSet = new Set(paths);
  const requiredFiles = [
    ...STATIC_REQUIRED_FILES,
    ...migrationFileNames.map((fileName) => `migrations/${fileName}`),
  ];
  const diagnostics: ReleasePackDiagnostic[] = [];
  if (requiredFiles.some((path) => !pathSet.has(path))) {
    diagnostics.push({
      code: 'missing-pack-file',
      message: DIAGNOSTIC_MESSAGES['missing-pack-file'],
    });
  }
  if (paths.some((path) => FORBIDDEN_PACK_PATH.test(path))) {
    diagnostics.push({
      code: 'forbidden-pack-file',
      message: DIAGNOSTIC_MESSAGES['forbidden-pack-file'],
    });
  }

  return {
    ok: diagnostics.length === 0,
    fileCount: paths.length,
    diagnostics,
  };
}

export function runReleasePackCheck(projectRoot: string): ReleasePackCheckResult {
  let migrationFileNames: string[];
  try {
    migrationFileNames = readMigrationPlan(
      join(projectRoot, 'migrations'),
      CURRENT_SCHEMA_VERSION,
    ).map((migration) => migration.fileName);
  } catch {
    return {
      ok: false,
      fileCount: 0,
      diagnostics: [{
        code: 'invalid-migration-set',
        message: DIAGNOSTIC_MESSAGES['invalid-migration-set'],
      }],
    };
  }

  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: MAX_PACK_OUTPUT_BYTES,
  });
  if (result.error !== undefined || result.status !== 0) {
    return {
      ok: false,
      fileCount: 0,
      diagnostics: [{
        code: 'pack-command-failed',
        message: DIAGNOSTIC_MESSAGES['pack-command-failed'],
      }],
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      fileCount: 0,
      diagnostics: [{
        code: 'invalid-pack-manifest',
        message: DIAGNOSTIC_MESSAGES['invalid-pack-manifest'],
      }],
    };
  }
  return validateReleasePackManifest(manifest, migrationFileNames);
}

function main(): void {
  const result = runReleasePackCheck(process.cwd());
  if (result.ok) {
    process.stdout.write(
      `Release pack check passed: ${result.fileCount} files; runtime, migrations, metadata, and license present.\n`,
    );
    return;
  }

  process.stderr.write(`Release pack check failed: ${result.diagnostics.length} issue(s).\n`);
  for (const diagnostic of result.diagnostics) {
    process.stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
