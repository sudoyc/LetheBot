import {
  lstatSync,
  mkdirSync,
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
  createWorkspaceListTool,
  type WorkspaceListOutput,
} from '../../../src/tools/builtins/workspace-list';
import { ToolRegistry } from '../../../src/tools/registry';
import type { ToolHandlerRequest } from '../../../src/types/tool';

describe('built-in workspace.list tool', () => {
  let testDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-workspace-list-'));
    workspaceRoot = join(testDir, 'workspace');
    mkdirSync(workspaceRoot);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('declares exact read-only metadata and private owner/admin permissions', () => {
    const entry = createWorkspaceListTool({ workspaceRoot });
    const registry = new ToolRegistry();
    registry.register(entry);

    expect(entry).toMatchObject({
      name: 'workspace.list',
      capabilities: ['read_local'],
      permissions: {
        allowedActors: ['owner', 'admin'],
        allowedContexts: ['private_chat'],
      },
      evaluatorPolicy: 'bypass',
      auditLevel: 'redacted_full',
      sandboxPolicy: {
        filesystem: 'readonly',
        network: 'none',
        execution: 'in_process',
        maxRuntimeMs: 1000,
        maxOutputBytes: 8192,
      },
      outputSensitivity: 'secret_possible',
      piSchema: {
        input: {
          required: ['path'],
          additionalProperties: false,
        },
        output: {
          required: ['entries', 'count', 'truncated', 'redactionApplied'],
          additionalProperties: false,
        },
      },
    });
    expect(registry.checkPermission('workspace.list', { actorClass: 'owner' }, 'private_chat'))
      .toBe(true);
    expect(registry.checkPermission('workspace.list', { actorClass: 'admin' }, 'private_chat'))
      .toBe(true);
    expect(registry.checkPermission(
      'workspace.list',
      { actorClass: 'trusted_user' },
      'private_chat',
    )).toBe(false);
    expect(registry.checkPermission('workspace.list', { actorClass: 'owner' }, 'group_chat'))
      .toBe(false);
    expect(registry.checkPermission('workspace.list', { actorClass: 'owner' }, 'admin_cli'))
      .toBe(false);
  });

  it('returns sorted relative metadata without hidden entries, symlink targets, or mutation', async () => {
    mkdirSync(join(workspaceRoot, 'docs'));
    writeFileSync(join(workspaceRoot, 'b.txt'), 'second');
    writeFileSync(join(workspaceRoot, '.env'), 'api_key=sk-hidden-workspace-secret');
    const outsideFile = join(testDir, 'outside-secret.txt');
    writeFileSync(outsideFile, 'outside content must never be read');
    symlinkSync(outsideFile, join(workspaceRoot, 'outside-link'));
    const fileBefore = lstatSync(join(workspaceRoot, 'b.txt'));
    const directoryBefore = lstatSync(workspaceRoot);
    const entry = createWorkspaceListTool({ workspaceRoot });

    const output = await entry.handler(toolRequest({ path: '.' })) as WorkspaceListOutput;

    expect(output).toEqual({
      entries: [
        { name: 'b.txt', path: 'b.txt', type: 'file', size: 6 },
        { name: 'docs', path: 'docs', type: 'directory', size: null },
        { name: 'outside-link', path: 'outside-link', type: 'symlink', size: null },
      ],
      count: 3,
      truncated: false,
      redactionApplied: false,
    });
    expect(JSON.stringify(output)).not.toContain('.env');
    expect(JSON.stringify(output)).not.toContain(outsideFile);
    expect(JSON.stringify(output)).not.toContain('outside content');
    expect(readFileSync(join(workspaceRoot, 'b.txt'), 'utf8')).toBe('second');
    expect(lstatSync(join(workspaceRoot, 'b.txt')).mtimeMs).toBe(fileBefore.mtimeMs);
    expect(lstatSync(workspaceRoot).mtimeMs).toBe(directoryBefore.mtimeMs);
  });

  it('caps scanned output at 100 entries with an explicit truncation marker', async () => {
    for (let index = 0; index < 105; index += 1) {
      writeFileSync(join(workspaceRoot, `f${String(index).padStart(3, '0')}`), 'x');
    }
    const entry = createWorkspaceListTool({ workspaceRoot });

    const output = await entry.handler(toolRequest({ path: '.' })) as WorkspaceListOutput;

    expect(output.entries).toHaveLength(100);
    expect(output.count).toBe(100);
    expect(output.truncated).toBe(true);
    expect(output.entries).toEqual([...output.entries].sort(compareWorkspaceEntries));
  });

  it('redacts secret and five-to-twelve-digit platform-shaped entry names', async () => {
    const secret = 'sk-workspace-list-secret-abcdefghijklmnopqrstuvwxyz';
    writeFileSync(join(workspaceRoot, `api_key=${secret}.txt`), 'ordinary');
    writeFileSync(join(workspaceRoot, 'qq-12345.txt'), 'ordinary');
    const entry = createWorkspaceListTool({ workspaceRoot });

    const output = await entry.handler(toolRequest({ path: '.' })) as WorkspaceListOutput;
    const serialized = JSON.stringify(output);

    expect(output.redactionApplied).toBe(true);
    expect(serialized).toContain('[REDACTED:api_key_assignment]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('12345');
  });

  it.each([
    null,
    [],
    {},
    { path: '' },
    { path: '/absolute' },
    { path: '../outside' },
    { path: 'visible/../outside' },
    { path: '.hidden' },
    { path: 'visible/.hidden' },
    { path: 'visible//nested' },
    { path: 'visible\\nested' },
    { path: 'visible', recursive: true },
  ])('rejects malformed or disallowed input without filesystem diagnostics: %j', async (input) => {
    const entry = createWorkspaceListTool({ workspaceRoot });

    await expect(entry.handler(toolRequest(input)))
      .rejects.toThrow('workspace.list input is not allowed');
  });

  it('rejects a symlink escape without exposing or reading the target', async () => {
    const outsideDir = join(testDir, 'outside-api_key=sk-workspace-target-secret');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'sentinel.txt'), 'outside content');
    symlinkSync(outsideDir, join(workspaceRoot, 'linked'));
    const entry = createWorkspaceListTool({ workspaceRoot });

    const failure = await captureFailure(entry.handler(toolRequest({ path: 'linked' })));

    expect(failure.message).toBe('workspace.list path is not allowed');
    expect(failure.message).not.toContain(outsideDir);
    expect(failure.message).not.toContain('workspace-target-secret');
  });

  it('uses fixed missing, non-directory, unavailable, and aborted failures', async () => {
    writeFileSync(join(workspaceRoot, 'file.txt'), 'content');
    const entry = createWorkspaceListTool({ workspaceRoot });

    await expect(entry.handler(toolRequest({ path: 'missing' })))
      .rejects.toThrow('workspace.list path was not found');
    await expect(entry.handler(toolRequest({ path: 'file.txt' })))
      .rejects.toThrow('workspace.list path is not a directory');

    const controller = new AbortController();
    controller.abort();
    await expect(entry.handler(toolRequest({ path: '.' }, controller.signal)))
      .rejects.toThrow('workspace.list aborted');

    rmSync(workspaceRoot, { recursive: true, force: true });
    await expect(entry.handler(toolRequest({ path: '.' })))
      .rejects.toThrow('workspace.list is unavailable');
  });

  it.each([
    'relative/root',
    '/missing/api_key=sk-workspace-root-secret-abcdefghijklmnopqrstuvwxyz',
  ])('rejects an unavailable root with a fixed non-leaking error: %s', (invalidRoot) => {
    expect(() => createWorkspaceListTool({ workspaceRoot: invalidRoot }))
      .toThrow('workspace.list root is unavailable');
    try {
      createWorkspaceListTool({ workspaceRoot: invalidRoot });
    } catch (error) {
      expect(String(error)).not.toContain(invalidRoot);
      expect(String(error)).not.toContain('workspace-root-secret');
    }
  });
});

function toolRequest(input: unknown, signal = new AbortController().signal): ToolHandlerRequest {
  return {
    toolCallId: 'tool-call-workspace-list',
    turnId: 'turn-workspace-list',
    toolName: 'workspace.list',
    signal,
    input,
    actor: { actorClass: 'owner' },
    context: 'private_chat',
  };
}

function compareWorkspaceEntries(
  left: WorkspaceListOutput['entries'][number],
  right: WorkspaceListOutput['entries'][number],
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

async function captureFailure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected workspace.list to fail');
}
