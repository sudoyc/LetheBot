import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LetheBotApp } from '../../src/index.js';
import { resetConfig } from '../../src/config/index.js';
import { getLogger } from '../../src/logger/index.js';

type FakeWebSocketEventName = 'open' | 'message' | 'error' | 'close';

interface FakeWebSocketEvent {
  data?: unknown;
}

class FakeAppWebSocket {
  static instances: FakeAppWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<
    FakeWebSocketEventName,
    Array<(event: FakeWebSocketEvent) => void>
  >();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeAppWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  addEventListener(
    event: FakeWebSocketEventName,
    handler: (event: FakeWebSocketEvent) => void,
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
    this.emit('message', { data: JSON.stringify(data) });
  }

  private emit(event: FakeWebSocketEventName, payload: FakeWebSocketEvent): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(payload);
    }
  }
}

describe('OneBot WebSocket app integration', () => {
  const originalEnv = process.env;
  const originalWebSocket = globalThis.WebSocket;
  let infoLogSpy: ReturnType<typeof vi.spyOn>;
  let app: LetheBotApp;
  let testPort: number;
  let testDir: string;

  beforeAll(async () => {
    process.env = { ...originalEnv };
    resetConfig();
    FakeAppWebSocket.instances = [];
    globalThis.WebSocket = FakeAppWebSocket as unknown as typeof WebSocket;
    infoLogSpy = vi.spyOn(getLogger(), 'info');

    testDir = mkdtempSync(join(tmpdir(), 'lethebot-ws-gateway-'));
    testPort = 17700 + Math.floor(Math.random() * 1000);
    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_DB_PATH = join(testDir, 'lethebot-ws.db');
    process.env.LETHEBOT_PORT = String(testPort);
    delete process.env.ONEBOT_TRANSPORT;
    delete process.env.LETHEBOT_REVERSE_HTTP_ENABLED;
    process.env.ONEBOT_WS_URL = 'ws://localhost:3001/';
    process.env.ONEBOT_TOKEN = 'ws-token';
    process.env.LETHEBOT_BOT_QQ_ID = '3889000770';
    process.env.PI_PROVIDER = 'mock';
    process.env.PI_MODEL = 'mock';
    process.env.LOG_LEVEL = 'fatal';

    app = new LetheBotApp();
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
    rmSync(testDir, { recursive: true, force: true });
    globalThis.WebSocket = originalWebSocket;
    infoLogSpy.mockRestore();
    process.env = originalEnv;
    resetConfig();
  });

  it('persists SnowLuma OneBot events received over WebSocket', async () => {
    const socket = FakeAppWebSocket.instances[0];
    if (!socket) {
      throw new Error('Expected fake WebSocket connection');
    }

    expect(socket.url).toBe('ws://localhost:3001/?access_token=ws-token');
    socket.simulateOpen();

    socket.simulateMessage({
      post_type: 'message',
      message_type: 'group',
      message_id: 701,
      user_id: 10001,
      group_id: 20001,
      message: [
        { type: 'at', data: { qq: '3889000770' } },
        { type: 'text', data: { text: ' ws integration' } },
      ],
      raw_message: '[CQ:at,qq=3889000770] ws integration',
      sender: { user_id: 10001, card: 'Ws Tester', role: 'member' },
      time: 1782970000,
    });

    await app.waitForIdle();

    const row = app
      .getDatabase()
      .prepare(
        `SELECT message_id, conversation_type, group_id, text, mentions_bot
         FROM chat_messages
         WHERE message_id = ?`,
      )
      .get('qq-701') as {
        message_id: string;
        conversation_type: string;
        group_id: string | null;
        text: string | null;
        mentions_bot: number;
      } | undefined;

    expect(row).toEqual({
      message_id: 'qq-701',
      conversation_type: 'group',
      group_id: 'qq-group-20001',
      text: 'ws integration',
      mentions_bot: 1,
    });
  });

  it('does not expose reverse HTTP ingress in default WebSocket mode', async () => {
    const tables = [
      'raw_events',
      'chat_messages',
      'agent_turns',
      'context_traces',
      'action_decisions',
      'action_executions',
    ] as const;
    const countRows = () => Object.fromEntries(
      tables.map((table) => {
        const row = app
          .getDatabase()
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as { count: number };
        return [table, row.count];
      }),
    );
    const beforeCounts = countRows();

    const response = await fetch(`http://127.0.0.1:${testPort}/onebot/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ws-token',
      },
      body: JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        message_id: 702,
        user_id: 10002,
        message: '/memory list',
        raw_message: '/memory list',
        sender: { user_id: 10002 },
        time: 1782970001,
      }),
    });

    await app.waitForIdle();

    expect(response.status).toBe(404);
    expect(countRows()).toEqual(beforeCounts);
    expect(infoLogSpy.mock.calls.some(
      ([, message]) => message === 'OneBot endpoint',
    )).toBe(false);
  });

  it('exposes reverse HTTP ingress in WebSocket mode only when explicitly enabled', async () => {
    const previousEnv = process.env;
    const explicitDir = mkdtempSync(join(tmpdir(), 'lethebot-ws-reverse-http-'));
    const explicitPort = 18700 + Math.floor(Math.random() * 1000);
    let explicitApp: LetheBotApp | undefined;

    try {
      process.env = {
        ...previousEnv,
        LETHEBOT_DB_PATH: join(explicitDir, 'lethebot-ws-reverse-http.db'),
        LETHEBOT_PORT: String(explicitPort),
        ONEBOT_TRANSPORT: 'ws',
        LETHEBOT_REVERSE_HTTP_ENABLED: 'true',
      };
      resetConfig();

      const socketIndex = FakeAppWebSocket.instances.length;
      explicitApp = new LetheBotApp();
      await explicitApp.start();

      expect(infoLogSpy.mock.calls).toContainEqual([
        {
          host: 'localhost',
          port: explicitPort,
          path: '/onebot/event',
        },
        'OneBot endpoint',
      ]);

      const socket = FakeAppWebSocket.instances[socketIndex];
      if (!socket) {
        throw new Error('Expected explicit-enable fake WebSocket connection');
      }
      socket.simulateOpen();

      const response = await fetch(`http://127.0.0.1:${explicitPort}/onebot/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ws-token',
        },
        body: JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          message_id: 703,
          user_id: 10003,
          message: 'explicit reverse HTTP integration',
          raw_message: 'explicit reverse HTTP integration',
          sender: { user_id: 10003 },
          time: 1782970002,
        }),
      });

      await explicitApp.waitForIdle();

      const row = explicitApp
        .getDatabase()
        .prepare('SELECT message_id, text FROM chat_messages WHERE message_id = ?')
        .get('qq-703');
      expect(response.status).toBe(200);
      expect(row).toEqual({
        message_id: 'qq-703',
        text: 'explicit reverse HTTP integration',
      });
    } finally {
      if (explicitApp) {
        await explicitApp.stop();
      }
      rmSync(explicitDir, { recursive: true, force: true });
      process.env = previousEnv;
      resetConfig();
    }
  });
});
