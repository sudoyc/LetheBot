import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLocalAcceptanceEvidenceTemplate,
  summarizeLocalAcceptanceDatabase,
  validateLocalAcceptanceEvidence,
} from '../../../src/scripts/local-acceptance-evidence.js';
import { closeDatabase, initDatabase, runMigrations } from '../../../src/storage/database.js';

describe('local acceptance evidence template', () => {
  function buildCompleteRedactedEvidence(): string {
    return buildLocalAcceptanceEvidenceTemplate({
      generatedAt: '2026-07-03T14:20:00.000Z',
    })
      .replaceAll('- [ ]', '- [x]')
      .replace(/^\s{2}- \[x\] docker-compose\.local-acceptance\.yml$/m, '  - [ ] docker-compose.local-acceptance.yml')
      .replace(/^\s{2}- \[x\] mock$/m, '  - [ ] mock')
      .replace(/^\s{2}- \[x\] http$/m, '  - [ ] http')
      .replace('- [x] Not accepted; blocker is recorded above.', '- [ ] Not accepted; blocker is recorded above.')
      .replaceAll('<redacted-db-path-or-disposable-path>', 'internal-db-path')
      .replaceAll('<redacted-db-path>', 'internal-db-path')
      .replaceAll('<ok|degraded>', 'ok')
      .replaceAll('<true|false>', 'true')
      .replaceAll('<ready|not_ready>', 'ready')
      .replaceAll('<count/internal-id-only>', '3 internal rows')
      .replaceAll('<completed|failed>', 'completed')
      .replaceAll('<success|failed|rejected>', 'success')
      .replaceAll('<pass|fail>', 'pass')
      .replaceAll('<positive-number>', '1')
      .replaceAll('<verified|failed>', 'verified')
      .replaceAll('<milliseconds-at-most-15000>', '12000')
      .replaceAll('<number>', '0')
      .replaceAll('<redacted steps>', 'redacted local steps')
      .replaceAll('<fix|rerun|document local environment issue>', 'fix')
      .replaceAll('<redacted-or-internal-name>', 'internal-operator')
      .replaceAll('<YYYY-MM-DD>', '2026-07-08');
  }

  it('builds a redaction-first SnowLuma / QQ acceptance evidence template', () => {
    const template = buildLocalAcceptanceEvidenceTemplate({
      generatedAt: '2026-07-03T14:20:00.000Z',
    });

    expect(template).toContain('Generated at: 2026-07-03T14:20:00.000Z');
    expect(template).toContain(
      'docker compose --env-file /dev/null -f docker-compose.snowluma-framework.yml config --quiet',
    );
    expect(template).toContain(
      'docker compose --env-file /dev/null -f docker-compose.local-acceptance.yml config --quiet',
    );
    expect(template).toContain('curl http://localhost:6700/healthz');
    expect(template).toContain('curl http://localhost:6700/readyz');
    expect(template).toContain('curl http://localhost:6700/metrics');
    expect(template).toContain("curl 'http://localhost:6700/metrics?format=prometheus'");
    expect(template).toContain('pnpm verify:onebot');
    expect(template).toContain('pnpm ops:worker-soak');
    expect(template).toContain(
      'pnpm --silent acceptance:db-summary -- --db=<redacted-db-path> --require-acceptance-hints',
    );
    expect(template).toContain('docker-compose.local-acceptance.yml config exits 0');
    expect(template).toContain('docker-compose.snowluma-framework.yml config exits 0');
    expect(template).toContain('pnpm ops:worker-soak exits 0 with aggregate-only output');
    expect(template).toContain('sqlite3 PRAGMA foreign_key_check returns no rows');
    expect(template).toContain(
      'pnpm acceptance:db-summary exits 0 with aggregate-only DB evidence and required acceptance hints',
    );
    expect(template).toContain(
      'Required acceptance DB hints confirm one distinct same-group @bot-to-reply pair quoting the exact delivered bot response',
    );
    expect(template).toContain('pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md');
    expect(template).toContain('pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete');
    expect(template).toContain('PRAGMA foreign_key_check');
    expect(template).toContain('Private chat lifecycle evidence');
    expect(template).toContain('Group @bot lifecycle evidence');
    expect(template).toContain('real provider with explicit local credential injection');
    expect(template).toContain('agent_turns row exists with status: <completed|failed>');
    expect(template).toContain('Governed memory affects an allowed follow-up answer');
    expect(template).toContain('Evidence validator evidence');
    expect(template).toContain('Default validation is a heuristic scan');
    expect(template).toContain('Do not paste secrets, API keys');
    expect(template).toContain('Use counts or internal IDs only');
    expect(template).not.toMatch(/\b\d{8,12}\b/);
    expect(template).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);
  });

  it('names every R0-R8 TARGET_COMPLETE behavior gate in the evidence template', () => {
    const template = buildLocalAcceptanceEvidenceTemplate({
      generatedAt: '2026-07-03T14:20:00.000Z',
    });
    const scenarioIds = [
      'REL-CTX-01',
      'REL-CTX-02',
      'REL-QUOTE-01',
      'REL-QUOTE-02',
      'REL-ATT-01',
      'REL-ATT-02',
      'REL-ADMIN-01',
      'REL-EVAL-01',
      'REL-EVAL-02',
      'REL-MEM-01',
      'REL-MEM-02',
      'REL-MEM-03',
      'REL-GOV-01',
      'REL-RET-01',
      'REL-SCOPE-01',
    ];

    expect(template).toContain('R0 deterministic and release baseline');
    expect(template).toContain('- [ ] Scenario ID: R0');
    expect(template).toContain('- [ ] Scenario ID: REL-CTX-01');
    expect(template).toContain('  - Expected classification: pass');
    expect(template).toContain('  - Actual classification: <pass|fail>');
    expect(template).toContain('  - Checks passed: <positive-number>');
    expect(template).toContain('  - Checks total: <positive-number>');
    expect(template).toContain('  - Durable-chain evidence: <verified|failed>');
    expect(template).toContain('  - Scenario result: <pass|fail>');
    expect(template).toContain('  - Verification command: `pnpm release:check`');
    expect(template).toContain('R4 direct delivered-reply p95 milliseconds: <milliseconds-at-most-15000>');
    expect(template).toContain('15-second recheck');
    expect(template).toContain('120-second thread expiry');
    expect(template).toContain('human-answer cancellation');
    expect(template).toContain('traffic suppression');
    expect(template).toContain('two-reply budget');
    expect(template).toContain('summary default-off and exact-group authority');
    expect(template).toContain('immediate disable/cancel');
    expect(template).toContain('no-backfill re-enable');
    expect(template).toContain('restart recall');
    expect(template).toContain('Accepted for TARGET_COMPLETE local controlled QQ/SnowLuma acceptance.');
    for (const scenarioId of scenarioIds) {
      expect(template).toContain(`- [ ] Scenario ID: ${scenarioId}`);
    }
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

  it('supports opt-in complete acceptance validation without changing default share-safe validation', () => {
    const template = buildLocalAcceptanceEvidenceTemplate({
      generatedAt: '2026-07-03T14:20:00.000Z',
    });

    expect(validateLocalAcceptanceEvidence(template)).toEqual({
      valid: true,
      findings: [],
    });

    const incomplete = validateLocalAcceptanceEvidence(template, { requireComplete: true });
    expect(incomplete.valid).toBe(false);
    expect(incomplete.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        'incomplete-required-checklist',
        'acceptance-decision-missing',
        'operator-placeholder',
        'date-placeholder',
      ]),
    );

    const complete = validateLocalAcceptanceEvidence(buildCompleteRedactedEvidence(), { requireComplete: true });
    expect(complete).toEqual({
      valid: true,
      findings: [],
    });
  });

  it('requires every named R0-R8 behavior gate and the direct-reply latency bound', () => {
    const scenarioIds = [
      'REL-CTX-01',
      'REL-CTX-02',
      'REL-QUOTE-01',
      'REL-QUOTE-02',
      'REL-ATT-01',
      'REL-ATT-02',
      'REL-ADMIN-01',
      'REL-EVAL-01',
      'REL-EVAL-02',
      'REL-MEM-01',
      'REL-MEM-02',
      'REL-MEM-03',
      'REL-GOV-01',
      'REL-RET-01',
      'REL-SCOPE-01',
    ];

    const missingR0 = buildCompleteRedactedEvidence().replace(
      '- [x] Scenario ID: R0',
      '- [ ] Scenario ID: R0',
    );
    expect(validateLocalAcceptanceEvidence(missingR0, { requireComplete: true }).findings
      .map((finding) => finding.ruleId)).toContain('incomplete-required-checklist');

    for (const scenarioId of scenarioIds) {
      const missing = buildCompleteRedactedEvidence().replace(
        new RegExp(`^- \\[x\\] Scenario ID: ${scenarioId.replaceAll('-', '\\-')}$`, 'm'),
        `- [ ] Scenario ID: ${scenarioId}`,
      );
      const result = validateLocalAcceptanceEvidence(missing, { requireComplete: true });
      expect(result.valid, scenarioId).toBe(false);
      expect(result.findings.map((finding) => finding.ruleId), scenarioId).toContain(
        'incomplete-required-checklist',
      );
    }

    const missingLatency = buildCompleteRedactedEvidence().replace(
      '- [x] R4 direct delivered-reply p95 milliseconds:',
      '- [ ] R4 direct delivered-reply p95 milliseconds:',
    );
    expect(validateLocalAcceptanceEvidence(missingLatency, { requireComplete: true }).findings
      .map((finding) => finding.ruleId)).toContain('incomplete-required-checklist');

    const slow = buildCompleteRedactedEvidence().replace(
      'R4 direct delivered-reply p95 milliseconds: 12000',
      'R4 direct delivered-reply p95 milliseconds: 15001',
    );
    const slowResult = validateLocalAcceptanceEvidence(slow, { requireComplete: true });
    expect(slowResult.valid).toBe(false);
    expect(slowResult.findings.map((finding) => finding.ruleId)).toContain(
      'invalid-complete-latency',
    );
  });

  it.each([
    {
      label: 'failed actual classification',
      from: '  - Actual classification: pass',
      to: '  - Actual classification: fail',
    },
    {
      label: 'zero checks passed',
      from: '  - Checks passed: 1',
      to: '  - Checks passed: 0',
    },
    {
      label: 'unequal check counts',
      from: '  - Checks total: 1',
      to: '  - Checks total: 2',
    },
    {
      label: 'failed durable chain',
      from: '  - Durable-chain evidence: verified',
      to: '  - Durable-chain evidence: failed',
    },
    {
      label: 'failed scenario result',
      from: '  - Scenario result: pass',
      to: '  - Scenario result: fail',
    },
  ])('rejects $label in structured scenario evidence', ({ from, to }) => {
    const evidence = buildCompleteRedactedEvidence().replace(from, to);
    expect(evidence).toContain(to);

    const result = validateLocalAcceptanceEvidence(evidence, { requireComplete: true });

    expect(result.valid).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toContain(
      'invalid-complete-scenario-evidence',
    );
  });

  it.each([
    '/healthz eventProcessing counts are present and count-only.',
    '/readyz omits adapter URLs, DB paths, raw errors, raw events, message IDs, sender IDs, raw messages, tokens, QQ IDs, and group IDs.',
    '/metrics contains job/action/context/tool/event-failure counts.',
  ])('requires checked complete evidence for %s', (item) => {
    const evidence = buildCompleteRedactedEvidence().replace(`- [x] ${item}`, `- [ ] ${item}`);

    const result = validateLocalAcceptanceEvidence(evidence, { requireComplete: true });

    expect(result.valid).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toContain(
      'incomplete-required-checklist',
    );
  });

  it.each([
    {
      label: 'non-calendar acceptance date',
      from: 'Date: 2026-07-08',
      to: 'Date: 2026-02-31',
    },
    {
      label: 'non-calendar generated timestamp',
      from: 'Generated at: 2026-07-03T14:20:00.000Z',
      to: 'Generated at: 2026-02-31T14:20:00.000Z',
    },
    {
      label: 'out-of-range generated timestamp',
      from: 'Generated at: 2026-07-03T14:20:00.000Z',
      to: 'Generated at: 2026-07-03T25:20:00.000Z',
    },
    {
      label: 'numeric internal ID',
      from: '- [x] raw_events row exists: 3 internal rows',
      to: '- [x] raw_events row exists: internal-id:13579',
    },
    {
      label: 'QQ-like tmp basename',
      from: '  - [x] internal-db-path',
      to: '  - [x] /tmp/13579.db',
    },
  ])('rejects $label in complete evidence', ({ from, to }) => {
    const evidence = buildCompleteRedactedEvidence().replace(from, to);
    expect(evidence).toContain(to);

    const result = validateLocalAcceptanceEvidence(evidence, { requireComplete: true });

    expect(result.valid).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toContain(
      'unrecognized-complete-content',
    );
  });

  it('rejects unrecognized appended content only for complete evidence', () => {
    const appended = `${buildCompleteRedactedEvidence()}unlabeled private chat fixture\n1234567\n`;

    expect(validateLocalAcceptanceEvidence(appended)).toEqual({
      valid: true,
      findings: [],
    });
    const complete = validateLocalAcceptanceEvidence(appended, { requireComplete: true });
    expect(complete.valid).toBe(false);
    expect(complete.findings.map((finding) => finding.ruleId)).toContain(
      'unrecognized-complete-content',
    );
    expect(JSON.stringify(complete)).not.toContain('unlabeled private chat fixture');
    expect(JSON.stringify(complete)).not.toContain('1234567');
  });

  it.each([
    {
      label: 'free-form reproduction text',
      from: '- [x] Reproduction path: redacted local steps',
      to: '- [x] Reproduction path: private sentence copied from chat',
    },
    {
      label: 'raw reproduction text behind a redacted prefix',
      from: '- [x] Reproduction path: redacted local steps',
      to: '- [x] Reproduction path: redacted private sentence from chat',
    },
    {
      label: 'user home database path',
      from: '  - [x] internal-db-path',
      to: '  - [x] /home/private-user/acceptance.db',
    },
    {
      label: 'free-form row evidence',
      from: '- [x] raw_events row exists: 3 internal rows',
      to: '- [x] raw_events row exists: private sentence copied from chat',
    },
    {
      label: 'nonnumeric failure count',
      from: '- [x] /healthz eventProcessing failure count: 0',
      to: '- [x] /healthz eventProcessing failure count: not-a-number',
    },
    {
      label: 'free-form next action',
      from: '- [x] Next action: fix',
      to: '- [x] Next action: private follow-up details',
    },
    {
      label: 'unredacted operator name',
      from: 'Operator: internal-operator',
      to: 'Operator: Private User Name',
    },
    {
      label: 'operator name behind a redacted prefix',
      from: 'Operator: internal-operator',
      to: 'Operator: redacted Private User Name',
    },
    {
      label: 'free-form date',
      from: 'Date: 2026-07-08',
      to: 'Date: next Tuesday',
    },
  ])('rejects $label in a bounded complete-evidence field', ({ from, to }) => {
    const evidence = buildCompleteRedactedEvidence().replace(from, to);
    expect(evidence).toContain(to);

    const result = validateLocalAcceptanceEvidence(evidence, { requireComplete: true });

    expect(result.valid).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toContain(
      'unrecognized-complete-content',
    );
    expect(JSON.stringify(result)).not.toContain(to);
  });

  it('requires a real provider only for complete acceptance validation', () => {
    const mockEvidence = buildCompleteRedactedEvidence()
      .replace(/^\s{2}- \[ \] mock$/m, '  - [x] mock')
      .replace(
        /^\s{2}- \[x\] real provider with explicit local credential injection$/m,
        '  - [ ] real provider with explicit local credential injection',
      );

    expect(validateLocalAcceptanceEvidence(mockEvidence)).toEqual({
      valid: true,
      findings: [],
    });
    expect(validateLocalAcceptanceEvidence(mockEvidence, { requireComplete: true })).toMatchObject({
      valid: false,
      findings: [
        {
          ruleId: 'real-provider-required',
        },
      ],
    });

    const fixedMockComposeEvidence = buildCompleteRedactedEvidence()
      .replace(
        /^\s{2}- \[x\] docker-compose\.snowluma-framework\.yml$/m,
        '  - [ ] docker-compose.snowluma-framework.yml',
      )
      .replace(
        /^\s{2}- \[ \] docker-compose\.local-acceptance\.yml$/m,
        '  - [x] docker-compose.local-acceptance.yml',
      );
    expect(validateLocalAcceptanceEvidence(fixedMockComposeEvidence)).toEqual({
      valid: true,
      findings: [],
    });
    const fixedMockComposeResult = validateLocalAcceptanceEvidence(fixedMockComposeEvidence, {
      requireComplete: true,
    });
    expect(fixedMockComposeResult.valid).toBe(false);
    expect(fixedMockComposeResult.findings.map((finding) => finding.ruleId)).toContain(
      'real-provider-compose-required',
    );
  });

  it('rejects conflicting or placeholder complete acceptance decisions without echoing values', () => {
    const completeEvidence = buildCompleteRedactedEvidence();
    const conflict = validateLocalAcceptanceEvidence(
      completeEvidence.replace('- [ ] Not accepted; blocker is recorded above.', '- [x] Not accepted; blocker is recorded above.'),
      { requireComplete: true },
    );
    expect(conflict.valid).toBe(false);
    expect(conflict.findings.map((finding) => finding.ruleId)).toContain('acceptance-decision-conflict');

    const placeholder = validateLocalAcceptanceEvidence(
      completeEvidence.replace(
        '- [x] raw_events row exists: 3 internal rows',
        '- [x] raw_events row exists: <count/internal-id-only>',
      ),
      { requireComplete: true },
    );
    expect(placeholder.valid).toBe(false);
    expect(placeholder.findings.map((finding) => finding.ruleId)).toContain('placeholder-value');
    expect(JSON.stringify(placeholder)).not.toContain('3 internal rows');
  });

  it('requires exactly one runtime configuration option in each complete acceptance group', () => {
    const base = buildCompleteRedactedEvidence();
    const conflicting = validateLocalAcceptanceEvidence(
      base
        .replace(/^\s{2}- \[ \] docker-compose\.local-acceptance\.yml$/m, '  - [x] docker-compose.local-acceptance.yml')
        .replace(/^\s{2}- \[ \] mock$/m, '  - [x] mock')
        .replace(/^\s{2}- \[ \] http$/m, '  - [x] http'),
      { requireComplete: true },
    );

    expect(conflicting.valid).toBe(false);
    expect(conflicting.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(['exclusive-option-conflict']),
    );
    expect(conflicting.findings.filter((finding) => finding.ruleId === 'exclusive-option-conflict')).toHaveLength(3);

    const missing = validateLocalAcceptanceEvidence(
      base
        .replace(/^\s{2}- \[x\] docker-compose\.snowluma-framework\.yml$/m, '  - [ ] docker-compose.snowluma-framework.yml')
        .replace(
          /^\s{2}- \[x\] real provider with explicit local credential injection$/m,
          '  - [ ] real provider with explicit local credential injection',
        )
        .replace(/^\s{2}- \[x\] ws$/m, '  - [ ] ws'),
      { requireComplete: true },
    );

    expect(missing.valid).toBe(false);
    expect(missing.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(['exclusive-option-missing']),
    );
    expect(missing.findings.filter((finding) => finding.ruleId === 'exclusive-option-missing')).toHaveLength(3);
  });

  it('rejects checked completion evidence with failed or degraded status values', () => {
    const completeEvidence = buildCompleteRedactedEvidence();
    const failedEvidence = completeEvidence
      .replace('- [x] /healthz status: ok', '- [x] /healthz status: degraded')
      .replace('- [x] /healthz adapter ready: true', '- [x] /healthz adapter ready: false')
      .replace('- [x] /readyz readiness status: ready.', '- [x] /readyz readiness status: not_ready.')
      .replace('- [x] agent_turns row exists with status: completed', '- [x] agent_turns row exists with status: failed')
      .replace('- [x] action_executions row exists with status: success', '- [x] action_executions row exists with status: rejected');

    const result = validateLocalAcceptanceEvidence(failedEvidence, { requireComplete: true });

    expect(result.valid).toBe(false);
    const invalidStatusFindings = result.findings.filter(
      (finding) => finding.ruleId === 'invalid-complete-status',
    );
    expect(invalidStatusFindings.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(result)).not.toContain('degraded');
    expect(JSON.stringify(result)).not.toContain('not_ready');
    expect(JSON.stringify(result)).not.toContain('failed');
    expect(JSON.stringify(result)).not.toContain('rejected');
  });

  it('requires governed-memory and privacy evidence for complete acceptance', () => {
    const incomplete = validateLocalAcceptanceEvidence(
      buildCompleteRedactedEvidence()
        .replace(
          '- [x] Governed memory affects an allowed follow-up answer without cross-scope or private-in-group leakage.',
          '- [ ] Governed memory affects an allowed follow-up answer without cross-scope or private-in-group leakage.',
        )
        .replace(
          '- [x] Group-derived user memory remains conservative and source-linked to group_chat when applicable.',
          '- [ ] Group-derived user memory remains conservative and source-linked to group_chat when applicable.',
        )
        .replace(
          '- [x] User/admin can inspect relevant memory through governance CLI with redaction.',
          '- [ ] User/admin can inspect relevant memory through governance CLI with redaction.',
        ),
      { requireComplete: true },
    );

    expect(incomplete.valid).toBe(false);
    const missingChecklist = incomplete.findings.filter(
      (finding) => finding.ruleId === 'incomplete-required-checklist',
    );
    expect(missingChecklist.length).toBeGreaterThanOrEqual(3);
  });

  it('requires command preflight and aggregate worker evidence for complete acceptance', () => {
    const incomplete = validateLocalAcceptanceEvidence(
      buildCompleteRedactedEvidence()
        .replace(
          '- [x] docker-compose.local-acceptance.yml config exits 0.',
          '- [ ] docker-compose.local-acceptance.yml config exits 0.',
        )
        .replace(
          '- [x] docker-compose.snowluma-framework.yml config exits 0.',
          '- [ ] docker-compose.snowluma-framework.yml config exits 0.',
        )
        .replace(
          '- [x] pnpm ops:worker-soak exits 0 with aggregate-only output.',
          '- [ ] pnpm ops:worker-soak exits 0 with aggregate-only output.',
        )
        .replace(
          '- [x] sqlite3 PRAGMA foreign_key_check returns no rows for the acceptance DB.',
          '- [ ] sqlite3 PRAGMA foreign_key_check returns no rows for the acceptance DB.',
        )
        .replace(
          '- [x] pnpm acceptance:db-summary exits 0 with aggregate-only DB evidence and required acceptance hints.',
          '- [ ] pnpm acceptance:db-summary exits 0 with aggregate-only DB evidence and required acceptance hints.',
        ),
      { requireComplete: true },
    );

    expect(incomplete.valid).toBe(false);
    const missingChecklist = incomplete.findings.filter(
      (finding) => finding.ruleId === 'incomplete-required-checklist',
    );
    expect(missingChecklist.length).toBeGreaterThanOrEqual(5);
  });

  it('summarizes an acceptance database with aggregate-only redacted evidence', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const genericSecret = 'plain-local-credential-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(
      join(tmpdir(), `lethebot-token=${genericSecret}-`),
    );
    const dbPath = join(testDir, `acceptance-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        generatedAt: '2026-07-08T09:00:00.000Z',
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          rawEvents: 7,
          chatMessages: {
            total: 7,
            private: 3,
            group: 4,
          },
          contextTraces: {
            total: 3,
            private: 1,
            group: 2,
          },
          agentTurns: {
            total: 3,
            completed: 3,
          },
          actionExecutions: {
            total: 3,
            success: 3,
          },
          memoryRecords: {
            total: 2,
            active: 1,
            proposed: 1,
            secretOrProhibited: 0,
          },
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 1,
          conservativeGroupDerivedUserMemories: 1,
          toolCalls: {
            total: 3,
            success: 1,
            error: 1,
            timeout: 0,
            rejected: 1,
            other: 0,
          },
          reviewedToolExecutions: 1,
          eventProcessingFailures: 1,
          auditLog: 2,
          acceptanceFlows: {
            private: {
              chatMessages: 3,
              contextTraces: 1,
              completedTurns: 1,
              successfulActions: 1,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
              completeLinkedTargetedFlows: 1,
              completeNonMockLinkedTargetedFlows: 1,
            },
            group: {
              chatMessages: 4,
              contextTraces: 2,
              completedTurns: 2,
              successfulActions: 2,
              completeLinkedFlows: 2,
              completeLinkedChatFlows: 2,
              completeLinkedReplyFlows: 2,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 2,
              completeLinkedTargetedFlows: 1,
              completeNonMockLinkedReplyToBotFlows: 1,
              completeNonMockLinkedTargetedFlows: 1,
              completeNonMockLinkedMentionReplyPairs: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          completedTurnsPresent: true,
          successfulActionsPresent: true,
          contextTraceRowsPresent: true,
          privateCompletedTurnPresent: true,
          groupCompletedTurnPresent: true,
          privateSuccessfulActionPresent: true,
          groupSuccessfulActionPresent: true,
          privateContextTracePresent: true,
          groupContextTracePresent: true,
          privateCompleteLinkedFlowPresent: true,
          groupCompleteLinkedFlowPresent: true,
          privateCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedChatFlowPresent: true,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          privateCompleteLinkedTargetedFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: true,
          privateNonMockCompleteLinkedTargetedFlowPresent: true,
          groupNonMockCompleteLinkedTargetedFlowPresent: true,
          groupNonMockCompleteLinkedReplyToBotFlowPresent: true,
          groupNonMockCompleteLinkedMentionReplyPairPresent: true,
          reviewedToolExecutionPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: true,
          conservativeGroupDerivedUserMemoryPresent: true,
          foreignKeysClean: true,
        },
      });
      const serialized = JSON.stringify(summary);
      expect(summary.dbPath).toContain('[REDACTED:api_key_like_token]');
      expect(summary.dbPath).toContain('[REDACTED:secret_assignment]');
      expect(summary.dbPath).toContain('[REDACTED:platform_id]');
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(genericSecret);
      expect(serialized).not.toContain(privateQqId);
      expect(serialized).not.toContain('private acceptance text');
      expect(serialized).not.toContain('group acceptance text');
      expect(serialized).not.toContain('private bot response');
      expect(serialized).not.toContain('group bot response');

      const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status, spawned.stderr).toBe(0);
      expect(spawned.stderr.trim()).toBe('');
      const spawnedSummary = JSON.parse(spawned.stdout) as { dbPath: string; counts: { rawEvents: number } };
      expect(spawnedSummary.counts.rawEvents).toBe(7);
      expect(spawnedSummary.dbPath).toContain('[REDACTED:api_key_like_token]');
      expect(spawnedSummary.dbPath).toContain('[REDACTED:secret_assignment]');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(genericSecret);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('private bot response');
      expect(spawned.stdout).not.toContain('group bot response');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('redacts generic home-directory paths from successful DB summary display', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-acceptance-home-path-'));
    const privateUserSegment = 'private-local-operator';
    const homeLikeDir = join(testDir, 'home', privateUserSegment, 'private-project');
    const dbPath = join(homeLikeDir, 'acceptance.db');

    try {
      mkdirSync(homeLikeDir, { recursive: true });
      seedAcceptanceSummaryDatabase(
        dbPath,
        'fixture-secret-value',
        'fixture-platform-value',
      );

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.dbPath).toContain('[REDACTED:home_path]');
      expect(summary.dbPath).not.toContain(privateUserSegment);
      expect(summary.dbPath).not.toContain('private-project');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('accepts a linked completed correction invocation as reviewed tool evidence', () => {
    const secretToken = 'sk-local-acceptance-correction-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-acceptance-correction-'));
    const dbPath = join(testDir, 'acceptance-correction.db');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      const db = initDatabase({ path: dbPath });
      try {
        db.prepare(
          `UPDATE model_invocations
              SET call_number = 2
            WHERE id = 'acceptance-tool-evaluator-invocation'`,
        ).run();
        const timestamp = db.prepare(
          `SELECT started_at FROM model_invocations
           WHERE id = 'acceptance-tool-evaluator-invocation'`,
        ).pluck().get() as number;
        db.prepare(
          `INSERT INTO model_invocations (
            id, turn_id, job_attempt_id, context_id, purpose,
            evaluator_request_id, evaluator_domain, prompt_version, call_number,
            provider, model, status, started_at, completed_at,
            tokens_input, tokens_output, tokens_total,
            response_sha256, response_bytes, error_code
          ) VALUES ('acceptance-tool-evaluator-invocation-first',
                    'acceptance-private-turn', NULL, NULL, 'evaluator',
                    'acceptance-tool-evaluator-request', 'tool', 'acceptance-v1', 1,
                    'deepseek', 'deepseek-chat', 'failed', ?, ?,
                    NULL, NULL, NULL, NULL, NULL, 'invalid_structured_output')`,
        ).run(timestamp, timestamp);
        db.prepare(
          `INSERT INTO model_invocation_sources (
            model_invocation_id, raw_event_id, source_ordinal
          ) VALUES ('acceptance-tool-evaluator-invocation-first',
                    'acceptance-private-raw', 0)`,
        ).run();
        expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
        expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        closeDatabase(db);
      }

      const summary = summarizeLocalAcceptanceDatabase(
        dbPath,
        '2026-07-08T09:00:00.000Z',
      );
      expect(summary.counts.reviewedToolExecutions).toBe(1);
      expect(summary.evidenceHints.reviewedToolExecutionPresent).toBe(true);
      expect(JSON.stringify(summary)).not.toContain(secretToken);
      expect(JSON.stringify(summary)).not.toContain(privateQqId);

      const invalidDb = initDatabase({ path: dbPath });
      try {
        invalidDb.prepare(
          `UPDATE model_invocations
              SET started_at = (
                SELECT request_created_at - 1
                FROM evaluator_decisions
                WHERE id = 'acceptance-tool-evaluator'
              )
            WHERE id = 'acceptance-tool-evaluator-invocation-first'`,
        ).run();
      } finally {
        closeDatabase(invalidDb);
      }
      const invalidSummary = summarizeLocalAcceptanceDatabase(
        dbPath,
        '2026-07-08T09:00:00.000Z',
      );
      expect(invalidSummary.counts.reviewedToolExecutions).toBe(0);
      expect(invalidSummary.evidenceHints.reviewedToolExecutionPresent).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'the runtime mock identity', provider: 'mock', model: 'mock' },
    { label: 'a mock-prefixed identity', provider: 'mock-v1', model: 'mock-pi' },
    { label: 'a stub-prefixed model identity', provider: 'deepseek', model: 'stub-model' },
    { label: 'a control-whitespace identity', provider: '\t\r\n', model: '\t' },
  ])('requires every targeted acceptance flow to reject $label', ({ provider, model }) => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `mock-required-flow-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      const db = initDatabase({ path: dbPath });
      try {
        db.prepare(
          `UPDATE agent_turns
              SET pi_provider = ?, pi_model = ?
            WHERE id = ?`,
        ).run(provider, model, 'acceptance-group-reply-turn');
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        closeDatabase(db);
      }

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.acceptanceFlows.group).toMatchObject({
        completeNonMockLinkedTargetedFlows: 1,
        completeNonMockLinkedReplyToBotFlows: 0,
      });
      expect(summary.evidenceHints).toMatchObject({
        privateNonMockCompleteLinkedTargetedFlowPresent: true,
        groupNonMockCompleteLinkedTargetedFlowPresent: true,
        groupNonMockCompleteLinkedReplyToBotFlowPresent: false,
        reviewedToolExecutionPresent: true,
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupNonMockCompleteLinkedReplyToBotFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('does not treat a fabricated evaluator version as completed Provider evidence', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `version-only-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId, {
        linkEvaluatorInvocation: false,
      });

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.reviewedToolExecutions).toBe(0);
      expect(summary.evidenceHints.reviewedToolExecutionPresent).toBe(false);

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"reviewedToolExecutionPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'a stub evaluator version',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET evaluator_version = ? WHERE id = ?').run(
          'stub-v1',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'an empty evaluator version',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET evaluator_version = ? WHERE id = ?').run(
          '\t\r\n',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'a mock-prefixed evaluator version',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET evaluator_version = ? WHERE id = ?').run(
          'mock-v1',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'a missing completed invocation link',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET model_invocation_id = NULL WHERE id = ?').run(
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'a non-terminal evaluator invocation',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare(
          `UPDATE model_invocations
              SET status = 'running', completed_at = NULL,
                  tokens_input = NULL, tokens_output = NULL, tokens_total = NULL,
                  response_sha256 = NULL, response_bytes = NULL, error_code = NULL
            WHERE id = ?`,
        ).run('acceptance-tool-evaluator-invocation');
      },
    },
    {
      label: 'an invocation bound to a different evaluator request',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE model_invocations SET evaluator_request_id = ? WHERE id = ?').run(
          'different-evaluator-request',
          'acceptance-tool-evaluator-invocation',
        );
      },
    },
    {
      label: 'an invocation bound to a different evaluator domain',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE model_invocations SET evaluator_domain = ? WHERE id = ?').run(
          'social',
          'acceptance-tool-evaluator-invocation',
        );
      },
    },
    {
      label: 'an invocation bound to a different turn',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE model_invocations SET turn_id = ? WHERE id = ?').run(
          'acceptance-group-turn',
          'acceptance-tool-evaluator-invocation',
        );
      },
    },
    {
      label: 'a mock evaluator invocation provider',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE model_invocations SET provider = ? WHERE id = ?').run(
          'mock-provider',
          'acceptance-tool-evaluator-invocation',
        );
        db.prepare('UPDATE evaluator_decisions SET evaluator_version = ? WHERE id = ?').run(
          'mock-provider/deepseek-chat/acceptance-v1',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'a stub evaluator invocation model',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE model_invocations SET model = ? WHERE id = ?').run(
          'stub-model',
          'acceptance-tool-evaluator-invocation',
        );
        db.prepare('UPDATE evaluator_decisions SET evaluator_version = ? WHERE id = ?').run(
          'deepseek/stub-model/acceptance-v1',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'an invocation with a mismatched prompt identity',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE model_invocations SET prompt_version = ? WHERE id = ?').run(
          'different-prompt',
          'acceptance-tool-evaluator-invocation',
        );
      },
    },
    {
      label: 'an invocation completed after the evaluator decision',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        const late = Date.UTC(2026, 6, 8, 10, 0, 0);
        db.prepare(
          'UPDATE model_invocations SET started_at = ?, completed_at = ? WHERE id = ?',
        ).run(late, late, 'acceptance-tool-evaluator-invocation');
      },
    },
    {
      label: 'an invocation missing its exact evaluator source',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('DELETE FROM model_invocation_sources WHERE model_invocation_id = ?').run(
          'acceptance-tool-evaluator-invocation',
        );
      },
    },
    {
      label: 'an invocation with an extra evaluator source',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare(
          `INSERT INTO model_invocation_sources (
            model_invocation_id, raw_event_id, source_ordinal
          ) VALUES (?, ?, 1)`,
        ).run('acceptance-tool-evaluator-invocation', 'acceptance-group-raw');
      },
    },
    {
      label: 'an invocation with reordered evaluator sources',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare(
          `INSERT INTO model_invocation_sources (
            model_invocation_id, raw_event_id, source_ordinal
          ) VALUES (?, ?, 1)`,
        ).run('acceptance-tool-evaluator-invocation', 'acceptance-group-raw');
        db.prepare('UPDATE evaluator_decisions SET source_event_ids = ? WHERE id = ?').run(
          JSON.stringify(['acceptance-group-raw', 'acceptance-private-raw']),
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'malformed evaluator source JSON',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET source_event_ids = ? WHERE id = ?').run(
          '{malformed',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'a rejected evaluator decision',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET decision = ? WHERE id = ?').run(
          'reject',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'a prohibited evaluator decision',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET risk_level = ? WHERE id = ?').run(
          'prohibited',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'a missing tool evaluator link',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE tool_calls SET evaluator_decision_id = NULL WHERE id = ?').run(
          'acceptance-tool-call-success',
        );
      },
    },
    {
      label: 'a missing tool audit',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('DELETE FROM audit_log WHERE id = ?').run('acceptance-tool-audit');
      },
    },
    {
      label: 'a mismatched audit evaluator link',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE audit_log SET evaluator_decision_id = ? WHERE id = ?').run(
          'mismatched-evaluator',
          'acceptance-tool-audit',
        );
      },
    },
    {
      label: 'an unsuccessful tool call',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE tool_calls SET status = ? WHERE id = ?').run(
          'error',
          'acceptance-tool-call-success',
        );
      },
    },
    {
      label: 'an evaluator bound to the wrong trigger source',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET source_event_ids = ? WHERE id = ?').run(
          JSON.stringify(['acceptance-group-raw']),
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'an evaluator bound to a different turn',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET turn_id = ? WHERE id = ?').run(
          'acceptance-group-turn',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'an evaluator bound to a different tool',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET tool_name = ? WHERE id = ?').run(
          'different-tool',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'an evaluator bound to a different actor',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET actor_user_id = ? WHERE id = ?').run(
          'different-user',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'an evaluator bound to a different context',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE evaluator_decisions SET invocation_context = ? WHERE id = ?').run(
          'group_chat',
          'acceptance-tool-evaluator',
        );
      },
    },
    {
      label: 'a tool audit bound to a different actor',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE audit_log SET actor_user_id = ? WHERE id = ?').run(
          'different-user',
          'acceptance-tool-audit',
        );
      },
    },
    {
      label: 'a tool audit bound to a different context',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        db.prepare('UPDATE audit_log SET invocation_context = ? WHERE id = ?').run(
          'group_chat',
          'acceptance-tool-audit',
        );
      },
    },
    {
      label: 'tool evidence recorded after the action decision',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        const late = Date.UTC(2026, 6, 8, 10, 0, 0);
        db.prepare('UPDATE tool_calls SET created_at = ? WHERE id = ?').run(
          late,
          'acceptance-tool-call-success',
        );
      },
    },
    {
      label: 'a bot response recorded before action execution',
      mutate: (db: ReturnType<typeof initDatabase>) => {
        const early = Date.UTC(2026, 6, 8, 8, 59, 59);
        db.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(
          early,
          'acceptance-private-bot-raw',
        );
      },
    },
  ])('rejects required acceptance DB hints with $label', ({ mutate }) => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `invalid-reviewed-tool-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      const db = initDatabase({ path: dbPath });
      try {
        mutate(db);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        closeDatabase(db);
      }

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.reviewedToolExecutions).toBe(0);
      expect(summary.evidenceHints.reviewedToolExecutionPresent).toBe(false);
      expect(summary.evidenceHints).toMatchObject({
        privateNonMockCompleteLinkedTargetedFlowPresent: true,
        groupNonMockCompleteLinkedTargetedFlowPresent: true,
        groupNonMockCompleteLinkedReplyToBotFlowPresent: true,
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"reviewedToolExecutionPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires a distinct same-group reply-to-bot flow without @mention for complete DB hints', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `reply-to-bot-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      removeGroupReplyToBotAcceptanceFlow(dbPath);

      const exactMentionOnly = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );

      addGroupReplyToBotAcceptanceFlow(dbPath, secretToken, privateQqId);

      const db = initDatabase({ path: dbPath, readonly: true });
      try {
        const replyProof = db.prepare(
          `SELECT inbound.has_quote AS has_quote,
                  inbound.mentions_bot AS mentions_bot,
                  inbound.reply_to_message_id AS reply_to_message_id,
                  quoted.message_id AS quoted_message_id,
                  quoted.sender_id AS quoted_sender_id,
                  quoted.group_id AS quoted_group_id,
                  quoted_raw.type AS quoted_raw_type,
                  quoted_raw.source AS quoted_raw_source,
                  decisions.reasons AS reasons
             FROM chat_messages AS inbound
             INNER JOIN chat_messages AS quoted
                     ON quoted.message_id = inbound.reply_to_message_id
                    AND quoted.conversation_id = inbound.conversation_id
                    AND quoted.conversation_type = inbound.conversation_type
                    AND quoted.group_id = inbound.group_id
             INNER JOIN raw_events AS quoted_raw ON quoted_raw.id = quoted.raw_event_id
             INNER JOIN raw_events AS inbound_raw ON inbound_raw.id = inbound.raw_event_id
             INNER JOIN agent_turns AS turns ON turns.trigger_event_id = inbound_raw.id
             INNER JOIN action_decisions AS decisions ON decisions.id = turns.action_decision_id
            WHERE inbound.id = ?`,
        ).get('acceptance-group-reply-chat') as {
          has_quote: number;
          mentions_bot: number;
          quoted_group_id: string | null;
          quoted_message_id: string;
          quoted_raw_source: string;
          quoted_raw_type: string;
          quoted_sender_id: string;
          reasons: string;
          reply_to_message_id: string | null;
        } | undefined;

        expect(replyProof).toMatchObject({
          has_quote: 1,
          mentions_bot: 0,
          reply_to_message_id: 'sent-acceptance-group-execution',
          quoted_message_id: 'sent-acceptance-group-execution',
          quoted_sender_id: 'bot-self',
          quoted_group_id: `qq-group-${privateQqId}`,
          quoted_raw_type: 'bot.response',
          quoted_raw_source: 'agent',
        });
        expect(JSON.parse(replyProof?.reasons ?? '[]')).toContain('reply_to_bot');
      } finally {
        closeDatabase(db);
      }

      const withReplyToBot = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );

      const chronologyDb = initDatabase({ path: dbPath });
      try {
        chronologyDb.prepare(
          `UPDATE action_executions
              SET executed_at = (
                SELECT created_at + 1
                  FROM raw_events
                 WHERE id = ?
              )
            WHERE id = ?`,
        ).run('acceptance-group-reply-bot-raw', 'acceptance-group-reply-execution');
        expect(chronologyDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        closeDatabase(chronologyDb);
      }

      const responsePredatesExecution = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );

      const exactMentionOnlySummary = JSON.parse(exactMentionOnly.stdout) as {
        counts: {
          acceptanceFlows: {
            group: {
              completeLinkedReplyToBotFlows: number;
              completeLinkedTargetedFlows: number;
            };
          };
        };
        evidenceHints: {
          groupCompleteLinkedReplyToBotFlowPresent: boolean;
          groupCompleteLinkedTargetedFlowPresent: boolean;
        };
      };
      const withReplyToBotSummary = JSON.parse(withReplyToBot.stdout) as typeof exactMentionOnlySummary;
      const responsePredatesExecutionSummary = JSON.parse(
        responsePredatesExecution.stdout,
      ) as typeof exactMentionOnlySummary;

      expect(withReplyToBot.status, withReplyToBot.stderr).toBe(0);
      expect(withReplyToBot.stderr.trim()).toBe('');
      expect(withReplyToBot.stdout).not.toContain(secretToken);
      expect(withReplyToBot.stdout).not.toContain(privateQqId);
      expect(responsePredatesExecution.status, responsePredatesExecution.stderr).toBe(1);
      expect(responsePredatesExecution.stderr.trim()).toBe('');
      expect(responsePredatesExecution.stdout).not.toContain(secretToken);
      expect(responsePredatesExecution.stdout).not.toContain(privateQqId);
      expect(exactMentionOnly.status, exactMentionOnly.stderr).toBe(1);
      expect(exactMentionOnly.stderr.trim()).toBe('');
      expect(exactMentionOnly.stdout).not.toContain(secretToken);
      expect(exactMentionOnly.stdout).not.toContain(privateQqId);
      expect(exactMentionOnlySummary.counts.acceptanceFlows.group).toMatchObject({
        completeLinkedTargetedFlows: 1,
        completeLinkedReplyToBotFlows: 0,
      });
      expect(exactMentionOnlySummary.evidenceHints).toMatchObject({
        groupCompleteLinkedTargetedFlowPresent: true,
        groupCompleteLinkedReplyToBotFlowPresent: false,
      });
      expect(withReplyToBotSummary.counts.acceptanceFlows.group).toMatchObject({
        completeLinkedTargetedFlows: 1,
        completeLinkedReplyToBotFlows: 1,
      });
      expect(withReplyToBotSummary.evidenceHints).toMatchObject({
        groupCompleteLinkedTargetedFlowPresent: true,
        groupCompleteLinkedReplyToBotFlowPresent: true,
      });
      expect(responsePredatesExecutionSummary.counts.acceptanceFlows.group).toMatchObject({
        completeLinkedTargetedFlows: 1,
        completeLinkedReplyToBotFlows: 0,
      });
      expect(responsePredatesExecutionSummary.evidenceHints).toMatchObject({
        groupCompleteLinkedTargetedFlowPresent: true,
        groupCompleteLinkedReplyToBotFlowPresent: false,
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'a reply chain in a different group',
      mutate: moveGroupReplyFlowToDifferentGroup,
    },
    {
      label: 'an unrelated prior bot response in the same group',
      mutate: replaceGroupReplyQuoteWithUnrelatedBotResponse,
    },
  ])('requires the reply-to-bot flow to quote the exact @bot response, rejecting $label', ({ mutate }) => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-joint-group-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `joint-group-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      mutate(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.acceptanceFlows.group).toMatchObject({
        completeNonMockLinkedTargetedFlows: 1,
        completeNonMockLinkedReplyToBotFlows: 1,
        completeNonMockLinkedMentionReplyPairs: 0,
      });
      expect(summary.evidenceHints).toMatchObject({
        groupNonMockCompleteLinkedTargetedFlowPresent: true,
        groupNonMockCompleteLinkedReplyToBotFlowPresent: true,
        groupNonMockCompleteLinkedMentionReplyPairPresent: false,
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupNonMockCompleteLinkedMentionReplyPairPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects reply-to-bot evidence that reuses the quoted bot response raw event', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `reply-to-bot-shared-raw-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);

      const db = initDatabase({ path: dbPath });
      try {
        db.transaction(() => {
          db.prepare('UPDATE chat_messages SET raw_event_id = ? WHERE id = ?').run(
            'acceptance-group-bot-raw',
            'sent-acceptance-group-reply-execution',
          );
          db.prepare(
            `UPDATE raw_events
                SET created_at = (SELECT created_at FROM raw_events WHERE id = ?)
              WHERE id = ?`,
          ).run('acceptance-group-reply-raw', 'acceptance-group-bot-raw');
          db.prepare('DELETE FROM raw_events WHERE id = ?').run('acceptance-group-reply-bot-raw');
        })();
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        closeDatabase(db);
      }

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      const summary = JSON.parse(spawned.stdout) as {
        counts: {
          acceptanceFlows: {
            group: {
              completeLinkedReplyToBotFlows: number;
              completeLinkedTargetedFlows: number;
            };
          };
        };
        evidenceHints: {
          groupCompleteLinkedReplyToBotFlowPresent: boolean;
          groupCompleteLinkedTargetedFlowPresent: boolean;
        };
      };

      expect(spawned.status, spawned.stderr).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(summary.counts.acceptanceFlows.group).toMatchObject({
        completeLinkedTargetedFlows: 1,
        completeLinkedReplyToBotFlows: 0,
      });
      expect(summary.evidenceHints).toMatchObject({
        groupCompleteLinkedTargetedFlowPresent: true,
        groupCompleteLinkedReplyToBotFlowPresent: false,
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('fails required acceptance DB hints on an incomplete aggregate summary without leaking values', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `empty-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const db = initDatabase({ path: dbPath });

    try {
      runMigrations(db, join(process.cwd(), 'migrations'));
    } finally {
      closeDatabase(db);
    }

    try {
      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );

      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      const summary = JSON.parse(spawned.stdout) as {
        dbPath: string;
        database: { integrityOk: boolean; foreignKeyViolations: number };
        evidenceHints: {
          privateFlowRowsPresent: boolean;
          groupFlowRowsPresent: boolean;
          completedTurnsPresent: boolean;
          successfulActionsPresent: boolean;
          contextTraceRowsPresent: boolean;
          privateCompletedTurnPresent: boolean;
          groupCompletedTurnPresent: boolean;
          privateSuccessfulActionPresent: boolean;
          groupSuccessfulActionPresent: boolean;
          privateContextTracePresent: boolean;
          groupContextTracePresent: boolean;
          privateCompleteLinkedFlowPresent: boolean;
          groupCompleteLinkedFlowPresent: boolean;
          privateCompleteLinkedChatFlowPresent: boolean;
          groupCompleteLinkedChatFlowPresent: boolean;
          privateCompleteLinkedReplyFlowPresent: boolean;
          groupCompleteLinkedReplyFlowPresent: boolean;
          privateCompleteLinkedBotResponseFlowPresent: boolean;
          groupCompleteLinkedBotResponseFlowPresent: boolean;
          privateCompleteLinkedTargetedFlowPresent: boolean;
          groupCompleteLinkedTargetedFlowPresent: boolean;
          privateNonMockCompleteLinkedTargetedFlowPresent: boolean;
          groupNonMockCompleteLinkedTargetedFlowPresent: boolean;
          groupNonMockCompleteLinkedReplyToBotFlowPresent: boolean;
          reviewedToolExecutionPresent: boolean;
          memoryGovernanceRowsPresent: boolean;
          selectedGovernedMemoryContextPresent: boolean;
          foreignKeysClean: boolean;
        };
      };
      expect(summary.dbPath).toContain('[REDACTED:api_key_like_token]');
      expect(summary.dbPath).toContain('[REDACTED:platform_id]');
      expect(summary.database).toEqual({ integrityOk: true, foreignKeyViolations: 0 });
      expect(summary.evidenceHints).toMatchObject({
        privateFlowRowsPresent: false,
        groupFlowRowsPresent: false,
        completedTurnsPresent: false,
        successfulActionsPresent: false,
        contextTraceRowsPresent: false,
        privateCompletedTurnPresent: false,
        groupCompletedTurnPresent: false,
        privateSuccessfulActionPresent: false,
        groupSuccessfulActionPresent: false,
        privateContextTracePresent: false,
        groupContextTracePresent: false,
        privateCompleteLinkedFlowPresent: false,
        groupCompleteLinkedFlowPresent: false,
        privateCompleteLinkedChatFlowPresent: false,
        groupCompleteLinkedChatFlowPresent: false,
        privateCompleteLinkedReplyFlowPresent: false,
        groupCompleteLinkedReplyFlowPresent: false,
        privateCompleteLinkedBotResponseFlowPresent: false,
        groupCompleteLinkedBotResponseFlowPresent: false,
        privateCompleteLinkedTargetedFlowPresent: false,
        groupCompleteLinkedTargetedFlowPresent: false,
        privateNonMockCompleteLinkedTargetedFlowPresent: false,
        groupNonMockCompleteLinkedTargetedFlowPresent: false,
        groupNonMockCompleteLinkedReplyToBotFlowPresent: false,
        reviewedToolExecutionPresent: false,
        memoryGovernanceRowsPresent: false,
        selectedGovernedMemoryContextPresent: false,
        foreignKeysClean: true,
      });
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires private and group turn/action/context DB evidence separately', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `partial-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      removeGroupTurnActionContextEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          chatMessages: {
            private: 3,
            group: 4,
          },
          contextTraces: {
            private: 1,
            group: 1,
          },
          agentTurns: {
            completed: 2,
          },
          actionExecutions: {
            success: 2,
          },
          acceptanceFlows: {
            private: {
              chatMessages: 3,
              contextTraces: 1,
              completedTurns: 1,
              successfulActions: 1,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
            group: {
              chatMessages: 4,
              contextTraces: 1,
              completedTurns: 1,
              successfulActions: 1,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompletedTurnPresent: true,
          groupCompletedTurnPresent: true,
          privateSuccessfulActionPresent: true,
          groupSuccessfulActionPresent: true,
          privateContextTracePresent: true,
          groupContextTracePresent: true,
          privateCompleteLinkedFlowPresent: true,
          groupCompleteLinkedFlowPresent: true,
          privateCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedChatFlowPresent: true,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          memoryGovernanceRowsPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupFlowRowsPresent": false');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('group acceptance text');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires private and group context/action evidence to be linked to the same completed turn', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `split-linked-flow-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceGroupLinkedFlowWithSplitEvidence(dbPath, privateQqId);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          chatMessages: {
            private: 3,
            group: 4,
          },
          contextTraces: {
            private: 1,
            group: 2,
          },
          agentTurns: {
            completed: 4,
          },
          actionExecutions: {
            success: 3,
          },
          acceptanceFlows: {
            private: {
              chatMessages: 3,
              contextTraces: 1,
              completedTurns: 1,
              successfulActions: 1,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
            group: {
              chatMessages: 4,
              contextTraces: 2,
              completedTurns: 3,
              successfulActions: 2,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompletedTurnPresent: true,
          groupCompletedTurnPresent: true,
          privateSuccessfulActionPresent: true,
          groupSuccessfulActionPresent: true,
          privateContextTracePresent: true,
          groupContextTracePresent: true,
          privateCompleteLinkedFlowPresent: true,
          groupCompleteLinkedFlowPresent: true,
          privateCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedChatFlowPresent: true,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          memoryGovernanceRowsPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupFlowRowsPresent": false');
      expect(spawned.stdout).toContain('"groupCompletedTurnPresent": true');
      expect(spawned.stdout).toContain('"groupSuccessfulActionPresent": true');
      expect(spawned.stdout).toContain('"groupContextTracePresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires linked complete flows to originate from the same normalized chat event', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `unlinked-chat-flow-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceGroupTurnTriggerWithUnnormalizedRawEvent(dbPath, secretToken, privateQqId);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          chatMessages: {
            private: 3,
            group: 4,
          },
          contextTraces: {
            private: 1,
            group: 2,
          },
          acceptanceFlows: {
            private: {
              chatMessages: 3,
              contextTraces: 1,
              completedTurns: 1,
              successfulActions: 1,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
            group: {
              chatMessages: 4,
              contextTraces: 2,
              completedTurns: 2,
              successfulActions: 2,
              completeLinkedFlows: 2,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompletedTurnPresent: true,
          groupCompletedTurnPresent: true,
          privateSuccessfulActionPresent: true,
          groupSuccessfulActionPresent: true,
          privateContextTracePresent: true,
          groupContextTracePresent: true,
          privateCompleteLinkedFlowPresent: true,
          groupCompleteLinkedFlowPresent: true,
          privateCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedChatFlowPresent: true,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          memoryGovernanceRowsPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupFlowRowsPresent": false');
      expect(spawned.stdout).toContain('"groupCompleteLinkedFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires complete linked chat flows to use the turn selected context and action decision rows', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `wrong-selected-links-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceGroupTurnSelectedLinksWithMissingRows(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          chatMessages: {
            private: 3,
            group: 4,
          },
          contextTraces: {
            private: 1,
            group: 2,
          },
          acceptanceFlows: {
            private: {
              chatMessages: 3,
              contextTraces: 1,
              completedTurns: 1,
              successfulActions: 1,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
            group: {
              chatMessages: 4,
              contextTraces: 2,
              completedTurns: 2,
              successfulActions: 2,
              completeLinkedFlows: 2,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompleteLinkedFlowPresent: true,
          groupCompleteLinkedFlowPresent: true,
          privateCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedChatFlowPresent: true,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          memoryGovernanceRowsPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupCompleteLinkedFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires complete linked chat flows to originate from QQ chat message raw events', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `non-qq-chat-flow-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceGroupRawEventTypeAndPlatform(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          chatMessages: {
            private: 3,
            group: 4,
          },
          contextTraces: {
            private: 1,
            group: 2,
          },
          acceptanceFlows: {
            private: {
              chatMessages: 3,
              contextTraces: 1,
              completedTurns: 1,
              successfulActions: 1,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
            group: {
              chatMessages: 4,
              contextTraces: 2,
              completedTurns: 2,
              successfulActions: 2,
              completeLinkedFlows: 2,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompleteLinkedFlowPresent: true,
          groupCompleteLinkedFlowPresent: true,
          privateCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedChatFlowPresent: true,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          memoryGovernanceRowsPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupCompleteLinkedFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires complete linked chat flows to include a delivered reply action', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `non-reply-action-flow-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceGroupExecutionWithNonReplySuccess(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          chatMessages: {
            private: 3,
            group: 4,
          },
          contextTraces: {
            private: 1,
            group: 2,
          },
          actionExecutions: {
            success: 3,
          },
          acceptanceFlows: {
            private: {
              chatMessages: 3,
              contextTraces: 1,
              completedTurns: 1,
              successfulActions: 1,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
            group: {
              chatMessages: 4,
              contextTraces: 2,
              completedTurns: 2,
              successfulActions: 2,
              completeLinkedFlows: 2,
              completeLinkedChatFlows: 2,
              completeLinkedReplyFlows: 1,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompleteLinkedFlowPresent: true,
          groupCompleteLinkedFlowPresent: true,
          privateCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedChatFlowPresent: true,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          memoryGovernanceRowsPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupCompleteLinkedChatFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('counts reply_with_tool success with persisted bot response as delivered reply evidence', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `reply-with-tool-flow-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceGroupExecutionActionType(dbPath, 'reply_with_tool');

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          actionExecutions: {
            success: 3,
          },
          acceptanceFlows: {
            private: {
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedReplyFlows: 2,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 2,
              completeLinkedTargetedFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          privateCompleteLinkedTargetedFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: true,
          selectedGovernedMemoryContextPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status, spawned.stdout).toBe(0);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedBotResponseFlowPresent": true');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('does not count downgraded folded-forward fallback as delivered reply acceptance evidence', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `folded-forward-fallback-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceGroupExecutionWithDowngradedFoldedForwardFallback(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          actionExecutions: {
            success: 2,
            downgraded: 1,
          },
          acceptanceFlows: {
            private: {
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 1,
              completeLinkedTargetedFlows: 0,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          privateCompleteLinkedTargetedFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('group bot response');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('does not count downgraded react_only face-message fallback as delivered reply acceptance evidence', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `react-only-fallback-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceGroupExecutionWithDowngradedReactOnlyFallback(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          actionExecutions: {
            success: 2,
            downgraded: 1,
          },
          acceptanceFlows: {
            private: {
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 1,
              completeLinkedTargetedFlows: 0,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          privateCompleteLinkedTargetedFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('group bot response');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires delivered reply actions to have persisted bot response rows', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `missing-bot-response-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      removeGroupBotResponseEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          chatMessages: {
            private: 3,
            group: 3,
          },
          contextTraces: {
            private: 1,
            group: 2,
          },
          actionExecutions: {
            success: 3,
          },
          acceptanceFlows: {
            private: {
              chatMessages: 3,
              contextTraces: 1,
              completedTurns: 1,
              successfulActions: 1,
              completeLinkedFlows: 1,
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedBotResponseFlows: 1,
            },
            group: {
              chatMessages: 3,
              contextTraces: 2,
              completedTurns: 2,
              successfulActions: 2,
              completeLinkedFlows: 2,
              completeLinkedChatFlows: 2,
              completeLinkedReplyFlows: 2,
              completeLinkedReplyToBotFlows: 0,
              completeLinkedBotResponseFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: false,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          memoryGovernanceRowsPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": false');
      expect(spawned.stdout).toContain('"groupCompleteLinkedBotResponseFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('group bot response');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires group acceptance DB hints to originate from an exact @bot trigger row', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `missing-group-mention-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      removeGroupExactMentionEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          chatMessages: {
            private: 3,
            group: 4,
          },
          acceptanceFlows: {
            private: {
              completeLinkedBotResponseFlows: 1,
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 2,
              completeLinkedTargetedFlows: 0,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          privateCompleteLinkedTargetedFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          memoryGovernanceRowsPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupCompleteLinkedBotResponseFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('group bot response');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires group acceptance DB hints to carry normalized group scope through the flow', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `missing-group-scope-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      removeGroupScopeEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          chatMessages: {
            private: 3,
            group: 4,
          },
          acceptanceFlows: {
            private: {
              completeLinkedBotResponseFlows: 1,
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedChatFlows: 1,
              completeLinkedReplyFlows: 1,
              completeLinkedReplyToBotFlows: 1,
              completeLinkedBotResponseFlows: 1,
              completeLinkedTargetedFlows: 0,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: false,
          privateCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
          memoryGovernanceRowsPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"groupCompleteLinkedReplyToBotFlowPresent": true');
      expect(spawned.stdout).toContain('"groupCompleteLinkedTargetedFlowPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('group bot response');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    'qq-group-01234',
    'qq-group-1234',
    'qq-group-1234567890123',
  ])('rejects noncanonical normalized group scope %s from acceptance DB hints', (groupId) => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-group-scope-${privateQqId}-`));
    const dbPath = join(testDir, 'noncanonical-group-scope.db');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceAllAcceptanceGroupScopeIds(dbPath, groupId);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');

      expect(summary.evidenceHints.groupCompleteLinkedTargetedFlowPresent).toBe(false);
      expect(summary.evidenceHints.groupNonMockCompleteLinkedTargetedFlowPresent).toBe(false);
      expect(summary.evidenceHints.conservativeGroupDerivedUserMemoryPresent).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires group acceptance DB hints to keep context and bot response group scope consistent', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const scenarios: Array<{
      name: string;
      breakScope: (dbPath: string) => void;
      expectedGroupCounts: {
        completeLinkedChatFlows: number;
        completeLinkedReplyFlows: number;
        completeLinkedReplyToBotFlows: number;
        completeLinkedBotResponseFlows: number;
        completeLinkedTargetedFlows: number;
      };
      expectedGroupHints: {
        groupCompleteLinkedChatFlowPresent: boolean;
        groupCompleteLinkedReplyFlowPresent: boolean;
        groupCompleteLinkedReplyToBotFlowPresent: boolean;
        groupCompleteLinkedBotResponseFlowPresent: boolean;
        groupCompleteLinkedTargetedFlowPresent: boolean;
      };
    }> = [
      {
        name: 'context',
        breakScope: replaceGroupContextScopeEvidence,
        expectedGroupCounts: {
          completeLinkedChatFlows: 1,
          completeLinkedReplyFlows: 1,
          completeLinkedReplyToBotFlows: 1,
          completeLinkedBotResponseFlows: 1,
          completeLinkedTargetedFlows: 0,
        },
        expectedGroupHints: {
          groupCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: true,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
        },
      },
      {
        name: 'bot-response',
        breakScope: replaceGroupBotResponseScopeEvidence,
        expectedGroupCounts: {
          completeLinkedChatFlows: 2,
          completeLinkedReplyFlows: 2,
          completeLinkedReplyToBotFlows: 0,
          completeLinkedBotResponseFlows: 1,
          completeLinkedTargetedFlows: 0,
        },
        expectedGroupHints: {
          groupCompleteLinkedChatFlowPresent: true,
          groupCompleteLinkedReplyFlowPresent: true,
          groupCompleteLinkedReplyToBotFlowPresent: false,
          groupCompleteLinkedBotResponseFlowPresent: true,
          groupCompleteLinkedTargetedFlowPresent: false,
        },
      },
    ];

    for (const scenario of scenarios) {
      const testDir = mkdtempSync(join(tmpdir(), `lethebot-${scenario.name}-${secretToken}-qq-${privateQqId}-`));
      const dbPath = join(testDir, `mismatched-group-scope-${secretToken}-qq-${privateQqId}.db`);

      try {
        seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
        scenario.breakScope(dbPath);

        const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
        expect(summary).toMatchObject({
          database: {
            integrityOk: true,
            foreignKeyViolations: 0,
          },
          counts: {
            acceptanceFlows: {
              private: {
                completeLinkedBotResponseFlows: 1,
                completeLinkedTargetedFlows: 1,
              },
              group: scenario.expectedGroupCounts,
            },
          },
          evidenceHints: {
            privateFlowRowsPresent: true,
            groupFlowRowsPresent: false,
            ...scenario.expectedGroupHints,
            memoryGovernanceRowsPresent: true,
            foreignKeysClean: true,
          },
        });

        const serialized = JSON.stringify(summary);
        expect(serialized).not.toContain(secretToken);
        expect(serialized).not.toContain(privateQqId);
        expect(serialized).not.toContain('group acceptance text');
        expect(serialized).not.toContain('group bot response');
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });

  it('requires memory governance DB hints to include a selected governed memory context', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `missing-memory-context-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      removeSelectedGovernedMemoryContextEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
          acceptanceFlows: {
            private: {
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedTargetedFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"memoryGovernanceRowsPresent": true');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('memory content');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'the selected memory is absent from the candidate set',
      mutate: removeSelectedMemoryCandidateEvidence,
    },
    {
      label: 'the selected memory is absent from the injected context memories',
      mutate: removeSelectedMemoryPayloadEvidence,
    },
  ])('requires coherent selected-memory context evidence when $label', ({ mutate }) => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-memory-context-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `memory-context-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      mutate(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(0);
      expect(summary.evidenceHints.selectedGovernedMemoryContextPresent).toBe(false);
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'a prohibited memory', kind: 'prohibited' as const },
    { label: 'another user\'s private memory', kind: 'cross_scope' as const },
  ])('rejects a context that mixes one valid memory with $label', ({ kind }) => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-mixed-memory-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `mixed-memory-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      addInvalidSelectedMemoryEvidence(dbPath, kind);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(0);
      expect(summary.evidenceHints.selectedGovernedMemoryContextPresent).toBe(false);
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires selected governed memory to use a distinct durable source predating the target turn', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-memory-chronology-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `memory-chronology-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      const priorSource = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(priorSource.counts.selectedGovernedMemoryContexts).toBe(1);

      replaceSelectedMemorySourceWithTargetTrigger(dbPath);

      const sameTurnSource = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(sameTurnSource.counts.selectedGovernedMemoryContexts).toBe(0);
      expect(sameTurnSource.evidenceHints.selectedGovernedMemoryContextPresent).toBe(false);
      const serialized = JSON.stringify(sameTurnSource);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects selected memory provenance attached after the memory and governing revision', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-memory-source-order-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `memory-source-order-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      makeSelectedMemoryChatSourcePostdateMemory(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(0);
      expect(summary.evidenceHints.selectedGovernedMemoryContextPresent).toBe(false);
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('accepts source and canonical evidence at the memory creation and revision millisecond', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-memory-source-equality-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `memory-source-equality-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      makeSelectedMemoryCoincideWithSourceEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(1);
      expect(summary.evidenceHints.selectedGovernedMemoryContextPresent).toBe(true);
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects selected and conservative group memory with post-hoc tool provenance', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-group-tool-source-order-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `group-tool-source-order-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      removeDefaultConservativeGroupMemory(dbPath);
      configureSelectedGroupDerivedUserMemory(dbPath, {
        privateQqId,
        provenance: 'tool',
        visibility: 'same_group_only',
      });
      makeSelectedGroupToolSourcePostdateMemory(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(0);
      expect(summary.counts.conservativeGroupDerivedUserMemories).toBe(0);
      expect(summary.evidenceHints).toMatchObject({
        selectedGovernedMemoryContextPresent: false,
        conservativeGroupDerivedUserMemoryPresent: false,
      });
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    { provenance: 'chat' as const, visibility: 'same_user_any_context' as const },
    { provenance: 'chat' as const, visibility: 'public' as const },
    { provenance: 'tool' as const, visibility: 'same_user_any_context' as const },
    { provenance: 'tool' as const, visibility: 'public' as const },
  ])(
    'rejects broad $visibility selected user memory derived from group $provenance provenance',
    ({ provenance, visibility }) => {
      const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
      const privateQqId = '12345678901';
      const testDir = mkdtempSync(join(tmpdir(), `lethebot-group-derived-${secretToken}-qq-${privateQqId}-`));
      const dbPath = join(testDir, `group-derived-${secretToken}-qq-${privateQqId}.db`);

      try {
        seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
        configureSelectedGroupDerivedUserMemory(dbPath, {
          privateQqId,
          provenance,
          visibility,
        });

        const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
        expect(summary.counts.selectedGovernedMemoryContexts).toBe(0);
        expect(summary.counts.conservativeGroupDerivedUserMemories).toBe(1);
        expect(summary.evidenceHints.conservativeGroupDerivedUserMemoryPresent).toBe(true);
        const serialized = JSON.stringify(summary);
        expect(serialized).not.toContain(secretToken);
        expect(serialized).not.toContain(privateQqId);
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    },
  );

  it('accepts governance-approved active same-group user memory with linked group chat provenance', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-approved-group-memory-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `approved-group-memory-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      removeDefaultConservativeGroupMemory(dbPath);
      configureSelectedGroupDerivedUserMemory(dbPath, {
        privateQqId,
        provenance: 'chat',
        visibility: 'same_group_only',
      });

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(1);
      expect(summary.counts.conservativeGroupDerivedUserMemories).toBe(1);
      expect(summary.evidenceHints).toMatchObject({
        selectedGovernedMemoryContextPresent: true,
        conservativeGroupDerivedUserMemoryPresent: true,
      });
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'missing group-derived memory',
      mutate: removeDefaultConservativeGroupMemory,
    },
    {
      label: 'broad group-derived visibility',
      mutate: makeDefaultGroupMemoryVisibilityBroad,
    },
  ])('requires conservative source-linked group-derived user memory when evidence is $label', ({ mutate }) => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-required-group-memory-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `required-group-memory-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      mutate(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.conservativeGroupDerivedUserMemories).toBe(0);
      expect(summary.evidenceHints.conservativeGroupDerivedUserMemoryPresent).toBe(false);

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"conservativeGroupDerivedUserMemoryPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'future record creation', mutate: makeSelectedMemoryCreatedAfterContext },
    { label: 'future governing revision', mutate: makeSelectedMemoryRevisionAfterContext },
    { label: 'incoherent non-active governing revision', mutate: makeSelectedMemoryRevisionIncoherent },
    { label: 'memory already expired at context time', mutate: makeSelectedMemoryExpiredAtContext },
    { label: 'memory expiring after turn start but at context selection', mutate: makeSelectedMemoryExpireBetweenTurnAndContext },
    { label: 'context persisted after its action decision', mutate: makeSelectedMemoryContextPostdateDecision },
  ])('rejects selected governed memory with $label', ({ mutate }) => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-memory-time-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `memory-time-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      mutate(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(0);
      expect(summary.evidenceHints.selectedGovernedMemoryContextPresent).toBe(false);
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(privateQqId);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires selected governed memory context evidence to be the turn selected context pack', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `unselected-memory-context-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithUnselectedContextEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
          acceptanceFlows: {
            private: {
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedTargetedFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"privateFlowRowsPresent": true');
      expect(spawned.stdout).toContain('"groupFlowRowsPresent": true');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('memory content');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires selected governed memory context evidence to be visible in the flow context', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `private-memory-in-group-context-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithPrivateOnlyGroupContextEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
          acceptanceFlows: {
            private: {
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedTargetedFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"privateFlowRowsPresent": true');
      expect(spawned.stdout).toContain('"groupFlowRowsPresent": true');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('memory content');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires selected governed user memory context evidence to belong to the flow sender', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `other-user-memory-context-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithOtherUserEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
          acceptanceFlows: {
            private: {
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedTargetedFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"privateFlowRowsPresent": true');
      expect(spawned.stdout).toContain('"groupFlowRowsPresent": true');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('memory content');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires selected governed memory source links to resolve to durable source rows', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `unresolved-memory-source-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithUnresolvableSourceEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
          acceptanceFlows: {
            private: {
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedTargetedFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"privateFlowRowsPresent": true');
      expect(spawned.stdout).toContain('"groupFlowRowsPresent": true');
      expect(spawned.stdout).toContain('"memoryGovernanceRowsPresent": true');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('private acceptance text');
      expect(spawned.stdout).not.toContain('group acceptance text');
      expect(spawned.stdout).not.toContain('memory content');
      expect(spawned.stdout).not.toContain('missing-chat-message-source');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('uses canonical internal source ids instead of colliding opaque source aliases', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `canonical-memory-source-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithCollidingCanonicalChatSourceEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.database).toEqual({
        integrityOk: true,
        foreignKeyViolations: 0,
      });
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(0);
      expect(summary.evidenceHints.selectedGovernedMemoryContextPresent).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('retains historical source aliases only for legacy unresolved rows', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `legacy-memory-source-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithLegacyChatAliasEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.database).toEqual({
        integrityOk: true,
        foreignKeyViolations: 0,
      });
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(1);
      expect(summary.evidenceHints.selectedGovernedMemoryContextPresent).toBe(true);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('does not treat external user commands as inbound QQ memory evidence', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `external-memory-source-${secretToken}-qq-${privateQqId}.db`);

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithExternalUserCommandEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary.database).toEqual({
        integrityOk: true,
        foreignKeyViolations: 0,
      });
      expect(summary.counts.selectedGovernedMemoryContexts).toBe(0);
      expect(summary.evidenceHints.selectedGovernedMemoryContextPresent).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires selected governed memory source links to resolve to usable source evidence', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const scenarios: Array<{
      name: string;
      replaceSource: (dbPath: string) => void;
      forbiddenSourceId: string;
    }> = [
      {
        name: 'rejected-tool-call',
        replaceSource: replaceSelectedGovernedMemoryWithRejectedToolSourceEvidence,
        forbiddenSourceId: 'acceptance-tool-call-rejected',
      },
      {
        name: 'bot-response-chat',
        replaceSource: replaceSelectedGovernedMemoryWithBotResponseChatSourceEvidence,
        forbiddenSourceId: 'sent-acceptance-private-execution',
      },
    ];

    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    for (const scenario of scenarios) {
      const testDir = mkdtempSync(join(tmpdir(), `lethebot-${scenario.name}-${secretToken}-qq-${privateQqId}-`));
      const dbPath = join(testDir, `unusable-memory-source-${secretToken}-qq-${privateQqId}.db`);

      try {
        seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
        scenario.replaceSource(dbPath);

        const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
        expect(summary).toMatchObject({
          database: {
            integrityOk: true,
            foreignKeyViolations: 0,
          },
          counts: {
            memorySources: 2,
            memoryRevisions: 2,
            selectedGovernedMemoryContexts: 0,
            acceptanceFlows: {
              private: {
                completeLinkedTargetedFlows: 1,
              },
              group: {
                completeLinkedTargetedFlows: 1,
              },
            },
          },
          evidenceHints: {
            privateFlowRowsPresent: true,
            groupFlowRowsPresent: true,
            memoryGovernanceRowsPresent: true,
            selectedGovernedMemoryContextPresent: false,
            foreignKeysClean: true,
          },
        });

        const spawned = spawnSync(
          tsxBin,
          ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
          },
        );
        expect(spawned.status).toBe(1);
        expect(spawned.stderr.trim()).toBe('');
        expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
        expect(spawned.stdout).not.toContain(secretToken);
        expect(spawned.stdout).not.toContain(privateQqId);
        expect(spawned.stdout).not.toContain('private acceptance text');
        expect(spawned.stdout).not.toContain('group acceptance text');
        expect(spawned.stdout).not.toContain('memory content');
        expect(spawned.stdout).not.toContain(scenario.forbiddenSourceId);
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });

  it('requires selected governed user memory chat sources to belong to the memory owner', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `other-user-memory-source-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithOtherUserChatSourceEvidence(dbPath, secretToken);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
          acceptanceFlows: {
            private: {
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedTargetedFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('other user source text');
      expect(spawned.stdout).not.toContain('memory content');
      expect(spawned.stdout).not.toContain('acceptance-other-source-chat');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects usable memory source joins whose raw and chat conversations disagree', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-source-scope-${privateQqId}-`));
    const dbPath = join(testDir, 'mismatched-source-conversation.db');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      mismatchSelectedMemoryRawEventConversation(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');

      expect(summary.counts.selectedGovernedMemoryContexts).toBe(0);
      expect(summary.evidenceHints.selectedGovernedMemoryContextPresent).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects worker-only memory provenance without a companion canonical chat source', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `worker-source-without-chat-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithCompletedWorkerWithoutChatSourceEvidence(dbPath, secretToken);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
          acceptanceFlows: {
            private: {
              completeLinkedTargetedFlows: 1,
            },
            group: {
              completeLinkedTargetedFlows: 1,
            },
          },
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('worker payload without chat provenance');
      expect(spawned.stdout).not.toContain('acceptance-worker-without-chat');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('accepts a coherent supplemental worker link with compatible canonical chat provenance', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `worker-source-with-chat-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithCompletedWorkerChatSourceEvidence(dbPath, secretToken);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 3,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 1,
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(0);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": true');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('worker payload with chat provenance');
      expect(spawned.stdout).not.toContain('acceptance-worker-with-chat');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires selected governed user memory tool sources to belong to the memory owner', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `other-user-tool-source-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithOtherUserSuccessfulToolSourceEvidence(dbPath, secretToken);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('other user tool source output');
      expect(spawned.stdout).not.toContain('acceptance-tool-call-other-user-success');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('accepts selected governed user memory tool sources from the same source turn sender', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `same-user-tool-source-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithSuccessfulToolSourceEvidence(dbPath);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 1,
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(0);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": true');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('acceptance-tool-call-success');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects selected governed user memory tool sources with conflicting actor and source turn sender', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `conflicting-actor-tool-source-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedMemoryWithConflictingActorToolSourceEvidence(dbPath, secretToken);

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('conflicting actor tool source output');
      expect(spawned.stdout).not.toContain('acceptance-tool-call-conflicting-actor-success');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires selected governed group memory tool sources to match the memory group', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `other-group-tool-source-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedGroupMemoryWithToolSourceEvidence(dbPath, {
        privateQqId,
        secretToken,
        sourceGroup: 'other',
      });

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('other group tool source output');
      expect(spawned.stdout).not.toContain('acceptance-tool-call-other-group-success');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('accepts selected governed group memory tool sources from the same group context', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `same-group-tool-source-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedGroupMemoryWithToolSourceEvidence(dbPath, {
        privateQqId,
        secretToken,
        sourceGroup: 'matching',
      });

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 1,
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(0);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": true');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('matching group tool source output');
      expect(spawned.stdout).not.toContain('acceptance-tool-call-group-success');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('requires selected governed conversation memory tool sources to match the memory conversation', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `other-conversation-tool-source-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedConversationMemoryWithToolSourceEvidence(dbPath, {
        privateQqId,
        secretToken,
        sourceConversation: 'other',
      });

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 0,
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: false,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(1);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": false');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('other conversation tool source output');
      expect(spawned.stdout).not.toContain('acceptance-tool-call-other-conversation-success');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('accepts selected governed conversation memory tool sources from the same conversation context', () => {
    const secretToken = 'sk-local-acceptance-db-secret-should-not-leak';
    const privateQqId = '12345678901';
    const testDir = mkdtempSync(join(tmpdir(), `lethebot-${secretToken}-qq-${privateQqId}-`));
    const dbPath = join(testDir, `same-conversation-tool-source-${secretToken}-qq-${privateQqId}.db`);
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      seedAcceptanceSummaryDatabase(dbPath, secretToken, privateQqId);
      replaceSelectedGovernedConversationMemoryWithToolSourceEvidence(dbPath, {
        privateQqId,
        secretToken,
        sourceConversation: 'matching',
      });

      const summary = summarizeLocalAcceptanceDatabase(dbPath, '2026-07-08T09:00:00.000Z');
      expect(summary).toMatchObject({
        database: {
          integrityOk: true,
          foreignKeyViolations: 0,
        },
        counts: {
          memorySources: 2,
          memoryRevisions: 2,
          selectedGovernedMemoryContexts: 1,
        },
        evidenceHints: {
          privateFlowRowsPresent: true,
          groupFlowRowsPresent: true,
          memoryGovernanceRowsPresent: true,
          selectedGovernedMemoryContextPresent: true,
          foreignKeysClean: true,
        },
      });

      const spawned = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--summarize-db', '--db', dbPath, '--require-acceptance-hints'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(spawned.status).toBe(0);
      expect(spawned.stderr.trim()).toBe('');
      expect(spawned.stdout).toContain('"selectedGovernedMemoryContextPresent": true');
      expect(spawned.stdout).not.toContain(secretToken);
      expect(spawned.stdout).not.toContain(privateQqId);
      expect(spawned.stdout).not.toContain('matching conversation tool source output');
      expect(spawned.stdout).not.toContain('acceptance-tool-call-conversation-success');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('allows explicitly redacted authorization evidence but flags raw bearer tokens', () => {
    const safe = validateLocalAcceptanceEvidence(`
# Redacted auth evidence

Authorization: Bearer <redacted-token>
Authorization: <redacted>
ONEBOT_TOKEN=<redacted>
ONEBOT_TOKEN=\${ONEBOT_TOKEN}
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

  it.each([
    {
      line: 'Authorization: Bearer <redacted>actual-secret',
      ruleId: 'secret-assignment',
    },
    {
      line: 'ONEBOT_TOKEN=value-containing-hash',
      ruleId: 'secret-assignment',
    },
    {
      line: 'raw message text: <redacted> actual body',
      ruleId: 'raw-message-text',
    },
    {
      line: 'ONEBOT_TOKEN=<actual-value>',
      ruleId: 'secret-assignment',
    },
    {
      line: 'raw message text: <private-body>',
      ruleId: 'raw-message-text',
    },
    {
      line: 'ONEBOT_TOKEN=${ONEBOT_TOKEN:-actual-secret}',
      ruleId: 'secret-assignment',
    },
  ])('does not treat a redaction marker substring as safe: $line', ({ line, ruleId }) => {
    const result = validateLocalAcceptanceEvidence(line);

    expect(result.valid).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toContain(ruleId);
    expect(JSON.stringify(result)).not.toContain(line);
  });

  it('flags password, passwd, pwd, and recovery assignments without echoing values', () => {
    const rawValues = [
      'local-password-value',
      'local-passwd-value',
      'local-pwd-value',
      'local-recovery-value',
    ];
    const result = validateLocalAcceptanceEvidence([
      `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=${rawValues[0]}`,
      `VNC_PASSWD=${rawValues[1]}`,
      `LOCAL_PWD=${rawValues[2]}`,
      `RECOVERY_CODES=${rawValues[3]}`,
    ].join('\n'));

    expect(result.valid).toBe(false);
    expect(result.findings.filter((finding) => finding.ruleId === 'secret-assignment')).toHaveLength(4);
    for (const rawValue of rawValues) {
      expect(JSON.stringify(result)).not.toContain(rawValue);
    }
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

  it('does not let nearby redaction markers hide raw platform identifiers', () => {
    const privateQqId = '12345678901';
    const result = validateLocalAcceptanceEvidence(`
# Unsafe mixed redaction evidence

QQ ID: ${privateQqId} (<redacted elsewhere>)
internal-id evidence: ${privateQqId} redacted-note
`);

    expect(result.valid).toBe(false);
    const platformFindings = result.findings.filter(
      (finding) => finding.ruleId === 'platform-id-like-number',
    );
    expect(platformFindings.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(result)).not.toContain(privateQqId);
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

  it('validates complete evidence through the spawned CLI only when required items are checked', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-acceptance-complete-'));
    const incompletePath = join(testDir, 'incomplete.md');
    const completePath = join(testDir, 'complete.md');
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

    try {
      writeFileSync(incompletePath, buildLocalAcceptanceEvidenceTemplate(), 'utf8');
      writeFileSync(completePath, buildCompleteRedactedEvidence(), 'utf8');

      const incomplete = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--validate', incompletePath, '--require-complete'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(incomplete.status).toBe(1);
      expect(incomplete.stderr.trim()).toBe('');
      expect(incomplete.stdout).toContain('"requireComplete": true');
      expect(incomplete.stdout).toContain('"incomplete-required-checklist"');
      expect(incomplete.stdout).toContain('"acceptance-decision-missing"');

      const complete = spawnSync(
        tsxBin,
        ['src/scripts/local-acceptance-evidence.ts', '--validate', completePath, '--require-complete'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(complete.status, complete.stderr).toBe(0);
      expect(complete.stderr.trim()).toBe('');
      expect(JSON.parse(complete.stdout) as { requireComplete: boolean; valid: boolean; findingCount: number }).toMatchObject({
        requireComplete: true,
        valid: true,
        findingCount: 0,
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects conflicting validate and DB-summary CLI modes before either mode runs', () => {
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const result = spawnSync(
      tsxBin,
      [
        'src/scripts/local-acceptance-evidence.ts',
        '--validate',
        '/tmp/lethebot-acceptance-evidence.md',
        '--require-complete',
        '--summarize-db',
        '--db',
        '/tmp/lethebot-acceptance.db',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
    expect(result.stderr).toContain('Conflicting CLI modes');
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

  it('redacts generic home-directory paths in CLI errors', () => {
    const privateUserSegment = 'private-local-operator';
    const missingPath = `/home/${privateUserSegment}/private-project/missing-evidence.md`;
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const result = spawnSync(
      tsxBin,
      ['src/scripts/local-acceptance-evidence.ts', '--validate', missingPath],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[REDACTED:home_path]');
    expect(result.stderr).not.toContain(privateUserSegment);
    expect(result.stderr).not.toContain('private-project');
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
    const passwordSecret = 'plain-local-password-should-not-leak';
    const githubToken = `ghp_${'A'.repeat(24)}`;
    const awsAccessKey = `AKIA${'A'.repeat(16)}`;
    const privateQqId = '12345678901';
    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const cases: Array<{
      args: string[];
      expectedMessage: string;
      expectedMarkers?: string[];
      sensitiveValues?: string[];
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
        args: ['--require-acceptance-hints'],
        expectedMessage: '--require-acceptance-hints can only be used with --summarize-db',
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
      {
        args: [`--password=${passwordSecret}`],
        expectedMessage: 'Unknown option',
        expectedMarkers: ['[REDACTED:secret_assignment]'],
        sensitiveValues: [passwordSecret],
      },
      {
        args: [`--unexpected-${githubToken}`],
        expectedMessage: 'Unknown option',
        expectedMarkers: ['[REDACTED:github_token]'],
        sensitiveValues: [githubToken],
      },
      {
        args: [`--unexpected-${awsAccessKey}`],
        expectedMessage: 'Unknown option',
        expectedMarkers: ['[REDACTED:aws_access_key_id]'],
        sensitiveValues: [awsAccessKey],
      },
      {
        args: ['/srv/private-client/acceptance.md'],
        expectedMessage: 'Unexpected positional argument',
        expectedMarkers: ['[REDACTED:absolute_path]'],
        sensitiveValues: ['/srv/private-client/acceptance.md', 'private-client'],
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
      for (const sensitiveValue of testCase.sensitiveValues ?? []) {
        expect(result.stderr).not.toContain(sensitiveValue);
      }

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

function seedAcceptanceSummaryDatabase(
  dbPath: string,
  secretToken: string,
  privateQqId: string,
  options: { linkEvaluatorInvocation?: boolean } = {},
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);

  try {
    runMigrations(db, join(process.cwd(), 'migrations'));
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run('acceptance-user', now, now);
    db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id,
        account_type, verified_level, status,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('qq', privateQqId, 'acceptance-user', 'private', 'observed', 'active', now, now);
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-memory-source-raw',
      'chat.message.received',
      now - 10,
      'gateway',
      'qq',
      `private:qq-${privateQqId}`,
      JSON.stringify({ text: `prior memory source ${secretToken} qq-${privateQqId}` }),
      now - 10,
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-private-raw',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      `private:qq-${privateQqId}`,
      JSON.stringify({ text: `private acceptance text ${secretToken} qq-${privateQqId}` }),
      now,
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-group-raw',
      'chat.message.received',
      now - 10,
      'gateway',
      'qq',
      `group:qq-group-${privateQqId}`,
      JSON.stringify({ text: `group acceptance text ${secretToken} qq-${privateQqId}` }),
      now - 10,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, sender_role, text, has_media, has_quote,
        mentions_bot, reply_to_message_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-memory-source-chat',
      'acceptance-memory-source-raw',
      'msg-memory-source',
      `private:qq-${privateQqId}`,
      'private',
      null,
      `qq-${privateQqId}`,
      null,
      `prior memory source ${secretToken}`,
      0,
      0,
      0,
      null,
      now - 10,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, sender_role, text, has_media, has_quote,
        mentions_bot, reply_to_message_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-private-chat',
      'acceptance-private-raw',
      'msg-private',
      `private:qq-${privateQqId}`,
      'private',
      null,
      `qq-${privateQqId}`,
      null,
      `private acceptance text ${secretToken}`,
      0,
      0,
      0,
      null,
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, sender_role, text, has_media, has_quote,
        mentions_bot, reply_to_message_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-group-chat',
      'acceptance-group-raw',
      'msg-group',
      `group:qq-group-${privateQqId}`,
      'group',
      `qq-group-${privateQqId}`,
      `qq-${privateQqId}`,
      'member',
      `group acceptance text ${secretToken}`,
      0,
      0,
      1,
      null,
      now - 10,
    );
    insertTurnTraceDecisionAndExecution(db, {
      rawEventId: 'acceptance-private-raw',
      turnId: 'acceptance-private-turn',
      traceId: 'acceptance-private-context',
      decisionId: 'acceptance-private-decision',
      executionId: 'acceptance-private-execution',
      conversationId: `private:qq-${privateQqId}`,
      conversationType: 'private',
      groupId: null,
      timestamp: now,
      selectedMemoryIds: ['acceptance-memory'],
      piProvider: 'deepseek',
      piModel: 'deepseek-chat',
    });
    insertBotResponseEvidence(db, {
      rawEventId: 'acceptance-private-bot-raw',
      messageId: 'sent-acceptance-private-execution',
      conversationId: `private:qq-${privateQqId}`,
      conversationType: 'private',
      groupId: null,
      text: `private bot response ${secretToken}`,
      timestamp: now + 2,
    });
    insertTurnTraceDecisionAndExecution(db, {
      rawEventId: 'acceptance-group-raw',
      turnId: 'acceptance-group-turn',
      traceId: 'acceptance-group-context',
      decisionId: 'acceptance-group-decision',
      executionId: 'acceptance-group-execution',
      conversationId: `group:qq-group-${privateQqId}`,
      conversationType: 'group',
      groupId: `qq-group-${privateQqId}`,
      timestamp: now + 1,
      piProvider: 'deepseek',
      piModel: 'deepseek-chat',
    });
    insertBotResponseEvidence(db, {
      rawEventId: 'acceptance-group-bot-raw',
      messageId: 'sent-acceptance-group-execution',
      conversationId: `group:qq-group-${privateQqId}`,
      conversationType: 'group',
      groupId: `qq-group-${privateQqId}`,
      text: `group bot response ${secretToken}`,
      timestamp: now + 3,
    });
    db.prepare(
      `INSERT INTO memory_records (
        id, scope, canonical_user_id, visibility, sensitivity, authority, kind, title, content,
        state, confidence, importance, source_context, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-memory',
      'user',
      'acceptance-user',
      'private_only',
      'normal',
      'user_stated',
      'preference',
      `memory title ${secretToken}`,
      `memory content qq-${privateQqId}`,
      'active',
      0.9,
      0.8,
      'private_chat',
      now - 6,
      now - 5,
    );
    db.prepare(
      `INSERT INTO memory_sources (
        memory_id, source_type, source_id, source_timestamp, extracted_by,
        resolution_state, raw_event_id, chat_message_id, tool_call_id,
        job_id, job_attempt_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-memory',
      'chat_message',
      'acceptance-memory-source-chat',
      now - 10,
      'evaluator',
      'internal',
      null,
      'acceptance-memory-source-chat',
      null,
      null,
      null,
    );
    db.prepare(
      `INSERT INTO memory_revisions (
        id, memory_id, revision_number, change_type, previous_state, new_state,
        reason, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-memory-revision',
      'acceptance-memory',
      1,
      'create',
      null,
      buildMemoryRevisionSnapshot({
        id: 'acceptance-memory',
        scope: 'user',
        canonicalUserId: 'acceptance-user',
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        sourceContext: 'private_chat',
      }),
      `reason ${secretToken}`,
      'system',
      now - 5,
    );
    db.prepare(
      `INSERT INTO memory_records (
        id, scope, canonical_user_id, group_id, conversation_id,
        visibility, sensitivity, authority, kind, title, content,
        state, confidence, importance, source_context, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-group-proposed-memory',
      'user',
      'acceptance-user',
      `qq-group-${privateQqId}`,
      `group:qq-group-${privateQqId}`,
      'same_group_only',
      'normal',
      'user_stated',
      'preference',
      `group memory title ${secretToken}`,
      `group memory content qq-${privateQqId}`,
      'proposed',
      0.8,
      0.7,
      'group_chat',
      now - 6,
      now - 5,
    );
    db.prepare(
      `INSERT INTO memory_sources (
        memory_id, source_type, source_id, source_timestamp, extracted_by,
        resolution_state, raw_event_id, chat_message_id, tool_call_id,
        job_id, job_attempt_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-group-proposed-memory',
      'chat_message',
      'acceptance-group-chat',
      now - 10,
      'evaluator',
      'internal',
      null,
      'acceptance-group-chat',
      null,
      null,
      null,
    );
    db.prepare(
      `INSERT INTO memory_revisions (
        id, memory_id, revision_number, change_type, previous_state, new_state,
        reason, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-group-proposed-memory-revision',
      'acceptance-group-proposed-memory',
      1,
      'create',
      null,
      buildMemoryRevisionSnapshot({
        id: 'acceptance-group-proposed-memory',
        scope: 'user',
        canonicalUserId: 'acceptance-user',
        groupId: `qq-group-${privateQqId}`,
        conversationId: `group:qq-group-${privateQqId}`,
        visibility: 'same_group_only',
        sensitivity: 'normal',
        state: 'proposed',
        sourceContext: 'group_chat',
      }),
      'redacted group proposal',
      'system',
      now - 5,
    );
    db.prepare(
      `INSERT INTO evaluator_decisions (
        id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
        evaluator_version, tool_name, actor_user_id, actor_class, invocation_context,
        source_event_ids, request_created_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-tool-evaluator',
      'acceptance-tool-evaluator-request',
      'tool',
      'acceptance-private-turn',
      'approve',
      'Approved by the configured model evaluator',
      0.96,
      'medium',
      'deepseek/deepseek-chat/acceptance-v1',
      'acceptance-tool-success',
      'acceptance-user',
      'user',
      'private_chat',
      JSON.stringify(['acceptance-private-raw']),
      now,
      now,
    );
    if (options.linkEvaluatorInvocation !== false) {
      insertCompletedAcceptanceEvaluatorInvocation(db, now);
    }
    const insertToolCall = db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by, actor_class,
        invocation_context, status, error_code, error_message, execution_time_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertToolCall.run(
      'acceptance-tool-call-success',
      'acceptance-private-turn',
      'acceptance-tool-success',
      JSON.stringify({ input: secretToken }),
      JSON.stringify({ output: `qq-${privateQqId}` }),
      'pi',
      'user',
      'private_chat',
      'success',
      null,
      null,
      10,
      now,
    );
    db.prepare(
      `UPDATE tool_calls
          SET evaluator_decision_id = ?, actor_user_id = ?
        WHERE id = ?`,
    ).run('acceptance-tool-evaluator', 'acceptance-user', 'acceptance-tool-call-success');
    insertToolCall.run(
      'acceptance-tool-call-rejected',
      'acceptance-private-turn',
      'acceptance-tool-rejected',
      JSON.stringify({ rejectedPayload: `api_key=${secretToken}-qq-${privateQqId}` }),
      null,
      'pi',
      'user',
      'private_chat',
      'rejected',
      `EVALUATOR_REQUIRED_qq-${privateQqId}`,
      `requires evaluator api_key=${secretToken}-qq-${privateQqId}`,
      3,
      now + 1,
    );
    insertToolCall.run(
      'acceptance-tool-call-error',
      'acceptance-private-turn',
      'acceptance-tool-error',
      JSON.stringify({ errorPayload: `token=${secretToken}-qq-${privateQqId}` }),
      JSON.stringify({ hiddenOutput: `qq-${privateQqId}` }),
      'pi',
      'user',
      'private_chat',
      'error',
      `TOOL_HANDLER_ERROR_qq-${privateQqId}`,
      `handler failed token=${secretToken}-qq-${privateQqId}`,
      11,
      now + 2,
    );
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-failure',
      'acceptance-private-raw',
      'acceptance-private-turn',
      now,
      'pi',
      'private',
      'Error',
      'hash-only',
      JSON.stringify({ note: secretToken }),
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, details, redacted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-audit',
      now,
      'memory',
      'summary',
      'memory.create',
      'acceptance-memory',
      'system_worker',
      'background_worker',
      `audit ${secretToken}`,
      JSON.stringify({ platformId: `qq-${privateQqId}` }),
      1,
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary, details,
        redacted, risk_level, evaluator_decision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-tool-audit',
      now,
      'tool',
      'redacted_full',
      'tool.executed',
      'acceptance-tool-call-success',
      'acceptance-user',
      'user',
      'private_chat',
      'Approved tool execution completed',
      '{}',
      1,
      'medium',
      'acceptance-tool-evaluator',
    );
  } finally {
    closeDatabase(db);
  }

  addGroupReplyToBotAcceptanceFlow(dbPath, secretToken, privateQqId);
}

function insertCompletedAcceptanceEvaluatorInvocation(
  db: ReturnType<typeof initDatabase>,
  timestamp: number,
): void {
  const invocationId = 'acceptance-tool-evaluator-invocation';
  db.prepare(
    `INSERT INTO model_invocations (
      id, turn_id, job_attempt_id, context_id, purpose,
      evaluator_request_id, evaluator_domain, prompt_version, call_number,
      provider, model, status, started_at, completed_at,
      tokens_input, tokens_output, tokens_total,
      response_sha256, response_bytes, error_code
    ) VALUES (?, ?, NULL, NULL, 'evaluator', ?, 'tool', ?, 1,
      ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    invocationId,
    'acceptance-private-turn',
    'acceptance-tool-evaluator-request',
    'acceptance-v1',
    'deepseek',
    'deepseek-chat',
    timestamp,
    timestamp,
    12,
    8,
    20,
    'a'.repeat(64),
    128,
  );
  db.prepare(
    `INSERT INTO model_invocation_sources (
      model_invocation_id, raw_event_id, source_ordinal
    ) VALUES (?, ?, 0)`,
  ).run(invocationId, 'acceptance-private-raw');
  db.prepare(
    'UPDATE evaluator_decisions SET model_invocation_id = ? WHERE id = ?',
  ).run(invocationId, 'acceptance-tool-evaluator');
}

function addGroupReplyToBotAcceptanceFlow(dbPath: string, secretToken: string, privateQqId: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  const conversationId = `group:qq-group-${privateQqId}`;
  const groupId = `qq-group-${privateQqId}`;
  const quotedBotMessageId = 'sent-acceptance-group-execution';

  try {
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-group-reply-raw',
      'chat.message.received',
      now + 4,
      'gateway',
      'qq',
      conversationId,
      JSON.stringify({
        message: {
          conversationId: groupId,
          conversationType: 'group',
          content: { text: `group reply-to-bot acceptance text ${secretToken}` },
          mentions: [],
          mentionsBot: false,
          replyToMessageId: quotedBotMessageId,
          senderId: `qq-${privateQqId}`,
        },
      }),
      now + 4,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, sender_role, text, has_media, has_quote,
        mentions_bot, reply_to_message_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-group-reply-chat',
      'acceptance-group-reply-raw',
      'msg-group-reply',
      conversationId,
      'group',
      groupId,
      `qq-${privateQqId}`,
      'member',
      `group reply-to-bot acceptance text ${secretToken}`,
      0,
      1,
      0,
      quotedBotMessageId,
      now + 4,
    );
    insertTurnTraceDecisionAndExecution(db, {
      rawEventId: 'acceptance-group-reply-raw',
      turnId: 'acceptance-group-reply-turn',
      traceId: 'acceptance-group-reply-context',
      decisionId: 'acceptance-group-reply-decision',
      executionId: 'acceptance-group-reply-execution',
      conversationId,
      conversationType: 'group',
      groupId,
      timestamp: now + 4,
      reasons: ['reply_to_bot', 'pi_response_text'],
      piProvider: 'deepseek',
      piModel: 'deepseek-chat',
    });
    insertBotResponseEvidence(db, {
      rawEventId: 'acceptance-group-reply-bot-raw',
      messageId: 'sent-acceptance-group-reply-execution',
      conversationId,
      conversationType: 'group',
      groupId,
      text: `group reply-to-bot response ${secretToken}`,
      timestamp: now + 6,
    });
  } finally {
    closeDatabase(db);
  }
}

function moveGroupReplyFlowToDifferentGroup(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  const groupId = 'qq-group-22222222222';
  const conversationId = `group:${groupId}`;
  const quotedMessageId = 'sent-unrelated-group-response';

  try {
    insertBotResponseEvidence(db, {
      rawEventId: 'acceptance-unrelated-group-bot-raw',
      messageId: quotedMessageId,
      conversationId,
      conversationType: 'group',
      groupId,
      text: 'redacted unrelated group response',
      timestamp: now + 2,
    });
    db.prepare('UPDATE raw_events SET conversation_id = ? WHERE id IN (?, ?)').run(
      conversationId,
      'acceptance-group-reply-raw',
      'acceptance-group-reply-bot-raw',
    );
    db.prepare(
      `UPDATE chat_messages
          SET conversation_id = ?, group_id = ?, reply_to_message_id = ?
        WHERE id = ?`,
    ).run(conversationId, groupId, quotedMessageId, 'acceptance-group-reply-chat');
    db.prepare(
      `UPDATE chat_messages
          SET conversation_id = ?, group_id = ?
        WHERE id = ?`,
    ).run(conversationId, groupId, 'sent-acceptance-group-reply-execution');
    db.prepare('UPDATE agent_turns SET conversation_id = ? WHERE id = ?').run(
      conversationId,
      'acceptance-group-reply-turn',
    );
    db.prepare(
      `UPDATE context_traces
          SET conversation_id = ?, group_id = ?
        WHERE id = ?`,
    ).run(conversationId, groupId, 'acceptance-group-reply-context');
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupReplyQuoteWithUnrelatedBotResponse(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);

  try {
    insertBotResponseEvidence(db, {
      rawEventId: 'acceptance-unrelated-prior-bot-raw',
      messageId: 'sent-unrelated-prior-response',
      conversationId: 'group:qq-group-12345678901',
      conversationType: 'group',
      groupId: 'qq-group-12345678901',
      text: 'redacted unrelated prior response',
      timestamp: now + 2,
    });
    db.prepare('UPDATE chat_messages SET reply_to_message_id = ? WHERE id = ?').run(
      'sent-unrelated-prior-response',
      'acceptance-group-reply-chat',
    );
  } finally {
    closeDatabase(db);
  }
}

function removeGroupReplyToBotAcceptanceFlow(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('DELETE FROM action_executions WHERE id = ?').run('acceptance-group-reply-execution');
    db.prepare('DELETE FROM context_traces WHERE id = ?').run('acceptance-group-reply-context');
    db.prepare('DELETE FROM action_decisions WHERE id = ?').run('acceptance-group-reply-decision');
    db.prepare('DELETE FROM agent_turns WHERE id = ?').run('acceptance-group-reply-turn');
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run('sent-acceptance-group-reply-execution');
    db.prepare('DELETE FROM raw_events WHERE id = ?').run('acceptance-group-reply-bot-raw');
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run('acceptance-group-reply-chat');
    db.prepare('DELETE FROM raw_events WHERE id = ?').run('acceptance-group-reply-raw');
  } finally {
    closeDatabase(db);
  }
}

function removeGroupTurnActionContextEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('DELETE FROM action_executions WHERE action_decision_id = ?').run('acceptance-group-decision');
    db.prepare('DELETE FROM action_decisions WHERE id = ?').run('acceptance-group-decision');
    db.prepare('DELETE FROM context_traces WHERE id = ?').run('acceptance-group-context');
    db.prepare('DELETE FROM agent_turns WHERE id = ?').run('acceptance-group-turn');
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupLinkedFlowWithSplitEvidence(dbPath: string, privateQqId: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  const groupConversationId = `group:qq-group-${privateQqId}`;
  const groupId = `qq-group-${privateQqId}`;

  try {
    db.prepare('DELETE FROM action_executions WHERE action_decision_id = ?').run('acceptance-group-decision');
    db.prepare('DELETE FROM action_decisions WHERE id = ?').run('acceptance-group-decision');
    db.prepare('DELETE FROM context_traces WHERE id = ?').run('acceptance-group-context');
    db.prepare('DELETE FROM agent_turns WHERE id = ?').run('acceptance-group-turn');

    insertTurnTraceDecisionAndExecution(db, {
      rawEventId: 'acceptance-group-raw',
      turnId: 'acceptance-group-context-only-turn',
      traceId: 'acceptance-group-context-only-trace',
      decisionId: 'acceptance-group-context-only-decision',
      executionId: 'acceptance-group-context-only-execution',
      conversationId: groupConversationId,
      conversationType: 'group',
      groupId,
      timestamp: now + 2,
    });
    db.prepare('DELETE FROM action_executions WHERE action_decision_id = ?').run(
      'acceptance-group-context-only-decision',
    );
    db.prepare('DELETE FROM action_decisions WHERE id = ?').run('acceptance-group-context-only-decision');
    db.prepare('UPDATE agent_turns SET action_decision_id = NULL WHERE id = ?').run(
      'acceptance-group-context-only-turn',
    );

    insertTurnTraceDecisionAndExecution(db, {
      rawEventId: 'acceptance-group-raw',
      turnId: 'acceptance-group-action-only-turn',
      traceId: 'acceptance-group-action-only-trace',
      decisionId: 'acceptance-group-action-only-decision',
      executionId: 'acceptance-group-action-only-execution',
      conversationId: groupConversationId,
      conversationType: 'group',
      groupId,
      timestamp: now + 3,
    });
    db.prepare('DELETE FROM context_traces WHERE id = ?').run('acceptance-group-action-only-trace');
    db.prepare('UPDATE agent_turns SET context_pack_id = NULL WHERE id = ?').run('acceptance-group-action-only-turn');
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupTurnTriggerWithUnnormalizedRawEvent(
  dbPath: string,
  secretToken: string,
  privateQqId: string,
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);

  try {
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-group-unlinked-raw',
      'chat.message.received',
      now + 4,
      'gateway',
      'qq',
      `group:qq-group-${privateQqId}`,
      JSON.stringify({ text: `unlinked group acceptance text ${secretToken} qq-${privateQqId}` }),
      now + 4,
    );
    db.prepare('UPDATE agent_turns SET trigger_event_id = ? WHERE id = ?').run(
      'acceptance-group-unlinked-raw',
      'acceptance-group-turn',
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupTurnSelectedLinksWithMissingRows(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare(
      `UPDATE agent_turns
          SET context_pack_id = ?,
              action_decision_id = ?
        WHERE id = ?`,
    ).run('acceptance-group-missing-context', 'acceptance-group-missing-decision', 'acceptance-group-turn');
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupRawEventTypeAndPlatform(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE raw_events SET type = ?, platform = ? WHERE id = ?').run(
      'system.lifecycle',
      'not-qq',
      'acceptance-group-raw',
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupExecutionActionType(dbPath: string, actionType: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE action_executions SET action_type = ? WHERE id = ?').run(
      actionType,
      'acceptance-group-execution',
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupExecutionWithDowngradedFoldedForwardFallback(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare(
      `UPDATE action_executions
          SET action_type = ?,
              status = ?,
              downgraded_reason = ?
        WHERE id = ?`,
    ).run(
      'send_folded_forward',
      'downgraded',
      'folded_forward_text_fallback',
      'acceptance-group-execution',
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupExecutionWithDowngradedReactOnlyFallback(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare(
      `UPDATE action_executions
          SET action_type = ?,
              status = ?,
              downgraded_reason = ?
        WHERE id = ?`,
    ).run(
      'react_only',
      'downgraded',
      'reaction_face_message_fallback',
      'acceptance-group-execution',
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupExecutionWithNonReplySuccess(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare(
      `UPDATE action_executions
          SET action_type = ?,
              executed_message_id = NULL
        WHERE id = ?`,
    ).run('silent_store', 'acceptance-group-execution');
  } finally {
    closeDatabase(db);
  }
}

function removeGroupBotResponseEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run('sent-acceptance-group-execution');
    db.prepare('DELETE FROM raw_events WHERE id = ?').run('acceptance-group-bot-raw');
  } finally {
    closeDatabase(db);
  }
}

function removeGroupExactMentionEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE chat_messages SET mentions_bot = 0 WHERE id = ?').run('acceptance-group-chat');
  } finally {
    closeDatabase(db);
  }
}

function removeGroupScopeEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE chat_messages SET group_id = NULL WHERE id = ?').run('acceptance-group-chat');
  } finally {
    closeDatabase(db);
  }
}

function replaceAllAcceptanceGroupScopeIds(dbPath: string, groupId: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare("UPDATE chat_messages SET group_id = ? WHERE conversation_type = 'group'").run(groupId);
    db.prepare("UPDATE context_traces SET group_id = ? WHERE conversation_type = 'group'").run(groupId);
    db.prepare('UPDATE memory_records SET group_id = ? WHERE group_id IS NOT NULL').run(groupId);
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupContextScopeEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE context_traces SET group_id = ? WHERE id = ?').run(
      'qq-group-222222222',
      'acceptance-group-context',
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceGroupBotResponseScopeEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE chat_messages SET group_id = ? WHERE id = ?').run(
      'qq-group-222222222',
      'sent-acceptance-group-execution',
    );
  } finally {
    closeDatabase(db);
  }
}

function removeSelectedGovernedMemoryContextEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE context_traces SET selected_memory_ids = ?').run('[]');
  } finally {
    closeDatabase(db);
  }
}

function mismatchSelectedMemoryRawEventConversation(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE raw_events SET conversation_id = ? WHERE id = ?').run(
      'private:internal-other-conversation',
      'acceptance-memory-source-raw',
    );
  } finally {
    closeDatabase(db);
  }
}

function removeSelectedMemoryCandidateEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE context_traces SET candidate_memory_ids = ? WHERE id = ?').run(
      '[]',
      'acceptance-private-context',
    );
  } finally {
    closeDatabase(db);
  }
}

function removeSelectedMemoryPayloadEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE context_traces SET memories = ? WHERE id = ?').run(
      '[]',
      'acceptance-private-context',
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedMemorySourceWithTargetTrigger(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    replaceAcceptanceMemorySource(db, {
      sourceType: 'chat_message',
      sourceId: 'acceptance-private-chat',
      sourceTimestamp: now,
      resolutionState: 'internal',
      chatMessageId: 'acceptance-private-chat',
    });
  } finally {
    closeDatabase(db);
  }
}

function makeSelectedMemoryChatSourcePostdateMemory(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare('UPDATE memory_sources SET source_timestamp = ? WHERE memory_id = ?').run(
      now - 4,
      'acceptance-memory',
    );
    db.prepare('UPDATE raw_events SET timestamp = ?, created_at = ? WHERE id = ?').run(
      now - 4,
      now - 4,
      'acceptance-memory-source-raw',
    );
    db.prepare('UPDATE chat_messages SET timestamp = ? WHERE id = ?').run(
      now - 4,
      'acceptance-memory-source-chat',
    );
  } finally {
    closeDatabase(db);
  }
}

function makeSelectedMemoryCoincideWithSourceEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare('UPDATE memory_records SET created_at = ?, updated_at = ? WHERE id = ?').run(
      now - 10,
      now - 10,
      'acceptance-memory',
    );
    db.prepare('UPDATE memory_revisions SET created_at = ? WHERE memory_id = ?').run(
      now - 10,
      'acceptance-memory',
    );
  } finally {
    closeDatabase(db);
  }
}

function addInvalidSelectedMemoryEvidence(
  dbPath: string,
  kind: 'prohibited' | 'cross_scope',
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  const memoryId = kind === 'prohibited'
    ? 'acceptance-prohibited-memory'
    : 'acceptance-cross-scope-memory';
  const ownerId = kind === 'prohibited' ? 'acceptance-user' : 'acceptance-other-user';
  const sourceChatId = kind === 'prohibited'
    ? 'acceptance-memory-source-chat'
    : 'acceptance-other-memory-source-chat';

  try {
    if (kind === 'cross_scope') {
      db.prepare(
        `INSERT INTO canonical_users (id, created_at, last_seen_at)
         VALUES (?, ?, ?)`,
      ).run(ownerId, now - 20, now - 20);
      db.prepare(
        `INSERT INTO platform_accounts (
          platform, platform_account_id, canonical_user_id,
          account_type, verified_level, status, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('qq', '22222222222', ownerId, 'private', 'observed', 'active', now - 20, now - 20);
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-other-memory-source-raw',
        'chat.message.received',
        now - 20,
        'gateway',
        'qq',
        'private:qq-22222222222',
        '{}',
        now - 20,
      );
      db.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id, conversation_type,
          group_id, sender_id, text, has_media, has_quote, mentions_bot, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceChatId,
        'acceptance-other-memory-source-raw',
        'msg-other-memory-source',
        'private:qq-22222222222',
        'private',
        null,
        'qq-22222222222',
        'redacted other-user source',
        0,
        0,
        0,
        now - 20,
      );
    }

    db.prepare(
      `INSERT INTO memory_records (
        id, scope, canonical_user_id, visibility, sensitivity, authority, kind,
        title, content, state, confidence, importance, source_context,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      memoryId,
      'user',
      ownerId,
      'private_only',
      kind === 'prohibited' ? 'prohibited' : 'normal',
      'user_stated',
      'preference',
      'redacted invalid memory',
      'redacted invalid memory content',
      'active',
      0.9,
      0.8,
      'private_chat',
      now - 8,
      now - 8,
    );
    db.prepare(
      `INSERT INTO memory_sources (
        memory_id, source_type, source_id, source_timestamp, extracted_by,
        resolution_state, raw_event_id, chat_message_id, tool_call_id,
        job_id, job_attempt_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      memoryId,
      'chat_message',
      sourceChatId,
      kind === 'prohibited' ? now - 10 : now - 20,
      'evaluator',
      'internal',
      null,
      sourceChatId,
      null,
      null,
      null,
    );
    db.prepare(
      `INSERT INTO memory_revisions (
        id, memory_id, revision_number, change_type, previous_state, new_state,
        reason, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${memoryId}-revision`,
      memoryId,
      1,
      'create',
      null,
      buildMemoryRevisionSnapshot({
        id: memoryId,
        scope: 'user',
        canonicalUserId: ownerId,
        visibility: 'private_only',
        sensitivity: kind === 'prohibited' ? 'prohibited' : 'normal',
        state: 'active',
        sourceContext: 'private_chat',
      }),
      'redacted test reason',
      'system',
      now - 7,
    );

    const selectedIds = ['acceptance-memory', memoryId];
    db.prepare(
      `UPDATE context_traces
          SET candidate_memory_ids = ?, selected_memory_ids = ?, memories = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify(selectedIds),
      JSON.stringify(selectedIds),
      JSON.stringify(selectedIds.map((id) => ({
        memoryId: id,
        scope: 'user',
        title: 'redacted memory title',
      }))),
      'acceptance-private-context',
    );
  } finally {
    closeDatabase(db);
  }
}

function configureSelectedGroupDerivedUserMemory(
  dbPath: string,
  input: {
    privateQqId: string;
    provenance: 'chat' | 'tool';
    visibility: 'same_group_only' | 'same_user_any_context' | 'public';
  },
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  const groupId = `qq-group-${input.privateQqId}`;
  const conversationId = `group:${groupId}`;

  try {
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-prior-group-memory-raw',
      'chat.message.received',
      now - 10,
      'gateway',
      'qq',
      conversationId,
      '{}',
      now - 10,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-prior-group-memory-chat',
      'acceptance-prior-group-memory-raw',
      'msg-prior-group-memory',
      conversationId,
      'group',
      groupId,
      `qq-${input.privateQqId}`,
      'redacted prior group memory source',
      0,
      0,
      0,
      now - 10,
    );

    db.prepare(
      `UPDATE memory_records
          SET scope = 'user', canonical_user_id = ?, group_id = ?, conversation_id = ?,
              visibility = ?, sensitivity = 'normal', state = 'active',
              source_context = 'group_chat', created_at = ?, updated_at = ?, expires_at = NULL
        WHERE id = ?`,
    ).run(
      'acceptance-user',
      groupId,
      conversationId,
      input.visibility,
      now - 7,
      now - 5,
      'acceptance-memory',
    );
    db.prepare(
      `UPDATE memory_revisions
          SET change_type = 'approve', new_state = ?, created_at = ?
        WHERE memory_id = ?`,
    ).run(
      buildMemoryRevisionSnapshot({
        id: 'acceptance-memory',
        scope: 'user',
        canonicalUserId: 'acceptance-user',
        groupId,
        conversationId,
        visibility: input.visibility,
        sensitivity: 'normal',
        state: 'active',
        sourceContext: 'group_chat',
      }),
      now - 5,
      'acceptance-memory',
    );
    db.prepare(
      `UPDATE context_traces
          SET candidate_memory_ids = '[]', selected_memory_ids = '[]', memories = '[]'
        WHERE id = ?`,
    ).run('acceptance-private-context');
    db.prepare(
      `UPDATE context_traces
          SET candidate_memory_ids = ?, selected_memory_ids = ?, memories = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify(['acceptance-memory']),
      JSON.stringify(['acceptance-memory']),
      JSON.stringify([{
        memoryId: 'acceptance-memory',
        scope: 'user',
        title: 'redacted memory title',
      }]),
      'acceptance-group-context',
    );

    if (input.provenance === 'chat') {
      replaceAcceptanceMemorySource(db, {
        sourceType: 'chat_message',
        sourceId: 'acceptance-prior-group-memory-chat',
        sourceTimestamp: now - 10,
        resolutionState: 'internal',
        chatMessageId: 'acceptance-prior-group-memory-chat',
      });
    } else {
      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, context_pack_id, pi_model,
          pi_provider, response_text, status, tokens_input, tokens_output,
          tokens_total, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-prior-group-tool-turn',
        conversationId,
        'acceptance-prior-group-memory-raw',
        'acceptance-prior-group-tool-context',
        'mock',
        'mock',
        'redacted response',
        'completed',
        1,
        1,
        2,
        now - 9,
        now - 8,
      );
      db.prepare(
        `INSERT INTO context_traces (
          id, turn_id, conversation_id, conversation_type, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-prior-group-tool-context',
        'acceptance-prior-group-tool-turn',
        conversationId,
        'group',
        groupId,
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '{}',
        '[]',
        now - 9,
      );
      db.prepare(
        `INSERT INTO tool_calls (
          id, turn_id, tool_name, input, output, requested_by,
          actor_user_id, actor_class, invocation_context, status,
          error_code, error_message, execution_time_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-prior-group-tool-call',
        'acceptance-prior-group-tool-turn',
        'acceptance-prior-group-tool',
        '{}',
        '{}',
        'pi',
        'acceptance-user',
        'user',
        'group_chat',
        'success',
        null,
        null,
        1,
        now - 8,
      );
      replaceAcceptanceMemorySource(db, {
        sourceType: 'tool_output',
        sourceId: 'acceptance-prior-group-tool-call',
        sourceTimestamp: now - 8,
        resolutionState: 'internal',
        toolCallId: 'acceptance-prior-group-tool-call',
      });
    }
  } finally {
    closeDatabase(db);
  }
}

function makeSelectedGroupToolSourcePostdateMemory(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare('UPDATE tool_calls SET created_at = ? WHERE id = ?').run(
      now - 6,
      'acceptance-prior-group-tool-call',
    );
    db.prepare('UPDATE memory_sources SET source_timestamp = ? WHERE memory_id = ?').run(
      now - 6,
      'acceptance-memory',
    );
  } finally {
    closeDatabase(db);
  }
}

function removeDefaultConservativeGroupMemory(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run('acceptance-group-proposed-memory');
    db.prepare('DELETE FROM memory_revisions WHERE memory_id = ?').run('acceptance-group-proposed-memory');
    db.prepare('DELETE FROM memory_records WHERE id = ?').run('acceptance-group-proposed-memory');
  } finally {
    closeDatabase(db);
  }
}

function makeDefaultGroupMemoryVisibilityBroad(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE memory_records SET visibility = ? WHERE id = ?').run(
      'same_user_any_context',
      'acceptance-group-proposed-memory',
    );
    db.prepare(
      `UPDATE memory_revisions
          SET new_state = json_set(new_state, '$.visibility', ?)
        WHERE memory_id = ?`,
    ).run('same_user_any_context', 'acceptance-group-proposed-memory');
  } finally {
    closeDatabase(db);
  }
}

function makeSelectedMemoryCreatedAfterContext(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare('UPDATE memory_records SET created_at = ? WHERE id = ?').run(now + 1, 'acceptance-memory');
  } finally {
    closeDatabase(db);
  }
}

function makeSelectedMemoryRevisionAfterContext(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare('UPDATE memory_revisions SET created_at = ? WHERE memory_id = ?').run(
      now + 1,
      'acceptance-memory',
    );
  } finally {
    closeDatabase(db);
  }
}

function makeSelectedMemoryRevisionIncoherent(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE memory_revisions SET new_state = ? WHERE memory_id = ?').run(
      JSON.stringify({ state: 'proposed' }),
      'acceptance-memory',
    );
  } finally {
    closeDatabase(db);
  }
}

function makeSelectedMemoryExpiredAtContext(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare('UPDATE memory_records SET expires_at = ? WHERE id = ?').run(now, 'acceptance-memory');
  } finally {
    closeDatabase(db);
  }
}

function makeSelectedMemoryExpireBetweenTurnAndContext(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare('UPDATE memory_records SET expires_at = ? WHERE id = ?').run(now + 1, 'acceptance-memory');
    db.prepare('UPDATE context_traces SET created_at = ? WHERE id = ?').run(
      now + 1,
      'acceptance-private-context',
    );
    db.prepare('UPDATE action_decisions SET created_at = ? WHERE id = ?').run(
      now + 2,
      'acceptance-private-decision',
    );
    db.prepare('UPDATE action_executions SET executed_at = ? WHERE id = ?').run(
      now + 2,
      'acceptance-private-execution',
    );
  } finally {
    closeDatabase(db);
  }
}

function makeSelectedMemoryContextPostdateDecision(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare('UPDATE context_traces SET created_at = ? WHERE id = ?').run(
      now + 1,
      'acceptance-private-context',
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithUnselectedContextEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);

  try {
    db.prepare('UPDATE context_traces SET selected_memory_ids = ?').run('[]');
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-private-unselected-memory-context',
      'acceptance-private-turn',
      'private:redacted-local-test',
      'private',
      null,
      JSON.stringify(['acceptance-memory']),
      JSON.stringify(['acceptance-memory']),
      '[]',
      '[]',
      '[]',
      '[]',
      '{}',
      '[]',
      now + 10,
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithPrivateOnlyGroupContextEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    db.prepare('UPDATE context_traces SET selected_memory_ids = ? WHERE id = ?').run(
      '[]',
      'acceptance-private-context',
    );
    db.prepare('UPDATE context_traces SET selected_memory_ids = ? WHERE id = ?').run(
      JSON.stringify(['acceptance-memory']),
      'acceptance-group-context',
    );
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithOtherUserEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run('acceptance-other-user', now, now);
    db.prepare(
      `UPDATE memory_records
          SET canonical_user_id = ?,
              visibility = ?
        WHERE id = ?`,
    ).run('acceptance-other-user', 'same_user_any_context', 'acceptance-memory');
    db.prepare(
      `UPDATE memory_revisions
          SET new_state = json_set(
            new_state,
            '$.canonicalUserId', ?,
            '$.visibility', ?
          )
        WHERE memory_id = ?`,
    ).run('acceptance-other-user', 'same_user_any_context', 'acceptance-memory');
  } finally {
    closeDatabase(db);
  }
}

function replaceAcceptanceMemorySource(
  db: ReturnType<typeof initDatabase>,
  input: {
    sourceType: 'raw_event' | 'chat_message' | 'tool_output' | 'worker_extraction' | 'user_command';
    sourceId: string;
    resolutionState: 'internal' | 'external' | 'legacy_unresolved';
    sourceTimestamp?: number;
    rawEventId?: string;
    chatMessageId?: string;
    toolCallId?: string;
    jobId?: string;
    jobAttemptId?: string;
  },
): void {
  db.prepare(
    `UPDATE memory_sources
        SET source_type = ?,
            source_id = ?,
            source_timestamp = COALESCE(?, source_timestamp),
            resolution_state = ?,
            raw_event_id = ?,
            chat_message_id = ?,
            tool_call_id = ?,
            job_id = ?,
            job_attempt_id = ?
      WHERE memory_id = ?`,
  ).run(
    input.sourceType,
    input.sourceId,
    input.sourceTimestamp ?? null,
    input.resolutionState,
    input.rawEventId ?? null,
    input.chatMessageId ?? null,
    input.toolCallId ?? null,
    input.jobId ?? null,
    input.jobAttemptId ?? null,
    'acceptance-memory',
  );
}

function replaceSelectedGovernedMemoryWithUnresolvableSourceEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    replaceAcceptanceMemorySource(db, {
      sourceType: 'chat_message',
      sourceId: 'missing-chat-message-source',
      resolutionState: 'legacy_unresolved',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithCollidingCanonicalChatSourceEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    replaceAcceptanceMemorySource(db, {
      sourceType: 'chat_message',
      sourceId: 'acceptance-private-chat',
      resolutionState: 'internal',
      chatMessageId: 'sent-acceptance-private-execution',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithLegacyChatAliasEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    replaceAcceptanceMemorySource(db, {
      sourceType: 'chat_message',
      sourceId: 'msg-memory-source',
      resolutionState: 'legacy_unresolved',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithExternalUserCommandEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    replaceAcceptanceMemorySource(db, {
      sourceType: 'user_command',
      sourceId: 'external:user-command:acceptance-test',
      resolutionState: 'external',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithRejectedToolSourceEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    replaceAcceptanceMemorySource(db, {
      sourceType: 'tool_output',
      sourceId: 'acceptance-tool-call-rejected',
      resolutionState: 'internal',
      toolCallId: 'acceptance-tool-call-rejected',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithSuccessfulToolSourceEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  try {
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider,
        response_text, status, tokens_input, tokens_output, tokens_total,
        started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-memory-source-turn',
      'private:qq-12345678901',
      'acceptance-memory-source-raw',
      'mock',
      'mock',
      'redacted prior source turn',
      'completed',
      1,
      1,
      2,
      now - 9,
      now - 8,
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        error_code, error_message, execution_time_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-prior-tool-call-success',
      'acceptance-memory-source-turn',
      'acceptance-prior-tool',
      '{}',
      '{}',
      'pi',
      'acceptance-user',
      'user',
      'private_chat',
      'success',
      null,
      null,
      1,
      now - 9,
    );
    replaceAcceptanceMemorySource(db, {
      sourceType: 'tool_output',
      sourceId: 'acceptance-prior-tool-call-success',
      sourceTimestamp: now - 9,
      resolutionState: 'internal',
      toolCallId: 'acceptance-prior-tool-call-success',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithConflictingActorToolSourceEvidence(
  dbPath: string,
  secretToken: string,
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);

  try {
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run('acceptance-tool-source-other-sender', now, now);
    db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id,
        account_type, verified_level, status,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'qq',
      '22222222222',
      'acceptance-tool-source-other-sender',
      'private',
      'observed',
      'active',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-tool-conflicting-actor-raw',
      'chat.message.received',
      now + 4,
      'gateway',
      'qq',
      'private:qq-22222222222',
      JSON.stringify({ text: `conflicting actor source turn text ${secretToken}` }),
      now + 4,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-tool-conflicting-actor-chat',
      'acceptance-tool-conflicting-actor-raw',
      'msg-tool-conflicting-actor',
      'private:qq-22222222222',
      'private',
      'qq-22222222222',
      `conflicting actor source turn text ${secretToken}`,
      0,
      0,
      0,
      now + 4,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id, pi_model,
        pi_provider, action_decision_id, response_text, status,
        tokens_input, tokens_output, tokens_total, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-tool-conflicting-actor-turn',
      'private:qq-22222222222',
      'acceptance-tool-conflicting-actor-raw',
      'acceptance-tool-conflicting-actor-context',
      'mock',
      'mock',
      null,
      'redacted response',
      'completed',
      1,
      1,
      2,
      now + 4,
      now + 5,
    );
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-tool-conflicting-actor-context',
      'acceptance-tool-conflicting-actor-turn',
      'private:qq-22222222222',
      'private',
      null,
      '[]',
      '[]',
      '[]',
      '[]',
      '[]',
      '[]',
      '{}',
      '[]',
      now + 4,
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        error_code, error_message, execution_time_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-tool-call-conflicting-actor-success',
      'acceptance-tool-conflicting-actor-turn',
      'acceptance-tool-conflicting-actor',
      JSON.stringify({ input: `conflicting actor tool source input ${secretToken}` }),
      JSON.stringify({ output: `conflicting actor tool source output ${secretToken}` }),
      'pi',
      'acceptance-user',
      'user',
      'private_chat',
      'success',
      null,
      null,
      12,
      now + 5,
    );
    replaceAcceptanceMemorySource(db, {
      sourceType: 'tool_output',
      sourceId: 'acceptance-tool-call-conflicting-actor-success',
      sourceTimestamp: now + 5,
      resolutionState: 'internal',
      toolCallId: 'acceptance-tool-call-conflicting-actor-success',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedGroupMemoryWithToolSourceEvidence(
  dbPath: string,
  input: {
    privateQqId: string;
    secretToken: string;
    sourceGroup: 'matching' | 'other';
  },
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  const groupId = `qq-group-${input.privateQqId}`;
  const groupConversationId = `group:${groupId}`;
  const sourceId = input.sourceGroup === 'matching'
    ? 'acceptance-tool-call-group-success'
    : 'acceptance-tool-call-other-group-success';
  const sourceTurnId = input.sourceGroup === 'matching'
    ? 'acceptance-tool-matching-group-turn'
    : 'acceptance-tool-other-group-turn';
  const toolOutputLabel = input.sourceGroup === 'matching'
    ? 'matching group tool source output'
    : 'other group tool source output';

  try {
    db.prepare(
      `UPDATE memory_records
          SET scope = ?,
              canonical_user_id = NULL,
              visibility = ?,
              group_id = ?,
              conversation_id = ?,
              source_context = ?
        WHERE id = ?`,
    ).run('group', 'same_group_only', groupId, groupConversationId, 'group_chat', 'acceptance-memory');
    db.prepare('UPDATE memory_revisions SET new_state = ? WHERE memory_id = ?').run(
      buildMemoryRevisionSnapshot({
        id: 'acceptance-memory',
        scope: 'group',
        groupId,
        conversationId: groupConversationId,
        visibility: 'same_group_only',
        sensitivity: 'normal',
        state: 'active',
        sourceContext: 'group_chat',
      }),
      'acceptance-memory',
    );
    db.prepare(
      `UPDATE context_traces
          SET candidate_memory_ids = ?, selected_memory_ids = ?, memories = ?
        WHERE id = ?`,
    ).run(
      '[]',
      '[]',
      '[]',
      'acceptance-private-context',
    );
    db.prepare(
      `UPDATE context_traces
          SET candidate_memory_ids = ?, selected_memory_ids = ?, memories = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify(['acceptance-memory']),
      JSON.stringify(['acceptance-memory']),
      JSON.stringify([{
        memoryId: 'acceptance-memory',
        scope: 'group',
        title: 'redacted memory title',
      }]),
      'acceptance-group-context',
    );

    if (input.sourceGroup === 'matching') {
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform, conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-tool-matching-group-raw',
        'chat.message.received',
        now - 10,
        'gateway',
        'qq',
        groupConversationId,
        '{}',
        now - 10,
      );
      db.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id, conversation_type,
          group_id, sender_id, text, has_media, has_quote, mentions_bot, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-tool-matching-group-chat',
        'acceptance-tool-matching-group-raw',
        'msg-tool-matching-group',
        groupConversationId,
        'group',
        groupId,
        `qq-${input.privateQqId}`,
        'redacted matching group source',
        0,
        0,
        0,
        now - 10,
      );
      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, context_pack_id, pi_model,
          pi_provider, response_text, status, tokens_input, tokens_output,
          tokens_total, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceTurnId,
        groupConversationId,
        'acceptance-tool-matching-group-raw',
        'acceptance-tool-matching-group-context',
        'mock',
        'mock',
        'redacted response',
        'completed',
        1,
        1,
        2,
        now - 9,
        now - 8,
      );
      db.prepare(
        `INSERT INTO context_traces (
          id, turn_id, conversation_id, conversation_type, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-tool-matching-group-context',
        sourceTurnId,
        groupConversationId,
        'group',
        groupId,
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '{}',
        '[]',
        now - 9,
      );
    } else {
      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, context_pack_id, pi_model,
          pi_provider, action_decision_id, response_text, status,
          tokens_input, tokens_output, tokens_total, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceTurnId,
        'group:qq-group-22222222222',
        'acceptance-group-raw',
        'acceptance-tool-other-group-context',
        'mock',
        'mock',
        null,
        'redacted response',
        'completed',
        1,
        1,
        2,
        now + 4,
        now + 5,
      );
      db.prepare(
        `INSERT INTO context_traces (
          id, turn_id, conversation_id, conversation_type, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-tool-other-group-context',
        sourceTurnId,
        'group:qq-group-22222222222',
        'group',
        'qq-group-22222222222',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '{}',
        '[]',
        now + 4,
      );
    }

    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_class, invocation_context, status, error_code, error_message,
        execution_time_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sourceId,
      sourceTurnId,
      'acceptance-group-tool',
      JSON.stringify({ input: `${toolOutputLabel} input ${input.secretToken}` }),
      JSON.stringify({ output: `${toolOutputLabel} ${input.secretToken}` }),
      'pi',
      'user',
      'group_chat',
      'success',
      null,
      null,
      12,
      input.sourceGroup === 'matching' ? now - 8 : now + 5,
    );
    replaceAcceptanceMemorySource(db, {
      sourceType: 'tool_output',
      sourceId,
      sourceTimestamp: input.sourceGroup === 'matching' ? now - 8 : now + 5,
      resolutionState: 'internal',
      toolCallId: sourceId,
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedConversationMemoryWithToolSourceEvidence(
  dbPath: string,
  input: {
    privateQqId: string;
    secretToken: string;
    sourceConversation: 'matching' | 'other';
  },
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);
  const conversationId = `private:qq-${input.privateQqId}`;
  const sourceId = input.sourceConversation === 'matching'
    ? 'acceptance-tool-call-conversation-success'
    : 'acceptance-tool-call-other-conversation-success';
  const sourceTurnId = input.sourceConversation === 'matching'
    ? 'acceptance-tool-matching-conversation-turn'
    : 'acceptance-tool-other-conversation-turn';
  const toolOutputLabel = input.sourceConversation === 'matching'
    ? 'matching conversation tool source output'
    : 'other conversation tool source output';

  try {
    db.prepare(
      `UPDATE memory_records
          SET scope = ?,
              canonical_user_id = NULL,
              visibility = ?,
              group_id = NULL,
              conversation_id = ?,
              source_context = ?
        WHERE id = ?`,
    ).run('conversation', 'private_only', conversationId, 'private_chat', 'acceptance-memory');
    db.prepare('UPDATE memory_revisions SET new_state = ? WHERE memory_id = ?').run(
      buildMemoryRevisionSnapshot({
        id: 'acceptance-memory',
        scope: 'conversation',
        conversationId,
        visibility: 'private_only',
        sensitivity: 'normal',
        state: 'active',
        sourceContext: 'private_chat',
      }),
      'acceptance-memory',
    );

    if (input.sourceConversation === 'matching') {
      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, context_pack_id, pi_model,
          pi_provider, response_text, status, tokens_input, tokens_output,
          tokens_total, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceTurnId,
        conversationId,
        'acceptance-memory-source-raw',
        'acceptance-tool-matching-conversation-context',
        'mock',
        'mock',
        'redacted response',
        'completed',
        1,
        1,
        2,
        now - 9,
        now - 8,
      );
      db.prepare(
        `INSERT INTO context_traces (
          id, turn_id, conversation_id, conversation_type, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-tool-matching-conversation-context',
        sourceTurnId,
        conversationId,
        'private',
        null,
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '{}',
        '[]',
        now - 9,
      );
    } else {
      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, context_pack_id, pi_model,
          pi_provider, action_decision_id, response_text, status,
          tokens_input, tokens_output, tokens_total, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceTurnId,
        'private:qq-22222222222',
        'acceptance-private-raw',
        'acceptance-tool-other-conversation-context',
        'mock',
        'mock',
        null,
        'redacted response',
        'completed',
        1,
        1,
        2,
        now + 4,
        now + 5,
      );
      db.prepare(
        `INSERT INTO context_traces (
          id, turn_id, conversation_id, conversation_type, group_id,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acceptance-tool-other-conversation-context',
        sourceTurnId,
        'private:qq-22222222222',
        'private',
        null,
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        '{}',
        '[]',
        now + 4,
      );
    }

    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_class, invocation_context, status, error_code, error_message,
        execution_time_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sourceId,
      sourceTurnId,
      'acceptance-conversation-tool',
      JSON.stringify({ input: `${toolOutputLabel} input ${input.secretToken}` }),
      JSON.stringify({ output: `${toolOutputLabel} ${input.secretToken}` }),
      'pi',
      'user',
      'private_chat',
      'success',
      null,
      null,
      12,
      input.sourceConversation === 'matching' ? now - 8 : now + 5,
    );
    replaceAcceptanceMemorySource(db, {
      sourceType: 'tool_output',
      sourceId,
      sourceTimestamp: input.sourceConversation === 'matching' ? now - 8 : now + 5,
      resolutionState: 'internal',
      toolCallId: sourceId,
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithOtherUserSuccessfulToolSourceEvidence(
  dbPath: string,
  secretToken: string,
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);

  try {
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run('acceptance-tool-other-user', now, now);
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        error_code, error_message, execution_time_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-tool-call-other-user-success',
      'acceptance-private-turn',
      'acceptance-tool-other-user',
      JSON.stringify({ input: `other user tool source input ${secretToken}` }),
      JSON.stringify({ output: `other user tool source output ${secretToken}` }),
      'pi',
      'acceptance-tool-other-user',
      'user',
      'private_chat',
      'success',
      null,
      null,
      12,
      now + 3,
    );
    replaceAcceptanceMemorySource(db, {
      sourceType: 'tool_output',
      sourceId: 'acceptance-tool-call-other-user-success',
      sourceTimestamp: now + 3,
      resolutionState: 'internal',
      toolCallId: 'acceptance-tool-call-other-user-success',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithBotResponseChatSourceEvidence(dbPath: string): void {
  const db = initDatabase({ path: dbPath });
  try {
    replaceAcceptanceMemorySource(db, {
      sourceType: 'chat_message',
      sourceId: 'sent-acceptance-private-execution',
      resolutionState: 'internal',
      chatMessageId: 'sent-acceptance-private-execution',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithOtherUserChatSourceEvidence(
  dbPath: string,
  secretToken: string,
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);

  try {
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run('acceptance-source-other-user', now, now);
    db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id,
        account_type, verified_level, status,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('qq', '22222222222', 'acceptance-source-other-user', 'private', 'observed', 'active', now, now);
    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform, conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-other-source-raw',
      'chat.message.received',
      now + 20,
      'gateway',
      'qq',
      'private:qq-22222222222',
      JSON.stringify({ text: `other user source text ${secretToken}` }),
      now + 20,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-other-source-chat',
      'acceptance-other-source-raw',
      'msg-other-source',
      'private:qq-22222222222',
      'private',
      'qq-22222222222',
      `other user source text ${secretToken}`,
      0,
      0,
      0,
      now + 20,
    );
    replaceAcceptanceMemorySource(db, {
      sourceType: 'chat_message',
      sourceId: 'acceptance-other-source-chat',
      sourceTimestamp: now + 20,
      resolutionState: 'internal',
      chatMessageId: 'acceptance-other-source-chat',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithCompletedWorkerWithoutChatSourceEvidence(
  dbPath: string,
  secretToken: string,
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);

  try {
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at, started_at, completed_at, result
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-worker-without-chat',
      'extraction',
      JSON.stringify({
        note: `worker payload without canonical chat provenance ${secretToken}`,
        sourceChatMessageId: 'acceptance-private-chat',
      }),
      'completed',
      1,
      3,
      now - 10,
      now - 4,
      now - 10,
      now - 9,
      now - 4,
      JSON.stringify({ memoryId: 'acceptance-memory' }),
    );
    replaceAcceptanceMemorySource(db, {
      sourceType: 'worker_extraction',
      sourceId: 'acceptance-worker-without-chat',
      sourceTimestamp: now - 10,
      resolutionState: 'internal',
      jobId: 'acceptance-worker-without-chat',
    });
  } finally {
    closeDatabase(db);
  }
}

function replaceSelectedGovernedMemoryWithCompletedWorkerChatSourceEvidence(
  dbPath: string,
  secretToken: string,
): void {
  const db = initDatabase({ path: dbPath });
  const now = Date.UTC(2026, 6, 8, 9, 0, 0);

  try {
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at, started_at, completed_at, result
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-worker-with-chat',
      'extraction',
      JSON.stringify({
        note: `worker payload with chat provenance ${secretToken}`,
        sourceChatMessageId: 'acceptance-private-chat',
      }),
      'completed',
      1,
      3,
      now - 10,
      now - 4,
      now - 10,
      now - 9,
      now - 4,
      JSON.stringify({ memoryId: 'acceptance-memory' }),
    );
    db.prepare(
      `INSERT INTO memory_sources (
        memory_id, source_type, source_id, source_timestamp, extracted_by,
        resolution_state, raw_event_id, chat_message_id, tool_call_id,
        job_id, job_attempt_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acceptance-memory',
      'worker_extraction',
      'acceptance-worker-with-chat',
      now - 10,
      'worker',
      'internal',
      null,
      null,
      null,
      'acceptance-worker-with-chat',
      null,
    );
  } finally {
    closeDatabase(db);
  }
}

function buildMemoryRevisionSnapshot(input: {
  id: string;
  scope: 'global' | 'user' | 'group' | 'conversation' | 'tool' | 'system';
  canonicalUserId?: string;
  groupId?: string;
  conversationId?: string;
  visibility: 'private_only' | 'same_user_any_context' | 'same_group_only' | 'owner_admin_only' | 'public';
  sensitivity: 'normal' | 'personal' | 'sensitive' | 'secret' | 'prohibited';
  state: 'proposed' | 'active' | 'rejected' | 'superseded' | 'disabled' | 'deleted';
  sourceContext: string;
}): string {
  return JSON.stringify(input);
}

function insertBotResponseEvidence(
  db: ReturnType<typeof initDatabase>,
  input: {
    rawEventId: string;
    messageId: string;
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId: string | null;
    text: string;
    timestamp: number;
  },
): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.rawEventId,
    'bot.response',
    input.timestamp,
    'agent',
    'qq',
    input.conversationId,
    JSON.stringify({ messageId: input.messageId, text: input.text }),
    input.timestamp,
  );
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id,
      conversation_type, group_id, sender_id, text,
      has_media, has_quote, mentions_bot, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.messageId,
    input.rawEventId,
    input.messageId,
    input.conversationId,
    input.conversationType,
    input.groupId,
    'bot-self',
    input.text,
    0,
    0,
    0,
    input.timestamp,
  );
}

function insertTurnTraceDecisionAndExecution(
  db: ReturnType<typeof initDatabase>,
  input: {
    rawEventId: string;
    turnId: string;
    traceId: string;
    decisionId: string;
    executionId: string;
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId: string | null;
    timestamp: number;
    selectedMemoryIds?: string[];
    reasons?: string[];
    piProvider?: string;
    piModel?: string;
  },
): void {
  const selectedMemoryIds = input.selectedMemoryIds ?? [];
  db.prepare(
    `INSERT INTO agent_turns (
      id, conversation_id, trigger_event_id, context_pack_id, pi_model,
      pi_provider, action_decision_id, response_text, status,
      tokens_input, tokens_output, tokens_total, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.turnId,
    input.conversationId,
    input.rawEventId,
    input.traceId,
    input.piModel ?? 'mock',
    input.piProvider ?? 'mock',
    input.decisionId,
    'redacted response',
    'completed',
    1,
    1,
    2,
    input.timestamp,
    input.timestamp + 3,
  );
  db.prepare(
    `INSERT INTO context_traces (
      id, turn_id, conversation_id, conversation_type, group_id,
      candidate_memory_ids, selected_memory_ids, rejected_memories,
      filters_applied, injected_identity_fields, recent_message_ids,
      token_budget, memories, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.traceId,
    input.turnId,
    input.conversationId,
    input.conversationType,
    input.groupId,
    JSON.stringify(selectedMemoryIds),
    JSON.stringify(selectedMemoryIds),
    '[]',
    '[]',
    '[]',
    '[]',
    '{}',
    JSON.stringify(selectedMemoryIds.map((memoryId) => ({
      memoryId,
      scope: 'user',
      title: 'redacted memory title',
    }))),
    input.timestamp,
  );
  db.prepare(
    `INSERT INTO action_decisions (
      id, turn_id, decided_by, risk_level, confidence, evaluator_required,
      evaluator_passed, actions, reasons, suppressors, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.decisionId,
    input.turnId,
    'pi',
    'low',
    0.9,
    0,
    null,
    '[]',
    JSON.stringify(input.reasons ?? []),
    '[]',
    input.timestamp,
  );
  db.prepare(
    `INSERT INTO action_executions (
      id, action_decision_id, action_type, status, executed_message_id,
      audit_level, audit_entry, executed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.executionId,
    input.decisionId,
    'reply_short',
    'success',
    `sent-${input.executionId}`,
    'summary',
    '{}',
    input.timestamp,
  );
}
