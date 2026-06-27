/**
 * Context Pack
 *
 * 上下文包 - 为代理回合准备的上下文数据
 */

/**
 * 最近消息
 */
export interface RecentMessage {
  messageId: string;
  senderId: string;
  senderDisplayName: string; // 用于渲染，非身份标识
  text?: string;
  timestamp: Date;
  isFromBot: boolean;
}

/**
 * 记忆块
 */
export interface MemoryBlock {
  memoryId: string;
  scope: string;
  title: string;
  content: string;
  confidence: number;
  sourceContext?: string;
}

/**
 * 参与者上下文
 */
export interface ParticipantContext {
  canonicalUserId: string;

  // 显示（不可信的用户提供数据）
  displayName: string;
  groupCard?: string;
  role?: 'member' | 'admin' | 'owner';

  // 标志（用于策略）
  isOwner: boolean;
  isAdmin: boolean;
  isTrusted: boolean;

  // 平台 ID 注入（目的绑定）
  platformAccountId?: string; // 仅在需要身份消歧/调试时
}

/**
 * 上下文包
 */
export interface ContextPack {
  id: string; // ULID
  turnId: string; // 关联到 agent_runs
  createdAt: Date;

  conversation: {
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
  };

  // 最近消息（token 预算内）
  recentMessages: RecentMessage[];

  // 记忆（可见性过滤后）
  memory: {
    userProfile?: MemoryBlock;
    groupProfile?: MemoryBlock;
    retrievedFacts: MemoryBlock[];
    selectedMemoryIds: string[]; // 用于审计
  };

  // 参与者上下文（最小化）
  participants: ParticipantContext[];

  // 注入的身份字段（用于审计）
  injectedIdentityFields: string[]; // 例如 ['current_display_name', 'sender_role']

  // Token 预算跟踪
  tokenBudget: {
    max: number;
    used: number;
    breakdown: {
      recentMessages: number;
      memory: number;
      identity: number;
      system: number;
    };
  };
}
