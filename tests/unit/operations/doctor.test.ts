import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  initDatabase,
  runMigration,
} from '../../../src/storage/database.js';
import {
  runOperationsDoctor,
  type OperationsDoctorConfig,
} from '../../../src/operations/doctor.js';

const migrationPath = join(process.cwd(), 'migrations/001_initial_schema.sql');

const config: OperationsDoctorConfig = {
  onebotTransport: 'ws',
  onebotHttpUrl: 'http://localhost:3000',
  onebotWsUrl: 'ws://localhost:3001/',
  onebotToken: undefined,
  onebotBotQqId: undefined,
  lethebotHost: '127.0.0.1',
  lethebotPort: 6700,
  lethebotHealthPath: '/healthz',
  lethebotReadinessPath: '/readyz',
  lethebotMetricsPath: '/metrics',
  lethebotEventPath: '/onebot/event',
  rawEventRetentionDays: 90,
  chatMessageRetentionDays: 0,
  auditLogRetentionDays: 0,
  disabledDeletedMemoryRetentionDays: 0,
  eventProcessingFailureRetentionDays: 0,
};

describe('Operations doctor owner', () => {
  let tempDir: string | undefined;
  let db: ReturnType<typeof initDatabase> | undefined;

  afterEach(() => {
    if (db?.open) {
      closeDatabase(db);
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('returns the fixed read-only projection without writes', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'lethebot-doctor-'));
    const dbPath = join(tempDir, 'doctor.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, migrationPath);
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const result = runOperationsDoctor(db, dbPath, config);

    expect(Object.keys(result)).toEqual([
      'generatedAt',
      'overall',
      'database',
      'schema',
      'counts',
      'configuration',
    ]);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(result.overall).toBe('ok');
    expect(result.database).toMatchObject({
      dbPath,
      open: true,
      readonly: true,
      integrityOk: true,
      integrityResult: 'ok',
      foreignKeyViolations: 0,
    });
    expect(result.schema.ready).toBe(true);
    expect(result.schema.missingTables).toEqual([]);
    expect(result.configuration.retentionDays).toEqual({
      rawEvents: 90,
      chatMessages: 0,
      auditLog: 0,
      disabledDeletedMemory: 0,
      eventProcessingFailures: 0,
    });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('reports an incomplete schema without changing the database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'lethebot-doctor-'));
    const dbPath = join(tempDir, 'doctor.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, migrationPath);
    db.exec('DROP TABLE event_ingress_receipts');
    const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

    const result = runOperationsDoctor(db, dbPath, config);

    expect(result.overall).toBe('attention_required');
    expect(result.schema.ready).toBe(false);
    expect(result.schema.missingTables).toContain('event_ingress_receipts');
    expect(result.counts.event_ingress_receipts).toBe(0);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
  });
});
