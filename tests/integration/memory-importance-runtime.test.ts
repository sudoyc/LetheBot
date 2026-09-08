import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../src/config/index.js';
import { EvaluatorStub } from '../../src/evaluator/evaluator-stub.js';
import { LetheBotApp } from '../../src/index.js';
import type { PiAdapterInput } from '../../src/pi/pi-adapter.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';

const DAY = 86_400_000;
const TOKEN = 'synthetic-importance-governance-token';

describe('DEL-V3 production learning and governed retrieval', () => {
  const originalEnv = process.env;
  let root: string;
  let app: LetheBotApp;
  let inputs: PiAdapterInput[];
  let sequence: number;
  let base: number;
  let clock: number;
  let origin: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-importance-runtime-'));
    origin = `http://127.0.0.1:${await port()}`;
    process.env = {
      PATH: originalEnv.PATH, HOME: originalEnv.HOME, TMPDIR: originalEnv.TMPDIR,
      NODE_ENV: 'test', LETHEBOT_TEST: 'true', LOG_LEVEL: 'fatal',
      LETHEBOT_DB_PATH: join(root, 'runtime.db'), LETHEBOT_PORT: String(await port()), LETHEBOT_HOST: '127.0.0.1',
      ONEBOT_TRANSPORT: 'http', ONEBOT_HTTP_URL: 'http://127.0.0.1:1', ONEBOT_TOKEN: 'synthetic-importance-onebot',
      LETHEBOT_BOT_QQ_ID: '81111', PI_PROVIDER: 'mock', PI_MODEL: 'mock', EVALUATOR_PROVIDER: 'mock', EVALUATOR_MODEL: 'mock',
      LETHEBOT_GOVERNANCE_ENABLED: 'true', LETHEBOT_GOVERNANCE_PORT: new URL(origin).port,
      LETHEBOT_GOVERNANCE_ADMIN_TOKEN: TOKEN, LETHEBOT_IMPORTANCE_LEARNING_ENABLED: 'true',
      LETHEBOT_IMPORTANCE_APPLICATION_ENABLED: 'true',
    };
    base = Date.now();
    clock = base - 6 * DAY;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    inputs = [];
    sequence = 0;
    await start();
  });

  afterEach(async () => {
    try {
      expect(app.getEventProcessingFailures()).toEqual([]);
      expect(app.getDatabase().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(app.getDatabase().prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    } finally {
      await app?.stop();
      vi.restoreAllMocks();
      process.env = originalEnv;
      resetConfig();
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function start() {
    resetConfig();
    app = new LetheBotApp();
    app.setSocialEvaluatorForTesting(new EvaluatorStub());
    app.setPiRuntimeForTesting({ async runTurn(input) {
      inputs.push(input);
      return { turnId: input.turnId, responseText: 'Synthetic response.', toolCallIds: [], events: [],
        tokensUsed: { input: 0, output: 0, total: 0 }, status: 'completed' };
    } });
    app.setMessageSenderForTesting({ async sendMessage() { return `qq-importance-response-${++sequence}`; } });
    await app.start();
  }

  async function send(text = 'Synthetic workbench ping', sender = 82222) {
    clock += 1000;
    app.clearCooldownsForTesting();
    app.dispatchOneBotEventForTesting({ post_type: 'message', message_type: 'private', self_id: 81111,
      user_id: sender, message_id: 90000 + ++sequence, time: Math.floor(clock / 1000),
      sender: { user_id: sender, nickname: 'Synthetic operator' }, message: text }, 'http');
    await app.waitForIdle();
    return inputs.at(-1)?.contextPack.memory.selectedMemoryIds ?? [];
  }

  async function reviewSurface() {
    const login = await fetch(`${origin}/governance/api/v1/session`, { method: 'POST',
      headers: { Connection: 'close', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(login.status).toBe(201);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    const session = await login.json() as { csrfToken: string };
    const headers: Record<string, string> = { Connection: 'close', Origin: origin, Cookie: cookie,
      'Content-Type': 'application/json', 'X-LetheBot-CSRF': session.csrfToken };
    const scopes = await fetch(`${origin}/governance/api/v1/scopes`, { headers });
    const catalog = await scopes.json() as { entries: Array<{ handle: string; scopeKind: string }> };
    for (const scope of catalog.entries.filter((entry) => entry.scopeKind === 'user')) {
      headers['X-LetheBot-Scope'] = scope.handle;
      const list = await fetch(`${origin}/governance/api/v1/memory-reviews`, { headers });
      const entries = await list.json() as { entries: Array<{ kind: string; handle: string }> };
      const entry = entries.entries.find((item) => item.kind === 'importance');
      if (entry) return { headers, path: `${origin}/governance/api/v1/memory-reviews/${entry.handle}` };
    }
    throw new Error('Expected an importance review in its owner scope');
  }

  async function transition(surface: Awaited<ReturnType<typeof reviewSurface>>, action: string) {
    const preview = await fetch(surface.path, { method: 'POST', headers: surface.headers, body: JSON.stringify({ action }) });
    expect(preview.status).toBe(201);
    const body = await preview.json() as { previewHandle: string };
    const result = await fetch(`${surface.path}/confirm`, { method: 'POST', headers: surface.headers,
      body: JSON.stringify({ confirm: true, previewHandle: body.previewHandle,
        ...(action === 'approve' ? {} : { action }) }) });
    expect(result.status).toBe(200);
    return result.json() as Promise<Record<string, unknown>>;
  }

  it('learns from real ingress, exposes the score, changes later ContextPack only after apply and restores ranking', async () => {
    const statement = '\u6211\u559c\u6b22\u7eff\u8336';
    await send(statement);
    expect(await app.processNextBackgroundJobForTesting(undefined, ['extraction'])).toMatchObject({ status: 'completed' });
    const memory = app.getDatabase().prepare("SELECT id, canonical_user_id, conversation_id FROM memory_records WHERE kind = 'preference'").get() as {
      id: string; canonical_user_id: string; conversation_id: string;
    };
    assert(memory);
    clock = base - 3 * DAY;
    await send(statement);
    clock = base;
    await send(statement);
    await new MemoryRepository(app.getDatabase()).create({
      id: 'importance-distractor', scope: 'user', canonicalUserId: memory.canonical_user_id, conversationId: memory.conversation_id,
      content: 'A comparison preference', title: 'Comparison', kind: 'preference', importance: 0.6,
      confidence: 0.9, state: 'active', visibility: 'private_only', sensitivity: 'normal', authority: 'user_stated',
      sourceContext: 'admin_cli:synthetic',
      actor: { actorClass: 'admin', context: 'admin_cli' }, sources: [{ sourceType: 'user_command', sourceId: 'synthetic-control', external: true }],
    });
    for (let i = 0; i < 11; i += 1) await send();
    const before = await send();
    expect(before.slice(0, 2)).toEqual(['importance-distractor', memory.id]);
    await app.stop();
    await start();
    for (let i = 0; i < 3; i += 1) {
      const result = await app.processNextBackgroundJobForTesting(undefined, ['importance']);
      if (!result) break;
      expect(result.status).toBe('completed');
    }
    const surface = await reviewSurface();
    const detail = await fetch(surface.path, { headers: surface.headers });
    const detailText = await detail.text();
    expect(JSON.parse(detailText)).toMatchObject({ kind: 'importance', importance: {
      scorerVersion: 1, observationCount: 3, distinctDayCount: 3, proposedImportance: 0.74,
    } });
    expect(detailText).not.toContain(memory.id);
    expect(detailText).not.toContain(statement);
    expect(await send()).toEqual(before);
    await transition(surface, 'approve');
    expect(await send()).toEqual(before);
    await transition(await reviewSurface(), 'apply');
    expect((await send()).slice(0, 2)).toEqual([memory.id, 'importance-distractor']);
    expect(await send(undefined, 84444)).not.toContain(memory.id);
    const sources = app.getDatabase().prepare('SELECT * FROM memory_importance_sources').all();
    process.env.LETHEBOT_IMPORTANCE_LEARNING_ENABLED = 'false';
    process.env.LETHEBOT_IMPORTANCE_APPLICATION_ENABLED = 'false';
    await app.stop();
    await start();
    expect((await send()).slice(0, 2)).toEqual([memory.id, 'importance-distractor']);
    await transition(await reviewSurface(), 'rollback');
    expect(await send()).toEqual(before);
    expect(app.getDatabase().prepare('SELECT * FROM memory_importance_sources').all()).toEqual(sources);
    expect(app.getDatabase().prepare('SELECT COUNT(*) FROM model_invocations').pluck().get()).toBe(0);
  }, 20_000);
});

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
