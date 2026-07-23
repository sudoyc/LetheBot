/**
 * Attention Signals
 *
 * 注意力信号分类和执行路径选择
 */

export interface AttentionSignals {
  classification: 'silent' | 'defer' | 'needs_response' | 'needs_evaluation';
  triggerScore: number; // 0.0 - 1.0
  triggerReasons: string[];
  suppressors: string[];
  recommendedPath: 'silent_fast_path' | 'delayed_recheck' | 'reply_fast_path' | 'risk_path';
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

const GOVERNANCE_COMMAND_PATTERN = /^\/(?:memory|why)(?=$|\s)/;

export function hasQuestionSignal(text: string): boolean {
  return text.includes('？') || text.includes('?') || text.includes('吗');
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

    const hasGovernanceCommandAuthority = event.conversationType === 'private'
      || event.senderRole === 'owner'
      || event.senderRole === 'admin';
    if (hasGovernanceCommandAuthority && GOVERNANCE_COMMAND_PATTERN.test(event.text)) {
      triggers.push({ type: 'command', weight: 0.9, reason: 'Command prefix detected' });
    }

    // 私聊默认触发
    if (event.conversationType === 'private') {
      triggers.push({ type: 'private_message', weight: 0.6, reason: 'Private conversation' });
    }

    // 软触发器 - 直接问题
    const hasQuestion = hasQuestionSignal(event.text);
    if (hasQuestion) {
      triggers.push({ type: 'question', weight: 0.3, reason: 'Question detected' });
    }

    // 短闲聊仍可快速静默；真实流速在延迟重检时根据持久消息窗口判断。
    if (event.conversationType === 'group' && event.text.length < 10 && !event.mentionsBot && !hasQuestion) {
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
    } else if (triggers.some((trigger) => trigger.type === 'command')) {
      classification = 'needs_evaluation';
      recommendedPath = 'risk_path';
    } else if (triggerScore >= 0.5) {
      classification = 'needs_response';
      recommendedPath = 'reply_fast_path';
    } else if (event.conversationType === 'group' && hasQuestion) {
      classification = 'defer';
      recommendedPath = 'delayed_recheck';
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
