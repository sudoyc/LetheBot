/**
 * OneBot 11 Adapter (HTTP mode)
 *
 * 连接到 NapCat 的 HTTP API + reverse HTTP event endpoint 适配器。
 */

import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import type { MessageContent, MessageTarget } from './adapter';
import type {
  ChatMessageReceived,
  GatewayCapabilities,
  MediaAttachment,
  QuotedMessage,
} from '../types/events';

interface OneBotApiResponse {
  status?: unknown;
  retcode?: unknown;
  message?: unknown;
  data?: unknown;
}

export interface OneBotConfig {
  httpUrl: string;
  token?: string;
  botId?: string;
}

export interface OneBotSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotMessage {
  post_type: 'message' | 'notice' | 'request' | 'meta_event';
  message_type?: 'private' | 'group';
  message_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  message?: string | OneBotSegment[];
  raw_message?: string;
  sender?: {
    user_id?: number | string;
    nickname?: string;
    card?: string;
    role?: string;
  };
  time?: number;
}

export interface OneBotReadiness {
  ready: boolean;
  mode: 'http';
  httpUrl: string;
  hasToken: boolean;
  botIdConfigured: boolean;
  lastError?: string;
}

type HeaderValue = string | string[] | undefined;
type AuthHeaders = IncomingHttpHeaders | Headers | Record<string, HeaderValue>;

interface ParsedMessageContent {
  text: string;
  mentions: string[];
  media: MediaAttachment[];
  quote?: QuotedMessage;
  replyToMessageId?: string;
}

export class OneBotAdapter extends EventEmitter {
  private readonly config: OneBotConfig;
  private ready = false;
  private lastError: string | undefined;

  constructor(config: OneBotConfig) {
    super();
    this.config = {
      ...config,
      token: this.normalizeOptional(config.token),
      botId: this.normalizeOptional(config.botId),
    };
  }

  async start(): Promise<void> {
    this.ready = true;
    this.lastError = undefined;
    console.log('OneBot adapter started (HTTP mode)');
  }

  async stop(): Promise<void> {
    this.ready = false;
    console.log('OneBot adapter stopped');
  }

  async connect(): Promise<void> {
    await this.start();
  }

  async disconnect(): Promise<void> {
    await this.stop();
  }

  getCapabilities(): GatewayCapabilities {
    return this.buildCapabilities();
  }

  getReadiness(): OneBotReadiness {
    return {
      ready: this.ready,
      mode: 'http',
      httpUrl: this.config.httpUrl,
      hasToken: Boolean(this.config.token),
      botIdConfigured: Boolean(this.config.botId),
      lastError: this.lastError,
    };
  }

  /**
   * 校验 reverse HTTP event 的访问令牌。
   *
   * 若未配置 ONEBOT_TOKEN，则允许本地/dev 流量；配置后要求
   * Authorization: Bearer <token>，和出站 OneBot API 调用使用同一 token。
   */
  validateHttpEventAuth(headers: AuthHeaders): boolean {
    const expectedToken = this.config.token;
    if (!expectedToken) {
      return true;
    }

    const authorization = this.getHeader(headers, 'authorization')?.trim();
    if (!authorization) {
      return false;
    }

    const [scheme, ...rest] = authorization.split(/\s+/);
    return scheme?.toLowerCase() === 'bearer' && rest.join(' ') === expectedToken;
  }

  /**
   * 处理来自 NapCat 的 HTTP POST 事件。
   */
  handleHttpEvent(body: OneBotMessage): boolean {
    try {
      const internalEvent = this.convertToInternalEvent(body);
      if (!internalEvent) {
        return false;
      }

      this.emit('event', internalEvent);
      this.emit('message', internalEvent);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown OneBot event error';
      this.lastError = message;
      console.error('Failed to handle OneBot event:', error);
      if (this.listenerCount('error') > 0) {
        this.emit('error', error instanceof Error ? error : new Error(message));
      }
      return false;
    }
  }

