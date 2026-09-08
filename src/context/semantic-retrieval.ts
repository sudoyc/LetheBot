import {
  EmbeddingError, MAX_EMBEDDING_TEXT_LENGTH, type EmbeddingIdentity, type EmbeddingProvider,
} from '../memory/embedding.js';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type { MemoryEmbeddingRepository, SemanticMemoryContext } from '../storage/memory-embedding-repository.js';

export interface SemanticRetrievalResult {
  status: string;
  matches: Array<{ queryIndex: number; memoryId: string; score: number }>;
  identity?: EmbeddingIdentity;
  durationMs?: number;
  stale: number;
  truncated: boolean;
}

export class SemanticMemoryRetrieval {
  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly index: MemoryEmbeddingRepository,
    private readonly enabled = true,
  ) {}

  async retrieve(texts: string[], context: SemanticMemoryContext, deadlineAtMs?: number): Promise<SemanticRetrievalResult> {
    const empty = { matches: [], stale: 0, truncated: false };
    if (!this.enabled) return { ...empty, status: 'disabled' };
    if (texts.length === 0) return { ...empty, status: 'no_query' };
    const remaining = deadlineAtMs === undefined ? 2500 : Math.min(2500, Math.floor(deadlineAtMs - Date.now()));
    if (remaining < 1) return { ...empty, status: 'timeout' };
    try {
      const batch = await this.provider.embed(
        texts.slice(0, 3).map((text) => redactSecretsInText(text).text.slice(0, MAX_EMBEDDING_TEXT_LENGTH)),
        { timeoutMs: remaining },
      );
      const result: SemanticRetrievalResult = {
        status: 'ready', matches: [], identity: batch.identity, durationMs: batch.durationMs, stale: 0, truncated: false,
      };
      batch.vectors.forEach((vector, queryIndex) => {
        const found = this.index.search(batch.identity, vector, context);
        result.matches.push(...found.matches.map((match) => ({ ...match, queryIndex })));
        result.stale += found.stale;
        result.truncated ||= found.truncated;
      });
      if (result.matches.length === 0) result.status = result.stale > 0 ? 'stale_index' : 'empty_index';
      return result;
    } catch (error) {
      return { ...empty, status: error instanceof EmbeddingError ? error.code : 'unavailable' };
    }
  }
}
