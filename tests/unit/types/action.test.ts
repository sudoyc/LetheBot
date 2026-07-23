import { describe, it, expect } from 'vitest';
import type {
  ActionDecision,
  ActionPlan,
  ActionTarget,
  ActionPayload,
  ActionExecutionResult,
  ActionType,
  ToolCallRequest,
  MemoryProposalRequest,
} from '../../../src/types/action';

describe('Action Decision & Execution', () => {
  describe('ActionTarget', () => {
    it('should allow creating action targets', () => {
      const target: ActionTarget = {
        conversationId: 'conv-123',
        conversationType: 'group',
        groupId: 'group-456',
      };

      expect(target.conversationId).toBe('conv-123');
      expect(target.conversationType).toBe('group');
      expect(target.groupId).toBe('group-456');
    });

    it('should allow private conversation targets', () => {
      const target: ActionTarget = {
        conversationId: 'conv-private-001',
        conversationType: 'private',
        userId: 'qq-10001',
        canonicalUserId: 'user-001',
      };

      expect(target.conversationType).toBe('private');
      expect(target.userId).toBe('qq-10001');
      expect(target.canonicalUserId).toBe('user-001');
    });
  });

  describe('ActionPayload', () => {
    it('should allow text payload', () => {
      const payload: ActionPayload = {
        text: 'Hello world',
      };

      expect(payload.text).toBe('Hello world');
    });

    it('should allow tool call payload', () => {
      const toolCall: ToolCallRequest = {
        id: 'tool-001',
        turnId: 'turn-001',
        toolName: 'search',
        input: { query: 'test' },
        requestedBy: 'pi',
        actor: {
          canonicalUserId: 'user-001',
          actorClass: 'user',
        },
        context: 'group_chat',
      };

      const payload: ActionPayload = {
        toolCall,
      };

      expect(payload.toolCall?.toolName).toBe('search');
    });

    it('should allow memory proposal payload', () => {
      const proposal: MemoryProposalRequest = {
        scope: 'user',
        canonicalUserId: 'user-001',
        kind: 'preference',
        title: 'User preference',
        content: 'Prefers concise responses',
        confidence: 0.9,
        sourceContext: 'chat_message:msg-123',
      };

      const payload: ActionPayload = {
        memoryProposal: proposal,
      };

      expect(payload.memoryProposal?.title).toBe('User preference');
    });

    it('should allow reaction payload', () => {
      const payload: ActionPayload = {
        reaction: '👍',
      };

      expect(payload.reaction).toBe('👍');
    });
  });

  describe('ActionPlan', () => {
    it('should allow creating action plans', () => {
      const plan: ActionPlan = {
        type: 'reply_short',
        priority: 1,
        target: {
          conversationId: 'conv-123',
          conversationType: 'group',
          groupId: 'group-456',
        },
        payload: {
          text: 'Sure!',
        },
        constraints: {
          evaluatorRequired: false,
          maxResponseTokens: 100,
          redactionLevel: 'none',
        },
        reason: 'Quick acknowledgment',
      };

      expect(plan.type).toBe('reply_short');
      expect(plan.priority).toBe(1);
      expect(plan.reason).toBe('Quick acknowledgment');
    });

    it('should allow proactive DM metadata on constraints', () => {
      const plan: ActionPlan = {
        type: 'dm_user',
        priority: 1,
        target: {
          conversationId: 'private:qq-10001',
          conversationType: 'private',
          userId: 'qq-10001',
          canonicalUserId: 'user-001',
        },
        payload: {
          text: 'Reminder',
        },
        constraints: {
          proactive: true,
          proactiveTrigger: 'reminder',
          evaluatorRequired: true,
          cooldownKey: 'dm:user-001:reminder',
          cooldownSeconds: 3600,
        },
        reason: 'Scheduled reminder',
      };

      expect(plan.constraints.proactive).toBe(true);
      expect(plan.constraints.proactiveTrigger).toBe('reminder');
    });

    it('should support all action types', () => {
      const types: ActionType[] = [
        'silent_store',
        'silent_summarize_later',
        'reply_short',
        'reply_full',
        'reply_with_tool',
        'propose_memory',
        'admin_digest',
        'schedule_background_task',
        'dm_user',
        'react_only',
        'send_folded_forward',
        'ask_clarification',
      ];

      types.forEach((type) => {
        const plan: ActionPlan = {
          type,
          priority: 1,
          constraints: {},
          reason: `Test ${type}`,
        };

        expect(plan.type).toBe(type);
      });
    });
  });

  describe('ActionDecision', () => {
    it('should allow creating action decisions', () => {
      const decision: ActionDecision = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        turnId: 'turn-001',
        createdAt: new Date(),
        decidedBy: 'pi',
        actions: [
          {
            type: 'reply_full',
            priority: 1,
            constraints: {
              evaluatorRequired: true,
            },
            reason: 'User asked a question',
          },
        ],
        riskLevel: 'low',
        confidence: 0.9,
        reasons: ['User asked a direct question', 'No sensitive content detected'],
        suppressors: [],
        evaluatorRequired: true,
      };

      expect(decision.decidedBy).toBe('pi');
      expect(decision.actions).toHaveLength(1);
      expect(decision.riskLevel).toBe('low');
      expect(decision.evaluatorRequired).toBe(true);
    });

    it('should allow decisions with suppressors', () => {
      const decision: ActionDecision = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        turnId: 'turn-002',
        createdAt: new Date(),
        decidedBy: 'attention',
        actions: [],
        riskLevel: 'low',
        confidence: 0.95,
        reasons: ['No trigger detected'],
        suppressors: ['high_speed_chat', 'bot_spoke_recently'],
        evaluatorRequired: false,
      };

      expect(decision.suppressors).toHaveLength(2);
      expect(decision.actions).toHaveLength(0);
    });
  });

  describe('ActionExecutionResult', () => {
    it('should allow successful execution results', () => {
      const result: ActionExecutionResult = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        actionDecisionId: 'decision-001',
        actionType: 'reply_short',
        executedAt: new Date(),
        status: 'success',
        executed: {
          messageId: 'msg-789',
        },
        auditLevel: 'summary',
        auditEntry: '{"action":"reply","messageId":"msg-789"}',
      };

      expect(result.status).toBe('success');
      expect(result.executed?.messageId).toBe('msg-789');
    });

    it('should allow downgraded execution results', () => {
      const result: ActionExecutionResult = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        actionDecisionId: 'decision-002',
        actionType: 'reply_short',
        executedAt: new Date(),
        status: 'downgraded',
        downgradedFrom: 'reply_full',
        downgradedReason: 'Token budget exceeded',
        executed: {
          messageId: 'msg-790',
        },
        auditLevel: 'redacted_full',
      };

      expect(result.status).toBe('downgraded');
      expect(result.downgradedFrom).toBe('reply_full');
      expect(result.downgradedReason).toBe('Token budget exceeded');
    });

    it('should allow failed execution results', () => {
      const result: ActionExecutionResult = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        actionDecisionId: 'decision-003',
        actionType: 'send_folded_forward',
        executedAt: new Date(),
        status: 'failed',
        error: {
          code: 'CAPABILITY_NOT_AVAILABLE',
          message: 'Gateway does not support folded forward',
          recoverable: false,
        },
        auditLevel: 'full',
      };

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('CAPABILITY_NOT_AVAILABLE');
      expect(result.error?.recoverable).toBe(false);
    });

    it('should allow rejected execution results', () => {
      const result: ActionExecutionResult = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        actionDecisionId: 'decision-004',
        actionType: 'dm_user',
        executedAt: new Date(),
        status: 'rejected',
        error: {
          code: 'PERMISSION_DENIED',
          message: 'User has not authorized DMs',
          recoverable: true,
        },
        auditLevel: 'summary',
      };

      expect(result.status).toBe('rejected');
      expect(result.error?.recoverable).toBe(true);
    });
  });
});
