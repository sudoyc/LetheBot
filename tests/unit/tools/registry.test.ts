import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry';

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
        sandboxPolicy: {
          networkAccess: false,
          filesystemAccess: false,
          maxExecutionTimeMs: 1000,
        },
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

    it('should throw on duplicate registration', () => {
      registry.register({
        name: 'duplicate',
        version: '1.0.0',
        description: 'Test',
        capabilities: [],
        permissions: { allowedActors: [], allowedContexts: [] },
        evaluatorPolicy: 'bypass',
        auditLevel: 'none',
        sandboxPolicy: { networkAccess: false, filesystemAccess: false, maxExecutionTimeMs: 1000 },
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
          sandboxPolicy: { networkAccess: false, filesystemAccess: false, maxExecutionTimeMs: 1000 },
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
        sandboxPolicy: { networkAccess: true, filesystemAccess: false, maxExecutionTimeMs: 5000 },
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
        sandboxPolicy: { networkAccess: false, filesystemAccess: false, maxExecutionTimeMs: 1000 },
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
        sandboxPolicy: { networkAccess: false, filesystemAccess: false, maxExecutionTimeMs: 1000 },
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      const tools = freshRegistry.list();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(['tool1', 'tool2']);
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
        sandboxPolicy: { networkAccess: false, filesystemAccess: false, maxExecutionTimeMs: 1000 },
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
  });
});
