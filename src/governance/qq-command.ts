const MAX_QQ_GOVERNANCE_COMMAND_LENGTH = 512;
const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type QqGovernanceCommand =
  | { type: 'memory' }
  | { type: 'memory_forget'; memoryId: string }
  | {
      type: 'memory_summary';
      action: 'status' | 'enable' | 'disable';
    }
  | { type: 'why' };

export type QqGovernanceCommandParseResult =
  | { status: 'not_command' }
  | {
      status: 'invalid';
      family: 'memory' | 'why';
      reason: 'input_too_long' | 'invalid_syntax';
    }
  | { status: 'valid'; command: QqGovernanceCommand };

export function parseQqGovernanceCommand(
  input: string,
): QqGovernanceCommandParseResult {
  if (input.length > MAX_QQ_GOVERNANCE_COMMAND_LENGTH) {
    const family = recognizeFamily(input);
    return family === undefined
      ? { status: 'not_command' }
      : { status: 'invalid', family, reason: 'input_too_long' };
  }

  const tokens = input.trim().split(/\s+/u);
  const family = tokens[0];

  if (family === '/why') {
    return tokens.length === 1
      ? { status: 'valid', command: { type: 'why' } }
      : { status: 'invalid', family: 'why', reason: 'invalid_syntax' };
  }

  if (family !== '/memory') {
    return { status: 'not_command' };
  }

  if (tokens.length === 1) {
    return { status: 'valid', command: { type: 'memory' } };
  }

  if (tokens[1] === 'forget') {
    const memoryId = tokens[2];
    return tokens.length === 3 && memoryId !== undefined && MEMORY_ID_PATTERN.test(memoryId)
      ? { status: 'valid', command: { type: 'memory_forget', memoryId } }
      : { status: 'invalid', family: 'memory', reason: 'invalid_syntax' };
  }

  if (tokens[1] === 'summary') {
    const action = tokens[2];
    return tokens.length === 3 && isSummaryAction(action)
      ? { status: 'valid', command: { type: 'memory_summary', action } }
      : { status: 'invalid', family: 'memory', reason: 'invalid_syntax' };
  }

  return { status: 'invalid', family: 'memory', reason: 'invalid_syntax' };
}

function recognizeFamily(input: string): 'memory' | 'why' | undefined {
  const match = /^\s*\/(memory|why)(?=\s|$)/u.exec(input);
  const family = match?.[1];
  return family === 'memory' || family === 'why' ? family : undefined;
}

function isSummaryAction(
  action: string | undefined,
): action is 'status' | 'enable' | 'disable' {
  return action === 'status' || action === 'enable' || action === 'disable';
}
