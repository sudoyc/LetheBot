import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { LocalEmbeddingProvider } from '../memory/local-embedding-provider.js';
import { evaluateSemanticRecall } from '../operations/semantic-recall.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { 'model-directory': { type: 'string' }, out: { type: 'string' } },
  });
  const directory = values['model-directory'];
  if (!directory || !isAbsolute(directory)) throw new Error('An absolute --model-directory is required');
  const provider = new LocalEmbeddingProvider(directory);
  try {
    const report = await evaluateSemanticRecall(provider);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, output, { flag: 'wx', mode: 0o600 });
    process.stdout.write(output);
    if (!report.success) process.exitCode = 1;
  } finally {
    await provider.close();
  }
}

main().catch(() => {
  process.stderr.write('Semantic recall evaluation failed; check local model assets and explicit arguments.\n');
  process.exitCode = 1;
});
