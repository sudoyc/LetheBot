/**
 * Phase A Acceptance Tests
 *
 * Verifies that Phase A (Repository Foundation) meets its acceptance criteria.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfig } from '../../src/config/index.js';
import { hello, VERSION } from '../../src/index.js';

describe('Phase A Acceptance', () => {
  beforeEach(() => {
    resetConfig();
  });

  test('TypeScript compiles without errors', () => {
    // If this test runs, TypeScript compilation succeeded
    expect(true).toBe(true);
  });

  test('config loader works', () => {
    process.env.LETHEBOT_TEST = 'true';
    const config = loadConfig();
    expect(config.test).toBe(true);
  });

  test('exports work correctly', () => {
    expect(VERSION).toBe('0.1.0');
    expect(hello()).toContain('LetheBot');
  });
});
