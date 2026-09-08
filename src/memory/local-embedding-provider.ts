import { fork, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  EMBEDDING_DIMENSIONS, EMBEDDING_INDEX_VERSION, EMBEDDING_MODEL,
  EmbeddingError, MAX_EMBEDDING_BATCH, MAX_EMBEDDING_TEXT_LENGTH, MAX_EMBEDDING_TIMEOUT_MS,
  normalizedEmbedding, type EmbeddingBatch, type EmbeddingIdentity, type EmbeddingProvider, type EmbeddingRequestOptions,
} from './embedding.js';

const replySchema = z.discriminatedUnion('ok', [
  z.object({
    id: z.number().int().positive(), ok: z.literal(true),
    modelRevision: z.string().regex(/^[0-9a-f]{64}$/),
    vectors: z.array(z.array(z.number().finite()).length(EMBEDDING_DIMENSIONS)).max(MAX_EMBEDDING_BATCH),
    peakRssBytes: z.number().int().nonnegative().max(2 * 1024 ** 3),
  }),
  z.object({
    id: z.number().int().positive(), ok: z.literal(false),
    code: z.enum(['unavailable', 'invalid_model', 'invalid_vector']),
  }),
]);

export class LocalEmbeddingProvider implements EmbeddingProvider {
  identity?: EmbeddingIdentity;
  private child?: ChildProcess;
  private busy = false;
  private closed = false;
  private nextId = 0;
  private cancelPending?: () => void;
  private stopping?: Promise<void>;

  constructor(
    private readonly modelDirectory: string,
    private readonly spawnProcess: () => ChildProcess = () => fork(
      new URL(import.meta.url.endsWith('.ts') ? './local-embedding-process.ts' : './local-embedding-process.js', import.meta.url),
      [],
      {
        execArgv: [
          '--max-old-space-size=256',
          ...(import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : []),
        ],
        env: { PATH: process.env.PATH, OMP_NUM_THREADS: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    ),
  ) {
    if (!isAbsolute(modelDirectory)) throw new EmbeddingError('invalid_input');
  }

  async embed(texts: string[], options: EmbeddingRequestOptions = {}): Promise<EmbeddingBatch> {
    if (this.closed) throw new EmbeddingError('closed');
    if (options.signal?.aborted) throw new EmbeddingError('cancelled');
    if (this.busy || this.stopping) throw new EmbeddingError('busy');
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EMBEDDING_TIMEOUT_MS
      || texts.length < 1 || texts.length > MAX_EMBEDDING_BATCH
      || texts.some((text) => typeof text !== 'string' || !text.trim() || text.length > MAX_EMBEDDING_TEXT_LENGTH)) {
      throw new EmbeddingError('invalid_input');
    }
    this.busy = true;
    const start = performance.now();
    try {
      const child = this.child ?? this.spawnProcess();
      this.child = child;
      const id = ++this.nextId;
      return await new Promise<EmbeddingBatch>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          child.off('message', onMessage);
          child.off('error', onError);
          child.off('exit', onError);
          this.cancelPending = undefined;
        };
        const fail = (error: EmbeddingError): void => {
          if (settled) return;
          settled = true;
          cleanup();
          void this.stopChild().then(() => reject(error));
        };
        const onAbort = (): void => fail(new EmbeddingError('cancelled'));
        const onError = (): void => fail(new EmbeddingError('unavailable'));
        const onMessage = (message: unknown): void => {
          const parsed = replySchema.safeParse(message);
          if (!parsed.success || parsed.data.id !== id) {
            fail(new EmbeddingError('invalid_vector'));
            return;
          }
          const reply = parsed.data;
          if (!reply.ok) {
            fail(new EmbeddingError(reply.code));
            return;
          }
          if (reply.vectors.length !== texts.length) {
            fail(new EmbeddingError('invalid_vector'));
            return;
          }
          try {
            const vectors = reply.vectors.map((values) => normalizedEmbedding(values, EMBEDDING_DIMENSIONS));
            settled = true;
            cleanup();
            this.identity = {
              provider: 'local_transformers', model: EMBEDDING_MODEL,
              modelRevision: reply.modelRevision, dimensions: EMBEDDING_DIMENSIONS,
              indexVersion: EMBEDDING_INDEX_VERSION,
            };
            resolve({
              identity: this.identity,
              vectors, durationMs: Math.round(performance.now() - start), peakRssBytes: reply.peakRssBytes,
            });
          } catch {
            fail(new EmbeddingError('invalid_vector'));
          }
        };
        const timer = setTimeout(() => fail(new EmbeddingError('timeout')), timeoutMs);
        this.cancelPending = () => fail(new EmbeddingError('closed'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.on('message', onMessage);
        child.once('error', onError);
        child.once('exit', onError);
        child.send({ id, modelDirectory: this.modelDirectory, texts }, (error) => { if (error) onError(); });
      });
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      await this.stopChild();
      throw new EmbeddingError('unavailable');
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelPending?.();
    await this.stopChild();
  }

  private stopChild(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    this.child = undefined;
    this.identity = undefined;
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    this.stopping = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
