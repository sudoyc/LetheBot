import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MigrationPlanError,
  readMigrationPlan,
} from '../../../src/storage/migration-plan.js';
import {
  closeDatabase,
  getSchemaVersion,
  initDatabase,
  runMigration,
  runMigrations,
} from '../../../src/storage/database.js';

const temporaryRoots: string[] = [];

function createMigrationDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-migration-plan-'));
  temporaryRoots.push(root);
  const migrationDirectory = join(root, 'migrations');
  mkdirSync(migrationDirectory);
  return migrationDirectory;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('migration plan', () => {
  it('loads one ordered migration per version through the target', () => {
    const migrationDirectory = createMigrationDirectory();
    writeFileSync(join(migrationDirectory, '002_add_index.sql'), 'SELECT 2;\n', 'utf8');
    writeFileSync(join(migrationDirectory, '001_initial_schema.sql'), 'SELECT 1;\n', 'utf8');
    writeFileSync(join(migrationDirectory, 'README.md'), 'operator notes\n', 'utf8');

    expect(readMigrationPlan(migrationDirectory, 2)).toEqual([
      {
        version: 1,
        description: 'Initial schema',
        fileName: '001_initial_schema.sql',
        path: join(migrationDirectory, '001_initial_schema.sql'),
      },
      {
        version: 2,
        description: 'Add index',
        fileName: '002_add_index.sql',
        path: join(migrationDirectory, '002_add_index.sql'),
      },
    ]);
  });

  it.each([
    ['a missing version', ['001_initial_schema.sql', '003_gap.sql'], 3],
    ['a duplicate version', ['001_first.sql', '001_second.sql'], 1],
    ['a malformed SQL filename', ['001_initial_schema.sql', 'migration.sql'], 1],
    ['a migration beyond the target', ['001_initial_schema.sql', '002_future.sql'], 1],
  ])('rejects %s before a migration can run', (_label, fileNames, targetVersion) => {
    const migrationDirectory = createMigrationDirectory();
    for (const fileName of fileNames) {
      writeFileSync(join(migrationDirectory, fileName), 'SELECT 1;\n', 'utf8');
    }

    expect(() => readMigrationPlan(migrationDirectory, targetVersion)).toThrowError(
      expect.objectContaining<Partial<MigrationPlanError>>({
        name: 'MigrationPlanError',
        code: 'invalid-migration-set',
      }),
    );
  });

  it.each([0, 1.5, 1_000])('rejects invalid target version %s', (targetVersion) => {
    const migrationDirectory = createMigrationDirectory();

    expect(() => readMigrationPlan(migrationDirectory, targetVersion)).toThrowError(
      expect.objectContaining<Partial<MigrationPlanError>>({
        name: 'MigrationPlanError',
        code: 'invalid-migration-target',
      }),
    );
  });
});

describe('runMigrations', () => {
  it('normalizes v1 before applying all later versions and then performs a zero-write validation pass', () => {
    const db = initDatabase({ path: ':memory:' });
    try {
      const migrationDirectory = join(process.cwd(), 'migrations');
      runMigration(db, join(migrationDirectory, '001_initial_schema.sql'));
      const appliedAt = db.prepare(
        'SELECT applied_at FROM schema_version WHERE version = 1',
      ).pluck().get();
      db.exec('DROP TABLE event_processing_admissions');

      runMigrations(db, migrationDirectory);

      expect(getSchemaVersion(db)).toBe(6);
      expect(db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'event_processing_admissions'",
      ).get()).toEqual({ name: 'event_processing_admissions' });
      expect(db.prepare(
        'SELECT applied_at FROM schema_version WHERE version = 1',
      ).pluck().get()).toBe(appliedAt);
      const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

      runMigrations(db, migrationDirectory);

      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    } finally {
      closeDatabase(db);
    }
  });

  it('validates the complete migration set before changing the database', () => {
    const migrationDirectory = createMigrationDirectory();
    copyFileSync(
      join(process.cwd(), 'migrations/001_initial_schema.sql'),
      join(migrationDirectory, '001_initial_schema.sql'),
    );
    writeFileSync(join(migrationDirectory, '006_future.sql'), 'CREATE TABLE future_write (id TEXT);\n');
    const db = initDatabase({ path: ':memory:' });
    try {
      db.exec('CREATE TABLE preserved_sentinel (value TEXT)');

      expect(() => runMigrations(db, migrationDirectory)).toThrowError(
        expect.objectContaining<Partial<MigrationPlanError>>({
          code: 'invalid-migration-set',
        }),
      );

      expect(getSchemaVersion(db)).toBe(0);
      expect(db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).all()).toEqual([{ name: 'preserved_sentinel' }]);
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects a target other than the compiled schema version before changing the database', () => {
    const db = initDatabase({ path: ':memory:' });
    try {
      expect(() => runMigrations(db, join(process.cwd(), 'migrations'), 1)).toThrow(RangeError);
      expect(getSchemaVersion(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});
