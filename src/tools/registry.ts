/**
 * Tool Registry
 *
 * 工具注册表，管理工具元数据和权限
 */

import type { ToolRegistryEntry, InvocationContext, ActorClass } from '../types/tool';

export interface ActorContext {
  actorClass: ActorClass;
  canonicalUserId?: string;
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
