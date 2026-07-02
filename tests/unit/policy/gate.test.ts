import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyGate } from '../../../src/policy/gate';
import { ToolRegistry } from '../../../src/tools/registry';

describe('PolicyGate', () => {
  let registry: ToolRegistry;
  let gate: PolicyGate;

  beforeEach(() => {
    registry = new ToolRegistry();
    gate = new PolicyGate(registry);

    registry.register({
      name: 'test_tool',
      version: '1.0.0',
      description: 'Test tool',
      capabilities: ['read_context'],
      permissions: {
        allowedActors: ['owner', 'admin', 'user'],
        allowedContexts: ['private_chat', 'group_chat'],
      },
      evaluatorPolicy: 'bypass',
      auditLevel: 'summary',
      sandboxPolicy: { networkAccess: false, filesystemAccess: false, maxExecutionTimeMs: 1000 },
      outputSensitivity: 'normal',
      piSchema: { input: {}, output: {} },
      handler: async () => ({ ok: true }),
    });
  });

  describe('checkToolCall', () => {
    it('should allow valid tool call', () => {
      const result = gate.checkToolCall({
        toolName: 'test_tool',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        context: 'private_chat',
      });

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should deny unknown tool', () => {
      const result = gate.checkToolCall({
        toolName: 'nonexistent',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        context: 'private_chat',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Unknown tool');
    });

    it('should deny unauthorized actor', () => {
      registry.register({
        name: 'admin_only',
        version: '1.0.0',
        description: 'Admin only',
        capabilities: ['platform_admin'],
        permissions: {
          allowedActors: ['owner', 'admin'],
          allowedContexts: ['admin_cli'],
        },
        evaluatorPolicy: 'required',
        auditLevel: 'full',
        sandboxPolicy: { networkAccess: false, filesystemAccess: false, maxExecutionTimeMs: 1000 },
        outputSensitivity: 'sensitive',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      const result = gate.checkToolCall({
        toolName: 'admin_only',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        context: 'admin_cli',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Permission denied');
    });

    it('should deny wrong context', () => {
      const result = gate.checkToolCall({
        toolName: 'test_tool',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        context: 'admin_cli',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Permission denied');
    });
  });

  describe('L0 policy enforcement', () => {
    it('should always enforce L0 policy regardless of evaluator bypass', () => {
      // L0 policy: evaluatorPolicy=bypass does NOT bypass permission checks
      registry.register({
        name: 'bypass_tool',
        version: '1.0.0',
        description: 'Tool with evaluator bypass',
        capabilities: ['shell_exec'],
        permissions: {
          allowedActors: ['owner'],
          allowedContexts: ['admin_cli'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: { networkAccess: false, filesystemAccess: false, maxExecutionTimeMs: 1000 },
        outputSensitivity: 'normal',
        piSchema: { input: {}, output: {} },
        handler: async () => ({ ok: true }),
      });

      const result = gate.checkToolCall({
        toolName: 'bypass_tool',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        context: 'group_chat',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Permission denied');
    });
  });
});
