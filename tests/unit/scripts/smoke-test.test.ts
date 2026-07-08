import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { formatSmokeErrorForConsole } from '../../../scripts/smoke-test';

describe('smoke-test script', () => {
  it('runs the deterministic local smoke path successfully', () => {
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const result = spawnSync(tsxBin, ['scripts/smoke-test.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETHEBOT_TEST: 'true',
        LOG_LEVEL: 'fatal',
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('✨ All smoke tests passed!');
  });

  it('formats smoke errors without leaking secrets, platform IDs, or stack paths', () => {
    const secret = 'sk-cli-smoke-secret-should-not-leak';
    const platformId = 'qq-135792468';
    const error = new Error(`api_key=${secret} for ${platformId}`);
    error.stack = [
      `Error: api_key=${secret} for ${platformId}`,
      '    at smokeTest (/home/ycyc/projects/LetheBot/scripts/smoke-test.ts:228:5)',
      '    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)',
      '    at async /home/ycyc/projects/LetheBot/node_modules/.pnpm/tsx/index.mjs:1:1',
    ].join('\n');

    const display = formatSmokeErrorForConsole(error);

    expect(display).toContain('[REDACTED:api_key_assignment]');
    expect(display).toContain('[REDACTED:platform_id]');
    expect(display).toContain('[REDACTED:stack]');
    expect(display).not.toContain(secret);
    expect(display).not.toContain(platformId);
    expect(display).not.toContain('135792468');
    expect(display).not.toContain('scripts/smoke-test.ts');
    expect(display).not.toContain('node_modules');
    expect(display).not.toContain('\n    at ');
  });

  it('formats assignment-shaped adjacent smoke errors with both secret and platform markers', () => {
    const adjacent = 'api_key=sk-cli-smoke-secret-qq-135792468';
    const error = new Error(`operator smoke failure ${adjacent}`);

    const display = formatSmokeErrorForConsole(error);

    expect(display).toContain('[REDACTED:api_key_assignment]');
    expect(display).toContain('[REDACTED:platform_id]');
    expect(display).toContain('[REDACTED:stack]');
    expect(display).not.toContain(adjacent);
    expect(display).not.toContain('sk-cli-smoke-secret');
    expect(display).not.toContain('qq-135792468');
    expect(display).not.toContain('135792468');
  });
});
