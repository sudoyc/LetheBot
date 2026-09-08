import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { AutoModel, BertTokenizer, env, FeatureExtractionPipeline } from '@huggingface/transformers';
import { z } from 'zod';
import { EmbeddingError, MAX_EMBEDDING_BATCH, MAX_EMBEDDING_TEXT_LENGTH } from './embedding.js';

const inputSchema = z.object({
  id: z.number().int().positive(), modelDirectory: z.string().refine(isAbsolute),
  texts: z.array(z.string().trim().min(1).max(MAX_EMBEDDING_TEXT_LENGTH)).min(1).max(MAX_EMBEDDING_BATCH),
});
const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx'];
let extractor: FeatureExtractionPipeline | undefined;
let modelRevision: string | undefined;
let modelDirectory: string | undefined;
let running = false;

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFSCache = false;
env.useBrowserCache = false;
// This dedicated inference process must never fetch a model, tokenizer or user text.
globalThis.fetch = async () => { throw new EmbeddingError('unavailable'); };

async function fingerprintModel(directory: string): Promise<string> {
  const hash = createHash('sha256').update('lethebot-local-embedding-v1:transformers-4.2.0:mean:q8:128');
  for (const file of modelFiles) {
    const path = join(directory, file);
    const stats = lstatSync(path);
    const maxBytes = file.endsWith('.onnx') ? 130_000_000 : 32_000_000;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maxBytes) {
      throw new EmbeddingError('invalid_model');
    }
    hash.update(JSON.stringify([file, stats.size]));
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

process.on('disconnect', () => process.exit(0));
process.on('message', (message: unknown) => {
  void handleMessage(message);
});

async function handleMessage(message: unknown): Promise<void> {
  const parsed = inputSchema.safeParse(message);
  if (!parsed.success || running) { process.exit(1); }
  const input = parsed.data;
  running = true;
  try {
    if (!extractor) {
      modelDirectory = input.modelDirectory;
      modelRevision = await fingerprintModel(modelDirectory);
      const tokenizerConfig = z.record(z.string(), z.unknown()).parse(
        JSON.parse(readFileSync(join(modelDirectory, 'tokenizer_config.json'), 'utf8')),
      );
      if (tokenizerConfig.tokenizer_class !== 'BertTokenizer') throw new EmbeddingError('invalid_model');
      const tokenizerJson: unknown = JSON.parse(readFileSync(join(modelDirectory, 'tokenizer.json'), 'utf8'));
      const tokenizer = new BertTokenizer(tokenizerJson, { ...tokenizerConfig, model_max_length: 128 });
      const model = await AutoModel.from_pretrained(modelDirectory, {
        local_files_only: true, dtype: 'q8', device: 'cpu',
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' },
      });
      if (modelRevision !== await fingerprintModel(modelDirectory)) throw new EmbeddingError('invalid_model');
      extractor = new FeatureExtractionPipeline({ task: 'feature-extraction', model, tokenizer });
    }
    if (modelDirectory !== input.modelDirectory) throw new EmbeddingError('invalid_model');
    const tensor = await extractor(input.texts, { pooling: 'mean', normalize: true });
    process.send?.({
      id: input.id, ok: true, modelRevision, vectors: tensor.tolist(),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    });
  } catch (error) {
    process.send?.({ id: input.id, ok: false, code: error instanceof EmbeddingError ? error.code : 'unavailable' });
  } finally {
    running = false;
  }
}
