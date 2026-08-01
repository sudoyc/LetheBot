import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../src/config/index.js';
import { LetheBotApp, VERSION } from '../../src/index.js';
import { getLogger } from '../../src/logger/index.js';
import { closeDatabase } from '../../src/storage/database.js';

class InertWebSocket {
  readonly readyState = 0;

  constructor(_url: string | URL) {}

  send(_data: string): void {}

  close(_code?: number, _reason?: string): void {}

  addEventListener(
    _event: 'open' | 'message' | 'error' | 'close',
    _handler: (event: { data?: unknown }) => void,
  ): void {}
}

describe('LetheBot application HTTP boundary characterization', () => {
  const originalEnv = process.env;
  const originalWebSocket = globalThis.WebSocket;
  const apps: LetheBotApp[] = [];
  const testDirs: string[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0).reverse()) {
      await app.stop();
    }
    for (const testDir of testDirs.splice(0)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    globalThis.WebSocket = originalWebSocket;
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('preserves configured routes, methods, query formats, response bytes, listener logs, and close behavior', async () => {
    const port = await reserveLoopbackPort();
    const infoLog = vi.spyOn(getLogger(), 'info');
    const app = createTestApp(port, {
      LETHEBOT_HEALTH_PATH: '/status/health',
      LETHEBOT_READINESS_PATH: '/status/ready',
      LETHEBOT_METRICS_PATH: '/status/metrics',
      LETHEBOT_EVENT_PATH: '/hooks/onebot',
    });
    apps.push(app);

    await app.start();

    const health = await fetch(`http://127.0.0.1:${port}/status/health?format=prometheus`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toBe('application/json');
    expect(await health.json()).toEqual({
      status: 'ok',
      version: VERSION,
      checks: {
        database: { ok: true, open: true },
        adapter: {
          ready: true,
          mode: 'http',
          hasToken: true,
          botIdConfigured: true,
        },
        eventProcessing: { pending: 0, failures: 0 },
      },
    });

    const readiness = await fetch(`http://127.0.0.1:${port}/status/ready?probe=full`);
    expect(readiness.status).toBe(200);
    expect(readiness.headers.get('content-type')).toBe('application/json');
    expect(await readiness.json()).toEqual({
      status: 'ready',
      version: VERSION,
      checks: {
        database: { ready: true, open: true },
        adapter: {
          ready: true,
          mode: 'http',
          hasToken: true,
          botIdConfigured: true,
        },
        eventProcessing: { pending: 0 },
      },
    });

    const jsonMetrics = await fetch(`http://127.0.0.1:${port}/status/metrics?format=Prometheus`);
    expect(jsonMetrics.status).toBe(200);
    expect(jsonMetrics.headers.get('content-type')).toBe('application/json');
    expect(await jsonMetrics.json()).toMatchObject({
      generatedAt: expect.any(String),
      rawEvents: { total: 0 },
      chatMessages: { total: 0 },
      agentTurns: { total: 0 },
      modelInvocations: { total: 0 },
    });

    const prometheusMetrics = await fetch(
      `http://127.0.0.1:${port}/status/metrics?scope=current&format=prometheus`,
    );
    expect(prometheusMetrics.status).toBe(200);
    expect(prometheusMetrics.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(await prometheusMetrics.text()).toContain('lethebot_metrics_snapshot_info 1\n');

    const eventResponse = await fetch(`http://127.0.0.1:${port}/hooks/onebot?source=test`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer characterization-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ post_type: 'meta_event' }),
    });
    expect(eventResponse.status).toBe(200);
    expect(eventResponse.headers.get('content-type')).toBe('application/json');
    expect(await eventResponse.text()).toBe(JSON.stringify({ status: 'ok' }));

    for (const [path, init] of [
      ['/healthz', undefined],
      ['/status/health', { method: 'POST' }],
      ['/hooks/onebot', undefined],
      ['/missing?path=/status/health', undefined],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBeNull();
      expect(await response.text()).toBe('Not Found');
    }

    expect(infoLog.mock.calls).toEqual(expect.arrayContaining([
      [{ host: '127.0.0.1', port }, 'LetheBot listening'],
      [{ host: 'localhost', port, path: '/status/health' }, 'Health check'],
      [{ host: 'localhost', port, path: '/status/ready' }, 'Readiness check'],
      [{ host: 'localhost', port, path: '/status/metrics' }, 'Metrics snapshot'],
      [{ host: 'localhost', port, path: '/hooks/onebot' }, 'OneBot endpoint'],
    ]));

    await app.stop();
    await expect(fetch(`http://127.0.0.1:${port}/status/health`)).rejects.toThrow();
  });

  it('returns the fixed JSON metrics failure for both requested formats', async () => {
    const port = await reserveLoopbackPort();
    const app = createTestApp(port);
    apps.push(app);
    await app.start();
    app.getDatabase().close();

    for (const suffix of ['', '?format=prometheus']) {
      const response = await fetch(`http://127.0.0.1:${port}/metrics${suffix}`);
      expect(response.status).toBe(503);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.text()).toBe(JSON.stringify({ error: 'metrics_unavailable' }));
    }
  });

  it('hides the reverse HTTP route and listener log when the feature is disabled', async () => {
    const port = await reserveLoopbackPort();
    const infoLog = vi.spyOn(getLogger(), 'info');
    globalThis.WebSocket = InertWebSocket as unknown as typeof WebSocket;
    const app = createTestApp(port, {
      ONEBOT_TRANSPORT: 'ws',
      LETHEBOT_REVERSE_HTTP_ENABLED: 'false',
    });
    apps.push(app);

    await app.start();
    const response = await fetch(`http://127.0.0.1:${port}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer characterization-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ post_type: 'meta_event' }),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
    expect(infoLog.mock.calls.some(([, message]) => message === 'OneBot endpoint')).toBe(false);
  });

  it('rejects start with the original listen error and emits no listener coordinates', async () => {
    const occupied = createServer();
    const port = await listenOnLoopback(occupied);
    const infoLog = vi.spyOn(getLogger(), 'info');
    const app = createTestApp(port);

    try {
      await expect(app.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(infoLog.mock.calls.some(
        ([coordinates, message]) => message === 'LetheBot listening'
          && typeof coordinates === 'object'
          && coordinates !== null
          && 'port' in coordinates
          && coordinates.port === port,
      )).toBe(false);
    } finally {
      await app.stopAdapterForTesting();
      if (app.getDatabase().open) {
        closeDatabase(app.getDatabase());
      }
      await closeServer(occupied);
    }
  });

  function createTestApp(
    port: number,
    overrides: Record<string, string> = {},
  ): LetheBotApp {
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-http-characterization-'));
    testDirs.push(testDir);
    process.env = {
      ...originalEnv,
      LETHEBOT_TEST: 'true',
      LETHEBOT_DB_PATH: join(testDir, 'lethebot.db'),
      LETHEBOT_HOST: '127.0.0.1',
      LETHEBOT_PORT: String(port),
      ONEBOT_TRANSPORT: 'http',
      ONEBOT_TOKEN: 'characterization-token',
      LETHEBOT_BOT_QQ_ID: '61000',
      LETHEBOT_REVERSE_HTTP_ENABLED: 'false',
      PI_PROVIDER: 'mock',
      PI_MODEL: 'mock',
      LOG_LEVEL: 'fatal',
      ...overrides,
    };
    resetConfig();
    return new LetheBotApp();
  }
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await listenOnLoopback(server);
  await closeServer(server);
  return port;
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected a TCP listener address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
