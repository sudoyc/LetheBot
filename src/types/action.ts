/**
 * Action Decision & Execution
 *
 * 行动决策和执行结果
 */

import type { ToolCallRequest } from './tool';

/**
 * 行动类型
 */
export type ActionType =
  | 'silent_store'
  | 'silent_summarize_later'
  | 'reply_short'
  | 'reply_full'
  | 'reply_with_tool'
  | 'propose_memory'
  | 'admin_digest'
  | 'schedule_background_task'
  | 'dm_user'
  | 'react_only'
  | 'send_folded_forward'
  | 'ask_clarification';

/**
 * 行动目标
 */
export interface ActionTarget {
  conversationId: string;
  conversationType: 'private' | 'group';
  userId?: string; // 用于 dm_user
  groupId?: string;
}

/**
 * 记忆提议请求
 */
export interface MemoryProposalRequest {
  scope: string;
  canonicalUserId?: string;
  groupId?: string;
  kind: string;
  title: string;
  content: string;
  confidence: number;
  sourceContext: string;
}

/**
 * 行动载荷
 */
export interface ActionPayload {
  text?: string;
  toolCall?: ToolCallRequest;
  memoryProposal?: MemoryProposalRequest;
  reaction?: string;
}

/**
 * 行动计划
 */
export interface ActionPlan {
  type: ActionType;
  priority: number;

  target?: ActionTarget;
  payload?: ActionPayload;

  constraints: {
    evaluatorRequired?: boolean;
    cooldownKey?: string;
    maxResponseTokens?: number;
    redactionLevel?: 'none' | 'light' | 'strict';
    capabilities?: string[]; // 所需网关能力
  };

  reason: string;
}

/**
 * 行动决策
 */
export interface ActionDecision {
  id: string; // ULID
  turnId: string;
  createdAt: Date;

  decidedBy: 'attention' | 'pi' | 'evaluator';

  actions: ActionPlan[];
  riskLevel: 'low' | 'medium' | 'high' | 'prohibited';
  confidence: number; // 0.0 - 1.0

  reasons: string[]; // 为什么选择这些行动
  suppressors: string[]; // 什么降级/阻止了行动

  // 评估器元数据（如果适用）
  evaluatorRequired: boolean;
  evaluatorPassed?: boolean;
  evaluatorPromptId?: string;
}

/**
 * 行动执行结果
 */
export interface ActionExecutionResult {
  id: string; // ULID
  actionDecisionId: string;
  actionType: ActionType;
  executedAt: Date;

  status: 'success' | 'downgraded' | 'failed' | 'rejected';

  // 实际发生了什么
  executed?: {
    messageId?: string;
    dmMessageId?: string;
    toolCallId?: string;
    memoryId?: string;
    jobId?: string;
  };

  // 如果被降级
  downgradedFrom?: ActionType;
  downgradedReason?: string;

  // 如果失败
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };

  // 审计
  auditLevel: 'summary' | 'redacted_full' | 'full';
  auditEntry?: string; // JSON 或编辑后的摘要
}
