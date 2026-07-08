/**
 * OneBot 11 Adapter (HTTP / WebSocket modes)
 *
 * 连接到 SnowLuma / OneBot runtime，并统一转换 OneBot event。
 */

import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { redactSecretsInText } from '../memory/secret-scan';
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
  wording?: unknown;
  data?: unknown;
  echo?: unknown;
}

export type OneBotTransport = 'http' | 'ws';

export interface OneBotWebSocketEvent {
  data?: unknown;
  error?: unknown;
  message?: unknown;
  reason?: unknown;
}

export interface OneBotWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    event: 'open' | 'message' | 'error' | 'close',
    handler: (event: OneBotWebSocketEvent) => void,
  ): void;
}

export type OneBotWebSocketFactory = (url: string) => OneBotWebSocketLike;

export interface OneBotConfig {
  httpUrl: string;
  wsUrl?: string;
  transport?: OneBotTransport;
  token?: string;
  botId?: string;
  webSocketFactory?: OneBotWebSocketFactory;
  wsReconnectIntervalMs?: number;
}

export interface OneBotSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotMessage {
  post_type: 'message' | 'message_sent' | 'notice' | 'request' | 'meta_event';
  message_type?: 'private' | 'group';
  sub_type?: unknown;
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
  mode: OneBotTransport;
  httpUrl: string;
  wsUrl?: string;
  wsConnected?: boolean;
  pendingWsRequests?: number;
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

interface PendingWsRequest {
  resolve: (value: OneBotApiResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class OneBotAdapter extends EventEmitter {
  private readonly config: OneBotConfig;
  private readonly transport: OneBotTransport;
  private readonly webSocketFactory: OneBotWebSocketFactory;
  private readonly wsReconnectIntervalMs: number;
  private ready = false;
  private lastError: string | undefined;
  private socket: OneBotWebSocketLike | null = null;
  private wsConnected = false;
  private manuallyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingWsRequests = new Map<string, PendingWsRequest>();

  constructor(config: OneBotConfig) {
    super();
    this.transport = config.transport ?? 'http';
    this.wsReconnectIntervalMs = Math.max(100, config.wsReconnectIntervalMs ?? 5000);
    this.webSocketFactory = config.webSocketFactory ?? ((url) => {
      return new WebSocket(url) as unknown as OneBotWebSocketLike;
    });
    this.config = {
      ...config,
      wsUrl: this.normalizeOptional(config.wsUrl) ?? 'ws://localhost:3001/',
      token: this.normalizeOptional(config.token),
      botId: this.normalizeOptional(config.botId),
    };
  }

  async start(): Promise<void> {
    this.ready = true;
    this.lastError = undefined;
    this.manuallyClosed = false;
    if (this.transport === 'ws') {
      this.openWebSocket();
    }
    console.log(`OneBot adapter started (${this.transport.toUpperCase()} mode)`);
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.closeWebSocket();
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
    const ready = this.transport === 'ws'
      ? this.ready && this.wsConnected
      : this.ready;
    return {
      ready,
      mode: this.transport,
      httpUrl: this.config.httpUrl,
      wsUrl: this.config.wsUrl,
      wsConnected: this.transport === 'ws' ? this.wsConnected : undefined,
      pendingWsRequests: this.transport === 'ws' ? this.pendingWsRequests.size : undefined,
      hasToken: Boolean(this.config.token),
      botIdConfigured: Boolean(this.config.botId),
      lastError: this.lastError,
    };
  }

  /**
   * 校验 reverse HTTP event 的访问令牌。
   *
   * 若未配置 ONEBOT_TOKEN，则允许本地/dev 流量；配置后接受：
   * - Authorization: Bearer <token>（NapCat / generic OneBot）
   * - X-Signature: sha1=<hmac-sha1(rawBody, token)>（SnowLuma reverse HTTP）
   */
  validateHttpEventAuth(headers: AuthHeaders, rawBody = ''): boolean {
    const expectedToken = this.config.token;
    if (!expectedToken) {
      return true;
    }

    const authorization = this.getHeader(headers, 'authorization')?.trim();
    const [scheme, ...rest] = authorization?.split(/\s+/) ?? [];
    if (scheme?.toLowerCase() === 'bearer' && rest.join(' ') === expectedToken) {
      return true;
    }

    const signature = this.getHeader(headers, 'x-signature')?.trim();
    return signature ? this.validateSnowLumaSignature(signature, rawBody, expectedToken) : false;
  }

  /**
   * 处理来自 OneBot runtime 的事件。
   */
  handleHttpEvent(body: unknown): boolean {
    try {
      if (!this.isRecord(body)) {
        return false;
      }

      const internalEvent = this.convertToInternalEvent(body as unknown as OneBotMessage);
      if (!internalEvent) {
        return false;
      }

      this.emit('event', internalEvent);
      this.emit('message', internalEvent);
      return true;
    } catch (error) {
      const redactedMessage = this.toRedactedDiagnosticMessage(error, 'Unknown OneBot event error');
      this.lastError = redactedMessage;
      console.error('Failed to handle OneBot event:', this.formatRedactedConsoleDiagnostic(error, 'Unknown OneBot event error'));
      this.emitError(error);
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

    if (!this.isSupportedMessageSubtype(msg.message_type, msg.sub_type)) {
      return null;
    }

    const platformMessageId = this.normalizeMessageId(
      this.normalizeTopLevelId(msg.message_id) ?? this.createLocalMessageId()
    );
    const senderPlatformId = this.normalizeTopLevelId(msg.user_id)
      ?? this.normalizeTopLevelId(msg.sender?.user_id)
      ?? 'unknown';
    const senderId = this.normalizeUserId(senderPlatformId);
    const parsed = this.parseMessageContent(msg.message, msg.raw_message);
    const timestamp = this.normalizeTimestamp(msg.time);

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
          senderDisplayName: this.normalizeDisplayMetadata(msg.sender?.nickname),
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

    const groupId = this.normalizeGroupId(this.normalizeTopLevelId(msg.group_id) ?? 'unknown');
    const senderCard = this.normalizeDisplayMetadata(msg.sender?.card);
    const senderDisplayName = senderCard ?? this.normalizeDisplayMetadata(msg.sender?.nickname);
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

    if (typeof message === 'string') {
      return this.parseCqString(message);
    }

    if (typeof rawMessage === 'string') {
      return this.parseCqString(rawMessage);
    }

    return this.emptyParsedContent();
  }

  private parseSegmentArray(segments: OneBotSegment[]): ParsedMessageContent {
    const parsed = this.emptyParsedContent();
    const textParts: string[] = [];

    for (const segment of segments as unknown[]) {
      if (!this.isOneBotSegment(segment)) {
        continue;
      }

      const data = this.segmentDataRecord(segment.data);
      if (segment.type === 'text') {
        textParts.push(this.decodeCqValue(this.stringifySegmentString(data, 'text')));
        continue;
      }

      this.applyStructuredSegment(segment.type, data, parsed);
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

  private isOneBotSegment(segment: unknown): segment is OneBotSegment {
    return this.isRecord(segment) && typeof segment.type === 'string';
  }

  private segmentDataRecord(data: unknown): Record<string, unknown> {
    return this.isRecord(data) ? data : {};
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private applyStructuredSegment(
    type: string,
    data: Record<string, unknown>,
    parsed: ParsedMessageContent,
  ): void {
    if (type === 'at') {
      const qq = this.stringifySegmentId(data, 'qq', { allowAll: true });
      if (qq) {
        parsed.mentions.push(this.normalizeUserId(qq));
      }
      return;
    }

    if (type === 'reply') {
      const id = this.stringifySegmentId(data, 'id', { allowInternalBotMessageId: true });
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
        url: this.normalizeMediaUrl(this.stringifySegmentString(data, 'url')),
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

  private stringifySegmentId(
    data: Record<string, unknown> | undefined,
    key: string,
    options: { allowAll?: boolean; allowInternalBotMessageId?: boolean } = {},
  ): string {
    const value = data?.[key];
    if (this.isPositiveIntegerId(value)) {
      return String(value);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return '';
      }

      if (/^\d+$/.test(trimmed) || /^qq-\d+$/.test(trimmed)) {
        return trimmed;
      }

      if (options.allowInternalBotMessageId && /^qq-bot-\d+$/.test(trimmed)) {
        return trimmed;
      }

      if (options.allowAll && (trimmed === 'all' || trimmed === 'qq-all')) {
        return trimmed;
      }
    }

    return '';
  }

  private stringifySegmentString(data: Record<string, unknown> | undefined, key: string): string {
    const value = data?.[key];
    return typeof value === 'string' ? value : '';
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
    if (this.transport === 'ws') {
      return this.callWsApi(action, params);
    }

    return this.callHttpApi(action, params);
  }

  private async callHttpApi(action: string, params: Record<string, unknown>): Promise<unknown> {
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
      this.assertApiOk(result);

      this.lastError = undefined;
      return result.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown OneBot API error';
      const redactedMessage = this.redactDiagnosticText(message);
      this.lastError = redactedMessage;
      throw new Error(redactedMessage);
    }
  }

  private async callWsApi(action: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || !this.wsConnected) {
      throw new Error('OneBot WebSocket is not connected');
    }

    const echo = this.generateEcho(action);
    const responsePromise = new Promise<OneBotApiResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingWsRequests.delete(echo);
        reject(new Error(`OneBot WebSocket API timeout: ${action}`));
      }, 30000);
      this.pendingWsRequests.set(echo, { resolve, reject, timeout });
    });

    try {
      socket.send(JSON.stringify({ action, params, echo }));
    } catch (error) {
      const pending = this.pendingWsRequests.get(echo);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingWsRequests.delete(echo);
      }
      const message = error instanceof Error
        ? error.message
        : `OneBot WebSocket API send failed: ${action}`;
      const redactedMessage = this.redactDiagnosticText(message);
      this.lastError = redactedMessage;
      throw new Error(redactedMessage);
    }

    try {
      const result = await responsePromise;
      this.assertApiOk(result);
      this.lastError = undefined;
      return result.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown OneBot WebSocket API error';
      const redactedMessage = this.redactDiagnosticText(message);
      this.lastError = redactedMessage;
      throw new Error(redactedMessage);
    }
  }

