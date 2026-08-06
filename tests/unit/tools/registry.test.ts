import { beforeEach, describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry';
import { MIN_TOOL_OUTPUT_BYTES } from '../../../src/tools/output-limit';
import type { SandboxPolicy, ToolRegistryEntry } from '../../../src/types/tool';

function createSandboxPolicy(
  network: SandboxPolicy['network'] = 'none',
  maxRuntimeMs = 1000,
): SandboxPolicy {
  return {
    filesystem: 'none',
    network,
    execution: 'in_process',
    maxRuntimeMs,
  };
}

describe('ToolRegistry', () => {
  const registry = new ToolRegistry();

  describe('register', () => {
    it('should register a tool', () => {
      registry.register({
        name: 'echo',
        version: '1.0.0',
        description: 'Echo input back',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['owner', 'admin', 'user'],
          allowedContexts: ['private_chat', 'group_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: createSandboxPolicy(),
        outputSensitivity: 'normal',
        piSchema: {
          input: { type: 'object', properties: { text: { type: 'string' } } },
          output: { type: 'object', properties: { echo: { type: 'string' } } },
        },
        handler: async () => ({ ok: true }),
      });

      const tool = registry.get('echo');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('echo');
    });

    it('should retain a deeply frozen metadata snapshot while preserving its handler', async () => {
      const snapshotRegistry = new ToolRegistry();
      const handler: ToolRegistryEntry['handler'] = async () => ({ handled: true });
      const entry: ToolRegistryEntry = {
        name: 'registered-snapshot',
        version: '1.0.0',
        description: 'Metadata snapshot regression',
        capabilities: ['platform_admin'],
        permissions: {
          allowedActors: ['owner'],
          allowedContexts: ['admin_cli'],
        },
        evaluatorPolicy: 'required',
        auditLevel: 'full',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 1000,
          maxOutputBytes: MIN_TOOL_OUTPUT_BYTES,
        },
        outputSensitivity: 'sensitive',
        piSchema: {
          input: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
          output: { type: 'object', properties: { handled: { type: 'boolean' } } },
        },
        handler,
      };

      snapshotRegistry.register(entry);

      entry.permissions.allowedActors.push('user');
      entry.permissions.allowedContexts.push('private_chat');
      entry.evaluatorPolicy = 'bypass';
      entry.sandboxPolicy.execution = 'docker';
      entry.sandboxPolicy.maxRuntimeMs = undefined;
      entry.sandboxPolicy.maxOutputBytes = undefined;
      entry.capabilities.push('network');
      const originalInputSchema = entry.piSchema.input as {
        properties: { command: { type: string } };
      };
      originalInputSchema.properties.command.type = 'number';

      const retrieved = snapshotRegistry.get('registered-snapshot');
      const listed = snapshotRegistry.list()[0];
      const all = snapshotRegistry.getAll()[0];
      if (!retrieved || !listed || !all) {
        throw new Error('Expected registered-snapshot metadata');
      }

      expect(Object.isFrozen(retrieved)).toBe(true);
      expect(Object.isFrozen(retrieved.permissions.allowedActors)).toBe(true);
      expect(Object.isFrozen(retrieved.sandboxPolicy)).toBe(true);
      expect(Object.isFrozen(retrieved.piSchema.input)).toBe(true);

      expect(Reflect.set(retrieved.permissions.allowedActors, 1, 'user')).toBe(false);
      expect(Reflect.set(retrieved.permissions.allowedContexts, 1, 'private_chat')).toBe(false);
      expect(Reflect.set(listed, 'evaluatorPolicy', 'bypass')).toBe(false);
      expect(Reflect.set(listed.sandboxPolicy, 'execution', 'docker')).toBe(false);
      expect(Reflect.set(listed.sandboxPolicy, 'maxRuntimeMs', undefined)).toBe(false);
      expect(Reflect.set(listed.sandboxPolicy, 'maxOutputBytes', undefined)).toBe(false);
      expect(Reflect.set(all.capabilities, 1, 'network')).toBe(false);
      const listedInputSchema = all.piSchema.input as {
        properties: { command: { type: string } };
      };
      expect(Reflect.set(listedInputSchema.properties.command, 'type', 'number')).toBe(false);

      expect(snapshotRegistry.checkPermission(
        'registered-snapshot',
        { actorClass: 'owner' },
        'admin_cli',
      )).toBe(true);
      expect(snapshotRegistry.checkPermission(
        'registered-snapshot',
        { actorClass: 'user' },
        'admin_cli',
      )).toBe(false);
      expect(snapshotRegistry.checkPermission(
        'registered-snapshot',
        { actorClass: 'owner' },
        'private_chat',
      )).toBe(false);
      expect(snapshotRegistry.requiresEvaluator('registered-snapshot')).toBe(true);
      expect(snapshotRegistry.get('registered-snapshot')).toMatchObject({
        capabilities: ['platform_admin'],
        sandboxPolicy: {
          execution: 'in_process',
          maxRuntimeMs: 1000,
          maxOutputBytes: MIN_TOOL_OUTPUT_BYTES,
        },
        piSchema: {
          input: {
            properties: { command: { type: 'string' } },
          },
        },
      });
      const registeredHandler = snapshotRegistry.getHandler('registered-snapshot');
      expect(registeredHandler).toBe(handler);
      if (!registeredHandler) {
        throw new Error('Expected registered-snapshot handler');
      }
      await expect(registeredHandler({
        toolCallId: 'tool-call-snapshot',
        turnId: 'turn-snapshot',
        toolName: 'registered-snapshot',
        signal: new AbortController().signal,
        input: {},
        actor: { actorClass: 'owner' },
        context: 'admin_cli',
      })).resolves.toEqual({ handled: true });
    });

    it('should throw on duplicate registration', () => {
      registry.register({
        name: 'duplicate',
        version: '1.0.0',
        description: 'Test',
        capabilities: [],
        permissions: { allowedActors: [], allowedContexts: [] },
        evaluatorPolicy: 'bypass',
        auditLevel: 'none',
        sandboxPolicy: createSandboxPolicy(),
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      expect(() =>
        registry.register({
          name: 'duplicate',
          version: '1.0.0',
          description: 'Test 2',
          capabilities: [],
          permissions: { allowedActors: [], allowedContexts: [] },
          evaluatorPolicy: 'bypass',
          auditLevel: 'none',
          sandboxPolicy: createSandboxPolicy(),
          outputSensitivity: 'normal',
          piSchema: { input: {}, output: {} },
          handler: async () => ({ ok: true }),
        })
      ).toThrow(/already registered/i);
    });

    it('should reject unresolved string handlers', () => {
      const invalidEntry = {
        name: 'unresolved',
        version: '1.0.0',
        description: 'Unresolved handler',
        capabilities: [],
        permissions: { allowedActors: [], allowedContexts: [] },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: { filesystem: 'none', network: 'none', execution: 'none' },
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: 'module/path',
      };

      expect(() => registry.register(invalidEntry as never)).toThrow(/resolved function handler/i);
    });

    it.each([
      ['missing', undefined],
      ['unknown', 'worker_thread'],
    ])('should reject %s sandbox execution metadata', (_label, execution) => {
      const invalidEntry = {
        name: `invalid-execution-${String(execution)}`,
        version: '1.0.0',
        description: 'Invalid sandbox execution metadata',
        capabilities: ['read_context'],
        permissions: { allowedActors: ['user'], allowedContexts: ['private_chat'] },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          ...(execution === undefined ? {} : { execution }),
        },
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      } as unknown as ToolRegistryEntry;

      expect(() => new ToolRegistry().register(invalidEntry))
        .toThrow(/sandboxPolicy\.execution/);
    });

    it.each([
      ['maxRuntimeMs', 0],
      ['maxRuntimeMs', -1],
      ['maxRuntimeMs', 1.5],
      ['maxRuntimeMs', Number.NaN],
      ['maxRuntimeMs', Number.POSITIVE_INFINITY],
      ['maxRuntimeMs', 2_147_483_648],
      ['maxRuntimeMs', Number.MAX_SAFE_INTEGER],
      ['maxRuntimeMs', Number.MAX_SAFE_INTEGER + 1],
      ['maxOutputBytes', 0],
      ['maxOutputBytes', -1],
      ['maxOutputBytes', 1.5],
      ['maxOutputBytes', Number.NaN],
      ['maxOutputBytes', Number.POSITIVE_INFINITY],
      ['maxOutputBytes', Number.MAX_SAFE_INTEGER + 1],
      ['maxOutputBytes', 64],
      ['maxOutputBytes', MIN_TOOL_OUTPUT_BYTES - 1],
    ] as const)('should reject invalid sandbox limit metadata for %s=%s', (field, value) => {
      const invalidRegistry = new ToolRegistry();
      const sandboxPolicy: SandboxPolicy = {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
        [field]: value,
      };

      expect(() => invalidRegistry.register({
        name: `invalid-${field}-${String(value)}`,
        version: '1.0.0',
        description: 'Invalid sandbox limit',
        capabilities: ['read_context'],
        permissions: { allowedActors: ['user'], allowedContexts: ['private_chat'] },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy,
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      })).toThrow(new RegExp(field));
    });

    it('should accept exact positive and output-envelope limit boundaries', () => {
      const boundaryRegistry = new ToolRegistry();

      boundaryRegistry.register({
        name: 'valid-limit-boundaries',
        version: '1.0.0',
        description: 'Valid sandbox limit boundaries',
        capabilities: ['read_context'],
        permissions: { allowedActors: ['user'], allowedContexts: ['private_chat'] },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 1,
          maxOutputBytes: MIN_TOOL_OUTPUT_BYTES,
        },
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      expect(boundaryRegistry.get('valid-limit-boundaries')).toBeDefined();

      boundaryRegistry.register({
        name: 'valid-runtime-upper-boundary',
        version: '1.0.0',
        description: 'Valid runtime timer boundary',
        capabilities: ['read_context'],
        permissions: { allowedActors: ['user'], allowedContexts: ['private_chat'] },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 2_147_483_647,
        },
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      expect(boundaryRegistry.get('valid-runtime-upper-boundary')).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return undefined for unknown tool', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should return registered tool', () => {
      registry.register({
        name: 'search',
        version: '1.0.0',
        description: 'Search',
        capabilities: ['network'],
        permissions: { allowedActors: ['user'], allowedContexts: ['private_chat'] },
        evaluatorPolicy: 'required',
        auditLevel: 'summary',
        sandboxPolicy: createSandboxPolicy('allowed', 5000),
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      const tool = registry.get('search');
      expect(tool?.name).toBe('search');
      expect(tool?.capabilities).toContain('network');
    });
  });

  describe('list', () => {
    it('should list all registered tools', () => {
      const freshRegistry = new ToolRegistry();

      freshRegistry.register({
        name: 'tool1',
        version: '1.0.0',
        description: 'Tool 1',
        capabilities: [],
        permissions: { allowedActors: [], allowedContexts: [] },
        evaluatorPolicy: 'bypass',
        auditLevel: 'none',
        sandboxPolicy: createSandboxPolicy(),
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      freshRegistry.register({
        name: 'tool2',
        version: '1.0.0',
        description: 'Tool 2',
        capabilities: [],
        permissions: { allowedActors: [], allowedContexts: [] },
        evaluatorPolicy: 'bypass',
        auditLevel: 'none',
        sandboxPolicy: createSandboxPolicy(),
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      const tools = freshRegistry.list();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(['tool1', 'tool2']);
    });
  });

  describe('enablement lifecycle', () => {
    it('disables new calls, re-enables, and unregisters without leaving state', async () => {
      const lifecycleRegistry = new ToolRegistry();
      const handler: ToolRegistryEntry['handler'] = async () => ({ ok: true });
      lifecycleRegistry.register({
        name: 'lifecycle-tool',
        version: '1.0.0',
        description: 'Enablement lifecycle',
        capabilities: ['read_context'],
        permissions: { allowedActors: ['owner'], allowedContexts: ['private_chat'] },
        evaluatorPolicy: 'required',
        auditLevel: 'summary',
        sandboxPolicy: createSandboxPolicy(),
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler,
      });

      expect(lifecycleRegistry.isEnabled('lifecycle-tool')).toBe(true);
      expect(lifecycleRegistry.checkPermission(
        'lifecycle-tool',
        { actorClass: 'owner' },
        'private_chat',
      )).toBe(true);
      expect(lifecycleRegistry.requiresEvaluator('lifecycle-tool')).toBe(true);
      expect(lifecycleRegistry.getHandler('lifecycle-tool')).toBe(handler);

      lifecycleRegistry.disable('lifecycle-tool');
      expect(lifecycleRegistry.isEnabled('lifecycle-tool')).toBe(false);
      expect(lifecycleRegistry.get('lifecycle-tool')).toBeDefined();
      expect(lifecycleRegistry.checkPermission(
        'lifecycle-tool',
        { actorClass: 'owner' },
        'private_chat',
      )).toBe(false);
      expect(lifecycleRegistry.requiresEvaluator('lifecycle-tool')).toBe(false);
      expect(lifecycleRegistry.getHandler('lifecycle-tool')).toBeUndefined();

      lifecycleRegistry.enable('lifecycle-tool');
      expect(lifecycleRegistry.isEnabled('lifecycle-tool')).toBe(true);
      expect(lifecycleRegistry.getHandler('lifecycle-tool')).toBe(handler);

      expect(lifecycleRegistry.unregister('lifecycle-tool')).toBe(true);
      expect(lifecycleRegistry.unregister('lifecycle-tool')).toBe(false);
      expect(lifecycleRegistry.get('lifecycle-tool')).toBeUndefined();
      expect(lifecycleRegistry.isEnabled('lifecycle-tool')).toBe(false);
      expect(() => lifecycleRegistry.disable('lifecycle-tool')).toThrow('not registered');
    });
  });

  describe('checkPermission', () => {
    let restrictedRegistry: ToolRegistry;

    beforeEach(() => {
      restrictedRegistry = new ToolRegistry();
      restrictedRegistry.register({
        name: 'restricted',
        version: '1.0.0',
        description: 'Restricted tool',
        capabilities: ['platform_admin'],
        permissions: {
          allowedActors: ['owner'],
          allowedContexts: ['admin_cli'],
        },
        evaluatorPolicy: 'required',
        auditLevel: 'full',
        sandboxPolicy: createSandboxPolicy(),
        outputSensitivity: 'sensitive',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });
    });

    it('should allow owner in admin_cli', () => {
      const allowed = restrictedRegistry.checkPermission('restricted', {
        actorClass: 'owner',
        canonicalUserId: 'user-001',
      }, 'admin_cli');

      expect(allowed).toBe(true);
    });

    it('should deny user in group_chat', () => {
      const allowed = restrictedRegistry.checkPermission('restricted', {
        actorClass: 'user',
        canonicalUserId: 'user-002',
      }, 'group_chat');

      expect(allowed).toBe(false);
    });

    it('should deny admin in wrong context', () => {
      const allowed = restrictedRegistry.checkPermission('restricted', {
        actorClass: 'admin',
        canonicalUserId: 'user-003',
      }, 'private_chat');

      expect(allowed).toBe(false);
    });

    it('should enforce user allow and deny lists after actor and context checks', () => {
      restrictedRegistry.register({
        name: 'user_scoped',
        version: '1.0.0',
        description: 'User scoped tool',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['user'],
          allowedContexts: ['private_chat'],
          allowedUserIds: ['user-allowed'],
          deniedUserIds: ['user-denied'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: createSandboxPolicy(),
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      expect(restrictedRegistry.checkPermission(
        'user_scoped',
        { actorClass: 'user', canonicalUserId: 'user-allowed' },
        'private_chat',
      )).toBe(true);
      expect(restrictedRegistry.checkPermission(
        'user_scoped',
        { actorClass: 'user', canonicalUserId: 'user-denied' },
        'private_chat',
      )).toBe(false);
      expect(restrictedRegistry.checkPermission(
        'user_scoped',
        { actorClass: 'user', canonicalUserId: 'user-other' },
        'private_chat',
      )).toBe(false);
      expect(restrictedRegistry.checkPermission(
        'user_scoped',
        { actorClass: 'user' },
        'private_chat',
      )).toBe(false);

      restrictedRegistry.register({
        name: 'group_scoped',
        version: '1.0.0',
        description: 'Group scoped tool',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['user'],
          allowedContexts: ['group_chat'],
          allowedGroupIds: ['group-allowed'],
          deniedGroupIds: ['group-denied'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: createSandboxPolicy(),
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      expect(restrictedRegistry.checkPermission(
        'group_scoped',
        { actorClass: 'user', canonicalUserId: 'user-allowed', groupId: 'group-allowed' },
        'group_chat',
      )).toBe(true);
      expect(restrictedRegistry.checkPermission(
        'group_scoped',
        { actorClass: 'user', canonicalUserId: 'user-allowed', groupId: 'group-denied' },
        'group_chat',
      )).toBe(false);
      expect(restrictedRegistry.checkPermission(
        'group_scoped',
        { actorClass: 'user', canonicalUserId: 'user-allowed', groupId: 'group-other' },
        'group_chat',
      )).toBe(false);
      expect(restrictedRegistry.checkPermission(
        'group_scoped',
        { actorClass: 'user', canonicalUserId: 'user-allowed' },
        'group_chat',
      )).toBe(false);
    });
  });
});
