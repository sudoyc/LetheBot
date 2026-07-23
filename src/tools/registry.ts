/**
 * Tool Registry
 *
 * 工具注册表，管理工具元数据和权限
 */

import type {
  ToolRegistryEntry,
  InvocationContext,
  ActorClass,
  ToolHandler,
} from '../types/tool.js';
import { MIN_TOOL_OUTPUT_BYTES } from './output-limit.js';
import { MAX_TOOL_RUNTIME_MS } from './runtime-limit.js';
import { assertKnownToolExecution } from './sandbox-policy.js';

export interface ActorContext {
  actorClass: ActorClass;
  canonicalUserId?: string;
  groupId?: string;
}

export class ToolRegistry {
  private tools = new Map<string, ToolRegistryEntry>();

  /**
   * 注册工具
   */
  register(entry: ToolRegistryEntry): void {
    if (this.tools.has(entry.name)) {
      throw new Error(`Tool "${entry.name}" is already registered`);
    }

    if (typeof entry.handler !== 'function') {
      throw new Error(`Tool "${entry.name}" must be registered with a resolved function handler`);
    }

    assertKnownToolExecution(entry.name, entry.sandboxPolicy?.execution);
    validateSandboxLimit('maxRuntimeMs', entry.sandboxPolicy.maxRuntimeMs);
    validateSandboxLimit('maxOutputBytes', entry.sandboxPolicy.maxOutputBytes);
    if (
      entry.sandboxPolicy.maxOutputBytes !== undefined
      && entry.sandboxPolicy.maxOutputBytes < MIN_TOOL_OUTPUT_BYTES
    ) {
      throw new Error(
        `Tool "${entry.name}" maxOutputBytes must be at least ${MIN_TOOL_OUTPUT_BYTES}`
      );
    }

    this.tools.set(entry.name, entry);
  }

  /**
   * 获取工具元数据
   */
  get(name: string): ToolRegistryEntry | undefined {
    return this.tools.get(name);
  }

  /**
   * 列出所有工具
   */
  list(): ToolRegistryEntry[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取所有工具（别名）
   */
  getAll(): ToolRegistryEntry[] {
    return this.list();
  }

  /**
   * 获取工具处理器
   */
  getHandler(name: string): ToolHandler | undefined {
    const tool = this.tools.get(name);
    return tool?.handler;
  }

  /**
   * 检查权限
   */
  checkPermission(
    toolName: string,
    actor: ActorContext,
    context: InvocationContext
  ): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return false;
    }

    const { permissions } = tool;

    // 检查 actor 权限
    const actorAllowed = permissions.allowedActors.includes(actor.actorClass);
    if (!actorAllowed) {
      return false;
    }

    // 检查上下文权限
    const contextAllowed = permissions.allowedContexts.includes(context);
    if (!contextAllowed) {
      return false;
    }

    if (permissions.deniedUserIds?.includes(actor.canonicalUserId ?? '')) {
      return false;
    }

    if (
      permissions.allowedUserIds &&
      permissions.allowedUserIds.length > 0 &&
      (!actor.canonicalUserId || !permissions.allowedUserIds.includes(actor.canonicalUserId))
    ) {
      return false;
    }

    if (permissions.deniedGroupIds?.includes(actor.groupId ?? '')) {
      return false;
    }

    if (
      permissions.allowedGroupIds &&
      permissions.allowedGroupIds.length > 0 &&
      (!actor.groupId || !permissions.allowedGroupIds.includes(actor.groupId))
    ) {
      return false;
    }

    return true;
  }

  /**
   * 检查是否需要 evaluator
   */
  requiresEvaluator(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    return tool?.evaluatorPolicy === 'required';
  }
}

function validateSandboxLimit(
  field: 'maxRuntimeMs' | 'maxOutputBytes',
  value: number | undefined,
): void {
  if (
    value !== undefined
    && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error(`${field} must be a positive safe integer`);
  }

  if (field === 'maxRuntimeMs' && value !== undefined && value > MAX_TOOL_RUNTIME_MS) {
    throw new Error(`${field} must not exceed ${MAX_TOOL_RUNTIME_MS}`);
  }
}
