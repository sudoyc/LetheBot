import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContextBuilder } from '../context/builder.js';
import { SemanticMemoryRetrieval } from '../context/semantic-retrieval.js';
import { MAX_EMBEDDING_BATCH, type EmbeddingIdentity, type EmbeddingProvider } from '../memory/embedding.js';
import corpus from '../memory/semantic-recall-corpus.json' with { type: 'json' };
import { initDatabase, runMigrations } from '../storage/database.js';
import { IdentityRepository } from '../storage/identity-repository.js';
import { MemoryEmbeddingRepository } from '../storage/memory-embedding-repository.js';
import { MemoryRepository } from '../storage/memory-repository.js';

const CORPUS_DIGEST = '65209aaa2c2458c98031659052971201b72b64b887efad8fd8d9c081175463da';

interface RecallQueryResult {
  sourceIds: string[];
  recallAtK: number;
  tokensUsed: number;
  durationMs: number;
  semanticStatus?: string;
}

export async function evaluateSemanticRecall(provider: EmbeddingProvider) {
  const digest = createHash('sha256').update(readFileSync(new URL('../memory/semantic-recall-corpus.json', import.meta.url))).digest('hex');
  if (digest !== CORPUS_DIGEST) throw new Error('Frozen semantic corpus digest mismatch');
  const directory = mkdtempSync(join(tmpdir(), 'lethebot-semantic-recall-'));
  const db = initDatabase({ path: join(directory, 'synthetic.db') });
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    db.exec("INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES ('synthetic-owner', 1, 1), ('synthetic-other', 1, 1)");
    const memories = new MemoryRepository(db);
    const index = new MemoryEmbeddingRepository(db, memories);
    for (const item of corpus.items) {
      await memories.create({
        id: item.id, title: item.id, content: item.content, kind: 'fact',
        scope: item.boundary === 'other_group' ? 'group' : 'user',
        canonicalUserId: item.boundary === 'other_group' ? undefined
          : item.boundary === 'other_user' ? 'synthetic-other' : 'synthetic-owner',
        groupId: item.boundary === 'other_group' ? 'synthetic-other-group' : undefined,
        visibility: item.boundary === 'admin_only' ? 'owner_admin_only'
          : item.boundary === 'other_group' ? 'same_group_only' : 'private_only',
        sensitivity: 'normal', authority: 'user_stated', state: 'active', confidence: 0.9, importance: 0.5,
        actor: { actorClass: 'admin', context: 'admin_cli' }, sourceContext: 'admin_cli:synthetic-recall',
        sources: [{ sourceType: 'user_command', sourceId: `source-${item.id}`, external: true }],
      });
      if (item.boundary === 'disabled') await memories.updateState(item.id, 'disabled');
    }
    // Fixed creation times prevent wall-clock ties from changing the frozen baseline.
    db.prepare('UPDATE memory_records SET created_at = ?').run(1_700_000_000_000);
    const snapshots = corpus.items.flatMap((item) => {
      const snapshot = index.snapshot(item.id);
      return snapshot ? [snapshot] : [];
    });
    let model: EmbeddingIdentity | undefined;
    let peakRssBytes = 0;
    let indexDurationMs = 0;
    for (let offset = 0; offset < snapshots.length; offset += MAX_EMBEDDING_BATCH) {
      const batch = snapshots.slice(offset, offset + MAX_EMBEDDING_BATCH);
      const embedded = await provider.embed(batch.map((snapshot) => snapshot.text), { timeoutMs: 15_000 });
      if (embedded.vectors.length !== batch.length) throw new Error('Embedding evaluation batch mismatch');
      model = embedded.identity;
      peakRssBytes = Math.max(peakRssBytes, embedded.peakRssBytes);
      indexDurationMs += embedded.durationMs;
      for (const [i, snapshot] of batch.entries()) {
        const vector = embedded.vectors[i];
        if (!vector || index.write(snapshot, embedded.identity, vector) !== 'written') throw new Error('Embedding evaluation index failed');
      }
    }
    const builders = {
      fts: new ContextBuilder(memories, new IdentityRepository(db), db),
      semantic: new ContextBuilder(memories, new IdentityRepository(db), db, new SemanticMemoryRetrieval(provider, index)),
    };
    const forbidden = new Set(corpus.items.filter((item) => item.boundary !== undefined).map((item) => item.id));
    let forbiddenSelections = 0;
    let tokenBudgetViolations = 0;
    const queries: Array<{
      queryId: string;
      queryClass: string;
      fts: RecallQueryResult;
      semantic: RecallQueryResult;
    }> = [];
    for (const query of corpus.queries) {
      const results = {} as Record<keyof typeof builders, RecallQueryResult>;
      for (const mode of ['fts', 'semantic'] as const) {
        const started = performance.now();
        const context = await builders[mode].buildContext({
          conversationId: 'synthetic-private', conversationType: 'private', canonicalUserId: 'synthetic-owner',
          currentMessageId: query.id,
          recentMessages: [{ messageId: query.id, senderId: 'synthetic-owner', senderDisplayName: 'Synthetic',
            text: query.text, timestamp: new Date(1_700_000_000_000), isFromBot: false }],
        });
        const sourceIds = context.memory.selectedMemoryIds.slice(0, corpus.k).flatMap((id) => (
          db.prepare('SELECT source_id FROM memory_sources WHERE memory_id = ? ORDER BY source_id').pluck().all(id) as string[]
        ));
        forbiddenSelections += context.memory.selectedMemoryIds.filter((id) => forbidden.has(id)).length;
        if (context.tokenBudget.max !== corpus.tokenBudget || context.tokenBudget.used > corpus.tokenBudget) tokenBudgetViolations += 1;
        results[mode] = {
          sourceIds, recallAtK: query.expectedSourceIds.filter((id) => sourceIds.includes(id)).length / query.expectedSourceIds.length,
          tokensUsed: context.tokenBudget.used, durationMs: Math.round(performance.now() - started),
          semanticStatus: context.trace?.filtersApplied.find((filter) => filter.startsWith('semantic_status=')),
        };
      }
      queries.push({ queryId: query.id, queryClass: query.class, ...results });
    }
    const classes = [...new Set(queries.map((query) => query.queryClass))].map((queryClass) => {
      const members = queries.filter((query) => query.queryClass === queryClass);
      return {
        queryClass, count: members.length,
        ftsRecallAtK: members.reduce((sum, query) => sum + query.fts.recallAtK, 0) / members.length,
        semanticRecallAtK: members.reduce((sum, query) => sum + query.semantic.recallAtK, 0) / members.length,
      };
    });
    const recoveredParaphrases = queries.filter((query) => query.queryClass.startsWith('paraphrase') && query.semantic.recallAtK > query.fts.recallAtK).length;
    const lexicalRegressions = queries.filter((query) => query.queryClass === 'lexical' && query.semantic.recallAtK < query.fts.recallAtK).length;
    const foreignKeysClean = db.prepare('PRAGMA foreign_key_check').all().length === 0;
    const integrityOk = db.prepare('PRAGMA integrity_check').pluck().get() === 'ok';
    const boundedResources = peakRssBytes <= 2 * 1024 ** 3;
    return {
      success: recoveredParaphrases > 0 && lexicalRegressions === 0 && forbiddenSelections === 0
        && tokenBudgetViolations === 0 && foreignKeysClean && integrityOk && boundedResources
        && queries.every((query) => query.semantic.semanticStatus === 'semantic_status=ready'),
      corpusVersion: corpus.version, corpusDigest: digest, k: corpus.k, tokenBudget: corpus.tokenBudget,
      model, indexDurationMs, peakRssBytes, boundedResources, indexedRecords: snapshots.length,
      classes, queries, recoveredParaphrases, lexicalRegressions, forbiddenSelections, tokenBudgetViolations,
      foreignKeysClean, integrityOk,
    };
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
