const MAX_FTS_SOURCE_LENGTH = 4_096;
const MAX_FTS_TOKENS = 8;
const MAX_FTS_TOKEN_LENGTH = 64;

export function toSafeMemoryFtsQuery(text: string): string | undefined {
  const tokens = text
    .slice(0, MAX_FTS_SOURCE_LENGTH)
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawToken of tokens) {
    const token = rawToken.slice(0, MAX_FTS_TOKEN_LENGTH);
    if (token.length === 0 || seen.has(token)) {
      continue;
    }
    seen.add(token);
    normalized.push(token);
    if (normalized.length === MAX_FTS_TOKENS) {
      break;
    }
  }

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}
