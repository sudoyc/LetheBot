import { describe, expect, it } from 'vitest';
import { redactSecretsInText, scanMemoryForSecrets } from '../../../src/memory/secret-scan';

describe('secret-scan', () => {
  it('detects and redacts assignment-shaped credentials after structured key separators', () => {
    const rawSecret = 'sk-secret-scan-prefixed-assignment-secret';
    const rawText = `review_api_key=${rawSecret}`;

    const findings = scanMemoryForSecrets(rawText);
    const redacted = redactSecretsInText(rawText);

    expect(findings).toContainEqual({
      kind: 'secret',
      pattern: 'api_key_assignment',
    });
    expect(redacted.findings).toContainEqual({
      kind: 'secret',
      pattern: 'api_key_assignment',
    });
    expect(redacted.text).toBe('review_[REDACTED:api_key_assignment]');
    expect(redacted.text).not.toContain('api_key=');
    expect(redacted.text).not.toContain(rawSecret);
  });

  it('detects and redacts OpenAI-like tokens after non-alphanumeric separators', () => {
    const rawSecret = 'sk-secret-scan-token-after-separator';
    const rawText = `lookup_${rawSecret}`;

    const findings = scanMemoryForSecrets(rawText);
    const redacted = redactSecretsInText(rawText);

    expect(findings).toContainEqual({
      kind: 'secret',
      pattern: 'openai_like_api_key',
    });
    expect(redacted.text).toBe('lookup_[REDACTED:openai_like_api_key]');
    expect(redacted.text).not.toContain(rawSecret);
  });
});
