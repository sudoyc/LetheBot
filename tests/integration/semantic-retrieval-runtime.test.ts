import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { GovernanceCLI } from '../../src/cli/governance.js';
import { resetConfig } from '../../src/config/index.js';
import { EvaluatorStub } from '../../src/evaluator/evaluator-stub.js';
import { LetheBotApp } from '../../src/index.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EmbeddingError } from '../../src/memory/embedding.js';
import { LocalEmbeddingProvider } from '../../src/memory/local-embedding-provider.js';
import type { PiAdapterInput } from '../../src/pi/pi-adapter.js';
import { ContextTraceRepository } from '../../src/storage/context-trace-repository.js';
import { JobRepository } from '../../src/storage/job-repository.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';

const identity = {
  provider: 'local_transformers' as const, model: EMBEDDING_MODEL, modelRevision: 'a'.repeat(64),
  dimensions: EMBEDDING_DIMENSIONS, indexVersion: 1,
};

describe('DEL-V2 production semantic retrieval wiring', () => {
  const originalEnv = process.env;
  let directory: string;
  let app: LetheBotApp;
  let inputs: PiAdapterInput[];
  let sequence: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'lethebot-semantic-runtime-'));
    process.env = {
      PATH: originalEnv.PATH, HOME: originalEnv.HOME, TMPDIR: originalEnv.TMPDIR,
      NODE_ENV: 'test', LETHEBOT_TEST: 'true', LOG_LEVEL: 'fatal',
      LETHEBOT_DB_PATH: join(directory, 'runtime.db'),
      LETHEBOT_PORT: String(await reserveLoopbackPort()), LETHEBOT_HOST: '127.0.0.1',
      ONEBOT_TRANSPORT: 'http', ONEBOT_HTTP_URL: 'http://127.0.0.1:1',
      ONEBOT_TOKEN: 'synthetic-semantic-transport', LETHEBOT_BOT_QQ_ID: '81111',
      PI_PROVIDER: 'mock', PI_MODEL: 'mock', EVALUATOR_PROVIDER: 'mock', EVALUATOR_MODEL: 'mock',
      LETHEBOT_EMBEDDING_MODEL_DIRECTORY: join(directory, 'synthetic-model'),
      LETHEBOT_EMBEDDING_WRITES_ENABLED: 'true', LETHEBOT_EMBEDDING_RETRIEVAL_ENABLED: 'true',
    };
    vi.spyOn(LocalEmbeddingProvider.prototype, 'embed').mockImplementation(async function (texts) {
      this.identity = identity;
      return {
        identity, durationMs: 1, peakRssBytes: 1024,
        vectors: texts.map((text) => {
          const vector = new Float32Array(EMBEDDING_DIMENSIONS);
          vector[/silence|Loud rooms/.test(text) ? 0 : 1] = 1;
          return vector;
        }),
      };
    });
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
    app.setMessageSenderForTesting({ async sendMessage() { return `qq-semantic-response-${++sequence}`; } });
    await app.start();
  }

  async function send(text: string, group = false, otherScope = false) {
    app.clearCooldownsForTesting();
    const sender = otherScope && !group ? 84444 : 82222;
    app.dispatchOneBotEventForTesting({
      post_type: 'message', message_type: group ? 'group' : 'private',
      self_id: 81111, user_id: sender, ...(group ? { group_id: otherScope ? 85555 : 83333 } : {}),
      message_id: 90000 + ++sequence, time: Math.floor(Date.now() / 1000),
      sender: { user_id: sender, nickname: 'Synthetic operator', role: 'member' },
      message: group
        ? [{ type: 'at', data: { qq: '81111' } }, { type: 'text', data: { text } }]
        : text,
    }, 'http');
    await app.waitForIdle();
    const input = inputs.at(-1);
    assert(input);
    return input;
  }

  async function seed(group = false) {
    const initial = await send('Synthetic greeting.', group);
    const db = app.getDatabase();
    const owner = db.prepare('SELECT id FROM canonical_users ORDER BY rowid LIMIT 1').pluck().get();
    assert(typeof owner === 'string');
    const memories = new MemoryRepository(db);
    for (const [id, content, importance] of [
      ['quiet', 'Loud rooms make it hard for me to concentrate.', 0.1],
      ['distractor', 'A synthetic folder stores monthly invoices.', 0.9],
    ] as const) {
      await memories.create({
        id, content, importance, scope: group ? 'group' : 'user',
        canonicalUserId: group ? undefined : owner, groupId: initial.contextPack.conversation.groupId,
        kind: 'fact', title: id, state: 'active', sensitivity: 'normal',
        visibility: group ? 'same_group_only' : 'private_only', authority: 'user_stated', confidence: 0.9,
        actor: { actorClass: 'admin', context: 'admin_cli' }, sourceContext: 'admin_cli:synthetic',
        sources: [{ sourceType: 'user_command', sourceId: `source-${id}`, external: true }],
      });
    }
  }

  it.each([false, true])('indexes durable work and recalls through OneBot after restart (group=%s)', async (group) => {
    await seed(group);
    expect(await app.processNextBackgroundJobForTesting(undefined, ['embedding']))
      .toMatchObject({ status: 'completed', output: { indexed: 2 } });
    const rows = app.getDatabase().prepare('SELECT * FROM memory_embeddings ORDER BY memory_id').all();
    await app.stop();
    await start();
    const input = await send('Where can I work in silence?', group);
    expect(input.contextPack.memory.selectedMemoryIds[0]).toBe('quiet');
    const trace = await new ContextTraceRepository(app.getDatabase()).findByTurnId(input.turnId);
    expect(trace?.memorySelections).toContainEqual(expect.objectContaining({
      memoryId: 'quiet', retrievalMethods: expect.arrayContaining(['semantic']),
      semantic: expect.objectContaining({ modelRevision: identity.modelRevision, dimensions: EMBEDDING_DIMENSIONS }),
    }));
    expect(app.getDatabase().prepare('SELECT * FROM memory_embeddings ORDER BY memory_id').all()).toEqual(rows);
    const other = await send('Where can I work in silence?', group, true);
    expect(other.contextPack.memory.selectedMemoryIds).not.toContain('quiet');
    const cli = new GovernanceCLI(new MemoryRepository(app.getDatabase()), { db: app.getDatabase() });
    expect(await cli.deleteMemory('quiet')).toMatchObject({ success: true });
    expect((await send('Where can I work in silence?', group)).contextPack.memory.selectedMemoryIds).not.toContain('quiet');
  });

  it('keeps write and retrieval switches independent across queued work and restarts', async () => {
    await app.stop();
    process.env.LETHEBOT_EMBEDDING_RETRIEVAL_ENABLED = 'false';
    await start();
    await seed();
    expect(await app.processNextBackgroundJobForTesting(undefined, ['embedding']))
      .toMatchObject({ status: 'completed', output: { indexed: 2 } });
    expect((await send('Where can I work in silence?')).contextPack.trace?.filtersApplied).toContain('semantic_status=disabled');
    const rows = app.getDatabase().prepare('SELECT * FROM memory_embeddings ORDER BY memory_id').all();
    new JobRepository(app.getDatabase()).enqueue({ type: 'embedding', payload: {} });
    await app.stop();
    process.env.LETHEBOT_EMBEDDING_WRITES_ENABLED = 'false';
    process.env.LETHEBOT_EMBEDDING_RETRIEVAL_ENABLED = 'true';
    await start();
    expect(await app.processNextBackgroundJobForTesting(undefined, ['embedding']))
      .toMatchObject({ status: 'completed', output: { status: 'disabled', indexed: 0 } });
    const retrieved = await send('Where can I work in silence?');
    expect(retrieved.contextPack.memory.selectedMemoryIds[0]).toBe('quiet');
    expect(app.getDatabase().prepare('SELECT * FROM memory_embeddings ORDER BY memory_id').all()).toEqual(rows);
    await app.stop();
    process.env.LETHEBOT_EMBEDDING_RETRIEVAL_ENABLED = 'false';
    await start();
    expect((await send('Where can I work in silence?')).contextPack.trace?.memorySelections)
      .not.toContainEqual(expect.objectContaining({ retrievalMethods: expect.arrayContaining(['semantic']) }));
    expect(app.getDatabase().prepare('SELECT * FROM memory_embeddings ORDER BY memory_id').all()).toEqual(rows);
  });

  it('continues ordinary turns when local model startup and query inference fail', async () => {
    await app.stop();
    vi.mocked(LocalEmbeddingProvider.prototype.embed).mockRejectedValue(new EmbeddingError('unavailable'));
    await start();
    const input = await send('Synthetic greeting.');
    expect(input.contextPack.trace?.filtersApplied).toContain('semantic_status=unavailable');
    expect(await app.processNextBackgroundJobForTesting(undefined, ['embedding'])).toMatchObject({ status: 'failed' });
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
