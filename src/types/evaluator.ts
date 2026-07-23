/**
 * Evaluator (Risk Assessment)
 *
 * 风险评估器 - LLM 辅助的模糊场景判断
 */

import type { ActorClass, InvocationContext, ToolCapability } from './tool.js';
import type { ActionPlan, ActionType } from './action.js';
import type { MemoryRecord } from './memory.js';
import type { AttentionSignals } from './attention.js';

/**
 * 评估器请求基础接口
 */
interface EvaluatorRequestBase {
  /** 请求 ID (ULID) */
  requestId: string;

  /** 请求类型：工具/记忆/社交行动 */
  domain: 'tool' | 'memory' | 'social';

  /** 触发评估的 actor */
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
  };

  /** 调用上下文 */
  context: InvocationContext;

  /** 相关的 source event IDs */
  sourceEventIds: string[];

  /** 上下文摘要（token 预算受限，不完整注入） */
  contextSummary: string;

  /** 创建时间 */
  createdAt: Date;
}

type TurnEvaluatorAuthority = {
  /** Agent turn ID（关联到具体对话回合） */
  turnId: string;
  jobAttemptId?: never;
};

export type MemoryEvaluationAuthority =
  | TurnEvaluatorAuthority
  | {
    turnId?: never;
    /** Durable background job attempt that owns this evaluation. */
    jobAttemptId: string;
  };

export type EvaluatorRequest =
  | (EvaluatorRequestBase & TurnEvaluatorAuthority)
  | (EvaluatorRequestBase & { domain: 'memory' } & Extract<MemoryEvaluationAuthority, { jobAttemptId: string }>);

/**
 * 工具调用评估请求
 */
export interface ToolEvaluationRequest extends EvaluatorRequestBase, TurnEvaluatorAuthority {
  domain: 'tool';

  /** 工具名称 */
  toolName: string;

  /** 工具能力 */
  capabilities: ToolCapability[];

  /** 工具输入参数（结构化） */
  toolInput: Record<string, unknown>;

  /** Pi 提出的调用理由 */
  proposedReason: string;
}

/**
 * 记忆评估请求
 */
interface MemoryEvaluationRequestFields extends EvaluatorRequestBase {
  domain: 'memory';

  /** 记忆候选 */
  memoryCandidate: {
    scope: MemoryRecord['scope'];
    canonicalUserId?: string;
    groupId?: string;
    kind: MemoryRecord['kind'];
    title: string;
    content: string;
    confidence: number;
    sourceContext: string;
  };

  /** 初始风险分类（由 pre-gate 提供） */
  initialRiskLevel: 'low' | 'medium' | 'high';
}

export type MemoryEvaluationRequest = MemoryEvaluationRequestFields & MemoryEvaluationAuthority;

/**
 * 社交行动评估请求
 */
export interface SocialEvaluationRequest extends EvaluatorRequestBase, TurnEvaluatorAuthority {
  domain: 'social';

  /** 提议的行动 */
  proposedAction: ActionPlan;

  /** 注意力信号（来自 AttentionEngine） */
  attentionSignals: AttentionSignals;

  /** 是否为主动发送（非响应式） */
  isProactive: boolean;
}

/**
 * 评估结果基础接口
 */
export interface EvaluatorResult {
  /** 决策 ID (ULID) */
  decisionId: string;

  /** 关联的请求 ID */
  requestId: string;

  /** 决策：批准/拒绝/降级/提议 */
  decision: 'approve' | 'reject' | 'downgrade' | 'propose';

  /** 决策理由（可审计） */
  reason: string;

  /** 置信度 0.0-1.0 */
  confidence: number;

  /** 最终风险等级 */
  riskLevel: 'low' | 'medium' | 'high' | 'prohibited';

  /** 决策时间 */
  decidedAt: Date;

  /** Evaluator 版本/模型标识 */
  evaluatorVersion: string;

  /** Durable model invocation evidence, assigned locally by model-backed evaluators. */
  modelInvocationId?: string;
}

/**
 * 工具评估结果
 */
export interface ToolEvaluationResult extends EvaluatorResult {
  domain: 'tool';

  /** 如果 decision=approve，可能修改工具参数 */
  modifiedToolInput?: Record<string, unknown>;

  /** 如果 decision=downgrade，建议的替代工具 */
  alternativeTool?: string;

  /** 额外的沙箱约束 */
  additionalConstraints?: {
    maxRuntimeMs?: number;
    maxOutputBytes?: number;
    redactionLevel?: 'none' | 'light' | 'strict';
  };
}

/**
 * 记忆评估结果
 */
export interface MemoryEvaluationResult extends EvaluatorResult {
  domain: 'memory';

  /** 如果 decision=approve，推荐的最终状态 */
  recommendedState?: 'active' | 'proposed';

  /** 如果 decision=approve/downgrade，推荐的可见性 */
  recommendedVisibility?: MemoryRecord['visibility'];

  /** 如果 decision=approve/downgrade，推荐的敏感度 */
  recommendedSensitivity?: MemoryRecord['sensitivity'];

  /** 如果存在冲突，推荐的处理方式 */
  conflictResolution?: 'supersede' | 'merge' | 'reject';
}

/**
 * 社交行动评估结果
 */
export interface SocialEvaluationResult extends EvaluatorResult {
  domain: 'social';

  /** 如果 decision=approve，可能修改的行动 */
  modifiedAction?: ActionPlan;

  /** 如果 decision=downgrade，推荐的降级行动 */
  downgradeAction?: {
    from: ActionType;
    to: ActionType;
    reason: string;
  };

  /** 建议的冷却时间（秒） */
  cooldownSeconds?: number;
}

/**
 * Evaluator 核心接口
 */
export interface IEvaluator {
  /**
   * 评估工具调用
   */
  evaluateTool(request: ToolEvaluationRequest): Promise<ToolEvaluationResult>;

  /**
   * 评估记忆写入
   */
  evaluateMemory(request: MemoryEvaluationRequest): Promise<MemoryEvaluationResult>;

  /**
   * 评估社交行动
   */
  evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult>;

  /**
   * 批量评估（可选优化）
   */
  evaluateBatch?(requests: EvaluatorRequest[]): Promise<EvaluatorResult[]>;
}

/**
 * Evaluator 配置
 */
export interface EvaluatorConfig {
  /** LLM 提供者（openai/anthropic/deepseek等） */
  provider: string;

  /** 模型名称 */
  model: string;

  /** API 端点 */
  baseUrl?: string;

  /** API 密钥（从环境变量或配置文件读取） */
  apiKey?: string;

  /** 超时时间（毫秒） */
  timeoutMs: number;

  /** 最大重试次数 */
  maxRetries: number;

  /** 温度参数（0.0-1.0，推荐 0.0-0.3 用于决策） */
  temperature: number;

  /** Prompt 版本标识 */
  promptVersion: string;
}
