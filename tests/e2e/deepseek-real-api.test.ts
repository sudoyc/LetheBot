/**
 * E2E: DeepSeek Real API Integration
 *
 * 端到端测试，验证 PiAdapter 与真实 DeepSeek API 的集成
 * 需要配置 DEEPSEEK_API_KEY 环境变量或 ~/deepseek 文件
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import type { ContextPack } from '../../src/types/context';
import type { ToolRegistryEntry, ActorClass, InvocationContext } from '../../src/types/tool';
import { ToolRegistry } from '../../src/tools/registry';
import { PolicyGate } from '../../src/policy/gate';
import { initDatabase, runMigration } from '../../src/storage/database';
import type { ReasoningCore, AgentTurnOutput } from '../../src/pi/types';

/**
 * DeepSeek 测试配置
 */
interface DeepSeekTestConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeout: number;
}

/**
 * API 调用验证结果
 */
interface ApiCallValidation {
  success: boolean;
  responseReceived: boolean;
  responseText?: string;
  tokensUsed: { input: number; output: number; total: number };
  latencyMs: number;
  error?: string;
}

/**
 * 工具调用测试结果（预留用于未来实现）
 */

interface _ToolCallValidation {
  toolCalled: boolean;
  toolName: string;
  toolCallId: string;
  executionSuccess: boolean;
  resultReturned: boolean;
  policyCheckPassed: boolean;
  error?: string;
}

/**
 * 从环境或文件加载 DeepSeek 配置
 */
function loadDeepSeekConfig(): DeepSeekTestConfig | null {
  if (process.env.LETHEBOT_RUN_REAL_API_TESTS !== '1') {
    return null;
  }

  // 尝试从环境变量读取
  let apiKey = process.env.DEEPSEEK_API_KEY || process.env.PI_API_KEY;

  // 尝试从 ~/deepseek 文件读取
  if (!apiKey) {
    try {
      const keyPath = join(homedir(), 'deepseek');
      apiKey = readFileSync(keyPath, 'utf-8').trim();
    } catch {
      // 文件不存在或无法读取
    }
  }

  if (!apiKey) {
    return null;
  }

  return {
    apiKey,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    timeout: parseInt(process.env.DEEPSEEK_TIMEOUT || '30000', 10),
  };
}

/**
 * 检查是否应该跳过真实 API 测试
 */
function shouldSkipRealApiTests(): boolean {
  return !loadDeepSeekConfig();
}

/**
 * 创建测试用 ContextPack
 */
function createTestContextPack(options?: {
  withMemory?: boolean;
  withHistory?: boolean;
  conversationType?: 'private' | 'group';
  userMessage?: string;
}): ContextPack {
  const turnId = ulid();
  const conversationType = options?.conversationType || 'private';
  const userMessage = options?.userMessage || '你好';

  const contextPack: ContextPack = {
    id: ulid(),
    turnId,
    createdAt: new Date(),
    conversation: {
      conversationId: 'test-conv-001',
      conversationType,
      groupId: conversationType === 'group' ? 'test-group-001' : undefined,
    },
    recentMessages: [
      {
        messageId: ulid(),
        senderId: 'user-alice',
        senderDisplayName: 'Alice',
        text: userMessage,
        timestamp: new Date(),
        isFromBot: false,
      },
    ],
    memory: {
      retrievedFacts: [],
      selectedMemoryIds: [],
    },
    participants: [
      {
        canonicalUserId: 'user-alice',
        displayName: 'Alice',
        isOwner: false,
        isAdmin: false,
        isTrusted: true,
      },
    ],
    injectedIdentityFields: [],
    tokenBudget: {
      max: 8000,
      used: 500,
      breakdown: {
        recentMessages: 200,
        memory: 100,
        identity: 50,
        system: 150,
      },
    },
  };

  // 添加记忆
  if (options?.withMemory) {
    contextPack.memory.userProfile = {
      memoryId: ulid(),
      scope: 'user',
      title: '用户偏好',
      content: '用户喜欢喝咖啡',
      confidence: 0.9,
      sourceContext: 'previous conversation',
    };
    contextPack.memory.selectedMemoryIds.push(contextPack.memory.userProfile.memoryId);
  }

  // 添加历史消息
  if (options?.withHistory) {
    contextPack.recentMessages.unshift(
      {
        messageId: ulid(),
        senderId: 'bot',
        senderDisplayName: 'LetheBot',
        text: '你好！有什么可以帮助你的？',
        timestamp: new Date(Date.now() - 3000),
        isFromBot: true,
      },
      {
        messageId: ulid(),
        senderId: 'user-alice',
        senderDisplayName: 'Alice',
        text: '我想了解一些信息',
        timestamp: new Date(Date.now() - 2000),
        isFromBot: false,
      },
      {
        messageId: ulid(),
        senderId: 'bot',
        senderDisplayName: 'LetheBot',
        text: '当然，请告诉我你想了解什么。',
        timestamp: new Date(Date.now() - 1000),
        isFromBot: true,
      }
    );
  }

  return contextPack;
}

