import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfig } from '../../../src/config/index.js';

describe('Config Loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  test('loads default config when no env vars set', () => {
    delete process.env.LOG_LEVEL;
    delete process.env.LETHEBOT_TEST;
    delete process.env.LETHEBOT_DB_PATH;
    delete process.env.LETHEBOT_RAW_EVENT_RETENTION_DAYS;
    delete process.env.LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS;
    delete process.env.LETHEBOT_AUDIT_LOG_RETENTION_DAYS;
    delete process.env.LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS;
    delete process.env.LETHEBOT_EVENT_PROCESSING_FAILURE_RETENTION_DAYS;
    delete process.env.LETHEBOT_READINESS_PATH;
    delete process.env.LETHEBOT_METRICS_PATH;

    const config = loadConfig();

    expect(config.logLevel).toBe('info');
    expect(config.test).toBe(false);
    expect(config.dbPath).toBe('./data/lethebot.db');
    expect(config.rawEventRetentionDays).toBe(90);
    expect(config.chatMessageRetentionDays).toBe(0);
    expect(config.auditLogRetentionDays).toBe(0);
    expect(config.disabledDeletedMemoryRetentionDays).toBe(0);
    expect(config.eventProcessingFailureRetentionDays).toBe(0);
    expect(config.lethebotReadinessPath).toBe('/readyz');
    expect(config.lethebotMetricsPath).toBe('/metrics');
  });

  test('loads config from env vars', () => {
    process.env.LOG_LEVEL = 'debug';
    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_DB_PATH = '/custom/path/db.sqlite';
    process.env.LETHEBOT_RAW_EVENT_RETENTION_DAYS = '30';
    process.env.LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS = '60';
    process.env.LETHEBOT_AUDIT_LOG_RETENTION_DAYS = '90';
    process.env.LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS = '365';
    process.env.LETHEBOT_EVENT_PROCESSING_FAILURE_RETENTION_DAYS = '120';
    process.env.LETHEBOT_READINESS_PATH = '/ops/ready';
    process.env.LETHEBOT_METRICS_PATH = '/ops/metrics';

    const config = loadConfig();

    expect(config.logLevel).toBe('debug');
    expect(config.test).toBe(true);
    expect(config.dbPath).toBe('/custom/path/db.sqlite');
    expect(config.rawEventRetentionDays).toBe(30);
    expect(config.chatMessageRetentionDays).toBe(60);
    expect(config.auditLogRetentionDays).toBe(90);
    expect(config.disabledDeletedMemoryRetentionDays).toBe(365);
    expect(config.eventProcessingFailureRetentionDays).toBe(120);
    expect(config.lethebotReadinessPath).toBe('/ops/ready');
    expect(config.lethebotMetricsPath).toBe('/ops/metrics');
  });

  test('validates logLevel enum', () => {
    process.env.LOG_LEVEL = 'invalid';

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test('validates rawEventRetentionDays is non-negative', () => {
    process.env.LETHEBOT_RAW_EVENT_RETENTION_DAYS = '-1';

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test('validates retention days are non-negative', () => {
    process.env.LETHEBOT_AUDIT_LOG_RETENTION_DAYS = '-1';

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });
});
