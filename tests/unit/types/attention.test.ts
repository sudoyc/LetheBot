import { describe, it, expect } from 'vitest';
import type { AttentionSignals } from '../../../src/types/attention';

describe('Attention Signals', () => {
  describe('AttentionSignals', () => {
    it('should allow creating silent classification', () => {
      const signals: AttentionSignals = {
        classification: 'silent',
        triggerScore: 0.1,
        triggerReasons: [],
        suppressors: ['high_speed_chat', 'bot_spoke_recently'],
        recommendedPath: 'silent_fast_path',
      };

      expect(signals.classification).toBe('silent');
      expect(signals.recommendedPath).toBe('silent_fast_path');
      expect(signals.suppressors).toHaveLength(2);
    });

    it('should allow creating needs_response classification', () => {
      const signals: AttentionSignals = {
        classification: 'needs_response',
        triggerScore: 0.8,
        triggerReasons: ['@bot', 'direct_question'],
        suppressors: [],
        recommendedPath: 'reply_fast_path',
      };

      expect(signals.classification).toBe('needs_response');
      expect(signals.triggerScore).toBe(0.8);
      expect(signals.triggerReasons).toContain('@bot');
      expect(signals.recommendedPath).toBe('reply_fast_path');
    });

    it('should allow creating needs_evaluation classification', () => {
      const signals: AttentionSignals = {
        classification: 'needs_evaluation',
        triggerScore: 0.95,
        triggerReasons: ['@bot', 'admin_command', 'sensitive_content'],
        suppressors: [],
        recommendedPath: 'risk_path',
      };

      expect(signals.classification).toBe('needs_evaluation');
      expect(signals.recommendedPath).toBe('risk_path');
      expect(signals.triggerReasons).toHaveLength(3);
    });

    it('should support all classification types', () => {
      const classifications: Array<AttentionSignals['classification']> = [
        'silent',
        'needs_response',
        'needs_evaluation',
      ];

      classifications.forEach((classification) => {
        const signals: AttentionSignals = {
          classification,
          triggerScore: 0.5,
          triggerReasons: [],
          suppressors: [],
          recommendedPath: 'silent_fast_path',
        };

        expect(signals.classification).toBe(classification);
      });
    });

    it('should support all recommended paths', () => {
      const paths: Array<AttentionSignals['recommendedPath']> = [
        'silent_fast_path',
        'reply_fast_path',
        'risk_path',
      ];

      paths.forEach((path) => {
        const signals: AttentionSignals = {
          classification: 'silent',
          triggerScore: 0.5,
          triggerReasons: [],
          suppressors: [],
          recommendedPath: path,
        };

        expect(signals.recommendedPath).toBe(path);
      });
    });

    it('should track trigger score range', () => {
      const lowScore: AttentionSignals = {
        classification: 'silent',
        triggerScore: 0.0,
        triggerReasons: [],
        suppressors: ['not_mentioned'],
        recommendedPath: 'silent_fast_path',
      };

      const highScore: AttentionSignals = {
        classification: 'needs_evaluation',
        triggerScore: 1.0,
        triggerReasons: ['@bot', 'urgent', 'admin'],
        suppressors: [],
        recommendedPath: 'risk_path',
      };

      expect(lowScore.triggerScore).toBe(0.0);
      expect(highScore.triggerScore).toBe(1.0);
    });

    it('should track multiple trigger reasons', () => {
      const signals: AttentionSignals = {
        classification: 'needs_response',
        triggerScore: 0.75,
        triggerReasons: [
          '@bot',
          'reply_to_bot',
          'question_mark',
          'first_message_in_hour',
        ],
        suppressors: [],
        recommendedPath: 'reply_fast_path',
      };

      expect(signals.triggerReasons).toHaveLength(4);
      expect(signals.triggerReasons).toContain('@bot');
      expect(signals.triggerReasons).toContain('question_mark');
    });

    it('should track multiple suppressors', () => {
      const signals: AttentionSignals = {
        classification: 'silent',
        triggerScore: 0.3,
        triggerReasons: ['casual_chat'],
        suppressors: [
          'high_speed_chat',
          'bot_spoke_recently',
          'not_mentioned',
          'conversation_cooldown',
        ],
        recommendedPath: 'silent_fast_path',
      };

      expect(signals.suppressors).toHaveLength(4);
      expect(signals.suppressors).toContain('high_speed_chat');
      expect(signals.suppressors).toContain('conversation_cooldown');
    });

    it('should allow signals with no suppressors', () => {
      const signals: AttentionSignals = {
        classification: 'needs_response',
        triggerScore: 0.9,
        triggerReasons: ['@bot', 'urgent_keyword'],
        suppressors: [],
        recommendedPath: 'reply_fast_path',
      };

      expect(signals.suppressors).toHaveLength(0);
    });

    it('should allow signals with no trigger reasons', () => {
      const signals: AttentionSignals = {
        classification: 'silent',
        triggerScore: 0.0,
        triggerReasons: [],
        suppressors: ['no_trigger_detected'],
        recommendedPath: 'silent_fast_path',
      };

      expect(signals.triggerReasons).toHaveLength(0);
    });
  });
});
