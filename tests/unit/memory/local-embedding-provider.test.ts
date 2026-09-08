import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMBEDDING_MODEL } from '../../../src/memory/embedding.js';
import { LocalEmbeddingProvider } from '../../../src/memory/local-embedding-provider.js';

const providers: LocalEmbeddingProvider[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const child of children.splice(0)) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
});

function createProvider(): LocalEmbeddingProvider {
  const provider = new LocalEmbeddingProvider('/synthetic/model', () => {
    const child = fork(new URL('../../fixtures/embedding-process.mjs', import.meta.url), [], {
      execArgv: [], env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(child);
    return child;
  });
  providers.push(provider);
  return provider;
}

describe('bounded local embedding process', () => {
  it('returns versioned normalized vectors and reuses exactly one local process', async () => {
    const provider = createProvider();
    const first = await provider.embed(['synthetic example', 'second example']);
    const second = await provider.embed(['follow-up']);
    expect(first.identity).toEqual({
      provider: 'local_transformers', model: EMBEDDING_MODEL,
      modelRevision: 'a'.repeat(64), dimensions: 384, indexVersion: 1,
    });
    expect(first.vectors.map((vector) => vector.length)).toEqual([384, 384]);
    expect(first.vectors[0]?.[0]).toBe(1);
    expect(second.identity).toEqual(first.identity);
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(first.peakRssBytes).toBeGreaterThan(0);
    expect(children).toHaveLength(1);
  });

  it('rejects oversized and empty inputs before starting any child', async () => {
    const provider = createProvider();
    for (const texts of [[], [''], [' '.repeat(2)], ['a'.repeat(2049)], Array<string>(9).fill('text')]) {
      await expect(provider.embed(texts)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    for (const timeoutMs of [0, 15_001, Number.NaN]) {
      await expect(provider.embed(['text'], { timeoutMs })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(children).toHaveLength(0);
  });

  it('bounds concurrent demand and terminates timed-out inference before allowing a retry', async () => {
    const provider = createProvider();
    const pending = provider.embed(['hang'], { timeoutMs: 150 });
    await expect(provider.embed(['other turn'])).rejects.toMatchObject({ code: 'busy' });
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    expect(children[0]?.signalCode).toBe('SIGKILL');
    await expect(provider.embed(['recovered'])).resolves.toMatchObject({ identity: { dimensions: 384 } });
    expect(children).toHaveLength(2);
  });

  it('cancels a running request, closes cleanly, and refuses further work', async () => {
    const provider = createProvider();
    const controller = new AbortController();
    const pending = provider.embed(['hang'], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(children[0]?.signalCode).toBe('SIGKILL');
    const next = provider.embed(['hang']);
    const assertion = expect(next).rejects.toMatchObject({ code: 'closed' });
    await provider.close();
    await assertion;
    await expect(provider.embed(['text'])).rejects.toMatchObject({ code: 'closed' });
  });

  it.each([
    ['wrong dimension', 'invalid_vector'], ['zero vector', 'invalid_vector'],
    ['failure', 'unavailable'], ['crash', 'unavailable'],
  ])('rejects %s without persisting or logging provider content', async (text, code) => {
    const provider = createProvider();
    await expect(provider.embed([text])).rejects.toMatchObject({ code, message: `Embedding ${code}` });
    await expect(provider.embed(['retry'])).resolves.toMatchObject({ identity: { dimensions: 384 } });
  });

  it('rejects an already cancelled request without creating a process', async () => {
    const provider = createProvider();
    await expect(provider.embed(['text'], { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(children).toHaveLength(0);
  });

  it('settles a failed process spawn that has no PID or exit event', async () => {
    const provider = new LocalEmbeddingProvider('/synthetic/model', () => fork(
      new URL('../../fixtures/embedding-process.mjs', import.meta.url), [], {
        execPath: '/missing-synthetic-node', execArgv: [], env: {},
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    ));
    const pending = provider.embed(['text']);
    const result = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise<string>((resolve) => setTimeout(() => resolve('did_not_settle'), 250)),
    ]);
    expect(result).toMatchObject({ code: 'unavailable' });
    await provider.close();
  });

  it('returns an unavailable result from the actual offline loader when local assets are missing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lethebot-missing-embedding-'));
    const provider = new LocalEmbeddingProvider(directory);
    providers.push(provider);
    try {
      await expect(provider.embed(['synthetic input'], { timeoutMs: 10_000 }))
        .rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      await provider.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
