/**
 * Gateway Adapter Interface
 *
 * 网关适配器统一接口（供 OneBotAdapter 和 FakeOneBot 实现）
 */

import type { ChatMessageReceived, GatewayCapabilities } from '../types/events';

export interface MessageTarget {
  conversationId: string;
  conversationType: 'private' | 'group';
  userId?: string;
  groupId?: string;
}

export interface MessageContent {
  text?: string;
  media?: Array<{
    type: 'image' | 'video' | 'audio' | 'file';
    url?: string;
    file?: string;
  }>;
}

/**
 * 网关适配器接口
 */
export interface GatewayAdapter {
  /**
   * 连接到网关
   */
  connect(): Promise<void>;

  /**
   * 断开连接
   */
  disconnect(): Promise<void>;

  /**
   * 发送消息
   */
  sendMessage(_target: MessageTarget, _content: MessageContent): Promise<string>;

  /**
   * 发送表情回应
   */
  sendReaction?(_messageId: string, _emoji: string): Promise<void>;

  /**
   * 获取网关能力
   */
  getCapabilities(): GatewayCapabilities;

  /**
   * 监听消息事件
   */
  on(_event: 'message', _handler: (msg: ChatMessageReceived) => void): void;

  /**
   * 监听错误事件
   */
  on(_event: 'error', _handler: (error: Error) => void): void;

  /**
   * 移除事件监听
   */
  off(_event: 'message' | 'error', _handler: (...args: unknown[]) => void): void;
}
