/**
 * DeepSeek Provider - Custom provider using openai-completions API
 *
 * DeepSeek 实现了标准的 OpenAI Chat Completions API，
 * 但不支持 OpenAI 的 Responses API。
 * 因此我们需要使用 openai-completions API 类型。
 */

import type { Model } from '@earendil-works/pi-ai';

/**
 * Create a DeepSeek model configuration
 */
export function createDeepSeekModel(modelId: string): Model<'openai-completions'> {
  return {
    id: modelId,
    name: `DeepSeek ${modelId}`,
    api: 'openai-completions',
    provider: 'openai', // 使用 openai provider (兼容)
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: modelId.includes('reasoner'),
    input: ['text'],
    cost: {
      input: 0, // DeepSeek 定价不同，暂时设为0
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 64000,
    maxTokens: 8000,
  };
}

/**
 * DeepSeek 可用模型列表
 */
export const DEEPSEEK_MODELS = {
  'deepseek-v4-flash': createDeepSeekModel('deepseek-v4-flash'),
  'deepseek-v4-pro': createDeepSeekModel('deepseek-v4-pro'),
  'deepseek-reasoner': createDeepSeekModel('deepseek-reasoner'),
} as const;
