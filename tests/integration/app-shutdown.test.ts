import { once } from 'node:events';
import { request, type ClientRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LetheBotApp } from '../../src/index.js';
import { resetConfig } from '../../src/config/index.js';
import { closeDatabase, initDatabase } from '../../src/storage/database.js';
import type { OneBotMessage } from '../../src/gateway/onebot-adapter.js';
import type { PiAdapterInput, PiAdapterOutput } from '../../src/pi/pi-adapter.js';

interface HttpResponseResult {
  status: number;
  body: string;
}

describe('LetheBotApp graceful shutdown', () => {
  const originalEnv = process.env;
  let app: LetheBotApp;
  let dbPath: string;
  let port: number;
  let testDir: string;
  let releasePi: (() => void) | undefined;
  let partialRequest: ClientRequest | undefined;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    resetConfig();

    testDir = mkdtempSync(join(tmpdir(), 'lethebot-app-shutdown-'));
    dbPath = join(testDir, 'lethebot.db');
    port = 20_000 + Math.floor(Math.random() * 10_000);
    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_DB_PATH = dbPath;
    process.env.LETHEBOT_HOST = '127.0.0.1';
    process.env.LETHEBOT_PORT = String(port);
    process.env.ONEBOT_TRANSPORT = 'http';
    process.env.ONEBOT_TOKEN = 'shutdown-test-token';
    process.env.LETHEBOT_BOT_QQ_ID = '61000';
    process.env.PI_PROVIDER = 'mock';
    process.env.PI_MODEL = 'mock';
    process.env.LOG_LEVEL = 'fatal';

    app = new LetheBotApp();
    await app.start();
  });

  afterEach(async () => {
    releasePi?.();
    partialRequest?.end();
    await app.stop();
    rmSync(testDir, { recursive: true, force: true });
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('drains an accepted turn before closing outbound delivery and SQLite', async () => {
    let markPiStarted: (() => void) | undefined;
    const piStarted = new Promise<void>((resolve) => {
      markPiStarted = resolve;
    });
    const piGate = new Promise<void>((resolve) => {
      releasePi = resolve;
    });
    let piCalls = 0;
    const sendMessage = vi.fn().mockResolvedValue('qq-bot-shutdown-1');

    app.setPiRuntimeForTesting({
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        piCalls += 1;
        markPiStarted?.();
        await piGate;
        return {
          turnId: input.turnId,
          responseText: 'shutdown drain reply',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 4, output: 3, total: 7 },
          status: 'completed',
        };
      },
    });
    app.setMessageSenderForTesting({ sendMessage });

    const acceptedEvent: OneBotMessage = {
      post_type: 'message',
      message_type: 'private',
      message_id: 91_001,
      user_id: 61_001,
      message: 'finish this accepted turn before shutdown',
      sender: { user_id: 61_001, nickname: 'Shutdown Tester' },
      time: 1_783_630_000,
    };
    const response = await fetch(`http://127.0.0.1:${port}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer shutdown-test-token',
        Connection: 'close',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(acceptedEvent),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    await piStarted;

    const firstStop = app.stop();
    const secondStop = app.stop();
    let stopResolved = false;
    void firstStop.then(() => {
      stopResolved = true;
    });

    const wsDisposition = app.dispatchOneBotEventForTesting({
      ...acceptedEvent,
      message_id: 91_002,
      message: 'must not be claimed after shutdown admission closes',
    }, 'ws');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const databaseStayedOpen = app.getDatabase().open;
    const stoppedBeforePiReleased = stopResolved;

    releasePi();
    await Promise.all([firstStop, secondStop]);
    await app.waitForIdle();

    expect(firstStop).toBe(secondStop);
    expect(wsDisposition).toBe('failed');
    expect(databaseStayedOpen).toBe(true);
    expect(stoppedBeforePiReleased).toBe(false);
    expect(app.getDatabase().open).toBe(false);
    expect(piCalls).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const evidenceDb = initDatabase({ path: dbPath, readonly: true });
    try {
      expect(evidenceDb.prepare(
        `SELECT status, response_text, tokens_total
           FROM agent_turns`
      ).all()).toEqual([{
        status: 'completed',
        response_text: 'shutdown drain reply',
        tokens_total: 7,
      }]);
      expect(evidenceDb.prepare(
        `SELECT COUNT(*) AS count
           FROM action_decisions`
      ).get()).toEqual({ count: 1 });
      expect(evidenceDb.prepare(
        `SELECT status, executed_message_id
           FROM action_executions`
      ).all()).toEqual([{
        status: 'success',
        executed_message_id: 'qq-bot-shutdown-1',
      }]);
      expect(evidenceDb.prepare(
        `SELECT COUNT(*) AS count
           FROM chat_messages
          WHERE sender_id = 'bot-self'`
      ).get()).toEqual({ count: 1 });
      expect(evidenceDb.prepare(
        `SELECT COUNT(*) AS count
           FROM raw_events
          WHERE platform_event_id = 'qq-91002'`
      ).get()).toEqual({ count: 0 });
      expect(evidenceDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      closeDatabase(evidenceDb);
    }
  });

  it('awaits an in-flight HTTP request and rejects it without claiming the event', async () => {
    const runTurn = vi.fn();
    const sendMessage = vi.fn();
    app.setPiRuntimeForTesting({ runTurn });
    app.setMessageSenderForTesting({ sendMessage });

    const event: OneBotMessage = {
      post_type: 'message',
      message_type: 'private',
      message_id: 92_001,
      user_id: 62_001,
      message: 'partial request must remain unclaimed',
      sender: { user_id: 62_001, nickname: 'Partial Request Tester' },
      time: 1_783_630_100,
    };
    const body = JSON.stringify(event);
    let resolveResponse: ((value: HttpResponseResult) => void) | undefined;
    let rejectResponse: ((reason?: unknown) => void) | undefined;
    const responsePromise = new Promise<HttpResponseResult>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    partialRequest = request({
      host: '127.0.0.1',
      port,
      path: '/onebot/event',
      method: 'POST',
      headers: {
        Authorization: 'Bearer shutdown-test-token',
        Connection: 'close',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Expect: '100-continue',
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        resolveResponse?.({
          status: incoming.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    partialRequest.on('error', (error) => rejectResponse?.(error));
    partialRequest.flushHeaders();
    await once(partialRequest, 'continue');
    partialRequest.write(body.slice(0, -1));

    const stopPromise = app.stop();
    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const databaseStayedOpen = app.getDatabase().open;
    const stoppedBeforeRequestFinished = stopResolved;

    partialRequest.end(body.slice(-1));
    const result = await responsePromise;
    await stopPromise;

    expect(databaseStayedOpen).toBe(true);
    expect(stoppedBeforeRequestFinished).toBe(false);
    expect(result).toEqual({
      status: 503,
      body: JSON.stringify({ error: 'event_unavailable' }),
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const evidenceDb = initDatabase({ path: dbPath, readonly: true });
    try {
      expect(evidenceDb.prepare('SELECT COUNT(*) AS count FROM raw_events').get()).toEqual({ count: 0 });
      expect(evidenceDb.prepare('SELECT COUNT(*) AS count FROM event_ingress_receipts').get()).toEqual({ count: 0 });
      expect(evidenceDb.prepare('SELECT COUNT(*) AS count FROM chat_messages').get()).toEqual({ count: 0 });
      expect(evidenceDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      closeDatabase(evidenceDb);
    }
  });
});
