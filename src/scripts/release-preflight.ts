import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMigrationPlan } from '../storage/migration-plan.js';
import { CURRENT_SCHEMA_VERSION } from '../storage/schema-version.js';
import { isSemanticVersion } from '../version.js';

export type ReleasePreflightDiagnosticCode =
  | 'missing-dist-entrypoint'
  | 'unloadable-dist-entrypoint'
  | 'missing-initial-migration'
  | 'invalid-migration-set'
  | 'missing-package-manifest'
  | 'missing-license'
  | 'missing-lockfile'
  | 'unreadable-package-manifest'
  | 'unreadable-lockfile'
  | 'invalid-package-json'
  | 'invalid-package-manager'
  | 'invalid-package-version'
  | 'invalid-schema-contract'
  | 'dist-version-mismatch'
  | 'invalid-lockfile-version'
  | 'package-lock-version-incompatible';

export interface ReleasePreflightDiagnostic {
  code: ReleasePreflightDiagnosticCode;
  message: string;
}

export interface ReleasePreflightResult {
  ok: boolean;
  checkedFileCount: number;
  diagnostics: ReleasePreflightDiagnostic[];
  schemaContract?: ReleaseSchemaContract;
}

export interface ReleaseSchemaContract {
  contractVersion: 1;
  targetVersion: number;
  minReadableVersion: number;
  maxReadableVersion: number;
  adoptsLegacyUnversioned: boolean;
}

const DIAGNOSTIC_MESSAGES: Record<ReleasePreflightDiagnosticCode, string> = {
  'missing-dist-entrypoint': 'Required built entrypoint is missing.',
  'unloadable-dist-entrypoint': 'Built entrypoint dependency graph is not loadable by Node.',
  'missing-initial-migration': 'Required initial migration is missing.',
  'invalid-migration-set': 'Migration files do not match the schema target.',
  'missing-package-manifest': 'Required package manifest is missing.',
  'missing-license': 'Required license file is missing.',
  'missing-lockfile': 'Required pnpm lockfile is missing.',
  'unreadable-package-manifest': 'Package manifest could not be read.',
  'unreadable-lockfile': 'Pnpm lockfile could not be read.',
  'invalid-package-json': 'Package manifest is not valid JSON metadata.',
  'invalid-package-manager': 'Package manager must be an exact pnpm semantic version.',
  'invalid-package-version': 'Package manifest version is not a valid semantic version.',
  'dist-version-mismatch': 'Built entrypoint version does not match the package manifest.',
  'invalid-schema-contract': 'Package manifest schema compatibility contract is invalid.',
  'invalid-lockfile-version': 'Pnpm lockfile version is missing or invalid.',
  'package-lock-version-incompatible': 'Pnpm and lockfile versions are not compatible.',
};

const EXACT_PNPM_SEMVER = /^pnpm@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TOP_LEVEL_LOCKFILE_VERSION = /^lockfileVersion:\s*['"]?(0|[1-9]\d*)(?:\.\d+)?['"]?\s*(?:#.*)?$/m;
const PNPM_LOCKFILE_MAJOR_COMPATIBILITY: Readonly<Record<string, string>> = {
  '9': '9',
  '10': '9',
  '11': '9',
};
const MAX_CLI_DIAGNOSTICS = 8;
const ENTRYPOINT_LOAD_TIMEOUT_MS = 10_000;

function addDiagnostic(
  diagnostics: ReleasePreflightDiagnostic[],
  code: ReleasePreflightDiagnosticCode,
): void {
  diagnostics.push({ code, message: DIAGNOSTIC_MESSAGES[code] });
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readRequiredTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function inspectEntrypoint(
  projectRoot: string,
  entrypointPath: string,
  expectedVersion: string | undefined,
): 'loadable' | 'unloadable' | 'version-mismatch' {
  const versionCheck = expectedVersion === undefined
    ? ''
    : `if (entrypoint.VERSION !== ${JSON.stringify(expectedVersion)}) process.exit(42);`;
  // The candidate release root is runtime-selected, so a static import cannot inspect it.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const entrypoint = await import(${JSON.stringify(pathToFileURL(entrypointPath).href)}); ${versionCheck}`,
    ],
    {
      cwd: projectRoot,
      stdio: 'ignore',
      timeout: ENTRYPOINT_LOAD_TIMEOUT_MS,
    },
  );

  if (result.error !== undefined) {
    return 'unloadable';
  }
  if (result.status === 42) {
    return 'version-mismatch';
  }
  return result.status === 0 ? 'loadable' : 'unloadable';
}

function packageManagerMajor(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const packageManager = (parsed as Record<string, unknown>).packageManager;
  if (typeof packageManager !== 'string') {
    return '';
  }

  return EXACT_PNPM_SEMVER.exec(packageManager)?.[1] ?? '';
}

function lockfileMajor(content: string): string | undefined {
  return TOP_LEVEL_LOCKFILE_VERSION.exec(content)?.[1];
}

function isPnpmLockfileCompatible(pnpmMajor: string, lockMajor: string): boolean {
  return PNPM_LOCKFILE_MAJOR_COMPATIBILITY[pnpmMajor] === lockMajor;
}

