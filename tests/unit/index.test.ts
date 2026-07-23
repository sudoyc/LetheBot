import { describe, it, expect } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  formatFatalErrorForConsole,
  isMainModuleInvocation,
  resolvePiApiKey,
} from '../../src/index';

describe('main module invocation', () => {
  it('recognizes an entrypoint invoked through a managed release symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'lethebot-main-module-'));
    try {
      const releaseDir = join(root, 'releases', 'A', 'dist');
      mkdirSync(releaseDir, { recursive: true });
      const realEntrypoint = join(releaseDir, 'index.js');
      writeFileSync(realEntrypoint, 'export {};\n', 'utf8');
      symlinkSync('releases/A', join(root, 'current'));

      expect(isMainModuleInvocation(
        pathToFileURL(realEntrypoint).href,
        join(root, 'current', 'dist', 'index.js'),
      )).toBe(true);
      expect(isMainModuleInvocation(
        pathToFileURL(realEntrypoint).href,
        join(root, 'missing', 'index.js'),
      )).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('provider credential configuration', () => {
  it('uses only an explicitly provided PI_API_KEY', () => {
    expect(resolvePiApiKey({ PI_API_KEY: 'explicit-test-key' })).toBe('explicit-test-key');
    expect(resolvePiApiKey({})).toBe('');
    expect(resolvePiApiKey({ HOME: '/tmp/home-with-implicit-key-file' })).toBe('');
    expect(() => resolvePiApiKey({}, true)).toThrow(
      'PI_API_KEY is required for a non-mock Pi provider',
    );
    expect(() => resolvePiApiKey({ PI_API_KEY: '  ' }, true)).toThrow(
      'PI_API_KEY is required for a non-mock Pi provider',
    );
  });
});

describe('top-level fatal diagnostics', () => {
  it('redacts Error messages and suppresses stacks before direct console output', () => {
    const rawSecret = 'sk-index-fatal-secret-should-not-leak';
    const rawPlatformId = 'qq-1234567890';
    const error = new Error(`startup failed api_key=${rawSecret} target=${rawPlatformId}`);
    error.stack = [
      `Error: startup failed api_key=${rawSecret}`,
      '    at main (/home/operator/LetheBot/src/index.ts:1515:7)',
      '    at dependency (/home/operator/LetheBot/node_modules/example/index.js:1:1)',
      `    at platform (${rawPlatformId})`,
    ].join('\n');

    const diagnostic = formatFatalErrorForConsole(error);

    expect(diagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(diagnostic).toContain('[REDACTED:platform_id]');
    expect(diagnostic).toContain('[REDACTED:stack]');
    expect(diagnostic).not.toContain(rawSecret);
    expect(diagnostic).not.toContain(rawPlatformId);
    expect(diagnostic).not.toContain('/home/operator');
    expect(diagnostic).not.toContain('src/index.ts');
    expect(diagnostic).not.toContain('node_modules');
    expect(diagnostic).not.toContain('    at ');
  });

  it('redacts plain structured fatal diagnostics with stack fields', () => {
    const rawSecret = 'sk-index-fatal-plain-secret-should-not-leak';
    const rawPlatformId = 'qq-1234567890';
    const diagnostic = formatFatalErrorForConsole({
      message: `startup failed api_key=${rawSecret} target=${rawPlatformId}`,
      stack: [
        `Error: startup failed api_key=${rawSecret}`,
        '    at main (/home/operator/LetheBot/src/index.ts:1515:7)',
      ].join('\n'),
      metadata: {
        peer: rawPlatformId,
      },
    });

    expect(diagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(diagnostic).toContain('[REDACTED:platform_id]');
    expect(diagnostic).toContain('[REDACTED:stack]');
    expect(diagnostic).not.toContain(rawSecret);
    expect(diagnostic).not.toContain(rawPlatformId);
    expect(diagnostic).not.toContain('/home/operator');
    expect(diagnostic).not.toContain('src/index.ts');
    expect(diagnostic).not.toContain('    at ');
  });

  it('preserves both markers for adjacent secret/platform fatal diagnostics', () => {
    const rawAdjacent = 'sk-index-fatal-adjacent-secret-qq-1234567890';
    const rawPlatformId = 'qq-1234567890';
    const diagnostic = formatFatalErrorForConsole({
      message: `startup failed target=${rawAdjacent}`,
      [`metadata-${rawAdjacent}`]: {
        peer: rawAdjacent,
        stack: [
          `Error: startup failed target=${rawAdjacent}`,
          '    at main (/home/operator/LetheBot/src/index.ts:1515:7)',
        ].join('\n'),
      },
    });

    expect(diagnostic).toContain('[REDACTED:openai_like_api_key]');
    expect(diagnostic).toContain('[REDACTED:platform_id]');
    expect(diagnostic).toContain(`metadata-[REDACTED:openai_like_api_key][REDACTED:platform_id]`);
    expect(diagnostic).toContain('[REDACTED:stack]');
    expect(diagnostic).not.toContain(rawAdjacent);
    expect(diagnostic).not.toContain(rawPlatformId);
    expect(diagnostic).not.toContain('1234567890');
    expect(diagnostic).not.toContain('/home/operator');
    expect(diagnostic).not.toContain('src/index.ts');
    expect(diagnostic).not.toContain('    at ');
  });

  it('preserves both markers for assignment-shaped adjacent fatal diagnostics', () => {
    const rawAdjacent = 'api_key=sk-index-fatal-assignment-secret-qq-1234567890';
    const rawPlatformId = 'qq-1234567890';
    const diagnostic = formatFatalErrorForConsole({
      message: `startup failed ${rawAdjacent}`,
      [`metadata-${rawAdjacent}`]: {
        peer: rawAdjacent,
        stack: [
          `Error: startup failed ${rawAdjacent}`,
          '    at main (/home/operator/LetheBot/src/index.ts:1515:7)',
        ].join('\n'),
      },
    });

    expect(diagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(diagnostic).toContain('[REDACTED:platform_id]');
    expect(diagnostic).toContain(`metadata-[REDACTED:api_key_assignment] [REDACTED:platform_id]`);
    expect(diagnostic).toContain('[REDACTED:stack]');
    expect(diagnostic).not.toContain('api_key=');
    expect(diagnostic).not.toContain('sk-index-fatal-assignment');
    expect(diagnostic).not.toContain(rawPlatformId);
    expect(diagnostic).not.toContain('1234567890');
    expect(diagnostic).not.toContain('/home/operator');
    expect(diagnostic).not.toContain('src/index.ts');
    expect(diagnostic).not.toContain('    at ');
  });
});
