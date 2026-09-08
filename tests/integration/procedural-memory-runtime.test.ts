import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { GovernanceCLI } from '../../src/cli/governance.js';
import { resetConfig } from '../../src/config/index.js';
import { EvaluatorStub } from '../../src/evaluator/evaluator-stub.js';
import { LetheBotApp } from '../../src/index.js';
import type { PiAdapterInput } from '../../src/pi/pi-adapter.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';

describe('DEL-V1 production procedure wiring', () => {
  const originalEnv = process.env;
  let directory: string;
  let app: LetheBotApp;
  let inputs: PiAdapterInput[];
  let messageSequence: number;
  let outboundSequence: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'lethebot-procedure-runtime-'));
    process.env = {
      PATH: originalEnv.PATH, HOME: originalEnv.HOME, TMPDIR: originalEnv.TMPDIR,
      NODE_ENV: 'test', LETHEBOT_TEST: 'true', LOG_LEVEL: 'fatal',
      LETHEBOT_DB_PATH: join(directory, 'runtime.db'),
      LETHEBOT_PORT: String(await reserveLoopbackPort()), LETHEBOT_HOST: '127.0.0.1',
      ONEBOT_TRANSPORT: 'http', ONEBOT_HTTP_URL: 'http://127.0.0.1:1',
      ONEBOT_TOKEN: 'synthetic-procedure-transport', LETHEBOT_BOT_QQ_ID: '81111',
      PI_PROVIDER: 'mock', PI_MODEL: 'mock', EVALUATOR_PROVIDER: 'mock', EVALUATOR_MODEL: 'mock',
    };
    inputs = [];
    messageSequence = 0;
    outboundSequence = 0;
    await start();
  });

  afterEach(async () => {
    try {
      if (app) {
        expect(app.getEventProcessingFailures()).toEqual([]);
        expect(app.getDatabase().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(app.getDatabase().prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      }
    } finally {
      await app?.stop();
      process.env = originalEnv;
      resetConfig();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function start() {
    resetConfig();
    app = new LetheBotApp();
    app.setSocialEvaluatorForTesting(new EvaluatorStub());
    app.setPiRuntimeForTesting({
      async runTurn(input) {
        inputs.push(input);
        return {
          turnId: input.turnId, responseText: 'Synthetic response.', toolCallIds: [], events: [],
          tokensUsed: { input: 0, output: 0, total: 0 }, status: 'completed',
        };
      },
    });
    app.setMessageSenderForTesting({
      async sendMessage() { return `qq-procedure-response-${++outboundSequence}`; },
    });
    await app.start();
  }

  async function send(text: string, group: boolean, mention = false, sender = 82222) {
    const messageId = 90000 + ++messageSequence;
    app.clearCooldownsForTesting();
    app.dispatchOneBotEventForTesting({
      post_type: 'message', message_type: group ? 'group' : 'private',
      self_id: 81111, user_id: sender, ...(group ? { group_id: 83333 } : {}),
      message_id: messageId, time: Math.floor(Date.now() / 1000),
      sender: { user_id: sender, nickname: 'Synthetic operator', role: 'member' },
      message: mention
        ? [{ type: 'at', data: { qq: '81111' } }, { type: 'text', data: { text } }]
        : text,
    }, 'http');
    await app.waitForIdle();
    return messageId;
  }

  it.each([false, true])('learns from actual ingress and recalls after application restart (group=%s)', async (group) => {
    const teaching = 'Remember this procedure: summarize syntheticfiles with conclusions, then risks.';
    await send(teaching, group);
    const db = app.getDatabase();
    expect(db.prepare("SELECT COUNT(*) FROM jobs WHERE type = 'extraction' AND status = 'pending'").pluck().get()).toBe(1);
    expect(await app.processNextBackgroundJobForTesting(undefined, ['extraction']))
      .toMatchObject({ status: 'completed' });
    const row = db.prepare("SELECT id, canonical_user_id, state FROM memory_records WHERE kind = 'procedure'")
      .get() as { id: string; canonical_user_id: string; state: string } | undefined;
    assert(row);
    expect(row.state).toBe(group ? 'proposed' : 'active');
    const cli = new GovernanceCLI(new MemoryRepository(db), { db });
    if (group) expect(await cli.approveMemory(row.id)).toMatchObject({ success: true });
    const originalSources = db.prepare('SELECT * FROM memory_sources WHERE memory_id = ?').all(row.id);
    expect(originalSources).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) FROM evaluator_decisions WHERE domain = ?').pluck().get('memory')).toBe(1);
    await app.stop();
    await start();
    await send('Summarize syntheticfiles using my procedure.', group, group);
    expect(inputs.at(-1)?.contextPack.memory.selectedMemoryIds).toContain(row.id);
    expect(inputs.at(-1)?.contextPack.trace?.memorySelections).toEqual(expect.arrayContaining([
      expect.objectContaining({ memoryId: row.id, retrievalMethods: expect.arrayContaining(['fts']) }),
    ]));
    const restartedDb = app.getDatabase();
    expect(restartedDb.prepare('SELECT * FROM memory_sources WHERE memory_id = ?').all(row.id)).toEqual(originalSources);
    expect(await app.processNextBackgroundJobForTesting(undefined, ['extraction'])).toBeNull();
    await send('Summarize syntheticfiles using my procedure.', group, group, 84444);
    expect(inputs.at(-1)?.contextPack.memory.selectedMemoryIds).not.toContain(row.id);
    const restartedCli = new GovernanceCLI(new MemoryRepository(restartedDb), { db: restartedDb });
    expect(await restartedCli.deleteMemory(row.id)).toMatchObject({ success: true });
    await send('Summarize syntheticfiles using my procedure.', group, group);
    expect(inputs.at(-1)?.contextPack.memory.selectedMemoryIds).not.toContain(row.id);
    expect(restartedDb.prepare("SELECT COUNT(*) FROM jobs WHERE type = 'extraction' AND status = 'completed'").pluck().get()).toBe(1);
  });

  it('applies retrieval rollback on restart while keeping governance and source history available', async () => {
    await send('Remember this procedure: summarize syntheticfiles with conclusions, then risks.', false);
    expect(await app.processNextBackgroundJobForTesting(undefined, ['extraction'])).toMatchObject({ status: 'completed' });
    const memoryId = app.getDatabase().prepare("SELECT id FROM memory_records WHERE kind = 'procedure'").pluck().get();
    assert(typeof memoryId === 'string');
    await app.stop();
    process.env.LETHEBOT_PROCEDURE_RETRIEVAL_ENABLED = 'false';
    await start();
    await send('Summarize syntheticfiles using my procedure.', false);
    expect(inputs.at(-1)?.contextPack.memory.selectedMemoryIds).not.toContain(memoryId);
    expect(inputs.at(-1)?.contextPack.trace?.filtersApplied).toContain('procedure_retrieval=disabled');
    const db = app.getDatabase();
    expect(await new GovernanceCLI(new MemoryRepository(db), { db }).showMemory(memoryId)).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?').pluck().get(memoryId)).toBe(1);
    await app.stop();
    process.env.LETHEBOT_PROCEDURE_RETRIEVAL_ENABLED = 'true';
    await start();
    await send('Summarize syntheticfiles using my procedure.', false);
    expect(inputs.at(-1)?.contextPack.memory.selectedMemoryIds).toContain(memoryId);
  });
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
