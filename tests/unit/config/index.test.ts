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

    const config = loadConfig();

    expect(config.logLevel).toBe('info');
    expect(config.test).toBe(false);
    expect(config.dbPath).toBe('./data/lethebot.db');
    expect(config.rawEventRetentionDays).toBe(90);
  });

  test('loads config from env vars', () => {
    process.env.LOG_LEVEL = 'debug';
    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_DB_PATH = '/custom/path/db.sqlite';
    process.env.LETHEBOT_RAW_EVENT_RETENTION_DAYS = '30';

    const config = loadConfig();

    expect(config.logLevel).toBe('debug');
    expect(config.test).toBe(true);
    expect(config.dbPath).toBe('/custom/path/db.sqlite');
    expect(config.rawEventRetentionDays).toBe(30);
  });

  test('validates logLevel enum', () => {
    process.env.LOG_LEVEL = 'invalid';

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test('validates rawEventRetentionDays is non-negative', () => {
    process.env.LETHEBOT_RAW_EVENT_RETENTION_DAYS = '-1';

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });
});