  private assertApiOk(result: unknown): asserts result is OneBotApiResponse {
    if (!this.isRecord(result)) {
      throw new Error('OneBot API error: Unknown error');
    }

    if (result.status !== 'ok' && result.retcode !== 0) {
      const message = this.extractApiErrorMessage(result);
      throw new Error(`OneBot API error: ${message}`);
    }
  }

  private extractApiErrorMessage(result: OneBotApiResponse): string {
    if (typeof result.message === 'string') {
      return this.redactDiagnosticText(result.message);
    }
    if (typeof result.wording === 'string') {
      return this.redactDiagnosticText(result.wording);
    }
    return 'Unknown error';
  }

  private buildActionUrl(action: string): string {
    const baseUrl = this.config.httpUrl.endsWith('/')
      ? this.config.httpUrl
      : `${this.config.httpUrl}/`;
    return new URL(action, baseUrl).toString();
  }

  private openWebSocket(): void {
    if (this.transport !== 'ws' || !this.ready || this.socket) {
      return;
    }

    try {
      const socket = this.webSocketFactory(this.buildWebSocketUrl());
      this.socket = socket;
      this.wsConnected = false;

      socket.addEventListener('open', () => {
        this.wsConnected = true;
        this.lastError = undefined;
      });
      socket.addEventListener('message', (event) => this.handleWebSocketMessage(event));
      socket.addEventListener('error', (event) => this.handleWebSocketError(event));
      socket.addEventListener('close', (event) => this.handleWebSocketClose(event));
    } catch (error) {
      this.lastError = this.toRedactedDiagnosticMessage(error, 'Failed to open OneBot WebSocket');
      this.emitError(error);
      this.scheduleReconnect();
    }
  }

