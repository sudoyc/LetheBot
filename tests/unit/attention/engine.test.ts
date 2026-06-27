import { describe, it, expect } from 'vitest';
import { AttentionEngine } from '../../../src/attention/engine';

describe('AttentionEngine', () => {
  const engine = new AttentionEngine();

  describe('Silent fast path', () => {
    it('should classify ordinary group message as silent', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: false,
        text: '今天天气不错',
        senderId: 'user-001',
      });

      expect(signals.classification).toBe('silent');
      expect(signals.recommendedPath).toBe('silent_fast_path');
      expect(signals.suppressors).toContain('high_speed_chat');
    });

    it('should not trigger on short casual messages', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: false,
        text: '哈哈',
        senderId: 'user-002',
      });

      expect(signals.classification).toBe('silent');
      expect(signals.triggerScore).toBeLessThan(0.5);
    });
  });

  describe('Reply fast path', () => {
    it('should trigger on @bot mention', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: true,
        text: '@bot 你好',
        senderId: 'user-003',
      });

      expect(signals.classification).toBe('needs_response');
      expect(signals.recommendedPath).toBe('reply_fast_path');
      expect(signals.triggerReasons).toContain('@bot');
      expect(signals.triggerScore).toBeGreaterThanOrEqual(0.5);
    });

    it('should trigger on reply to bot', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: false,
        text: '好的，谢谢',
        senderId: 'user-004',
        replyToBot: true,
      });

      expect(signals.classification).toBe('needs_response');
      expect(signals.triggerReasons).toContain('reply_to_bot');
    });

    it('should trigger on private message', () => {
      const signals = engine.analyze({
        conversationType: 'private',
        mentionsBot: false,
        text: '你好',
        senderId: 'user-005',
      });

      expect(signals.classification).toBe('needs_response');
      expect(signals.recommendedPath).toBe('reply_fast_path');
      expect(signals.triggerReasons).toContain('private_message');
    });

    it('should detect question patterns', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: true,
        text: '@bot 今天星期几？',
        senderId: 'user-006',
      });

      expect(signals.triggerReasons).toContain('question');
      expect(signals.triggerScore).toBeGreaterThan(0.8);
    });
  });

  describe('Risk path', () => {
    it('should trigger evaluation on command', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: false,
        text: '/remember 重要信息',
        senderId: 'user-007',
      });

      expect(signals.classification).toBe('needs_evaluation');
      expect(signals.recommendedPath).toBe('risk_path');
      expect(signals.triggerReasons).toContain('command');
    });

    it('should trigger evaluation on admin instruction', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: false,
        text: '管理员设置群规则',
        senderId: 'admin-001',
        senderRole: 'admin',
      });

      expect(signals.classification).toBe('needs_evaluation');
      expect(signals.triggerReasons).toContain('admin_instruction');
    });

    it('should handle high-score triggers', () => {
      const signals = engine.analyze({
        conversationType: 'private',
        mentionsBot: true,
        text: '/help',
        senderId: 'user-008',
        senderRole: 'owner',
      });

      expect(signals.classification).toBe('needs_evaluation');
      expect(signals.triggerScore).toBeGreaterThan(0.9);
    });
  });

  describe('Trigger scoring', () => {
    it('should accumulate multiple triggers', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: true,
        text: '@bot 这是什么？',
        senderId: 'user-009',
        replyToBot: true,
      });

      expect(signals.triggerReasons).toContain('@bot');
      expect(signals.triggerReasons).toContain('reply_to_bot');
      expect(signals.triggerReasons).toContain('question');
      expect(signals.triggerScore).toBeGreaterThan(0.9);
    });

    it('should clamp trigger score to 1.0', () => {
      const signals = engine.analyze({
        conversationType: 'private',
        mentionsBot: true,
        text: '/command with question?',
        senderId: 'user-010',
        replyToBot: true,
        senderRole: 'owner',
      });

      expect(signals.triggerScore).toBe(1.0);
    });
  });

  describe('Suppressors', () => {
    it('should record suppressor reasons', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: false,
        text: 'ok',
        senderId: 'user-011',
      });

      expect(signals.suppressors).toContain('high_speed_chat');
    });

    it('should not suppress strong triggers', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: true,
        text: '@bot hi',
        senderId: 'user-012',
      });

      // Even with short message, @bot overrides suppressor
      expect(signals.classification).toBe('needs_response');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty text', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: false,
        text: '',
        senderId: 'user-013',
      });

      expect(signals.classification).toBe('silent');
    });

    it('should handle long group messages without mention', () => {
      const signals = engine.analyze({
        conversationType: 'group',
        mentionsBot: false,
        text: '这是一条很长的消息，讨论了很多技术细节和实现方案。',
        senderId: 'user-014',
      });

      expect(signals.classification).toBe('silent');
      expect(signals.suppressors).not.toContain('high_speed_chat');
    });
  });
});
