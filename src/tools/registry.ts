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
  private disabledTools = new Set<string>();

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

    const registeredEntry = cloneAndFreezeToolEntry(entry);

    assertKnownToolExecution(
      registeredEntry.name,
      registeredEntry.sandboxPolicy?.execution,
    );
    validateSandboxLimit('maxRuntimeMs', registeredEntry.sandboxPolicy.maxRuntimeMs);
    validateSandboxLimit('maxOutputBytes', registeredEntry.sandboxPolicy.maxOutputBytes);
    if (
      registeredEntry.sandboxPolicy.maxOutputBytes !== undefined
      && registeredEntry.sandboxPolicy.maxOutputBytes < MIN_TOOL_OUTPUT_BYTES
    ) {
      throw new Error(
        `Tool "${registeredEntry.name}" maxOutputBytes must be at least ${MIN_TOOL_OUTPUT_BYTES}`
      );
    }

    this.tools.set(registeredEntry.name, registeredEntry);
  }

  /**
   * Unregister a tool and discard its local enablement state.
   * Returns false when the tool was not registered.
   */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    this.disabledTools.delete(name);
    return removed;
  }

  /**
   * Disable a registered tool. In-flight handler calls are not interrupted.
   */
  disable(name: string): void {
    this.assertRegistered(name);
    this.disabledTools.add(name);
  }

  /**
   * Re-enable a previously disabled registered tool.
   */
  enable(name: string): void {
    this.assertRegistered(name);
    this.disabledTools.delete(name);
  }

  /**
   * Return whether a registered tool can be selected for a new invocation.
   */
  isEnabled(name: string): boolean {
    return this.tools.has(name) && !this.disabledTools.has(name);
  }

  private assertRegistered(name: string): void {
    if (!this.tools.has(name)) {
      throw new Error('Tool is not registered');
    }
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
    return tool && this.isEnabled(name) ? tool.handler : undefined;
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
    if (!tool || !this.isEnabled(toolName)) {
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
    return Boolean(tool && this.isEnabled(toolName) && tool.evaluatorPolicy === 'required');
  }
}

function cloneAndFreezeToolEntry(entry: ToolRegistryEntry): ToolRegistryEntry {
  const { handler, ...metadata } = entry;

  return deepFreeze({
    ...structuredClone(metadata),
    handler,
  });
}

function deepFreeze<T extends object>(value: T, seen = new WeakSet<object>()): T {
  if (seen.has(value)) {
    return value;
  }

  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const nestedValue = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (nestedValue !== null && typeof nestedValue === 'object') {
      deepFreeze(nestedValue, seen);
    }
  }

  Object.freeze(value);
  return value;
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