function parseReleaseSchemaContract(content: string): ReleaseSchemaContract | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.lethebotSchema)) {
    return undefined;
  }

  const contract = parsed.lethebotSchema;
  const expectedKeys = [
    'adoptsLegacyUnversioned',
    'contractVersion',
    'maxReadableVersion',
    'minReadableVersion',
    'targetVersion',
  ];
  if (
    Object.keys(contract).sort().join('\0') !== expectedKeys.join('\0')
    || contract.contractVersion !== 1
    || !isSafeInteger(contract.targetVersion)
    || !isSafeInteger(contract.minReadableVersion)
    || !isSafeInteger(contract.maxReadableVersion)
    || contract.targetVersion !== CURRENT_SCHEMA_VERSION
    || contract.minReadableVersion !== 1
    || contract.maxReadableVersion !== contract.targetVersion
    || contract.adoptsLegacyUnversioned !== true
  ) {
    return undefined;
  }

  return {
    contractVersion: 1,
    targetVersion: contract.targetVersion,
    minReadableVersion: contract.minReadableVersion,
    maxReadableVersion: contract.maxReadableVersion,
    adoptsLegacyUnversioned: contract.adoptsLegacyUnversioned,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function runReleasePreflight(projectRoot: string): ReleasePreflightResult {
  const paths = {
    entrypoint: join(projectRoot, 'dist/index.js'),
    migrations: join(projectRoot, 'migrations'),
    manifest: join(projectRoot, 'package.json'),
    lockfile: join(projectRoot, 'pnpm-lock.yaml'),
    license: join(projectRoot, 'LICENSE'),
  };
  const diagnostics: ReleasePreflightDiagnostic[] = [];
  const migrationDirectoryExists = isDirectory(paths.migrations);
  let migrationSetValid = false;
  if (migrationDirectoryExists) {
    try {
      readMigrationPlan(paths.migrations, CURRENT_SCHEMA_VERSION);
      migrationSetValid = true;
    } catch {
      addDiagnostic(diagnostics, 'invalid-migration-set');
    }
  }
  const existing = {
    entrypoint: isRegularFile(paths.entrypoint),
    migration: migrationSetValid,
    manifest: isRegularFile(paths.manifest),
    lockfile: isRegularFile(paths.lockfile),
    license: isRegularFile(paths.license),
  };

  if (!existing.entrypoint) {
    addDiagnostic(diagnostics, 'missing-dist-entrypoint');
  }
  if (!migrationDirectoryExists) {
    addDiagnostic(diagnostics, 'missing-initial-migration');
  }
  if (!existing.manifest) {
    addDiagnostic(diagnostics, 'missing-package-manifest');
  }
  if (!existing.lockfile) {
    addDiagnostic(diagnostics, 'missing-lockfile');
  }
  if (!existing.license) {
    addDiagnostic(diagnostics, 'missing-license');
  }

  let pnpmMajor: string | undefined;
  let schemaContract: ReleaseSchemaContract | undefined;
  let packageVersion: string | undefined;
  if (existing.manifest) {
    const content = readRequiredTextFile(paths.manifest);
    if (content === undefined) {
      addDiagnostic(diagnostics, 'unreadable-package-manifest');
    } else {
      pnpmMajor = packageManagerMajor(content);
      if (pnpmMajor === undefined) {
        addDiagnostic(diagnostics, 'invalid-package-json');
      } else if (pnpmMajor === '') {
        addDiagnostic(diagnostics, 'invalid-package-manager');
      }
      if (pnpmMajor !== undefined) {
        const parsedPackage = JSON.parse(content) as Record<string, unknown>;
        if (!isSemanticVersion(parsedPackage.version)) {
          addDiagnostic(diagnostics, 'invalid-package-version');
        } else {
          packageVersion = parsedPackage.version;
        }
        schemaContract = parseReleaseSchemaContract(content);
        if (schemaContract === undefined) {
          addDiagnostic(diagnostics, 'invalid-schema-contract');
        }
      }
    }
  }

  if (existing.entrypoint) {
    const entrypointStatus = inspectEntrypoint(projectRoot, paths.entrypoint, packageVersion);
    if (entrypointStatus === 'unloadable') {
      addDiagnostic(diagnostics, 'unloadable-dist-entrypoint');
    } else if (entrypointStatus === 'version-mismatch') {
      addDiagnostic(diagnostics, 'dist-version-mismatch');
    }
  }

  let lockMajor: string | undefined;
  if (existing.lockfile) {
    const content = readRequiredTextFile(paths.lockfile);
    if (content === undefined) {
      addDiagnostic(diagnostics, 'unreadable-lockfile');
    } else {
      lockMajor = lockfileMajor(content);
      if (lockMajor === undefined) {
        addDiagnostic(diagnostics, 'invalid-lockfile-version');
      }
    }
  }

  if (pnpmMajor && lockMajor && !isPnpmLockfileCompatible(pnpmMajor, lockMajor)) {
    addDiagnostic(diagnostics, 'package-lock-version-incompatible');
  }

  return {
    ok: diagnostics.length === 0,
    checkedFileCount: Object.values(existing).filter(Boolean).length,
    diagnostics,
    ...(schemaContract === undefined ? {} : { schemaContract }),
  };
}

function main(): void {
  if (process.argv.length > 2) {
    process.stderr.write('Release preflight failed: unexpected arguments.\n');
    process.exitCode = 1;
    return;
  }

  const result = runReleasePreflight(process.cwd());
  if (result.ok) {
    process.stdout.write(
      'Release preflight passed: 5 required files; pnpm/lockfile, version, license, and schema contract valid.\n',
    );
    return;
  }

  process.stderr.write(`Release preflight failed: ${result.diagnostics.length} issue(s).\n`);
  for (const diagnostic of result.diagnostics.slice(0, MAX_CLI_DIAGNOSTICS)) {
    process.stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
