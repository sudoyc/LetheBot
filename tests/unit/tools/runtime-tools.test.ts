import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeToolsTool,
  type RuntimeToolsOutput,
} from '../../../src/tools/builtins/runtime-tools';
import { ToolRegistry } from '../../../src/tools/registry';
import type {
  ActorClass,
  InvocationContext,
  ToolCapability,
  ToolHandlerRequest,
  ToolRegistryEntry,
} from '../../../src/types/tool';

const ALL_CAPABILITIES: ToolCapability[] = [
  'read_context',
  'read_local',
  'write_local',
  'network',
  'shell_exec',
  'long_running',
  'sends_message',
  'modifies_memory',
  'external_side_effect',
  'credential_access',
  'platform_admin',
];

describe('built-in runtime.tools tool', () => {
  it('declares exact read-only metadata and private owner/admin permissions', () => {
    const registry = new ToolRegistry();
    const entry = createRuntimeToolsTool({ registry });
    registry.register(entry);

    expect(entry).toMatchObject({
      name: 'runtime.tools',
      capabilities: ['read_local'],
      permissions: {
        allowedActors: ['owner', 'admin'],
        allowedContexts: ['private_chat'],
      },
      evaluatorPolicy: 'bypass',
      auditLevel: 'redacted_full',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
        maxRuntimeMs: 1000,
        maxOutputBytes: 8192,
      },
      outputSensitivity: 'secret_possible',
      piSchema: {
        input: {
          required: [],
          additionalProperties: false,
        },
        output: {
          required: [
            'registeredCount',
            'availableHereCount',
            'listedCount',
            'tools',
            'optionalConfiguration',
            'truncated',
            'redactionApplied',
          ],
          additionalProperties: false,
        },
      },
    });
    expect(registry.checkPermission(
      'runtime.tools',
      { actorClass: 'owner' },
      'private_chat',
    )).toBe(true);
    expect(registry.checkPermission(
      'runtime.tools',
      { actorClass: 'admin' },
      'private_chat',
    )).toBe(true);
    expect(registry.checkPermission(
      'runtime.tools',
      { actorClass: 'trusted_user' },
      'private_chat',
    )).toBe(false);
    expect(registry.checkPermission(
      'runtime.tools',
      { actorClass: 'owner' },
      'group_chat',
    )).toBe(false);
  });

  it('returns deterministic registered and current-context inventory without config values', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('memory.search'));
    registry.register(fakeTool('group.recent_summary', {
      allowedContexts: ['group_chat'],
    }));
    registry.register(fakeTool('workspace.list', {
      sandbox: { allowedPaths: ['/tmp/api_key=sk-workspace-root-secret-abcdefghijklmnopqrstuvwxyz'] },
    }));
    registry.register(fakeTool('workspace.read_text'));
    registry.register(fakeTool('web.fetch_text', {
      sandbox: {
        allowedOrigins: [
          'https://private-origin.example.invalid',
          'https://second-origin.example.invalid:8443',
        ],
      },
    }));
    registry.register(createRuntimeToolsTool({ registry }));
    const before = registry.list().map((entry) => entry.name);

    const output = await registry.get('runtime.tools')?.handler(toolRequest({}));
    const catalog = output as RuntimeToolsOutput;

    expect(catalog).toEqual({
      registeredCount: 6,
      availableHereCount: 5,
      listedCount: 6,
      tools: [
        {
          name: 'group.recent_summary',
          capabilities: ['read_local'],
          availableHere: false,
          enabled: true,
          evaluatorRequired: false,
        },
        {
          name: 'memory.search',
          capabilities: ['read_local'],
          availableHere: true,
          enabled: true,
          evaluatorRequired: false,
        },
        {
          name: 'runtime.tools',
          capabilities: ['read_local'],
          availableHere: true,
          enabled: true,
          evaluatorRequired: false,
        },
        {
          name: 'web.fetch_text',
          capabilities: ['read_local'],
          availableHere: true,
          enabled: true,
          evaluatorRequired: false,
        },
        {
          name: 'workspace.list',
          capabilities: ['read_local'],
          availableHere: true,
          enabled: true,
          evaluatorRequired: false,
        },
        {
          name: 'workspace.read_text',
          capabilities: ['read_local'],
          availableHere: true,
          enabled: true,
          evaluatorRequired: false,
        },
      ],
      optionalConfiguration: {
        workspace: 'enabled',
        webFetch: 'enabled',
        webFetchAllowedOriginCount: 2,
      },
      truncated: false,
      redactionApplied: false,
    });
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('/tmp/');
    expect(serialized).not.toContain('private-origin');
    expect(serialized).not.toContain('second-origin');
    expect(registry.list().map((entry) => entry.name)).toEqual(before);
  });

  it('reports disabled and inconsistent optional registration without exposing values', async () => {
    const disabledRegistry = new ToolRegistry();
    disabledRegistry.register(createRuntimeToolsTool({ registry: disabledRegistry }));

    await expect(disabledRegistry.get('runtime.tools')?.handler(toolRequest({})))
      .resolves.toMatchObject({
        optionalConfiguration: {
          workspace: 'disabled',
          webFetch: 'disabled',
          webFetchAllowedOriginCount: 0,
        },
      });

    const inconsistentRegistry = new ToolRegistry();
    inconsistentRegistry.register(fakeTool('workspace.list'));
    inconsistentRegistry.register(fakeTool('web.fetch_text', {
      sandbox: { allowedOrigins: [] },
    }));
    inconsistentRegistry.register(createRuntimeToolsTool({ registry: inconsistentRegistry }));

    await expect(inconsistentRegistry.get('runtime.tools')?.handler(toolRequest({})))
      .resolves.toMatchObject({
        optionalConfiguration: {
          workspace: 'inconsistent',
          webFetch: 'inconsistent',
          webFetchAllowedOriginCount: null,
        },
      });
  });

  it('keeps disabled tools inspectable while excluding them from current availability', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('memory.search'));
    registry.register(fakeTool('workspace.list'));
    registry.register(fakeTool('workspace.read_text'));
    registry.register(fakeTool('web.fetch_text', {
      sandbox: { allowedOrigins: ['https://docs.example.invalid'] },
    }));
    registry.register(createRuntimeToolsTool({ registry }));
    for (const name of [
      'memory.search',
      'workspace.list',
      'workspace.read_text',
      'web.fetch_text',
    ]) {
      registry.disable(name);
    }

    const catalog = await registry.get('runtime.tools')?.handler(toolRequest({})) as RuntimeToolsOutput;

    expect(catalog.registeredCount).toBe(5);
    expect(catalog.availableHereCount).toBe(1);
    expect(catalog.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'memory.search', enabled: false, availableHere: false }),
      expect.objectContaining({ name: 'runtime.tools', enabled: true, availableHere: true }),
    ]));
    expect(catalog.optionalConfiguration).toEqual({
      workspace: 'disabled',
      webFetch: 'disabled',
      webFetchAllowedOriginCount: 1,
    });
  });

  it('redacts and bounds a large catalog after deterministic sorting', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool(
      Array.from({ length: 20 }, () => 'qq-12345').join('.'),
      { capabilities: ALL_CAPABILITIES },
    ));
    for (let index = 0; index < 40; index += 1) {
      registry.register(fakeTool(
        `tool.${String(index).padStart(2, '0')}.${'x'.repeat(120)}`,
        { capabilities: ALL_CAPABILITIES },
      ));
    }
    registry.register(createRuntimeToolsTool({ registry }));

    const output = await registry.get('runtime.tools')?.handler(toolRequest({}));
    const catalog = output as RuntimeToolsOutput;
    const serialized = JSON.stringify(catalog);

    expect(catalog.registeredCount).toBe(42);
    expect(catalog.listedCount).toBe(catalog.tools.length);
    expect(catalog.tools.length).toBeLessThanOrEqual(32);
    expect(catalog.truncated).toBe(true);
    expect(catalog.redactionApplied).toBe(true);
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain('12345');
    expect(catalog.tools.every((tool) => tool.name.length <= 128)).toBe(true);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8192);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(
      [...catalog.tools.map((tool) => tool.name)].sort(),
    );
  });

  it.each([null, [], '', { unexpected: true }])(
    'rejects invalid input before registry inspection: %j',
    async (input) => {
      const registry = new ToolRegistry();
      const list = vi.spyOn(registry, 'list');
      const entry = createRuntimeToolsTool({ registry });

      await expect(entry.handler(toolRequest(input)))
        .rejects.toThrow('runtime.tools input must be an empty object');
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('uses fixed aborted and unavailable failures without leaking diagnostics', async () => {
    const registry = new ToolRegistry();
    const entry = createRuntimeToolsTool({ registry });
    const controller = new AbortController();
    controller.abort();

    await expect(entry.handler(toolRequest({}, controller.signal)))
      .rejects.toThrow('runtime.tools aborted');

    vi.spyOn(registry, 'list').mockImplementation(() => {
      throw new Error('api_key=sk-runtime-tools-secret-abcdefghijklmnopqrstuvwxyz qq-1234567890');
    });
    const failure = await captureFailure(entry.handler(toolRequest({})));
    expect(failure.message).toBe('runtime.tools is unavailable');
    expect(failure.message).not.toContain('runtime-tools-secret');
    expect(failure.message).not.toContain('1234567890');
  });
});

function fakeTool(
  name: string,
  options: {
    allowedActors?: ActorClass[];
    allowedContexts?: InvocationContext[];
    capabilities?: ToolCapability[];
    sandbox?: Partial<ToolRegistryEntry['sandboxPolicy']>;
  } = {},
): ToolRegistryEntry {
  return {
    name,
    version: '1.0.0',
    description: 'Synthetic catalog entry',
    capabilities: options.capabilities ?? ['read_local'],
    permissions: {
      allowedActors: options.allowedActors ?? ['owner'],
      allowedContexts: options.allowedContexts ?? ['private_chat'],
    },
    evaluatorPolicy: 'bypass',
    auditLevel: 'summary',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'none',
      execution: 'in_process',
      ...options.sandbox,
    },
    outputSensitivity: 'normal',
    piSchema: {
      input: { type: 'object', properties: {} },
      output: { type: 'object', properties: {} },
    },
    handler: async () => ({}),
  };
}

function toolRequest(
  input: unknown,
  signal = new AbortController().signal,
): ToolHandlerRequest {
  return {
    toolCallId: 'tool-call-runtime-tools',
    turnId: 'turn-runtime-tools',
    toolName: 'runtime.tools',
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
  throw new Error('Expected runtime.tools to fail');
}
