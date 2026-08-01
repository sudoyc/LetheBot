import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationHttpServer } from '../../../src/http/application-http-server.js';
import { getLogger } from '../../../src/logger/index.js';

describe('ApplicationHttpServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches configured routes and query formats, logs coordinates, and closes the listener', async () => {
    const port = await reserveLoopbackPort();
    const infoLog = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
    const health = vi.fn((response: ServerResponse) => respond(response, 'health'));
    const readiness = vi.fn((response: ServerResponse) => respond(response, 'readiness'));
    const metrics = vi.fn((format: 'json' | 'prometheus', response: ServerResponse) => {
      respond(response, `metrics:${format}`);
    });
    const oneBotEvent = vi.fn((_request, response: ServerResponse) => {
      respond(response, 'onebot');
    });
    const server = new ApplicationHttpServer({
      host: '127.0.0.1',
      port,
      healthPath: '/custom/health',
      readinessPath: '/custom/ready',
      metricsPath: '/custom/metrics',
      eventPath: '/custom/event',
      reverseHttpIngressEnabled: true,
    }, {
      handleHealth: health,
      handleReadiness: readiness,
      handleMetrics: metrics,
      handleOneBotEvent: oneBotEvent,
    });

    await server.start();
    try {
      await expect(fetchText(port, '/custom/health?probe=1')).resolves.toEqual({
        status: 200,
        body: 'health',
      });
      await expect(fetchText(port, '/custom/ready?probe=1')).resolves.toEqual({
        status: 200,
        body: 'readiness',
      });
      await expect(fetchText(port, '/custom/metrics?format=Prometheus')).resolves.toEqual({
        status: 200,
        body: 'metrics:json',
      });
      await expect(fetchText(port, '/custom/metrics?x=1&format=prometheus')).resolves.toEqual({
        status: 200,
        body: 'metrics:prometheus',
      });
      await expect(fetchText(port, '/custom/event?source=test', { method: 'POST' })).resolves.toEqual({
        status: 200,
        body: 'onebot',
      });
      await expect(fetchText(port, '/custom/health', { method: 'POST' })).resolves.toEqual({
        status: 404,
        body: 'Not Found',
      });
      await expect(fetchText(port, '/missing?path=/custom/health')).resolves.toEqual({
        status: 404,
        body: 'Not Found',
      });

      expect(health).toHaveBeenCalledTimes(1);
      expect(readiness).toHaveBeenCalledTimes(1);
      expect(metrics.mock.calls.map(([format]) => format)).toEqual(['json', 'prometheus']);
      expect(oneBotEvent).toHaveBeenCalledTimes(1);
      expect(infoLog.mock.calls).toEqual(expect.arrayContaining([
        [{ host: '127.0.0.1', port }, 'LetheBot listening'],
        [{ host: 'localhost', port, path: '/custom/health' }, 'Health check'],
        [{ host: 'localhost', port, path: '/custom/ready' }, 'Readiness check'],
        [{ host: 'localhost', port, path: '/custom/metrics' }, 'Metrics snapshot'],
        [{ host: 'localhost', port, path: '/custom/event' }, 'OneBot endpoint'],
      ]));
    } finally {
      await server.close();
    }

    await expect(fetch(`http://127.0.0.1:${port}/custom/health`)).rejects.toThrow();
  });

  it('does not dispatch or log the event route when disabled', async () => {
    const port = await reserveLoopbackPort();
    const infoLog = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
    const oneBotEvent = vi.fn();
    const server = new ApplicationHttpServer({
      host: '127.0.0.1',
      port,
      healthPath: '/healthz',
      readinessPath: '/readyz',
      metricsPath: '/metrics',
      eventPath: '/onebot/event',
      reverseHttpIngressEnabled: false,
    }, {
      handleHealth: () => undefined,
      handleReadiness: () => undefined,
      handleMetrics: () => undefined,
      handleOneBotEvent: oneBotEvent,
    });

    await server.start();
    try {
      await expect(fetchText(port, '/onebot/event', { method: 'POST' })).resolves.toEqual({
        status: 404,
        body: 'Not Found',
      });
      expect(oneBotEvent).not.toHaveBeenCalled();
      expect(infoLog.mock.calls.some(([, message]) => message === 'OneBot endpoint')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('rejects start with the listen error before logging coordinates', async () => {
    const occupied = createServer();
    const port = await listenOnLoopback(occupied);
    const infoLog = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
    const server = new ApplicationHttpServer({
      host: '127.0.0.1',
      port,
      healthPath: '/healthz',
      readinessPath: '/readyz',
      metricsPath: '/metrics',
      eventPath: '/onebot/event',
      reverseHttpIngressEnabled: true,
    }, {
      handleHealth: () => undefined,
      handleReadiness: () => undefined,
      handleMetrics: () => undefined,
      handleOneBotEvent: () => undefined,
    });

    try {
      await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(infoLog).not.toHaveBeenCalled();
    } finally {
      await closeServer(occupied);
    }
  });
});

function respond(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end(body);
}

async function fetchText(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return {
    status: response.status,
    body: await response.text(),
  };
}

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
