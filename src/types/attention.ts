/**
 * Attention Signals
 *
 * 注意力引擎 - 快速分类，不构建完整的 ActionDecision
 */

/**
 * 注意力信号
 *
 * 注意力引擎不构建完整的 ActionDecision。它只做快速分类和提取基本信号。
 */
export interface AttentionSignals {
  classification: 'silent' | 'defer' | 'needs_response' | 'needs_evaluation';

  // 基本触发信号
  triggerScore: number; // 0.0 - 1.0
  triggerReasons: string[]; // 例如 ['@bot', 'reply_to_bot']

  // 基本抑制器
  suppressors: string[]; // 例如 ['high_speed_chat', 'bot_spoke_recently']

  // 推荐路径
  recommendedPath: 'silent_fast_path' | 'delayed_recheck' | 'reply_fast_path' | 'risk_path';
}
