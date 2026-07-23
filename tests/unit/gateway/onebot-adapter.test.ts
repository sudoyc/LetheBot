import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { format } from 'node:util';
import {
  OneBotAdapter,
  type OneBotMessage,
  type OneBotWebSocketEvent,
  type OneBotWebSocketLike,
} from '../../../src/gateway/onebot-adapter.js';
import type { ChatMessageReceived } from '../../../src/types/events.js';

class FakeWebSocket implements OneBotWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly url: string;
  closeError: Error | undefined;
  sendError: Error | undefined;
  private readonly listeners = new Map<string, Array<(event: OneBotWebSocketEvent) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.sendError) {
      throw this.sendError;
    }
    this.sent.push(data);
  }

  close(_code?: number, reason = 'closed'): void {
    if (this.closeError) {
      throw this.closeError;
    }
    this.readyState = 3;
    this.emit('close', { reason });
  }

  addEventListener(
    event: 'open' | 'message' | 'error' | 'close',
    handler: (event: OneBotWebSocketEvent) => void,
  ): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  simulateMessage(data: unknown): void {
    this.emit('message', {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    });
  }

  simulateError(error: Error): void {
    this.emit('error', { error });
  }

  simulateClose(reason: string): void {
    this.readyState = 3;
    this.emit('close', { reason });
  }

  private emit(event: string, payload: OneBotWebSocketEvent): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(payload);
    }
  }
}

class DeferredCloseFakeWebSocket extends FakeWebSocket {
  override close(): void {
    this.readyState = 3;
  }
}

