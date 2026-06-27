/**
 * Pi Types
 *
 * Pi SDK 适配器类型定义
 */

import type { ContextPack } from '../types/context';
import type { ActionDecision } from '../types/action';
import type { ToolCallRequest } from '../types/tool';

export interface AgentTurnInput {
  contextPack: ContextPack;
  actionHint?: string;
}

export interface AgentTurnOutput {
  responseText?: string;
  actionDecision?: ActionDecision;
  toolCalls: ToolCallRequest[];
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
}

export interface ReasoningCore {
  run(input: AgentTurnInput): Promise<AgentTurnOutput>;
  isMock(): boolean;
  getModelInfo(): { model: string; provider: string };
}
