/**
 * Local SnowLuma / QQ acceptance evidence template generator.
 *
 * The template is intentionally redaction-first. It gives operators a stable
 * place to record manual local acceptance evidence without copying API keys,
 * OneBot tokens, private QQ IDs, group IDs, cookies, or raw chat text into the
 * repository.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface LocalAcceptanceEvidenceTemplateOptions {
  generatedAt?: string;
}

interface ParsedArgs {
  out?: string;
  overwrite: boolean;
  validate?: string;
}

export interface LocalAcceptanceEvidenceFinding {
  ruleId: string;
  line: number;
  message: string;
}

export interface LocalAcceptanceEvidenceValidationResult {
  valid: boolean;
  findings: LocalAcceptanceEvidenceFinding[];
}

export function buildLocalAcceptanceEvidenceTemplate(
  options: LocalAcceptanceEvidenceTemplateOptions = {},
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  return `# LetheBot Local SnowLuma / QQ Acceptance Evidence

Generated at: ${generatedAt}

## Scope

This is a manual, opt-in local acceptance evidence template for the SnowLuma /
OneBot / QQ path. It is not part of the default deterministic test gate.

Use this template only for redacted evidence. Do not paste secrets, API keys,
tokens, cookies, private QQ IDs, group IDs, raw message text, screenshots that
show private identifiers, or local secret-file contents.

## Local configuration snapshot

- Compose file:
  - [ ] docker-compose.snowluma-framework.yml
  - [ ] docker-compose.local-acceptance.yml
- Pi provider:
  - [ ] mock
  - [ ] real provider through local secret files only
- OneBot transport:
  - [ ] ws
  - [ ] http
- LetheBot DB path, redacted if user path is sensitive:
  - [ ] <redacted-db-path-or-disposable-path>

## Required command evidence

Record pass/fail and redacted output summaries only.

\`\`\`bash
docker compose -f docker-compose.local-acceptance.yml config --quiet
docker compose -f docker-compose.snowluma-framework.yml config --quiet
curl http://localhost:6700/healthz
curl http://localhost:6700/readyz
curl http://localhost:6700/metrics
curl 'http://localhost:6700/metrics?format=prometheus'
ONEBOT_TRANSPORT=ws \\
ONEBOT_WS_URL=ws://localhost:3001/ \\
ONEBOT_HTTP_URL=http://localhost:3000 \\
ONEBOT_TOKEN="\${ONEBOT_TOKEN:-lethebot-local-token}" \\
pnpm verify:onebot
pnpm ops:worker-soak -- --duration-ms=15000 --interval-ms=1000
sqlite3 <redacted-db-path> "PRAGMA foreign_key_check;"
\`\`\`

## Health / metrics evidence

- [ ] /healthz status: <ok|degraded>
- [ ] /healthz database ok: <true|false>
- [ ] /healthz adapter ready: <true|false>
- [ ] /healthz eventProcessing counts are present and count-only.
- [ ] /readyz readiness status: <ready|not_ready>.
- [ ] /readyz omits adapter URLs, DB paths, raw errors, raw events, message IDs, sender IDs, raw messages, tokens, QQ IDs, and group IDs.
- [ ] /metrics JSON snapshot is reachable.
- [ ] /metrics Prometheus text snapshot is reachable with \`?format=prometheus\`.
- [ ] /metrics contains job/action/context/tool/event-failure counts.
- [ ] /metrics outputs do not contain tokens, payloads, raw messages, QQ IDs, group IDs, or worker details.

## OneBot runtime evidence

- [ ] SnowLuma WebUI reachable.
- [ ] QQ session is logged in locally when real QQ acceptance is being run.
- [ ] pnpm verify:onebot exits 0.
- [ ] Verification output redacts token values.
- [ ] No token, cookie, QR code, QQ ID, or group ID is copied into this file.

## Private chat lifecycle evidence

Use counts or internal IDs only. Do not include platform IDs or message text.

- [ ] User sends one private message to the bot.
- [ ] LetheBot emits one bot reply through the action executor / response router.
- [ ] raw_events row exists: <count/internal-id-only>
- [ ] chat_messages row exists and references a real raw_event_id.
- [ ] context_traces row exists for the turn.
- [ ] agent_turns row exists with status: <completed|failed>
- [ ] action_decisions row exists.
- [ ] action_executions row exists with status: <success|failed|rejected>
- [ ] PRAGMA foreign_key_check returns no rows after the private flow.

## Group @bot lifecycle evidence

Use counts or internal IDs only. Do not include group ID, member QQ ID, group
card, raw CQ tags, or message text.

- [ ] User sends one group @bot message.
- [ ] LetheBot emits one group reply through the action executor / response router.
- [ ] raw_events row exists: <count/internal-id-only>
- [ ] chat_messages row exists with conversation_type="group".
- [ ] mentions_bot is true only for an exact bot mention.
- [ ] sender role/card evidence is structured, not copied as prompt text.
- [ ] context_traces row exists for the group turn.
- [ ] action_decisions row exists.
- [ ] action_executions row exists with status: <success|failed|rejected>
- [ ] PRAGMA foreign_key_check returns no rows after the group flow.

## Optional quote / media metadata evidence

- [ ] Quote metadata is persisted when supported by the adapter.
- [ ] Media metadata flags are persisted when supported by the adapter.
- [ ] Raw CQ tags are not stored as ordinary message text.
- [ ] No media URL with private query parameters is copied into this file.

## Memory / privacy evidence

- [ ] No secret-like content from the acceptance messages becomes active memory.
- [ ] Group-derived user memory remains conservative and source-linked to group_chat when applicable.
- [ ] Disabled/deleted/superseded/secret/prohibited/private-in-group memory is excluded from ordinary context.
- [ ] User/admin can inspect relevant memory through governance CLI with redaction.

## Failure evidence, if any

Record concise, redacted observations only.

- [ ] /healthz eventProcessing failure count: <number>
- [ ] pnpm cli list-event-failures output uses hashes/internal IDs only.
- [ ] No platform IDs, message text, display names, raw error strings, tokens, cookies, or API keys are copied.
- [ ] Reproduction path: <redacted steps>
- [ ] Next action: <fix|rerun|document local environment issue>

## Final acceptance decision

- [ ] Accepted for local controlled QQ/SnowLuma smoke.
- [ ] Not accepted; blocker is recorded above.

Operator: <redacted-or-internal-name>
Date: <YYYY-MM-DD>
`;
}

export function validateLocalAcceptanceEvidence(content: string): LocalAcceptanceEvidenceValidationResult {
  const findings: LocalAcceptanceEvidenceFinding[] = [];
  const lines = content.split(/\r?\n/);

  const addFinding = (line: number, ruleId: string, message: string): void => {
    findings.push({ line, ruleId, message });
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
      addFinding(lineNumber, 'private-key-block', 'Private key material must not be copied into evidence.');
    }

    if (/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9])/.test(line)) {
      addFinding(lineNumber, 'api-key-like-token', 'API-key-like token must be redacted.');
    }

    if (/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(line)) {
      addFinding(lineNumber, 'jwt-like-token', 'JWT-like token must be redacted.');
    }

    if (containsUnsafeSecretAssignment(line)) {
      addFinding(lineNumber, 'secret-assignment', 'Secret, token, cookie, or authorization values must be redacted.');
    }

    if (/\[CQ:[^\]]+\]/i.test(line)) {
      addFinding(lineNumber, 'raw-cq-tag', 'Raw CQ tags must not be copied into acceptance evidence.');
    }

    if (containsRawMessageText(line)) {
      addFinding(lineNumber, 'raw-message-text', 'Raw private or group message text must be replaced with counts or redacted notes.');
    }

    if (containsPlatformIdentifier(line)) {
      addFinding(lineNumber, 'platform-id-like-number', 'QQ/group/platform identifiers must be redacted.');
    }
  });

  return { valid: findings.length === 0, findings };
}

function containsUnsafeSecretAssignment(line: string): boolean {
  const authorizationBearer = /\bauthorization\b\s*:\s*bearer\s+["']?([^"'\s`]+)/i.exec(line);
  if (authorizationBearer) {
    return !isClearlyRedactedOrPlaceholder(authorizationBearer[1] ?? line);
  }

  const assignment =
    /\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|cookie|authorization)\b\s*(?::|=|\s+bearer\s+)\s*["']?([^"'\s`]+)/i.exec(
      line,
    );

  if (!assignment) {
    return false;
  }

  return !isClearlyRedactedOrPlaceholder(assignment[1] ?? line);
}

function containsRawMessageText(line: string): boolean {
  const rawMessage = /\b(?:raw message(?: text)?|message text|私聊正文|群聊原文)\s*(?::|=)\s*(.+)$/i.exec(line);

  if (!rawMessage) {
    return false;
  }

  const value = rawMessage[1]?.trim() ?? '';
  return value.length > 0 && !isClearlyRedactedOrPlaceholder(value);
}

function containsPlatformIdentifier(line: string): boolean {
  if (isClearlyRedactedOrPlaceholder(line)) {
    return false;
  }

  if (/\b(?:qq|group|uin|群|群号|QQ号|QQ ID|group ID)[\w\s/-]{0,24}(?::|=|\s)\s*\d{5,12}\b/i.test(line)) {
    return true;
  }

  return /(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/.test(line);
}

function isClearlyRedactedOrPlaceholder(value: string): boolean {
  return /redacted|<[^>]+>|\$\{|lethebot-local-token|\*{3,}|internal[-\s]?id|hash/i.test(value);
}

function redactForDisplay(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = platformRedacted
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9])/g, '[REDACTED:api_key_like_token]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt_like_token]');
  return redactPlatformIdentifiers(secretRedacted);
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { overwrite: false };
  const normalizedArgs = args.filter((arg) => arg !== '--');

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index] ?? '';

    if (arg === '--overwrite') {
      parsed.overwrite = true;
      continue;
    }

    if (arg === '--validate') {
      const value = normalizedArgs[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing evidence file path after --validate');
      }
      parsed.validate = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--validate=')) {
      const value = arg.slice('--validate='.length);
      if (!value) {
        throw new Error('Missing evidence file path after --validate');
      }
      parsed.validate = value;
      continue;
    }

    if (arg === '--out') {
      const value = normalizedArgs[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing output file path after --out');
      }
      parsed.out = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) {
        throw new Error('Missing output file path after --out');
      }
      parsed.out = value;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${redactForDisplay(arg)}`);
    }

    throw new Error(`Unexpected positional argument: ${redactForDisplay(arg)}`);
  }

  return parsed;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.validate) {
    const content = readFileSync(args.validate, 'utf8');
    const result = validateLocalAcceptanceEvidence(content);
    process.stdout.write(
      JSON.stringify(
        {
          path: redactForDisplay(args.validate),
          valid: result.valid,
          findingCount: result.findings.length,
          findings: result.findings,
        },
        null,
        2,
      ),
    );
    process.stdout.write('\n');

    if (!result.valid) {
      process.exitCode = 1;
    }
    return;
  }

  const template = buildLocalAcceptanceEvidenceTemplate();

  if (!args.out) {
    process.stdout.write(template);
    return;
  }

  if (existsSync(args.out) && !args.overwrite) {
    throw new Error(`Output file already exists: ${redactForDisplay(args.out)}`);
  }

  writeFileSync(args.out, template, 'utf8');
  process.stdout.write(JSON.stringify({ out: redactForDisplay(args.out), written: true }, null, 2));
  process.stdout.write('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(redactForDisplay(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}
