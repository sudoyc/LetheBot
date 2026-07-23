/**
 * Event Envelopes
 *
 * 所有内部事件的基础类型定义
 */

/**
 * 所有内部事件的基础接口
 */
export interface InternalEvent {
  id: string; // ULID
  type: string; // 事件类型判别器
  timestamp: Date;
  source: 'gateway' | 'agent' | 'tool' | 'worker' | 'system';
  platform?: 'qq';
  conversationId?: string; // 不透明的会话标识符
  correlationId?: string; // 关联相关事件
}

/**
 * 媒体附件
 */
export interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url?: string;
  localPath?: string;
  mimeType?: string;
  size?: number;
}

/**
 * 引用消息
 */
export interface QuotedMessage {
  messageId: string;
  senderId: string;
  text?: string;
}

/**
 * 网关能力报告
 */
export interface GatewayCapabilities {
  platform: 'qq';

  reactions: {
    emojiLike: boolean; // 真正的 emoji 反应支持
    faceMessage: boolean; // 降级到 QQ 表情消息
  };

  foldedForward: {
    groupForward: boolean; // 群聊转发节点
    privateForward: boolean; // 私聊转发节点
    customNode: boolean; // 自定义文本节点
  };

  platformAdmin: {
    kick: boolean;
    mute: boolean;
    setGroupCard: boolean;
  };
}

/**
 * 聊天消息接收事件
 */
export interface ChatMessageReceived extends InternalEvent {
  type: 'chat.message.received';
  source: 'gateway';
  platform: 'qq';

  ingress: {
    transport: 'http' | 'ws';
    platformEventId?: string;
  };

  message: {
    messageId: string; // 平台消息 ID
    conversationId: string;
    conversationType: 'private' | 'group';

    groupId?: string; // 如果是群聊
    senderId: string; // 平台用户 ID
    senderRole?: 'member' | 'admin' | 'owner';
    senderDisplayName?: string;
    senderCard?: string;

    content: {
      text?: string;
      media?: MediaAttachment[];
      quote?: QuotedMessage;
    };

    mentions?: string[]; // 平台用户 ID 列表
    mentionsBot: boolean;
    replyToMessageId?: string;
  };

  // 网关能力报告
  gatewayCapabilities: GatewayCapabilities;
}
