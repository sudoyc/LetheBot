import { describe, it, expect } from 'vitest';
import type { ToolRegistryEntry, ToolCallRequest, ToolCallResult, ToolCapability } from '../../../src/types/tool';

describe('Tool', () => {
  describe('ToolRegistryEntry', () => {
    it('should allow creating tool registry entry', () => {
      const entry: ToolRegistryEntry = {
        name: 'echo',
        version: '1.0.0',
        description: 'Echo tool',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['user'],
          allowedContexts: ['private_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'none',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
        },
        outputSensitivity: 'normal',
        piSchema: {
          input: {},
          output: {},
        },
        handler: 'echo-handler',
      };

      expect(entry.name).toBe('echo');
      expect(entry.capabilities).toContain('read_context');
    });

    it('should support all capability types', () => {
      const capabilities: ToolCapability[] = [
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

      capabilities.forEach((cap) => {
        const entry: ToolRegistryEntry = {
          name: 'test',
          version: '1.0.0',
          description: 'Test',
          capabilities: [cap],
          permissions: { allowedActors: ['user'], allowedContexts: ['private_chat'] },
          evaluatorPolicy: 'bypass',
          auditLevel: 'none',
          sandboxPolicy: { filesystem: 'none', network: 'none', execution: 'in_process' },
          outputSensitivity: 'normal',
          piSchema: { input: {}, output: {} },
          handler: 'test',
        };

        expect(entry.capabilities).toContain(cap);
      });
    });

    it('should support evaluatorPolicy values', () => {
      const policies: Array<ToolRegistryEntry['evaluatorPolicy']> = ['required', 'bypass'];

      policies.forEach((policy) => {
        const entry: ToolRegistryEntry = {
          name: 'test',
          version: '1.0.0',
          description: 'Test',
          capabilities: [],
          permissions: { allowedActors: ['user'], allowedContexts: ['private_chat'] },
          evaluatorPolicy: policy,
          auditLevel: 'none',
          sandboxPolicy: { filesystem: 'none', network: 'none', execution: 'in_process' },
          outputSensitivity: 'normal',
          piSchema: { input: {}, output: {} },
          handler: 'test',
        };

        expect(entry.evaluatorPolicy).toBe(policy);
      });
    });
  });

  describe('ToolCallRequest', () => {
    it('should allow creating tool call request', () => {
      const request: ToolCallRequest = {
        id: 'call-001',
        turnId: 'turn-001',
        toolName: 'search',
        input: { query: 'test' },
        requestedBy: 'pi',
        actor: {
          actorClass: 'user',
          canonicalUserId: 'user-001',
        },
        context: 'private_chat',
      };

      expect(request.toolName).toBe('search');
      expect(request.actor.actorClass).toBe('user');
    });

    it('should support all requestedBy values', () => {
      const requesters: Array<ToolCallRequest['requestedBy']> = ['pi', 'evaluator', 'user', 'system'];

      requesters.forEach((requester) => {
        const request: ToolCallRequest = {
          id: 'call-001',
          turnId: 'turn-001',
          toolName: 'test',
          input: {},
          requestedBy: requester,
          actor: { actorClass: 'user', canonicalUserId: 'user-001' },
          context: 'private_chat',
        };

        expect(request.requestedBy).toBe(requester);
      });
    });
  });

  describe('ToolCallResult', () => {
    it('should allow creating success result', () => {
      const result: ToolCallResult = {
        callId: 'call-001',
        status: 'success',
        output: { result: 'test' },
        executionTimeMs: 100,
        secretsRedacted: false,
        createdAt: new Date(),
      };

      expect(result.status).toBe('success');
      expect(result.executionTimeMs).toBe(100);
    });

    it('should allow creating error result', () => {
      const result: ToolCallResult = {
        callId: 'call-001',
        status: 'error',
        error: {
          code: 'TEST_ERROR',
          message: 'Test error',
          category: 'internal',
          recoverable: false,
        },
        executionTimeMs: 50,
        secretsRedacted: false,
        createdAt: new Date(),
      };

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('TEST_ERROR');
    });

    it('should support all status values', () => {
      const statuses: Array<ToolCallResult['status']> = ['success', 'error', 'timeout', 'rejected'];

      statuses.forEach((status) => {
        const result: ToolCallResult = {
          callId: 'call-001',
          status,
          executionTimeMs: 100,
          secretsRedacted: false,
          createdAt: new Date(),
        };

        expect(result.status).toBe(status);
      });
    });
  });
});
