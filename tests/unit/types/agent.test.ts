import { describe, it, expect } from 'vitest';
import type { AgentTurn } from '../../../src/types/agent';

describe('Agent Turn', () => {
  describe('AgentTurn', () => {
    it('should allow creating a complete agent turn', () => {
      const turn: AgentTurn = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        conversationId: 'conv-123',
        triggerEvent: {
          id: 'event-001',
          type: 'chat.message.received',
        },
        contextPackId: 'ctx-001',
        piPromptId: 'prompt-001',
        piModel: 'claude-opus-4',
        piProvider: 'anthropic',
        actionDecisionId: 'decision-001',
        responseText: 'Hello! How can I help you?',
        toolCalls: ['tool-call-001', 'tool-call-002'],
        status: 'completed',
        startedAt: new Date('2024-01-01T10:00:00Z'),
        completedAt: new Date('2024-01-01T10:00:05Z'),
        tokensUsed: {
          input: 1000,
          output: 500,
          total: 1500,
        },
      };

      expect(turn.id).toBeTruthy();
      expect(turn.status).toBe('completed');
      expect(turn.tokensUsed.total).toBe(1500);
    });

    it('should support all status values', () => {
      const statuses: Array<AgentTurn['status']> = [
        'pending',
        'running',
        'completed',
        'failed',
        'aborted',
      ];

      statuses.forEach((status) => {
        const turn: AgentTurn = {
          id: `turn-${status}`,
          conversationId: 'conv-123',
          triggerEvent: {
            id: 'event-001',
            type: 'chat.message.received',
          },
          contextPackId: 'ctx-001',
          piModel: 'claude-sonnet-4',
          piProvider: 'anthropic',
          toolCalls: [],
          status,
          startedAt: new Date(),
          tokensUsed: {
            input: 0,
            output: 0,
            total: 0,
          },
        };

        expect(turn.status).toBe(status);
      });
    });

    it('should allow minimal agent turn', () => {
      const turn: AgentTurn = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        conversationId: 'conv-123',
        triggerEvent: {
          id: 'event-001',
          type: 'chat.message.received',
        },
        contextPackId: 'ctx-001',
        piModel: 'claude-haiku-4',
        piProvider: 'anthropic',
        toolCalls: [],
        status: 'pending',
        startedAt: new Date(),
        tokensUsed: {
          input: 0,
          output: 0,
          total: 0,
        },
      };

      expect(turn.piPromptId).toBeUndefined();
      expect(turn.actionDecisionId).toBeUndefined();
      expect(turn.responseText).toBeUndefined();
      expect(turn.completedAt).toBeUndefined();
    });

    it('should track tool calls', () => {
      const turn: AgentTurn = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        conversationId: 'conv-123',
        triggerEvent: {
          id: 'event-001',
          type: 'chat.message.received',
        },
        contextPackId: 'ctx-001',
        piModel: 'claude-opus-4',
        piProvider: 'anthropic',
        toolCalls: ['tool-call-001', 'tool-call-002', 'tool-call-003'],
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        tokensUsed: {
          input: 2000,
          output: 1000,
          total: 3000,
        },
      };

      expect(turn.toolCalls).toHaveLength(3);
    });

    it('should allow turn without tool calls', () => {
      const turn: AgentTurn = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        conversationId: 'conv-123',
        triggerEvent: {
          id: 'event-001',
          type: 'chat.message.received',
        },
        contextPackId: 'ctx-001',
        piModel: 'claude-sonnet-4',
        piProvider: 'anthropic',
        responseText: 'Simple response',
        toolCalls: [],
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        tokensUsed: {
          input: 500,
          output: 50,
          total: 550,
        },
      };

      expect(turn.toolCalls).toHaveLength(0);
    });

    it('should track failed turns', () => {
      const turn: AgentTurn = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        conversationId: 'conv-123',
        triggerEvent: {
          id: 'event-001',
          type: 'chat.message.received',
        },
        contextPackId: 'ctx-001',
        piModel: 'claude-opus-4',
        piProvider: 'anthropic',
        toolCalls: [],
        status: 'failed',
        startedAt: new Date(),
        completedAt: new Date(),
        tokensUsed: {
          input: 1000,
          output: 0,
          total: 1000,
        },
      };

      expect(turn.status).toBe('failed');
      expect(turn.completedAt).toBeDefined();
    });

    it('should track aborted turns', () => {
      const turn: AgentTurn = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        conversationId: 'conv-123',
        triggerEvent: {
          id: 'event-001',
          type: 'chat.message.received',
        },
        contextPackId: 'ctx-001',
        piModel: 'claude-opus-4',
        piProvider: 'anthropic',
        toolCalls: [],
        status: 'aborted',
        startedAt: new Date(),
        tokensUsed: {
          input: 500,
          output: 0,
          total: 500,
        },
      };

      expect(turn.status).toBe('aborted');
      expect(turn.completedAt).toBeUndefined();
    });
  });
});
