import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  type BigIntStats,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const REQUIRED_RELEASE_FILES = [
  'dist/index.js',
  'package.json',
  'pnpm-lock.yaml',
] as const;
const REQUIRED_RELEASE_DIRECTORIES = ['dist', 'migrations'] as const;

export class ManagedReleaseArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedReleaseArtifactError';
  }
}

export function calculateManagedReleaseDigest(releaseDir: string): string {
  const releaseStats = assertDirectory(releaseDir);
  const expectedUid = releaseStats.uid;
  assertTrustedEntry(releaseStats, expectedUid);
  for (const relativePath of REQUIRED_RELEASE_DIRECTORIES) {
    assertDirectory(join(releaseDir, relativePath), expectedUid);
  }
  for (const relativePath of REQUIRED_RELEASE_FILES) {
    assertRegularFile(join(releaseDir, relativePath), expectedUid);
  }

  const identity = [
    managedEntryIdentity(releaseDir),
    ...REQUIRED_RELEASE_DIRECTORIES.map((relativePath) => {
      return fingerprintManagedDirectory(join(releaseDir, relativePath), expectedUid);
    }),
    ...REQUIRED_RELEASE_FILES.map((relativePath) => {
      return fingerprintManagedFile(join(releaseDir, relativePath), expectedUid);
    }),
    fingerprintRuntimeDependencies(join(releaseDir, 'node_modules'), expectedUid),
  ].join('|');
  return createHash('sha256').update(identity).digest('hex');
}

export function managedReleaseMatches(releaseDir: string, expectedDigest: string): boolean {
  try {
    return calculateManagedReleaseDigest(releaseDir) === expectedDigest;
  } catch {
    return false;
  }
}

function managedEntryIdentity(path: string): string {
  const stats = lstatSync(path);
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function fingerprintManagedDirectory(rootDir: string, expectedUid: number): string {
  const hash = createHash('sha256');

  const visit = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      throw new ManagedReleaseArtifactError('Managed release directory is unreadable.', {
        cause: error,
      });
    }

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      let stats;
      try {
        stats = lstatSync(path);
      } catch (error) {
        throw new ManagedReleaseArtifactError('Managed release entry is unreadable.', {
          cause: error,
        });
      }
      assertTrustedEntry(stats, expectedUid);
      if (stats.isSymbolicLink()) {
        throw new ManagedReleaseArtifactError(
          'Managed release runtime artifacts must not contain symbolic links.',
        );
      }
      if (stats.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        visit(path, relativePath);
      } else if (stats.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(readFileSync(path));
        hash.update('\0');
      } else {
        throw new ManagedReleaseArtifactError(
          'Managed release runtime artifacts must contain only regular files and directories.',
        );
      }
    }
  };

  visit(rootDir, '');
  return hash.digest('hex');
}

function fingerprintManagedFile(path: string, expectedUid: number): string {
  try {
    assertTrustedEntry(lstatSync(path), expectedUid);
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    throw new ManagedReleaseArtifactError('Managed release file is unreadable.', {
      cause: error,
    });
  }
}

function fingerprintRuntimeDependencies(dependencyPath: string, expectedUid: number): string {
  let rootStats: BigIntStats;
  let canonicalRoot: string;
  let rootLink = '';
  try {
    rootStats = lstatSync(dependencyPath, { bigint: true });
    assertTrustedBigIntEntry(rootStats, expectedUid);
    if (rootStats.isSymbolicLink()) {
      rootLink = readlinkSync(dependencyPath);
    } else if (!rootStats.isDirectory()) {
      throw new Error('not a dependency directory');
    }
    canonicalRoot = realpathSync(dependencyPath);
    const canonicalStats = lstatSync(canonicalRoot);
    if (!canonicalStats.isDirectory()) {
      throw new Error('dependency target is not a directory');
    }
    assertTrustedEntry(canonicalStats, expectedUid);
  } catch (error) {
    throw new ManagedReleaseArtifactError(
      'Managed release runtime dependency tree is invalid or missing.',
      { cause: error },
    );
  }

  const hash = createHash('sha256');
  hash.update(`root\0${metadataIdentity(rootStats)}\0${rootLink}\0`);

  const visit = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      throw new ManagedReleaseArtifactError(
        'Managed release runtime dependency tree is unreadable.',
        { cause: error },
      );
    }

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      let stats: BigIntStats;
      try {
        stats = lstatSync(path, { bigint: true });
      } catch (error) {
        throw new ManagedReleaseArtifactError(
          'Managed release runtime dependency entry is unreadable.',
          { cause: error },
        );
      }
      assertTrustedBigIntEntry(stats, expectedUid);

      if (stats.isSymbolicLink()) {
        let linkTarget: string;
        let canonicalTarget: string;
        try {
          linkTarget = readlinkSync(path);
          canonicalTarget = realpathSync(path);
        } catch (error) {
          throw new ManagedReleaseArtifactError(
            'Managed release runtime dependency link is invalid.',
            { cause: error },
          );
        }
        const targetWithinRoot = relative(canonicalRoot, canonicalTarget);
        if (
          isAbsolute(targetWithinRoot)
          || targetWithinRoot === '..'
          || targetWithinRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        ) {
          throw new ManagedReleaseArtifactError(
            'Managed release runtime dependency links must stay inside the dependency tree.',
          );
        }
        hash.update(
          `link\0${relativePath}\0${metadataIdentity(stats)}\0${linkTarget}\0${targetWithinRoot}\0`,
        );
      } else if (stats.isDirectory()) {
        hash.update(`directory\0${relativePath}\0${metadataIdentity(stats)}\0`);
        visit(path, relativePath);
      } else if (stats.isFile()) {
        hash.update(`file\0${relativePath}\0${metadataIdentity(stats)}\0`);
      } else {
        throw new ManagedReleaseArtifactError(
          'Managed release runtime dependency tree contains an unsupported entry.',
        );
      }
    }
  };

  visit(canonicalRoot, '');
  return hash.digest('hex');
}

function metadataIdentity(stats: BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.uid,
    stats.gid,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(':');
}

function assertDirectory(path: string, expectedUid?: number): Stats {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('not a directory');
    }
    if (expectedUid !== undefined) {
      assertTrustedEntry(stats, expectedUid);
    }
    return stats;
  } catch (error) {
    throw new ManagedReleaseArtifactError('Managed release directory is invalid or missing.', {
      cause: error,
    });
  }
}

function assertRegularFile(path: string, expectedUid: number): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('not a regular file');
    }
    assertTrustedEntry(stats, expectedUid);
  } catch (error) {
    throw new ManagedReleaseArtifactError('Managed release file is invalid or missing.', {
      cause: error,
    });
  }
}

function assertTrustedEntry(stats: Stats, expectedUid: number): void {
  if (stats.uid !== expectedUid || (stats.mode & 0o022) !== 0) {
    throw new ManagedReleaseArtifactError(
      'Managed release runtime artifacts have unsafe ownership or permissions.',
    );
  }
}

function assertTrustedBigIntEntry(stats: BigIntStats, expectedUid: number): void {
  if (
    stats.uid !== BigInt(expectedUid)
    || (!stats.isSymbolicLink() && (stats.mode & 0o22n) !== 0n)
  ) {
    throw new ManagedReleaseArtifactError(
      'Managed release runtime artifacts have unsafe ownership or permissions.',
    );
  }
}
