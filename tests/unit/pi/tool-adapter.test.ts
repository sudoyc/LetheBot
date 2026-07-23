import { describe, it, expect, vi } from 'vitest';
import {
  convertToolsToPiFormat,
  createMockPiTool,
  toProviderToolName,
} from '../../../src/pi/tool-adapter';
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
      execution: 'in_process',
    },
    outputSensitivity: 'normal',
    piSchema: {
      input: { type: 'object', properties: {} },
      output: { type: 'object', properties: {} },
    },
    handler,
  };
}

describe('tool-adapter provider names', () => {
  it('preserves safe canonical names and deterministically aliases unsafe or overlong names', () => {
    const safeName = 'safe_Tool-01';
    const maxLengthSafeName = 'a'.repeat(64);

    expect(toProviderToolName(safeName)).toBe(safeName);
    expect(toProviderToolName(maxLengthSafeName)).toBe(maxLengthSafeName);

    for (const canonicalName of ['memory.search', 'a'.repeat(65), '工具.搜索']) {
      const providerName = toProviderToolName(canonicalName);
      expect(providerName).toBe(toProviderToolName(canonicalName));
      expect(providerName).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(providerName).not.toBe(canonicalName);
    }
  });

  it('uses the provider alias while preserving the canonical name for handler execution', async () => {
    const entry = createEntry('memory.search');
    const handler = vi.fn().mockResolvedValue('canonical handler result');
    entry.handler = handler;

    const [tool] = convertToolsToPiFormat([entry], () => handler, {
      turnId: 'turn-provider-alias',
      actor: { actorClass: 'user' },
      invocationContext: 'private_chat',
    });

    expect(tool?.name).toBe(toProviderToolName(entry.name));
    expect(tool?.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    entry.name = 'mutated.after_conversion';
    await tool?.execute('tc-provider-alias', {});
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'memory.search',
      turnId: 'turn-provider-alias',
    }));
  });

  it('fails the whole batch when two canonical names map to one provider name', () => {
    const unsafeEntry = createEntry('memory.search');
    const collidingSafeEntry = createEntry(toProviderToolName(unsafeEntry.name));

    expect(() => convertToolsToPiFormat(
      [unsafeEntry, collidingSafeEntry],
      (name) => name === unsafeEntry.name ? unsafeEntry.handler : collidingSafeEntry.handler,
      {
        turnId: 'turn-provider-alias-collision',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
      },
    )).toThrow(/provider tool name collision/i);
  });

  it('aliases unsafe names created through the mock Pi helper', () => {
    const tool = createMockPiTool('memory.search', 'Mock memory search', async () => 'ok');

    expect(tool.name).toBe(toProviderToolName('memory.search'));
    expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('tool-adapter diagnostics', () => {
  it.each(['none', 'subprocess', 'docker'] as const)(
    'does not expose a tool that declares unsupported %s execution',
    (execution) => {
      const entry = createEntry(`unsupported-${execution}`);
      entry.sandboxPolicy.execution = execution;

      const tools = convertToolsToPiFormat([entry], () => entry.handler, {
        turnId: `turn-unsupported-${execution}`,
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
      });

      expect(tools).toEqual([]);
    }
  );

  it('rechecks execution metadata before invoking a converted handler', async () => {
    const entry = createEntry('mutated-execution');
    const handler = vi.fn().mockResolvedValue('must not run');
    entry.handler = handler;
    const [tool] = convertToolsToPiFormat([entry], () => entry.handler, {
      turnId: 'turn-mutated-execution',
      actor: { actorClass: 'user' },
      invocationContext: 'private_chat',
    });
    entry.sandboxPolicy.execution = 'subprocess';

    await expect(tool?.execute('tc-mutated-execution', {}))
      .rejects.toThrow(/execution backend/i);
    expect(handler).not.toHaveBeenCalled();
  });

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

describe('tool-adapter cooperative runtime limits', () => {
  const context = {
    turnId: 'turn-tool-runtime',
    actor: { actorClass: 'user' as const },
    invocationContext: 'private_chat' as const,
  };

  it('rejects a pre-aborted call without invoking the handler or exposing its reason', async () => {
    const secret = 'sk-preaborted-tool-reason-should-not-leak';
    const handler = vi.fn().mockResolvedValue('must not run');
    const entry = createEntry('preaborted_tool');
    entry.handler = handler;
    entry.sandboxPolicy.maxRuntimeMs = 100;
    const [tool] = convertToolsToPiFormat([entry], () => entry.handler, context);
    const controller = new AbortController();
    controller.abort(new Error(`api_key=${secret}`));

    const error = await tool?.execute('tc-preaborted', {}, controller.signal).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Tool execution aborted');
    expect((error as Error).message).not.toContain(secret);
    expect(handler).not.toHaveBeenCalled();
  });

  it('forwards upstream abort, waits for settlement, and removes its listener', async () => {
    const abortReasonSecret = 'sk-upstream-abort-reason-should-not-leak';
    const cleanupSecret = 'sk-handler-cleanup-error-should-not-leak';
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    let handlerSignal: AbortSignal | undefined;
    let releaseHandler: (() => void) | undefined;
    const handler: ToolHandler = async (request) => {
      handlerSignal = request.signal;
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      throw new Error(`cleanup failed api_key=${cleanupSecret}`);
    };
    const entry = createEntry('upstream_abort_tool');
    entry.handler = handler;
    const [tool] = convertToolsToPiFormat([entry], () => entry.handler, context);
    let settled = false;
    const execution = tool?.execute('tc-upstream-abort', {}, controller.signal)
      .finally(() => {
        settled = true;
      });

    await Promise.resolve();
    controller.abort(new Error(`api_key=${abortReasonSecret}`));
    await Promise.resolve();

    expect(handlerSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    releaseHandler?.();
    const error = await execution?.catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Tool execution aborted');
    expect((error as Error).message).not.toContain(abortReasonSecret);
    expect((error as Error).message).not.toContain(cleanupSecret);
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('aborts at maxRuntimeMs, waits for settlement, and can be reused without a stale timer', async () => {
    vi.useFakeTimers();
    let invocation = 0;
    const handlerSignals: AbortSignal[] = [];
    let releaseFirst: (() => void) | undefined;
    const handler: ToolHandler = async (request) => {
      invocation += 1;
      handlerSignals.push(request.signal);
      if (invocation === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return 'late result must fail';
      }
      return 'reused successfully';
    };
    const entry = createEntry('runtime_limited_tool');
    entry.handler = handler;
    entry.sandboxPolicy.maxRuntimeMs = 100;
    const [tool] = convertToolsToPiFormat([entry], () => entry.handler, context);
    let firstSettled = false;
    const firstExecution = tool?.execute('tc-runtime-timeout', {}).finally(() => {
      firstSettled = true;
    });

    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(handlerSignals[0]?.aborted).toBe(true);
      expect(firstSettled).toBe(false);

      releaseFirst?.();
      const firstError = await firstExecution?.catch((caught) => caught);
      expect(firstError).toBeInstanceOf(Error);
      expect((firstError as Error).message).toBe('Tool runtime limit exceeded');
      expect(vi.getTimerCount()).toBe(0);

      const secondResult = await tool?.execute('tc-runtime-reuse', {});
      expect(secondResult?.content[0]).toEqual({ type: 'text', text: 'reused successfully' });
      expect(handlerSignals[1]?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(200);
      expect(handlerSignals[1]?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseFirst?.();
      await firstExecution?.catch(() => undefined);
      vi.useRealTimers();
    }
  });
});
