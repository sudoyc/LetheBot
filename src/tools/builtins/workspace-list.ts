import {
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import {
  lstat,
  opendir,
  realpath,
  stat,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  relative,
} from 'node:path';
import type { ToolHandlerRequest, ToolRegistryEntry } from '../../types/tool.js';
import { redactFileOperationText } from '../file-operations/redaction.js';

const MAX_PATH_LENGTH = 512;
const MAX_RETURNED_ENTRIES = 100;
const MAX_SCANNED_ENTRIES = 200;

export interface WorkspaceListDependencies {
  workspaceRoot: string;
}

export interface WorkspaceListEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number | null;
}

export interface WorkspaceListOutput {
  entries: WorkspaceListEntry[];
  count: number;
  truncated: boolean;
  redactionApplied: boolean;
}

class WorkspaceListError extends Error {}

export function createWorkspaceListTool(
  dependencies: WorkspaceListDependencies,
): ToolRegistryEntry {
  const workspaceRoot = resolveWorkspaceRoot(dependencies.workspaceRoot);

  return {
    name: 'workspace.list',
    version: '1.0.0',
    description: 'List bounded non-hidden entries beneath the configured local workspace root.',
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
        type: 'object',
        properties: {
          path: {
            type: 'string',
            maxLength: MAX_PATH_LENGTH,
            description: 'Workspace-relative directory path. Use . for the workspace root.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            maxItems: MAX_RETURNED_ENTRIES,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                type: { type: 'string', enum: ['file', 'directory', 'symlink'] },
                size: { type: ['number', 'null'] },
              },
              required: ['name', 'path', 'type', 'size'],
              additionalProperties: false,
            },
          },
          count: { type: 'number' },
          truncated: { type: 'boolean' },
          redactionApplied: { type: 'boolean' },
        },
        required: ['entries', 'count', 'truncated', 'redactionApplied'],
        additionalProperties: false,
      },
    },
    handler: createWorkspaceListHandler(workspaceRoot),
  };
}

export function createWorkspaceListHandler(
  workspaceRoot: string,
): ToolRegistryEntry['handler'] {
  return async (request: ToolHandlerRequest): Promise<WorkspaceListOutput> => {
    try {
      throwIfAborted(request.signal);
      const requestedPath = parseWorkspacePath(request.input);
      const target = await resolveRequestedDirectory(workspaceRoot, requestedPath, request.signal);
      return await listDirectory(target, requestedPath, request.signal);
    } catch (error) {
      if (error instanceof WorkspaceListError) {
        throw error;
      }
      if (request.signal.aborted) {
        throw new WorkspaceListError('workspace.list aborted');
      }
      throw new WorkspaceListError('workspace.list is unavailable');
    }
  };
}

function resolveWorkspaceRoot(configuredRoot: string): string {
  try {
    if (
      typeof configuredRoot !== 'string'
      || configuredRoot.length === 0
      || configuredRoot.length > 4096
      || configuredRoot.includes('\0')
      || !isAbsolute(configuredRoot)
    ) {
      throw new Error('invalid root');
    }
    const resolved = realpathSync(configuredRoot);
    if (!statSync(resolved).isDirectory()) {
      throw new Error('invalid root');
    }
    return resolved;
  } catch {
    throw new WorkspaceListError('workspace.list root is unavailable');
  }
}

function parseWorkspacePath(input: unknown): string {
  if (
    typeof input !== 'object'
    || input === null
    || Array.isArray(input)
    || Object.keys(input).length !== 1
    || !Object.prototype.hasOwnProperty.call(input, 'path')
  ) {
    throw new WorkspaceListError('workspace.list input is not allowed');
  }

  const requestedPath = (input as { path?: unknown }).path;
  if (
    typeof requestedPath !== 'string'
    || requestedPath.length === 0
    || requestedPath.length > MAX_PATH_LENGTH
    || requestedPath.includes('\0')
    || requestedPath.includes('\\')
    || isAbsolute(requestedPath)
  ) {
    throw new WorkspaceListError('workspace.list input is not allowed');
  }
  if (requestedPath === '.') {
    return requestedPath;
  }

  const segments = requestedPath.split('/');
  if (segments.some((segment) =>
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.startsWith('.')
    || hasControlCharacter(segment)
  )) {
    throw new WorkspaceListError('workspace.list input is not allowed');
  }
  return segments.join('/');
}

async function resolveRequestedDirectory(
  workspaceRoot: string,
  requestedPath: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    throwIfAborted(signal);
    const rootStats = await stat(workspaceRoot);
    throwIfAborted(signal);
    if (!rootStats.isDirectory()) {
      throw new WorkspaceListError('workspace.list is unavailable');
    }
  } catch (error) {
    if (error instanceof WorkspaceListError) {
      throw error;
    }
    throwIfAborted(signal);
    throw new WorkspaceListError('workspace.list is unavailable');
  }

  let target: string;
  try {
    target = await realpath(join(workspaceRoot, requestedPath));
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    if (hasErrorCode(error, 'ENOENT')) {
      throw new WorkspaceListError('workspace.list path was not found');
    }
    throw new WorkspaceListError('workspace.list is unavailable');
  }

  if (!isWithinRoot(target, workspaceRoot)) {
    throw new WorkspaceListError('workspace.list path is not allowed');
  }

  try {
    const targetStats = await stat(target);
    throwIfAborted(signal);
    if (!targetStats.isDirectory()) {
      throw new WorkspaceListError('workspace.list path is not a directory');
    }
  } catch (error) {
    if (error instanceof WorkspaceListError) {
      throw error;
    }
    throwIfAborted(signal);
    throw new WorkspaceListError('workspace.list is unavailable');
  }
  return target;
}

async function listDirectory(
  target: string,
  requestedPath: string,
  signal: AbortSignal,
): Promise<WorkspaceListOutput> {
  const entries: WorkspaceListEntry[] = [];
  let redactionApplied = false;
  let truncated = false;
  let scanned = 0;
  const directory = await opendir(target);

  try {
    while (true) {
      throwIfAborted(signal);
      const dirent = await directory.read();
      throwIfAborted(signal);
      if (!dirent) {
        break;
      }
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES) {
        truncated = true;
        break;
      }
      if (dirent.name.startsWith('.')) {
        continue;
      }
      const type = readEntryType(dirent);
      if (!type) {
        continue;
      }
      if (entries.length >= MAX_RETURNED_ENTRIES) {
        truncated = true;
        break;
      }

      const entryStats = await lstat(join(target, dirent.name));
      throwIfAborted(signal);
      const entryPath = requestedPath === '.'
        ? dirent.name
        : `${requestedPath}/${dirent.name}`;
      const redactedName = redactFileOperationText(dirent.name);
      const redactedPath = redactFileOperationText(entryPath);
      redactionApplied ||= redactedName.redacted || redactedPath.redacted;
      entries.push({
        name: redactedName.text,
        path: redactedPath.text,
        type,
        size: type === 'file' ? entryStats.size : null,
      });
    }
  } finally {
    await directory.close();
  }

  entries.sort(compareEntries);
  return {
    entries,
    count: entries.length,
    truncated,
    redactionApplied,
  };
}

function readEntryType(dirent: Dirent): WorkspaceListEntry['type'] | null {
  if (dirent.isSymbolicLink()) {
    return 'symlink';
  }
  if (dirent.isDirectory()) {
    return 'directory';
  }
  if (dirent.isFile()) {
    return 'file';
  }
  return null;
}

function compareEntries(left: WorkspaceListEntry, right: WorkspaceListEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WorkspaceListError('workspace.list aborted');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}
