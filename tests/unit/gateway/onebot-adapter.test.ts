import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
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
  private readonly listeners = new Map<string, Array<(event: OneBotWebSocketEvent) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { reason: 'closed' });
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

  private emit(event: string, payload: OneBotWebSocketEvent): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(payload);
    }
  }
}

describe('OneBotAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(first.message.content.text).toBe('不是叫你');
    expect(second.message.mentions).toEqual(['qq-3889000770']);
    expect(second.message.mentionsBot).toBe(true);
    expect(second.message.content.text).toBe('你好');
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
});
