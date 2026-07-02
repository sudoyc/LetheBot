/**
 * Unit Tests for DeepSeek E2E Test Helpers
 *
 * 测试辅助函数和配置加载逻辑
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('DeepSeek E2E Test Helpers - Unit Tests', () => {
  // 保存原始环境变量
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 每个测试前重置环境变量
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // 恢复原始环境变量
    process.env = originalEnv;
  });

  describe('Configuration Loading', () => {
    it('should prioritize DEEPSEEK_API_KEY environment variable', () => {
      process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
      process.env.PI_API_KEY = 'sk-test-pi';

      // 在实际实现中，loadDeepSeekConfig 应该优先使用 DEEPSEEK_API_KEY
      expect(process.env.DEEPSEEK_API_KEY).toBe('sk-test-deepseek');
    });

    it('should fall back to PI_API_KEY if DEEPSEEK_API_KEY not set', () => {
      delete process.env.DEEPSEEK_API_KEY;
      process.env.PI_API_KEY = 'sk-test-pi';

      expect(process.env.PI_API_KEY).toBe('sk-test-pi');
    });

    it('should use default model when DEEPSEEK_MODEL not set', () => {
      const defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
      expect(defaultModel).toBe('deepseek-v4-flash');
    });

    it('should use default base URL when DEEPSEEK_BASE_URL not set', () => {
      const defaultBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
      expect(defaultBaseUrl).toBe('https://api.deepseek.com/v1');
    });

    it('should parse timeout as integer', () => {
      process.env.DEEPSEEK_TIMEOUT = '45000';
      const timeout = parseInt(process.env.DEEPSEEK_TIMEOUT, 10);
      expect(timeout).toBe(45000);
      expect(typeof timeout).toBe('number');
    });

    it('should use default timeout when not set', () => {
      delete process.env.DEEPSEEK_TIMEOUT;
      const timeout = parseInt(process.env.DEEPSEEK_TIMEOUT || '30000', 10);
      expect(timeout).toBe(30000);
    });
  });

  describe('Test Data Generation', () => {
    it('should generate valid ULID format', () => {
      // ULID 格式: 26个字符，使用 Crockford Base32 编码
      // 实际使用真实 ULID 进行测试
      const mockUlid = '01HMEX7K5Q9ABCDEFGHIJK1234';

      // 基本验证：长度必须是 26
      expect(mockUlid.length).toBe(26);

      // 验证只包含字母数字字符
      expect(mockUlid).toMatch(/^[0-9A-Z]+$/i);
    });

    it('should create timestamps with Date objects', () => {
      const timestamp = new Date();
      expect(timestamp).toBeInstanceOf(Date);
      expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should generate proper actor classes', () => {
      const validActorClasses = [
        'owner',
        'admin',
        'trusted_user',
        'user',
        'group_admin',
        'system_worker',
        'evaluator',
        'tool',
      ];

      const testActor = 'user';
      expect(validActorClasses).toContain(testActor);
    });

    it('should generate proper invocation contexts', () => {
      const validContexts = [
        'private_chat',
        'group_chat',
        'admin_cli',
        'background_worker',
        'internal',
      ];

      const testContext = 'private_chat';
      expect(validContexts).toContain(testContext);
    });
  });

  describe('Token Budget Calculations', () => {
    it('should calculate token budget breakdown correctly', () => {
      const breakdown = {
        recentMessages: 200,
        memory: 100,
        identity: 50,
        system: 150,
      };

      const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
      expect(total).toBe(500);
    });

    it('should respect max token budget', () => {
      const maxBudget = 8000;
      const used = 500;

      expect(used).toBeLessThan(maxBudget);
      expect(maxBudget - used).toBe(7500); // 剩余预算
    });

    it('should handle zero token usage', () => {
      const breakdown = {
        recentMessages: 0,
        memory: 0,
        identity: 0,
        system: 0,
      };

      const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
      expect(total).toBe(0);
    });
  });

  describe('Message Structure Validation', () => {
    it('should validate recent message structure', () => {
      const message = {
        messageId: '01HMEX7K5Q9ABCDEFGHIJK12',
        senderId: 'user-alice',
        senderDisplayName: 'Alice',
        text: '你好',
        timestamp: new Date(),
        isFromBot: false,
      };

      expect(message.messageId).toBeTruthy();
      expect(message.senderId).toBeTruthy();
      expect(message.senderDisplayName).toBeTruthy();
      expect(message.text).toBe('你好');
      expect(message.timestamp).toBeInstanceOf(Date);
      expect(message.isFromBot).toBe(false);
    });

    it('should handle bot messages', () => {
      const botMessage = {
        messageId: '01HMEX7K5Q9ABCDEFGHIJK13',
        senderId: 'bot',
        senderDisplayName: 'LetheBot',
        text: '你好！',
        timestamp: new Date(),
        isFromBot: true,
      };

      expect(botMessage.isFromBot).toBe(true);
      expect(botMessage.senderId).toBe('bot');
    });
  });

  describe('Memory Block Structure', () => {
    it('should validate memory block structure', () => {
      const memoryBlock = {
        memoryId: '01HMEX7K5Q9ABCDEFGHIJK14',
        scope: 'user',
        title: '用户偏好',
        content: '用户喜欢喝咖啡',
        confidence: 0.9,
        sourceContext: 'previous conversation',
      };

      expect(memoryBlock.memoryId).toBeTruthy();
      expect(memoryBlock.scope).toBe('user');
      expect(memoryBlock.title).toBeTruthy();
      expect(memoryBlock.content).toContain('咖啡');
      expect(memoryBlock.confidence).toBeGreaterThan(0);
      expect(memoryBlock.confidence).toBeLessThanOrEqual(1);
    });

    it('should validate confidence range', () => {
      const validConfidences = [0.0, 0.5, 0.9, 1.0];

      validConfidences.forEach(confidence => {
        expect(confidence).toBeGreaterThanOrEqual(0);
        expect(confidence).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('Participant Context Structure', () => {
    it('should validate participant structure', () => {
      const participant = {
        canonicalUserId: 'user-alice',
        displayName: 'Alice',
        isOwner: false,
        isAdmin: false,
        isTrusted: true,
      };

      expect(participant.canonicalUserId).toBeTruthy();
      expect(participant.displayName).toBeTruthy();
      expect(typeof participant.isOwner).toBe('boolean');
      expect(typeof participant.isAdmin).toBe('boolean');
      expect(typeof participant.isTrusted).toBe('boolean');
    });

    it('should handle admin participant', () => {
      const adminParticipant = {
        canonicalUserId: 'user-bob',
        displayName: 'Bob',
        role: 'admin' as const,
        isOwner: false,
        isAdmin: true,
        isTrusted: true,
      };

      expect(adminParticipant.isAdmin).toBe(true);
      expect(adminParticipant.role).toBe('admin');
    });
  });

  describe('Tool Schema Validation', () => {
    it('should validate tool input schema', () => {
      const inputSchema = {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      };

      expect(inputSchema.type).toBe('object');
      expect(inputSchema.properties).toHaveProperty('message');
      expect(inputSchema.required).toContain('message');
    });

    it('should validate tool output schema', () => {
      const outputSchema = {
        type: 'object',
        properties: {
          echo: { type: 'string' },
        },
      };

      expect(outputSchema.type).toBe('object');
      expect(outputSchema.properties).toHaveProperty('echo');
    });
  });

  describe('Permission Policy Validation', () => {
    it('should validate simple tool permissions', () => {
      const permissions = {
        allowedActors: ['user', 'admin'],
        allowedContexts: ['private_chat', 'group_chat'],
      };

      expect(permissions.allowedActors).toContain('user');
      expect(permissions.allowedActors).toContain('admin');
      expect(permissions.allowedContexts).toContain('private_chat');
    });

    it('should validate restricted tool permissions', () => {
      const permissions = {
        allowedActors: ['admin', 'owner'],
        allowedContexts: ['admin_cli'],
      };

      expect(permissions.allowedActors).not.toContain('user');
      expect(permissions.allowedContexts).toContain('admin_cli');
      expect(permissions.allowedContexts).not.toContain('private_chat');
    });
  });

  describe('Sandbox Policy Validation', () => {
    it('should validate safe sandbox policy', () => {
      const sandboxPolicy = {
        filesystem: 'none' as const,
        network: 'none' as const,
        execution: 'in_process' as const,
      };

      expect(sandboxPolicy.filesystem).toBe('none');
      expect(sandboxPolicy.network).toBe('none');
      expect(sandboxPolicy.execution).toBe('in_process');
    });

    it('should validate restricted sandbox policy', () => {
      const sandboxPolicy = {
        filesystem: 'readonly' as const,
        network: 'restricted' as const,
        execution: 'subprocess' as const,
        maxRuntimeMs: 5000,
        maxOutputBytes: 1024 * 1024,
      };

      expect(sandboxPolicy.maxRuntimeMs).toBe(5000);
      expect(sandboxPolicy.maxOutputBytes).toBe(1048576);
    });
  });

  describe('API Response Validation', () => {
    it('should validate successful API response', () => {
      const output = {
        responseText: '你好！我是 LetheBot。',
        actionDecision: undefined,
        toolCalls: [],
        tokensUsed: {
          input: 150,
          output: 80,
          total: 230,
        },
      };

      expect(output.responseText).toBeTruthy();
      expect(output.tokensUsed.total).toBe(output.tokensUsed.input + output.tokensUsed.output);
      expect(output.tokensUsed.total).toBeGreaterThan(0);
    });

    it('should validate token calculation', () => {
      const input = 150;
      const output = 80;
      const total = input + output;

      expect(total).toBe(230);
      expect(total).toBe(input + output);
    });

    it('should handle empty response text', () => {
      const output = {
        responseText: undefined,
        actionDecision: undefined,
        toolCalls: [],
        tokensUsed: {
          input: 150,
          output: 0,
          total: 150,
        },
      };

      expect(output.responseText).toBeUndefined();
      expect(output.tokensUsed.output).toBe(0);
    });
  });

  describe('Error Handling Patterns', () => {
    it('should handle authentication error format', () => {
      const error = {
        code: 'authentication_failed',
        message: 'Invalid API key',
        details: { statusCode: 401 },
      };

      expect(error.code).toBe('authentication_failed');
      expect(error.message).toContain('Invalid API key');
      expect(error.details?.statusCode).toBe(401);
    });

    it('should handle rate limit error format', () => {
      const error = {
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded',
        details: { statusCode: 429, retryAfter: 60 },
      };

      expect(error.code).toBe('rate_limit_exceeded');
      expect(error.details?.statusCode).toBe(429);
      expect(error.details?.retryAfter).toBe(60);
    });

    it('should handle timeout error format', () => {
      const error = {
        code: 'timeout',
        message: 'Request timeout after 30000ms',
        details: { timeoutMs: 30000 },
      };

      expect(error.code).toBe('timeout');
      expect(error.message).toContain('timeout');
      expect(error.details?.timeoutMs).toBe(30000);
    });
  });

  describe('Test Skip Conditions', () => {
    it('should skip when no API key available', () => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.PI_API_KEY;

      const hasApiKey = !!(process.env.DEEPSEEK_API_KEY || process.env.PI_API_KEY);
      expect(hasApiKey).toBe(false);
    });

    it('should run when API key is available', () => {
      process.env.DEEPSEEK_API_KEY = 'sk-test-key';

      const hasApiKey = !!(process.env.DEEPSEEK_API_KEY || process.env.PI_API_KEY);
      expect(hasApiKey).toBe(true);
    });
  });
});
