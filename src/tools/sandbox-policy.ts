import type { SandboxPolicy } from '../types/tool.js';

const TOOL_EXECUTION_VALUES: readonly SandboxPolicy['execution'][] = [
  'none',
  'in_process',
  'subprocess',
  'docker',
];

export function assertKnownToolExecution(
  toolName: string,
  execution: unknown,
): asserts execution is SandboxPolicy['execution'] {
  if (!TOOL_EXECUTION_VALUES.includes(execution as SandboxPolicy['execution'])) {
    throw new Error(
      `Tool "${toolName}" sandboxPolicy.execution must be one of: ${TOOL_EXECUTION_VALUES.join(', ')}`
    );
  }
}

export function isSupportedToolExecution(execution: unknown): execution is 'in_process' {
  return execution === 'in_process';
}

export function assertSupportedToolExecution(toolName: string, execution: unknown): void {
  if (!isSupportedToolExecution(execution)) {
    throw new Error(
      `Tool execution backend is unavailable for "${toolName}"; only in_process is supported`
    );
  }
}
