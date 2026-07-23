/**
 * Mock Pi Adapter
 *
 * 用于测试的模拟 Pi SDK 适配器（无需真实 API key）
 */

import { ulid } from 'ulidx';
import type { AgentTurnInput, AgentTurnOutput } from './types.js';
import type { ActionDecision } from '../types/action.js';

export class MockPi {
  /**
   * 运行模拟推理
   */
  async run(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const lastMessage = input.contextPack.recentMessages[input.contextPack.recentMessages.length - 1];
    const text = lastMessage?.text ?? '';

    // 模拟响应生成
    const responseText = this.generateMockResponse(text);

    // 模拟 action decision
    const actionDecision = this.generateMockActionDecision(text);

    // 模拟 token 使用
    const tokensUsed = {
      input: Math.floor(text.length / 2) + 100,
      output: Math.floor(responseText.length / 2) + 50,
      total: 0,
    };
    tokensUsed.total = tokensUsed.input + tokensUsed.output;

    return {
      responseText,
      actionDecision,
      toolCalls: [],
      tokensUsed,
    };
  }

  /**
   * 检查是否为模拟实现
   */
  isMock(): boolean {
    return true;
  }

  /**
   * 获取模型信息
   */
  getModelInfo(): { model: string; provider: string } {
    return {
      model: 'mock-pi',
      provider: 'mock',
    };
  }

  /**
   * 生成模拟响应文本
   */
  private generateMockResponse(text: string): string {
    if (text.includes('/help') || text.includes('帮助')) {
      return '这是帮助信息。我可以帮你记忆信息、回答问题。';
    }

    if (text.includes('？') || text.includes('?')) {
      return '这是一个好问题。让我想想...';
    }

    if (text.includes('你好') || text.includes('hi') || text.includes('hello')) {
      return '你好！我是 LetheBot，很高兴见到你。';
    }

    if (text.startsWith('/')) {
      return '命令已接收。';
    }

    return '收到你的消息。';
  }

  /**
   * 生成模拟 action decision
   */
  private generateMockActionDecision(text: string): ActionDecision {
    const isCommand = text.startsWith('/');
    const isQuestion = text.includes('？') || text.includes('?');

    const riskLevel = isCommand ? 'medium' : 'low';
    const confidence = isQuestion ? 0.85 : 0.7;

    return {
      id: ulid(),
      turnId: '',
      createdAt: new Date(),
      decidedBy: 'pi',
      actions: [
        {
          type: 'reply_short',
          priority: 1,
          constraints: {
            evaluatorRequired: false,
            maxResponseTokens: 200,
            redactionLevel: 'none',
          },
          reason: 'Direct response to user message',
        },
      ],
      riskLevel,
      confidence,
      reasons: ['User message detected', isQuestion ? 'Question pattern' : 'Greeting or statement'],
      suppressors: [],
      evaluatorRequired: false,
    };
  }
}
