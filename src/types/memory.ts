/**
 * Memory Records
 *
 * 记忆记录及其来源和修订历史
 */

/**
 * 记忆记录
 */
export interface MemoryRecord {
  id: string; // ULID

  // 所有权
  scope: 'global' | 'user' | 'group' | 'conversation' | 'tool' | 'system';
  canonicalUserId?: string; // 如果 scope=user
  groupId?: string; // 如果 scope=group
  conversationId?: string; // 如果 scope=conversation
  subjectUserId?: string; // 记忆是关于谁的（如果与所有者不同）

  // 边界
  visibility: 'private_only' | 'same_user_any_context' | 'same_group_only' | 'owner_admin_only' | 'public';
  sensitivity: 'normal' | 'personal' | 'sensitive' | 'secret' | 'prohibited';
  authority: 'user_stated' | 'inferred' | 'tool_derived' | 'system';

  // 内容
  kind: 'preference' | 'fact' | 'constraint' | 'summary' | 'reflection' | 'procedure';
  title: string;
  content: string;

  // 生命周期
  state: 'proposed' | 'active' | 'superseded' | 'disabled' | 'deleted';
  confidence: number; // 0.0 - 1.0
  importance: number; // 0.0 - 1.0

  // 来源
  sourceContext: string; // 来自哪里
  sourceEventIds: string[];
  evaluatorDecisionId?: string;

  // 时间戳
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

/**
 * 记忆来源链接
 */
export interface MemorySource {
  memoryId: string;
  sourceType: 'raw_event' | 'chat_message' | 'tool_output' | 'worker_extraction' | 'user_command';
  sourceId: string;
  sourceTimestamp: Date;
  extractedBy?: 'user' | 'evaluator' | 'worker';
}

/**
 * 记忆修订
 */
export interface MemoryRevision {
  id: string;
  memoryId: string;
  revisionNumber: number;

  previousState: Partial<MemoryRecord>;
  newState: Partial<MemoryRecord>;

  reason: string;
  changeType: 'create' | 'update' | 'supersede' | 'disable' | 'delete' | 'restore';

  actor: string; // canonical_user_id 或 'system'
  evaluatorDecisionId?: string;

  createdAt: Date;
}
