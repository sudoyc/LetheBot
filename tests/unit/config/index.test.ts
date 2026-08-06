import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfig } from '../../../src/config/index.js';

describe('Config Loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LETHEBOT_WORKSPACE_ROOT;
    delete process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS;
    delete process.env.LETHEBOT_DISABLED_TOOLS;
    delete process.env.LETHEBOT_GOVERNANCE_ENABLED;
    delete process.env.LETHEBOT_GOVERNANCE_HOST;
    delete process.env.LETHEBOT_GOVERNANCE_PORT;
    delete process.env.LETHEBOT_GOVERNANCE_ADMIN_TOKEN;
    delete process.env.LETHEBOT_GOVERNANCE_SESSION_TTL_MS;
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
    delete process.env.PI_MAX_CONCURRENT_TURNS;
    delete process.env.PI_MAX_QUEUED_TURNS;
    delete process.env.EVALUATOR_PROVIDER;
    delete process.env.EVALUATOR_MODEL;
    delete process.env.EVALUATOR_BASE_URL;
    delete process.env.EVALUATOR_API_KEY;
    delete process.env.EVALUATOR_TIMEOUT_MS;
    delete process.env.EVALUATOR_MAX_RETRIES;
    delete process.env.EVALUATOR_TEMPERATURE;
    delete process.env.EVALUATOR_PROMPT_VERSION;
    delete process.env.ONEBOT_TRANSPORT;
    delete process.env.ONEBOT_TOKEN;
    delete process.env.LETHEBOT_HOST;
    delete process.env.LETHEBOT_REVERSE_HTTP_ENABLED;
    delete process.env.LETHEBOT_MAX_EVENT_BODY_BYTES;
    delete process.env.LETHEBOT_EVENT_BODY_TIMEOUT_MS;
    delete process.env.LETHEBOT_READINESS_PATH;
    delete process.env.LETHEBOT_METRICS_PATH;

    const config = loadConfig();

    expect(config.logLevel).toBe('info');
    expect(config.test).toBe(false);
    expect(config.backgroundSummaryEnabled).toBe(false);
    expect(config.botOwnerQqId).toBeUndefined();
    expect(config.dbPath).toBe('./data/lethebot.db');
    expect(config.rawEventRetentionDays).toBe(90);
    expect(config.chatMessageRetentionDays).toBe(90);
    expect(config.auditLogRetentionDays).toBe(365);
    expect(config.disabledDeletedMemoryRetentionDays).toBe(90);
    expect(config.eventProcessingFailureRetentionDays).toBe(90);
    expect(config.workspaceRoot).toBeUndefined();
    expect(config.webFetchAllowedOrigins).toEqual([]);
    expect(config.disabledTools).toEqual([]);
    expect(config.piTurnTimeoutMs).toBe(120_000);
    expect(config.piMaxConcurrentTurns).toBe(2);
    expect(config.piMaxQueuedTurns).toBe(128);
    expect(config.evaluatorProvider).toBeUndefined();
    expect(config.evaluatorModel).toBeUndefined();
    expect(config.evaluatorBaseUrl).toBeUndefined();
    expect(config.evaluatorApiKey).toBeUndefined();
    expect(config.evaluatorTimeoutMs).toBe(30_000);
    expect(config.evaluatorMaxRetries).toBe(1);
    expect(config.evaluatorTemperature).toBe(0);
    expect(config.evaluatorPromptVersion).toBe('lethebot-governance-v1');
    expect(config.onebotTransport).toBe('ws');
    expect(config.lethebotHost).toBe('127.0.0.1');
    expect(config.lethebotReverseHttpEnabled).toBe(false);
    expect(config.lethebotMaxEventBodyBytes).toBe(262_144);
    expect(config.lethebotEventBodyTimeoutMs).toBe(5_000);
    expect(config.lethebotReadinessPath).toBe('/readyz');
    expect(config.lethebotMetricsPath).toBe('/metrics');
    expect(config.governanceEnabled).toBe(false);
    expect(config.governanceHost).toBe('127.0.0.1');
    expect(config.governancePort).toBe(6701);
    expect(config.governanceAdminToken).toBeUndefined();
    expect(config.governanceSessionTtlMs).toBe(900_000);
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
    process.env.PI_MAX_CONCURRENT_TURNS = '7';
    process.env.PI_MAX_QUEUED_TURNS = '64';
    process.env.EVALUATOR_PROVIDER = 'anthropic';
    process.env.EVALUATOR_MODEL = 'claude-test';
    process.env.EVALUATOR_BASE_URL = 'https://evaluator.example.invalid/v1';
    process.env.EVALUATOR_API_KEY = 'test-only-evaluator-key';
    process.env.EVALUATOR_TIMEOUT_MS = '12345';
    process.env.EVALUATOR_MAX_RETRIES = '3';
    process.env.EVALUATOR_TEMPERATURE = '0.2';
    process.env.EVALUATOR_PROMPT_VERSION = 'governance-test-v2';
    process.env.LETHEBOT_MAX_EVENT_BODY_BYTES = '1048576';
    process.env.LETHEBOT_EVENT_BODY_TIMEOUT_MS = '2500';
    process.env.LETHEBOT_READINESS_PATH = '/ops/ready';
    process.env.LETHEBOT_METRICS_PATH = '/ops/metrics';
    process.env.LETHEBOT_WORKSPACE_ROOT = '/tmp/lethebot-synthetic-workspace';
    process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS =
      'https://docs.example.invalid, https://api.example.invalid:8443/';
    process.env.LETHEBOT_DISABLED_TOOLS = 'memory.search, runtime.tools';
    process.env.LETHEBOT_GOVERNANCE_ENABLED = 'true';
    process.env.LETHEBOT_GOVERNANCE_HOST = '::1';
    process.env.LETHEBOT_GOVERNANCE_PORT = '16701';
    process.env.LETHEBOT_GOVERNANCE_ADMIN_TOKEN = 'synthetic-governance-admin-token-0001';
    process.env.LETHEBOT_GOVERNANCE_SESSION_TTL_MS = '60000';

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
    expect(config.workspaceRoot).toBe('/tmp/lethebot-synthetic-workspace');
    expect(config.webFetchAllowedOrigins).toEqual([
      'https://docs.example.invalid',
      'https://api.example.invalid:8443',
    ]);
    expect(config.disabledTools).toEqual(['memory.search', 'runtime.tools']);
    expect(config.piTurnTimeoutMs).toBe(45_000);
    expect(config.piMaxConcurrentTurns).toBe(7);
    expect(config.piMaxQueuedTurns).toBe(64);
    expect(config.evaluatorProvider).toBe('anthropic');
    expect(config.evaluatorModel).toBe('claude-test');
    expect(config.evaluatorBaseUrl).toBe('https://evaluator.example.invalid/v1');
    expect(config.evaluatorApiKey).toBe('test-only-evaluator-key');
    expect(config.evaluatorTimeoutMs).toBe(12_345);
    expect(config.evaluatorMaxRetries).toBe(3);
    expect(config.evaluatorTemperature).toBe(0.2);
    expect(config.evaluatorPromptVersion).toBe('governance-test-v2');
    expect(config.lethebotMaxEventBodyBytes).toBe(1_048_576);
    expect(config.lethebotEventBodyTimeoutMs).toBe(2_500);
    expect(config.lethebotReadinessPath).toBe('/ops/ready');
    expect(config.lethebotMetricsPath).toBe('/ops/metrics');
    expect(config.governanceEnabled).toBe(true);
    expect(config.governanceHost).toBe('::1');
    expect(config.governancePort).toBe(16_701);
    expect(config.governanceAdminToken).toBe('synthetic-governance-admin-token-0001');
    expect(config.governanceSessionTtlMs).toBe(60_000);
  });

  test.each(['', 'relative/workspace', './workspace']) (
    'rejects invalid workspace root %j',
    (value) => {
      process.env.LETHEBOT_WORKSPACE_ROOT = value;

      expect(() => loadConfig()).toThrow('Invalid configuration');
    },
  );

  test('treats an empty web fetch origin list as disabled', () => {
    process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS = '   ';

    expect(loadConfig().webFetchAllowedOrigins).toEqual([]);
  });

  test('treats an empty disabled-tool list as no disabled tools', () => {
    process.env.LETHEBOT_DISABLED_TOOLS = '   ';

    expect(loadConfig().disabledTools).toEqual([]);
  });

  test('accepts known optional tools even when their registration prerequisites are absent', () => {
    process.env.LETHEBOT_DISABLED_TOOLS = 'workspace.list, web.fetch_text';

    expect(loadConfig().disabledTools).toEqual(['workspace.list', 'web.fetch_text']);
  });

  test.each([
    ',memory.search',
    'memory.search,',
    'memory.search,,runtime.tools',
    'memory.search,memory.search',
    'memory\tsearch',
    'not.a.reviewed.tool',
  ])('rejects invalid disabled-tool configuration %j', (value) => {
    process.env.LETHEBOT_DISABLED_TOOLS = value;

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test.each([
    'http://docs.example.invalid',
    'https://docs.example.invalid/path',
    'https://user@docs.example.invalid',
    'https://docs.example.invalid?query=value',
    'https://docs.example.invalid#fragment',
    'https://*.example.invalid',
    'https://docs.example.invalid,https://docs.example.invalid/',
    Array.from(
      { length: 17 },
      (_, index) => `https://origin-${index}.example.invalid`,
    ).join(','),
  ])('rejects invalid web fetch exact-origin configuration %j', (value) => {
    process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS = value;

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test('rejects tokenless non-loopback reverse HTTP ingress', () => {
    process.env.ONEBOT_TRANSPORT = 'http';
    process.env.LETHEBOT_HOST = '0.0.0.0';
    delete process.env.ONEBOT_TOKEN;

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test('allows explicitly selected tokenless reverse HTTP ingress on loopback', () => {
    process.env.ONEBOT_TRANSPORT = 'http';
    process.env.LETHEBOT_HOST = '127.0.0.1';
    delete process.env.ONEBOT_TOKEN;

    expect(loadConfig().onebotTransport).toBe('http');
  });

  test('allows token-authenticated non-loopback reverse HTTP ingress', () => {
    process.env.ONEBOT_TRANSPORT = 'http';
    process.env.LETHEBOT_HOST = '0.0.0.0';
    process.env.ONEBOT_TOKEN = 'synthetic-event-token';

    expect(loadConfig().lethebotHost).toBe('0.0.0.0');
  });

  test('allows tokenless non-loopback bind when WebSocket mode leaves reverse HTTP disabled', () => {
    process.env.ONEBOT_TRANSPORT = 'ws';
    process.env.LETHEBOT_HOST = '0.0.0.0';
    delete process.env.ONEBOT_TOKEN;
    delete process.env.LETHEBOT_REVERSE_HTTP_ENABLED;

    const config = loadConfig();

    expect(config.lethebotHost).toBe('0.0.0.0');
    expect(config.lethebotReverseHttpEnabled).toBe(false);
  });

  test('rejects tokenless non-loopback explicitly enabled reverse HTTP ingress', () => {
    process.env.ONEBOT_TRANSPORT = 'ws';
    process.env.LETHEBOT_HOST = '0.0.0.0';
    process.env.LETHEBOT_REVERSE_HTTP_ENABLED = 'true';
    delete process.env.ONEBOT_TOKEN;

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test('loads an explicit reverse HTTP ingress enable flag', () => {
    process.env.ONEBOT_TRANSPORT = 'ws';
    process.env.LETHEBOT_REVERSE_HTTP_ENABLED = 'true';

    expect(loadConfig().lethebotReverseHttpEnabled).toBe(true);
  });

  test.each(['', '1', 'yes', 'TRUE', ' false '])(
    'rejects invalid reverse HTTP enable boolean %j',
    (value) => {
      process.env.LETHEBOT_REVERSE_HTTP_ENABLED = value;

      expect(() => loadConfig()).toThrow('Invalid configuration');
    },
  );

  test.each([
    ['LETHEBOT_MAX_EVENT_BODY_BYTES', '0'],
    ['LETHEBOT_MAX_EVENT_BODY_BYTES', '-1'],
    ['LETHEBOT_MAX_EVENT_BODY_BYTES', '1.5'],
    ['LETHEBOT_MAX_EVENT_BODY_BYTES', '2147483648'],
    ['LETHEBOT_EVENT_BODY_TIMEOUT_MS', '0'],
    ['LETHEBOT_EVENT_BODY_TIMEOUT_MS', '-1'],
    ['LETHEBOT_EVENT_BODY_TIMEOUT_MS', '1.5'],
    ['LETHEBOT_EVENT_BODY_TIMEOUT_MS', '2147483648'],
  ])('rejects invalid event request bound %s=%s', (name, value) => {
    process.env[name] = value;

    expect(() => loadConfig()).toThrow('Invalid configuration');
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
    ['1', 1],
    ['16', 16],
  ])('accepts Pi concurrency boundary %s', (value, expected) => {
    process.env.PI_MAX_CONCURRENT_TURNS = value;

    expect(loadConfig().piMaxConcurrentTurns).toBe(expected);
  });

  test.each([
    '',
    '0',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    '17',
    '2turns',
  ])('rejects invalid Pi concurrency %s', (value) => {
    process.env.PI_MAX_CONCURRENT_TURNS = value;

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test.each([
    ['0', 0],
    ['128', 128],
  ])('accepts Pi queue boundary %s', (value, expected) => {
    process.env.PI_MAX_QUEUED_TURNS = value;

    expect(loadConfig().piMaxQueuedTurns).toBe(expected);
  });

  test.each([
    '',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    '129',
    '128turns',
  ])('rejects invalid Pi queue limit %s', (value) => {
    process.env.PI_MAX_QUEUED_TURNS = value;

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

  test('requires a bounded admin token only when governance HTTP is enabled', () => {
    expect(loadConfig().governanceAdminToken).toBeUndefined();

    resetConfig();
    process.env.LETHEBOT_GOVERNANCE_ENABLED = 'true';
    expect(() => loadConfig()).toThrow('Invalid configuration');

    resetConfig();
    process.env.LETHEBOT_GOVERNANCE_ADMIN_TOKEN = 'g'.repeat(32);
    expect(loadConfig().governanceEnabled).toBe(true);
  });

  test.each(['', '1', 'yes', 'TRUE', ' false '])(
    'rejects invalid governance enable boolean %j',
    (value) => {
      process.env.LETHEBOT_GOVERNANCE_ENABLED = value;

      expect(() => loadConfig()).toThrow('Invalid configuration');
    },
  );

  test.each(['localhost', '0.0.0.0', '127.0.0.2', '::ffff:127.0.0.1'])(
    'rejects non-exact governance loopback host %j',
    (value) => {
      process.env.LETHEBOT_GOVERNANCE_HOST = value;

      expect(() => loadConfig()).toThrow('Invalid configuration');
    },
  );

  test.each([
    ['1', 1],
    ['65535', 65_535],
  ])('accepts governance port boundary %s', (value, expected) => {
    process.env.LETHEBOT_GOVERNANCE_PORT = value;

    expect(loadConfig().governancePort).toBe(expected);
  });

  test.each(['', '0', '65536', '1.5', '6701port'])(
    'rejects invalid governance port %j',
    (value) => {
      process.env.LETHEBOT_GOVERNANCE_PORT = value;

      expect(() => loadConfig()).toThrow('Invalid configuration');
    },
  );

  test.each([
    ['60000', 60_000],
    ['3600000', 3_600_000],
  ])('accepts governance session TTL boundary %s', (value, expected) => {
    process.env.LETHEBOT_GOVERNANCE_SESSION_TTL_MS = value;

    expect(loadConfig().governanceSessionTtlMs).toBe(expected);
  });

  test.each(['', '59999', '3600001', '1.5', '900000ms'])(
    'rejects invalid governance session TTL %j',
    (value) => {
      process.env.LETHEBOT_GOVERNANCE_SESSION_TTL_MS = value;

      expect(() => loadConfig()).toThrow('Invalid configuration');
    },
  );

  test.each([
    'g'.repeat(31),
    'g'.repeat(513),
    `${'g'.repeat(31)}\n`,
  ])('rejects invalid enabled governance admin token without reflecting it', (value) => {
    process.env.LETHEBOT_GOVERNANCE_ENABLED = 'true';
    process.env.LETHEBOT_GOVERNANCE_ADMIN_TOKEN = value;

    let diagnostic = '';
    try {
      loadConfig();
    } catch (error) {
      diagnostic = JSON.stringify(error);
    }
    expect(diagnostic).not.toContain(value);
    expect(diagnostic).toContain('governanceAdminToken');
  });

  test('measures governance admin token limits as UTF-8 bytes', () => {
    process.env.LETHEBOT_GOVERNANCE_ENABLED = 'true';
    process.env.LETHEBOT_GOVERNANCE_ADMIN_TOKEN = '\u754c'.repeat(11);

    expect(loadConfig().governanceAdminToken).toBe('\u754c'.repeat(11));
  });

  test('rejects an enabled governance listener that collides with the application port', () => {
    process.env.LETHEBOT_GOVERNANCE_ENABLED = 'true';
    process.env.LETHEBOT_GOVERNANCE_ADMIN_TOKEN = 'g'.repeat(32);
    process.env.LETHEBOT_PORT = '16701';
    process.env.LETHEBOT_GOVERNANCE_PORT = '16701';

    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  test('allows the disabled governance port to equal the application port', () => {
    process.env.LETHEBOT_PORT = '16701';
    process.env.LETHEBOT_GOVERNANCE_PORT = '16701';

    expect(loadConfig().governanceEnabled).toBe(false);
  });
});
