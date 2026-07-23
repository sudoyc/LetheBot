/**
 * Policy Gate
 *
 * L0 策略门控 - 强制权限检查，不受 evaluatorPolicy 绕过
 */

import type { ToolRegistry, ActorContext } from '../tools/registry.js';
import type { InvocationContext } from '../types/tool.js';
import { isSupportedToolExecution } from '../tools/sandbox-policy.js';

export interface PolicyCheckRequest {
  toolName: string;
  actor: ActorContext;
  context: InvocationContext;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  requiresEvaluator?: boolean;
}

export class PolicyGate {
  constructor(private toolRegistry: ToolRegistry) {}

  /**
   * 检查工具调用是否允许（L0 策略）
   */
  checkToolCall(request: PolicyCheckRequest): PolicyCheckResult {
    const { toolName, actor, context } = request;

    // 检查工具是否存在
    const tool = this.toolRegistry.get(toolName);
    if (!tool) {
      return {
        allowed: false,
        reason: `Unknown tool: ${toolName}`,
      };
    }

    // L0 策略：检查权限（不受 evaluatorPolicy 影响）
    const hasPermission = this.toolRegistry.checkPermission(toolName, actor, context);
    if (!hasPermission) {
      return {
        allowed: false,
        reason: `Permission denied: ${toolName} not allowed for ${actor.actorClass} in ${context}`,
      };
    }

    if (!isSupportedToolExecution(tool.sandboxPolicy.execution)) {
      return {
        allowed: false,
        reason: `Tool execution backend is unavailable for ${toolName}; only in_process is supported`,
      };
    }

    // 检查是否需要 evaluator
    const requiresEvaluator = this.toolRegistry.requiresEvaluator(toolName);

    return {
      allowed: true,
      requiresEvaluator,
    };
  }
}
