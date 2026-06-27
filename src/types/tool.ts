/**
 * Tool Registry
 *
 * 工具注册、调用和权限管理
 */

/**
 * 工具能力
 */
export type ToolCapability =
  | 'read_context'
  | 'read_local'
  | 'write_local'
  | 'network'
  | 'shell_exec'
  | 'long_running'
  | 'sends_message'
  | 'modifies_memory'
  | 'external_side_effect'
  | 'credential_access'
  | 'platform_admin';

/**
 * 行动者类别
 */
export type ActorClass =
  | 'owner'
  | 'admin'
  | 'trusted_user'
  | 'user'
  | 'group_admin'
  | 'system_worker'
  | 'evaluator'
  | 'tool';

/**
 * 调用上下文
 */
export type InvocationContext =
  | 'private_chat'
  | 'group_chat'
  | 'admin_cli'
  | 'background_worker'
  | 'internal';

/**
 * 工具权限策略
 */
export interface ToolPermissionPolicy {
  allowedActors: ActorClass[];
  allowedContexts: InvocationContext[];
  allowedUserIds?: string[];
  deniedUserIds?: string[];
  allowedGroupIds?: string[];
  deniedGroupIds?: string[];
}

/**
 * 沙箱策略
 */
export interface SandboxPolicy {
  filesystem: 'none' | 'readonly' | 'workspace_write' | 'allowed_paths';
  network: 'none' | 'restricted' | 'allowed';
  execution: 'none' | 'in_process' | 'subprocess' | 'docker';
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  allowedPaths?: string[];
  allowedDomains?: string[];
}

/**
 * 工具注册表条目
 */
export interface ToolRegistryEntry {
  name: string; // 唯一工具标识符
  version: string;
  description: string;

  // 能力（它能做什么）
  capabilities: ToolCapability[];

  // 权限（谁能使用它）
  permissions: ToolPermissionPolicy;

  // 评估器策略（需要 LLM 审查吗？）
  evaluatorPolicy: 'required' | 'bypass';

  // 审计（记录什么）
  auditLevel: 'none' | 'summary' | 'redacted_full' | 'full';

  // 沙箱（执行约束）
  sandboxPolicy: SandboxPolicy;

  // 输出处理
  outputSensitivity: 'normal' | 'personal' | 'sensitive' | 'secret_possible';

  // Pi 集成
  piSchema: {
    input: object; // JSON schema
    output: object; // JSON schema
  };

  // 处理器
  handler: string; // 模块路径或函数引用
}

/**
 * 工具调用请求
 */
export interface ToolCallRequest {
  id: string; // ULID
  turnId: string;
  toolName: string;

  input: object; // 已根据工具的 piSchema.input 验证

  requestedBy: 'pi' | 'evaluator' | 'user' | 'system';
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
  };

  context: InvocationContext;
}

/**
 * 工具调用结果
 */
export interface ToolCallResult {
  toolCallId: string;
  status: 'success' | 'error' | 'timeout' | 'rejected';

  output?: object; // 已根据工具的 piSchema.output 验证
  error?: {
    code: string;
    message: string;
    details?: object;
  };

  executionTimeMs: number;

  // 审计
  auditSummary: string; // 如果敏感则已编辑
  secretsRedacted: boolean;
}
