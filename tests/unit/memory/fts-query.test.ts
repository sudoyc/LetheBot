import { describe, expect, it } from 'vitest';
import { toSafeMemoryFtsQuery } from '../../../src/memory/fts-query.js';

describe('toSafeMemoryFtsQuery', () => {
  it('quotes, deduplicates, and preserves bounded token order', () => {
    expect(toSafeMemoryFtsQuery('alpha beta alpha gamma')).toBe(
      '"alpha" OR "beta" OR "gamma"',
    );
  });

  it('treats FTS operators and punctuation only as quoted tokens', () => {
    expect(toSafeMemoryFtsQuery('alpha" OR beta* (gamma)')).toBe(
      '"alpha" OR "OR" OR "beta" OR "gamma"',
    );
  });

  it('returns no query when the input has no searchable token', () => {
    expect(toSafeMemoryFtsQuery('*** "" ()')).toBeUndefined();
  });
});
