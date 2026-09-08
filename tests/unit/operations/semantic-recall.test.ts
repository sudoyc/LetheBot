import { describe, expect, it, vi } from 'vitest';
import { EmbeddingError, MAX_EMBEDDING_BATCH, type EmbeddingProvider } from '../../../src/memory/embedding.js';
import { evaluateSemanticRecall } from '../../../src/operations/semantic-recall.js';

const identity = {
  provider: 'local_transformers' as const, model: 'synthetic/recall-evaluation', modelRevision: 'a'.repeat(64),
  dimensions: 3, indexVersion: 1,
};

describe('semantic recall evaluation contract', () => {
  it('reports governed source results and rejects a provider that adds no semantic discrimination', async () => {
    const embed = vi.fn<EmbeddingProvider['embed']>().mockImplementation(async (texts) => ({
      identity, vectors: texts.map(() => new Float32Array([1, 0, 0])), durationMs: 2, peakRssBytes: 1024,
    }));
    const report = await evaluateSemanticRecall({ identity, embed, close: vi.fn() });
    expect(report).toMatchObject({ success: false, model: identity, forbiddenSelections: 0,
      tokenBudgetViolations: 0, foreignKeysClean: true, integrityOk: true, boundedResources: true });
    expect(report.recoveredParaphrases).toBe(0);
    const lexical = report.queries.filter((query) => query.queryClass === 'lexical');
    expect(lexical.length).toBeGreaterThan(0);
    for (const query of lexical) {
      expect(query.fts.recallAtK).toBe(1);
      expect(query.semantic.sourceIds).toEqual(query.fts.sourceIds);
    }
    for (const query of report.queries) {
      expect(query.semantic.semanticStatus).toBe('semantic_status=ready');
      for (const mode of [query.fts, query.semantic]) {
        expect(mode.tokensUsed).toBeLessThanOrEqual(report.tokenBudget);
        expect(mode.sourceIds.length).toBeLessThanOrEqual(report.k);
        expect(mode.sourceIds.every((id) => id.startsWith('source-') && !id.startsWith('source-forbidden-'))).toBe(true);
      }
    }
    const indexCalls = embed.mock.calls.filter(([, options]) => options?.timeoutMs === 15_000);
    expect(indexCalls.flatMap(([texts]) => texts)).toHaveLength(report.indexedRecords);
    expect(indexCalls.every(([texts]) => texts.length <= MAX_EMBEDDING_BATCH)).toBe(true);
    expect(report.indexDurationMs).toBe(indexCalls.length * 2);
    expect(report.classes.reduce((sum, group) => sum + group.count, 0)).toBe(report.queries.length);
  });

  it.each(['provider_failure', 'incomplete_batch'])(
    'rejects %s during indexing instead of publishing a completed evaluation', async (failure) => {
      const embed = vi.fn<EmbeddingProvider['embed']>().mockImplementation(async () => {
        if (failure === 'provider_failure') throw new EmbeddingError('unavailable');
        return { identity, vectors: [], durationMs: 0, peakRssBytes: 0 };
      });
      await expect(evaluateSemanticRecall({ identity, embed, close: vi.fn() })).rejects.toThrow(
        failure === 'provider_failure' ? 'Embedding unavailable' : 'Embedding evaluation batch mismatch',
      );
      expect(embed).toHaveBeenCalledTimes(1);
    },
  );
});
