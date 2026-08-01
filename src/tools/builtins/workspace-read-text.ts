import { Buffer } from 'node:buffer';
import {
  constants,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  lstat,
  open,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  relative,
} from 'node:path';
import { TextDecoder } from 'node:util';
import type { ToolHandlerRequest, ToolRegistryEntry } from '../../types/tool.js';
import { redactFileOperationText } from '../file-operations/redaction.js';

const MAX_PATH_LENGTH = 512;
const MAX_TEXT_BYTES = 2048;
const BLOCKED_DIRECTORY_NAMES = new Set([
  'credentials',
  'data',
  'logs',
  'runtime',
  'secrets',
  'state',
]);
const BLOCKED_FILENAME_MARKER = /(?:^|[._-])(?:api[._-]?key|access[._-]?key|private[._-]?key|secret|secrets|credential|credentials|token|tokens|password|passwd|cookie|recovery[._-]?codes?)(?:[._-]|$)/i;
const BLOCKED_FILE_SUFFIX = /\.(?:db|db-(?:shm|wal)|sqlite3?|sqlite3?-(?:shm|wal)|log|pem|key|p12|pfx|crt|cer|der)$/i;

export interface WorkspaceReadTextDependencies {
  workspaceRoot: string;
}

export interface WorkspaceReadTextOutput {
  path: string;
  content: string;
  bytes: number;
  redactionApplied: boolean;
}

class WorkspaceReadTextError extends Error {}

export function createWorkspaceReadTextTool(
  dependencies: WorkspaceReadTextDependencies,
): ToolRegistryEntry {
  const workspaceRoot = resolveWorkspaceRoot(dependencies.workspaceRoot);

  return {
    name: 'workspace.read_text',
    version: '1.0.0',
    description: 'Read one bounded non-sensitive UTF-8 text file beneath the configured workspace root.',
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
            description: 'Workspace-relative path to one non-sensitive UTF-8 text file.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', maxLength: MAX_TEXT_BYTES },
          bytes: { type: 'number' },
          redactionApplied: { type: 'boolean' },
        },
        required: ['path', 'content', 'bytes', 'redactionApplied'],
        additionalProperties: false,
      },
    },
    handler: createWorkspaceReadTextHandler(workspaceRoot),
  };
}

