export const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_INDEX_VERSION = 1;
export const MAX_EMBEDDING_BATCH = 8;
export const MAX_EMBEDDING_TEXT_LENGTH = 2048;
export const MAX_EMBEDDING_TIMEOUT_MS = 15_000;

export interface EmbeddingIdentity {
  provider: 'local_transformers';
  model: string;
  modelRevision: string;
  dimensions: number;
  indexVersion: number;
}

export interface EmbeddingBatch {
  identity: EmbeddingIdentity;
  vectors: Float32Array[];
  durationMs: number;
  peakRssBytes: number;
}

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EmbeddingProvider {
  readonly identity?: EmbeddingIdentity;
  embed(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatch>;
  close(): Promise<void>;
}

export type EmbeddingErrorCode =
  | 'unavailable' | 'invalid_model' | 'invalid_vector' | 'invalid_input'
  | 'busy' | 'timeout' | 'cancelled' | 'closed';

export class EmbeddingError extends Error {
  constructor(readonly code: EmbeddingErrorCode) {
    super(`Embedding ${code}`);
    this.name = 'EmbeddingError';
  }
}

export function normalizedEmbedding(values: readonly number[], dimensions: number): Float32Array {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096
    || values.length !== dimensions || !values.every(Number.isFinite)) {
    throw new EmbeddingError('invalid_vector');
  }
  const magnitude = Math.hypot(...values);
  if (!Number.isFinite(magnitude) || magnitude < 1e-12) throw new EmbeddingError('invalid_vector');
  return Float32Array.from(values, (value) => value / magnitude);
}
