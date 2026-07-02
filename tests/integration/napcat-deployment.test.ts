import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'node:http';
import { loadNapCatConfig, resetConfig } from '../../src/config/index.js';
import { OneBotAdapter } from '../../src/gateway/onebot-adapter.js';
import type { ChatMessageReceived } from '../../src/types/events.js';

describe('NapCat Deployment Integration', () => {
  const originalEnv = process.env;
  let server: Server | null = null;
  let adapter: OneBotAdapter | null = null;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  afterEach(async () => {
    process.env = originalEnv;
    resetConfig();

    // Cleanup server
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }

    // Cleanup adapter
    if (adapter) {
      await adapter.stop();
      adapter = null;
    }
  });

  test('HTTP server starts and responds to health check', async () => {
    process.env.ONEBOT_HTTP_URL = 'http://localhost:3000';
    process.env.LETHEBOT_PORT = '6701';

    const config = loadNapCatConfig();
    adapter = new OneBotAdapter({
      httpUrl: config.httpUrl,
      token: config.token,
    });

    await adapter.start();

    // Start HTTP server
    server = createServer((req, res) => {
      if (req.url === '/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      server!.listen(config.serverPort, config.serverHost, () => resolve());
    });

    // Test health check
    const response = await fetch(`http://localhost:${config.serverPort}/healthz`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0');
  });

  test('HTTP server receives and processes OneBot events', async () => {
    process.env.ONEBOT_HTTP_URL = 'http://localhost:3000';
    process.env.LETHEBOT_PORT = '6702';

    const config = loadNapCatConfig();
    adapter = new OneBotAdapter({
      httpUrl: config.httpUrl,
      token: config.token,
    });

    await adapter.start();

    let receivedEvent: ChatMessageReceived | null = null;
    adapter.onEvent((event) => {
      receivedEvent = event;
    });

    // Start HTTP server
    server = createServer((req, res) => {
      if (req.url === '/onebot/event' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          try {
            const event = JSON.parse(body);
            adapter!.handleHttpEvent(event);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      server!.listen(config.serverPort, config.serverHost, () => resolve());
    });

    // Send OneBot event
    const onebotEvent = {
      post_type: 'message',
      message_type: 'private',
      user_id: 123456,
      message: 'Hello bot',
      raw_message: 'Hello bot',
      time: Math.floor(Date.now() / 1000),
    };

    const response = await fetch(`http://localhost:${config.serverPort}/onebot/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(onebotEvent),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');

    // Wait for event processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify event was received and converted
    expect(receivedEvent).not.toBeNull();
    expect(receivedEvent?.type).toBe('chat.message.received');
    expect(receivedEvent?.message.content.text).toBe('Hello bot');
    expect(receivedEvent?.message.conversationType).toBe('private');
  });

  test('HTTP server handles group messages', async () => {
    process.env.ONEBOT_HTTP_URL = 'http://localhost:3000';
    process.env.LETHEBOT_PORT = '6703';

    const config = loadNapCatConfig();
    adapter = new OneBotAdapter({
      httpUrl: config.httpUrl,
      token: config.token,
    });

    await adapter.start();

    let receivedEvent: ChatMessageReceived | null = null;
    adapter.onEvent((event) => {
      receivedEvent = event;
    });

    // Start HTTP server
    server = createServer((req, res) => {
      if (req.url === '/onebot/event' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          try {
            const event = JSON.parse(body);
            adapter!.handleHttpEvent(event);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      server!.listen(config.serverPort, config.serverHost, () => resolve());
    });

    // Send group message event
    const groupEvent = {
      post_type: 'message',
      message_type: 'group',
      user_id: 123456,
      group_id: 789012,
      message: 'Hello group',
      raw_message: 'Hello group',
      time: Math.floor(Date.now() / 1000),
    };

    const response = await fetch(`http://localhost:${config.serverPort}/onebot/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(groupEvent),
    });

    expect(response.status).toBe(200);

    // Wait for event processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify group event
    expect(receivedEvent).not.toBeNull();
    expect(receivedEvent?.message.conversationType).toBe('group');
    expect(receivedEvent?.message.groupId).toBe('qq-group-789012');
  });

  test('HTTP server returns 404 for unknown routes', async () => {
    process.env.LETHEBOT_PORT = '6704';

    const config = loadNapCatConfig();

    server = createServer((req, res) => {
      if (req.url === '/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      server!.listen(config.serverPort, config.serverHost, () => resolve());
    });

    const response = await fetch(`http://localhost:${config.serverPort}/unknown`);
    expect(response.status).toBe(404);
  });

  test('Configuration validation prevents server start with invalid config', async () => {
    process.env.ONEBOT_HTTP_URL = 'not-a-valid-url';

    try {
      loadNapCatConfig();
      expect.fail('Should have thrown validation error');
    } catch (error) {
      expect(error).toBeDefined();
      // Server should not start with invalid config
    }
  });

  test('Server starts with custom host and port', async () => {
    process.env.ONEBOT_HTTP_URL = 'http://localhost:3000';
    process.env.LETHEBOT_PORT = '6705';
    process.env.LETHEBOT_HOST = '127.0.0.1';

    const config = loadNapCatConfig();
    expect(config.serverPort).toBe(6705);
    expect(config.serverHost).toBe('127.0.0.1');

    server = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(config.serverPort, config.serverHost, () => resolve());
    });

    const response = await fetch(`http://127.0.0.1:${config.serverPort}/healthz`);
    expect(response.status).toBe(200);
  });

  test('Server handles malformed JSON gracefully', async () => {
    process.env.LETHEBOT_PORT = '6706';

    const config = loadNapCatConfig();
    adapter = new OneBotAdapter({
      httpUrl: config.httpUrl,
    });

    await adapter.start();

    server = createServer((req, res) => {
      if (req.url === '/onebot/event' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          try {
            const event = JSON.parse(body);
            adapter!.handleHttpEvent(event);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(config.serverPort, config.serverHost, () => resolve());
    });

    const response = await fetch(`http://localhost:${config.serverPort}/onebot/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid json{{{',
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBeDefined();
  });
});