  /**
   * 转换为内部事件格式。
   */
  private convertToInternalEvent(msg: OneBotMessage): ChatMessageReceived | null {
    if (msg.post_type !== 'message') {
      return null;
    }

    if (msg.message_type !== 'private' && msg.message_type !== 'group') {
      return null;
    }

    const platformMessageId = this.normalizeMessageId(msg.message_id ?? Date.now());
    const senderPlatformId = msg.user_id ?? msg.sender?.user_id ?? 'unknown';
    const senderId = this.normalizeUserId(senderPlatformId);
    const parsed = this.parseMessageContent(msg.message, msg.raw_message);
    const timestamp = msg.time ? new Date(msg.time * 1000) : new Date();

    if (msg.message_type === 'private') {
      const conversationId = `private:${senderId}`;
      return {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: 'chat.message.received',
        timestamp,
        source: 'gateway',
        platform: 'qq',
        conversationId,
        message: {
          messageId: platformMessageId,
          conversationId,
          conversationType: 'private',
          senderId,
          senderDisplayName: this.normalizeOptional(msg.sender?.nickname),
          content: {
            text: parsed.text,
            media: parsed.media,
            quote: parsed.quote,
          },
          mentions: parsed.mentions,
          mentionsBot: false,
          replyToMessageId: parsed.replyToMessageId,
        },
        gatewayCapabilities: this.buildCapabilities(),
      };
    }

    const groupId = this.normalizeGroupId(msg.group_id ?? 'unknown');
    const senderCard = this.normalizeOptional(msg.sender?.card);
    const senderDisplayName = senderCard ?? this.normalizeOptional(msg.sender?.nickname);
    return {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type: 'chat.message.received',
      timestamp,
      source: 'gateway',
      platform: 'qq',
      conversationId: groupId,
      message: {
        messageId: platformMessageId,
        conversationId: groupId,
        conversationType: 'group',
        groupId,
        senderId,
        senderRole: this.normalizeSenderRole(msg.sender?.role),
        senderDisplayName,
        senderCard,
        content: {
          text: parsed.text,
          media: parsed.media,
          quote: parsed.quote,
        },
        mentions: parsed.mentions,
        mentionsBot: this.detectBotMention(parsed.mentions, parsed.text),
        replyToMessageId: parsed.replyToMessageId,
      },
      gatewayCapabilities: this.buildCapabilities(),
    };
  }

  private parseMessageContent(
    message: OneBotMessage['message'],
    rawMessage: string | undefined,
  ): ParsedMessageContent {
    if (Array.isArray(message)) {
      return this.parseSegmentArray(message);
    }

    const raw = typeof message === 'string' ? message : rawMessage ?? '';
    return this.parseCqString(raw);
  }

  private parseSegmentArray(segments: OneBotSegment[]): ParsedMessageContent {
    const parsed = this.emptyParsedContent();
    const textParts: string[] = [];

    for (const segment of segments) {
      if (segment.type === 'text') {
        textParts.push(this.decodeCqValue(this.stringifySegmentData(segment.data, 'text')));
        continue;
      }

      this.applyStructuredSegment(segment.type, segment.data ?? {}, parsed);
    }

    return {
      ...parsed,
      text: textParts.join('').trim(),
    };
  }

  private parseCqString(raw: string): ParsedMessageContent {
    const parsed = this.emptyParsedContent();
    const textParts: string[] = [];
    const cqPattern = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g;
    let cursor = 0;
    let match = cqPattern.exec(raw);

    while (match) {
      textParts.push(this.decodeCqValue(raw.slice(cursor, match.index)));
      const type = match[1] ?? '';
      const params = this.parseCqParams(match[2] ?? '');
      this.applyStructuredSegment(type, params, parsed);
      cursor = match.index + match[0].length;
      match = cqPattern.exec(raw);
    }

    textParts.push(this.decodeCqValue(raw.slice(cursor)));

    return {
      ...parsed,
      text: textParts.join('').trim(),
    };
  }

  private emptyParsedContent(): ParsedMessageContent {
    return {
      text: '',
      mentions: [],
      media: [],
    };
  }

  private applyStructuredSegment(
    type: string,
    data: Record<string, unknown>,
    parsed: ParsedMessageContent,
  ): void {
    if (type === 'at') {
      const qq = this.stringifySegmentData(data, 'qq');
      if (qq) {
        parsed.mentions.push(this.normalizeUserId(qq));
      }
      return;
    }

    if (type === 'reply') {
      const id = this.stringifySegmentData(data, 'id');
      if (id) {
        const messageId = this.normalizeMessageId(id);
        parsed.replyToMessageId = messageId;
        parsed.quote = {
          messageId,
          senderId: 'unknown',
        };
      }
      return;
    }

    const mediaType = this.mapMediaType(type);
    if (mediaType) {
      parsed.media.push({
        type: mediaType,
        url: this.normalizeOptional(this.stringifySegmentData(data, 'url')),
      });
    }
  }

  private parseCqParams(rawParams: string): Record<string, string> {
    const params: Record<string, string> = {};
    const trimmed = rawParams.startsWith(',') ? rawParams.slice(1) : rawParams;
    if (!trimmed) {
      return params;
    }

    for (const pair of trimmed.split(',')) {
      const eqIndex = pair.indexOf('=');
      if (eqIndex <= 0) {
        continue;
      }

      const key = pair.slice(0, eqIndex);
      const value = pair.slice(eqIndex + 1);
      params[key] = this.decodeCqValue(value);
    }

    return params;
  }

