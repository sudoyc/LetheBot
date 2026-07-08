import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLocalAcceptanceEvidenceTemplate,
  validateLocalAcceptanceEvidence,
} from '../../../src/scripts/local-acceptance-evidence.js';

describe('local acceptance evidence template', () => {
  it('builds a redaction-first SnowLuma / QQ acceptance evidence template', () => {
    const template = buildLocalAcceptanceEvidenceTemplate({
      generatedAt: '2026-07-03T14:20:00.000Z',
    });

    expect(template).toContain('Generated at: 2026-07-03T14:20:00.000Z');
    expect(template).toContain('docker compose -f docker-compose.snowluma-framework.yml config --quiet');
    expect(template).toContain('curl http://localhost:6700/healthz');
    expect(template).toContain('curl http://localhost:6700/readyz');
    expect(template).toContain('curl http://localhost:6700/metrics');
    expect(template).toContain("curl 'http://localhost:6700/metrics?format=prometheus'");
    expect(template).toContain('pnpm verify:onebot');
    expect(template).toContain('pnpm ops:worker-soak');
    expect(template).toContain('PRAGMA foreign_key_check');
    expect(template).toContain('Private chat lifecycle evidence');
    expect(template).toContain('Group @bot lifecycle evidence');
    expect(template).toContain('Do not paste secrets, API keys');
    expect(template).toContain('Use counts or internal IDs only');
    expect(template).not.toMatch(/\b\d{8,12}\b/);
    expect(template).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);
  });

  it('prints the template without leaking secret-like environment values', () => {
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const secretToken = 'sk-local-acceptance-secret-should-not-leak';
    const privateQqId = '12345678901';
    const result = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ONEBOT_TOKEN: secretToken,
        PI_API_KEY: secretToken,
        LETHEBOT_BOT_QQ_ID: privateQqId,
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe('');
    expect(result.stdout).toContain('LetheBot Local SnowLuma / QQ Acceptance Evidence');
    expect(result.stdout).toContain('ONEBOT_TOKEN="${ONEBOT_TOKEN:-lethebot-local-token}"');
    expect(result.stdout).not.toContain(secretToken);
    expect(result.stdout).not.toContain(privateQqId);
  });

  it('validates generated template content as share-safe by default', () => {
    const template = buildLocalAcceptanceEvidenceTemplate({
      generatedAt: '2026-07-03T14:20:00.000Z',
    });

    expect(validateLocalAcceptanceEvidence(template)).toEqual({
      valid: true,
      findings: [],
    });
  });

  it('allows explicitly redacted authorization evidence but flags raw bearer tokens', () => {
    const safe = validateLocalAcceptanceEvidence(`
# Redacted auth evidence

Authorization: Bearer <redacted-token>
Authorization: <redacted>
ONEBOT_TOKEN=<redacted>
cookie: ***
`);
    expect(safe).toEqual({
      valid: true,
      findings: [],
    });

    const secretToken = 'sk-local-acceptance-secret-should-not-leak';
    const unsafe = validateLocalAcceptanceEvidence(`
# Unsafe auth evidence

Authorization: Bearer ${secretToken}
`);

    expect(unsafe.valid).toBe(false);
    expect(unsafe.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(['api-key-like-token', 'secret-assignment']),
    );
    expect(JSON.stringify(unsafe)).not.toContain(secretToken);
  });

  it('flags secret-like values, platform IDs, raw CQ tags, and raw message text without echoing values', () => {
    const secretToken = 'sk-local-acceptance-secret-should-not-leak';
    const privateQqId = '12345678901';
    const result = validateLocalAcceptanceEvidence(`
# Unsafe evidence

ONEBOT_TOKEN=${secretToken}
Authorization: Bearer ${secretToken}
private QQ ID: ${privateQqId}
raw group event: [CQ:at,qq=${privateQqId}]
raw message text: hello from the private chat
`);

    expect(result.valid).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        'api-key-like-token',
        'secret-assignment',
        'platform-id-like-number',
        'raw-cq-tag',
        'raw-message-text',
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(secretToken);
    expect(JSON.stringify(result)).not.toContain(privateQqId);
    expect(JSON.stringify(result)).not.toContain('hello from the private chat');
  });

  it('flags embedded API-key-like tokens in legacy identifiers without echoing values', () => {
    const secretToken = 'sk-local-acceptance-embedded-secret-should-not-leak';
    const privateQqId = '12345678901';
    const result = validateLocalAcceptanceEvidence(`
# Unsafe embedded evidence

operator_id: legacy_${secretToken}_qq-${privateQqId}
`);

    expect(result.valid).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(['api-key-like-token', 'platform-id-like-number']),
    );
    expect(JSON.stringify(result)).not.toContain(secretToken);
    expect(JSON.stringify(result)).not.toContain(privateQqId);
  });

  it('flags and redacts embedded numeric platform identifiers in legacy identifiers', () => {
    const privateQqId = '12345678901';
    const result = validateLocalAcceptanceEvidence(`
# Unsafe embedded platform identifier evidence

operator_id: legacy_${privateQqId}_local_fixture
`);

    expect(result.valid).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(['platform-id-like-number']),
    );
    expect(JSON.stringify(result)).not.toContain(privateQqId);

    const testDir = mkdtempSync(join(tmpdir(), `lethebot-acceptance-legacy_${privateQqId}_`));
    const safePath = join(testDir, 'safe.md');
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      writeFileSync(safePath, buildLocalAcceptanceEvidenceTemplate(), 'utf8');

      const validation = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', '--validate', safePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(validation.status, validation.stderr).toBe(0);
      expect(validation.stderr.trim()).toBe('');
      expect(validation.stdout).toContain('[REDACTED:platform_id]');
      expect(validation.stdout).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('redacts embedded prefixed platform identifiers in spawned CLI display paths', () => {
    const embeddedPrefixedPlatformId = 'legacy_qq-1234567890';
    const embeddedNumericPlatformId = 'legacy_987654321';
    const testDir = mkdtempSync(
      join(tmpdir(), `lethebot-acceptance-${embeddedPrefixedPlatformId}-${embeddedNumericPlatformId}-`),
    );
    const safePath = join(testDir, 'safe.md');
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      writeFileSync(safePath, buildLocalAcceptanceEvidenceTemplate(), 'utf8');

      const validation = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', '--validate', safePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });

      expect(validation.status, validation.stderr).toBe(0);
      expect(validation.stderr.trim()).toBe('');
      expect(validation.stdout).toContain('[REDACTED:platform_id]');
      expect(validation.stdout).not.toContain(embeddedPrefixedPlatformId);
      expect(validation.stdout).not.toContain(embeddedNumericPlatformId);
      expect(validation.stdout).not.toContain('legacy_qq-');
      expect(validation.stdout).not.toContain('1234567890');
      expect(validation.stdout).not.toContain('987654321');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('validates evidence files through the spawned CLI without leaking unsafe values', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-acceptance-validate-'));
    const safePath = join(testDir, 'safe.md');
    const unsafePath = join(testDir, 'unsafe.md');
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const secretToken = 'sk-local-acceptance-secret-should-not-leak';
    const privateQqId = '12345678901';

    try {
      writeFileSync(safePath, buildLocalAcceptanceEvidenceTemplate(), 'utf8');
      writeFileSync(
        unsafePath,
        `# Unsafe\nONEBOT_TOKEN=${secretToken}\nQQ ID: ${privateQqId}\nraw message text: private chat body`,
        'utf8',
      );

      const safe = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', '--validate', safePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(safe.status, safe.stderr).toBe(0);
      expect(safe.stderr.trim()).toBe('');
      expect(JSON.parse(safe.stdout) as { valid: boolean; findingCount: number }).toMatchObject({
        valid: true,
        findingCount: 0,
      });

      const unsafe = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', '--validate', unsafePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(unsafe.status).toBe(1);
      expect(unsafe.stderr.trim()).toBe('');
      expect(unsafe.stdout).toContain('"valid": false');
      expect(unsafe.stdout).toContain('"secret-assignment"');
      expect(unsafe.stdout).toContain('"platform-id-like-number"');
      expect(unsafe.stdout).toContain('"raw-message-text"');
      expect(unsafe.stdout).not.toContain(secretToken);
      expect(unsafe.stdout).not.toContain(privateQqId);
      expect(unsafe.stdout).not.toContain('private chat body');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('redacts sensitive evidence file paths through silent pnpm package scripts', () => {
    const secretToken = 'sk-local-acceptance-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const existingOutPath = join(testDir, `existing-${secretToken}-qq-${privateQqId}.md`);

    try {
      writeFileSync(existingOutPath, 'existing', 'utf8');

      const result = spawnSync(
        'pnpm',
        ['--silent', 'acceptance:evidence-template', '--', `--out=${existingOutPath}`],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe('');
      expect(result.stderr).toContain('Output file already exists');
      expect(result.stderr).toContain('[REDACTED:api_key_like_token]');
      expect(result.stderr).not.toContain(secretToken);
      expect(result.stderr).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('redacts missing evidence file paths in silent validate errors', () => {
    const secretToken = 'sk-local-acceptance-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const missingPath = join(testDir, `missing-${secretToken}-qq-${privateQqId}.md`);

    try {
      const result = spawnSync(
        'pnpm',
        ['--silent', 'acceptance:validate-evidence', '--', missingPath],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe('');
      expect(result.stderr).toContain('ENOENT');
      expect(result.stderr).toContain('[REDACTED:api_key_like_token]');
      expect(result.stderr).not.toContain(secretToken);
      expect(result.stderr).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('redacts sensitive evidence file paths in spawned CLI output and errors', () => {
    const secretToken = 'sk-local-acceptance-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const safePath = join(testDir, `safe-${privateQqId}.md`);
    const existingOutPath = join(testDir, `existing-${secretToken}-qq-${privateQqId}.md`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      writeFileSync(safePath, buildLocalAcceptanceEvidenceTemplate(), 'utf8');
      writeFileSync(existingOutPath, 'existing', 'utf8');

      const validation = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', '--validate', safePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(validation.status, validation.stderr).toBe(0);
      expect(validation.stderr.trim()).toBe('');
      const validationPayload = JSON.parse(validation.stdout) as {
        path: string;
        valid: boolean;
        findingCount: number;
      };
      expect(validationPayload).toMatchObject({
        valid: true,
        findingCount: 0,
      });
      expect(validationPayload.path).toContain('[REDACTED:api_key_like_token]');
      expect(validationPayload.path).toContain('[REDACTED:platform_id]');
      expect(validation.stdout).not.toContain(secretToken);
      expect(validation.stdout).not.toContain(privateQqId);

      const overwriteRefusal = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', `--out=${existingOutPath}`],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(overwriteRefusal.status).toBe(1);
      expect(overwriteRefusal.stdout.trim()).toBe('');
      expect(overwriteRefusal.stderr).toContain('Output file already exists');
      expect(overwriteRefusal.stderr).toContain('[REDACTED:api_key_like_token]');
      expect(overwriteRefusal.stderr).not.toContain(secretToken);
      expect(overwriteRefusal.stderr).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('redacts sensitive success paths while reading and writing raw evidence files', () => {
    const secretToken = 'sk-local-acceptance-success-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-acceptance-success-'));
    const sensitiveDir = join(testDir, `qq-${privateQqId}`);
    const evidencePath = join(sensitiveDir, `evidence-${secretToken}.md`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      mkdirSync(sensitiveDir, { recursive: true });

      const writeResult = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', '--out', evidencePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(writeResult.status, writeResult.stderr).toBe(0);
      expect(writeResult.stderr.trim()).toBe('');
      const writePayload = JSON.parse(writeResult.stdout) as { out: string; written: boolean };
      expect(writePayload.written).toBe(true);
      expect(writePayload.out).toContain('[REDACTED:api_key_like_token]');
      expect(writePayload.out).toContain('[REDACTED:platform_id]');
      expect(writeResult.stdout).not.toContain(secretToken);
      expect(writeResult.stdout).not.toContain(privateQqId);
      expect(existsSync(evidencePath)).toBe(true);
      expect(readFileSync(evidencePath, 'utf8')).toContain('LetheBot Local SnowLuma / QQ Acceptance Evidence');

      const validateResult = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', '--validate', evidencePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(validateResult.status, validateResult.stderr).toBe(0);
      expect(validateResult.stderr.trim()).toBe('');
      const validatePayload = JSON.parse(validateResult.stdout) as {
        path: string;
        valid: boolean;
        findingCount: number;
      };
      expect(validatePayload).toMatchObject({
        valid: true,
        findingCount: 0,
      });
      expect(validatePayload.path).toContain('[REDACTED:api_key_like_token]');
      expect(validatePayload.path).toContain('[REDACTED:platform_id]');
      expect(validateResult.stdout).not.toContain(secretToken);
      expect(validateResult.stdout).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('redacts adjacent secret/platform identifiers in spawned CLI output and errors', () => {
    const adjacentSecretPlatformId = 'sk-local-acceptance-adjacent-secret-qq-12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${adjacentSecretPlatformId}-`));
    const safePath = join(testDir, 'safe.md');
    const existingOutPath = join(testDir, `existing-${adjacentSecretPlatformId}.md`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      writeFileSync(safePath, buildLocalAcceptanceEvidenceTemplate(), 'utf8');
      writeFileSync(existingOutPath, 'existing', 'utf8');

      const validation = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', '--validate', safePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(validation.status, validation.stderr).toBe(0);
      expect(validation.stderr.trim()).toBe('');
      expect(validation.stdout).toContain('[REDACTED:api_key_like_token]');
      expect(validation.stdout).toContain('[REDACTED:platform_id]');
      expect(validation.stdout).not.toContain(adjacentSecretPlatformId);
      expect(validation.stdout).not.toContain('qq-12345678901');
      expect(validation.stdout).not.toContain('12345678901');

      const overwriteRefusal = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', `--out=${existingOutPath}`],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(overwriteRefusal.status).toBe(1);
      expect(overwriteRefusal.stdout.trim()).toBe('');
      expect(overwriteRefusal.stderr).toContain('Output file already exists');
      expect(overwriteRefusal.stderr).toContain('[REDACTED:api_key_like_token]');
      expect(overwriteRefusal.stderr).toContain('[REDACTED:platform_id]');
      expect(overwriteRefusal.stderr).not.toContain(adjacentSecretPlatformId);
      expect(overwriteRefusal.stderr).not.toContain('qq-12345678901');
      expect(overwriteRefusal.stderr).not.toContain('12345678901');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed CLI arguments without leaking sensitive values', () => {
    const secretToken = 'sk-local-acceptance-secret-should-not-leak';
    const privateQqId = '12345678901';
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const cases: Array<{
      args: string[];
      expectedMessage: string;
      expectedMarkers?: string[];
    }> = [
      {
        args: ['--out'],
        expectedMessage: 'Missing output file path after --out',
      },
      {
        args: ['--out='],
        expectedMessage: 'Missing output file path after --out',
      },
      {
        args: ['--validate='],
        expectedMessage: 'Missing evidence file path after --validate',
      },
      {
        args: ['--validate', `--unsafe-${secretToken}-qq-${privateQqId}`],
        expectedMessage: 'Missing evidence file path after --validate',
      },
      {
        args: [`--unexpected-${secretToken}-qq-${privateQqId}`],
        expectedMessage: 'Unknown option',
        expectedMarkers: ['[REDACTED:api_key_like_token]', '[REDACTED:platform_id]'],
      },
      {
        args: [`--unexpected-qq-${privateQqId}`],
        expectedMessage: 'Unknown option',
        expectedMarkers: ['[REDACTED:platform_id]'],
      },
      {
        args: [`unexpected-${secretToken}-qq-${privateQqId}`],
        expectedMessage: 'Unexpected positional argument',
        expectedMarkers: ['[REDACTED:api_key_like_token]', '[REDACTED:platform_id]'],
      },
      {
        args: [`unexpected-qq-${privateQqId}`],
        expectedMessage: 'Unexpected positional argument',
        expectedMarkers: ['[REDACTED:platform_id]'],
      },
    ];

    for (const testCase of cases) {
      const result = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', ...testCase.args], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe('');
      expect(result.stderr).toContain(testCase.expectedMessage);
      expect(result.stderr).not.toContain(secretToken);
      expect(result.stderr).not.toContain(privateQqId);

      for (const marker of testCase.expectedMarkers ?? []) {
        expect(result.stderr).toContain(marker);
      }
    }
  });

  it('writes to an explicit output path and refuses overwrite by default', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-acceptance-template-'));
    const outPath = join(testDir, 'acceptance-evidence.md');
    const spacedOutPath = join(testDir, 'acceptance-evidence-spaced.md');
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      const first = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', `--out=${outPath}`], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stderr.trim()).toBe('');
      expect(JSON.parse(first.stdout) as { written: boolean; out: string }).toEqual({
        written: true,
        out: outPath,
      });
      expect(existsSync(outPath)).toBe(true);
      expect(readFileSync(outPath, 'utf8')).toContain('Final acceptance decision');

      const spaced = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', '--out', spacedOutPath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(spaced.status, spaced.stderr).toBe(0);
      expect(spaced.stderr.trim()).toBe('');
      expect(JSON.parse(spaced.stdout) as { written: boolean; out: string }).toEqual({
        written: true,
        out: spacedOutPath,
      });
      expect(existsSync(spacedOutPath)).toBe(true);
      expect(readFileSync(spacedOutPath, 'utf8')).toContain('Final acceptance decision');

      const second = spawnSync(tsxBin, ['src/scripts/local-acceptance-evidence.ts', `--out=${outPath}`], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(second.status).toBe(1);
      expect(second.stdout.trim()).toBe('');
      expect(second.stderr).toContain(`Output file already exists: ${outPath}`);

      writeFileSync(outPath, 'existing', 'utf8');
      const overwrite = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', `--out=${outPath}`, '--overwrite'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(overwrite.status, overwrite.stderr).toBe(0);
      expect(readFileSync(outPath, 'utf8')).toContain('LetheBot Local SnowLuma / QQ Acceptance Evidence');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
