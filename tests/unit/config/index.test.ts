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
    delete process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED;
    delete process.env.LETHEBOT_BOT_OWNER_QQ_ID;
    delete process.env.LETHEBOT_DB_PATH;
    delete process.env.LETHEBOT_RAW_EVENT_RETENTION_DAYS;
    delete process.env.LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS;
    delete process.env.LETHEBOT_AUDIT_LOG_RETENTION_DAYS;
    delete process.env.LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS;
    delete process.env.LETHEBOT_EVENT_PROCESSING_FAILURE_RETENTION_DAYS;
    delete process.env.PI_TURN_TIMEOUT_MS;
    delete process.env.EVALUATOR_PROVIDER;
    delete process.env.EVALUATOR_MODEL;
    delete process.env.EVALUATOR_BASE_URL;
    delete process.env.EVALUATOR_API_KEY;
    delete process.env.EVALUATOR_TIMEOUT_MS;
    delete process.env.EVALUATOR_MAX_RETRIES;
    delete process.env.EVALUATOR_TEMPERATURE;
    delete process.env.EVALUATOR_PROMPT_VERSION;
    delete process.env.LETHEBOT_READINESS_PATH;
    delete process.env.LETHEBOT_METRICS_PATH;

    const config = loadConfig();

    expect(config.logLevel).toBe('info');
    expect(config.test).toBe(false);
    expect(config.backgroundSummaryEnabled).toBe(false);
    expect(config.botOwnerQqId).toBeUndefined();
    expect(config.dbPath).toBe('./data/lethebot.db');
    expect(config.rawEventRetentionDays).toBe(90);
    expect(config.chatMessageRetentionDays).toBe(0);
    expect(config.auditLogRetentionDays).toBe(0);
    expect(config.disabledDeletedMemoryRetentionDays).toBe(0);
    expect(config.eventProcessingFailureRetentionDays).toBe(0);
    expect(config.piTurnTimeoutMs).toBe(120_000);
    expect(config.evaluatorProvider).toBeUndefined();
    expect(config.evaluatorModel).toBeUndefined();
    expect(config.evaluatorBaseUrl).toBeUndefined();
    expect(config.evaluatorApiKey).toBeUndefined();
    expect(config.evaluatorTimeoutMs).toBe(30_000);
    expect(config.evaluatorMaxRetries).toBe(1);
    expect(config.evaluatorTemperature).toBe(0);
    expect(config.evaluatorPromptVersion).toBe('lethebot-governance-v1');
    expect(config.lethebotReadinessPath).toBe('/readyz');
    expect(config.lethebotMetricsPath).toBe('/metrics');
  });

  test('loads config from env vars', () => {
    process.env.LOG_LEVEL = 'debug';
    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED = 'true';
    process.env.LETHEBOT_BOT_OWNER_QQ_ID = '123456789012';
    process.env.LETHEBOT_DB_PATH = '/custom/path/db.sqlite';
    process.env.LETHEBOT_RAW_EVENT_RETENTION_DAYS = '30';
    process.env.LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS = '60';
    process.env.LETHEBOT_AUDIT_LOG_RETENTION_DAYS = '90';
    process.env.LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS = '365';
    process.env.LETHEBOT_EVENT_PROCESSING_FAILURE_RETENTION_DAYS = '120';
    process.env.PI_TURN_TIMEOUT_MS = '45000';
    process.env.EVALUATOR_PROVIDER = 'anthropic';
    process.env.EVALUATOR_MODEL = 'claude-test';
    process.env.EVALUATOR_BASE_URL = 'https://evaluator.example.invalid/v1';
    process.env.EVALUATOR_API_KEY = 'test-only-evaluator-key';
    process.env.EVALUATOR_TIMEOUT_MS = '12345';
    process.env.EVALUATOR_MAX_RETRIES = '3';
    process.env.EVALUATOR_TEMPERATURE = '0.2';
    process.env.EVALUATOR_PROMPT_VERSION = 'governance-test-v2';
    process.env.LETHEBOT_READINESS_PATH = '/ops/ready';
    process.env.LETHEBOT_METRICS_PATH = '/ops/metrics';

    const config = loadConfig();

    expect(config.logLevel).toBe('debug');
    expect(config.test).toBe(true);
    expect(config.backgroundSummaryEnabled).toBe(true);
    expect(config.botOwnerQqId).toBe('123456789012');
    expect(config.dbPath).toBe('/custom/path/db.sqlite');
    expect(config.rawEventRetentionDays).toBe(30);
    expect(config.chatMessageRetentionDays).toBe(60);
    expect(config.auditLogRetentionDays).toBe(90);
    expect(config.disabledDeletedMemoryRetentionDays).toBe(365);
    expect(config.eventProcessingFailureRetentionDays).toBe(120);
    expect(config.piTurnTimeoutMs).toBe(45_000);
    expect(config.evaluatorProvider).toBe('anthropic');
    expect(config.evaluatorModel).toBe('claude-test');
    expect(config.evaluatorBaseUrl).toBe('https://evaluator.example.invalid/v1');
    expect(config.evaluatorApiKey).toBe('test-only-evaluator-key');
    expect(config.evaluatorTimeoutMs).toBe(12_345);
    expect(config.evaluatorMaxRetries).toBe(3);
    expect(config.evaluatorTemperature).toBe(0.2);
    expect(config.evaluatorPromptVersion).toBe('governance-test-v2');
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

  test('accepts an explicit disabled background-summary gate', () => {
    process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED = 'false';

    expect(loadConfig().backgroundSummaryEnabled).toBe(false);
  });

  test.each(['', '1', 'yes', 'TRUE', ' false '])(
    'rejects invalid background-summary boolean %j',
    (value) => {
      process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED = value;

      expect(() => loadConfig()).toThrow('Invalid configuration');
    },
  );

  test.each(['12345', '123456789012'])(
    'accepts bot-owner QQ id boundary %s',
    (value) => {
      process.env.LETHEBOT_BOT_OWNER_QQ_ID = value;

      expect(loadConfig().botOwnerQqId).toBe(value);
    },
  );

  test.each([
    '',
    '1234',
    '1234567890123',
    '01234',
    'qq:12345',
    ' 12345',
    '12345 ',
    '1234a',
  ])('rejects invalid bot-owner QQ id %j', (value) => {
    process.env.LETHEBOT_BOT_OWNER_QQ_ID = value;

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test.each([
    ['1', 1],
    ['2147483647', 2_147_483_647],
  ])('accepts Pi turn timeout boundary %s', (value, expected) => {
    process.env.PI_TURN_TIMEOUT_MS = value;

    expect(loadConfig().piTurnTimeoutMs).toBe(expected);
  });

  test.each([
    '',
    '0',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    '2147483648',
    '120000ms',
    'not-a-number',
  ])('rejects invalid Pi turn timeout %s', (value) => {
    process.env.PI_TURN_TIMEOUT_MS = value;

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test.each([
    ['EVALUATOR_TIMEOUT_MS', '0'],
    ['EVALUATOR_TIMEOUT_MS', '2147483648'],
    ['EVALUATOR_TIMEOUT_MS', '100ms'],
    ['EVALUATOR_MAX_RETRIES', '-1'],
    ['EVALUATOR_MAX_RETRIES', '1.5'],
    ['EVALUATOR_MAX_RETRIES', '11'],
    ['EVALUATOR_TEMPERATURE', '-0.1'],
    ['EVALUATOR_TEMPERATURE', '1.1'],
    ['EVALUATOR_TEMPERATURE', 'NaN'],
    ['EVALUATOR_BASE_URL', 'not-a-url'],
    ['EVALUATOR_PROMPT_VERSION', ''],
  ])('rejects invalid evaluator setting %s=%s', (key, value) => {
    process.env[key] = value;

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });
});
