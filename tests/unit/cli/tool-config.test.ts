import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectToolConfiguration,
  listToolConfiguration,
  readDisabledToolsEnvFile,
  updateToolEnvFile,
} from '../../../src/cli/tool-config';
import { KNOWN_TOOL_NAMES } from '../../../src/tools/known-tools';

describe('tool configuration CLI support', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-tool-config-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('projects every reviewed tool in canonical order without exposing other config', () => {
    const states = listToolConfiguration(['runtime.tools', 'memory.search']);

    expect(states.map((state) => state.name)).toEqual(KNOWN_TOOL_NAMES);
    expect(states.find((state) => state.name === 'memory.search')).toEqual({
      name: 'memory.search',
      enabled: false,
    });
    expect(inspectToolConfiguration([], 'memory.search')).toEqual({
      name: 'memory.search',
      enabled: true,
    });
    expect(() => inspectToolConfiguration([], 'unknown.tool')).toThrow(
      'Unknown reviewed tool name',
    );
  });

  it('creates an explicit env file and marks restart-scoped enablement', () => {
    const envPath = join(testDir, 'tools.env');

    const update = updateToolEnvFile(envPath, 'memory.search', 'disable');

    expect(update).toEqual({
      name: 'memory.search',
      enabled: false,
      changed: true,
      disabledTools: ['memory.search'],
      restartRequired: true,
    });
    expect(readFileSync(envPath, 'utf8')).toBe('LETHEBOT_DISABLED_TOOLS=memory.search\n');
    expect(lstatSync(envPath).mode & 0o777).toBe(0o600);
    expect(readDisabledToolsEnvFile(envPath)).toEqual(['memory.search']);
  });

  it('preserves unrelated env content and file mode across canonical updates', () => {
    const envPath = join(testDir, 'lethebot.env');
    const originalSecret = 'PI_API_KEY=sk-preserve-this-private-value-abcdefghijklmnopqrstuvwxyz';
    writeFileSync(
      envPath,
      `${originalSecret}\nLETHEBOT_DISABLED_TOOLS=runtime.tools\nONEBOT_TRANSPORT=ws\n`,
      'utf8',
    );
    chmodSync(envPath, 0o640);

    expect(updateToolEnvFile(envPath, 'memory.search', 'disable')).toMatchObject({
      enabled: false,
      changed: true,
      disabledTools: ['memory.search', 'runtime.tools'],
    });
    expect(readFileSync(envPath, 'utf8')).toBe(
      `${originalSecret}\nLETHEBOT_DISABLED_TOOLS=memory.search,runtime.tools\nONEBOT_TRANSPORT=ws\n`,
    );
    expect(lstatSync(envPath).mode & 0o777).toBe(0o640);

    expect(updateToolEnvFile(envPath, 'runtime.tools', 'enable')).toMatchObject({
      enabled: true,
      changed: true,
      disabledTools: ['memory.search'],
    });
    const onceEnabled = readFileSync(envPath, 'utf8');
    expect(updateToolEnvFile(envPath, 'runtime.tools', 'enable')).toMatchObject({
      enabled: true,
      changed: false,
      disabledTools: ['memory.search'],
    });
    expect(readFileSync(envPath, 'utf8')).toBe(onceEnabled);
    expect(onceEnabled).toContain(originalSecret);
  });

  it('reads quoted values but rejects duplicate, unknown, and symlinked configuration', () => {
    const quotedPath = join(testDir, 'quoted.env');
    writeFileSync(
      quotedPath,
      'LETHEBOT_DISABLED_TOOLS="memory.search, runtime.tools" # reviewed tools\n',
      'utf8',
    );
    expect(readDisabledToolsEnvFile(quotedPath)).toEqual(['memory.search', 'runtime.tools']);

    const duplicatePath = join(testDir, 'duplicate.env');
    const duplicateContent = [
      'LETHEBOT_DISABLED_TOOLS=memory.search',
      'export LETHEBOT_DISABLED_TOOLS=runtime.tools',
      '',
    ].join('\n');
    writeFileSync(duplicatePath, duplicateContent, 'utf8');
    expect(() => updateToolEnvFile(duplicatePath, 'memory.search', 'enable')).toThrow(
      'duplicate LETHEBOT_DISABLED_TOOLS',
    );
    expect(readFileSync(duplicatePath, 'utf8')).toBe(duplicateContent);

    const unknownPath = join(testDir, 'unknown.env');
    writeFileSync(unknownPath, 'LETHEBOT_DISABLED_TOOLS=unknown.tool\n', 'utf8');
    expect(() => readDisabledToolsEnvFile(unknownPath)).toThrow(
      'invalid reviewed tool name',
    );

    const symlinkPath = join(testDir, 'symlink.env');
    symlinkSync(quotedPath, symlinkPath);
    expect(() => updateToolEnvFile(symlinkPath, 'memory.search', 'disable')).toThrow(
      'regular file, not a symlink',
    );
  });
});
