import { describe, it, expect } from 'vitest';
import { MockPi } from '../../../src/pi/mock-pi';
import type { ContextPack } from '../../../src/types/context';

describe('MockPi', () => {
  const mockPi = new MockPi();

  const buildTestContext = (): ContextPack => ({
    id: 'ctx-001',
    turnId: 'turn-001',
    createdAt: new Date(),
    conversation: {
      conversationId: 'conv-001',
      conversationType: 'private',
    },
    recentMessages: [
      {
        messageId: 'msg-001',
        senderId: 'user-alice',
        text: '你好',
        timestamp: new Date(),
        senderDisplayName: 'Alice',
      },
    ],
    memory: {
      retrievedFacts: [],
      selectedMemoryIds: [],
    },
    participants: [],
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
  });

  describe('run', () => {
    it('should return mock response for greeting', async () => {
      const result = await mockPi.run({
        contextPack: buildTestContext(),
      });

      expect(result.responseText).toBeDefined();
      expect(result.responseText).toContain('你好');
      expect(result.actionDecision).toBeDefined();
      expect(result.toolCalls).toEqual([]);
      expect(result.tokensUsed.total).toBeGreaterThan(0);
    });

    it('should generate action decision with reply_short', async () => {
      const result = await mockPi.run({
        contextPack: buildTestContext(),
      });

      expect(result.actionDecision?.actions).toBeDefined();
      expect(result.actionDecision?.actions[0].type).toBe('reply_short');
      expect(result.actionDecision?.riskLevel).toBe('low');
      expect(result.actionDecision?.confidence).toBeGreaterThan(0.5);
    });

    it('should track token usage', async () => {
      const result = await mockPi.run({
        contextPack: buildTestContext(),
      });

      expect(result.tokensUsed.input).toBeGreaterThan(0);
      expect(result.tokensUsed.output).toBeGreaterThan(0);
      expect(result.tokensUsed.total).toBe(result.tokensUsed.input + result.tokensUsed.output);
    });

    it('should handle command patterns', async () => {
      const ctx = buildTestContext();
      ctx.recentMessages[0].text = '/help';

      const result = await mockPi.run({ contextPack: ctx });

      expect(result.responseText).toContain('帮助');
      expect(result.actionDecision?.riskLevel).toBe('medium');
    });

    it('should handle question patterns', async () => {
      const ctx = buildTestContext();
      ctx.recentMessages[0].text = '今天星期几？';

      const result = await mockPi.run({ contextPack: ctx });

      expect(result.responseText).toBeDefined();
      expect(result.actionDecision?.actions[0].type).toBe('reply_short');
    });

    it('should include action decision reasons', async () => {
      const result = await mockPi.run({
        contextPack: buildTestContext(),
      });

      expect(result.actionDecision?.reasons).toBeDefined();
      expect(result.actionDecision?.reasons.length).toBeGreaterThan(0);
      expect(result.actionDecision?.suppressors).toBeDefined();
    });
  });

  describe('Mock behavior', () => {
    it('should be marked as mock', () => {
      expect(mockPi.isMock()).toBe(true);
    });

    it('should return model info', () => {
      const info = mockPi.getModelInfo();
      expect(info.model).toBe('mock-pi');
      expect(info.provider).toBe('mock');
    });
  });
});
