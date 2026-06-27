/**
 * Agent Turn
 *
 * 代理回合 - 从触发到完成的一次代理交互
 */

/**
 * 代理回合
 */
export interface AgentTurn {
  id: string; // ULID，也作为 turnId
  conversationId: string;

  // 输入
  triggerEvent: {
    id: string;
    type: string;
  };
  contextPackId: string;

  // Pi 交互
  piPromptId?: string;
  piModel: string;
  piProvider: string;

  // 输出
  actionDecisionId?: string;
  responseText?: string;
  toolCalls: string[]; // ToolCallRequest IDs

  // 生命周期
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: Date;
  completedAt?: Date;

  // Token 使用
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
}