export function createWorkspaceReadTextHandler(
  workspaceRoot: string,
): ToolRegistryEntry['handler'] {
  return async (request: ToolHandlerRequest): Promise<WorkspaceReadTextOutput> => {
    try {
      throwIfAborted(request.signal);
      const requestedPath = parseWorkspaceFilePath(request.input);
      const target = await resolveWorkspaceFile(workspaceRoot, requestedPath, request.signal);
      const { content, bytes } = await readBoundedTextFile(target, request.signal);
      const redactedPath = redactFileOperationText(requestedPath);
      const redactedContent = redactFileOperationText(content);

      return {
        path: redactedPath.text,
        content: redactedContent.text,
        bytes,
        redactionApplied: redactedPath.redacted || redactedContent.redacted,
      };
    } catch (error) {
      if (error instanceof WorkspaceReadTextError) {
        throw error;
      }
      if (request.signal.aborted) {
        throw new WorkspaceReadTextError('workspace.read_text aborted');
      }
      throw new WorkspaceReadTextError('workspace.read_text is unavailable');
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
    throw new WorkspaceReadTextError('workspace.read_text root is unavailable');
  }
}

function parseWorkspaceFilePath(input: unknown): string {
  if (
    typeof input !== 'object'
    || input === null
    || Array.isArray(input)
    || Object.keys(input).length !== 1
    || !Object.prototype.hasOwnProperty.call(input, 'path')
  ) {
    throw new WorkspaceReadTextError('workspace.read_text input is not allowed');
  }

  const requestedPath = (input as { path?: unknown }).path;
  if (
    typeof requestedPath !== 'string'
    || requestedPath.length === 0
    || requestedPath.length > MAX_PATH_LENGTH
    || requestedPath.includes('\0')
    || requestedPath.includes('\\')
    || requestedPath === '.'
    || isAbsolute(requestedPath)
  ) {
    throw new WorkspaceReadTextError('workspace.read_text input is not allowed');
  }

  const segments = requestedPath.split('/');
  if (segments.some((segment) =>
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.startsWith('.')
    || hasControlCharacter(segment)
  )) {
    throw new WorkspaceReadTextError('workspace.read_text input is not allowed');
  }
  if (isSensitiveWorkspacePath(segments)) {
    throw new WorkspaceReadTextError('workspace.read_text path is not allowed');
  }
  return segments.join('/');
}

async function resolveWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    throwIfAborted(signal);
    const rootStats = await lstat(workspaceRoot);
    throwIfAborted(signal);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new WorkspaceReadTextError('workspace.read_text is unavailable');
    }
  } catch (error) {
    if (error instanceof WorkspaceReadTextError) {
      throw error;
    }
    throwIfAborted(signal);
    throw new WorkspaceReadTextError('workspace.read_text is unavailable');
  }

  let candidate = workspaceRoot;
  const segments = requestedPath.split('/');
  for (const [index, segment] of segments.entries()) {
    candidate = join(candidate, segment);
    try {
      const candidateStats = await lstat(candidate);
      throwIfAborted(signal);
      if (candidateStats.isSymbolicLink()) {
        throw new WorkspaceReadTextError('workspace.read_text path is not allowed');
      }
      if (index < segments.length - 1 && !candidateStats.isDirectory()) {
        throw new WorkspaceReadTextError('workspace.read_text path was not found');
      }
      if (index === segments.length - 1 && !candidateStats.isFile()) {
        throw new WorkspaceReadTextError('workspace.read_text path is not a file');
      }
    } catch (error) {
      if (error instanceof WorkspaceReadTextError) {
        throw error;
      }
      throwIfAborted(signal);
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
        throw new WorkspaceReadTextError('workspace.read_text path was not found');
      }
      throw new WorkspaceReadTextError('workspace.read_text is unavailable');
    }
  }

  try {
    const resolved = await realpath(candidate);
    throwIfAborted(signal);
    if (!isWithinRoot(resolved, workspaceRoot)) {
      throw new WorkspaceReadTextError('workspace.read_text path is not allowed');
    }
    return resolved;
  } catch (error) {
    if (error instanceof WorkspaceReadTextError) {
      throw error;
    }
    throwIfAborted(signal);
    throw new WorkspaceReadTextError('workspace.read_text is unavailable');
  }
}

async function readBoundedTextFile(
  target: string,
  signal: AbortSignal,
): Promise<{ content: string; bytes: number }> {
  let file: FileHandle | undefined;
  try {
    throwIfAborted(signal);
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    throwIfAborted(signal);
    const stats = await file.stat();
    throwIfAborted(signal);
    if (!stats.isFile()) {
      throw new WorkspaceReadTextError('workspace.read_text path is not a file');
    }
    if (stats.size > MAX_TEXT_BYTES) {
      throw new WorkspaceReadTextError('workspace.read_text file is too large');
    }

    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    throwIfAborted(signal);
    if (bytesRead > MAX_TEXT_BYTES) {
      throw new WorkspaceReadTextError('workspace.read_text file is too large');
    }

    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new WorkspaceReadTextError('workspace.read_text file is not text');
    }
    if (hasDisallowedTextControl(content)) {
      throw new WorkspaceReadTextError('workspace.read_text file is not text');
    }
    return { content, bytes: bytesRead };
  } catch (error) {
    if (error instanceof WorkspaceReadTextError) {
      throw error;
    }
    throwIfAborted(signal);
    if (hasErrorCode(error, 'ELOOP')) {
      throw new WorkspaceReadTextError('workspace.read_text path is not allowed');
    }
    throw new WorkspaceReadTextError('workspace.read_text is unavailable');
  } finally {
    await file?.close();
  }
}

function isSensitiveWorkspacePath(segments: string[]): boolean {
  if (segments.some((segment, index) =>
    index < segments.length - 1 && BLOCKED_DIRECTORY_NAMES.has(segment.toLowerCase())
  )) {
    return true;
  }
  const filename = segments.at(-1);
  return filename !== undefined
    && (BLOCKED_FILENAME_MARKER.test(filename) || BLOCKED_FILE_SUFFIX.test(filename));
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WorkspaceReadTextError('workspace.read_text aborted');
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

function hasDisallowedTextControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined
      && ((codePoint <= 31 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13)
        || codePoint === 127);
  });
}
