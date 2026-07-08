import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('verify-napcat CLI', () => {
  it('redacts secret-like URLs and platform identifiers from operator output', () => {
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const rawSecret = 'sk-verify-napcat-url-secret-should-not-print';
    const rawPlatformId = 'qq-1234567890';
    const rawHttpUrl = `http://127.0.0.1:1/${rawPlatformId}/api_key=${rawSecret}`;

    const result = spawnSync(tsxBin, ['src/scripts/verify-napcat.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETHEBOT_TEST: 'true',
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        ONEBOT_HTTP_URL: rawHttpUrl,
        ONEBOT_WS_URL: 'ws://127.0.0.1:1/',
        ONEBOT_TOKEN: `token=${rawSecret}`,
        LETHEBOT_BOT_QQ_ID: '1234567890',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('[REDACTED:api_key_assignment]');
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).not.toContain(rawSecret);
    expect(output).not.toContain(rawPlatformId);
    expect(output).not.toContain('1234567890');
  });

  it('redacts embedded platform identifiers from operator output', () => {
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const embeddedPrefixedPlatformId = 'legacy_qq-1234567890';
    const embeddedNumericPlatformId = 'legacy_987654321';
    const rawHttpUrl = `http://127.0.0.1:1/${embeddedPrefixedPlatformId}/${embeddedNumericPlatformId}`;

    const result = spawnSync(tsxBin, ['src/scripts/verify-napcat.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETHEBOT_TEST: 'true',
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        ONEBOT_HTTP_URL: rawHttpUrl,
        ONEBOT_WS_URL: 'ws://127.0.0.1:1/',
        LETHEBOT_BOT_QQ_ID: '1234567890',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).not.toContain(embeddedPrefixedPlatformId);
    expect(output).not.toContain(embeddedNumericPlatformId);
    expect(output).not.toContain('legacy_qq-');
    expect(output).not.toContain('1234567890');
    expect(output).not.toContain('987654321');
  });

  it('redacts adjacent secret/platform identifiers from operator output', () => {
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const adjacentSecretPlatformId = 'sk-verify-napcat-adjacent-url-secret-qq-1234567890';
    const rawHttpUrl = `http://127.0.0.1:1/${adjacentSecretPlatformId}`;

    const result = spawnSync(tsxBin, ['src/scripts/verify-napcat.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETHEBOT_TEST: 'true',
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        ONEBOT_HTTP_URL: rawHttpUrl,
        ONEBOT_WS_URL: 'ws://127.0.0.1:1/',
        LETHEBOT_BOT_QQ_ID: '1234567890',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('[REDACTED:openai_like_api_key]');
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).not.toContain(adjacentSecretPlatformId);
    expect(output).not.toContain('qq-1234567890');
    expect(output).not.toContain('1234567890');
  });

  it('preserves assignment-shaped adjacent markers in operator output', () => {
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const rawAssignment = 'api_key=sk-verify-napcat-assignment-url-secret-qq-1234567890';
    const rawSecret = 'sk-verify-napcat-assignment-url-secret-qq-1234567890';
    const rawPlatformId = 'qq-1234567890';
    const rawHttpUrl = `http://127.0.0.1:1/${rawAssignment}`;

    const result = spawnSync(tsxBin, ['src/scripts/verify-napcat.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETHEBOT_TEST: 'true',
        LOG_LEVEL: 'fatal',
        ONEBOT_TRANSPORT: 'http',
        ONEBOT_HTTP_URL: rawHttpUrl,
        ONEBOT_WS_URL: 'ws://127.0.0.1:1/',
        LETHEBOT_BOT_QQ_ID: '1234567890',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('[REDACTED:api_key_assignment]');
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).not.toContain(rawAssignment);
    expect(output).not.toContain(rawSecret);
    expect(output).not.toContain(rawPlatformId);
    expect(output).not.toContain('1234567890');
  });
});
