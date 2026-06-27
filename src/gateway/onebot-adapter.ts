/**
 * OneBot 11 Adapter (Simplified)
 *
 * 连接到 NapCat 的简化实现
 */

import { EventEmitter } from 'node:events';
import type { ChatMessageReceived, GatewayCapabilities } from '../types/events';

export interface OneBotConfig {
  httpUrl: string;
  token?: string;
}

export interface OneBotMessage {
  post_type: 'message' | 'notice' | 'request' | 'meta_event';
  message_type?: 'private' | 'group';
  message_id?: number;
  user_id?: number;
  group_id?: number;
  message?: string;
  raw_message?: string;
  sender?: {
    user_id?: number;
    nickname?: string;
    card?: string;
  };
  time?: number;
}

export class OneBotAdapter extends EventEmitter {
  private config: OneBotConfig;

  constructor(config: OneBotConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    console.log('OneBot adapter started (HTTP mode)');
  }

  async stop(): Promise<void> {
    console.log('OneBot adapter stopped');
  }

  /**
   * 处理来自 NapCat 的 HTTP POST 事件
   */
  handleHttpEvent(body: OneBotMessage): void {
    try {
      const internalEvent = this.convertToInternalEvent(body);
      if (internalEvent) {
        this.emit('event', internalEvent);
      }
    } catch (error) {
      console.error('Failed to handle OneBot event:', error);
    }
  }

  /**
   * 转换为内部事件格式
   */
  private convertToInternalEvent(msg: OneBotMessage): ChatMessageReceived | null {
    if (msg.post_type !== 'message') {
      return null;
    }

    const platformMessageId = `qq-${msg.message_id ?? Date.now()}`;
    const senderId = `qq-${msg.user_id}`;
    const text = msg.raw_message ?? msg.message ?? '';

    const gatewayCapabilities: GatewayCapabilities = {
      platform: 'qq',
      reactions: { emojiLike: false, faceMessage: true },
      foldedForward: { groupForward: true, privateForward: true, customNode: true },
      platformAdmin: { kick: false, mute: false, setGroupCard: false },
    };

    if (msg.message_type === 'private') {
      const conversationId = `private:${senderId}`;
      return {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: 'chat.message.received',
        timestamp: new Date((msg.time ?? Date.now()) * 1000),
        source: 'gateway',
        platform: 'qq',
        conversationId,
        message: {
          messageId: platformMessageId,
          conversationId,
          conversationType: 'private',
          senderId,
          senderRole: undefined,
          content: { text, media: [], quote: undefined },
          mentions: [],
          mentionsBot: false,
          replyToMessageId: undefined,
        },
        gatewayCapabilities,
      };
    } else {
      const groupId = `qq-group-${msg.group_id}`;
      return {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: 'chat.message.received',
        timestamp: new Date((msg.time ?? Date.now()) * 1000),
        source: 'gateway',
        platform: 'qq',
        conversationId: groupId,
        message: {
          messageId: platformMessageId,
          conversationId: groupId,
          conversationType: 'group',
          groupId,
          senderId,
          senderRole: undefined,
          content: { text, media: [], quote: undefined },
          mentions: [],
          mentionsBot: this.detectMention(text),
          replyToMessageId: undefined,
        },
        gatewayCapabilities,
      };
    }
  }

  private detectMention(text: string): boolean {
    return text.includes('[CQ:at,qq=') || text.includes('@bot');
  }

  /**
   * 发送私聊消息
   */
  async sendPrivateMessage(userId: string, text: string): Promise<void> {
    const numericUserId = userId.replace('qq-', '');
    await this.callApi('send_private_msg', {
      user_id: parseInt(numericUserId, 10),
      message: text,
    });
  }

  /**
   * 发送群消息
   */
  async sendGroupMessage(groupId: string, text: string): Promise<void> {
    const numericGroupId = groupId.replace('qq-group-', '');
    await this.callApi('send_group_msg', {
      group_id: parseInt(numericGroupId, 10),
      message: text,
    });
  }

  /**
   * 注册事件处理器
   */
  onEvent(handler: (event: ChatMessageReceived) => void): void {
    this.on('event', handler);
  }

  /**
   * 调用 OneBot API
   */
  private async callApi(action: string, params: Record<string, unknown>): Promise<any> {
    const url = `${this.config.httpUrl}/${action}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      throw new Error(`OneBot API failed: ${response.status} ${response.statusText}`);
    }

    const result: any = await response.json();
    if (result.status !== 'ok' && result.retcode !== 0) {
      throw new Error(`OneBot API error: ${result.message ?? 'Unknown error'}`);
    }

    return result.data;
  }
}
