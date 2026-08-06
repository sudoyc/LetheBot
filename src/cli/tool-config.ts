import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { parseDisabledToolsEnvironment } from '../config/index.js';
import {
  isKnownToolName,
  KNOWN_TOOL_NAMES,
} from '../tools/known-tools.js';

const DISABLED_TOOLS_ENVIRONMENT_KEY = 'LETHEBOT_DISABLED_TOOLS';
const MAX_ENV_FILE_BYTES = 1_048_576;
const DISABLED_TOOLS_ASSIGNMENT = /^(?:[ \t]*export[ \t]+)?[ \t]*LETHEBOT_DISABLED_TOOLS[ \t]*=[^\r\n]*$/gm;

type KnownToolName = typeof KNOWN_TOOL_NAMES[number];
export type ToolConfigurationAction = 'enable' | 'disable';

export interface ToolConfigurationState {
  name: KnownToolName;
  enabled: boolean;
}

export interface ToolConfigurationUpdate {
  name: KnownToolName;
  enabled: boolean;
  changed: boolean;
  disabledTools: KnownToolName[];
  restartRequired: true;
}

export function listToolConfiguration(
  disabledTools: readonly string[],
): ToolConfigurationState[] {
  const disabled = new Set(normalizeDisabledTools(disabledTools));
  return KNOWN_TOOL_NAMES.map((name) => ({
    name,
    enabled: !disabled.has(name),
  }));
}

export function inspectToolConfiguration(
  disabledTools: readonly string[],
  name: string,
): ToolConfigurationState {
  const knownName = requireKnownToolName(name);
  const states = listToolConfiguration(disabledTools);
  const state = states.find((entry) => entry.name === knownName);
  if (!state) {
    throw new Error('Reviewed tool configuration is unavailable');
  }
  return state;
}

export function readDisabledToolsEnvFile(path: string): KnownToolName[] {
  return readEnvFile(resolve(path)).disabledTools;
}

export function updateToolEnvFile(
  path: string,
  name: string,
  action: ToolConfigurationAction,
): ToolConfigurationUpdate {
  const knownName = requireKnownToolName(name);
  if (action !== 'enable' && action !== 'disable') {
    throw new Error('Tool configuration action must be enable or disable');
  }
  const targetPath = resolve(path);
  const current = readEnvFile(targetPath);
  const disabled = new Set<KnownToolName>(current.disabledTools);
  const wasDisabled = disabled.has(knownName);

  if (action === 'disable') {
    disabled.add(knownName);
  } else {
    disabled.delete(knownName);
  }

  const nextDisabled = KNOWN_TOOL_NAMES.filter((entry) => disabled.has(entry));
  const changed = wasDisabled !== disabled.has(knownName);
  if (changed) {
    const assignment = `${DISABLED_TOOLS_ENVIRONMENT_KEY}=${nextDisabled.join(',')}`;
    const nextContent = replaceEnvironmentAssignment(current.content, assignment);
    writeEnvFileAtomically(targetPath, nextContent, current.mode);
  }

  return {
    name: knownName,
    enabled: action === 'enable',
    changed,
    disabledTools: nextDisabled,
    restartRequired: true,
  };
}

function readEnvFile(path: string): {
  content: string;
  mode: number;
  disabledTools: KnownToolName[];
} {
  let content = '';
  let mode = 0o600;

  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Tool configuration env path must be a regular file, not a symlink');
    }
    if (stat.size > MAX_ENV_FILE_BYTES) {
      throw new Error('Tool configuration env file exceeds the 1 MiB limit');
    }
    mode = stat.mode & 0o777;
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const assignments = content.match(DISABLED_TOOLS_ASSIGNMENT) ?? [];
  if (assignments.length > 1) {
    throw new Error('Tool configuration env file contains duplicate LETHEBOT_DISABLED_TOOLS assignments');
  }

  let parsed: ReturnType<typeof parseEnv>;
  try {
    parsed = parseEnv(content);
  } catch {
    throw new Error('Tool configuration env file is invalid');
  }
  const disabledTools = parseDisabledToolsEnvironment(
    parsed[DISABLED_TOOLS_ENVIRONMENT_KEY],
  ) ?? [];

  return {
    content,
    mode,
    disabledTools: normalizeDisabledTools(disabledTools),
  };
}

function normalizeDisabledTools(disabledTools: readonly string[]): KnownToolName[] {
  const seen = new Set<string>();
  for (const name of disabledTools) {
    if (seen.has(name) || !isKnownToolName(name)) {
      throw new Error('LETHEBOT_DISABLED_TOOLS contains an invalid reviewed tool name');
    }
    seen.add(name);
  }
  return KNOWN_TOOL_NAMES.filter((name) => seen.has(name));
}

function requireKnownToolName(name: string): KnownToolName {
  if (!isKnownToolName(name)) {
    throw new Error('Unknown reviewed tool name');
  }
  return name as KnownToolName;
}

function replaceEnvironmentAssignment(content: string, assignment: string): string {
  DISABLED_TOOLS_ASSIGNMENT.lastIndex = 0;
  if (DISABLED_TOOLS_ASSIGNMENT.test(content)) {
    DISABLED_TOOLS_ASSIGNMENT.lastIndex = 0;
    return content.replace(DISABLED_TOOLS_ASSIGNMENT, assignment);
  }

  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  if (content.length === 0) {
    return `${assignment}${lineEnding}`;
  }
  return content.endsWith('\n')
    ? `${content}${assignment}${lineEnding}`
    : `${content}${lineEnding}${assignment}${lineEnding}`;
}

function writeEnvFileAtomically(path: string, content: string, mode: number): void {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, 'wx', mode);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporaryPath, { force: true });
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT';
}
