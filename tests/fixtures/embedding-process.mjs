import process from 'node:process';

process.on('disconnect', () => process.exit(0));
process.on('message', ({ id, texts }) => {
  if (texts[0] === 'hang') return;
  if (texts[0] === 'crash') process.exit(1);
  if (texts[0] === 'failure') {
    process.send({ id, ok: false, code: 'unavailable' });
    return;
  }
  const vector = Array.from({ length: texts[0] === 'wrong dimension' ? 2 : 384 }, (_, index) => index === 0 ? 1 : 0);
  if (texts[0] === 'zero vector') vector.fill(0);
  process.send({
    id, ok: true, modelRevision: 'a'.repeat(64),
    vectors: texts.map(() => vector), peakRssBytes: 10 * 1024 ** 2,
  });
});
