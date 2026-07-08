import { describe, test, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { getLogger, redactingLogHooks, sanitizeLogValueForOutput } from '../../../src/logger/index.js';

describe('Logger', () => {
  test('getLogger returns a logger instance', () => {
    const logger = getLogger();

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  test('logger can log messages', () => {
    const logger = getLogger();

    // Should not throw
    expect(() => {
      logger.info('test message');
      logger.debug({ foo: 'bar' }, 'test object');
    }).not.toThrow();
  });

  test('sanitizeLogValueForOutput redacts secret-like and platform identifiers recursively', () => {
    const rawSecret = 'sk-logger-redaction-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';

    const sanitized = sanitizeLogValueForOutput({
      conversationId: `private:${rawPlatformId}`,
      nested: {
        message: `api_key=${rawSecret}`,
        senderId: rawPlatformId,
        onebot: {
          user_id: 1234567890,
        },
      },
      list: [`target=${rawPlatformId}`],
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain('[REDACTED:api_key_assignment]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawPlatformId);
    expect(serialized).not.toContain('1234567890');
  });

  test('sanitizeLogValueForOutput redacts numeric platform identifiers in plural ID arrays', () => {
    const sanitized = sanitizeLogValueForOutput({
      senderIds: [1234567890],
      group_ids: [2345678901],
      nested: {
        platformIds: [3456789012],
      },
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain('1234567890');
    expect(serialized).not.toContain('2345678901');
    expect(serialized).not.toContain('3456789012');
  });

  test('sanitizeLogValueForOutput redacts numeric platform identifiers in prefixed ID fields', () => {
    const sanitized = sanitizeLogValueForOutput({
      targetUserId: 1234567890,
      recipientGroupIds: [2345678901],
      nested: {
        ownerMessageId: 3456789012,
        processedCount: 9876543210,
      },
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).toContain('9876543210');
    expect(serialized).not.toContain('1234567890');
    expect(serialized).not.toContain('2345678901');
    expect(serialized).not.toContain('3456789012');
  });

  test('sanitizeLogValueForOutput redacts embedded platform identifiers after non-alphanumeric separators', () => {
    const embeddedPrefixedPlatformId = 'legacy_qq-1234567890';
    const embeddedNumericPlatformId = 'legacy_987654321';

    const sanitized = sanitizeLogValueForOutput({
      diagnostic: `adapter=${embeddedPrefixedPlatformId}`,
      nested: {
        message: `sender=${embeddedNumericPlatformId}`,
      },
      list: [`targets=${embeddedPrefixedPlatformId}+${embeddedNumericPlatformId}`],
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(embeddedPrefixedPlatformId);
    expect(serialized).not.toContain(embeddedNumericPlatformId);
    expect(serialized).not.toContain('legacy_qq-');
    expect(serialized).not.toContain('1234567890');
    expect(serialized).not.toContain('987654321');
  });

  test('sanitizeLogValueForOutput redacts Error message and suppresses stack details', () => {
    const rawSecret = 'sk-logger-error-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';
    const error = new Error(`boom api_key=${rawSecret} target=${rawPlatformId}`);
    error.stack = [
      `Error: boom api_key=${rawSecret}`,
      `    at target (/home/operator/LetheBot/src/index.ts:10:5)`,
      `    at dependency (/home/operator/LetheBot/node_modules/example/index.js:1:1)`,
      `    at platform (${rawPlatformId})`,
    ].join('\n');

    const sanitized = sanitizeLogValueForOutput(error) as {
      message: string;
      stack: string;
      name: string;
    };

    expect(sanitized.name).toBe('Error');
    expect(sanitized.message).toContain('[REDACTED:api_key_assignment]');
    expect(sanitized.message).toContain('[REDACTED:platform_id]');
    expect(sanitized.stack).toBe('[REDACTED:stack]');
    expect(JSON.stringify(sanitized)).not.toContain(rawSecret);
    expect(JSON.stringify(sanitized)).not.toContain(rawPlatformId);
    expect(JSON.stringify(sanitized)).not.toContain('/home/operator');
    expect(JSON.stringify(sanitized)).not.toContain('src/index.ts');
    expect(JSON.stringify(sanitized)).not.toContain('node_modules');
    expect(JSON.stringify(sanitized)).not.toContain('    at ');
  });

  test('sanitizeLogValueForOutput suppresses plain structured stack fields', () => {
    const rawSecret = 'sk-logger-plain-stack-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';

    const sanitized = sanitizeLogValueForOutput({
      error: {
        message: `plain api_key=${rawSecret} target=${rawPlatformId}`,
        stack: [
          `Error: plain api_key=${rawSecret}`,
          `    at handler (/home/operator/LetheBot/src/workers/summary-worker.ts:20:5)`,
          `    at dependency (/home/operator/LetheBot/node_modules/example/index.js:1:1)`,
          `    at platform (${rawPlatformId})`,
        ].join('\n'),
        name: `Legacy_${rawPlatformId}`,
      },
    }) as { error: { message: string; stack: string; name: string } };

    expect(sanitized.error.message).toContain('[REDACTED:api_key_assignment]');
    expect(sanitized.error.message).toContain('[REDACTED:platform_id]');
    expect(sanitized.error.stack).toBe('[REDACTED:stack]');
    expect(sanitized.error.name).toContain('[REDACTED:platform_id]');
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawPlatformId);
    expect(serialized).not.toContain('/home/operator');
    expect(serialized).not.toContain('summary-worker.ts');
    expect(serialized).not.toContain('node_modules');
    expect(serialized).not.toContain('    at ');
  });

  test('redactingLogHooks suppress plain structured stack fields before write', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ base: null, timestamp: false, hooks: redactingLogHooks }, stream);
    const rawSecret = 'sk-logger-hook-plain-stack-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';

    logger.error({
      error: {
        message: `plain hook api_key=${rawSecret} target=${rawPlatformId}`,
        stack: [
          `Error: plain hook api_key=${rawSecret}`,
          `    at handler (/home/operator/LetheBot/src/workers/summary-worker.ts:20:5)`,
          `    at dependency (/home/operator/LetheBot/node_modules/example/index.js:1:1)`,
          `    at platform (${rawPlatformId})`,
        ].join('\n'),
        name: `Legacy_${rawPlatformId}`,
      },
    }, 'runtime failure');

    const output = lines.join('');
    expect(output).toContain('[REDACTED:api_key_assignment]');
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).toContain('[REDACTED:stack]');
    expect(output).not.toContain(rawSecret);
    expect(output).not.toContain(rawPlatformId);
    expect(output).not.toContain('/home/operator');
    expect(output).not.toContain('summary-worker.ts');
    expect(output).not.toContain('node_modules');
    expect(output).not.toContain('    at ');
  });

  test('redactingLogHooks redact actual structured log output before write', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ base: null, timestamp: false, hooks: redactingLogHooks }, stream);
    const rawSecret = 'sk-logger-hook-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';

    logger.info(
      {
        conversationId: `private:${rawPlatformId}`,
        event: {
          raw_message: `api_key=${rawSecret}`,
          user_id: 1234567890,
        },
      },
      `received from ${rawPlatformId}`,
    );

    const output = lines.join('');
    expect(output).toContain('[REDACTED:api_key_assignment]');
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).not.toContain(rawSecret);
    expect(output).not.toContain(rawPlatformId);
    expect(output).not.toContain('1234567890');
  });

  test('redactingLogHooks redact embedded platform identifiers before write', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ base: null, timestamp: false, hooks: redactingLogHooks }, stream);
    const embeddedPrefixedPlatformId = 'legacy_qq-1234567890';
    const embeddedNumericPlatformId = 'legacy_987654321';

    logger.warn(
      {
        diagnostic: `adapter=${embeddedPrefixedPlatformId}`,
        event: {
          stage: `sender=${embeddedNumericPlatformId}`,
        },
      },
      `received from ${embeddedPrefixedPlatformId}+${embeddedNumericPlatformId}`,
    );

    const output = lines.join('');
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).not.toContain(embeddedPrefixedPlatformId);
    expect(output).not.toContain(embeddedNumericPlatformId);
    expect(output).not.toContain('legacy_qq-');
    expect(output).not.toContain('1234567890');
    expect(output).not.toContain('987654321');
  });

  test('redactingLogHooks preserve platform markers for adjacent secret/platform text before write', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ base: null, timestamp: false, hooks: redactingLogHooks }, stream);
    const adjacentSecretPlatform =
      'sk-logger-adjacent-secret-should-not-persist-qq-12345678911';
    const error = new Error(`runtime ${adjacentSecretPlatform}`);

    const sanitized = sanitizeLogValueForOutput({
      message: `message ${adjacentSecretPlatform}`,
      nested: {
        [`diagnostic ${adjacentSecretPlatform}`]: 'key-value',
      },
      error,
    });

    logger.error(
      {
        message: `hook ${adjacentSecretPlatform}`,
        nested: {
          [`hook diagnostic ${adjacentSecretPlatform}`]: 'key-value',
        },
        error,
      },
      `runtime failure ${adjacentSecretPlatform}`,
    );

    const serialized = `${JSON.stringify(sanitized)}\n${lines.join('')}`;
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain('sk-logger-adjacent');
    expect(serialized).not.toContain('qq-12345678911');
    expect(serialized).not.toContain('12345678911');
  });

  test('redactingLogHooks preserve platform markers for assignment-shaped adjacent secret/platform text before write', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ base: null, timestamp: false, hooks: redactingLogHooks }, stream);
    const adjacentAssignment = 'api_key=sk-logger-assignment-secret-qq-12345678911';
    const error = new Error(`runtime ${adjacentAssignment}`);

    const sanitized = sanitizeLogValueForOutput({
      message: `message ${adjacentAssignment}`,
      nested: {
        [`diagnostic ${adjacentAssignment}`]: adjacentAssignment,
      },
      error,
    });

    logger.error(
      {
        message: `hook ${adjacentAssignment}`,
        nested: {
          [`hook diagnostic ${adjacentAssignment}`]: adjacentAssignment,
        },
        error,
      },
      `runtime failure ${adjacentAssignment}`,
    );

    const serialized = `${JSON.stringify(sanitized)}\n${lines.join('')}`;
    expect(serialized).toContain('[REDACTED:api_key_assignment]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-logger-assignment');
    expect(serialized).not.toContain('qq-12345678911');
    expect(serialized).not.toContain('12345678911');
  });

  test('redactingLogHooks redact dynamic object keys before write', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ base: null, timestamp: false, hooks: redactingLogHooks }, stream);
    const rawSecretKey = 'metric_sk-logger-dynamic-key-secret-should-not-persist';
    const rawPlatformKey = 'legacy_qq-1234567890';

    logger.info({
      dynamic: {
        [rawSecretKey]: 'secret-key-as-property-name',
        [rawPlatformKey]: {
          count: 1,
        },
      },
    }, 'dynamic diagnostic keys');

    const output = lines.join('');
    expect(output).toContain('[REDACTED:openai_like_api_key]');
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).not.toContain(rawSecretKey);
    expect(output).not.toContain(rawPlatformKey);
    expect(output).not.toContain('sk-logger-dynamic-key-secret-should-not-persist');
    expect(output).not.toContain('legacy_qq-');
    expect(output).not.toContain('1234567890');
  });

  test('redactingLogHooks suppress Error stack frames before write', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ base: null, timestamp: false, hooks: redactingLogHooks }, stream);
    const rawSecret = 'sk-logger-hook-stack-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';
    const error = new Error(`hook api_key=${rawSecret} target=${rawPlatformId}`);
    error.stack = [
      `Error: hook api_key=${rawSecret}`,
      `    at handler (/home/operator/LetheBot/src/index.ts:20:5)`,
      `    at dependency (/home/operator/LetheBot/node_modules/example/index.js:1:1)`,
      `    at platform (${rawPlatformId})`,
    ].join('\n');

    logger.warn({ error }, 'runtime failure');

    const output = lines.join('');
    expect(output).toContain('[REDACTED:api_key_assignment]');
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).toContain('[REDACTED:stack]');
    expect(output).not.toContain(rawSecret);
    expect(output).not.toContain(rawPlatformId);
    expect(output).not.toContain('/home/operator');
    expect(output).not.toContain('src/index.ts');
    expect(output).not.toContain('node_modules');
    expect(output).not.toContain('    at ');
  });
});