  private closeWebSocket(): void {
    this.wsConnected = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, 'LetheBot shutdown');
      } catch (error) {
        this.lastError = this.toRedactedDiagnosticMessage(error, 'Failed to close OneBot WebSocket');
      }
    }
    this.rejectAllPendingWsRequests(new Error('OneBot WebSocket closed'));
  }

  private buildWebSocketUrl(): string {
    const url = new URL(this.config.wsUrl ?? 'ws://localhost:3001/');
    if (this.config.token) {
      url.searchParams.set('access_token', this.config.token);
    }
    return url.toString();
  }

  private handleWebSocketMessage(event: OneBotWebSocketEvent): void {
    const text = this.websocketPayloadToString(event.data);
    if (!text) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.lastError = this.toRedactedDiagnosticMessage(error, 'Invalid OneBot WebSocket JSON');
      this.emitError(error);
      return;
    }

    if (!this.isRecord(parsed)) {
      return;
    }

    if (typeof parsed.post_type === 'string') {
      this.handleHttpEvent(parsed as unknown as OneBotMessage);
      return;
    }

    if (parsed.echo !== undefined && this.resolvePendingWsResponse(parsed)) {
      return;
    }
  }

  private resolvePendingWsResponse(packet: Record<string, unknown>): boolean {
    const echo = String(packet.echo);
    const pending = this.pendingWsRequests.get(echo);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pendingWsRequests.delete(echo);
    pending.resolve(packet as OneBotApiResponse);
    return true;
  }

  private handleWebSocketError(event: OneBotWebSocketEvent): void {
    const error = event.error instanceof Error
      ? event.error
      : new Error('OneBot WebSocket error');
    this.lastError = this.redactDiagnosticText(error.message);
    this.emitError(error);
  }

  private handleWebSocketClose(event: OneBotWebSocketEvent): void {
    this.wsConnected = false;
    this.socket = null;
    this.rejectAllPendingWsRequests(new Error('OneBot WebSocket closed'));
    const reason = typeof event.reason === 'string' && event.reason
      ? event.reason
      : 'OneBot WebSocket closed';
    this.lastError = this.redactDiagnosticText(reason);

    if (!this.manuallyClosed && this.ready) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.transport !== 'ws' || this.manuallyClosed || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openWebSocket();
    }, this.wsReconnectIntervalMs);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private rejectAllPendingWsRequests(error: Error): void {
    for (const [echo, pending] of this.pendingWsRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingWsRequests.delete(echo);
    }
  }

  private websocketPayloadToString(payload: unknown): string {
    if (typeof payload === 'string') {
      return payload;
    }
    if (Buffer.isBuffer(payload)) {
      return payload.toString('utf8');
    }
    if (payload instanceof ArrayBuffer) {
      return Buffer.from(payload).toString('utf8');
    }
    if (ArrayBuffer.isView(payload)) {
      return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
    }
    return '';
  }

  private generateEcho(action: string): string {
    return `lethebot-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private emitError(error: unknown): void {
    if (this.listenerCount('error') === 0) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.emit('error', new Error(this.redactDiagnosticText(message)));
  }

  private toRedactedDiagnosticMessage(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : fallback;
    return this.redactDiagnosticText(message);
  }

  private formatRedactedConsoleDiagnostic(error: unknown, fallback: string): string {
    const message = this.toRedactedDiagnosticMessage(error, fallback);
    if (!(error instanceof Error)) {
      return message;
    }

    return JSON.stringify({
      name: this.redactDiagnosticText(error.name || 'Error'),
      message,
      ...(error.stack ? { stack: '[REDACTED:stack]' } : {}),
    });
  }

  private extractSentMessageId(data: unknown): string {
    if (this.isRecord(data)) {
      const messageId = this.normalizeOutboundMessageId(data.message_id);
      if (messageId) {
        return messageId;
      }
    }

    return this.createSentMessageId();
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

  private validateSnowLumaSignature(signature: string, rawBody: string, token: string): boolean {
    const expected = `sha1=${createHmac('sha1', token).update(rawBody).digest('hex')}`;
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length
      && timingSafeEqual(actualBuffer, expectedBuffer);
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

  private normalizeTopLevelId(value: unknown): number | string | undefined {
    if (this.isPositiveIntegerId(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return undefined;
      }

      if (/^\d+$/.test(trimmed) || /^qq-\d+$/.test(trimmed) || /^qq-group-\d+$/.test(trimmed)) {
        return trimmed;
      }
    }

    return undefined;
  }

  private normalizeOutboundMessageId(value: unknown): string | undefined {
    if (this.isPositiveIntegerId(value)) {
      return this.normalizeMessageId(value);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed) || /^qq-\d+$/.test(trimmed)) {
        return this.normalizeMessageId(trimmed);
      }
    }

    return undefined;
  }

  private isPositiveIntegerId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  }

  private createLocalMessageId(): string {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private createSentMessageId(): string {
    return `qq-sent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private normalizeTimestamp(value: unknown): Date {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return new Date();
    }

    const milliseconds = value * 1000;
    if (!Number.isFinite(milliseconds)) {
      return new Date();
    }

    const timestamp = new Date(milliseconds);
    return Number.isFinite(timestamp.getTime()) ? timestamp : new Date();
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
      throw new Error(`Invalid OneBot ${label}: expected ${prefix}<positive-safe-integer-id>`);
    }

    const numeric = Number(stripped);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
      throw new Error(`Invalid OneBot ${label}: expected ${prefix}<positive-safe-integer-id>`);
    }

    return numeric;
  }

  private normalizeSenderRole(role: unknown): 'member' | 'admin' | 'owner' | undefined {
    if (role === 'member' || role === 'admin' || role === 'owner') {
      return role;
    }
    return undefined;
  }

  private isSupportedMessageSubtype(
    messageType: 'private' | 'group',
    subtype: unknown,
  ): boolean {
    if (subtype === undefined || subtype === null) {
      return true;
    }

    if (typeof subtype !== 'string') {
      return false;
    }

    const normalized = subtype.trim();
    if (!normalized) {
      return false;
    }

    if (messageType === 'private') {
      return ['friend', 'group', 'group_self', 'other'].includes(normalized);
    }

    return ['normal', 'anonymous', 'notice'].includes(normalized);
  }

  private normalizeOptional(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private normalizeDisplayMetadata(value: unknown): string | undefined {
    const normalized = this.normalizeOptional(value);
    return normalized ? this.redactDiagnosticText(normalized) : undefined;
  }

  private normalizeMediaUrl(value: unknown): string | undefined {
    const normalized = this.normalizeOptional(value);
    if (!normalized) {
      return undefined;
    }

    return this.redactDiagnosticText(normalized) === normalized ? normalized : undefined;
  }

  private redactDiagnosticText(value: string): string {
    const platformRedacted = this.redactPlatformIdentifiers(value);
    const secretRedacted = redactSecretsInText(platformRedacted).text;
    const redacted = this.redactPlatformIdentifiers(secretRedacted);
    const platformMarkerLost =
      platformRedacted.includes('[REDACTED:platform_id]')
      && !redacted.includes('[REDACTED:platform_id]');

    return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
  }

  private redactPlatformIdentifiers(value: string): string {
    return value
      .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
      .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
  }

  private buildCapabilities(): GatewayCapabilities {
    return {
      platform: 'qq',
      reactions: { emojiLike: false, faceMessage: true },
      foldedForward: { groupForward: true, privateForward: true, customNode: true },
      platformAdmin: { kick: false, mute: false, setGroupCard: false },
    };
  }

}
