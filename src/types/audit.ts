/**
 * Audit & Errors
 *
 * 审计日志和错误封装
 */

import type { ActorClass, InvocationContext } from './tool';

/**
 * 审计条目
 */
export interface AuditEntry {
  id: string; // ULID
  timestamp: Date;

  category: 'tool' | 'memory' | 'social' | 'evaluator' | 'system';
  level: 'summary' | 'redacted_full' | 'full';

  // 发生了什么
  eventType: string;
  eventId: string; // 引用实际事件

  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
    context: InvocationContext;
  };

  // 摘要（始终存在）
  summary: string;

  // 详细信息（如果 level != full 则已编辑）
  details?: object;
  redacted: boolean;

  // 风险标志
  riskLevel?: 'low' | 'medium' | 'high' | 'prohibited';
  evaluatorDecisionId?: string;
}

/**
 * 审计日志查询选项
 */
export interface AuditQueryOptions {
  category?: AuditEntry['category'];
  level?: AuditEntry['level'];
  eventType?: string;
  userId?: string;
  startTime?: Date;
  endTime?: Date;
  riskLevel?: AuditEntry['riskLevel'];
  limit?: number;
}

/**
 * 审计日志统计结果
 */
export interface AuditStatsResult {
  totalEvents: number;
  eventsByCategory: Record<string, number>;
  eventsByRiskLevel: Record<string, number>;
  recentActivity: Array<{
    date: string;
    count: number;
  }>;
}

/**
 * 错误封装
 */
export interface ErrorEnvelope {
  code: string; // 例如 'MEMORY_NOT_FOUND', 'PERMISSION_DENIED'
  message: string;
  category: 'validation' | 'permission' | 'not_found' | 'conflict' | 'rate_limit' | 'internal';

  details?: object;
  recoverable: boolean;

  // 用于调试（永远不暴露给不可信上下文）
  stack?: string;
  internalError?: Error;
}
