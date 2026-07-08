export interface SecretScanFinding {
  kind: 'secret' | 'prohibited';
  pattern: string;
}

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'openai_like_api_key', regex: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/ },
  { name: 'github_token', regex: /\bghp_[A-Za-z0-9_]{20,}\b/ },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  { name: 'aws_access_key_id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private_key_block', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'password_assignment', regex: /(?<![A-Za-z0-9])(?:password|passwd|pwd)\s*[:=]\s*['"]?\S{4,}/i },
  { name: 'api_key_assignment', regex: /(?<![A-Za-z0-9])api[_-]?key\s*[:=]\s*['"]?\S{4,}/i },
  {
    name: 'token_assignment',
    regex: /(?<![A-Za-z0-9])(?:access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*['"]?\S{8,}/i,
  },
  { name: 'cookie_assignment', regex: /(?<![A-Za-z0-9])cookie\s*[:=]\s*['"]?\S{8,}/i },
  {
    name: 'recovery_codes',
    regex: /(?<![A-Za-z0-9])recovery\s*codes?\s*[:=]\s*(?:[A-Z0-9-]{4,}[\s,;]*){2,}/i,
  },
];

export function scanMemoryForSecrets(text: string): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(text)) {
      findings.push({ kind: 'secret', pattern: pattern.name });
    }
  }

  return findings;
}

export interface SecretRedactionResult {
  text: string;
  findings: SecretScanFinding[];
}

export function redactSecretsInText(text: string): SecretRedactionResult {
  const findings: SecretScanFinding[] = [];
  let redacted = text;

  for (const pattern of SECRET_PATTERNS) {
    if (!pattern.regex.test(text)) {
      continue;
    }

    findings.push({ kind: 'secret', pattern: pattern.name });
    const globalRegex = new RegExp(
      pattern.regex.source,
      pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`
    );
    redacted = redacted.replace(globalRegex, `[REDACTED:${pattern.name}]`);
  }

  return { text: redacted, findings };
}
