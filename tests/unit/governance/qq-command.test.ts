import { describe, expect, it } from 'vitest';
import { parseQqGovernanceCommand } from '../../../src/governance/qq-command.js';

describe('parseQqGovernanceCommand', () => {
  it.each([
    ['/memory', { type: 'memory' }],
    ['  \t/memory\n', { type: 'memory' }],
    ['/memory forget memory-01', { type: 'memory_forget', memoryId: 'memory-01' }],
    [
      '\n/memory\tforget\u00a0A.b_c:d-9  ',
      { type: 'memory_forget', memoryId: 'A.b_c:d-9' },
    ],
    ['/memory summary status', { type: 'memory_summary', action: 'status' }],
    [' /memory\tsummary\nenable ', { type: 'memory_summary', action: 'enable' }],
    ['/memory  summary  disable', { type: 'memory_summary', action: 'disable' }],
    ['/why', { type: 'why' }],
    [' \t/why\n', { type: 'why' }],
  ])('parses valid command %j', (input, command) => {
    expect(parseQqGovernanceCommand(input)).toEqual({ status: 'valid', command });
  });

  it('accepts memory IDs at both length boundaries', () => {
    const oneCharacterId = 'A';
    const maximumLengthId = `A${'b'.repeat(127)}`;

    expect(parseQqGovernanceCommand(`/memory forget ${oneCharacterId}`)).toEqual({
      status: 'valid',
      command: { type: 'memory_forget', memoryId: oneCharacterId },
    });
    expect(parseQqGovernanceCommand(`/memory forget ${maximumLengthId}`)).toEqual({
      status: 'valid',
      command: { type: 'memory_forget', memoryId: maximumLengthId },
    });
  });

  it.each([
    '/memory forget',
    '/memory forget id extra',
    '/memory forget .leading-dot',
    '/memory forget :leading-colon',
    '/memory forget -leading-hyphen',
    '/memory forget unsafe/id',
    '/memory forget unicode-\u6c49',
    `/memory forget A${'b'.repeat(128)}`,
    '/memory summary',
    '/memory summary unknown',
    '/memory summary STATUS',
    '/memory summary status extra',
    '/memory unknown',
    '/memory /why',
  ])('recognizes malformed memory-family command %j', (input) => {
    expect(parseQqGovernanceCommand(input)).toEqual({
      status: 'invalid',
      family: 'memory',
      reason: 'invalid_syntax',
    });
  });

  it.each(['/why now', '/why extra arguments', '/why /memory'])(
    'recognizes malformed why-family command %j',
    (input) => {
      expect(parseQqGovernanceCommand(input)).toEqual({
        status: 'invalid',
        family: 'why',
        reason: 'invalid_syntax',
      });
    },
  );

  it.each([
    '',
    '   \t\n',
    'hello',
    'please run /memory',
    '!memory',
    '!/memory',
    '/memoryless',
    '/memory/forget id',
    '/memory?',
    '/whyever',
    '/why?',
    '/Memory',
    '/WHY',
  ])('does not recognize non-command input %j', (input) => {
    expect(parseQqGovernanceCommand(input)).toEqual({ status: 'not_command' });
  });

  it('accepts valid raw input at exactly 512 characters', () => {
    const input = `/why${' '.repeat(508)}`;

    expect(input).toHaveLength(512);
    expect(parseQqGovernanceCommand(input)).toEqual({
      status: 'valid',
      command: { type: 'why' },
    });
  });

  it.each([
    [`/memory${' '.repeat(506)}`, 'memory'],
    [`/why${' '.repeat(509)}`, 'why'],
  ] as const)('rejects overlong recognized %s-family input without echoing it', (input, family) => {
    const result = parseQqGovernanceCommand(input);

    expect(input).toHaveLength(513);
    expect(result).toEqual({ status: 'invalid', family, reason: 'input_too_long' });
    expect(JSON.stringify(result)).not.toContain(input);
  });

  it('keeps overlong narrative text and prefix collisions out of the command path', () => {
    expect(parseQqGovernanceCommand(`narrative ${'x'.repeat(600)}`)).toEqual({
      status: 'not_command',
    });
    expect(parseQqGovernanceCommand(`/memoryless${'x'.repeat(600)}`)).toEqual({
      status: 'not_command',
    });
    expect(parseQqGovernanceCommand(`${' '.repeat(505)}/memoryless`)).toEqual({
      status: 'not_command',
    });
  });

  it.each([
    [`${' '.repeat(509)}/memory`, 'memory'],
    [`${'\t'.repeat(510)}/why`, 'why'],
  ] as const)(
    'recognizes overlong %s-family input after leading whitespace',
    (input, family) => {
      expect(parseQqGovernanceCommand(input)).toEqual({
        status: 'invalid',
        family,
        reason: 'input_too_long',
      });
    },
  );

  it('does not expose malformed input in invalid results', () => {
    const rawInput = '/memory forget unsafe/value';
    const result = parseQqGovernanceCommand(rawInput);

    expect(result).toEqual({
      status: 'invalid',
      family: 'memory',
      reason: 'invalid_syntax',
    });
    expect(JSON.stringify(result)).not.toContain(rawInput);
  });
});
