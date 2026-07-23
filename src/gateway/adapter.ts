/**
 * Gateway Adapter Interface
 *
 * 网关适配器统一接口（供 OneBotAdapter 和 FakeOneBot 实现）
 */

import type { ChatMessageReceived, GatewayCapabilities } from '../types/events.js';

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
  sendMessage(target: MessageTarget, content: MessageContent): Promise<string>;

  /**
   * 发送表情回应
   */
  sendReaction?(messageId: string, emoji: string): Promise<void>;

  /**
   * 获取网关能力
   */
  getCapabilities(): GatewayCapabilities;

  /**
   * 监听消息事件
   */
  on(event: 'message', handler: (msg: ChatMessageReceived) => void): void;

  /**
   * 监听错误事件
   */
  on(event: 'error', handler: (error: Error) => void): void;

  /**
   * 移除事件监听
   */
  off(event: 'message' | 'error', handler: (...args: unknown[]) => void): void;
}
