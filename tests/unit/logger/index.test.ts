import { describe, test, expect } from 'vitest';
import { getLogger } from '../../../src/logger/index.js';

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
});
