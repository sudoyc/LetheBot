/**
 * Attention Signals
 *
 * 注意力信号分类和执行路径选择
 */

export interface AttentionSignals {
  classification: 'silent' | 'needs_response' | 'needs_evaluation';
  triggerScore: number; // 0.0 - 1.0
  triggerReasons: string[];
  suppressors: string[];
  recommendedPath: 'silent_fast_path' | 'reply_fast_path' | 'risk_path';
}

/**
 * 触发信号
 */
export interface TriggerSignal {
  type: string;
  weight: number;
  reason: string;
}

/**
 * 抑制器
 */
export interface Suppressor {
  type: string;
  reason: string;
  downgradeAction?: string;
}

/**
 * 注意力引擎
 */
export class AttentionEngine {
  /**
   * 分析消息并生成注意力信号
   */
  analyze(event: {
    conversationType: 'private' | 'group';
    mentionsBot: boolean;
    text: string;
    senderId: string;
    senderRole?: string;
    replyToBot?: boolean;
  }): AttentionSignals {
    const triggers: TriggerSignal[] = [];
    const suppressors: Suppressor[] = [];

    // 强触发器
    if (event.mentionsBot) {
      triggers.push({ type: '@bot', weight: 0.8, reason: 'Direct mention' });
    }

    if (event.replyToBot) {
      triggers.push({ type: 'reply_to_bot', weight: 0.7, reason: 'Reply to bot message' });
    }

    if (event.text.startsWith('/') || event.text.startsWith('!')) {
      triggers.push({ type: 'command', weight: 0.9, reason: 'Command prefix detected' });
    }

    // 私聊默认触发
    if (event.conversationType === 'private') {
      triggers.push({ type: 'private_message', weight: 0.6, reason: 'Private conversation' });
    }

    // 管理员指令
    if (event.senderRole === 'owner' || event.senderRole === 'admin') {
      if (event.text.includes('管理') || event.text.includes('设置')) {
        triggers.push({ type: 'admin_instruction', weight: 0.85, reason: 'Admin instruction' });
      }
    }

    // 软触发器 - 直接问题
    if (event.text.includes('？') || event.text.includes('?') || event.text.includes('吗')) {
      triggers.push({ type: 'question', weight: 0.3, reason: 'Question detected' });
    }

    // 抑制器 - 高速聊天（简化：检测短消息）
    if (event.conversationType === 'group' && event.text.length < 10 && !event.mentionsBot) {
      suppressors.push({
        type: 'high_speed_chat',
        reason: 'Short casual message in group',
        downgradeAction: 'silent_store',
      });
    }

    // 抑制器 - Bot 刚发言（需要外部状态，这里简化）
    // if (botSpokeRecently) suppressors.push({ type: 'bot_spoke_recently', reason: 'Cooldown' });

    // 计算总分
    const triggerScore = triggers.reduce((sum, t) => sum + t.weight, 0);
    const triggerReasons = triggers.map((t) => t.type);
    const suppressorReasons = suppressors.map((s) => s.type);

    // 分类
    let classification: AttentionSignals['classification'];
    let recommendedPath: AttentionSignals['recommendedPath'];

    if (suppressors.length > 0 && triggerScore < 0.7) {
      classification = 'silent';
      recommendedPath = 'silent_fast_path';
    } else if (triggerScore >= 0.9 || triggers.some((t) => t.type === 'admin_instruction')) {
      classification = 'needs_evaluation';
      recommendedPath = 'risk_path';
    } else if (triggerScore >= 0.5) {
      classification = 'needs_response';
      recommendedPath = 'reply_fast_path';
    } else {
      classification = 'silent';
      recommendedPath = 'silent_fast_path';
    }

    return {
      classification,
      triggerScore: Math.min(triggerScore, 1.0),
      triggerReasons,
      suppressors: suppressorReasons,
      recommendedPath,
    };
  }
}
