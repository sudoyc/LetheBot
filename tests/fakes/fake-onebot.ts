/**
 * Fake OneBot Gateway
 *
 * 用于测试的模拟网关，实现 GatewayAdapter 接口
 */

import { EventEmitter } from 'node:events';
import { ulid } from 'ulidx';
import type { GatewayAdapter, MessageTarget, MessageContent } from '../../src/gateway/adapter';
import type { ChatMessageReceived, GatewayCapabilities } from '../../src/types/events';

export interface SimulatePrivateMessageOptions {
  senderId?: string;
  text: string;
  messageId?: string;
  timestamp?: Date;
  quote?: {
    messageId: string;
    text: string;
  };
}

export interface SimulateGroupMessageOptions {
  groupId?: string;
  senderId?: string;
  text: string;
  messageId?: string;
  timestamp?: Date;
  senderRole?: 'member' | 'admin' | 'owner';
  senderCard?: string;
  mentionsBot?: boolean;
  replyToMessageId?: string;
  quote?: {
    messageId: string;
    text: string;
  };
}

export interface SentMessage {
  messageId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  content: MessageContent;
  sentAt: Date;
}

export interface FakeOneBotConfig {
  botId?: string;
  capabilities?: Partial<GatewayCapabilities>;
  autoIncrement?: {
    messageIds?: boolean;
    userIds?: boolean;
  };
}

export class FakeOneBot implements GatewayAdapter {
  private emitter = new EventEmitter();
  private sentMessages: SentMessage[] = [];
  private capabilities: GatewayCapabilities;
  private botId: string;
  private messageCounter = 0;
  private userCounter = 0;

  constructor(config: FakeOneBotConfig = {}) {
    this.botId = config.botId ?? 'fake-bot-123';
    this.capabilities = {
      platform: 'qq',
      reactions: config.capabilities?.reactions ?? {
        emojiLike: true,
        faceMessage: true,
      },
      foldedForward: config.capabilities?.foldedForward ?? {
        groupForward: true,
        privateForward: true,
        customNode: true,
      },
      platformAdmin: config.capabilities?.platformAdmin ?? {
        kick: false,
        mute: false,
        setGroupCard: false,
      },
    };
  }

  async connect(): Promise<void> {
    // Fake gateway connects immediately
  }

  async disconnect(): Promise<void> {
    // Fake gateway disconnects immediately
  }

  async sendMessage(target: MessageTarget, content: MessageContent): Promise<string> {
    const messageId = this.generateMessageId();

    this.sentMessages.push({
      messageId,
      conversationId: target.conversationId,
      conversationType: target.conversationType,
      content,
      sentAt: new Date(),
    });

    return messageId;
  }

  async sendReaction(messageId: string, emoji: string): Promise<void> {
    // Store reactions if needed for assertions
    // For now, just a no-op
  }

  getCapabilities(): GatewayCapabilities {
    return this.capabilities;
  }

  on(event: 'message' | 'error', handler: (...args: unknown[]) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: 'message' | 'error', handler: (...args: unknown[]) => void): void {
    this.emitter.off(event, handler);
  }

  /**
   * 模拟私聊消息
   */
  simulatePrivateMessage(options: SimulatePrivateMessageOptions): void {
    const senderId = options.senderId ?? this.generateUserId();
    const messageId = options.messageId ?? this.generateMessageId();
    const timestamp = options.timestamp ?? new Date();

    const event: ChatMessageReceived = {
      id: ulid(),
      type: 'chat.message.received',
      timestamp,
      source: 'gateway',
      platform: 'qq',
      message: {
        messageId,
        conversationId: `private:${senderId}`,
        conversationType: 'private',
        senderId,
        content: {
          text: options.text,
        },
        mentionsBot: false,
      },
      gatewayCapabilities: this.capabilities,
    };

    this.emitter.emit('message', event);
  }

  /**
   * 模拟群聊消息
   */
  simulateGroupMessage(options: SimulateGroupMessageOptions): void {
    const groupId = options.groupId ?? 'fake-group-001';
    const senderId = options.senderId ?? this.generateUserId();
    const messageId = options.messageId ?? this.generateMessageId();
    const timestamp = options.timestamp ?? new Date();

    // Auto-detect @bot if not specified
    const mentionsBot = options.mentionsBot ?? options.text.includes('@bot');

    const event: ChatMessageReceived = {
      id: ulid(),
      type: 'chat.message.received',
      timestamp,
      source: 'gateway',
      platform: 'qq',
      message: {
        messageId,
        conversationId: `group:${groupId}`,
        conversationType: 'group',
        senderId,
        senderRole: options.senderRole,
        senderCard: options.senderCard,
        content: {
          text: options.text,
        },
        mentionsBot,
        replyToMessageId: options.replyToMessageId,
      },
      gatewayCapabilities: this.capabilities,
    };

    this.emitter.emit('message', event);
  }

  /**
   * 设置网关能力
   */
  setCapabilities(capabilities: Partial<GatewayCapabilities>): void {
    this.capabilities = {
      ...this.capabilities,
      ...capabilities,
    };
  }

  /**
   * 获取所有已发送的消息
   */
  getSentMessages(): SentMessage[] {
    return [...this.sentMessages];
  }

  /**
   * 获取最后一条已发送的消息
   */
  getLastSentMessage(): SentMessage | undefined {
    return this.sentMessages[this.sentMessages.length - 1];
  }

  /**
   * 断言消息已发送
   */
  assertMessageSent(matcher?: string | RegExp | { text?: string | RegExp; conversationId?: string }): void {
    if (!matcher) {
      if (this.sentMessages.length === 0) {
        throw new Error('Expected at least one message to be sent, but none were sent');
      }
      return;
    }

    const messages = this.sentMessages;

    if (typeof matcher === 'string') {
      const found = messages.some((m) => m.content.text?.includes(matcher));
      if (!found) {
        throw new Error(`Expected a message containing "${matcher}" but found: ${JSON.stringify(messages.map((m) => m.content.text))}`);
      }
    } else if (matcher instanceof RegExp) {
      const found = messages.some((m) => m.content.text && matcher.test(m.content.text));
      if (!found) {
        throw new Error(`Expected a message matching ${matcher} but found: ${JSON.stringify(messages.map((m) => m.content.text))}`);
      }
    } else {
      const found = messages.some((m) => {
        let textMatch = true;
        let conversationMatch = true;

        if (matcher.text) {
          if (typeof matcher.text === 'string') {
            textMatch = m.content.text?.includes(matcher.text) ?? false;
          } else {
            textMatch = m.content.text ? matcher.text.test(m.content.text) : false;
          }
        }

        if (matcher.conversationId) {
          conversationMatch = m.conversationId === matcher.conversationId;
        }

        return textMatch && conversationMatch;
      });

      if (!found) {
        throw new Error(`Expected a message matching ${JSON.stringify(matcher)} but found: ${JSON.stringify(messages)}`);
      }
    }
  }

  /**
   * 断言没有消息发送
   */
  assertNoMessageSent(): void {
    if (this.sentMessages.length > 0) {
      throw new Error(`Expected no messages to be sent, but ${this.sentMessages.length} were sent: ${JSON.stringify(this.sentMessages)}`);
    }
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.sentMessages = [];
    this.messageCounter = 0;
    this.userCounter = 0;
  }

  private generateMessageId(): string {
    this.messageCounter++;
    return `fake-msg-${this.messageCounter.toString().padStart(6, '0')}`;
  }

  private generateUserId(): string {
    this.userCounter++;
    return `fake-user-${this.userCounter.toString().padStart(3, '0')}`;
  }
}