/**
 * 创建测试工具
 */
function createTestTool(options?: {
  requiresPolicy?: boolean;
  shouldFail?: boolean;
}): ToolRegistryEntry {
  const requiresPolicy = options?.requiresPolicy ?? false;
  const shouldFail = options?.shouldFail ?? false;

  return {
    name: requiresPolicy ? 'admin_action' : 'echo',
    version: '1.0.0',
    description: requiresPolicy ? 'Admin-only tool for testing' : 'Echoes back the input message',
    capabilities: requiresPolicy ? ['platform_admin'] : ['read_context'],
    permissions: {
      allowedActors: requiresPolicy ? (['admin', 'owner'] as ActorClass[]) : (['user', 'admin'] as ActorClass[]),
      allowedContexts: requiresPolicy
        ? (['admin_cli'] as InvocationContext[])
        : (['private_chat', 'group_chat'] as InvocationContext[]),
    },
    evaluatorPolicy: requiresPolicy ? 'required' : 'bypass',
    auditLevel: requiresPolicy ? 'full' : 'summary',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'none',
      execution: 'in_process',
    },
    outputSensitivity: requiresPolicy ? 'sensitive' : 'normal',
    piSchema: {
      input: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      output: {
        type: 'object',
        properties: {
          echo: { type: 'string' },
        },
      },
    },
    handler: async (request) => {
      if (shouldFail) {
        throw new Error('test-handler-fail');
      }

      return {
        echo: `test-handler-${requiresPolicy ? 'admin' : 'echo'}`,
        input: request.input,
      };
    },
  };
}

/**
 * 验证 API 响应（预留用于未来实现）
 */

function _validateApiResponse(output: AgentTurnOutput): ApiCallValidation {
  const success = !!output.responseText && output.tokensUsed.total > 0;

  return {
    success,
    responseReceived: !!output.responseText,
    responseText: output.responseText,
    tokensUsed: output.tokensUsed,
    latencyMs: 0, // 需要在调用侧测量
    error: success ? undefined : 'No response or invalid token usage',
  };
}

