import { describe, it, expect } from 'vitest';
import type {
  EvaluatorRequest,
  ToolEvaluationRequest,
  ToolEvaluationResult,
  MemoryEvaluationRequest,
  MemoryEvaluationResult,
  SocialEvaluationRequest,
  SocialEvaluationResult,
  EvaluatorConfig,
} from '../../../src/types/evaluator';

describe('Evaluator Types', () => {
  describe('EvaluatorRequest', () => {
    it('should allow creating base evaluator request', () => {
      const request: EvaluatorRequest = {
        requestId: 'req-001',
        domain: 'tool',
        turnId: 'turn-001',
        actor: {
          canonicalUserId: 'user-001',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['event-001'],
        contextSummary: 'User requested action',
        createdAt: new Date(),
      };

      expect(request.requestId).toBe('req-001');
      expect(request.domain).toBe('tool');
      expect(request.actor.actorClass).toBe('user');
    });

    it('should support all domain types', () => {
      const domains: Array<EvaluatorRequest['domain']> = ['tool', 'memory', 'social'];

      domains.forEach((domain) => {
        const request: EvaluatorRequest = {
          requestId: 'req-001',
          domain,
          turnId: 'turn-001',
          actor: { actorClass: 'user' },
          context: 'private_chat',
          sourceEventIds: [],
          contextSummary: 'Test',
          createdAt: new Date(),
        };

        expect(request.domain).toBe(domain);
      });
    });
  });

  describe('ToolEvaluationRequest', () => {
    it('should allow creating tool evaluation request', () => {
      const request: ToolEvaluationRequest = {
        requestId: 'req-002',
        domain: 'tool',
        turnId: 'turn-002',
        actor: {
          canonicalUserId: 'user-002',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['event-002'],
        contextSummary: 'User wants to search',
        toolName: 'search',
        capabilities: ['network'],
        toolInput: { query: 'weather' },
        proposedReason: 'Search for weather',
        createdAt: new Date(),
      };

      expect(request.toolName).toBe('search');
      expect(request.capabilities).toContain('network');
      expect(request.proposedReason).toBe('Search for weather');
    });
  });

  describe('MemoryEvaluationRequest', () => {
    it('should allow creating memory evaluation request', () => {
      const request: MemoryEvaluationRequest = {
        requestId: 'req-003',
        domain: 'memory',
        turnId: 'turn-003',
        actor: {
          canonicalUserId: 'user-003',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['event-003'],
        contextSummary: 'User stated preference',
        memoryCandidate: {
          scope: 'user',
          canonicalUserId: 'user-003',
          kind: 'preference',
          title: 'Language',
          content: 'Prefers English',
          confidence: 0.9,
          sourceContext: 'User stated',
        },
        initialRiskLevel: 'low',
        createdAt: new Date(),
      };

      expect(request.memoryCandidate.scope).toBe('user');
      expect(request.memoryCandidate.kind).toBe('preference');
      expect(request.initialRiskLevel).toBe('low');
    });

    it('should support all risk levels', () => {
      const riskLevels: Array<MemoryEvaluationRequest['initialRiskLevel']> = ['low', 'medium', 'high'];

      riskLevels.forEach((riskLevel) => {
        const request: MemoryEvaluationRequest = {
          requestId: 'req-001',
          domain: 'memory',
          turnId: 'turn-001',
          actor: { actorClass: 'user' },
          context: 'private_chat',
          sourceEventIds: [],
          contextSummary: 'Test',
          memoryCandidate: {
            scope: 'user',
            kind: 'fact',
            title: 'Test',
            content: 'Test',
            confidence: 0.8,
            sourceContext: 'Test',
          },
          initialRiskLevel: riskLevel,
          createdAt: new Date(),
        };

        expect(request.initialRiskLevel).toBe(riskLevel);
      });
    });
  });

  describe('SocialEvaluationRequest', () => {
    it('should allow creating social evaluation request', () => {
      const request: SocialEvaluationRequest = {
        requestId: 'req-004',
        domain: 'social',
        turnId: 'turn-004',
        actor: {
          canonicalUserId: 'user-004',
          actorClass: 'user',
        },
        context: 'group_chat',
        sourceEventIds: ['event-004'],
        contextSummary: 'User asked question',
        proposedAction: {
          type: 'reply_full',
          priority: 7,
          constraints: {},
          reason: 'Answer question',
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

      expect(request.proposedAction.type).toBe('reply_full');
      expect(request.attentionSignals.classification).toBe('needs_response');
      expect(request.isProactive).toBe(false);
    });
  });

  describe('EvaluatorResult', () => {
    it('should allow creating base evaluator result', () => {
      const result: ToolEvaluationResult = {
        domain: 'tool',
        decisionId: 'decision-001',
        requestId: 'req-001',
        decision: 'approve',
        reason: 'Low-risk tool',
        confidence: 0.95,
        riskLevel: 'low',
        decidedAt: new Date(),
        evaluatorVersion: 'stub-v1',
      };

      expect(result.decision).toBe('approve');
      expect(result.riskLevel).toBe('low');
      expect(result.confidence).toBe(0.95);
    });

    it('should support all decision types', () => {
      const decisions: Array<ToolEvaluationResult['decision']> = ['approve', 'reject', 'downgrade', 'propose'];

      decisions.forEach((decision) => {
        const result: ToolEvaluationResult = {
          domain: 'tool',
          decisionId: 'decision-001',
          requestId: 'req-001',
          decision,
          reason: 'Test',
          confidence: 0.8,
          riskLevel: 'medium',
          decidedAt: new Date(),
          evaluatorVersion: 'test-v1',
        };

        expect(result.decision).toBe(decision);
      });
    });

    it('should support all risk levels', () => {
      const riskLevels: Array<ToolEvaluationResult['riskLevel']> = ['low', 'medium', 'high', 'prohibited'];

      riskLevels.forEach((riskLevel) => {
        const result: ToolEvaluationResult = {
          domain: 'tool',
          decisionId: 'decision-001',
          requestId: 'req-001',
          decision: 'approve',
          reason: 'Test',
          confidence: 0.8,
          riskLevel,
          decidedAt: new Date(),
          evaluatorVersion: 'test-v1',
        };

        expect(result.riskLevel).toBe(riskLevel);
      });
    });
  });

  describe('ToolEvaluationResult', () => {
    it('should allow modified tool input', () => {
      const result: ToolEvaluationResult = {
        domain: 'tool',
        decisionId: 'decision-002',
        requestId: 'req-002',
        decision: 'approve',
        reason: 'Approved with modifications',
        confidence: 0.85,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'stub-v1',
        modifiedToolInput: {
          query: 'sanitized query',
          maxResults: 10,
        },
      };

      expect(result.modifiedToolInput).toBeDefined();
      expect(result.modifiedToolInput?.query).toBe('sanitized query');
    });

    it('should allow additional constraints', () => {
      const result: ToolEvaluationResult = {
        domain: 'tool',
        decisionId: 'decision-003',
        requestId: 'req-003',
        decision: 'approve',
        reason: 'Approved with constraints',
        confidence: 0.8,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'stub-v1',
        additionalConstraints: {
          maxRuntimeMs: 5000,
          maxOutputBytes: 1024000,
          redactionLevel: 'light',
        },
      };

      expect(result.additionalConstraints).toBeDefined();
      expect(result.additionalConstraints?.maxRuntimeMs).toBe(5000);
      expect(result.additionalConstraints?.redactionLevel).toBe('light');
    });

    it('should allow alternative tool suggestion', () => {
      const result: ToolEvaluationResult = {
        domain: 'tool',
        decisionId: 'decision-004',
        requestId: 'req-004',
        decision: 'downgrade',
        reason: 'Use safer alternative',
        confidence: 0.9,
        riskLevel: 'high',
        decidedAt: new Date(),
        evaluatorVersion: 'stub-v1',
        alternativeTool: 'safe_search',
      };

      expect(result.alternativeTool).toBe('safe_search');
    });
  });

  describe('MemoryEvaluationResult', () => {
    it('should allow recommended state and visibility', () => {
      const result: MemoryEvaluationResult = {
        domain: 'memory',
        decisionId: 'decision-005',
        requestId: 'req-005',
        decision: 'approve',
        reason: 'Approved with restrictions',
        confidence: 0.8,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'stub-v1',
        recommendedState: 'proposed',
        recommendedVisibility: 'private_only',
        recommendedSensitivity: 'personal',
      };

      expect(result.recommendedState).toBe('proposed');
      expect(result.recommendedVisibility).toBe('private_only');
      expect(result.recommendedSensitivity).toBe('personal');
    });

    it('should allow conflict resolution', () => {
      const result: MemoryEvaluationResult = {
        domain: 'memory',
        decisionId: 'decision-006',
        requestId: 'req-006',
        decision: 'approve',
        reason: 'Supersede old memory',
        confidence: 0.85,
        riskLevel: 'low',
        decidedAt: new Date(),
        evaluatorVersion: 'stub-v1',
        conflictResolution: 'supersede',
      };

      expect(result.conflictResolution).toBe('supersede');
    });
  });

  describe('SocialEvaluationResult', () => {
    it('should allow modified action', () => {
      const result: SocialEvaluationResult = {
        domain: 'social',
        decisionId: 'decision-007',
        requestId: 'req-007',
        decision: 'approve',
        reason: 'Approved with modifications',
        confidence: 0.8,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'stub-v1',
        modifiedAction: {
          type: 'reply_short',
          priority: 6,
          constraints: { maxResponseTokens: 100 },
          reason: 'Shortened response',
        },
      };

      expect(result.modifiedAction).toBeDefined();
      expect(result.modifiedAction?.type).toBe('reply_short');
    });

    it('should allow downgrade action', () => {
      const result: SocialEvaluationResult = {
        domain: 'social',
        decisionId: 'decision-008',
        requestId: 'req-008',
        decision: 'downgrade',
        reason: 'Downgrade to shorter response',
        confidence: 0.85,
        riskLevel: 'medium',
        decidedAt: new Date(),
        evaluatorVersion: 'stub-v1',
        downgradeAction: {
          from: 'reply_full',
          to: 'reply_short',
          reason: 'Group chat prefers concise responses',
        },
      };

      expect(result.downgradeAction).toBeDefined();
      expect(result.downgradeAction?.from).toBe('reply_full');
      expect(result.downgradeAction?.to).toBe('reply_short');
    });

    it('should allow cooldown seconds', () => {
      const result: SocialEvaluationResult = {
        domain: 'social',
        decisionId: 'decision-009',
        requestId: 'req-009',
        decision: 'propose',
        reason: 'Proactive message needs approval',
        confidence: 0.75,
        riskLevel: 'high',
        decidedAt: new Date(),
        evaluatorVersion: 'stub-v1',
        cooldownSeconds: 300,
      };

      expect(result.cooldownSeconds).toBe(300);
    });
  });

  describe('EvaluatorConfig', () => {
    it('should allow creating evaluator config', () => {
      const config: EvaluatorConfig = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test-key',
        timeoutMs: 30000,
        maxRetries: 3,
        temperature: 0.1,
        promptVersion: 'v1.0',
      };

      expect(config.provider).toBe('deepseek');
      expect(config.model).toBe('deepseek-chat');
      expect(config.temperature).toBe(0.1);
      expect(config.promptVersion).toBe('v1.0');
    });

    it('should allow config without optional fields', () => {
      const config: EvaluatorConfig = {
        provider: 'openai',
        model: 'gpt-4',
        timeoutMs: 60000,
        maxRetries: 2,
        temperature: 0.2,
        promptVersion: 'v2.0',
      };

      expect(config.baseUrl).toBeUndefined();
      expect(config.apiKey).toBeUndefined();
    });
  });
});
