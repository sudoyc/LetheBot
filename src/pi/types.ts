/**
 * Pi Types
 *
 * Pi SDK 适配器类型定义
 */

import type { ContextPack } from '../types/context.js';
import type { ActionDecision } from '../types/action.js';
import type { ToolCallRequest } from '../types/tool.js';

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