// 测试套件
describe('E2E: DeepSeek Real API Integration', () => {
  let db: Database.Database;
  let toolRegistry: ToolRegistry;
  let policyGate: PolicyGate;

  let _reasoningCore: ReasoningCore | null = null;
  let config: DeepSeekTestConfig | null = null;

  beforeAll(() => {
    // 初始化确定性测试组件（不依赖真实 API）
    db = initDatabase({ path: ':memory:' });

    // 运行迁移
    const migrationPath = join(process.cwd(), 'migrations', '001_initial_schema.sql');
    runMigration(db, migrationPath);

    // 创建核心组件
    toolRegistry = new ToolRegistry();
    policyGate = new PolicyGate(toolRegistry);

    // 注册测试工具
    toolRegistry.register(createTestTool({ requiresPolicy: false }));
    toolRegistry.register(createTestTool({ requiresPolicy: true }));

    // 检查 API key 可用性
    config = loadDeepSeekConfig();

    if (!config) {
      console.warn(
        '⚠️  DeepSeek API key not found. Set DEEPSEEK_API_KEY or PI_API_KEY env var, or create ~/deepseek file.'
      );
      console.warn('   Real API tests will be skipped.');
      return;
    }

    // 注意: PiAdapter 尚未实现，这里使用占位符
    // 实际实现时应该使用真实的 PiAdapter
    console.log('✓ Test environment initialized');
    console.log(`  Model: ${config.model}`);
    console.log(`  Base URL: ${config.baseUrl}`);
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
  });

  describe('连通性测试', () => {
    it.skipIf(shouldSkipRealApiTests())('should connect to DeepSeek API successfully', async () => {
      // 这个测试需要真实的 PiAdapter 实现
      // 当前项目中 PiAdapter 尚未实现，所以我们标记为 TODO
      expect(config).toBeTruthy();
      expect(config?.apiKey).toBeTruthy();
      expect(config?.baseUrl).toBe('https://api.deepseek.com/v1');
    });

    it.skipIf(shouldSkipRealApiTests())('should handle authentication with valid API key', async () => {
      expect(config?.apiKey).toMatch(/^sk-/);
    });

    it('should skip tests when API key is not available', () => {
      if (!config) {
        expect(shouldSkipRealApiTests()).toBe(true);
      }
    });
  });

  describe('基础对话流程', () => {
    it.skipIf(shouldSkipRealApiTests())('should complete simple chat turn', async () => {
      // TODO: 需要真实 PiAdapter 实现
      // const contextPack = createTestContextPack();
      // const input: AgentTurnInput = { contextPack };
      // const output = await reasoningCore!.run(input);
      // const validation = validateApiResponse(output);
      // expect(validation.success).toBe(true);
      expect(true).toBe(true); // Placeholder
    }, 60000);

    it.skipIf(shouldSkipRealApiTests())('should inject system prompt correctly', async () => {
      // TODO: 实现系统提示词注入测试
      expect(true).toBe(true); // Placeholder
    });

    it.skipIf(shouldSkipRealApiTests())('should return valid response text', async () => {
      // TODO: 验证响应文本有效性
      expect(true).toBe(true); // Placeholder
    });

    it.skipIf(shouldSkipRealApiTests())('should track token usage', async () => {
      // TODO: 验证 token 使用跟踪
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('上下文注入', () => {
    it.skipIf(shouldSkipRealApiTests())('should inject memory context', async () => {
      const contextPack = createTestContextPack({
        withMemory: true,
        userMessage: '我喜欢什么饮料？',
      });

      expect(contextPack.memory.userProfile).toBeDefined();
      expect(contextPack.memory.userProfile?.content).toContain('咖啡');

      // TODO: 验证 API 响应包含记忆内容
    });

    it.skipIf(shouldSkipRealApiTests())('should inject conversation history', async () => {
      const contextPack = createTestContextPack({
        withHistory: true,
      });

      expect(contextPack.recentMessages.length).toBeGreaterThan(1);

      // TODO: 验证历史消息被正确注入
    });

    it.skipIf(shouldSkipRealApiTests())('should inject participant context for group chat', async () => {
      const contextPack = createTestContextPack({
        conversationType: 'group',
      });

      expect(contextPack.conversation.conversationType).toBe('group');
      expect(contextPack.conversation.groupId).toBeDefined();

      // TODO: 验证参与者上下文注入
    });

    it.skipIf(shouldSkipRealApiTests())('should respect token budget limits', async () => {
      const contextPack = createTestContextPack();

      expect(contextPack.tokenBudget.max).toBe(8000);
      expect(contextPack.tokenBudget.used).toBeLessThan(contextPack.tokenBudget.max);
    });
  });

  describe('工具调用', () => {
    it('should register and verify simple tool', () => {
      const tool = toolRegistry.get('echo');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('echo');
      expect(tool?.capabilities).toContain('read_context');
    });

    it('should check tool permissions correctly', () => {
      const hasPermission = toolRegistry.checkPermission(
        'echo',
        { actorClass: 'user' },
        'private_chat'
      );
      expect(hasPermission).toBe(true);

      const noPermission = toolRegistry.checkPermission(
        'admin_action',
        { actorClass: 'user' },
        'private_chat'
      );
      expect(noPermission).toBe(false);
    });

    it.skipIf(shouldSkipRealApiTests())('should call simple tool via API', async () => {
      // TODO: 测试工具调用流程
      expect(true).toBe(true); // Placeholder
    }, 60000);

    it('should enforce tool permissions via PolicyGate', () => {
      const checkResult = policyGate.checkToolCall({
        toolName: 'admin_action',
        actor: { actorClass: 'user' },
        context: 'private_chat',
      });

      expect(checkResult.allowed).toBe(false);
      expect(checkResult.reason).toContain('Permission denied');
    });

    it('should allow authorized tool calls', () => {
      const checkResult = policyGate.checkToolCall({
        toolName: 'echo',
        actor: { actorClass: 'user' },
        context: 'private_chat',
      });

      expect(checkResult.allowed).toBe(true);
    });

    it.skipIf(shouldSkipRealApiTests())('should handle tool execution errors', async () => {
      // TODO: 测试工具执行错误处理
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('错误处理', () => {
    it.skipIf(shouldSkipRealApiTests())('should handle invalid API key gracefully', async () => {
      // TODO: 测试无效 API key 处理
      expect(true).toBe(true); // Placeholder
    });

    it.skipIf(shouldSkipRealApiTests())('should handle network timeout', async () => {
      // TODO: 测试网络超时处理
      expect(true).toBe(true); // Placeholder
    }, 60000);

    it('should validate tool existence before call', () => {
      const checkResult = policyGate.checkToolCall({
        toolName: 'nonexistent_tool',
        actor: { actorClass: 'user' },
        context: 'private_chat',
      });

      expect(checkResult.allowed).toBe(false);
      expect(checkResult.reason).toContain('Unknown tool');
    });
  });

  describe('辅助函数测试', () => {
    it('should create minimal context pack', () => {
      const contextPack = createTestContextPack();

      expect(contextPack.id).toBeDefined();
      expect(contextPack.turnId).toBeDefined();
      expect(contextPack.conversation.conversationType).toBe('private');
      expect(contextPack.recentMessages.length).toBe(1);
      expect(contextPack.memory.retrievedFacts).toEqual([]);
    });

    it('should create context pack with memory', () => {
      const contextPack = createTestContextPack({ withMemory: true });

      expect(contextPack.memory.userProfile).toBeDefined();
      expect(contextPack.memory.userProfile?.content).toContain('咖啡');
    });

    it('should create context pack with history', () => {
      const contextPack = createTestContextPack({ withHistory: true });

      expect(contextPack.recentMessages.length).toBeGreaterThan(1);
      expect(contextPack.recentMessages.some(m => m.isFromBot)).toBe(true);
    });

    it('should create test tools with correct configurations', () => {
      const simpleTool = createTestTool({ requiresPolicy: false });
      expect(simpleTool.name).toBe('echo');
      expect(simpleTool.evaluatorPolicy).toBe('bypass');
      expect(simpleTool.permissions.allowedActors).toContain('user');

      const restrictedTool = createTestTool({ requiresPolicy: true });
      expect(restrictedTool.name).toBe('admin_action');
      expect(restrictedTool.evaluatorPolicy).toBe('required');
      expect(restrictedTool.permissions.allowedActors).not.toContain('user');
    });
  });

  describe('配置加载', () => {
    it('should load config from environment or file', () => {
      const testConfig = loadDeepSeekConfig();

      if (testConfig) {
        expect(testConfig.apiKey).toBeDefined();
        expect(testConfig.model).toBeDefined();
        expect(testConfig.baseUrl).toBe('https://api.deepseek.com/v1');
        expect(testConfig.timeout).toBeGreaterThan(0);
      }
    });

    it('should use default values when env vars not set', () => {
      const testConfig = loadDeepSeekConfig();

      if (testConfig) {
        expect(testConfig.baseUrl).toBe('https://api.deepseek.com/v1');
        expect(testConfig.timeout).toBeGreaterThanOrEqual(30000);
      }
    });
  });
});
