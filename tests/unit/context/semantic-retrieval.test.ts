import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBuilder } from '../../../src/context/builder.js';
import { SemanticMemoryRetrieval } from '../../../src/context/semantic-retrieval.js';
import { EmbeddingError, type EmbeddingErrorCode, type EmbeddingProvider } from '../../../src/memory/embedding.js';
import { initDatabase, runMigrations } from '../../../src/storage/database.js';
import { IdentityRepository } from '../../../src/storage/identity-repository.js';
import { MemoryEmbeddingRepository } from '../../../src/storage/memory-embedding-repository.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';

const identity = {
  provider: 'local_transformers' as const, model: 'synthetic/model', modelRevision: 'a'.repeat(64),
  dimensions: 3, indexVersion: 1,
};
const direction = new Float32Array([1, 0, 0]);
const context = { canonicalUserId: 'owner', conversationId: 'private:owner', contextType: 'private' as const };

describe('semantic ContextBuilder ranking and fallback', () => {
  let directory: string;
  let db: Database.Database;
  let memories: MemoryRepository;
  let index: MemoryEmbeddingRepository;
  const embed = vi.fn<EmbeddingProvider['embed']>();
  const provider: EmbeddingProvider = { identity, embed, async close() {} };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'lethebot-semantic-context-'));
    db = initDatabase({ path: join(directory, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    db.exec("INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES ('owner', 1, 1), ('other', 1, 1)");
    memories = new MemoryRepository(db);
    index = new MemoryEmbeddingRepository(db, memories);
    for (const [id, content, importance, owner] of [
      ['quiet', 'Loud rooms make it hard for me to concentrate.', 0.1, 'owner'],
      ['lexical', 'Silence is the name of the synthetic project.', 0.1, 'owner'],
      ['distractor', 'A synthetic folder stores monthly invoices.', 0.9, 'owner'],
      ['forbidden', 'Where can I work in silence?', 1, 'other'],
    ] as const) {
      await memories.create({
        id, content, importance, canonicalUserId: owner, scope: 'user', kind: 'fact', title: id,
        state: 'active', visibility: 'private_only', sensitivity: 'normal', authority: 'user_stated', confidence: 0.9,
        actor: { actorClass: 'admin', context: 'admin_cli' }, sourceContext: 'admin_cli:synthetic',
        sources: [{ sourceType: 'user_command', sourceId: `source-${id}`, external: true }],
      });
      const snapshot = index.snapshot(id);
      assert(snapshot);
      index.write(snapshot, identity, id === 'quiet' || id === 'forbidden' ? direction : new Float32Array([0, 1, 0]));
    }
    embed.mockReset().mockImplementation(async (texts) => ({
      identity, vectors: texts.map(() => direction), durationMs: 1, peakRssBytes: 100,
    }));
  });
  afterEach(() => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function build(enabled: boolean, deadlineAtMs?: number) {
    return new ContextBuilder(memories, new IdentityRepository(db), db,
      new SemanticMemoryRetrieval(provider, index, enabled)).buildContext({
      conversationId: context.conversationId, conversationType: context.contextType,
      canonicalUserId: context.canonicalUserId, currentMessageId: 'query', deadlineAtMs,
      recentMessages: [{ messageId: 'query', senderId: 'owner', senderDisplayName: 'Synthetic',
        text: 'Where can I work in silence?', timestamp: new Date(), isFromBot: false }],
    });
  }

  it('recovers a paraphrase while keeping lexical priority and scoped token limits', async () => {
    const baseline = await build(false);
    const semantic = await build(true);
    expect(baseline.memory.selectedMemoryIds.slice(0, 2)).toEqual(['lexical', 'distractor']);
    expect(semantic.memory.selectedMemoryIds.slice(0, 2)).toEqual(['lexical', 'quiet']);
    expect(semantic.trace?.candidateMemoryIds).not.toContain('forbidden');
    expect(semantic.memory.selectedMemoryIds).not.toContain('forbidden');
    expect(semantic.tokenBudget.used).toBeLessThanOrEqual(semantic.tokenBudget.max);
    expect(semantic.trace?.memorySelections).toContainEqual(expect.objectContaining({
      memoryId: 'quiet', retrievalMethods: expect.arrayContaining(['semantic']),
      semantic: { score: 1, model: identity.model, modelRevision: identity.modelRevision, dimensions: 3, indexVersion: 1 },
    }));
  });

  it.each<EmbeddingErrorCode>(['unavailable', 'timeout', 'busy', 'invalid_vector', 'cancelled', 'closed', 'invalid_model'])(
    'falls back to the same governed selection on %s', async (code) => {
      const baseline = await build(false);
      embed.mockRejectedValueOnce(new EmbeddingError(code));
      const fallback = await build(true);
      expect(fallback.memory.selectedMemoryIds).toEqual(baseline.memory.selectedMemoryIds);
      expect(fallback.trace?.filtersApplied).toContain(`semantic_status=${code}`);
    },
  );

  it('does not start inference past a turn deadline or when retrieval is disabled', async () => {
    expect((await build(false)).trace?.filtersApplied).toContain('semantic_status=disabled');
    expect((await build(true, Date.now() - 1)).trace?.filtersApplied).toContain('semantic_status=timeout');
    expect(embed).not.toHaveBeenCalled();
  });

  it('bounds and redacts query inference and excludes memory changed while awaiting it', async () => {
    const service = new SemanticMemoryRetrieval(provider, index);
    embed.mockImplementationOnce(async (texts) => {
      await memories.delete('quiet');
      return { identity, vectors: texts.map(() => direction), durationMs: 1, peakRssBytes: 100 };
    });
    const result = await service.retrieve(['a'.repeat(5000), 'password=synthetic-private-value', 'query', 'ignored'], context);
    expect(embed).toHaveBeenCalledWith([
      'a'.repeat(2048), expect.not.stringContaining('synthetic-private-value'), 'query',
    ], { timeoutMs: 2500 });
    expect(result.matches).toEqual([]);
  });

  it('rejects obsolete content and reports an empty index for a new model revision', async () => {
    db.prepare("UPDATE memory_records SET content = 'Revised synthetic memory' WHERE id = 'quiet'").run();
    const service = new SemanticMemoryRetrieval(provider, index);
    expect(await service.retrieve(['query'], context)).toMatchObject({ status: 'stale_index', matches: [], stale: 1 });
    embed.mockResolvedValueOnce({
      identity: { ...identity, modelRevision: 'b'.repeat(64) }, vectors: [direction], durationMs: 1, peakRssBytes: 100,
    });
    expect(await service.retrieve(['query'], context)).toMatchObject({ status: 'empty_index', matches: [] });
  });
});
