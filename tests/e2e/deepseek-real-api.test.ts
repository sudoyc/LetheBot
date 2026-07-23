/**
 * DeepSeek real-provider harness guard.
 *
 * Actual opt-in provider calls live in tests/e2e/pi-real-api.test.ts. This file
 * keeps the legacy DeepSeek-specific harness honest: credentials alone must not
 * enable real network tests, local secret files are not read by the default
 * deterministic gate, and this suite must not contain placeholder live-API
 * assertions that could be mistaken for acceptance evidence.
 */

import { describe, expect, it } from 'vitest';

interface DeepSeekTestConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeout: number;
}

function loadDeepSeekConfig(env: NodeJS.ProcessEnv = process.env): DeepSeekTestConfig | null {
  if (env.LETHEBOT_RUN_REAL_API_TESTS !== '1') {
    return null;
  }

  const apiKey = env.DEEPSEEK_API_KEY || env.PI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const parsedTimeout = Number.parseInt(env.DEEPSEEK_TIMEOUT ?? '', 10);
  const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30_000;

  return {
    apiKey,
    model: env.DEEPSEEK_MODEL || env.PI_MODEL || 'deepseek-chat',
    baseUrl: env.DEEPSEEK_BASE_URL || env.PI_BASE_URL || 'https://api.deepseek.com/v1',
    timeout,
  };
}

function isConfiguredForRealDeepSeek(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadDeepSeekConfig(env) !== null;
}

describe('DeepSeek real-provider harness guard', () => {
  it('does not opt into real provider tests from credentials alone', () => {
    const config = loadDeepSeekConfig({
      PI_API_KEY: 'sk-test-key-that-must-not-enable-network-alone',
    });

    expect(config).toBeNull();
  });

  it('requires explicit opt-in plus an environment-provided API key', () => {
    const config = loadDeepSeekConfig({
      LETHEBOT_RUN_REAL_API_TESTS: '1',
      DEEPSEEK_API_KEY: 'sk-test-key-from-env-only',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
      DEEPSEEK_BASE_URL: 'https://example.invalid/v1',
      DEEPSEEK_TIMEOUT: '45000',
    });

    expect(config).toEqual({
      apiKey: 'sk-test-key-from-env-only',
      model: 'deepseek-reasoner',
      baseUrl: 'https://example.invalid/v1',
      timeout: 45_000,
    });
  });

  it('falls back to PI_* environment names for the shared PiAdapter real-provider suite', () => {
    const config = loadDeepSeekConfig({
      LETHEBOT_RUN_REAL_API_TESTS: '1',
      PI_API_KEY: 'sk-test-shared-pi-key',
      PI_MODEL: 'deepseek-chat',
      PI_BASE_URL: 'https://shared.example.invalid/v1',
    });

    expect(config).toEqual({
      apiKey: 'sk-test-shared-pi-key',
      model: 'deepseek-chat',
      baseUrl: 'https://shared.example.invalid/v1',
      timeout: 30_000,
    });
  });

  it('uses a bounded timeout default for missing or malformed timeout values', () => {
    expect(
      loadDeepSeekConfig({
        LETHEBOT_RUN_REAL_API_TESTS: '1',
        PI_API_KEY: 'sk-test-shared-pi-key',
      })?.timeout,
    ).toBe(30_000);

    expect(
      loadDeepSeekConfig({
        LETHEBOT_RUN_REAL_API_TESTS: '1',
        PI_API_KEY: 'sk-test-shared-pi-key',
        DEEPSEEK_TIMEOUT: '-1',
      })?.timeout,
    ).toBe(30_000);
  });

  it('keeps live provider evidence delegated to the PiAdapter real-provider suite', () => {
    expect(isConfiguredForRealDeepSeek({ LETHEBOT_RUN_REAL_API_TESTS: '1' })).toBe(false);
    expect(
      isConfiguredForRealDeepSeek({
        LETHEBOT_RUN_REAL_API_TESTS: '1',
        PI_API_KEY: 'sk-test-shared-pi-key',
      }),
    ).toBe(true);
  });
});
