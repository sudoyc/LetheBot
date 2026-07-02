import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluatorStub } from '../../../src/evaluator/evaluator-stub';
import type {
  ToolEvaluationRequest,
  MemoryEvaluationRequest,
  SocialEvaluationRequest,
} from '../../../src/types/evaluator';

describe('EvaluatorStub', () => {
  let evaluator: EvaluatorStub;

  beforeEach(() => {
    evaluator = new EvaluatorStub();
  });

  describe('evaluateTool', () => {
    it('should propose high-risk tools (shell_exec)', async () => {
      const request: ToolEvaluationRequest = {
        requestId: 'req-001',
        domain: 'tool',
        turnId: 'turn-001',
        actor: {
          canonicalUserId: 'user-001',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['event-001'],
        contextSummary: 'User requested system command',
        toolName: 'exec',
        capabilities: ['shell_exec'],
        toolInput: { command: 'ls -la' },
        proposedReason: 'List files',
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateTool(request);

      expect(result.decision).toBe('propose');
      expect(result.riskLevel).toBe('high');
      expect(result.confidence).toBeGreaterThan(0.8);
      expect(result.reason).toContain('high-risk capability');
      expect(result.decisionId).toBeTruthy();
      expect(result.requestId).toBe('req-001');
      expect(result.evaluatorVersion).toBe('stub-v1');
    });

    it('should propose platform_admin tools', async () => {
      const request: ToolEvaluationRequest = {
        requestId: 'req-002',
        domain: 'tool',
        turnId: 'turn-002',
        actor: {
          canonicalUserId: 'user-002',
          actorClass: 'user',
        },
        context: 'admin_cli',
        sourceEventIds: ['event-002'],
        contextSummary: 'Admin requested platform change',
        toolName: 'platform_control',
        capabilities: ['platform_admin'],
        toolInput: { action: 'restart' },
        proposedReason: 'Restart service',
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateTool(request);

      expect(result.decision).toBe('propose');
      expect(result.riskLevel).toBe('high');
    });

    it('should approve medium-risk tools (network)', async () => {
      const request: ToolEvaluationRequest = {
        requestId: 'req-003',
        domain: 'tool',
        turnId: 'turn-003',
        actor: {
          canonicalUserId: 'user-003',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['event-003'],
        contextSummary: 'User requested web search',
        toolName: 'search',
        capabilities: ['network'],
        toolInput: { query: 'weather today' },
        proposedReason: 'Search weather info',
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateTool(request);

      expect(result.decision).toBe('approve');
      expect(result.riskLevel).toBe('medium');
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.reason).toContain('Medium-risk');
    });

    it('should approve low-risk tools', async () => {
      const request: ToolEvaluationRequest = {
        requestId: 'req-004',
        domain: 'tool',
        turnId: 'turn-004',
        actor: {
          canonicalUserId: 'user-004',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['event-004'],
        contextSummary: 'User requested echo',
        toolName: 'echo',
        capabilities: ['read_context'],
        toolInput: { message: 'hello' },
        proposedReason: 'Echo message',
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateTool(request);

      expect(result.decision).toBe('approve');
      expect(result.riskLevel).toBe('low');
      expect(result.confidence).toBeGreaterThan(0.9);
    });
  });

  describe('evaluateMemory', () => {
    it('should recommend proposed state for high-risk memory', async () => {
      const request: MemoryEvaluationRequest = {
        requestId: 'req-005',
        domain: 'memory',
        turnId: 'turn-005',
        actor: {
          canonicalUserId: 'user-005',
          actorClass: 'user',
        },
        context: 'group_chat',
        sourceEventIds: ['event-005'],
        contextSummary: 'Group chat observation',
        memoryCandidate: {
          scope: 'user',
          canonicalUserId: 'user-006',
          kind: 'fact',
          title: 'User health information',
          content: 'User mentioned they have diabetes',
          confidence: 0.8,
          sourceContext: 'Group chat discussion',
        },
        initialRiskLevel: 'high',
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateMemory(request);

      expect(result.decision).toBe('approve');
      expect(result.riskLevel).toBe('high');
      expect(result.recommendedState).toBe('proposed');
      expect(result.recommendedVisibility).toBe('private_only');
      expect(result.reason).toContain('owner approval');
    });

    it('should restrict visibility for medium-risk memory', async () => {
      const request: MemoryEvaluationRequest = {
        requestId: 'req-006',
        domain: 'memory',
        turnId: 'turn-006',
        actor: {
          canonicalUserId: 'user-007',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['event-006'],
        contextSummary: 'Inferred preference',
        memoryCandidate: {
          scope: 'user',
          canonicalUserId: 'user-007',
          kind: 'preference',
          title: 'Communication style',
          content: 'User prefers concise responses',
          confidence: 0.7,
          sourceContext: 'Inferred from conversation pattern',
        },
        initialRiskLevel: 'medium',
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateMemory(request);

      expect(result.decision).toBe('approve');
      expect(result.riskLevel).toBe('medium');
      expect(result.recommendedState).toBe('active');
      expect(result.recommendedVisibility).toBe('private_only');
      expect(result.recommendedSensitivity).toBe('personal');
    });

    it('should approve low-risk memory directly', async () => {
      const request: MemoryEvaluationRequest = {
        requestId: 'req-007',
        domain: 'memory',
        turnId: 'turn-007',
        actor: {
          canonicalUserId: 'user-008',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['event-007'],
        contextSummary: 'User stated preference',
        memoryCandidate: {
          scope: 'user',
          canonicalUserId: 'user-008',
          kind: 'preference',
          title: 'Language preference',
          content: 'User prefers English',
          confidence: 0.95,
          sourceContext: 'User explicitly stated',
        },
        initialRiskLevel: 'low',
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateMemory(request);

      expect(result.decision).toBe('approve');
      expect(result.riskLevel).toBe('low');
      expect(result.recommendedState).toBe('active');
      expect(result.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('evaluateSocial', () => {
    it('should propose proactive messaging', async () => {
      const request: SocialEvaluationRequest = {
        requestId: 'req-008',
        domain: 'social',
        turnId: 'turn-008',
        actor: {
          actorClass: 'system_worker',
        },
        context: 'background_worker',
        sourceEventIds: ['event-008'],
        contextSummary: 'Scheduled reminder',
        proposedAction: {
          type: 'dm_user',
          priority: 5,
          target: {
            conversationId: 'conv-001',
            conversationType: 'private',
            userId: 'user-009',
          },
          payload: {
            text: 'Reminder: your task is due',
          },
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Scheduled reminder',
        },
        attentionSignals: {
          classification: 'needs_evaluation',
          triggerScore: 0.6,
          triggerReasons: ['scheduled_task'],
          suppressors: [],
          recommendedPath: 'risk_path',
        },
        isProactive: true,
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateSocial(request);

      expect(result.decision).toBe('propose');
      expect(result.riskLevel).toBe('high');
      expect(result.cooldownSeconds).toBe(300);
      expect(result.reason).toContain('owner approval');
    });

    it('should downgrade reply_full to reply_short in group chat', async () => {
      const request: SocialEvaluationRequest = {
        requestId: 'req-009',
        domain: 'social',
        turnId: 'turn-009',
        actor: {
          canonicalUserId: 'user-010',
          actorClass: 'user',
        },
        context: 'group_chat',
        sourceEventIds: ['event-009'],
        contextSummary: 'User question in group',
        proposedAction: {
          type: 'reply_full',
          priority: 7,
          target: {
            conversationId: 'group-001',
            conversationType: 'group',
            groupId: 'group-001',
          },
          payload: {
            text: 'Very long detailed explanation...',
          },
          constraints: {},
          reason: 'Answer user question',
        },
        attentionSignals: {
          classification: 'needs_response',
          triggerScore: 0.8,
          triggerReasons: ['@bot'],
          suppressors: [],
          recommendedPath: 'reply_fast_path',
        },
        isProactive: false,
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateSocial(request);

      expect(result.decision).toBe('downgrade');
      expect(result.riskLevel).toBe('medium');
      expect(result.downgradeAction).toBeDefined();
      expect(result.downgradeAction?.from).toBe('reply_full');
      expect(result.downgradeAction?.to).toBe('reply_short');
      expect(result.downgradeAction?.reason).toContain('concise');
    });

    it('should approve normal social actions', async () => {
      const request: SocialEvaluationRequest = {
        requestId: 'req-010',
        domain: 'social',
        turnId: 'turn-010',
        actor: {
          canonicalUserId: 'user-011',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['event-010'],
        contextSummary: 'User question',
        proposedAction: {
          type: 'reply_short',
          priority: 8,
          target: {
            conversationId: 'conv-002',
            conversationType: 'private',
            userId: 'user-011',
          },
          payload: {
            text: 'Sure, I can help with that.',
          },
          constraints: {},
          reason: 'Answer user question',
        },
        attentionSignals: {
          classification: 'needs_response',
          triggerScore: 0.9,
          triggerReasons: ['direct_message'],
          suppressors: [],
          recommendedPath: 'reply_fast_path',
        },
        isProactive: false,
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateSocial(request);

      expect(result.decision).toBe('approve');
      expect(result.riskLevel).toBe('low');
      expect(result.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('evaluator metadata', () => {
    it('should generate unique decision IDs', async () => {
      const request: ToolEvaluationRequest = {
        requestId: 'req-011',
        domain: 'tool',
        turnId: 'turn-011',
        actor: { actorClass: 'user' },
        context: 'private_chat',
        sourceEventIds: [],
        contextSummary: 'Test',
        toolName: 'test',
        capabilities: ['read_context'],
        toolInput: {},
        proposedReason: 'Test',
        createdAt: new Date(),
      };

      const result1 = await evaluator.evaluateTool(request);
      const result2 = await evaluator.evaluateTool(request);

      expect(result1.decisionId).not.toBe(result2.decisionId);
    });

    it('should include evaluator version', async () => {
      const request: MemoryEvaluationRequest = {
        requestId: 'req-012',
        domain: 'memory',
        turnId: 'turn-012',
        actor: { actorClass: 'user' },
        context: 'private_chat',
        sourceEventIds: [],
        contextSummary: 'Test',
        memoryCandidate: {
          scope: 'user',
          kind: 'preference',
          title: 'Test',
          content: 'Test',
          confidence: 0.9,
          sourceContext: 'Test',
        },
        initialRiskLevel: 'low',
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateMemory(request);

      expect(result.evaluatorVersion).toBe('stub-v1');
    });

    it('should preserve requestId in result', async () => {
      const request: SocialEvaluationRequest = {
        requestId: 'req-013',
        domain: 'social',
        turnId: 'turn-013',
        actor: { actorClass: 'user' },
        context: 'private_chat',
        sourceEventIds: [],
        contextSummary: 'Test',
        proposedAction: {
          type: 'reply_short',
          priority: 5,
          constraints: {},
          reason: 'Test',
        },
        attentionSignals: {
          classification: 'needs_response',
          triggerScore: 0.5,
          triggerReasons: [],
          suppressors: [],
          recommendedPath: 'reply_fast_path',
        },
        isProactive: false,
        createdAt: new Date(),
      };

      const result = await evaluator.evaluateSocial(request);

      expect(result.requestId).toBe('req-013');
    });
  });
});
