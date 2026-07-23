/**
 * Evaluator Stub
 *
 * 简单的规则驱动评估器，不依赖 LLM
 * 用于测试和开发阶段
 */

import { ulid } from 'ulid';
import type {
  IEvaluator,
  ToolEvaluationRequest,
  ToolEvaluationResult,
  MemoryEvaluationRequest,
  MemoryEvaluationResult,
  SocialEvaluationRequest,
  SocialEvaluationResult,
} from '../types/evaluator.js';

export class EvaluatorStub implements IEvaluator {
  private readonly version = 'stub-v1';

  async evaluateTool(request: ToolEvaluationRequest): Promise<ToolEvaluationResult> {
    const decisionId = ulid();
    const decidedAt = new Date();

    // 高风险能力 → propose
    const highRiskCapabilities = ['shell_exec', 'platform_admin', 'credential_access'];
    const hasHighRiskCapability = request.capabilities.some((cap) =>
      highRiskCapabilities.includes(cap)
    );

    if (hasHighRiskCapability) {
      return {
        domain: 'tool',
        decisionId,
        requestId: request.requestId,
        decision: 'propose',
        reason: `Tool requires high-risk capability: ${request.capabilities.join(', ')}`,
        confidence: 0.9,
        riskLevel: 'high',
        decidedAt,
        evaluatorVersion: this.version,
      };
    }

    // 中等风险能力（network, external_side_effect）→ approve 但记录
    const mediumRiskCapabilities = ['network', 'external_side_effect', 'sends_message'];
    const hasMediumRiskCapability = request.capabilities.some((cap) =>
      mediumRiskCapabilities.includes(cap)
    );

    if (hasMediumRiskCapability) {
      return {
        domain: 'tool',
        decisionId,
        requestId: request.requestId,
        decision: 'approve',
        reason: 'Medium-risk capability approved with audit',
        confidence: 0.8,
        riskLevel: 'medium',
        decidedAt,
        evaluatorVersion: this.version,
      };
    }

    // 低风险 → approve
    return {
      domain: 'tool',
      decisionId,
      requestId: request.requestId,
      decision: 'approve',
      reason: 'Low-risk tool approved',
      confidence: 0.95,
      riskLevel: 'low',
      decidedAt,
      evaluatorVersion: this.version,
    };
  }

  async evaluateMemory(request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult> {
    const decisionId = ulid();
    const decidedAt = new Date();

    const { memoryCandidate, initialRiskLevel } = request;

    // high risk → propose (等待 owner 审核)
    if (initialRiskLevel === 'high') {
      return {
        domain: 'memory',
        decisionId,
        requestId: request.requestId,
        decision: 'approve',
        reason: 'High-risk memory requires owner approval',
        confidence: 0.7,
        riskLevel: 'high',
        decidedAt,
        evaluatorVersion: this.version,
        recommendedState: 'proposed', // 进入 proposed 状态
        recommendedVisibility: memoryCandidate.scope === 'user' ? 'private_only' : 'same_group_only',
      };
    }

    // medium risk → approve 但降低 visibility
    if (initialRiskLevel === 'medium') {
      return {
        domain: 'memory',
        decisionId,
        requestId: request.requestId,
        decision: 'approve',
        reason: 'Medium-risk memory approved with restricted visibility',
        confidence: 0.8,
        riskLevel: 'medium',
        decidedAt,
        evaluatorVersion: this.version,
        recommendedState: 'active',
        recommendedVisibility: 'private_only',
        recommendedSensitivity: 'personal',
      };
    }

    // low risk → approve 直接激活
    return {
      domain: 'memory',
      decisionId,
      requestId: request.requestId,
      decision: 'approve',
      reason: 'Low-risk memory approved',
      confidence: 0.9,
      riskLevel: 'low',
      decidedAt,
      evaluatorVersion: this.version,
      recommendedState: 'active',
    };
  }

  async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
    const decisionId = ulid();
    const decidedAt = new Date();

    const { proposedAction, isProactive } = request;

    // 主动发送 → propose
    if (isProactive) {
      return {
        domain: 'social',
        decisionId,
        requestId: request.requestId,
        decision: 'propose',
        reason: 'Proactive messaging requires owner approval',
        confidence: 0.8,
        riskLevel: 'high',
        decidedAt,
        evaluatorVersion: this.version,
        cooldownSeconds: 300, // 5 分钟冷却
      };
    }

    // reply_full 在群聊 → downgrade 到 reply_short
    if (
      proposedAction.type === 'reply_full' &&
      request.context === 'group_chat'
    ) {
      return {
        domain: 'social',
        decisionId,
        requestId: request.requestId,
        decision: 'downgrade',
        reason: 'Long reply in group chat should be shortened',
        confidence: 0.85,
        riskLevel: 'medium',
        decidedAt,
        evaluatorVersion: this.version,
        downgradeAction: {
          from: 'reply_full',
          to: 'reply_short',
          reason: 'Group chat prefers concise responses',
        },
      };
    }

    // 默认 approve
    return {
      domain: 'social',
      decisionId,
      requestId: request.requestId,
      decision: 'approve',
      reason: 'Social action approved',
      confidence: 0.9,
      riskLevel: 'low',
      decidedAt,
      evaluatorVersion: this.version,
    };
  }
}
