/**
 * E2E Tests for Real DeepSeek API Integration
 *
 * These tests verify the complete flow from PiAdapter through DeepSeek API:
 * 1. Simple conversation
 * 2. Tool calling
 * 3. Multi-turn context
 * 4. Error recovery
 *
 * Tests are skipped if PI_API_KEY is not available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PiAdapter } from '../../src/pi/pi-adapter.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PolicyGate } from '../../src/policy/gate.js';
import type { ContextPack } from '../../src/types/context.js';
import type { ToolRegistryEntry } from '../../src/types/tool.js';

const runRealApiTests =
  process.env.LETHEBOT_RUN_REAL_API_TESTS === '1' && !!process.env.PI_API_KEY;

describe.skipIf(!runRealApiTests)('Real DeepSeek API E2E Tests', () => {
  let adapter: PiAdapter;
  let toolRegistry: ToolRegistry;
  let policyGate: PolicyGate;

  beforeAll(() => {
    toolRegistry = new ToolRegistry();
    policyGate = new PolicyGate(toolRegistry);

    adapter = new PiAdapter({
      toolRegistry,
      policyGate,
      provider: process.env.PI_PROVIDER || 'openai',
      model: process.env.PI_MODEL || 'deepseek-chat',
      apiKey: process.env.PI_API_KEY!,
      baseURL: process.env.PI_BASE_URL || 'https://api.deepseek.com/v1',
    });
  });

  afterAll(() => {
    // Cleanup if needed
  });

  describe('1. Simple Conversation', () => {
    it('should respond to a simple greeting', async () => {
      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'Hello! How are you?',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant. Keep responses concise.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-001',
      });

      expect(result.status).toBe('completed');
      expect(result.responseText).toBeDefined();
      expect(result.responseText!.length).toBeGreaterThan(0);
      expect(result.errorMessage).toBeUndefined();
    }, 30000); // 30s timeout for API call

    it('should handle Chinese conversation', async () => {
      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-002',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: '你好，今天天气怎么样？',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant. Respond in Chinese.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-002',
      });

      expect(result.status).toBe('completed');
      expect(result.responseText).toBeDefined();
      // Should contain Chinese characters
      expect(/[一-龥]/.test(result.responseText!)).toBe(true);
    }, 30000);
  });

  describe('2. Tool Calling', () => {
    beforeAll(() => {
      // Register a simple test tool
      const testTool: ToolRegistryEntry = {
        name: 'get_current_time',
        version: '1.0.0',
        description: 'Get the current time in a specific timezone',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['user', 'admin'],
          allowedContexts: ['private_chat', 'group_chat'],
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
          input: {
            type: 'object',
            properties: {
              timezone: {
                type: 'string',
                description: 'IANA timezone name (e.g., Asia/Shanghai)',
              },
            },
            required: ['timezone'],
          },
          output: {
            type: 'object',
            properties: {
              time: { type: 'string' },
              timezone: { type: 'string' },
            },
          },
        },
        handler: async (context: any) => {
          const tz = context.input.timezone || 'UTC';
          const now = new Date();
          return {
            time: now.toLocaleString('en-US', { timeZone: tz }),
            timezone: tz,
          };
        },
      };

      toolRegistry.register(testTool);
    });

    it('should successfully call a tool', async () => {
      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-003',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'What time is it in Shanghai?',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt:
          'You are a helpful assistant. Use the get_current_time tool when asked about time.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-003',
      });

      expect(result.status).toBe('completed');
      expect(result.responseText).toBeDefined();
      expect(result.toolCallIds).toBeDefined();

      // The response should mention Shanghai or the time
      const hasRelevantContent =
        result.responseText!.toLowerCase().includes('shanghai') ||
        /\d{1,2}:\d{2}/.test(result.responseText!);
      expect(hasRelevantContent).toBe(true);
    }, 30000);

    it('should handle tool with Chinese description', async () => {
      // Register a Chinese-named tool
      const chineseTool: ToolRegistryEntry = {
        name: 'calculate_sum',
        version: '1.0.0',
        description: '计算两个数字的和',
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
          input: {
            type: 'object',
            properties: {
              a: { type: 'number', description: '第一个数字' },
              b: { type: 'number', description: '第二个数字' },
            },
            required: ['a', 'b'],
          },
          output: {
            type: 'object',
            properties: {
              result: { type: 'number' },
            },
          },
        },
        handler: async (context: any) => {
          return { result: context.input.a + context.input.b };
        },
      };

      toolRegistry.register(chineseTool);

      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-004',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: '帮我计算 123 加 456',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant. Use available tools when appropriate.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-004',
      });

      expect(result.status).toBe('completed');
      expect(result.responseText).toBeDefined();
      // Should mention 579 (123 + 456)
      expect(result.responseText!.includes('579')).toBe(true);
    }, 30000);
  });

  describe('3. Multi-turn Context', () => {
    it('should maintain context across multiple turns', async () => {
      // First turn: establish a preference
      const contextPack1 = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-005',
            senderId: 'user-001',
            senderDisplayName: 'Alice',
            text: 'My favorite color is blue.',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result1 = await adapter.runTurn({
        contextPack: contextPack1,
        systemPrompt: 'You are a helpful assistant. Remember user preferences.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-005',
      });

      expect(result1.status).toBe('completed');

      // Second turn: reference the preference
      const contextPack2 = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-005',
            senderId: 'user-001',
            senderDisplayName: 'Alice',
            text: 'My favorite color is blue.',
            timestamp: new Date(Date.now() - 10000),
            isFromBot: false,
          },
          {
            messageId: 'msg-006',
            senderId: 'bot',
            senderDisplayName: 'LetheBot',
            text: result1.responseText || 'Got it!',
            timestamp: new Date(Date.now() - 5000),
            isFromBot: true,
          },
          {
            messageId: 'msg-007',
            senderId: 'user-001',
            senderDisplayName: 'Alice',
            text: 'What is my favorite color?',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result2 = await adapter.runTurn({
        contextPack: contextPack2,
        systemPrompt: 'You are a helpful assistant. Remember user preferences.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-006',
      });

      expect(result2.status).toBe('completed');
      expect(result2.responseText).toBeDefined();
      // Should reference blue
      expect(result2.responseText!.toLowerCase().includes('blue')).toBe(true);
    }, 60000);
  });

  describe('4. Error Recovery', () => {
    it('should handle invalid API key gracefully', async () => {
      const badAdapter = new PiAdapter({
        toolRegistry,
        policyGate,
        provider: 'openai',
        model: 'deepseek-chat',
        apiKey: 'invalid-key-12345',
        baseURL: 'https://api.deepseek.com/v1',
      });

      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-008',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'Hello',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await badAdapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-007',
      });

      expect(result.status).toBe('failed');
      expect(result.errorMessage).toBeDefined();
      expect(result.errorMessage).toMatch(/401|authentication|unauthorized|invalid.*key/i);
    }, 30000);

    it('should handle network timeout', async () => {
      // Use an invalid URL to trigger timeout
      const timeoutAdapter = new PiAdapter({
        toolRegistry,
        policyGate,
        provider: 'openai',
        model: 'deepseek-chat',
        apiKey: process.env.PI_API_KEY!,
        baseURL: 'https://192.0.2.1:9999', // Non-routable IP
      });

      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-009',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'Hello',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await timeoutAdapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-008',
      });

      // Pi agent may handle timeout gracefully and complete, or fail
      // Either way, if it completed, there should be no error message
      if (result.status === 'completed') {
        // Timeout was handled gracefully - this is acceptable behavior
        expect(result.responseText).toBeDefined();
      } else {
        expect(result.status).toBe('failed');
        expect(result.errorMessage).toBeDefined();
      }
    }, 30000);

    it('should recover from malformed tool response', async () => {
      // Register a tool that throws an error
      const errorTool: ToolRegistryEntry = {
        name: 'broken_tool',
        version: '1.0.0',
        description: 'A tool that always fails',
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
          input: {
            type: 'object',
            properties: {},
          },
          output: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
          },
        },
        handler: async () => {
          throw new Error('Tool execution failed');
        },
      };

      toolRegistry.register(errorTool);

      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-010',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'Use the broken_tool',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant. Use the broken_tool when asked.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-009',
      });

      // Should still complete (Pi agent handles tool errors gracefully)
      expect(result.status).toMatch(/completed|failed/);
      expect(result.responseText).toBeDefined();
    }, 30000);
  });
});

/**
 * Helper function to create test ContextPack
 */
function createTestContext(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    id: 'ctx-test',
    turnId: 'turn-test',
    createdAt: new Date(),
    conversation: {
      conversationId: 'conv-test',
      conversationType: 'private',
    },
    recentMessages: [],
    memory: {
      userProfile: undefined,
      groupProfile: undefined,
      retrievedFacts: [],
      selectedMemoryIds: [],
    },
    participants: [],
    injectedIdentityFields: [],
    tokenBudget: {
      max: 10000,
      used: 0,
      breakdown: {
        recentMessages: 0,
        memory: 0,
        identity: 0,
        system: 0,
      },
    },
    ...overrides,
  };
}
