/**
 * PiAdapter Unit Tests
 *
 * Testing:
 * 1. PiAdapter construction
 * 2. ContextPack to Pi message conversion
 * 3. Tool registration with PolicyGate hook
 * 4. Response extraction from Pi events
 * 5. Error handling
 * 6. Tool call flow with policy checks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ContextPack } from '../../../src/types/context';
import type { ToolRegistryEntry } from '../../../src/types/tool';

// Define types for mocked modules
type AgentOptions = any;
type AgentEvent = any;
type BeforeToolCallContext = any;

// Mock Pi Agent Core
let mockSubscribers: Array<(event: AgentEvent, signal: AbortSignal) => void> = [];

const createMockAgent = (options: AgentOptions) => {
  const mockAgentState = {
    systemPrompt: options.initialState?.systemPrompt ?? '',
    model: options.initialState?.model ?? {},
    tools: options.initialState?.tools ?? [],
    messages: options.initialState?.messages ?? [],
    isStreaming: false,
    errorMessage: undefined,
  };

  return {
    state: mockAgentState,
    subscribe: vi.fn((handler: (event: AgentEvent, signal: AbortSignal) => void) => {
      mockSubscribers.push(handler);
    }),
    prompt: vi.fn().mockResolvedValue(undefined),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    _mockOptions: options,
    _mockSubscribers: mockSubscribers,
    _mockEmitEvent: (event: AgentEvent) => {
      mockSubscribers.forEach((handler) =>
        handler(event, new AbortController().signal)
      );
    },
  };
};

const MockAgent = vi.fn(createMockAgent);

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: MockAgent,
  };
});

vi.mock('@earendil-works/pi-ai/compat', () => {
  return {
    getModel: vi.fn((provider: string, model: string) => ({ provider, model })),
  };
});

// Mock Pi AI
vi.mock('@earendil-works/pi-ai', () => {
  return {
    Models: {
      anthropic: vi.fn((model: string) => ({ provider: 'anthropic', model })),
    },
  };
});

// Import after mocks are set up
const { PiAdapter } = await import('../../../src/pi/pi-adapter');
const { ToolRegistry } = await import('../../../src/tools/registry');
const { PolicyGate } = await import('../../../src/policy/gate');

type PiAdapterInput = any;

describe('PiAdapter', () => {
  let toolRegistry: ToolRegistry;
  let policyGate: PolicyGate;
  let adapter: PiAdapter;
  let mockAgent: any;
  let mockAuditRepository: { create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribers = []; // Reset subscribers

    toolRegistry = new ToolRegistry();
    policyGate = new PolicyGate(toolRegistry);
    mockAuditRepository = {
      create: vi.fn().mockResolvedValue('audit-001'),
    };

    // Create adapter after mocks are reset
    adapter = new PiAdapter({
      toolRegistry,
      policyGate,
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'test-api-key',
      auditRepository: mockAuditRepository,
    });

    // Get reference to mocked Agent instance (last call)
    const lastCallIndex = MockAgent.mock.results.length - 1;
    mockAgent = MockAgent.mock.results[lastCallIndex].value;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Construction', () => {
    it('should create PiAdapter with required dependencies', () => {
      expect(adapter).toBeDefined();
      expect(adapter).toBeInstanceOf(PiAdapter);
    });

    it('should initialize Pi Agent with correct configuration', async () => {
      const agentOptions = mockAgent._mockOptions;

      expect(MockAgent).toHaveBeenCalledTimes(1);
      expect(agentOptions).toMatchObject({
        initialState: expect.objectContaining({
          systemPrompt: '',
          tools: [],
          messages: [],
        }),
        getApiKey: expect.any(Function),
      });

      // Test getApiKey function (it's async)
      const apiKey = await agentOptions.getApiKey('openai');
      expect(apiKey).toBe('test-api-key');
    });

    it('should subscribe to Pi Agent events', () => {
      expect(mockAgent.subscribe).toHaveBeenCalledTimes(1);
      expect(mockAgent.subscribe).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('ContextPack to Message Conversion', () => {
    it('should convert empty ContextPack to empty messages', async () => {
      const contextPack: ContextPack = createMinimalContextPack();

      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-001',
      };

      await adapter.runTurn(input);

      expect(mockAgent.prompt).toHaveBeenCalledWith([]);
    });

    it('should inject memory context as first user message', async () => {
      const contextPack: ContextPack = {
        ...createMinimalContextPack(),
        memory: {
          userProfile: {
            memoryId: 'mem-001',
            scope: 'user',
            title: 'User Profile',
            content: 'Alice loves cats',
            confidence: 0.95,
          },
          groupProfile: undefined,
          retrievedFacts: [
            {
              memoryId: 'mem-002',
              scope: 'conversation',
              title: 'Recent Topic',
              content: 'Discussed TypeScript yesterday',
              confidence: 0.85,
            },
          ],
          selectedMemoryIds: ['mem-001', 'mem-002'],
        },
      };

      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-002',
      };

      await adapter.runTurn(input);

      const messages = mockAgent.prompt.mock.calls[0][0];
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content[0].text).toContain('<context>');
      expect(messages[0].content[0].text).toContain('## User Profile');
      expect(messages[0].content[0].text).toContain('Alice loves cats');
      expect(messages[0].content[0].text).toContain('## Relevant Facts');
      expect(messages[0].content[0].text).toContain('Discussed TypeScript yesterday');
    });

    it('should convert recent messages with display names', async () => {
      const contextPack: ContextPack = {
        ...createMinimalContextPack(),
        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'user-001',
            senderDisplayName: 'Alice',
            text: 'Hello bot!',
            timestamp: new Date('2024-01-01T10:00:00Z'),
            isFromBot: false,
          },
          {
            messageId: 'msg-002',
            senderId: 'bot-001',
            senderDisplayName: 'LetheBot',
            text: 'Hi Alice! How can I help?',
            timestamp: new Date('2024-01-01T10:00:01Z'),
            isFromBot: true,
          },
          {
            messageId: 'msg-003',
            senderId: 'user-001',
            senderDisplayName: 'Alice',
            text: 'Tell me about cats',
            timestamp: new Date('2024-01-01T10:00:02Z'),
            isFromBot: false,
          },
        ],
      };

      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-003',
      };

      await adapter.runTurn(input);

      const messages = mockAgent.prompt.mock.calls[0][0];
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content[0].text).toContain('Alice: Hello bot!');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content[0].text).toBe('Hi Alice! How can I help?');
      expect(messages[1]).toMatchObject({
        api: 'openai-completions',
        provider: 'openai',
        model: 'gpt-4',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        stopReason: 'stop',
        timestamp: new Date('2024-01-01T10:00:01Z').getTime(),
      });
      expect(messages[2].role).toBe('user');
      expect(messages[2].content[0].text).toContain('Alice: Tell me about cats');
    });

    it('should include participant context for group chats', async () => {
      const contextPack: ContextPack = {
        ...createMinimalContextPack(),
        conversation: {
          conversationId: 'conv-001',
          conversationType: 'group',
          groupId: 'group-001',
        },
        participants: [
          {
            canonicalUserId: 'user-001',
            displayName: 'Alice',
            isOwner: true,
            isAdmin: true,
            isTrusted: true,
          },
          {
            canonicalUserId: 'user-002',
            displayName: 'Bob',
            isOwner: false,
            isAdmin: false,
            isTrusted: false,
          },
        ],
      };

      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'group_chat',
        turnId: 'turn-004',
      };

      await adapter.runTurn(input);

      const messages = mockAgent.prompt.mock.calls[0][0];
      expect(messages[0].content[0].text).toContain('## Participants');
      expect(messages[0].content[0].text).toContain('Alice [owner, admin, trusted]');
      expect(messages[0].content[0].text).toContain('Bob');
    });
  });

  describe('Tool Registration', () => {
    beforeEach(() => {
      // Register test tools
      const testTool: ToolRegistryEntry = {
        name: 'test_tool',
        version: '1.0.0',
        description: 'A test tool',
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
              query: { type: 'string' },
            },
            required: ['query'],
          },
          output: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
          },
        },
        handler: async () => ({ result: 'Tool executed successfully' }),
      };

      toolRegistry.register(testTool);
    });

    it('should convert allowed tools to Pi AgentTool format', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-005',
      };

      await adapter.runTurn(input);

      expect(mockAgent.state.tools).toHaveLength(1);
      const piTool = mockAgent.state.tools[0];

      expect(piTool.name).toBe('test_tool');
      expect(piTool.description).toBe('A test tool');
      expect(piTool.parameters).toEqual({
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      });
      expect(piTool.execute).toBeInstanceOf(Function);
    });

    it('should filter out tools not allowed for actor', async () => {
      const restrictedTool: ToolRegistryEntry = {
        name: 'admin_tool',
        version: '1.0.0',
        description: 'Admin only tool',
        capabilities: ['platform_admin'],
        permissions: {
          allowedActors: ['admin', 'owner'],
          allowedContexts: ['admin_cli'],
        },
        evaluatorPolicy: 'required',
        auditLevel: 'full',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
        },
        outputSensitivity: 'sensitive',
        piSchema: {
          input: { type: 'object', properties: {} },
          output: { type: 'object', properties: {} },
        },
        handler: async () => ({ result: 'Admin tool executed successfully' }),
      };

      toolRegistry.register(restrictedTool);

      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' }, // Not admin
        invocationContext: 'private_chat', // Not admin_cli
        turnId: 'turn-006',
      };

      await adapter.runTurn(input);

      // Should only have test_tool, not admin_tool
      expect(mockAgent.state.tools).toHaveLength(1);
      expect(mockAgent.state.tools[0].name).toBe('test_tool');
    });
  });

  describe('Response Extraction', () => {
    it('should extract text response from assistant message', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-007',
      };

      // Mock agent state after completion
      mockAgent.state.messages = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there! How can I help?' }],
        },
      ];

      const output = await adapter.runTurn(input);

      expect(output.responseText).toBe('Hi there! How can I help?');
      expect(output.status).toBe('completed');
      expect(output.turnId).toBe('turn-007');
    });

    it('should handle multiple text blocks in assistant response', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-008',
      };

      mockAgent.state.messages = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'First part. ' },
            { type: 'text', text: 'Second part.' },
          ],
        },
      ];

      const output = await adapter.runTurn(input);

      expect(output.responseText).toBe('First part. Second part.');
    });

    it('should handle no assistant message', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-009',
      };

      mockAgent.state.messages = [];

      const output = await adapter.runTurn(input);

      expect(output.responseText).toBeUndefined();
      expect(output.status).toBe('completed');
    });
  });

  describe('Error Handling', () => {
    it('should handle agent errors gracefully', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-010',
      };

      mockAgent.prompt.mockRejectedValueOnce(new Error('API error'));

      const output = await adapter.runTurn(input);

      expect(output.status).toBe('failed');
      expect(output.errorMessage).toBe('API error');
      expect(output.turnId).toBe('turn-010');
    });

    it('should capture error message from agent state', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-011',
      };

      mockAgent.state.errorMessage = 'Rate limit exceeded';

      const output = await adapter.runTurn(input);

      expect(output.status).toBe('failed');
      expect(output.errorMessage).toBe('Rate limit exceeded');
    });
  });

  describe('Tool Call Flow with Policy Checks', () => {
    let mockToolHandler: any;

    beforeEach(() => {
      mockToolHandler = vi.fn().mockResolvedValue({
        result: 'Tool executed successfully',
      });

      const testTool: ToolRegistryEntry = {
        name: 'policy_test_tool',
        version: '1.0.0',
        description: 'Tool for testing policy checks',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['user', 'admin'],
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
              action: { type: 'string' },
            },
            required: ['action'],
          },
          output: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
          },
        },
        handler: mockToolHandler,
      };

      toolRegistry.register(testTool);

    });

    it('should call beforeToolCall hook with correct context', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: {
          canonicalUserId: 'user-123',
          actorClass: 'user',
        },
        invocationContext: 'private_chat',
        turnId: 'turn-012',
      };

      await adapter.runTurn(input);

      // Get the beforeToolCall hook
      const beforeToolCall = mockAgent._mockOptions.beforeToolCall;
      expect(beforeToolCall).toBeInstanceOf(Function);

      // Simulate tool call
      const mockContext: BeforeToolCallContext = {
        toolCall: {
          id: 'tc-001',
          name: 'policy_test_tool',
          arguments: { action: 'test' },
        },
        assistantMessage: {} as any,
        args: { action: 'test' },
        context: {} as any,
      };

      const result = await beforeToolCall(mockContext, new AbortController().signal);

      // PolicyGate will check permissions
      // If allowed: returns undefined (no block)
      // If blocked: returns { block: true, reason }
      // For user actor + private_chat context, should be allowed
      expect(result).toBeUndefined();
    });

    it('should block tool call if actor lacks permission', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: {
          canonicalUserId: 'user-123',
          actorClass: 'user',
        },
        invocationContext: 'group_chat', // Not allowed for policy_test_tool
        turnId: 'turn-013',
      };

      await adapter.runTurn(input);

      const beforeToolCall = mockAgent._mockOptions.beforeToolCall;

      const mockContext: BeforeToolCallContext = {
        toolCall: {
          id: 'tc-002',
          name: 'policy_test_tool',
          arguments: { action: 'test' },
        },
        assistantMessage: {} as any,
        args: { action: 'test' },
        context: {} as any,
      };

      const result = await beforeToolCall(mockContext, new AbortController().signal);

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
      expect(result.reason).toContain('Permission denied');
      expect(mockAuditRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'tool',
          level: 'summary',
          eventType: 'tool.rejected',
          eventId: 'tc-002',
          actor: expect.objectContaining({
            canonicalUserId: 'user-123',
            actorClass: 'user',
            context: 'group_chat',
          }),
          redacted: false,
        })
      );
    });

    it('should block tool call if evaluator is required', async () => {
      const evaluatorTool: ToolRegistryEntry = {
        name: 'evaluator_required_tool',
        version: '1.0.0',
        description: 'Tool requiring evaluator',
        capabilities: ['external_side_effect'],
        permissions: {
          allowedActors: ['user'],
          allowedContexts: ['private_chat'],
        },
        evaluatorPolicy: 'required',
        auditLevel: 'full',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'allowed',
          execution: 'subprocess',
        },
        outputSensitivity: 'sensitive',
        piSchema: {
          input: { type: 'object', properties: {} },
          output: { type: 'object', properties: {} },
        },
        handler: async () => ({ result: 'Evaluator tool executed successfully' }),
      };

      toolRegistry.register(evaluatorTool);

      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-014',
      };

      await adapter.runTurn(input);

      const beforeToolCall = mockAgent._mockOptions.beforeToolCall;

      const mockContext: BeforeToolCallContext = {
        toolCall: {
          id: 'tc-003',
          name: 'evaluator_required_tool',
          arguments: {},
        },
        assistantMessage: {} as any,
        args: {},
        context: {} as any,
      };

      const result = await beforeToolCall(mockContext, new AbortController().signal);

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
      expect(result.reason).toContain('requires evaluator review');
      expect(mockAuditRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'tool',
          level: 'full',
          eventType: 'tool.rejected',
          eventId: 'tc-003',
          actor: expect.objectContaining({
            actorClass: 'user',
            context: 'private_chat',
          }),
          riskLevel: 'high',
        })
      );
    });

    it('should track executed tool calls', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-015',
      };

      await adapter.runTurn(input);

      // Get the tool execute function
      const piTool = mockAgent.state.tools[0];
      expect(piTool.name).toBe('policy_test_tool');

      // Execute the tool
      await piTool.execute(
        'tc-004',
        { action: 'test' },
        new AbortController().signal,
        vi.fn()
      );

      expect(mockToolHandler).toHaveBeenCalledWith({
        toolCallId: 'tc-004',
        turnId: 'turn-015',
        toolName: 'policy_test_tool',
        input: { action: 'test' },
        actor: { actorClass: 'user' },
        context: 'private_chat',
      });

      // Run turn again to capture executed tool IDs
      const output = await adapter.runTurn(input);

      // Note: In real usage, tools would be executed by Pi agent during the turn
      // For this test, we verify the tracking mechanism is in place
      expect(output.toolCallIds).toBeDefined();
      expect(Array.isArray(output.toolCallIds)).toBe(true);
    });

    it('should audit successful tool execution', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: {
          canonicalUserId: 'user-123',
          actorClass: 'user',
        },
        invocationContext: 'private_chat',
        turnId: 'turn-audit-success',
      };

      await adapter.runTurn(input);
      const piTool = mockAgent.state.tools[0];

      await piTool.execute('tc-audit-success', { action: 'test' });

      expect(mockAuditRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'tool',
          level: 'summary',
          eventType: 'tool.executed',
          eventId: 'tc-audit-success',
          actor: expect.objectContaining({
            canonicalUserId: 'user-123',
            actorClass: 'user',
            context: 'private_chat',
          }),
          redacted: false,
        })
      );
    });

    it('should enforce PolicyGate inside execute and audit rejected bypass tools', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: {
          canonicalUserId: 'user-123',
          actorClass: 'user',
        },
        invocationContext: 'private_chat',
        turnId: 'turn-policy-execute',
      };

      await adapter.runTurn(input);
      const piTool = mockAgent.state.tools[0];
      const registeredTool = toolRegistry.get('policy_test_tool');
      expect(registeredTool).toBeDefined();
      if (!registeredTool) {
        throw new Error('Expected policy_test_tool to be registered');
      }
      registeredTool.permissions.allowedActors = ['owner'];

      await expect(piTool.execute('tc-policy-denied', { action: 'test' }))
        .rejects.toThrow(/Permission denied/);

      expect(mockToolHandler).not.toHaveBeenCalled();
      expect(mockAuditRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'tool',
          level: 'summary',
          eventType: 'tool.rejected',
          eventId: 'tc-policy-denied',
          redacted: false,
        })
      );
    });

    it('should redact secret_possible tool output before prompt and audit details', async () => {
      const secretToolHandler = vi.fn().mockResolvedValue({
        output: 'api_key=sk-1234567890abcdefghijklmnopqrstuvwxyz',
      });

      toolRegistry.register({
        name: 'secret_output_tool',
        version: '1.0.0',
        description: 'Returns secret-like output',
        capabilities: ['read_local'],
        permissions: {
          allowedActors: ['user'],
          allowedContexts: ['private_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'redacted_full',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
        },
        outputSensitivity: 'secret_possible',
        piSchema: {
          input: { type: 'object', properties: {} },
          output: { type: 'object', properties: {} },
        },
        handler: secretToolHandler,
      });

      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: {
          canonicalUserId: 'user-123',
          actorClass: 'user',
        },
        invocationContext: 'private_chat',
        turnId: 'turn-secret-redaction',
      };

      await adapter.runTurn(input);
      const piTool = mockAgent.state.tools.find((tool: any) => tool.name === 'secret_output_tool');

      const result = await piTool.execute('tc-secret-redaction', {});
      const text = result.content[0].text;
      expect(text).toContain('[REDACTED:api_key_assignment]');
      expect(text).not.toContain('sk-1234567890abcdefghijklmnopqrstuvwxyz');

      const auditEntry = mockAuditRepository.create.mock.calls.at(-1)?.[0];
      expect(auditEntry).toMatchObject({
        category: 'tool',
        level: 'redacted_full',
        eventType: 'tool.executed',
        eventId: 'tc-secret-redaction',
        redacted: true,
      });
      expect(JSON.stringify(auditEntry)).not.toContain('sk-1234567890abcdefghijklmnopqrstuvwxyz');
    });
  });

  describe('Event Handling', () => {
    it('should capture and enrich Pi events', async () => {
      const contextPack = createMinimalContextPack();
      const input: PiAdapterInput = {
        contextPack,
        systemPrompt: 'Test system prompt',
        actor: { actorClass: 'user' },
        invocationContext: 'private_chat',
        turnId: 'turn-016',
      };

      // Emit test events during turn
      mockAgent.prompt.mockImplementation(async () => {
        mockAgent._mockEmitEvent({
          type: 'turn_start',
          data: {},
        });
        mockAgent._mockEmitEvent({
          type: 'message_update',
          data: { delta: 'Hello' },
        });
        mockAgent._mockEmitEvent({
          type: 'turn_end',
          data: {},
        });
      });

      const output = await adapter.runTurn(input);

      expect(output.events).toHaveLength(3);
      expect(output.events[0].type).toBe('turn_start');
      expect(output.events[0].turnId).toBe('turn-016');
      expect(output.events[0].timestamp).toBeInstanceOf(Date);
      expect(output.events[0].piEvent).toEqual({
        type: 'turn_start',
        data: {},
      });

      expect(output.events[1].type).toBe('message_update');
      expect(output.events[2].type).toBe('turn_end');
    });
  });

  describe('Abort', () => {
    it('should call agent abort method', () => {
      adapter.abort();
      expect(mockAgent.abort).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Helper to create minimal ContextPack for testing
 */
function createMinimalContextPack(): ContextPack {
  return {
    id: 'ctx-001',
    turnId: 'turn-001',
    createdAt: new Date('2024-01-01T10:00:00Z'),
    conversation: {
      conversationId: 'conv-001',
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
  };
}