describe('OneBotAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports only currently implemented OneBot gateway capabilities', () => {
    const adapter = new OneBotAdapter({ httpUrl: 'http://localhost:3000' });

    expect(adapter.getCapabilities()).toEqual({
      platform: 'qq',
      reactions: { emojiLike: false, faceMessage: true },
      foldedForward: { groupForward: false, privateForward: false, customNode: false },
      platformAdmin: { kick: false, mute: false, setGroupCard: false },
    });
  });

  it('runs readiness callbacks only after the configured transport is ready', async () => {
    const httpAdapter = new OneBotAdapter({
      transport: 'http',
      httpUrl: 'http://localhost:3000',
    });
    let httpReadyCalls = 0;
    httpAdapter.whenReady(() => {
      httpReadyCalls += 1;
    });
    expect(httpReadyCalls).toBe(0);
    await httpAdapter.start();
    expect(httpReadyCalls).toBe(1);
    httpAdapter.whenReady(() => {
      httpReadyCalls += 1;
    });
    expect(httpReadyCalls).toBe(2);
    await httpAdapter.stop();

    const sockets: FakeWebSocket[] = [];
    const wsAdapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    let wsReadyCalls = 0;
    wsAdapter.whenReady(() => {
      wsReadyCalls += 1;
    });
    await wsAdapter.start();
    expect(wsReadyCalls).toBe(0);
    sockets[0]?.simulateOpen();
    expect(wsReadyCalls).toBe(1);
    await wsAdapter.stop();
  });

  it('validates reverse HTTP events with the configured bearer token', () => {
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      token: 'event-token',
    });

    expect(adapter.validateHttpEventAuth({ authorization: 'Bearer event-token' })).toBe(true);
    expect(adapter.validateHttpEventAuth({ authorization: 'Bearer wrong-token' })).toBe(false);
    expect(adapter.validateHttpEventAuth({})).toBe(false);
  });

  it('validates SnowLuma reverse HTTP events with X-Signature HMAC', () => {
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      token: 'event-token',
    });
    const body = JSON.stringify({ post_type: 'message', message_type: 'private' });
    const signature = `sha1=${createHmac('sha1', 'event-token').update(body).digest('hex')}`;

    expect(adapter.validateHttpEventAuth({ 'x-signature': signature }, body)).toBe(true);
    expect(adapter.validateHttpEventAuth({ 'x-signature': 'sha1=bad' }, body)).toBe(false);
  });

  it('allows reverse HTTP events when no token is configured', () => {
    const adapter = new OneBotAdapter({ httpUrl: 'http://localhost:3000' });

    expect(adapter.validateHttpEventAuth({})).toBe(true);
  });

  it('ignores non-object reverse HTTP payloads without diagnostic side effects', () => {
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      botId: '3889000770',
    });
    const events: ChatMessageReceived[] = [];
    adapter.onEvent((event) => events.push(event));

    const payloads: unknown[] = [
      null,
      'token=sk-non-object-unit-secret qq-8123456789',
      8123456789,
      true,
      ['token=sk-non-object-unit-secret', 'qq-8123456789'],
    ];

    for (const payload of payloads) {
      expect(adapter.handleHttpEvent(payload)).toBe(false);
    }

    expect(events).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
  });

  it('ignores unsupported or malformed OneBot message subtypes without diagnostic side effects', () => {
    const rawSecret = 'sk-message-subtype-unit-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456799';
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      botId: '3889000770',
    });
    const events: ChatMessageReceived[] = [];
    adapter.onEvent((event) => events.push(event));

    const payloads: Array<Record<string, unknown>> = [
      {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'guild',
        message_id: 1,
        user_id: 10001,
        group_id: 20001,
        message: `[CQ:at,qq=3889000770] token=${rawSecret} target=${rawPlatformId}`,
      },
      {
        post_type: 'message',
        message_type: 'private',
        sub_type: { token: rawSecret, platform: rawPlatformId },
        message_id: 2,
        user_id: 10002,
        message: `token=${rawSecret}`,
      },
      {
        post_type: 'message',
        message_type: 'group',
        sub_type: 8123456799,
        message_id: 3,
        user_id: 10003,
        group_id: 20002,
        message: `target=${rawPlatformId}`,
      },
    ];

    for (const payload of payloads) {
      expect(adapter.handleHttpEvent(payload)).toBe(false);
    }

    expect(events).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(JSON.stringify(adapter.getReadiness())).not.toContain(rawSecret);
    expect(JSON.stringify(adapter.getReadiness())).not.toContain(rawPlatformId);
  });

  it('parses target bot CQ mentions exactly when bot QQ id is configured', () => {
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      botId: '3889000770',
    });
    const events: ChatMessageReceived[] = [];
    adapter.onEvent((event) => events.push(event));

    const nonTarget: OneBotMessage = {
      post_type: 'message',
      message_type: 'group',
      message_id: 1,
      user_id: 10001,
      group_id: 20001,
      message: '[CQ:at,qq=111111] 不是叫你',
      raw_message: '[CQ:at,qq=111111] 不是叫你',
      sender: { user_id: 10001, role: 'member' },
      time: 1782970000,
    };
    const target: OneBotMessage = {
      ...nonTarget,
      message_id: 2,
      message: '[CQ:at,qq=3889000770] 你好',
      raw_message: '[CQ:at,qq=3889000770] 你好',
    };

    adapter.handleHttpEvent(nonTarget);
    adapter.handleHttpEvent(target);

    expect(events).toHaveLength(2);
    const first = events[0];
    const second = events[1];
    if (!first || !second) {
      throw new Error('Expected parsed OneBot events');
    }

    expect(first.message.mentions).toEqual(['qq-111111']);
    expect(first.message.mentionsBot).toBe(false);
    expect(first.ingress).toEqual({ transport: 'http', platformEventId: 'qq-1' });
    expect(second.ingress).toEqual({ transport: 'http', platformEventId: 'qq-2' });
    expect(first.message.content.text).toBe('不是叫你');
    expect(second.message.mentions).toEqual(['qq-3889000770']);
    expect(second.message.mentionsBot).toBe(true);
    expect(second.message.content.text).toBe('你好');
  });

  it('does not treat a group-id namespace as a stable message event id', () => {
    const adapter = new OneBotAdapter({ httpUrl: 'http://localhost:3000' });
    const events: ChatMessageReceived[] = [];
    adapter.onEvent((event) => events.push(event));

    expect(adapter.dispatchInboundEvent({
      post_type: 'message',
      message_type: 'private',
      message_id: 'qq-group-12345',
      user_id: 12346,
      message: 'wrong namespace',
      raw_message: 'wrong namespace',
      sender: { user_id: 12346, nickname: 'Namespace Test' },
      time: 1782970000,
    }, 'http')).toBe('accepted');

    expect(events).toHaveLength(1);
    expect(events[0]?.message.messageId).toMatch(/^qq-local-/);
    expect(events[0]?.ingress).toEqual({ transport: 'http' });
  });

  it('parses sender role, group card, quote, and media from OneBot segments', () => {
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      botId: '3889000770',
    });
    let parsed: ChatMessageReceived | undefined;
    adapter.onEvent((event) => {
      parsed = event;
    });

    adapter.handleHttpEvent({
      post_type: 'message',
      message_type: 'group',
      message_id: 42,
      user_id: 12345,
      group_id: 67890,
      message: [
        { type: 'reply', data: { id: 41 } },
        { type: 'at', data: { qq: '3889000770' } },
        { type: 'text', data: { text: ' 看这个' } },
        { type: 'image', data: { url: 'https://example.test/a.png' } },
      ],
      sender: {
        user_id: 12345,
        nickname: 'Nick',
        card: 'Group Card',
        role: 'admin',
      },
      time: 1782970000,
    });

    if (!parsed) {
      throw new Error('Expected parsed OneBot event');
    }

    expect(parsed.message.conversationType).toBe('group');
    expect(parsed.message.groupId).toBe('qq-group-67890');
    expect(parsed.message.senderRole).toBe('admin');
    expect(parsed.message.senderCard).toBe('Group Card');
    expect(parsed.message.senderDisplayName).toBe('Group Card');
    expect(parsed.message.mentionsBot).toBe(true);
    expect(parsed.message.replyToMessageId).toBe('qq-41');
    expect(parsed.message.content.quote?.messageId).toBe('qq-41');
    expect(parsed.message.content.media).toEqual([
      { type: 'image', url: 'https://example.test/a.png' },
    ]);
    expect(parsed.message.content.text).toBe('看这个');
  });

  it('handles malformed top-level message content without diagnostic side effects', () => {
    const rawSecret = 'sk-malformed-message-content-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456794';
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      botId: '3889000770',
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    const malformedPayloads: Array<Partial<OneBotMessage>> = [
      {
        message: { token: rawSecret, target: rawPlatformId } as unknown as OneBotMessage['message'],
        raw_message: { text: rawPlatformId } as unknown as string,
      },
      {
        message: 8123456794 as unknown as OneBotMessage['message'],
        raw_message: [`token=${rawSecret}`] as unknown as string,
      },
      {
        message: null as unknown as OneBotMessage['message'],
        raw_message: true as unknown as string,
      },
      {
        raw_message: { token: rawSecret, target: rawPlatformId } as unknown as string,
      },
    ];

    for (const [index, payload] of malformedPayloads.entries()) {
      expect(adapter.handleHttpEvent({
        post_type: 'message',
        message_type: 'group',
        message_id: 70 + index,
        user_id: 12345,
        group_id: 67890,
        sender: {
          user_id: 12345,
          nickname: 'Nick',
          role: 'member',
        },
        time: 1782970000,
        ...payload,
      } as unknown as OneBotMessage)).toBe(true);
    }

    expect(events).toHaveLength(malformedPayloads.length);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    for (const event of events) {
      expect(event.message.content.text).toBe('');
      expect(event.message.mentions).toEqual([]);
      expect(event.message.mentionsBot).toBe(false);
      expect(event.message.content.media).toEqual([]);
      expect(event.message.content.quote).toBeUndefined();
      expect(event.message.replyToMessageId).toBeUndefined();
    }

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(rawSecret);
    expect(serializedEvents).not.toContain(rawPlatformId);
    expect(serializedEvents).not.toContain('8123456794');
  });

  it('redacts event-handler failure diagnostics before direct console output', () => {
    const rawSecret = 'sk-onebot-handler-console-secret-should-not-leak';
    const rawPlatformId = 'qq-1234567890';
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      botId: '3889000770',
    });
    const thrown = new Error(`handler failed api_key=${rawSecret} target=${rawPlatformId}`);
    thrown.stack = [
      `Error: handler failed api_key=${rawSecret}`,
      '    at handle (/home/operator/LetheBot/src/gateway/onebot-adapter.ts:229:7)',
      '    at dependency (/home/operator/LetheBot/node_modules/example/index.js:1:1)',
      `    at platform (${rawPlatformId})`,
    ].join('\n');
    const emittedErrors: Error[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    adapter.onEvent(() => {
      throw thrown;
    });
    adapter.on('error', (error) => {
      emittedErrors.push(error instanceof Error ? error : new Error(String(error)));
    });

    try {
      expect(adapter.handleHttpEvent({
        post_type: 'message',
        message_type: 'private',
        message_id: 90,
        user_id: 1234567890,
        message: 'hello',
        raw_message: 'hello',
        sender: { user_id: 1234567890 },
        time: 1782970000,
      })).toBe(false);

      expect(emittedErrors).toHaveLength(1);
      expect(emittedErrors[0]?.message).toContain('[REDACTED:api_key_assignment]');
      expect(emittedErrors[0]?.message).toContain('[REDACTED:platform_id]');
      expect(emittedErrors[0]?.message).not.toContain(rawSecret);
      expect(emittedErrors[0]?.message).not.toContain(rawPlatformId);

      const diagnostic = consoleError.mock.calls.map((call) => format(...call)).join('\n');
      expect(diagnostic).toContain('Failed to handle OneBot event:');
      expect(diagnostic).toContain('[REDACTED:api_key_assignment]');
      expect(diagnostic).toContain('[REDACTED:platform_id]');
      expect(diagnostic).toContain('[REDACTED:stack]');
      expect(diagnostic).not.toContain(rawSecret);
      expect(diagnostic).not.toContain(rawPlatformId);
      expect(diagnostic).not.toContain('/home/operator');
      expect(diagnostic).not.toContain('src/gateway/onebot-adapter.ts');
      expect(diagnostic).not.toContain('node_modules');
      expect(diagnostic).not.toContain('    at ');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('preserves assignment-shaped adjacent event-handler diagnostic markers', () => {
    const rawAssignment = 'api_key=sk-onebot-handler-console-secret-qq-1234567890';
    const rawSecret = 'sk-onebot-handler-console-secret-qq-1234567890';
    const rawPlatformId = 'qq-1234567890';
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      botId: '3889000770',
    });
    const thrown = new Error(`handler failed ${rawAssignment}`);
    thrown.stack = [
      `Error: handler failed ${rawAssignment}`,
      '    at handle (/home/operator/LetheBot/src/gateway/onebot-adapter.ts:229:7)',
      '    at dependency (/home/operator/LetheBot/node_modules/example/index.js:1:1)',
    ].join('\n');
    const emittedErrors: Error[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    adapter.onEvent(() => {
      throw thrown;
    });
    adapter.on('error', (error) => {
      emittedErrors.push(error instanceof Error ? error : new Error(String(error)));
    });

    try {
      expect(adapter.handleHttpEvent({
        post_type: 'message',
        message_type: 'private',
        message_id: 90,
        user_id: 1234567890,
        message: 'hello',
        raw_message: 'hello',
        sender: { user_id: 1234567890 },
        time: 1782970000,
      })).toBe(false);

      expect(emittedErrors).toHaveLength(1);
      expect(emittedErrors[0]?.message).toContain('[REDACTED:api_key_assignment]');
      expect(emittedErrors[0]?.message).toContain('[REDACTED:platform_id]');
      expect(emittedErrors[0]?.message).not.toContain(rawAssignment);
      expect(emittedErrors[0]?.message).not.toContain(rawSecret);
      expect(emittedErrors[0]?.message).not.toContain(rawPlatformId);

      const diagnostic = consoleError.mock.calls.map((call) => format(...call)).join('\n');
      expect(diagnostic).toContain('Failed to handle OneBot event:');
      expect(diagnostic).toContain('[REDACTED:api_key_assignment]');
      expect(diagnostic).toContain('[REDACTED:platform_id]');
      expect(diagnostic).toContain('[REDACTED:stack]');
      expect(diagnostic).not.toContain(rawAssignment);
      expect(diagnostic).not.toContain(rawSecret);
      expect(diagnostic).not.toContain(rawPlatformId);
      expect(diagnostic).not.toContain('/home/operator');
      expect(diagnostic).not.toContain('src/gateway/onebot-adapter.ts');
      expect(diagnostic).not.toContain('node_modules');
      expect(diagnostic).not.toContain('    at ');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('accepts only finite numeric OneBot timestamps and falls back for malformed values', () => {
    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000',
      botId: '3889000770',
    });
    const events: ChatMessageReceived[] = [];
    adapter.onEvent((event) => events.push(event));

    adapter.handleHttpEvent({
      post_type: 'message',
      message_type: 'group',
      message_id: 50,
      user_id: 12345,
      group_id: 67890,
      message: 'valid timestamp',
      sender: {
        user_id: 12345,
        nickname: 'Nick',
        role: 'member',
      },
      time: 1782970000,
    });

    const fallbackStart = Date.now();
    const malformedTimes: unknown[] = [
      '1782970000',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      { value: 1782970000 },
    ];

    for (const [index, time] of malformedTimes.entries()) {
      adapter.handleHttpEvent({
        post_type: 'message',
        message_type: 'group',
        message_id: 51 + index,
        user_id: 12345,
        group_id: 67890,
        message: `malformed timestamp ${index}`,
        sender: {
          user_id: 12345,
          nickname: 'Nick',
          role: 'member',
        },
        time,
      } as unknown as OneBotMessage);
    }
    const fallbackEnd = Date.now();

    expect(events).toHaveLength(1 + malformedTimes.length);
    expect(events[0]?.timestamp.getTime()).toBe(1782970000000);
    for (const event of events.slice(1)) {
      expect(Number.isFinite(event.timestamp.getTime())).toBe(true);
      expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(fallbackStart);
      expect(event.timestamp.getTime()).toBeLessThanOrEqual(fallbackEnd);
    }
  });

  it('sends private and group replies through the unified sendMessage path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', data: { message_id: 321 } }),
    });
    global.fetch = fetchMock;

    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000/api',
      token: 'api-token',
    });

    const privateMessageId = await adapter.sendMessage(
      { conversationId: 'private:qq-10001', conversationType: 'private' },
      { text: '私聊回复' },
    );
    const groupMessageId = await adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊回复' },
    );

    expect(privateMessageId).toBe('qq-321');
    expect(groupMessageId).toBe('qq-321');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3000/api/send_private_msg',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer api-token' }),
        body: JSON.stringify({ user_id: 10001, message: '私聊回复' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3000/api/send_group_msg',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer api-token' }),
        body: JSON.stringify({ group_id: 20001, message: '群聊回复' }),
      }),
    );
  });

  it('falls back for secret-like outbound OneBot message_id values', async () => {
    const rawSecret = 'sk-outbound-message-id-secret-should-not-persist';
    const rawPlatformId = 'qq-123456789';
    const malformedMessageId = `sent-${rawPlatformId}-${rawSecret}`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', data: { message_id: malformedMessageId } }),
    });
    global.fetch = fetchMock;

    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000/api',
    });

    const messageId = await adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊回复' },
    );

    expect(messageId).toMatch(/^qq-sent-\d+-[a-z0-9]+$/);
    expect(messageId).not.toContain(malformedMessageId);
    expect(messageId).not.toContain(rawSecret);
    expect(messageId).not.toContain(rawPlatformId);
  });

  it('falls back for structured malformed outbound OneBot message_id values', async () => {
    const rawSecret = 'sk-outbound-structured-message-id-secret';
    const rawPlatformId = 'qq-123456790';
    const malformedMessageIds: unknown[] = [
      { value: `sent-${rawPlatformId}-${rawSecret}` },
      [`sent-${rawPlatformId}`],
      false,
      null,
    ];
    const fetchMock = vi.fn();
    for (const malformedMessageId of malformedMessageIds) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok', data: { message_id: malformedMessageId } }),
      });
    }
    global.fetch = fetchMock;

    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000/api',
    });

    for (const malformedMessageId of malformedMessageIds) {
      const messageId = await adapter.sendMessage(
        { conversationId: 'qq-group-20001', conversationType: 'group' },
        { text: '群聊回复' },
      );

      expect(messageId).toMatch(/^qq-sent-\d+-[a-z0-9]+$/);
      expect(messageId).not.toContain(JSON.stringify(malformedMessageId));
      expect(messageId).not.toContain(rawSecret);
      expect(messageId).not.toContain(rawPlatformId);
    }

    expect(fetchMock).toHaveBeenCalledTimes(malformedMessageIds.length);
    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
  });

  it('falls back for malformed outbound OneBot response data containers', async () => {
    const rawSecret = 'sk-outbound-malformed-data-secret';
    const rawPlatformId = 'qq-123456791';
    const malformedDataValues: unknown[] = [
      `sent-${rawPlatformId}-${rawSecret}`,
      [`sent-${rawPlatformId}`],
      true,
      null,
    ];
    const fetchMock = vi.fn();
    for (const malformedDataValue of malformedDataValues) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok', data: malformedDataValue }),
      });
    }
    global.fetch = fetchMock;

    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000/api',
    });

    for (const malformedDataValue of malformedDataValues) {
      const messageId = await adapter.sendMessage(
        { conversationId: 'qq-group-20001', conversationType: 'group' },
        { text: '群聊回复' },
      );

      expect(messageId).toMatch(/^qq-sent-\d+-[a-z0-9]+$/);
      expect(messageId).not.toContain(JSON.stringify(malformedDataValue));
      expect(messageId).not.toContain(rawSecret);
      expect(messageId).not.toContain(rawPlatformId);
    }

    expect(fetchMock).toHaveBeenCalledTimes(malformedDataValues.length);
    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
  });

  it('falls back for non-positive or fractional outbound OneBot message_id values', async () => {
    const malformedMessageIds = [-321, 0, 321.5];
    const fetchMock = vi.fn();
    for (const messageId of malformedMessageIds) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok', data: { message_id: messageId } }),
      });
    }
    global.fetch = fetchMock;

    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000/api',
    });

    for (const malformedMessageId of malformedMessageIds) {
      const messageId = await adapter.sendMessage(
        { conversationId: 'qq-group-20001', conversationType: 'group' },
        { text: '群聊回复' },
      );

      expect(messageId).toMatch(/^qq-sent-\d+-[a-z0-9]+$/);
      expect(messageId).not.toBe(`qq-${malformedMessageId}`);
      expect(messageId).not.toContain('qq--');
      expect(messageId).not.toContain('.');
    }
  });

  it('rejects unsafe outbound OneBot target identifiers before sending', async () => {
    const unsafeId = '9007199254740993';
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000/api',
    });

    await expect(adapter.sendMessage(
      { conversationId: `private:qq-${unsafeId}`, conversationType: 'private' },
      { text: '私聊回复' },
    )).rejects.toThrow('Invalid OneBot userId: expected qq-<positive-safe-integer-id>');
    await expect(adapter.sendMessage(
      { conversationId: 'private:qq-0', conversationType: 'private' },
      { text: '私聊回复' },
    )).rejects.toThrow('Invalid OneBot userId: expected qq-<positive-safe-integer-id>');
    await expect(adapter.sendMessage(
      { conversationId: `qq-group-${unsafeId}`, conversationType: 'group' },
      { text: '群聊回复' },
    )).rejects.toThrow('Invalid OneBot groupId: expected qq-group-<positive-safe-integer-id>');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(adapter.getReadiness())).not.toContain(unsafeId);
  });

  it('rejects unsafe outbound OneBot WebSocket target identifiers before sending', async () => {
    const unsafeId = '9007199254740993';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    await expect(adapter.sendMessage(
      { conversationId: `private:qq-${unsafeId}`, conversationType: 'private' },
      { text: '私聊回复' },
    )).rejects.toThrow('Invalid OneBot userId: expected qq-<positive-safe-integer-id>');
    await expect(adapter.sendMessage(
      { conversationId: `qq-group-${unsafeId}`, conversationType: 'group' },
      { text: '群聊回复' },
    )).rejects.toThrow('Invalid OneBot groupId: expected qq-group-<positive-safe-integer-id>');

    expect(socket.sent).toHaveLength(0);
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);
    expect(JSON.stringify(adapter.getReadiness())).not.toContain(unsafeId);

    await adapter.stop();
  });

  it('redacts secret-like OneBot API error diagnostics before throwing or readiness exposure', async () => {
    const rawSecret = 'sk-onebot-api-error-secret-should-not-leak';
    const rawPlatformId = 'qq-123456789';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'failed',
        retcode: 1404,
        message: `api_key=${rawSecret} target=${rawPlatformId}`,
      }),
    });
    global.fetch = fetchMock;

    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000/api',
    });

    await expect(adapter.sendMessage(
      { conversationId: 'private:qq-10001', conversationType: 'private' },
      { text: '私聊回复' },
    )).rejects.toThrow('[REDACTED:');

    const readiness = adapter.getReadiness();
    expect(readiness.lastError).toContain('[REDACTED:');

    const serialized = JSON.stringify({ lastError: readiness.lastError });
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawPlatformId);
    expect(serialized).not.toContain('123456789');
  });

  it('falls back for structured malformed OneBot API error diagnostic containers', async () => {
    const rawSecret = 'sk-onebot-api-structured-error-secret';
    const rawPlatformId = 'qq-123456792';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'failed',
        retcode: 1404,
        message: { value: `api_key=${rawSecret}` },
        wording: [`target=${rawPlatformId}`],
      }),
    });
    global.fetch = fetchMock;

    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000/api',
    });

    await expect(adapter.sendMessage(
      { conversationId: 'private:qq-10001', conversationType: 'private' },
      { text: '私聊回复' },
    )).rejects.toThrow('Unknown error');

    const readiness = adapter.getReadiness();
    expect(readiness.lastError).toContain('Unknown error');

    const serialized = JSON.stringify({ lastError: readiness.lastError });
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawPlatformId);
    expect(serialized).not.toContain('123456792');
    expect(serialized).not.toContain('[object Object]');
  });

  it('falls back for malformed top-level OneBot API response containers', async () => {
    const rawSecret = 'sk-onebot-api-top-level-container-secret';
    const rawPlatformId = 'qq-123456794';
    const malformedResponses: unknown[] = [
      `api_key=${rawSecret} target=${rawPlatformId}`,
      [{ message: `api_key=${rawSecret}` }, `target=${rawPlatformId}`],
      true,
      null,
    ];
    const fetchMock = vi.fn();
    for (const response of malformedResponses) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => response,
      });
    }
    global.fetch = fetchMock;

    const adapter = new OneBotAdapter({
      httpUrl: 'http://localhost:3000/api',
    });

    for (const _response of malformedResponses) {
      await expect(adapter.sendMessage(
        { conversationId: 'private:qq-10001', conversationType: 'private' },
        { text: '私聊回复' },
      )).rejects.toThrow('Unknown error');

      const serialized = JSON.stringify({ lastError: adapter.getReadiness().lastError });
      expect(serialized).not.toContain(rawSecret);
      expect(serialized).not.toContain(rawPlatformId);
      expect(serialized).not.toContain('123456794');
      expect(serialized).not.toContain('[object Object]');
      expect(serialized).not.toContain('Cannot read properties');
    }

    expect(fetchMock).toHaveBeenCalledTimes(malformedResponses.length);
  });

  it('redacts secret-like WebSocket OneBot API error diagnostics before throwing or readiness exposure', async () => {
    const rawSecret = 'sk-onebot-ws-error-secret-should-not-leak';
    const rawPlatformId = 'qq-123456789';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    socket.simulateMessage({
      status: 'failed',
      retcode: 1404,
      wording: `api_key=${rawSecret} target=${rawPlatformId}`,
      echo: request.echo,
    });

    await expect(pending).rejects.toThrow('[REDACTED:');

    const readiness = adapter.getReadiness();
    expect(readiness.lastError).toContain('[REDACTED:');

    const serialized = JSON.stringify({ lastError: readiness.lastError });
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawPlatformId);
    expect(serialized).not.toContain('123456789');

    await adapter.stop();
  });

  it('falls back for structured malformed WebSocket OneBot API error diagnostic containers', async () => {
    const rawSecret = 'sk-onebot-ws-structured-error-secret';
    const rawPlatformId = 'qq-123456793';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    socket.simulateMessage({
      status: 'failed',
      retcode: 1404,
      message: { value: `api_key=${rawSecret}` },
      wording: [`target=${rawPlatformId}`],
      echo: request.echo,
    });

    await expect(pending).rejects.toThrow('Unknown error');

    const readiness = adapter.getReadiness();
    expect(readiness.lastError).toContain('Unknown error');
    expect(readiness.pendingWsRequests).toBe(0);

    const serialized = JSON.stringify({ lastError: readiness.lastError });
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawPlatformId);
    expect(serialized).not.toContain('123456793');
    expect(serialized).not.toContain('[object Object]');

    await adapter.stop();
  });

  it('cleans up timed-out WebSocket OneBot API requests with bounded diagnostics', async () => {
    vi.useFakeTimers();
    const rawPlatformId = '123456795';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    try {
      await adapter.start();
      const socket = sockets[0];
      if (!socket) {
        throw new Error('Expected fake WebSocket');
      }
      socket.simulateOpen();

      const pending = adapter.sendMessage(
        { conversationId: `qq-group-${rawPlatformId}`, conversationType: 'group' },
        { text: '群聊 WS timeout' },
      );
      const rejection = expect(pending).rejects.toThrow('OneBot WebSocket API timeout: send_group_msg');

      expect(adapter.getReadiness().pendingWsRequests).toBe(1);
      vi.advanceTimersByTime(30_000);

      await rejection;

      const readiness = adapter.getReadiness();
      expect(readiness.pendingWsRequests).toBe(0);
      expect(readiness.lastError).toBe('OneBot WebSocket API timeout: send_group_msg');
      expect(JSON.stringify(readiness)).not.toContain(rawPlatformId);
      expect(socket.sent).toHaveLength(1);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('cleans up pending WebSocket OneBot API requests on close without leaking close diagnostics', async () => {
    const rawSecret = 'sk-onebot-ws-close-pending-secret';
    const rawPlatformId = '123456796';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 10_000,
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: `qq-group-${rawPlatformId}`, conversationType: 'group' },
      { text: '群聊 WS close' },
    );
    const rejection = expect(pending).rejects.toThrow('OneBot WebSocket closed');

    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    socket.simulateClose(`closed api_key=${rawSecret} target=qq-${rawPlatformId}`);

    await rejection;

    const readiness = adapter.getReadiness();
    expect(readiness.pendingWsRequests).toBe(0);
    expect(readiness.lastError).toContain('OneBot WebSocket closed');
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(`qq-${rawPlatformId}`);
    expect(serialized).not.toContain(rawPlatformId);
    expect(socket.sent).toHaveLength(1);

    await adapter.stop();
  });

  it('ignores late WebSocket messages after stop', async () => {
    const sockets: DeferredCloseFakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new DeferredCloseFakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    await adapter.stop();
    socket.simulateMessage({
      post_type: 'message',
      message_type: 'private',
      message_id: 701,
      user_id: 10001,
      message: 'late after stop',
      time: 1782970000,
    });

    expect(events).toHaveLength(0);
    expect(adapter.getReadiness()).toMatchObject({
      ready: false,
      wsConnected: false,
    });
  });

  it('ignores stale open and close events after a replacement WebSocket starts', async () => {
    vi.useFakeTimers();
    const sockets: DeferredCloseFakeWebSocket[] = [];
    const errors: Error[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 100,
      webSocketFactory: (url) => {
        const socket = new DeferredCloseFakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    try {
      await adapter.start();
      const staleSocket = sockets[0];
      if (!staleSocket) {
        throw new Error('Expected initial fake WebSocket');
      }

      await adapter.stop();
      await adapter.start();
      const replacementSocket = sockets[1];
      if (!replacementSocket) {
        throw new Error('Expected replacement fake WebSocket');
      }

      staleSocket.simulateOpen();
      expect(adapter.getReadiness().ready).toBe(false);

      replacementSocket.simulateOpen();
      expect(adapter.getReadiness().ready).toBe(true);

      staleSocket.simulateError(new Error('late stale error'));
      expect(errors).toHaveLength(0);
      expect(adapter.getReadiness().lastError).toBeUndefined();

      staleSocket.simulateClose('late stale close');
      expect(adapter.getReadiness().ready).toBe(true);

      vi.advanceTimersByTime(100);
      expect(sockets).toHaveLength(2);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('keeps replacement pending requests intact when a stale WebSocket closes', async () => {
    const sockets: DeferredCloseFakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 10_000,
      webSocketFactory: (url) => {
        const socket = new DeferredCloseFakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const staleSocket = sockets[0];
    if (!staleSocket) {
      throw new Error('Expected initial fake WebSocket');
    }
    await adapter.stop();
    await adapter.start();
    const replacementSocket = sockets[1];
    if (!replacementSocket) {
      throw new Error('Expected replacement fake WebSocket');
    }
    replacementSocket.simulateOpen();

    const pending = adapter.sendGroupMessage('qq-group-20001', 'replacement request');
    const request = JSON.parse(replacementSocket.sent[0] ?? '{}') as Record<string, unknown>;
    const guardedPending = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    staleSocket.simulateClose('late stale close');
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    replacementSocket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 702 },
      echo: request.echo,
    });

    await expect(guardedPending).resolves.toEqual({ value: 'qq-702' });
    expect(adapter.getReadiness()).toMatchObject({
      ready: true,
      wsConnected: true,
      pendingWsRequests: 0,
    });

    await adapter.stop();
  });

  it('reconnects exactly once after the current WebSocket closes unexpectedly', async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 100,
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    try {
      await adapter.start();
      const socket = sockets[0];
      if (!socket) {
        throw new Error('Expected initial fake WebSocket');
      }
      socket.simulateOpen();
      socket.simulateClose('unexpected close');

      expect(adapter.getReadiness().ready).toBe(false);
      vi.advanceTimersByTime(99);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);

      const replacementSocket = sockets[1];
      if (!replacementSocket) {
        throw new Error('Expected replacement fake WebSocket');
      }
      expect(adapter.getReadiness().ready).toBe(false);
      replacementSocket.simulateOpen();
      expect(adapter.getReadiness().ready).toBe(true);

      vi.advanceTimersByTime(1_000);
      expect(sockets).toHaveLength(2);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('retries a synchronous WebSocket factory failure after the reconnect delay', async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    let attempts = 0;
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 100,
      webSocketFactory: (url) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('synthetic WebSocket factory failure');
        }
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    try {
      await adapter.start();
      expect(attempts).toBe(1);
      expect(adapter.getReadiness().ready).toBe(false);

      vi.advanceTimersByTime(99);
      expect(attempts).toBe(1);
      vi.advanceTimersByTime(1);
      expect(attempts).toBe(2);
      expect(sockets).toHaveLength(1);

      sockets[0]?.simulateOpen();
      expect(adapter.getReadiness().ready).toBe(true);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled WebSocket reconnect when stopped', async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 100,
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    try {
      await adapter.start();
      const socket = sockets[0];
      if (!socket) {
        throw new Error('Expected initial fake WebSocket');
      }
      socket.simulateOpen();
      socket.simulateClose('unexpected close before stop');

      await adapter.stop();
      vi.advanceTimersByTime(1_000);

      expect(sockets).toHaveLength(1);
      expect(adapter.getReadiness()).toMatchObject({
        ready: false,
        wsConnected: false,
      });
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('cleans up pending WebSocket OneBot API requests during stop without leaking close failures', async () => {
    const rawSecret = 'sk-onebot-ws-stop-close-failure-secret';
    const rawPlatformId = '123456797';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 10_000,
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();
    socket.closeError = new Error(`shutdown failed api_key=${rawSecret} target=qq-${rawPlatformId}`);

    const pending = adapter.sendMessage(
      { conversationId: `qq-group-${rawPlatformId}`, conversationType: 'group' },
      { text: '群聊 WS stop' },
    );
    const rejection = expect(pending).rejects.toThrow('OneBot WebSocket closed');

    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    await adapter.stop();
    await rejection;

    const readiness = adapter.getReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.wsConnected).toBe(false);
    expect(readiness.pendingWsRequests).toBe(0);
    expect(readiness.lastError).toContain('OneBot WebSocket closed');
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(`qq-${rawPlatformId}`);
    expect(serialized).not.toContain(rawPlatformId);
    expect(socket.sent).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  it('cleans up pending WebSocket OneBot API requests when socket send throws without leaking diagnostics', async () => {
    const rawSecret = 'sk-onebot-ws-send-throw-secret';
    const rawPlatformId = '123456798';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 10_000,
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();
    socket.sendError = new Error(`ws send failed api_key=${rawSecret} target=qq-${rawPlatformId}`);

    await expect(adapter.sendMessage(
      { conversationId: `qq-group-${rawPlatformId}`, conversationType: 'group' },
      { text: '群聊 WS send throw' },
    )).rejects.toThrow('ws send failed');

    const readiness = adapter.getReadiness();
    expect(readiness.pendingWsRequests).toBe(0);
    expect(readiness.lastError).toContain('ws send failed');
    const serialized = JSON.stringify(readiness);
    expect(serialized).toContain('[REDACTED:');
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(`qq-${rawPlatformId}`);
    expect(serialized).not.toContain(rawPlatformId);
    expect(socket.sent).toHaveLength(0);
    expect(sockets).toHaveLength(1);

    await adapter.stop();
  });

  it('redacts secret-like WebSocket lifecycle diagnostics before readiness exposure', async () => {
    const rawSecret = 'sk-onebot-lifecycle-secret-should-not-leak';
    const rawPlatformId = 'qq-123456789';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 10_000,
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }

    const assertReadinessRedacted = (): void => {
      const readiness = adapter.getReadiness();
      expect(readiness.lastError).toContain('[REDACTED:');
      assertReadinessDoesNotLeak(readiness.lastError);
    };

    const assertReadinessDoesNotLeak = (lastError: string | undefined): void => {
      const serialized = JSON.stringify({ lastError });
      expect(serialized).not.toContain(rawSecret);
      expect(serialized).not.toContain(rawPlatformId);
      expect(serialized).not.toContain('123456789');
    };

    socket.simulateError(new Error(`ws error api_key=${rawSecret} target=${rawPlatformId}`));
    assertReadinessRedacted();

    socket.simulateMessage(`invalid-json api_key=${rawSecret} target=${rawPlatformId}`);
    assertReadinessDoesNotLeak(adapter.getReadiness().lastError);

    socket.simulateClose(`closed api_key=${rawSecret} target=${rawPlatformId}`);
    assertReadinessRedacted();

    await adapter.stop();
  });

  it('redacts secret-like WebSocket open failures before readiness exposure', async () => {
    const rawSecret = 'sk-onebot-open-secret-should-not-leak';
    const rawPlatformId = 'qq-123456789';
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      wsReconnectIntervalMs: 10_000,
      webSocketFactory: () => {
        throw new Error(`open failed api_key=${rawSecret} target=${rawPlatformId}`);
      },
    });

    await adapter.start();

    const readiness = adapter.getReadiness();
    expect(readiness.lastError).toContain('[REDACTED:');
    const serialized = JSON.stringify({ lastError: readiness.lastError });
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawPlatformId);
    expect(serialized).not.toContain('123456789');

    await adapter.stop();
  });

  it('ignores non-object WebSocket packets without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-non-object-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456791';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    const packets = [
      'null',
      JSON.stringify(`token=${rawSecret} target=${rawPlatformId}`),
      '8123456791',
      'true',
      'false',
      JSON.stringify([`token=${rawSecret}`, rawPlatformId]),
    ];

    for (const packet of packets) {
      socket.simulateMessage(packet);
    }

    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456791');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 601 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-601');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('ignores non-event WebSocket object packets without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-object-packet-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456792';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    const packets: Array<Record<string, unknown>> = [
      { echo: `${String(request.echo)}-distractor`, status: 'ok', data: { token: rawSecret } },
      { status: 'ok', retcode: 0, wording: `token=${rawSecret} target=${rawPlatformId}` },
      { post_type: 42, payload: `token=${rawSecret} target=${rawPlatformId}` },
      { post_type: 'notice', notice_type: 'notify', message: `token=${rawSecret}` },
      { post_type: 'message_reaction', reaction: rawPlatformId, token: rawSecret },
    ];

    for (const packet of packets) {
      socket.simulateMessage(packet);
    }

    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456792');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 602 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-602');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('treats WebSocket post_type packets as events before matching pending echo responses', async () => {
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const guardedPending = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'group',
      message_id: 110,
      user_id: 10001,
      group_id: 20001,
      message: '[CQ:at,qq=3889000770] echo collision',
      raw_message: '[CQ:at,qq=3889000770] echo collision',
      sender: { user_id: 10001, role: 'member' },
      time: 1782970000,
      echo: request.echo,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.message.content.text).toBe('echo collision');
    expect(events[0]?.message.mentionsBot).toBe(true);
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(adapter.getReadiness().lastError).toBeUndefined();

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 610 },
      echo: request.echo,
    });

    expect(await guardedPending).toEqual({ value: 'qq-610' });
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('ignores WebSocket message packets with unsupported message_type without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-message-type-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456793';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    const packets: Array<Record<string, unknown>> = [
      {
        post_type: 'message',
        message_type: 'guild',
        message_id: 1,
        user_id: 10001,
        group_id: 20001,
        message: `token=${rawSecret} target=${rawPlatformId}`,
      },
      {
        post_type: 'message',
        message_type: '',
        message_id: 2,
        user_id: 10001,
        group_id: 20001,
        message: `token=${rawSecret}`,
      },
      {
        post_type: 'message',
        message_type: 42,
        message_id: 3,
        user_id: 10001,
        group_id: 20001,
        message: `target=${rawPlatformId}`,
      },
      {
        post_type: 'message',
        message_type: null,
        message_id: 4,
        user_id: 10001,
        group_id: 20001,
        message: [`token=${rawSecret}`, rawPlatformId],
      },
      {
        post_type: 'message',
        message_id: 5,
        user_id: 10001,
        group_id: 20001,
        message: `token=${rawSecret} target=${rawPlatformId}`,
      },
    ];

    for (const packet of packets) {
      socket.simulateMessage(packet);
    }

    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456793');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 603 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-603');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('ignores WebSocket message packets with unsupported message sub_type without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-message-subtype-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456794';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    const packets: Array<Record<string, unknown>> = [
      {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'guild',
        message_id: 1,
        user_id: 10001,
        group_id: 20001,
        message: `[CQ:at,qq=3889000770] token=${rawSecret} target=${rawPlatformId}`,
      },
      {
        post_type: 'message',
        message_type: 'private',
        sub_type: { token: rawSecret, target: rawPlatformId },
        message_id: 2,
        user_id: 10002,
        message: `token=${rawSecret}`,
      },
      {
        post_type: 'message',
        message_type: 'group',
        sub_type: 8123456794,
        message_id: 3,
        user_id: 10003,
        group_id: 20003,
        message: `target=${rawPlatformId}`,
      },
    ];

    for (const packet of packets) {
      socket.simulateMessage(packet);
    }

    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456794');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 604 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-604');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('handles WebSocket message packets with malformed top-level content without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-malformed-content-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456795';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    const packets: Array<Record<string, unknown>> = [
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 10,
        user_id: 10001,
        group_id: 20001,
        message: { token: rawSecret, target: rawPlatformId },
        raw_message: { text: rawPlatformId },
        sender: { user_id: 10001, nickname: 'Group User', role: 'member' },
        time: 1782970000,
      },
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 11,
        user_id: 10002,
        message: 8123456795,
        raw_message: [`token=${rawSecret}`, rawPlatformId],
        sender: { user_id: 10002, nickname: 'Private User' },
        time: 1782970000,
      },
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 12,
        user_id: 10003,
        group_id: 20002,
        message: null,
        raw_message: true,
        sender: { user_id: 10003, nickname: 'Admin User', role: 'admin' },
        time: 1782970000,
      },
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 13,
        user_id: 10004,
        raw_message: { token: rawSecret, target: rawPlatformId },
        sender: { user_id: 10004, nickname: 'Second Private User' },
        time: 1782970000,
      },
    ];

    for (const packet of packets) {
      socket.simulateMessage(packet);
    }

    expect(events).toHaveLength(packets.length);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    expect(events.map((event) => event.message.conversationType)).toEqual([
      'group',
      'private',
      'group',
      'private',
    ]);
    for (const event of events) {
      expect(event.message.content.text).toBe('');
      expect(event.message.mentions).toEqual([]);
      expect(event.message.mentionsBot).toBe(false);
      expect(event.message.content.media).toEqual([]);
      expect(event.message.content.quote).toBeUndefined();
      expect(event.message.replyToMessageId).toBeUndefined();
    }

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(rawSecret);
    expect(serializedEvents).not.toContain(rawPlatformId);
    expect(serializedEvents).not.toContain('8123456795');

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456795');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 604 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-604');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('handles WebSocket message packets with malformed top-level identifiers without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-malformed-identifier-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456796';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    const packets: Array<Record<string, unknown>> = [
      {
        post_type: 'message',
        message_type: 'group',
        message_id: { value: `message-${rawSecret}-${rawPlatformId}` },
        user_id: true,
        group_id: [`group-${rawPlatformId}`],
        message: 'ws malformed identifiers should be bounded',
        raw_message: 'ws malformed identifiers should be bounded',
        sender: {
          user_id: { value: `sender-${rawSecret}-${rawPlatformId}` },
          nickname: 'Malformed Identifier Group User',
          role: 'member',
        },
        time: 1782970000,
      },
      {
        post_type: 'message',
        message_type: 'private',
        message_id: `api_key=${rawSecret}`,
        user_id: `sender-${rawPlatformId}-${rawSecret}`,
        message: 'ws malformed private identifiers should use sender fallback',
        raw_message: 'ws malformed private identifiers should use sender fallback',
        sender: {
          user_id: 10005,
          nickname: 'Malformed Identifier Private User',
        },
        time: 1782970000,
      },
    ];

    for (const packet of packets) {
      socket.simulateMessage(packet);
    }

    expect(events).toHaveLength(packets.length);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    const groupEvent = events[0];
    const privateEvent = events[1];
    if (!groupEvent || !privateEvent) {
      throw new Error('Expected parsed WebSocket events');
    }

    expect(groupEvent.message).toMatchObject({
      conversationId: 'qq-group-unknown',
      conversationType: 'group',
      groupId: 'qq-group-unknown',
      senderId: 'qq-unknown',
      senderRole: 'member',
      mentions: [],
      mentionsBot: false,
    });
    expect(groupEvent.message.messageId).toMatch(/^qq-local-/);
    expect(groupEvent.ingress).toEqual({ transport: 'ws' });
    expect(groupEvent.message.content.text).toBe('ws malformed identifiers should be bounded');

    expect(privateEvent.message).toMatchObject({
      conversationId: 'private:qq-10005',
      conversationType: 'private',
      senderId: 'qq-10005',
      mentions: [],
      mentionsBot: false,
    });
    expect(privateEvent.message.messageId).toMatch(/^qq-local-/);
    expect(privateEvent.ingress).toEqual({ transport: 'ws' });
    expect(privateEvent.message.content.text).toBe(
      'ws malformed private identifiers should use sender fallback'
    );

    for (const event of events) {
      expect(event.message.content.media).toEqual([]);
      expect(event.message.content.quote).toBeUndefined();
      expect(event.message.replyToMessageId).toBeUndefined();
    }

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(rawSecret);
    expect(serializedEvents).not.toContain(rawPlatformId);
    expect(serializedEvents).not.toContain('8123456796');
    expect(serializedEvents).not.toContain('[object Object]');
    expect(serializedEvents).not.toContain('qq-true');

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456796');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 605 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-605');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('handles WebSocket message packets with malformed timestamps without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-malformed-timestamp-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456797';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'group',
      message_id: 20,
      user_id: 10001,
      group_id: 20001,
      message: 'ws valid timestamp',
      raw_message: 'ws valid timestamp',
      sender: { user_id: 10001, nickname: 'Timestamp User', role: 'member' },
      time: 1782970000,
    });

    const fallbackStart = Date.now();
    const packets: Array<Record<string, unknown>> = [
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 21,
        user_id: 10001,
        group_id: 20001,
        message: 'ws malformed string timestamp',
        raw_message: 'ws malformed string timestamp',
        sender: { user_id: 10001, nickname: 'Timestamp User', role: 'member' },
        time: `api_key=${rawSecret} target=${rawPlatformId}`,
      },
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 22,
        user_id: 10002,
        message: 'ws malformed object timestamp',
        raw_message: 'ws malformed object timestamp',
        sender: { user_id: 10002, nickname: 'Timestamp Private User' },
        time: { token: rawSecret, target: rawPlatformId },
      },
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 23,
        user_id: 10003,
        group_id: 20003,
        message: 'ws malformed array timestamp',
        raw_message: 'ws malformed array timestamp',
        sender: { user_id: 10003, nickname: 'Timestamp Admin', role: 'admin' },
        time: [`token=${rawSecret}`, rawPlatformId],
      },
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 24,
        user_id: 10004,
        message: 'ws malformed boolean timestamp',
        raw_message: 'ws malformed boolean timestamp',
        sender: { user_id: 10004, nickname: 'Timestamp Boolean User' },
        time: true,
      },
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 25,
        user_id: 10005,
        group_id: 20005,
        message: 'ws malformed null timestamp',
        raw_message: 'ws malformed null timestamp',
        sender: { user_id: 10005, nickname: 'Timestamp Null User', role: 'member' },
        time: null,
      },
    ];

    for (const packet of packets) {
      socket.simulateMessage(packet);
    }
    const fallbackEnd = Date.now();

    expect(events).toHaveLength(1 + packets.length);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    expect(events[0]?.timestamp.getTime()).toBe(1782970000000);
    for (const event of events.slice(1)) {
      expect(Number.isFinite(event.timestamp.getTime())).toBe(true);
      expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(fallbackStart);
      expect(event.timestamp.getTime()).toBeLessThanOrEqual(fallbackEnd);
      expect(event.message.mentions).toEqual([]);
      expect(event.message.mentionsBot).toBe(false);
      expect(event.message.content.media).toEqual([]);
      expect(event.message.content.quote).toBeUndefined();
      expect(event.message.replyToMessageId).toBeUndefined();
    }

    expect(events.slice(1).map((event) => event.message.content.text)).toEqual([
      'ws malformed string timestamp',
      'ws malformed object timestamp',
      'ws malformed array timestamp',
      'ws malformed boolean timestamp',
      'ws malformed null timestamp',
    ]);

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(rawSecret);
    expect(serializedEvents).not.toContain(rawPlatformId);
    expect(serializedEvents).not.toContain('8123456797');

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456797');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 606 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-606');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('redacts WebSocket sender display metadata without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-sender-display-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456798';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'group',
      message_id: 30,
      user_id: 10001,
      group_id: 20001,
      message: 'ws group display metadata should redact',
      raw_message: 'ws group display metadata should redact',
      sender: {
        user_id: 10001,
        nickname: `Nick api_key=${rawSecret} peer=${rawPlatformId}`,
        card: `Card api_key=${rawSecret} peer=${rawPlatformId}`,
        role: 'member',
      },
      time: 1782970000,
    });

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'private',
      message_id: 31,
      user_id: 10002,
      message: 'ws private display metadata should redact',
      raw_message: 'ws private display metadata should redact',
      sender: {
        user_id: 10002,
        nickname: `Private api_key=${rawSecret} peer=${rawPlatformId}`,
      },
      time: 1782970000,
    });

    expect(events).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    const groupEvent = events[0];
    const privateEvent = events[1];
    if (!groupEvent || !privateEvent) {
      throw new Error('Expected WebSocket display metadata events');
    }

    expect(groupEvent.message.conversationType).toBe('group');
    expect(groupEvent.message.senderCard).toContain('[REDACTED:api_key_assignment]');
    expect(groupEvent.message.senderCard).toContain('[REDACTED:platform_id]');
    expect(groupEvent.message.senderDisplayName).toBe(groupEvent.message.senderCard);
    expect(groupEvent.message.senderRole).toBe('member');
    expect(privateEvent.message.conversationType).toBe('private');
    expect(privateEvent.message.senderDisplayName).toContain('[REDACTED:api_key_assignment]');
    expect(privateEvent.message.senderDisplayName).toContain('[REDACTED:platform_id]');

    for (const event of events) {
      expect(event.message.mentions).toEqual([]);
      expect(event.message.mentionsBot).toBe(false);
      expect(event.message.content.media).toEqual([]);
      expect(event.message.content.quote).toBeUndefined();
      expect(event.message.replyToMessageId).toBeUndefined();
    }

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(rawSecret);
    expect(serializedEvents).not.toContain(rawPlatformId);
    expect(serializedEvents).not.toContain('8123456798');

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456798');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 607 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-607');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('drops WebSocket secret-like media URLs without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-media-url-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456799';
    const sensitiveImageUrl =
      `https://example.test/ws-image.png?api_key=${rawSecret}&owner=${rawPlatformId}`;
    const sensitiveRecordUrl =
      `https://example.test/ws-audio.amr?download_token=${rawSecret}&legacy=${rawPlatformId}`;
    const sensitiveVideoUrl =
      `https://example.test/ws-video.mp4?access_token=${rawSecret}&group=${rawPlatformId}`;
    const sensitiveFileUrl =
      `https://example.test/ws-file.bin?cookie=${rawSecret}&sender=${rawPlatformId}`;
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'group',
      message_id: 40,
      user_id: 10001,
      group_id: 20001,
      message: [
        { type: 'image', data: { url: sensitiveImageUrl } },
        { type: 'record', data: { url: sensitiveRecordUrl } },
        { type: 'video', data: { url: sensitiveVideoUrl } },
        { type: 'file', data: { url: sensitiveFileUrl } },
        { type: 'text', data: { text: ' ws sensitive segment media URLs should drop' } },
      ],
      raw_message: 'structured ws secret-like segment media URL message',
      sender: { user_id: 10001, nickname: 'Media User', role: 'member' },
      time: 1782970000,
    });

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'private',
      message_id: 41,
      user_id: 10002,
      message:
        `[CQ:image,url=${sensitiveImageUrl}]` +
        `[CQ:record,url=${sensitiveRecordUrl}]` +
        ' ws sensitive cq media URLs should drop',
      raw_message:
        `[CQ:image,url=${sensitiveImageUrl}]` +
        `[CQ:record,url=${sensitiveRecordUrl}]` +
        ' ws sensitive cq media URLs should drop',
      sender: { user_id: 10002, nickname: 'Private Media User' },
      time: 1782970000,
    });

    expect(events).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    const groupEvent = events[0];
    const privateEvent = events[1];
    if (!groupEvent || !privateEvent) {
      throw new Error('Expected WebSocket media URL events');
    }

    expect(groupEvent.message.content.text).toBe('ws sensitive segment media URLs should drop');
    expect(groupEvent.message.content.media).toEqual([
      { type: 'image', url: undefined },
      { type: 'audio', url: undefined },
      { type: 'video', url: undefined },
      { type: 'file', url: undefined },
    ]);
    expect(privateEvent.message.content.text).toBe('ws sensitive cq media URLs should drop');
    expect(privateEvent.message.content.media).toEqual([
      { type: 'image', url: undefined },
      { type: 'audio', url: undefined },
    ]);

    for (const event of events) {
      expect(event.message.mentions).toEqual([]);
      expect(event.message.mentionsBot).toBe(false);
      expect(event.message.content.quote).toBeUndefined();
      expect(event.message.replyToMessageId).toBeUndefined();
    }

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(rawSecret);
    expect(serializedEvents).not.toContain(rawPlatformId);
    expect(serializedEvents).not.toContain('8123456799');
    expect(serializedEvents).not.toContain(sensitiveImageUrl);
    expect(serializedEvents).not.toContain(sensitiveRecordUrl);
    expect(serializedEvents).not.toContain(sensitiveVideoUrl);
    expect(serializedEvents).not.toContain(sensitiveFileUrl);

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456799');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 608 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-608');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('handles WebSocket malformed segment-array entries without diagnostic or pending-response side effects', async () => {
    const rawSecret = 'sk-ws-malformed-segment-secret-should-not-leak';
    const rawPlatformId = 'qq-8123456800';
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    const errors: Error[] = [];
    adapter.onEvent((event) => events.push(event));
    adapter.on('error', (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'group',
      message_id: 50,
      user_id: 10001,
      group_id: 20001,
      message: [
        null,
        `token=${rawSecret} target=${rawPlatformId}`,
        8123456800,
        true,
        [`array-${rawPlatformId}`],
        { data: { text: `missing type ${rawSecret}` } },
        { type: 42, data: { text: rawPlatformId } },
        { type: 'at', data: `qq-3889000770 token=${rawSecret}` },
        { type: 'reply', data: [`qq-123`, rawPlatformId] },
        { type: 'image', data: `url=https://example.test/${rawSecret}` },
        { type: 'record', data: null },
        { type: 'video', data: false },
        { type: 'file', data: [`file-${rawPlatformId}`] },
        { type: 'text', data: `text ${rawSecret}` },
        { type: 'text', data: { text: ' ws malformed segment entries stay bounded' } },
      ],
      raw_message: 'structured ws malformed segment-array message',
      sender: { user_id: 10001, nickname: 'Malformed Segment User', role: 'member' },
      time: 1782970000,
    });

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'private',
      message_id: 51,
      user_id: 10002,
      message: [
        { type: 'reply', data: { id: { value: `reply-${rawSecret}-${rawPlatformId}` } } },
        { type: 'at', data: { qq: [`bot-${rawPlatformId}`] } },
        { type: 'image', data: { url: { href: `https://example.test/${rawSecret}` } } },
        { type: 'unknown', data: { marker: rawPlatformId } },
        { type: 'text', data: { text: ' ws private malformed segment containers stay bounded' } },
      ],
      raw_message: 'structured ws private malformed segment-array message',
      sender: { user_id: 10002, nickname: 'Private Malformed Segment User' },
      time: 1782970000,
    });

    expect(events).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(adapter.getReadiness().lastError).toBeUndefined();
    expect(adapter.getReadiness().pendingWsRequests).toBe(1);
    expect(socket.sent).toHaveLength(1);

    const groupEvent = events[0];
    const privateEvent = events[1];
    if (!groupEvent || !privateEvent) {
      throw new Error('Expected WebSocket malformed segment-array events');
    }

    expect(groupEvent.message.content.text).toBe('ws malformed segment entries stay bounded');
    expect(groupEvent.message.content.media).toEqual([
      { type: 'image', url: undefined },
      { type: 'audio', url: undefined },
      { type: 'video', url: undefined },
      { type: 'file', url: undefined },
    ]);
    expect(privateEvent.message.content.text).toBe(
      'ws private malformed segment containers stay bounded'
    );
    expect(privateEvent.message.content.media).toEqual([{ type: 'image', url: undefined }]);

    for (const event of events) {
      expect(event.message.mentions).toEqual([]);
      expect(event.message.mentionsBot).toBe(false);
      expect(event.message.content.quote).toBeUndefined();
      expect(event.message.replyToMessageId).toBeUndefined();
    }

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(rawSecret);
    expect(serializedEvents).not.toContain(rawPlatformId);
    expect(serializedEvents).not.toContain('8123456800');
    expect(serializedEvents).not.toContain('[object Object]');
    expect(serializedEvents).not.toContain('qq-true');

    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);
    expect(serializedReadiness).not.toContain('8123456800');

    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 609 },
      echo: request.echo,
    });

    expect(await pending).toBe('qq-609');
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);

    await adapter.stop();
  });

  it('connects to OneBot WebSocket with access_token and dispatches message events', async () => {
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      token: 'ws-token',
      botId: '3889000770',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const events: ChatMessageReceived[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    expect(socket.url).toBe('ws://localhost:3001/?access_token=ws-token');
    socket.simulateOpen();
    expect(adapter.getReadiness().ready).toBe(true);

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'group',
      message_id: 88,
      user_id: 10001,
      group_id: 20001,
      message: [
        { type: 'at', data: { qq: '3889000770' } },
        { type: 'text', data: { text: ' ws hello' } },
      ],
      raw_message: '[CQ:at,qq=3889000770] ws hello',
      sender: { user_id: 10001, card: 'Ws User', role: 'member' },
      time: 1782970000,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.message.conversationType).toBe('group');
    expect(events[0]?.message.mentionsBot).toBe(true);
    expect(events[0]?.message.content.text).toBe('ws hello');
    expect(events[0]?.ingress).toEqual({ transport: 'ws', platformEventId: 'qq-88' });

    await adapter.stop();
  });

  it('sends private and group replies through OneBot WebSocket actions', async () => {
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const privatePending = adapter.sendMessage(
      { conversationId: 'private:qq-10001', conversationType: 'private' },
      { text: '私聊 WS' },
    );
    const privateRequest = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 501 },
      echo: privateRequest.echo,
    });

    const groupPending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const groupRequest = JSON.parse(socket.sent[1] ?? '{}') as Record<string, unknown>;
    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: 502 },
      echo: groupRequest.echo,
    });

    expect(await privatePending).toBe('qq-501');
    expect(await groupPending).toBe('qq-502');
    expect(privateRequest).toMatchObject({
      action: 'send_private_msg',
      params: { user_id: 10001, message: '私聊 WS' },
    });
    expect(groupRequest).toMatchObject({
      action: 'send_group_msg',
      params: { group_id: 20001, message: '群聊 WS' },
    });

    await adapter.stop();
  });

  it('falls back for non-positive or fractional outbound WebSocket message_id values', async () => {
    const malformedMessageIds = [-501, 0, 501.5];
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    for (const malformedMessageId of malformedMessageIds) {
      const pending = adapter.sendMessage(
        { conversationId: 'qq-group-20001', conversationType: 'group' },
        { text: '群聊 WS' },
      );
      const request = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
      socket.simulateMessage({
        status: 'ok',
        retcode: 0,
        data: { message_id: malformedMessageId },
        echo: request.echo,
      });

      const messageId = await pending;

      expect(messageId).toMatch(/^qq-sent-\d+-[a-z0-9]+$/);
      expect(messageId).not.toBe(`qq-${malformedMessageId}`);
      expect(messageId).not.toContain('qq--');
      expect(messageId).not.toContain('.');
      expect(adapter.getReadiness().pendingWsRequests).toBe(0);
    }

    expect(socket.sent).toHaveLength(malformedMessageIds.length);

    await adapter.stop();
  });

  it('falls back for secret-like outbound WebSocket message_id values', async () => {
    const rawSecret = 'sk-ws-outbound-message-id-secret-should-not-persist';
    const rawPlatformId = 'qq-987654321';
    const malformedMessageId = `sent-${rawPlatformId}-${rawSecret}`;
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    const pending = adapter.sendMessage(
      { conversationId: 'qq-group-20001', conversationType: 'group' },
      { text: '群聊 WS' },
    );
    const request = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
    socket.simulateMessage({
      status: 'ok',
      retcode: 0,
      data: { message_id: malformedMessageId },
      echo: request.echo,
    });

    const messageId = await pending;

    expect(messageId).toMatch(/^qq-sent-\d+-[a-z0-9]+$/);
    expect(messageId).not.toContain(malformedMessageId);
    expect(messageId).not.toContain(rawSecret);
    expect(messageId).not.toContain(rawPlatformId);
    expect(adapter.getReadiness().pendingWsRequests).toBe(0);
    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);

    await adapter.stop();
  });

  it('falls back for structured malformed outbound WebSocket message_id values', async () => {
    const rawSecret = 'sk-ws-outbound-structured-message-id-secret';
    const rawPlatformId = 'qq-987654322';
    const malformedMessageIds: unknown[] = [
      { value: `sent-${rawPlatformId}-${rawSecret}` },
      [`sent-${rawPlatformId}`],
      true,
      null,
    ];
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    for (const malformedMessageId of malformedMessageIds) {
      const pending = adapter.sendMessage(
        { conversationId: 'qq-group-20001', conversationType: 'group' },
        { text: '群聊 WS' },
      );
      const request = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
      socket.simulateMessage({
        status: 'ok',
        retcode: 0,
        data: { message_id: malformedMessageId },
        echo: request.echo,
      });

      const messageId = await pending;

      expect(messageId).toMatch(/^qq-sent-\d+-[a-z0-9]+$/);
      expect(messageId).not.toContain(rawSecret);
      expect(messageId).not.toContain(rawPlatformId);
      expect(adapter.getReadiness().pendingWsRequests).toBe(0);
    }

    expect(socket.sent).toHaveLength(malformedMessageIds.length);
    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);

    await adapter.stop();
  });

  it('falls back for malformed outbound WebSocket response data containers', async () => {
    const rawSecret = 'sk-ws-outbound-malformed-data-secret';
    const rawPlatformId = 'qq-987654323';
    const malformedDataValues: unknown[] = [
      `sent-${rawPlatformId}-${rawSecret}`,
      [`sent-${rawPlatformId}`],
      true,
      null,
    ];
    const sockets: FakeWebSocket[] = [];
    const adapter = new OneBotAdapter({
      transport: 'ws',
      httpUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001/',
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await adapter.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket');
    }
    socket.simulateOpen();

    for (const malformedDataValue of malformedDataValues) {
      const pending = adapter.sendMessage(
        { conversationId: 'qq-group-20001', conversationType: 'group' },
        { text: '群聊 WS' },
      );
      const request = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
      socket.simulateMessage({
        status: 'ok',
        retcode: 0,
        data: malformedDataValue,
        echo: request.echo,
      });

      const messageId = await pending;

      expect(messageId).toMatch(/^qq-sent-\d+-[a-z0-9]+$/);
      expect(messageId).not.toContain(rawSecret);
      expect(messageId).not.toContain(rawPlatformId);
      expect(adapter.getReadiness().pendingWsRequests).toBe(0);
    }

    expect(socket.sent).toHaveLength(malformedDataValues.length);
    const serializedReadiness = JSON.stringify(adapter.getReadiness());
    expect(serializedReadiness).not.toContain(rawSecret);
    expect(serializedReadiness).not.toContain(rawPlatformId);

    await adapter.stop();
  });
});
