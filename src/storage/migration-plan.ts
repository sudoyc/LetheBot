import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_FILE_PATTERN = /^(\d{3})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const MAX_MIGRATION_VERSION = 999;

export type MigrationPlanErrorCode =
  | 'invalid-migration-target'
  | 'invalid-migration-set';

export class MigrationPlanError extends Error {
  constructor(
    readonly code: MigrationPlanErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MigrationPlanError';
  }
}

export interface MigrationFile {
  version: number;
  description: string;
  fileName: string;
  path: string;
}

export function readMigrationPlan(
  migrationDirectory: string,
  targetVersion: number,
): MigrationFile[] {
  if (
    !Number.isSafeInteger(targetVersion)
    || targetVersion < 1
    || targetVersion > MAX_MIGRATION_VERSION
  ) {
    throw new MigrationPlanError(
      'invalid-migration-target',
      'Migration target version is invalid.',
    );
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(migrationDirectory, { withFileTypes: true });
  } catch (error) {
    throw new MigrationPlanError(
      'invalid-migration-set',
      'Migration directory is missing or unreadable.',
      { cause: error },
    );
  }

  const migrations: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.sql')) {
      continue;
    }

    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile()) {
      throwInvalidMigrationSet();
    }

    const version = Number(match[1]);
    const descriptionSlug = match[2];
    if (version < 1 || descriptionSlug === undefined) {
      throwInvalidMigrationSet();
    }

    migrations.push({
      version,
      description: toMigrationDescription(descriptionSlug),
      fileName: entry.name,
      path: join(migrationDirectory, entry.name),
    });
  }

  migrations.sort((left, right) => {
    return left.version - right.version || left.fileName.localeCompare(right.fileName);
  });

  if (migrations.length !== targetVersion) {
    throwInvalidMigrationSet();
  }
  for (let index = 0; index < migrations.length; index += 1) {
    if (migrations[index]?.version !== index + 1) {
      throwInvalidMigrationSet();
    }
  }

  return migrations;
}

function toMigrationDescription(slug: string): string {
  const description = slug.replaceAll('_', ' ');
  return `${description[0]?.toUpperCase() ?? ''}${description.slice(1)}`;
}

function throwInvalidMigrationSet(): never {
  throw new MigrationPlanError(
    'invalid-migration-set',
    'Migration files must form one contiguous sequence through the target version.',
  );
}