  private decodeCqValue(value: string): string {
    return value
      .replace(/&#44;/g, ',')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&amp;/g, '&');
  }

  private stringifySegmentData(data: Record<string, unknown> | undefined, key: string): string {
    const value = data?.[key];
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return '';
  }

  private mapMediaType(type: string): MediaAttachment['type'] | null {
    if (type === 'image') {
      return 'image';
    }
    if (type === 'record') {
      return 'audio';
    }
    if (type === 'video') {
      return 'video';
    }
    if (type === 'file') {
      return 'file';
    }
    return null;
  }

  private detectBotMention(mentions: string[], text: string): boolean {
    const configuredBotId = this.config.botId;
    if (configuredBotId) {
      const expected = this.stripUserPrefix(configuredBotId);
      return mentions.some((mention) => this.stripUserPrefix(mention) === expected);
    }

    return mentions.length > 0 || text.includes('@bot');
  }

  /**
   * 通过统一 GatewayAdapter 风格路径发送消息。
   */
  async sendMessage(target: MessageTarget, content: MessageContent): Promise<string> {
    const text = content.text ?? '';
    if (target.conversationType === 'private') {
      const userId = target.userId ?? this.extractPrivateUserId(target.conversationId);
      return this.sendPrivateMessage(userId, text);
    }

    const groupId = target.groupId ?? this.extractGroupId(target.conversationId);
    return this.sendGroupMessage(groupId, text);
  }

  /**
   * 发送私聊消息。
   */
  async sendPrivateMessage(userId: string, text: string): Promise<string> {
    const result = await this.callApi('send_private_msg', {
      user_id: this.toOneBotNumericId(userId, 'qq-', 'userId'),
      message: text,
    });

    return this.extractSentMessageId(result);
  }

  /**
   * 发送群消息。
   */
  async sendGroupMessage(groupId: string, text: string): Promise<string> {
    const result = await this.callApi('send_group_msg', {
      group_id: this.toOneBotNumericId(groupId, 'qq-group-', 'groupId'),
      message: text,
    });

    return this.extractSentMessageId(result);
  }

  /**
   * 注册事件处理器。
   */
  onEvent(handler: (event: ChatMessageReceived) => void): void {
    this.on('event', handler);
  }

  /**
   * 调用 OneBot API。
   */
  private async callApi(action: string, params: Record<string, unknown>): Promise<unknown> {
    const url = this.buildActionUrl(action);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        throw new Error(`OneBot API failed: ${response.status} ${response.statusText}`);
      }

      const result = (await response.json()) as OneBotApiResponse;
      if (result.status !== 'ok' && result.retcode !== 0) {
        const message = typeof result.message === 'string' ? result.message : 'Unknown error';
        throw new Error(`OneBot API error: ${message}`);
      }

      this.lastError = undefined;
      return result.data;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Unknown OneBot API error';
      throw error;
    }
  }

  private buildActionUrl(action: string): string {
    const baseUrl = this.config.httpUrl.endsWith('/')
      ? this.config.httpUrl
      : `${this.config.httpUrl}/`;
    return new URL(action, baseUrl).toString();
  }

  private extractSentMessageId(data: unknown): string {
    if (this.isRecord(data)) {
      const messageId = data.message_id;
      if (typeof messageId === 'string' || typeof messageId === 'number') {
        return this.normalizeMessageId(messageId);
      }
    }

    return `qq-sent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private getHeader(headers: AuthHeaders, name: string): string | undefined {
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined;
    }

    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  private normalizeMessageId(value: number | string): string {
    const text = String(value);
    return text.startsWith('qq-') ? text : `qq-${text}`;
  }

  private normalizeUserId(value: number | string): string {
    const text = String(value);
    return text.startsWith('qq-') ? text : `qq-${text}`;
  }

  private normalizeGroupId(value: number | string): string {
    const text = String(value);
    return text.startsWith('qq-group-') ? text : `qq-group-${text}`;
  }

  private stripUserPrefix(value: string): string {
    return value.startsWith('qq-') ? value.slice('qq-'.length) : value;
  }

  private extractPrivateUserId(conversationId: string): string {
    return conversationId.startsWith('private:')
      ? conversationId.slice('private:'.length)
      : conversationId;
  }

  private extractGroupId(conversationId: string): string {
    if (conversationId.startsWith('group:')) {
      return conversationId.slice('group:'.length);
    }
    return conversationId;
  }

  private toOneBotNumericId(value: string, prefix: string, label: string): number {
    const stripped = value.startsWith(prefix) ? value.slice(prefix.length) : value;
    if (!/^\d+$/.test(stripped)) {
      throw new Error(`Invalid OneBot ${label}: expected ${prefix}<numeric-id>`);
    }

    return Number(stripped);
  }

  private normalizeSenderRole(role: string | undefined): 'member' | 'admin' | 'owner' | undefined {
    if (role === 'member' || role === 'admin' || role === 'owner') {
      return role;
    }
    return undefined;
  }

  private normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  private buildCapabilities(): GatewayCapabilities {
    return {
      platform: 'qq',
      reactions: { emojiLike: false, faceMessage: true },
      foldedForward: { groupForward: true, privateForward: true, customNode: true },
      platformAdmin: { kick: false, mute: false, setGroupCard: false },
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
