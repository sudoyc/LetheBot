/**
 * Fake OneBot Gateway
 *
 * 用于测试的模拟网关，实现 GatewayAdapter 接口
 */

import { EventEmitter } from 'node:events';
import { ulid } from 'ulidx';
import type { GatewayAdapter, MessageTarget, MessageContent } from '../../src/gateway/adapter';
import type { ChatMessageReceived, GatewayCapabilities, MediaAttachment } from '../../src/types/events';

export interface SimulatePrivateMessageOptions {
  senderId?: string;
  text: string;
  messageId?: string;
  timestamp?: Date;
  quote?: {
    messageId: string;
    text: string;
  };
  media?: MediaAttachment[];
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
  media?: MediaAttachment[];
}

export interface SentMessage {
  messageId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  content: MessageContent;
  sentAt: Date;
}

export interface SentReaction {
  messageId: string;
  emoji: string;
  sentAt: Date;
}

export interface FakeOneBotConfig {
  botId?: string;
  capabilities?: Partial<GatewayCapabilities>;
}

export class FakeOneBot implements GatewayAdapter {
  private emitter = new EventEmitter();
  private sentMessages: SentMessage[] = [];
  private sentReactions: SentReaction[] = [];
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
    this.sentReactions.push({
      messageId,
      emoji,
      sentAt: new Date(),
    });
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
          media: options.media ?? [],
          quote: options.quote
            ? {
                messageId: options.quote.messageId,
                senderId: 'unknown',
                text: options.quote.text,
              }
            : undefined,
        },
        mentionsBot: false,
        replyToMessageId: options.quote?.messageId,
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

    const mentions = this.extractMentions(options.text);

    // Auto-detect @bot / exact CQ mention if not specified
    const autoMentionsBot = options.text.includes('@bot')
      || mentions.includes(this.normalizeUserId(this.botId));
    const mentionsBot = options.mentionsBot ?? autoMentionsBot;

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
        groupId,
        senderId,
        senderRole: options.senderRole,
        senderDisplayName: options.senderCard,
        senderCard: options.senderCard,
        content: {
          text: options.text,
          media: options.media ?? [],
          quote: options.quote
            ? {
                messageId: options.quote.messageId,
                senderId: 'unknown',
                text: options.quote.text,
              }
            : undefined,
        },
        mentions,
        mentionsBot,
        replyToMessageId: options.replyToMessageId ?? options.quote?.messageId,
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
   * 获取所有已发送的 reaction
   */
  getSentReactions(): SentReaction[] {
    return [...this.sentReactions];
  }

  /**
   * 获取最后一条已发送的 reaction
   */
  getLastSentReaction(): SentReaction | undefined {
    return this.sentReactions[this.sentReactions.length - 1];
  }

  /**
   * 断言 reaction 已发送
   */
  assertReactionSent(messageId: string, emoji?: string): void {
    const found = this.sentReactions.some((reaction) => {
      if (reaction.messageId !== messageId) {
        return false;
      }
      return emoji === undefined || reaction.emoji === emoji;
    });

    if (!found) {
      throw new Error(
        `Expected reaction ${emoji ?? '*'} for message ${messageId} but found: ${JSON.stringify(this.sentReactions)}`,
      );
    }
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
    this.sentReactions = [];
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

  private extractMentions(text: string): string[] {
    const mentions: string[] = [];
    const cqAtPattern = /\[CQ:at,qq=([^\],]+)[^\]]*\]/g;
    let match = cqAtPattern.exec(text);
    while (match) {
      const qq = match[1];
      if (qq) {
        mentions.push(this.normalizeUserId(qq));
      }
      match = cqAtPattern.exec(text);
    }
    return mentions;
  }

  private normalizeUserId(userId: string): string {
    return userId.startsWith('qq-') ? userId : `qq-${userId}`;
  }
}
