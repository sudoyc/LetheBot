import { describe, it, expect, vi } from 'vitest';
import { convertToolsToPiFormat } from '../../../src/pi/tool-adapter';
import type { ToolHandler, ToolRegistryEntry } from '../../../src/types/tool';

function createEntry(name: unknown): ToolRegistryEntry {
  const handler: ToolHandler = async () => 'ok';
  return {
    name: name as string,
    version: '1.0.0',
    description: 'Test tool',
    capabilities: ['read_context'],
    permissions: {
      allowedActors: ['user'],
      allowedContexts: ['private_chat'],
    },
    evaluatorPolicy: 'bypass',
    auditLevel: 'summary',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'none',
      execution: 'none',
    },
    outputSensitivity: 'normal',
    piSchema: {
      input: { type: 'object', properties: {} },
      output: { type: 'object', properties: {} },
    },
    handler,
  };
}

describe('tool-adapter diagnostics', () => {
  it('redacts missing-handler warning tool names before direct console output', () => {
    const rawSecret = 'sk-tooladapter-warning-secret-should-not-leak';
    const rawPlatformId = 'qq-1234567890';
    const entry = createEntry(`memory.search api_key=${rawSecret} target=${rawPlatformId}`);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const tools = convertToolsToPiFormat([entry], () => undefined, {
      turnId: 'turn-tool-adapter-warning',
      actor: { actorClass: 'user' },
      invocationContext: 'private_chat',
    });

    expect(tools).toEqual([]);
    const diagnostic = consoleWarn.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(diagnostic).toContain('[tool-adapter] No handler found for tool:');
    expect(diagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(diagnostic).toContain('[REDACTED:platform_id]');
    expect(diagnostic).not.toContain(rawSecret);
    expect(diagnostic).not.toContain(rawPlatformId);

    consoleWarn.mockRestore();
  });

  it('redacts conversion errors before direct console output', () => {
    const rawSecret = 'sk-tooladapter-error-secret-should-not-leak';
    const rawPlatformId = 'qq-1234567890';
    const entry = createEntry({
      toString: () => `memory.bad api_key=${rawSecret} target=${rawPlatformId}`,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const tools = convertToolsToPiFormat([entry], () => entry.handler, {
      turnId: 'turn-tool-adapter-error',
      actor: { actorClass: 'user' },
      invocationContext: 'private_chat',
    });

    expect(tools).toEqual([]);
    const diagnostic = consoleError.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(diagnostic).toContain('[tool-adapter] Failed to convert tool');
    expect(diagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(diagnostic).toContain('[REDACTED:platform_id]');
    expect(diagnostic).toContain('[REDACTED:stack]');
    expect(diagnostic).not.toContain(rawSecret);
    expect(diagnostic).not.toContain(rawPlatformId);
    expect(diagnostic).not.toContain('src/pi/tool-adapter.ts');
    expect(diagnostic).not.toContain('node_modules');
    expect(diagnostic).not.toContain('    at ');

    consoleError.mockRestore();
  });

  it('preserves both markers for adjacent secret/platform direct console diagnostics', () => {
    const rawAdjacent = 'sk-tooladapter-adjacent-secret-qq-1234567890';
    const rawPlatformId = 'qq-1234567890';
    const rawNumericPlatformId = '1234567890';
    const warningEntry = createEntry(`memory.search target=${rawAdjacent}`);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const missingHandlerTools = convertToolsToPiFormat([warningEntry], () => undefined, {
      turnId: 'turn-tool-adapter-adjacent-warning',
      actor: { actorClass: 'user' },
      invocationContext: 'private_chat',
    });

    expect(missingHandlerTools).toEqual([]);
    const warningDiagnostic = consoleWarn.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(warningDiagnostic).toContain('[tool-adapter] No handler found for tool:');
    expect(warningDiagnostic).toContain('[REDACTED:openai_like_api_key]');
    expect(warningDiagnostic).toContain('[REDACTED:platform_id]');
    expect(warningDiagnostic).not.toContain(rawAdjacent);
    expect(warningDiagnostic).not.toContain(rawPlatformId);
    expect(warningDiagnostic).not.toContain(rawNumericPlatformId);

    consoleWarn.mockRestore();

    const errorName = {
      toString: () => `memory.bad target=${rawAdjacent}`,
      split: () => {
        throw new Error(`schema failure target=${rawAdjacent}`);
      },
    };
    const errorEntry = createEntry(errorName);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const conversionTools = convertToolsToPiFormat([errorEntry], () => errorEntry.handler, {
      turnId: 'turn-tool-adapter-adjacent-error',
      actor: { actorClass: 'user' },
      invocationContext: 'private_chat',
    });

    expect(conversionTools).toEqual([]);
    const errorDiagnostic = consoleError.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(errorDiagnostic).toContain('[tool-adapter] Failed to convert tool');
    expect(errorDiagnostic).toContain('[REDACTED:openai_like_api_key]');
    expect(errorDiagnostic).toContain('[REDACTED:platform_id]');
    expect(errorDiagnostic).toContain('[REDACTED:stack]');
    expect(errorDiagnostic).not.toContain(rawAdjacent);
    expect(errorDiagnostic).not.toContain(rawPlatformId);
    expect(errorDiagnostic).not.toContain(rawNumericPlatformId);
    expect(errorDiagnostic).not.toContain('src/pi/tool-adapter.ts');
    expect(errorDiagnostic).not.toContain('node_modules');
    expect(errorDiagnostic).not.toContain('    at ');

    consoleError.mockRestore();
  });

  it('preserves both markers for assignment-shaped adjacent direct console diagnostics', () => {
    const rawAdjacentAssignment = 'api_key=sk-tooladapter-assignment-adjacent-secret-qq-1234567890';
    const rawPlatformId = 'qq-1234567890';
    const rawNumericPlatformId = '1234567890';
    const warningEntry = createEntry(`memory.search target=${rawAdjacentAssignment}`);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const missingHandlerTools = convertToolsToPiFormat([warningEntry], () => undefined, {
      turnId: 'turn-tool-adapter-assignment-adjacent-warning',
      actor: { actorClass: 'user' },
      invocationContext: 'private_chat',
    });

    expect(missingHandlerTools).toEqual([]);
    const warningDiagnostic = consoleWarn.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(warningDiagnostic).toContain('[tool-adapter] No handler found for tool:');
    expect(warningDiagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(warningDiagnostic).toContain('[REDACTED:platform_id]');
    expect(warningDiagnostic).not.toContain(rawAdjacentAssignment);
    expect(warningDiagnostic).not.toContain(rawPlatformId);
    expect(warningDiagnostic).not.toContain(rawNumericPlatformId);

    consoleWarn.mockRestore();

    const errorName = {
      toString: () => `memory.bad target=${rawAdjacentAssignment}`,
      split: () => {
        throw new Error(`schema failure target=${rawAdjacentAssignment}`);
      },
    };
    const errorEntry = createEntry(errorName);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const conversionTools = convertToolsToPiFormat([errorEntry], () => errorEntry.handler, {
      turnId: 'turn-tool-adapter-assignment-adjacent-error',
      actor: { actorClass: 'user' },
      invocationContext: 'private_chat',
    });

    expect(conversionTools).toEqual([]);
    const errorDiagnostic = consoleError.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(errorDiagnostic).toContain('[tool-adapter] Failed to convert tool');
    expect(errorDiagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(errorDiagnostic).toContain('[REDACTED:platform_id]');
    expect(errorDiagnostic).toContain('[REDACTED:stack]');
    expect(errorDiagnostic).not.toContain(rawAdjacentAssignment);
    expect(errorDiagnostic).not.toContain(rawPlatformId);
    expect(errorDiagnostic).not.toContain(rawNumericPlatformId);
    expect(errorDiagnostic).not.toContain('src/pi/tool-adapter.ts');
    expect(errorDiagnostic).not.toContain('node_modules');
    expect(errorDiagnostic).not.toContain('    at ');

    consoleError.mockRestore();
  });
});
