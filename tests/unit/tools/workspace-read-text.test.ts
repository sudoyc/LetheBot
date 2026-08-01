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
  createWorkspaceReadTextTool,
  type WorkspaceReadTextOutput,
} from '../../../src/tools/builtins/workspace-read-text';
import { ToolRegistry } from '../../../src/tools/registry';
import type { ToolHandlerRequest } from '../../../src/types/tool';

describe('built-in workspace.read_text tool', () => {
  let testDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-workspace-read-text-'));
    workspaceRoot = join(testDir, 'workspace');
    mkdirSync(workspaceRoot);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('declares exact read-only metadata and private owner/admin permissions', () => {
    const entry = createWorkspaceReadTextTool({ workspaceRoot });
    const registry = new ToolRegistry();
    registry.register(entry);

    expect(entry).toMatchObject({
      name: 'workspace.read_text',
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
          required: ['path', 'content', 'bytes', 'redactionApplied'],
          additionalProperties: false,
        },
      },
    });
    expect(registry.checkPermission(
      'workspace.read_text',
      { actorClass: 'owner' },
      'private_chat',
    )).toBe(true);
    expect(registry.checkPermission(
      'workspace.read_text',
      { actorClass: 'admin' },
      'private_chat',
    )).toBe(true);
    expect(registry.checkPermission(
      'workspace.read_text',
      { actorClass: 'trusted_user' },
      'private_chat',
    )).toBe(false);
    expect(registry.checkPermission(
      'workspace.read_text',
      { actorClass: 'owner' },
      'group_chat',
    )).toBe(false);
    expect(registry.checkPermission(
      'workspace.read_text',
      { actorClass: 'owner' },
      'admin_cli',
    )).toBe(false);
  });

  it('reads strict bounded text with relative output, redaction, and no content or mtime write', async () => {
    const secret = 'sk-workspace-read-secret-abcdefghijklmnopqrstuvwxyz';
    const original = `ordinary\napi_key=${secret}\ncontact 12345`;
    const docsDir = join(workspaceRoot, 'docs');
    const filePath = join(docsDir, 'notes.txt');
    mkdirSync(docsDir);
    writeFileSync(filePath, original);
    const fileBefore = lstatSync(filePath);
    const rootBefore = lstatSync(workspaceRoot);
    const entry = createWorkspaceReadTextTool({ workspaceRoot });

    const output = await entry.handler(
      toolRequest({ path: 'docs/notes.txt' }),
    ) as WorkspaceReadTextOutput;
    const serialized = JSON.stringify(output);

    expect(output).toMatchObject({
      path: 'docs/notes.txt',
      bytes: Buffer.byteLength(original),
      redactionApplied: true,
    });
    expect(output.content).toContain('ordinary');
    expect(output.content).toContain('[REDACTED:api_key_assignment]');
    expect(output.content).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('12345');
    expect(serialized).not.toContain(testDir);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
    expect(lstatSync(filePath).mtimeMs).toBe(fileBefore.mtimeMs);
    expect(lstatSync(workspaceRoot).mtimeMs).toBe(rootBefore.mtimeMs);
  });

  it('keeps heavily redacted output within the declared byte envelope', async () => {
    const original = '12345 '.repeat(300);
    writeFileSync(join(workspaceRoot, 'identifiers.txt'), original);
    const entry = createWorkspaceReadTextTool({ workspaceRoot });

    const output = await entry.handler(
      toolRequest({ path: 'identifiers.txt' }),
    ) as WorkspaceReadTextOutput;
    const serialized = JSON.stringify(output);

    expect(output.bytes).toBe(Buffer.byteLength(original));
    expect(output.redactionApplied).toBe(true);
    expect(serialized).not.toContain('12345');
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8192);
  });

  it.each([
    null,
    [],
    {},
    { path: '' },
    { path: '.' },
    { path: '/absolute.txt' },
    { path: '../outside.txt' },
    { path: 'visible/../outside.txt' },
    { path: '.env' },
    { path: 'visible/.hidden.txt' },
    { path: 'visible//notes.txt' },
    { path: 'visible\\notes.txt' },
    { path: 'notes.txt', encoding: 'base64' },
  ])('rejects malformed or hidden/traversal input without diagnostics: %j', async (input) => {
    const entry = createWorkspaceReadTextTool({ workspaceRoot });

    await expect(entry.handler(toolRequest(input)))
      .rejects.toThrow('workspace.read_text input is not allowed');
  });

  it.each([
    'data/chat.txt',
    'logs/latest.txt',
    'runtime/state.txt',
    'state/current.txt',
    'credentials/readme.txt',
    'api-token.txt',
    'password.md',
    'private_key.txt',
    'lethebot.db',
    'cache.sqlite3',
    'server.log',
    'identity.pem',
    'certificate.crt',
  ])('rejects credential or runtime-data path %s before reading', async (path) => {
    const entry = createWorkspaceReadTextTool({ workspaceRoot });

    await expect(entry.handler(toolRequest({ path })))
      .rejects.toThrow('workspace.read_text path is not allowed');
  });

  it('rejects symlink leaves and parents without exposing or reading their targets', async () => {
    const outsideDir = join(testDir, 'outside');
    const outsideFile = join(outsideDir, 'sentinel.txt');
    const insideDir = join(workspaceRoot, 'inside');
    mkdirSync(outsideDir);
    mkdirSync(insideDir);
    writeFileSync(outsideFile, 'outside content must not be read');
    writeFileSync(join(insideDir, 'notes.txt'), 'inside content');
    symlinkSync(outsideFile, join(workspaceRoot, 'linked-file.txt'));
    symlinkSync(insideDir, join(workspaceRoot, 'linked-dir'));
    const entry = createWorkspaceReadTextTool({ workspaceRoot });

    const leafFailure = await captureFailure(
      entry.handler(toolRequest({ path: 'linked-file.txt' })),
    );
    const parentFailure = await captureFailure(
      entry.handler(toolRequest({ path: 'linked-dir/notes.txt' })),
    );

    expect(leafFailure.message).toBe('workspace.read_text path is not allowed');
    expect(parentFailure.message).toBe('workspace.read_text path is not allowed');
    expect(`${leafFailure.message}${parentFailure.message}`).not.toContain(outsideDir);
    expect(`${leafFailure.message}${parentFailure.message}`).not.toContain('outside content');
  });

  it('uses fixed failures for missing, non-file, oversized, and non-text inputs', async () => {
    mkdirSync(join(workspaceRoot, 'directory'));
    writeFileSync(join(workspaceRoot, 'oversized.txt'), Buffer.alloc(2049, 0x61));
    writeFileSync(join(workspaceRoot, 'invalid-utf8.txt'), Buffer.from([0xc3, 0x28]));
    writeFileSync(join(workspaceRoot, 'nul.txt'), Buffer.from('text\0tail'));
    writeFileSync(join(workspaceRoot, 'control.txt'), Buffer.from('text\u0001tail'));
    const entry = createWorkspaceReadTextTool({ workspaceRoot });

    await expect(entry.handler(toolRequest({ path: 'missing.txt' })))
      .rejects.toThrow('workspace.read_text path was not found');
    await expect(entry.handler(toolRequest({ path: 'directory' })))
      .rejects.toThrow('workspace.read_text path is not a file');
    await expect(entry.handler(toolRequest({ path: 'oversized.txt' })))
      .rejects.toThrow('workspace.read_text file is too large');
    await expect(entry.handler(toolRequest({ path: 'invalid-utf8.txt' })))
      .rejects.toThrow('workspace.read_text file is not text');
    await expect(entry.handler(toolRequest({ path: 'nul.txt' })))
      .rejects.toThrow('workspace.read_text file is not text');
    await expect(entry.handler(toolRequest({ path: 'control.txt' })))
      .rejects.toThrow('workspace.read_text file is not text');
  });

  it('uses fixed aborted and unavailable failures', async () => {
    writeFileSync(join(workspaceRoot, 'notes.txt'), 'content');
    const entry = createWorkspaceReadTextTool({ workspaceRoot });
    const controller = new AbortController();
    controller.abort();

    await expect(entry.handler(toolRequest({ path: 'notes.txt' }, controller.signal)))
      .rejects.toThrow('workspace.read_text aborted');

    rmSync(workspaceRoot, { recursive: true, force: true });
    await expect(entry.handler(toolRequest({ path: 'notes.txt' })))
      .rejects.toThrow('workspace.read_text is unavailable');
  });

  it.each([
    'relative/root',
    '/missing/api_key=sk-workspace-root-secret-abcdefghijklmnopqrstuvwxyz',
  ])('rejects an unavailable root with a fixed non-leaking error: %s', (invalidRoot) => {
    expect(() => createWorkspaceReadTextTool({ workspaceRoot: invalidRoot }))
      .toThrow('workspace.read_text root is unavailable');
    try {
      createWorkspaceReadTextTool({ workspaceRoot: invalidRoot });
    } catch (error) {
      expect(String(error)).not.toContain(invalidRoot);
      expect(String(error)).not.toContain('workspace-root-secret');
    }
  });
});

function toolRequest(input: unknown, signal = new AbortController().signal): ToolHandlerRequest {
  return {
    toolCallId: 'tool-call-workspace-read-text',
    turnId: 'turn-workspace-read-text',
    toolName: 'workspace.read_text',
    signal,
    input,
    actor: { actorClass: 'owner' },
    context: 'private_chat',
  };
}

async function captureFailure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected workspace.read_text to fail');
}
