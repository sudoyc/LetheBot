/**
 * Local SnowLuma / QQ acceptance evidence template generator.
 *
 * The template is intentionally redaction-first. It gives operators a stable
 * place to record manual local acceptance evidence without copying API keys,
 * OneBot tokens, private QQ IDs, group IDs, cookies, or raw chat text into the
 * repository.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { redactSecretsInText } from '../memory/secret-scan.js';
import { initDatabase, closeDatabase } from '../storage/database.js';

export interface LocalAcceptanceEvidenceTemplateOptions {
  generatedAt?: string;
}

interface ParsedArgs {
  db?: string;
  out?: string;
  overwrite: boolean;
  requireAcceptanceHints: boolean;
  requireComplete: boolean;
  summarizeDb: boolean;
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

export interface LocalAcceptanceEvidenceValidationOptions {
  requireComplete?: boolean;
}

export interface LocalAcceptanceDatabaseSummary {
  generatedAt: string;
  dbPath: string;
  database: {
    integrityOk: boolean;
    foreignKeyViolations: number;
  };
  counts: {
    rawEvents: number;
    chatMessages: {
      total: number;
      private: number;
      group: number;
    };
    contextTraces: {
      total: number;
      private: number;
      group: number;
    };
    agentTurns: {
      total: number;
      completed: number;
      failed: number;
      running: number;
      pending: number;
      aborted: number;
      other: number;
    };
    actionExecutions: {
      total: number;
      success: number;
      failed: number;
      rejected: number;
      downgraded: number;
      other: number;
    };
    memoryRecords: {
      total: number;
      active: number;
      proposed: number;
      rejected: number;
      superseded: number;
      disabled: number;
      deleted: number;
      secretOrProhibited: number;
    };
    memorySources: number;
    memoryRevisions: number;
    selectedGovernedMemoryContexts: number;
    conservativeGroupDerivedUserMemories: number;
    toolCalls: {
      total: number;
      success: number;
      error: number;
      timeout: number;
      rejected: number;
      other: number;
    };
    reviewedToolExecutions: number;
    eventProcessingFailures: number;
    auditLog: number;
    acceptanceFlows: {
      private: {
        chatMessages: number;
        contextTraces: number;
        completedTurns: number;
        successfulActions: number;
        completeLinkedFlows: number;
        completeLinkedChatFlows: number;
        completeLinkedReplyFlows: number;
        completeLinkedBotResponseFlows: number;
        completeLinkedTargetedFlows: number;
        completeNonMockLinkedTargetedFlows: number;
      };
      group: {
        chatMessages: number;
        contextTraces: number;
        completedTurns: number;
        successfulActions: number;
        completeLinkedFlows: number;
        completeLinkedChatFlows: number;
        completeLinkedReplyFlows: number;
        completeLinkedReplyToBotFlows: number;
        completeLinkedBotResponseFlows: number;
        completeLinkedTargetedFlows: number;
        completeNonMockLinkedReplyToBotFlows: number;
        completeNonMockLinkedTargetedFlows: number;
        completeNonMockLinkedMentionReplyPairs: number;
      };
    };
  };
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
    groupCompleteLinkedReplyToBotFlowPresent: boolean;
    privateCompleteLinkedBotResponseFlowPresent: boolean;
    groupCompleteLinkedBotResponseFlowPresent: boolean;
    privateCompleteLinkedTargetedFlowPresent: boolean;
    groupCompleteLinkedTargetedFlowPresent: boolean;
    privateNonMockCompleteLinkedTargetedFlowPresent: boolean;
    groupNonMockCompleteLinkedTargetedFlowPresent: boolean;
    groupNonMockCompleteLinkedReplyToBotFlowPresent: boolean;
    groupNonMockCompleteLinkedMentionReplyPairPresent: boolean;
    reviewedToolExecutionPresent: boolean;
    memoryGovernanceRowsPresent: boolean;
    selectedGovernedMemoryContextPresent: boolean;
    conservativeGroupDerivedUserMemoryPresent: boolean;
    foreignKeysClean: boolean;
  };
}

const TARGET_COMPLETE_EVIDENCE_ITEMS = [
  {
    id: 'R0',
    requirement: 'R0 deterministic and release baseline: synthetic structural fixtures, required focused gates, and pnpm release:check pass with no required open R0-R8 scenario.',
    verificationCommand: 'pnpm release:check',
  },
  {
    id: 'REL-CTX-01',
    requirement: 'REL-CTX-01 (R1): three or more selected human speakers, including duplicate display names, retain distinct stable opaque speaker refs and the current speaker is explicit.',
    verificationCommand: 'pnpm vitest run tests/integration/context-history.test.ts tests/unit/context/builder.test.ts tests/unit/pi/pi-adapter.test.ts',
  },
  {
    id: 'REL-CTX-02',
    requirement: 'REL-CTX-02 (R1): changed or unavailable display metadata remains an untrusted label and never changes or borrows speaker identity.',
    verificationCommand: 'pnpm vitest run tests/integration/context-history.test.ts tests/unit/context/builder.test.ts tests/unit/pi/pi-adapter.test.ts',
  },
  {
    id: 'REL-QUOTE-01',
    requirement: 'REL-QUOTE-01 (R1): current same-conversation bot and human quote targets resolve to the exact message/speaker refs and enter Pi rendering and token accounting.',
    verificationCommand: 'pnpm vitest run tests/integration/context-history.test.ts tests/unit/context/builder.test.ts tests/unit/pi/pi-adapter.test.ts',
  },
  {
    id: 'REL-QUOTE-02',
    requirement: 'REL-QUOTE-02 (R1): bounded older same-conversation lookup succeeds, missing targets remain unresolved, and cross-conversation targets cannot trigger or influence the turn.',
    verificationCommand: 'pnpm vitest run tests/integration/context-history.test.ts tests/unit/context/builder.test.ts tests/unit/pi/pi-adapter.test.ts',
  },
  {
    id: 'REL-ATT-01',
    requirement: 'REL-ATT-01 (R2A/R4): low-risk direct mention/reply/question combinations use the reply path without invoking the risk evaluator solely from relevance signals.',
    verificationCommand: 'pnpm vitest run tests/unit/actions/social-decision-service.test.ts tests/unit/attention/engine.test.ts',
  },
  {
    id: 'REL-ATT-02',
    requirement: 'REL-ATT-02 (R5): the 15-second recheck, 120-second thread expiry, human-answer cancellation, more-than-five-per-ten-seconds traffic suppression, and two-reply budget per group per ten minutes produce durable outcomes without duplicate work.',
    verificationCommand: 'pnpm vitest run tests/unit/attention/delayed-attention-service.test.ts tests/integration/e2e-conversation.test.ts',
  },
  {
    id: 'REL-ADMIN-01',
    requirement: 'REL-ADMIN-01 (R2A/R6): narrative and prefix-collision text stays ordinary while member denial, exact-group admin authority, local reply evidence, and zero Pi/evaluator/tool calls agree.',
    verificationCommand: 'pnpm vitest run tests/unit/governance/qq-command.test.ts tests/integration/e2e-conversation.test.ts',
  },
  {
    id: 'REL-EVAL-01',
    requirement: 'REL-EVAL-01 (R2B): valid and invalid structured Provider outputs, one correction maximum, and terminal fail-closed social/memory/tool evidence pass.',
    verificationCommand: 'pnpm vitest run tests/unit/evaluator/model-evaluator.test.ts tests/unit/evaluator/pi-ai-client.test.ts',
  },
  {
    id: 'REL-EVAL-02',
    requirement: 'REL-EVAL-02 (R2B): ordinary relevance is independent of evaluator parsing and a genuinely risky evaluator failure remains a bounded governed outcome.',
    verificationCommand: 'pnpm vitest run tests/unit/evaluator/model-evaluator.test.ts tests/integration/e2e-conversation.test.ts',
  },
  {
    id: 'REL-MEM-01',
    requirement: 'REL-MEM-01 (R3): no effect, proposal, active recall, and unrelated or ambiguous evidence produce truthful wording and matching stored/delivered decisions.',
    verificationCommand: 'pnpm vitest run tests/unit/actions/memory-claim-truthfulness.test.ts tests/integration/e2e-conversation.test.ts',
  },
  {
    id: 'REL-MEM-02',
    requirement: 'REL-MEM-02 (R7): private recall, conservative same-group proposal, per-group summary opt-in, and approved restart recall pass without cross-scope leakage.',
    verificationCommand: 'pnpm vitest run tests/integration/process-restart-memory-recall.test.ts tests/e2e/full-memory-cycle.test.ts',
  },
  {
    id: 'REL-MEM-03',
    requirement: 'REL-MEM-03 (R7): frozen summary windows remain source-complete, disjoint, race-safe, retention-safe, and linked to matching final memory/invocation sources.',
    verificationCommand: 'pnpm vitest run tests/unit/workers/group-summary-job-service.test.ts tests/integration/summary-worker.test.ts tests/integration/e2e-conversation.test.ts',
  },
  {
    id: 'REL-GOV-01',
    requirement: 'REL-GOV-01 (R6): QQ memory/why and CLI delete/summary commands share governance; summary default-off and exact-group authority, member denial, immediate disable/cancel, retained-memory governance, and no-backfill re-enable pass.',
    verificationCommand: 'pnpm vitest run tests/unit/governance/qq-command.test.ts tests/unit/governance/service.test.ts tests/integration/cli-main.test.ts tests/integration/e2e-conversation.test.ts',
  },
  {
    id: 'REL-RET-01',
    requirement: 'REL-RET-01 (R8): at least 12 synthetic retrieval cases select 12/12 expected same-scope sources, select zero incompatible records, and retain complete selection/rejection trace reasons.',
    verificationCommand: 'pnpm vitest run tests/integration/query-aware-memory-retrieval.test.ts',
  },
  {
    id: 'REL-SCOPE-01',
    requirement: 'REL-SCOPE-01 (R1/R4): history, quote targets, participants, memory, actions, and bot responses remain isolated across two similar groups.',
    verificationCommand: 'pnpm vitest run tests/integration/context-history.test.ts tests/integration/e2e-conversation.test.ts',
  },
] as const;

const TARGET_COMPLETE_LATENCY_ITEM = 'R4 direct delivered-reply p95 milliseconds';
const COMPLETE_TEMPLATE_REFERENCE_TIME = '2000-01-01T00:00:00.000Z';

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
  - [ ] real provider with explicit local credential injection
- OneBot transport:
  - [ ] ws
  - [ ] http
- LetheBot DB path, redacted if user path is sensitive:
  - [ ] <redacted-db-path-or-disposable-path>

## Required command evidence

Record pass/fail and redacted output summaries only.

\`\`\`bash
docker compose --env-file /dev/null -f docker-compose.local-acceptance.yml config --quiet
docker compose --env-file /dev/null -f docker-compose.snowluma-framework.yml config --quiet
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
pnpm --silent acceptance:db-summary -- --db=<redacted-db-path> --require-acceptance-hints
pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
\`\`\`

- [ ] docker-compose.local-acceptance.yml config exits 0.
- [ ] docker-compose.snowluma-framework.yml config exits 0.
- [ ] pnpm ops:worker-soak exits 0 with aggregate-only output.
- [ ] sqlite3 PRAGMA foreign_key_check returns no rows for the acceptance DB.
- [ ] pnpm acceptance:db-summary exits 0 with aggregate-only DB evidence and required acceptance hints.
- [ ] Required acceptance DB hints confirm non-mock Pi identity for private, group @bot, and group reply-to-bot flows.
- [ ] Required acceptance DB hints confirm one distinct same-group @bot-to-reply pair quoting the exact delivered bot response.
- [ ] Required acceptance DB hints confirm conservative source-linked group-derived user memory.
- [ ] Required acceptance DB hints confirm one successful Pi tool call with an approving evaluator decision linked to one completed Provider invocation, matching audit, and delivered action evidence.
- [ ] Required command output summaries omit tokens, payloads, raw messages, QQ IDs, group IDs, local secret-file contents, and DB row contents.

## R0-R8 / TARGET_COMPLETE behavior matrix

Each checked row means its named deterministic gate passed and, where the
scenario has a live component, its controlled live observation passed. Record
only categorical outcomes, counts, timing aggregates, and command exit status;
never add message text, display names, or platform IDs.

${TARGET_COMPLETE_EVIDENCE_ITEMS.map((item) => `- [ ] Scenario ID: ${item.id}
  - Expected classification: pass
  - Actual classification: <pass|fail>
  - Checks passed: <positive-number>
  - Checks total: <positive-number>
  - Durable-chain evidence: <verified|failed>
  - Scenario result: <pass|fail>
  - Verification command: \`${item.verificationCommand}\`
  - Required behavior: ${item.requirement}`).join('\n')}
- [ ] ${TARGET_COMPLETE_LATENCY_ITEM}: <milliseconds-at-most-15000>

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
- [ ] agent_turns row exists with status: <completed|failed>
- [ ] action_decisions row exists.
- [ ] action_executions row exists with status: <success|failed|rejected>
- [ ] PRAGMA foreign_key_check returns no rows after the group flow.

## Group reply-to-bot lifecycle evidence

Use counts or internal IDs only. Do not include group ID, member QQ ID, quoted
message text, raw CQ tags, or message text.

- [ ] User sends one same-group reply to a stored bot response without @bot.
- [ ] Inbound reply evidence has quote metadata, mentions_bot=false, and a non-empty reply_to_message_id.
- [ ] reply_to_message_id resolves to a same-group bot-self message backed by a bot.response event.
- [ ] reply-to-bot agent_turns row is completed and linked to the inbound raw event.
- [ ] reply-to-bot action_decisions reasons include reply_to_bot.
- [ ] reply-to-bot action_executions row is successful and links a separately stored outbound bot response.
- [ ] PRAGMA foreign_key_check returns no rows after the reply-to-bot group flow.

## Optional additional quote / media metadata evidence

- [ ] Quote metadata is persisted when supported by the adapter.
- [ ] Media metadata flags are persisted when supported by the adapter.
- [ ] Raw CQ tags are not stored as ordinary message text.
- [ ] No media URL with private query parameters is copied into this file.

## Memory / privacy evidence

- [ ] Governed memory affects an allowed follow-up answer without cross-scope or private-in-group leakage.
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

## Evidence validator evidence

Default validation is a heuristic scan, not proof that arbitrary free-form text
is share-safe. Manually review the file before sharing it.

- [ ] Default evidence validator exits 0 on this file after redaction.
- [ ] Complete evidence validator exits 0 on this file after all evidence is filled.
- [ ] Validator output reports redacted path/status/count fields and static findings; no matched raw values are echoed.

## Final acceptance decision

- [ ] Accepted for TARGET_COMPLETE local controlled QQ/SnowLuma acceptance.
- [ ] Not accepted; blocker is recorded above.

Operator: <redacted-or-internal-name>
Date: <YYYY-MM-DD>
`;
}

export function validateLocalAcceptanceEvidence(
  content: string,
  options: LocalAcceptanceEvidenceValidationOptions = {},
): LocalAcceptanceEvidenceValidationResult {
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

  if (options.requireComplete) {
    validateCompleteness(lines, addFinding);
  }

  return { valid: findings.length === 0, findings };
}

function validateCompleteness(
  lines: string[],
  addFinding: (line: number, ruleId: string, message: string) => void,
): void {
  const requiredCheckedItems: Array<{ pattern: RegExp; minimumCount?: number }> = [
    ...TARGET_COMPLETE_EVIDENCE_ITEMS.map((item) => ({
      pattern: new RegExp(`Scenario ID:\\s*${escapeRegExp(item.id)}$`),
    })),
    { pattern: new RegExp(`${escapeRegExp(TARGET_COMPLETE_LATENCY_ITEM)}:`) },
    { pattern: /\/healthz status:/ },
    { pattern: /\/healthz database ok:/ },
    { pattern: /\/healthz adapter ready:/ },
    { pattern: /\/healthz eventProcessing counts are present and count-only\./ },
    { pattern: /\/readyz readiness status:/ },
    { pattern: /\/readyz omits adapter URLs, DB paths, raw errors, raw events, message IDs, sender IDs, raw messages, tokens, QQ IDs, and group IDs\./ },
    { pattern: /\/metrics JSON snapshot is reachable\./ },
    { pattern: /\/metrics Prometheus text snapshot is reachable/ },
    { pattern: /\/metrics contains job\/action\/context\/tool\/event-failure counts\./ },
    { pattern: /\/metrics outputs do not contain tokens, payloads, raw messages, QQ IDs, group IDs, or worker details\./ },
    { pattern: /docker-compose\.local-acceptance\.yml config exits 0\./ },
    { pattern: /docker-compose\.snowluma-framework\.yml config exits 0\./ },
    { pattern: /pnpm ops:worker-soak exits 0 with aggregate-only output\./ },
    { pattern: /sqlite3 PRAGMA foreign_key_check returns no rows for the acceptance DB\./ },
    { pattern: /pnpm acceptance:db-summary exits 0 with aggregate-only DB evidence and required acceptance hints\./ },
    { pattern: /Required acceptance DB hints confirm non-mock Pi identity for private, group @bot, and group reply-to-bot flows\./ },
    { pattern: /Required acceptance DB hints confirm one distinct same-group @bot-to-reply pair quoting the exact delivered bot response\./ },
    { pattern: /Required acceptance DB hints confirm conservative source-linked group-derived user memory\./ },
    { pattern: /Required acceptance DB hints confirm one successful Pi tool call with an approving evaluator decision linked to one completed Provider invocation, matching audit, and delivered action evidence\./ },
    { pattern: /Required command output summaries omit tokens, payloads, raw messages, QQ IDs, group IDs, local secret-file contents, and DB row contents\./ },
    { pattern: /SnowLuma WebUI reachable\./ },
    { pattern: /QQ session is logged in locally when real QQ acceptance is being run\./ },
    { pattern: /pnpm verify:onebot exits 0\./ },
    { pattern: /Verification output redacts token values\./ },
    { pattern: /No token, cookie, QR code, QQ ID, or group ID is copied into this file\./ },
    { pattern: /User sends one private message to the bot\./ },
    { pattern: /LetheBot emits one bot reply through the action executor \/ response router\./ },
    { pattern: /raw_events row exists:/, minimumCount: 2 },
    { pattern: /chat_messages row exists and references a real raw_event_id\./ },
    { pattern: /context_traces row exists for the turn\./ },
    { pattern: /agent_turns row exists with status:/, minimumCount: 2 },
    { pattern: /action_decisions row exists\./, minimumCount: 2 },
    { pattern: /action_executions row exists with status:/, minimumCount: 2 },
    { pattern: /PRAGMA foreign_key_check returns no rows after the private flow\./ },
    { pattern: /User sends one group @bot message\./ },
    { pattern: /LetheBot emits one group reply through the action executor \/ response router\./ },
    { pattern: /chat_messages row exists with conversation_type="group"\./ },
    { pattern: /mentions_bot is true only for an exact bot mention\./ },
    { pattern: /sender role\/card evidence is structured, not copied as prompt text\./ },
    { pattern: /context_traces row exists for the group turn\./ },
    { pattern: /PRAGMA foreign_key_check returns no rows after the group flow\./ },
    { pattern: /User sends one same-group reply to a stored bot response without @bot\./ },
    { pattern: /Inbound reply evidence has quote metadata, mentions_bot=false, and a non-empty reply_to_message_id\./ },
    { pattern: /reply_to_message_id resolves to a same-group bot-self message backed by a bot\.response event\./ },
    { pattern: /reply-to-bot agent_turns row is completed and linked to the inbound raw event\./ },
    { pattern: /reply-to-bot action_decisions reasons include reply_to_bot\./ },
    { pattern: /reply-to-bot action_executions row is successful and links a separately stored outbound bot response\./ },
    { pattern: /PRAGMA foreign_key_check returns no rows after the reply-to-bot group flow\./ },
    { pattern: /Governed memory affects an allowed follow-up answer without cross-scope or private-in-group leakage\./ },
    { pattern: /No secret-like content from the acceptance messages becomes active memory\./ },
    { pattern: /Group-derived user memory remains conservative and source-linked to group_chat when applicable\./ },
    { pattern: /Disabled\/deleted\/superseded\/secret\/prohibited\/private-in-group memory is excluded from ordinary context\./ },
    { pattern: /User\/admin can inspect relevant memory through governance CLI with redaction\./ },
    { pattern: /Default evidence validator exits 0 on this file after redaction\./ },
    { pattern: /Complete evidence validator exits 0 on this file after all evidence is filled\./ },
    { pattern: /Validator output reports redacted path\/status\/count fields and static findings; no matched raw values are echoed\./ },
  ];

  for (const requiredItem of requiredCheckedItems) {
    const checkedCount = lines.filter(
      (line) => isCheckedChecklistLine(line) && requiredItem.pattern.test(line),
    ).length;
    if (checkedCount >= (requiredItem.minimumCount ?? 1)) {
      continue;
    }

    const lineIndex = lines.findIndex((line) => requiredItem.pattern.test(line));
    addFinding(
      lineIndex >= 0 ? lineIndex + 1 : 1,
      'incomplete-required-checklist',
      'Required local acceptance checklist item must be checked before completion evidence is valid.',
    );
  }

  const acceptedIndex = lines.findIndex(
    (line) => /Accepted for TARGET_COMPLETE local controlled QQ\/SnowLuma acceptance\./.test(line),
  );
  if (acceptedIndex < 0 || !isCheckedChecklistLine(lines[acceptedIndex] ?? '')) {
    addFinding(
      acceptedIndex >= 0 ? acceptedIndex + 1 : 1,
      'acceptance-decision-missing',
      'Final acceptance decision must be checked as accepted before completion evidence is valid.',
    );
  }

  const notAcceptedIndex = lines.findIndex(
    (line) => /Not accepted; blocker is recorded above\./.test(line) && isCheckedChecklistLine(line),
  );
  if (notAcceptedIndex >= 0) {
    addFinding(
      notAcceptedIndex + 1,
      'acceptance-decision-conflict',
      'Final acceptance decision cannot be both accepted and not accepted.',
    );
  }

  lines.forEach((line, index) => {
    if (isCheckedChecklistLine(line) && /<[^>]+>/.test(line)) {
      addFinding(
        index + 1,
        'placeholder-value',
        'Checked acceptance evidence must replace placeholder values with redacted concrete evidence.',
      );
    }
  });

  validateCompleteStatusValues(lines, addFinding);
  validateCompleteScenarioEvidence(lines, addFinding);
  validateCompleteLatency(lines, addFinding);
  validateExclusiveCompleteOptions(lines, addFinding);
  validateCompleteProviderSelection(lines, addFinding);
  validateCompleteDocumentShape(lines, addFinding);

  const operatorIndex = lines.findIndex((line) => /^Operator:/i.test(line));
  if (operatorIndex < 0 || /<[^>]+>/.test(lines[operatorIndex] ?? '')) {
    addFinding(
      operatorIndex >= 0 ? operatorIndex + 1 : 1,
      'operator-placeholder',
      'Operator must be recorded as a redacted or internal name before completion evidence is valid.',
    );
  }

  const dateIndex = lines.findIndex((line) => /^Date:/i.test(line));
  if (dateIndex < 0 || /<[^>]+>/.test(lines[dateIndex] ?? '')) {
    addFinding(
      dateIndex >= 0 ? dateIndex + 1 : 1,
      'date-placeholder',
      'Acceptance date must be recorded before completion evidence is valid.',
    );
  }
}

function validateCompleteLatency(
  lines: string[],
  addFinding: (line: number, ruleId: string, message: string) => void,
): void {
  const lineIndex = lines.findIndex(
    (line) => isCheckedChecklistLine(line) && line.includes(`${TARGET_COMPLETE_LATENCY_ITEM}:`),
  );
  if (lineIndex < 0) {
    return;
  }

  const rawValue = new RegExp(`${escapeRegExp(TARGET_COMPLETE_LATENCY_ITEM)}:\\s*(\\d+)\\s*$`)
    .exec(lines[lineIndex] ?? '')?.[1];
  const milliseconds = rawValue === undefined ? Number.NaN : Number(rawValue);
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 15_000) {
    return;
  }

  addFinding(
    lineIndex + 1,
    'invalid-complete-latency',
    'Complete acceptance requires a direct delivered-reply p95 from 1 through 15000 milliseconds.',
  );
}

function validateCompleteScenarioEvidence(
  lines: string[],
  addFinding: (line: number, ruleId: string, message: string) => void,
): void {
  for (const scenario of TARGET_COMPLETE_EVIDENCE_ITEMS) {
    const scenarioIndex = lines.findIndex((line) =>
      new RegExp(`^\\s*-\\s*\\[[ xX]\\]\\s+Scenario ID:\\s*${escapeRegExp(scenario.id)}$`).test(line),
    );
    if (scenarioIndex < 0) {
      continue;
    }

    const actual = readStructuredScenarioValue(lines[scenarioIndex + 2], 'Actual classification');
    const checksPassed = Number(readStructuredScenarioValue(lines[scenarioIndex + 3], 'Checks passed'));
    const checksTotal = Number(readStructuredScenarioValue(lines[scenarioIndex + 4], 'Checks total'));
    const durableChain = readStructuredScenarioValue(lines[scenarioIndex + 5], 'Durable-chain evidence');
    const result = readStructuredScenarioValue(lines[scenarioIndex + 6], 'Scenario result');
    const verificationCommand = lines[scenarioIndex + 7]?.trim();

    if (
      actual === 'pass'
      && Number.isSafeInteger(checksPassed)
      && checksPassed > 0
      && checksPassed === checksTotal
      && durableChain === 'verified'
      && result === 'pass'
      && verificationCommand === `- Verification command: \`${scenario.verificationCommand}\``
    ) {
      continue;
    }

    addFinding(
      scenarioIndex + 1,
      'invalid-complete-scenario-evidence',
      'Complete scenario evidence requires passing actual/result values, equal positive check counts, verified durable linkage, and the generated verification command.',
    );
  }
}

function readStructuredScenarioValue(line: string | undefined, label: string): string | undefined {
  if (!line) {
    return undefined;
  }
  return new RegExp(`^\\s*-\\s*${escapeRegExp(label)}:\\s*(\\S+)\\s*$`).exec(line)?.[1];
}

function validateCompleteDocumentShape(
  lines: string[],
  addFinding: (line: number, ruleId: string, message: string) => void,
): void {
  const actualLines = withoutTrailingEmptyLines(lines);
  const templateLines = withoutTrailingEmptyLines(
    buildLocalAcceptanceEvidenceTemplate({ generatedAt: COMPLETE_TEMPLATE_REFERENCE_TIME }).split(/\r?\n/),
  );
  const comparedLength = Math.min(actualLines.length, templateLines.length);

  for (let index = 0; index < comparedLength; index += 1) {
    if (completeEvidenceLineMatchesTemplate(actualLines[index] ?? '', templateLines[index] ?? '')) {
      continue;
    }
    addFinding(
      index + 1,
      'unrecognized-complete-content',
      'Complete evidence must retain the generated template structure and use only its bounded fields.',
    );
    return;
  }

  if (actualLines.length !== templateLines.length) {
    addFinding(
      comparedLength + 1,
      'unrecognized-complete-content',
      'Complete evidence must retain the generated template structure and use only its bounded fields.',
    );
  }
}

function completeEvidenceLineMatchesTemplate(actualLine: string, templateLine: string): boolean {
  if (templateLine.startsWith('Generated at: ')) {
    return isValidGeneratedAtLine(actualLine);
  }

  if (templateLine === 'Date: <YYYY-MM-DD>') {
    const value = /^Date:\s*(\d{4}-\d{2}-\d{2})$/.exec(actualLine)?.[1];
    return value !== undefined && isValidIsoCalendarDate(value);
  }

  const actual = normalizeChecklistMarker(actualLine);
  const template = normalizeChecklistMarker(templateLine);
  if (actual === template) {
    return true;
  }

  const placeholders = [...template.matchAll(/<[^>]+>/g)];
  if (placeholders.length === 0) {
    return false;
  }

  let pattern = '^';
  let cursor = 0;
  for (const placeholder of placeholders) {
    pattern += escapeRegExp(template.slice(cursor, placeholder.index));
    const placeholderPattern = completeEvidencePlaceholderPattern(placeholder[0]);
    if (!placeholderPattern) {
      return false;
    }
    pattern += placeholderPattern;
    cursor = (placeholder.index ?? 0) + placeholder[0].length;
  }
  pattern += `${escapeRegExp(template.slice(cursor))}$`;
  return new RegExp(pattern).test(actual);
}

function completeEvidencePlaceholderPattern(placeholder: string): string | undefined {
  switch (placeholder) {
    case '<YYYY-MM-DD>':
      return '\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])';
    case '<completed|failed>':
      return '(?:completed|failed)';
    case '<count/internal-id-only>':
      return '(?:\\d{1,9} internal rows|internal-id:(?!\\d+$)[A-Za-z0-9_.-]{1,64})';
    case '<fix|rerun|document local environment issue>':
      return '(?:fix|rerun|document local environment issue)';
    case '<milliseconds-at-most-15000>':
      return '\\d{1,5}';
    case '<number>':
      return '\\d{1,9}';
    case '<pass|fail>':
      return '(?:pass|fail)';
    case '<positive-number>':
      return '\\d{1,9}';
    case '<ok|degraded>':
      return '(?:ok|degraded)';
    case '<ready|not_ready>':
      return '(?:ready|not_ready)';
    case '<redacted steps>':
      return '(?:redacted local steps|internal-step-summary)';
    case '<redacted-db-path-or-disposable-path>':
    case '<redacted-db-path>':
      return '(?:internal-db-path|\\[REDACTED:[A-Za-z0-9_.-]+\\]|\\.\\/data\\/lethebot\\/acceptance\\.db|\\/tmp\\/lethebot-acceptance\\.db)';
    case '<redacted-or-internal-name>':
      return '(?:\\[REDACTED(?::operator)?\\]|redacted|internal-operator)';
    case '<success|failed|rejected>':
      return '(?:success|failed|rejected)';
    case '<true|false>':
      return '(?:true|false)';
    case '<verified|failed>':
      return '(?:verified|failed)';
    default:
      return undefined;
  }
}

function isValidGeneratedAtLine(line: string): boolean {
  const value = /^Generated at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/.exec(line)?.[1];
  if (!value) {
    return false;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  const normalized = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return parsed.toISOString() === normalized;
}

function isValidIsoCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeChecklistMarker(line: string): string {
  return line.replace(/^(\s*-\s*)\[[ xX]\]/, '$1[ ]');
}

function withoutTrailingEmptyLines(lines: string[]): string[] {
  let length = lines.length;
  while (length > 0 && lines[length - 1] === '') {
    length -= 1;
  }
  return lines.slice(0, length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCheckedChecklistLine(line: string): boolean {
  return /^\s*-\s*\[[xX]\]\s+/.test(line);
}

function validateExclusiveCompleteOptions(
  lines: string[],
  addFinding: (line: number, ruleId: string, message: string) => void,
): void {
  const groups: Array<{ label: string; patterns: readonly RegExp[] }> = [
    {
      label: 'compose file',
      patterns: [
        /^\s*-\s*\[[xX]\]\s+docker-compose\.snowluma-framework\.yml\s*$/,
        /^\s*-\s*\[[xX]\]\s+docker-compose\.local-acceptance\.yml\s*$/,
      ],
    },
    {
      label: 'Pi provider',
      patterns: [
        /^\s*-\s*\[[xX]\]\s+mock\s*$/,
        /^\s*-\s*\[[xX]\]\s+real provider with explicit local credential injection\s*$/,
      ],
    },
    {
      label: 'OneBot transport',
      patterns: [
        /^\s*-\s*\[[xX]\]\s+ws\s*$/,
        /^\s*-\s*\[[xX]\]\s+http\s*$/,
      ],
    },
  ];

  for (const group of groups) {
    const checkedIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => group.patterns.some((pattern) => pattern.test(line)))
      .map(({ index }) => index);

    if (checkedIndexes.length === 1) {
      continue;
    }

    const firstOptionIndex = lines.findIndex((line) =>
      group.patterns.some((pattern) => pattern.test(line.replace('[ ]', '[x]'))),
    );
    addFinding(
      firstOptionIndex >= 0 ? firstOptionIndex + 1 : 1,
      checkedIndexes.length === 0 ? 'exclusive-option-missing' : 'exclusive-option-conflict',
      `Complete acceptance evidence must check exactly one ${group.label} option.`,
    );
  }
}

function validateCompleteProviderSelection(
  lines: string[],
  addFinding: (line: number, ruleId: string, message: string) => void,
): void {
  const mockProviderIndex = lines.findIndex((line) =>
    /^\s*-\s*\[[xX]\]\s+mock\s*$/.test(line),
  );
  if (mockProviderIndex >= 0) {
    addFinding(
      mockProviderIndex + 1,
      'real-provider-required',
      'Complete acceptance requires the configured real Pi provider option.',
    );
  }

  const fixedMockComposeIndex = lines.findIndex((line) =>
    /^\s*-\s*\[[xX]\]\s+docker-compose\.local-acceptance\.yml\s*$/.test(line),
  );
  if (fixedMockComposeIndex >= 0) {
    addFinding(
      fixedMockComposeIndex + 1,
      'real-provider-compose-required',
      'Complete acceptance requires a compose target that accepts explicit real-provider configuration.',
    );
  }
}

function validateCompleteStatusValues(
  lines: string[],
  addFinding: (line: number, ruleId: string, message: string) => void,
): void {
  const requiredValues: Array<{ pattern: RegExp; allowed: readonly string[] }> = [
    { pattern: /\/healthz status:/, allowed: ['ok'] },
    { pattern: /\/healthz database ok:/, allowed: ['true'] },
    { pattern: /\/healthz adapter ready:/, allowed: ['true'] },
    { pattern: /\/readyz readiness status:/, allowed: ['ready'] },
    { pattern: /agent_turns row exists with status:/, allowed: ['completed'] },
    { pattern: /action_executions row exists with status:/, allowed: ['success'] },
  ];

  for (const [index, line] of lines.entries()) {
    if (!isCheckedChecklistLine(line)) {
      continue;
    }

    for (const requirement of requiredValues) {
      if (!requirement.pattern.test(line)) {
        continue;
      }

      const value = readChecklistValue(line);
      if (value && requirement.allowed.includes(value)) {
        continue;
      }

      addFinding(
        index + 1,
        'invalid-complete-status',
        'Checked completion evidence must record a successful ready/completed status value.',
      );
    }
  }
}

function readChecklistValue(line: string): string | undefined {
  const value = /:\s*([^.;]+?)(?:[.;]\s*)?$/.exec(line)?.[1]?.trim().toLowerCase();
  if (!value || /<[^>]+>/.test(value)) {
    return undefined;
  }
  return value;
}

export function summarizeLocalAcceptanceDatabase(
  dbPath: string,
  generatedAt = new Date().toISOString(),
): LocalAcceptanceDatabaseSummary {
  const db = initDatabase({ path: dbPath, readonly: true });
  try {
    const database = {
      integrityOk: readIntegrityOk(db),
      foreignKeyViolations: readForeignKeyViolationCount(db),
    };
    const chatMessages = readConversationTypeCounts(db, 'chat_messages');
    const contextTraces = readConversationTypeCounts(db, 'context_traces');
    const agentTurns = readKnownValueCounts(db, 'agent_turns', 'status', [
      'completed',
      'failed',
      'running',
      'pending',
      'aborted',
    ]);
    const actionExecutions = readKnownValueCounts(db, 'action_executions', 'status', [
      'success',
      'failed',
      'rejected',
      'downgraded',
    ]);
    const completedTurnsByConversation = readCompletedTurnConversationCounts(db);
    const successfulActionsByConversation = readSuccessfulActionConversationCounts(db);
    const completeLinkedFlowsByConversation = readCompleteLinkedFlowConversationCounts(db);
    const completeLinkedChatFlowsByConversation = readCompleteLinkedChatFlowConversationCounts(db);
    const completeLinkedReplyFlowsByConversation = readCompleteLinkedReplyFlowConversationCounts(db);
    const completeLinkedReplyToBotFlowsByConversation =
      readCompleteLinkedReplyToBotFlowConversationCounts(db);
    const completeLinkedBotResponseFlowsByConversation = readCompleteLinkedBotResponseFlowConversationCounts(db);
    const completeLinkedTargetedFlowsByConversation = readCompleteLinkedTargetedFlowConversationCounts(db);
    const completeNonMockLinkedReplyToBotFlowsByConversation =
      readCompleteLinkedReplyToBotFlowConversationCounts(db, { requireNonMockPi: true });
    const completeNonMockLinkedTargetedFlowsByConversation =
      readCompleteLinkedTargetedFlowConversationCounts(db, { requireNonMockPi: true });
    const completeNonMockLinkedMentionReplyPairs =
      readCompleteNonMockLinkedMentionReplyPairCount(db);
    const memoryStates = readKnownValueCounts(db, 'memory_records', 'state', [
      'active',
      'proposed',
      'rejected',
      'superseded',
      'disabled',
      'deleted',
    ]);
    const secretOrProhibited = readScalarCount(
      db,
      "SELECT COUNT(*) AS count FROM memory_records WHERE sensitivity IN ('secret', 'prohibited')",
    );
    const selectedGovernedMemoryContexts = readSelectedGovernedMemoryContextCount(db);
    const conservativeGroupDerivedUserMemories =
      readConservativeGroupDerivedUserMemoryCount(db, Date.parse(generatedAt));
    const toolCalls = readKnownValueCounts(db, 'tool_calls', 'status', [
      'success',
      'error',
      'timeout',
      'rejected',
    ]);
    const reviewedToolExecutions = readReviewedToolExecutionCount(db);

    const counts: LocalAcceptanceDatabaseSummary['counts'] = {
      rawEvents: readTableCount(db, 'raw_events'),
      chatMessages,
      contextTraces,
      agentTurns: {
        total: agentTurns.total,
        completed: agentTurns.completed,
        failed: agentTurns.failed,
        running: agentTurns.running,
        pending: agentTurns.pending,
        aborted: agentTurns.aborted,
        other: agentTurns.other,
      },
      actionExecutions: {
        total: actionExecutions.total,
        success: actionExecutions.success,
        failed: actionExecutions.failed,
        rejected: actionExecutions.rejected,
        downgraded: actionExecutions.downgraded,
        other: actionExecutions.other,
      },
      memoryRecords: {
        total: memoryStates.total,
        active: memoryStates.active,
        proposed: memoryStates.proposed,
        rejected: memoryStates.rejected,
        superseded: memoryStates.superseded,
        disabled: memoryStates.disabled,
        deleted: memoryStates.deleted,
        secretOrProhibited,
      },
      memorySources: readTableCount(db, 'memory_sources'),
      memoryRevisions: readTableCount(db, 'memory_revisions'),
      selectedGovernedMemoryContexts,
      conservativeGroupDerivedUserMemories,
      toolCalls: {
        total: toolCalls.total,
        success: toolCalls.success,
        error: toolCalls.error,
        timeout: toolCalls.timeout,
        rejected: toolCalls.rejected,
        other: toolCalls.other,
      },
      reviewedToolExecutions,
      eventProcessingFailures: readTableCount(db, 'event_processing_failures'),
      auditLog: readTableCount(db, 'audit_log'),
      acceptanceFlows: {
        private: {
          chatMessages: chatMessages.private,
          contextTraces: contextTraces.private,
          completedTurns: completedTurnsByConversation.private,
          successfulActions: successfulActionsByConversation.private,
          completeLinkedFlows: completeLinkedFlowsByConversation.private,
          completeLinkedChatFlows: completeLinkedChatFlowsByConversation.private,
          completeLinkedReplyFlows: completeLinkedReplyFlowsByConversation.private,
          completeLinkedBotResponseFlows: completeLinkedBotResponseFlowsByConversation.private,
          completeLinkedTargetedFlows: completeLinkedTargetedFlowsByConversation.private,
          completeNonMockLinkedTargetedFlows:
            completeNonMockLinkedTargetedFlowsByConversation.private,
        },
        group: {
          chatMessages: chatMessages.group,
          contextTraces: contextTraces.group,
          completedTurns: completedTurnsByConversation.group,
          successfulActions: successfulActionsByConversation.group,
          completeLinkedFlows: completeLinkedFlowsByConversation.group,
          completeLinkedChatFlows: completeLinkedChatFlowsByConversation.group,
          completeLinkedReplyFlows: completeLinkedReplyFlowsByConversation.group,
          completeLinkedReplyToBotFlows: completeLinkedReplyToBotFlowsByConversation.group,
          completeLinkedBotResponseFlows: completeLinkedBotResponseFlowsByConversation.group,
          completeLinkedTargetedFlows: completeLinkedTargetedFlowsByConversation.group,
          completeNonMockLinkedReplyToBotFlows:
            completeNonMockLinkedReplyToBotFlowsByConversation.group,
          completeNonMockLinkedTargetedFlows:
            completeNonMockLinkedTargetedFlowsByConversation.group,
          completeNonMockLinkedMentionReplyPairs,
        },
      },
    };

    const privateFlowRowsPresent =
      counts.acceptanceFlows.private.chatMessages > 0 &&
      counts.acceptanceFlows.private.contextTraces > 0 &&
      counts.acceptanceFlows.private.completedTurns > 0 &&
      counts.acceptanceFlows.private.successfulActions > 0 &&
      counts.acceptanceFlows.private.completeLinkedFlows > 0 &&
      counts.acceptanceFlows.private.completeLinkedChatFlows > 0 &&
      counts.acceptanceFlows.private.completeLinkedReplyFlows > 0 &&
      counts.acceptanceFlows.private.completeLinkedBotResponseFlows > 0 &&
      counts.acceptanceFlows.private.completeLinkedTargetedFlows > 0;
    const groupFlowRowsPresent =
      counts.acceptanceFlows.group.chatMessages > 0 &&
      counts.acceptanceFlows.group.contextTraces > 0 &&
      counts.acceptanceFlows.group.completedTurns > 0 &&
      counts.acceptanceFlows.group.successfulActions > 0 &&
      counts.acceptanceFlows.group.completeLinkedFlows > 0 &&
      counts.acceptanceFlows.group.completeLinkedChatFlows > 0 &&
      counts.acceptanceFlows.group.completeLinkedReplyFlows > 0 &&
      counts.acceptanceFlows.group.completeLinkedBotResponseFlows > 0 &&
      counts.acceptanceFlows.group.completeLinkedTargetedFlows > 0;

    return {
      generatedAt,
      dbPath: redactForDisplay(dbPath),
      database,
      counts,
      evidenceHints: {
        privateFlowRowsPresent,
        groupFlowRowsPresent,
        completedTurnsPresent: counts.agentTurns.completed > 0,
        successfulActionsPresent: counts.actionExecutions.success > 0,
        contextTraceRowsPresent: counts.contextTraces.total > 0,
        privateCompletedTurnPresent: counts.acceptanceFlows.private.completedTurns > 0,
        groupCompletedTurnPresent: counts.acceptanceFlows.group.completedTurns > 0,
        privateSuccessfulActionPresent: counts.acceptanceFlows.private.successfulActions > 0,
        groupSuccessfulActionPresent: counts.acceptanceFlows.group.successfulActions > 0,
        privateContextTracePresent: counts.acceptanceFlows.private.contextTraces > 0,
        groupContextTracePresent: counts.acceptanceFlows.group.contextTraces > 0,
        privateCompleteLinkedFlowPresent: counts.acceptanceFlows.private.completeLinkedFlows > 0,
        groupCompleteLinkedFlowPresent: counts.acceptanceFlows.group.completeLinkedFlows > 0,
        privateCompleteLinkedChatFlowPresent: counts.acceptanceFlows.private.completeLinkedChatFlows > 0,
        groupCompleteLinkedChatFlowPresent: counts.acceptanceFlows.group.completeLinkedChatFlows > 0,
        privateCompleteLinkedReplyFlowPresent: counts.acceptanceFlows.private.completeLinkedReplyFlows > 0,
        groupCompleteLinkedReplyFlowPresent: counts.acceptanceFlows.group.completeLinkedReplyFlows > 0,
        groupCompleteLinkedReplyToBotFlowPresent:
          counts.acceptanceFlows.group.completeLinkedReplyToBotFlows > 0,
        privateCompleteLinkedBotResponseFlowPresent:
          counts.acceptanceFlows.private.completeLinkedBotResponseFlows > 0,
        groupCompleteLinkedBotResponseFlowPresent:
          counts.acceptanceFlows.group.completeLinkedBotResponseFlows > 0,
        privateCompleteLinkedTargetedFlowPresent:
          counts.acceptanceFlows.private.completeLinkedTargetedFlows > 0,
        groupCompleteLinkedTargetedFlowPresent:
          counts.acceptanceFlows.group.completeLinkedTargetedFlows > 0,
        privateNonMockCompleteLinkedTargetedFlowPresent:
          counts.acceptanceFlows.private.completeNonMockLinkedTargetedFlows > 0,
        groupNonMockCompleteLinkedTargetedFlowPresent:
          counts.acceptanceFlows.group.completeNonMockLinkedTargetedFlows > 0,
        groupNonMockCompleteLinkedReplyToBotFlowPresent:
          counts.acceptanceFlows.group.completeNonMockLinkedReplyToBotFlows > 0,
        groupNonMockCompleteLinkedMentionReplyPairPresent:
          counts.acceptanceFlows.group.completeNonMockLinkedMentionReplyPairs > 0,
        reviewedToolExecutionPresent: counts.reviewedToolExecutions > 0,
        memoryGovernanceRowsPresent: counts.memorySources > 0 && counts.memoryRevisions > 0,
        selectedGovernedMemoryContextPresent: counts.selectedGovernedMemoryContexts > 0,
        conservativeGroupDerivedUserMemoryPresent:
          counts.conservativeGroupDerivedUserMemories > 0,
        foreignKeysClean: database.foreignKeyViolations === 0,
      },
    };
  } finally {
    closeDatabase(db);
  }
}

function readSelectedGovernedMemoryContextCount(db: Database.Database): number {
  const rows = db.prepare(
    `SELECT DISTINCT context_traces.id AS id,
            agent_turns.id AS turn_id,
            agent_turns.trigger_event_id AS trigger_event_id,
            context_traces.conversation_id AS conversation_id,
            context_traces.conversation_type AS conversation_type,
            context_traces.group_id AS group_id,
            chat_messages.sender_id AS sender_id,
            (
              SELECT platform_accounts.canonical_user_id
                FROM platform_accounts
               WHERE platform_accounts.platform = 'qq'
                 AND platform_accounts.status = 'active'
                 AND (
                   platform_accounts.platform_account_id = chat_messages.sender_id
                   OR (
                     substr(chat_messages.sender_id, 1, length('qq-')) = 'qq-'
                     AND platform_accounts.platform_account_id = substr(chat_messages.sender_id, length('qq-') + 1)
                   )
                 )
               LIMIT 1
            ) AS sender_canonical_user_id,
            context_traces.candidate_memory_ids AS candidate_memory_ids,
            context_traces.selected_memory_ids AS selected_memory_ids,
            context_traces.memories AS memories,
            context_traces.created_at AS context_created_at
       FROM agent_turns
       INNER JOIN context_traces
               ON context_traces.id = agent_turns.context_pack_id
              AND context_traces.turn_id = agent_turns.id
       INNER JOIN action_decisions
               ON action_decisions.id = agent_turns.action_decision_id
              AND action_decisions.turn_id = agent_turns.id
       INNER JOIN action_executions ON action_executions.action_decision_id = action_decisions.id
       INNER JOIN raw_events ON raw_events.id = agent_turns.trigger_event_id
       INNER JOIN chat_messages ON chat_messages.raw_event_id = raw_events.id
       INNER JOIN chat_messages AS bot_messages
               ON bot_messages.message_id = action_executions.executed_message_id
              AND bot_messages.conversation_id = context_traces.conversation_id
              AND bot_messages.conversation_type = context_traces.conversation_type
              AND bot_messages.sender_id = 'bot-self'
       INNER JOIN raw_events AS bot_raw_events
               ON bot_raw_events.id = bot_messages.raw_event_id
      WHERE agent_turns.status = 'completed'
        AND action_executions.status = 'success'
        AND action_executions.action_type IN ('reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification')
        AND action_executions.executed_message_id IS NOT NULL
        AND length(trim(action_executions.executed_message_id)) > 0
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'
        AND raw_events.conversation_id = agent_turns.conversation_id
        AND context_traces.conversation_id = agent_turns.conversation_id
        AND chat_messages.conversation_id = context_traces.conversation_id
        AND chat_messages.conversation_type = context_traces.conversation_type
        AND context_traces.created_at >= agent_turns.started_at
        AND action_decisions.created_at >= context_traces.created_at
        AND action_executions.executed_at >= action_decisions.created_at
        AND agent_turns.completed_at IS NOT NULL
        AND agent_turns.completed_at >= action_executions.executed_at
        AND bot_raw_events.type = 'bot.response'
        AND bot_raw_events.source = 'agent'
        AND bot_raw_events.platform = 'qq'
        AND bot_raw_events.conversation_id = context_traces.conversation_id
        AND ${acceptanceConversationScopePredicate({
          includeBotResponse: true,
          requireExactGroupMention: true,
        })}`,
  ).all() as Array<{
    turn_id: string;
    trigger_event_id: string;
    conversation_id: string;
    conversation_type: 'private' | 'group';
    group_id: string | null;
    sender_id: string;
    sender_canonical_user_id: string | null;
    candidate_memory_ids: string;
    selected_memory_ids: string;
    memories: string;
    context_created_at: number;
  }>;
  const selectableGovernedMemory = db.prepare(
    `SELECT id, scope, canonical_user_id, visibility, sensitivity, state,
            group_id, conversation_id, source_context, created_at, expires_at
       FROM memory_records
      WHERE id = ?
        AND state = 'active'
        AND sensitivity NOT IN ('secret', 'prohibited')
        AND visibility IN ('private_only', 'same_user_any_context', 'same_group_only', 'public')
        AND EXISTS (
          SELECT 1 FROM memory_sources WHERE memory_sources.memory_id = memory_records.id
        )
      LIMIT 1`,
  );

  let count = 0;
  for (const row of rows) {
    const candidateMemoryIds = parseStrictStringArrayJson(row.candidate_memory_ids);
    const selectedMemoryIds = parseStrictStringArrayJson(row.selected_memory_ids);
    const contextMemoryIds = parseContextMemoryIds(row.memories);
    if (
      !candidateMemoryIds
      || !selectedMemoryIds
      || !contextMemoryIds
      || selectedMemoryIds.length === 0
      || !selectedMemoryIds.every((memoryId) => candidateMemoryIds.includes(memoryId))
      || !haveSameStringMembers(selectedMemoryIds, contextMemoryIds)
    ) {
      continue;
    }

    const contextCutoff = row.context_created_at;
    const allSelectedMemoriesGoverned = selectedMemoryIds.every((memoryId) => {
      const memory = selectableGovernedMemory.get(memoryId) as AcceptanceSelectedMemory | undefined;

      if (!memory) {
        return false;
      }

      const revision = readCoherentLatestMemoryRevision(db, memory, contextCutoff);
      if (!revision || !isSelectedGroupDerivedUserMemoryGoverned(memory, revision, row)) {
        return false;
      }

      const sourceTarget: AcceptanceMemoryTarget = {
        turnId: row.turn_id,
        triggerEventId: row.trigger_event_id,
        cutoff: contextCutoff,
        provenanceCutoff: Math.min(memory.created_at, revision.created_at),
        requiredSourceGroupId: isGroupChatDerivedUserMemory(memory)
          ? memory.group_id ?? undefined
          : undefined,
      };
      return isMemoryVisibleInAcceptanceContext(memory, row)
        && isMemoryScopedToAcceptanceContext(memory, row)
        && hasUsableMemorySource(db, memory, sourceTarget);
    });
    if (allSelectedMemoriesGoverned) {
      count += 1;
    }
  }

  return count;
}

type AcceptanceMemorySourceType =
  | 'raw_event'
  | 'chat_message'
  | 'tool_output'
  | 'worker_extraction'
  | 'user_command';

type AcceptanceSelectedMemory = {
  id: string;
  scope: 'global' | 'user' | 'group' | 'conversation' | 'tool' | 'system';
  canonical_user_id: string | null;
  visibility: 'private_only' | 'same_user_any_context' | 'same_group_only' | 'public';
  sensitivity: 'normal' | 'personal' | 'sensitive' | 'secret' | 'prohibited';
  state: 'proposed' | 'active' | 'rejected' | 'superseded' | 'disabled' | 'deleted';
  group_id: string | null;
  conversation_id: string | null;
  source_context: string | null;
  created_at: number;
  expires_at: number | null;
};

type AcceptanceMemoryRevisionChangeType =
  | 'create'
  | 'update'
  | 'approve'
  | 'reject'
  | 'supersede'
  | 'disable'
  | 'delete'
  | 'restore';

type AcceptanceCoherentMemoryRevision = {
  change_type: AcceptanceMemoryRevisionChangeType;
  created_at: number;
};

type AcceptanceMemorySourceRow = {
  source_type: AcceptanceMemorySourceType;
  source_id: string;
  resolution_state: 'internal' | 'external' | 'legacy_unresolved';
  raw_event_id: string | null;
  chat_message_id: string | null;
  tool_call_id: string | null;
  job_id: string | null;
  job_attempt_id: string | null;
  source_timestamp: number;
};

type AcceptanceChatSourceEvidence = {
  raw_event_id: string;
  source_created_at: number;
  conversation_id: string;
  conversation_type: 'private' | 'group';
  group_id: string | null;
  sender_canonical_user_id: string | null;
};

type AcceptanceMemoryTarget = {
  turnId?: string;
  triggerEventId?: string;
  cutoff: number;
  provenanceCutoff: number;
  requiredSourceGroupId?: string;
};

function readCoherentLatestMemoryRevision(
  db: Database.Database,
  memory: AcceptanceSelectedMemory,
  cutoff: number,
): AcceptanceCoherentMemoryRevision | undefined {
  if (
    !Number.isFinite(cutoff)
    || !Number.isFinite(memory.created_at)
    || memory.created_at >= cutoff
    || (
      memory.expires_at !== null
      && (!Number.isFinite(memory.expires_at) || memory.expires_at <= cutoff)
    )
  ) {
    return undefined;
  }

  const revision = db.prepare(
    `SELECT revision_number, change_type, new_state, created_at
       FROM memory_revisions
      WHERE memory_id = ?
      ORDER BY revision_number DESC, created_at DESC, id DESC
      LIMIT 1`,
  ).get(memory.id) as
    | {
      revision_number: number;
      change_type: AcceptanceMemoryRevisionChangeType;
      new_state: string | null;
      created_at: number;
    }
    | undefined;
  if (
    !revision
    || !Number.isInteger(revision.revision_number)
    || revision.revision_number < 1
    || !Number.isFinite(revision.created_at)
    || revision.created_at < memory.created_at
    || revision.created_at >= cutoff
    || !revision.new_state
  ) {
    return undefined;
  }

  const snapshot = parseJsonValue(revision.new_state);
  if (!isRecord(snapshot) || !doesMemoryRevisionSnapshotMatchRecord(snapshot, memory)) {
    return undefined;
  }

  return {
    change_type: revision.change_type,
    created_at: revision.created_at,
  };
}

function doesMemoryRevisionSnapshotMatchRecord(
  snapshot: Record<string, unknown>,
  memory: AcceptanceSelectedMemory,
): boolean {
  return snapshot.id === memory.id
    && snapshot.scope === memory.scope
    && optionalSnapshotStringMatches(snapshot.canonicalUserId, memory.canonical_user_id)
    && optionalSnapshotStringMatches(snapshot.groupId, memory.group_id)
    && optionalSnapshotStringMatches(snapshot.conversationId, memory.conversation_id)
    && snapshot.visibility === memory.visibility
    && snapshot.sensitivity === memory.sensitivity
    && snapshot.state === memory.state
    && optionalSnapshotStringMatches(snapshot.sourceContext, memory.source_context);
}

function optionalSnapshotStringMatches(snapshotValue: unknown, recordValue: string | null): boolean {
  return recordValue === null
    ? snapshotValue === undefined || snapshotValue === null
    : snapshotValue === recordValue;
}

function isGroupChatDerivedUserMemory(memory: AcceptanceSelectedMemory): boolean {
  return memory.scope === 'user'
    && Boolean(memory.source_context)
    && (
      memory.source_context === 'group_chat'
      || memory.source_context?.startsWith('group_chat:') === true
    );
}

function isSelectedGroupDerivedUserMemoryGoverned(
  memory: AcceptanceSelectedMemory,
  revision: AcceptanceCoherentMemoryRevision,
  context: {
    conversation_type: 'private' | 'group';
    group_id: string | null;
  },
): boolean {
  if (!isGroupChatDerivedUserMemory(memory)) {
    return true;
  }

  return memory.state === 'active'
    && memory.visibility === 'same_group_only'
    && isNormalizedAcceptanceGroupId(memory.group_id)
    && context.conversation_type === 'group'
    && context.group_id === memory.group_id
    && (revision.change_type === 'approve' || revision.change_type === 'restore');
}

function readConservativeGroupDerivedUserMemoryCount(
  db: Database.Database,
  cutoff: number,
): number {
  const memories = db.prepare(
    `SELECT id, scope, canonical_user_id, visibility, sensitivity, state,
            group_id, conversation_id, source_context, created_at, expires_at
       FROM memory_records
      WHERE scope = 'user'
        AND visibility = 'same_group_only'
        AND sensitivity NOT IN ('secret', 'prohibited')
        AND state IN ('proposed', 'active')`,
  ).all() as AcceptanceSelectedMemory[];

  return memories.filter((memory) => {
    if (
      !memory.canonical_user_id
      || !isGroupChatDerivedUserMemory(memory)
      || !isNormalizedAcceptanceGroupId(memory.group_id)
    ) {
      return false;
    }

    const revision = readCoherentLatestMemoryRevision(db, memory, cutoff);
    if (
      !revision
      || (
        memory.state === 'active'
        && revision.change_type !== 'approve'
        && revision.change_type !== 'restore'
      )
    ) {
      return false;
    }

    return hasUsableMemorySource(db, memory, {
      cutoff,
      provenanceCutoff: Math.min(memory.created_at, revision.created_at),
      requiredSourceGroupId: memory.group_id,
    });
  }).length;
}

function hasUsableMemorySource(
  db: Database.Database,
  memory: AcceptanceSelectedMemory,
  target: AcceptanceMemoryTarget,
): boolean {
  const rows = db.prepare(
    `SELECT source_type, source_id, source_timestamp, resolution_state,
            raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
       FROM memory_sources
      WHERE memory_id = ?`,
  ).all(memory.id) as AcceptanceMemorySourceRow[];

  return rows.some((row) => isMemorySourceUsableForMemory(db, row, memory, target));
}

function isMemorySourceUsableForMemory(
  db: Database.Database,
  source: AcceptanceMemorySourceRow,
  memory: AcceptanceSelectedMemory,
  target: AcceptanceMemoryTarget,
): boolean {
  if (
    source.resolution_state === 'external'
    || !Number.isFinite(source.source_timestamp)
    || source.source_timestamp >= target.cutoff
    || source.source_timestamp > target.provenanceCutoff
  ) {
    return false;
  }

  if (source.resolution_state === 'legacy_unresolved') {
    return isLegacyMemorySourceUsableForMemory(db, source, memory, target);
  }

  switch (source.source_type) {
    case 'raw_event':
      return Boolean(source.raw_event_id)
        && readUsableRawEventChatSources(db, source.raw_event_id ?? '').some((chatSource) =>
        isChatSourceUsableForTarget(chatSource, memory, target),
      );
    case 'chat_message':
      return Boolean(source.chat_message_id)
        && readUsableCanonicalChatMessageSources(db, source.chat_message_id ?? '').some((chatSource) =>
        isChatSourceUsableForTarget(chatSource, memory, target),
      );
    case 'tool_output':
      return Boolean(source.tool_call_id)
        && hasUsableToolSource(db, source.tool_call_id ?? '', memory, target);
    case 'worker_extraction':
      return hasUsableWorkerSource(db, {
        jobId: source.job_id,
        jobAttemptId: source.job_attempt_id,
      }, memory, target);
    case 'user_command':
      return false;
  }
}

function isLegacyMemorySourceUsableForMemory(
  db: Database.Database,
  source: AcceptanceMemorySourceRow,
  memory: AcceptanceSelectedMemory,
  target: AcceptanceMemoryTarget,
): boolean {
  switch (source.source_type) {
    case 'raw_event':
      return readUsableRawEventChatSources(db, source.source_id).some((chatSource) =>
        isChatSourceUsableForTarget(chatSource, memory, target),
      );
    case 'chat_message':
      return readUsableLegacyChatMessageSources(db, source.source_id).some((chatSource) =>
        isChatSourceUsableForTarget(chatSource, memory, target),
      );
    case 'tool_output':
      return hasUsableToolSource(db, source.source_id, memory, target);
    case 'worker_extraction':
      return hasUsableWorkerSource(db, { legacySourceId: source.source_id }, memory, target);
    case 'user_command':
      return false;
  }
}

type AcceptanceToolSourceEvidence = {
  turn_id: string | null;
  created_at: number;
  actor_user_id: string | null;
  invocation_context: string;
  turn_conversation_id: string | null;
  turn_conversation_type: 'private' | 'group' | null;
  turn_group_id: string | null;
  turn_sender_canonical_user_id: string | null;
};

function hasUsableToolSource(
  db: Database.Database,
  sourceId: string,
  memory: AcceptanceSelectedMemory,
  target: AcceptanceMemoryTarget,
): boolean {
  return readUsableToolSources(db, sourceId).some((toolSource) =>
    (!target.turnId || toolSource.turn_id !== target.turnId)
      && Number.isFinite(toolSource.created_at)
      && toolSource.created_at < target.cutoff
      && toolSource.created_at <= target.provenanceCutoff
      && (
        !target.requiredSourceGroupId
        || (
          toolSource.turn_conversation_type === 'group'
          && toolSource.turn_group_id === target.requiredSourceGroupId
        )
      )
      && isToolSourceCompatibleWithMemory(toolSource, memory),
  );
}

function readUsableToolSources(db: Database.Database, sourceId: string): AcceptanceToolSourceEvidence[] {
  return db.prepare(
    `SELECT tool_calls.turn_id AS turn_id,
            tool_calls.created_at AS created_at,
            tool_calls.actor_user_id AS actor_user_id,
            tool_calls.invocation_context AS invocation_context,
            context_traces.conversation_id AS turn_conversation_id,
            context_traces.conversation_type AS turn_conversation_type,
            context_traces.group_id AS turn_group_id,
            ${senderCanonicalUserIdExpression('chat_messages.sender_id')} AS turn_sender_canonical_user_id
       FROM tool_calls
       LEFT JOIN agent_turns ON agent_turns.id = tool_calls.turn_id
       LEFT JOIN context_traces
              ON context_traces.id = agent_turns.context_pack_id
             AND context_traces.turn_id = agent_turns.id
       LEFT JOIN raw_events
              ON raw_events.id = agent_turns.trigger_event_id
             AND raw_events.type = 'chat.message.received'
             AND raw_events.source = 'gateway'
             AND raw_events.platform = 'qq'
       LEFT JOIN chat_messages
              ON chat_messages.raw_event_id = raw_events.id
             AND chat_messages.conversation_id = raw_events.conversation_id
             AND chat_messages.sender_id <> 'bot-self'
             AND chat_messages.conversation_type IN ('private', 'group')
      WHERE tool_calls.id = ?
        AND tool_calls.status = 'success'
      LIMIT 8`,
  ).all(sourceId) as AcceptanceToolSourceEvidence[];
}

function isToolSourceCompatibleWithMemory(
  source: AcceptanceToolSourceEvidence,
  memory: AcceptanceSelectedMemory,
): boolean {
  if (
    source.actor_user_id
    && source.turn_sender_canonical_user_id
    && source.actor_user_id !== source.turn_sender_canonical_user_id
  ) {
    return false;
  }

  const sourceActorUserId = source.actor_user_id ?? source.turn_sender_canonical_user_id;

  if (memory.scope === 'user') {
    if (!memory.canonical_user_id || sourceActorUserId !== memory.canonical_user_id) {
      return false;
    }

    const isGroupEvidence = source.turn_conversation_type === 'group'
      || source.invocation_context === 'group_chat';
    if (isGroupEvidence) {
      return memory.visibility === 'same_group_only'
        && source.turn_conversation_type === 'group'
        && isNormalizedAcceptanceGroupId(memory.group_id)
        && source.turn_group_id === memory.group_id;
    }

    if (memory.visibility === 'private_only') {
      return source.turn_conversation_type === 'private'
        || (!source.turn_conversation_type && source.invocation_context === 'private_chat');
    }

    if (memory.visibility === 'same_group_only') {
      return false;
    }

    return true;
  }

  if (memory.scope === 'group') {
    return source.turn_conversation_type === 'group'
      && (
        (Boolean(memory.group_id) && memory.group_id === source.turn_group_id)
        || (Boolean(memory.conversation_id) && memory.conversation_id === source.turn_conversation_id)
      );
  }

  if (memory.scope === 'conversation') {
    return Boolean(memory.conversation_id) && memory.conversation_id === source.turn_conversation_id;
  }

  if (memory.scope === 'global' || memory.scope === 'system') {
    return memory.visibility === 'public';
  }

  return false;
}

function hasUsableWorkerSource(
  db: Database.Database,
  source: {
    jobId?: string | null;
    jobAttemptId?: string | null;
    legacySourceId?: string;
  },
  memory: AcceptanceSelectedMemory,
  target: AcceptanceMemoryTarget,
): boolean {
  const rows = readCompletedWorkerSourceRows(db, source);

  return rows.some((row) => {
    if (row.completed_at === null || row.completed_at >= target.cutoff) {
      return false;
    }
    const references = collectWorkerSourceReferences([
      row.payload,
      row.result,
      row.attempt_result,
    ]);

    return hasCompatibleCanonicalWorkerEvidenceSource(db, memory, references, target);
  });
}

function readCompletedWorkerSourceRows(
  db: Database.Database,
  source: {
    jobId?: string | null;
    jobAttemptId?: string | null;
    legacySourceId?: string;
  },
): Array<{
  payload: string | null;
  result: string | null;
  attempt_result: string | null;
  completed_at: number | null;
}> {
  if (source.legacySourceId) {
    return db.prepare(
      `SELECT jobs.payload AS payload,
              jobs.result AS result,
              NULL AS attempt_result,
              jobs.completed_at AS completed_at
         FROM jobs
        WHERE jobs.id = ?
          AND jobs.type = 'extraction'
          AND jobs.status = 'completed'
        UNION ALL
       SELECT jobs.payload AS payload,
              jobs.result AS result,
              job_attempts.result AS attempt_result,
              job_attempts.completed_at AS completed_at
         FROM job_attempts
         JOIN jobs ON jobs.id = job_attempts.job_id
        WHERE job_attempts.id = ?
          AND job_attempts.status = 'completed'
          AND jobs.type = 'extraction'
          AND jobs.status = 'completed'
        LIMIT 8`,
    ).all(source.legacySourceId, source.legacySourceId) as Array<{
      payload: string | null;
      result: string | null;
      attempt_result: string | null;
      completed_at: number | null;
    }>;
  }

  if (Boolean(source.jobId) === Boolean(source.jobAttemptId)) {
    return [];
  }

  if (source.jobId) {
    return db.prepare(
      `SELECT jobs.payload AS payload,
              jobs.result AS result,
              NULL AS attempt_result,
              jobs.completed_at AS completed_at
         FROM jobs
        WHERE jobs.id = ?
          AND jobs.type = 'extraction'
          AND jobs.status = 'completed'`,
    ).all(source.jobId) as Array<{
      payload: string | null;
      result: string | null;
      attempt_result: string | null;
      completed_at: number | null;
    }>;
  }

  return db.prepare(
    `SELECT jobs.payload AS payload,
            jobs.result AS result,
            job_attempts.result AS attempt_result,
            job_attempts.completed_at AS completed_at
       FROM job_attempts
       JOIN jobs ON jobs.id = job_attempts.job_id
      WHERE job_attempts.id = ?
        AND job_attempts.status = 'completed'
        AND jobs.type = 'extraction'
        AND jobs.status = 'completed'`,
  ).all(source.jobAttemptId) as Array<{
    payload: string | null;
    result: string | null;
    attempt_result: string | null;
    completed_at: number | null;
  }>;
}

function hasCompatibleCanonicalWorkerEvidenceSource(
  db: Database.Database,
  memory: AcceptanceSelectedMemory,
  references: { rawEventIds: string[]; chatMessageIds: string[] },
  target: AcceptanceMemoryTarget,
): boolean {
  const canonicalSources = db.prepare(
    `SELECT source_type, raw_event_id, chat_message_id
       FROM memory_sources
      WHERE memory_id = ?
        AND resolution_state = 'internal'
        AND source_type IN ('raw_event', 'chat_message')`,
  ).all(memory.id) as Array<{
    source_type: 'raw_event' | 'chat_message';
    raw_event_id: string | null;
    chat_message_id: string | null;
  }>;

  const referencedRawEventIds = new Set(references.rawEventIds);
  const referencedChatMessageIds = new Set(references.chatMessageIds);

  return canonicalSources.some((canonicalSource) => {
    if (canonicalSource.source_type === 'raw_event') {
      return Boolean(canonicalSource.raw_event_id)
        && referencedRawEventIds.has(canonicalSource.raw_event_id ?? '')
        && readUsableRawEventChatSources(db, canonicalSource.raw_event_id ?? '').some((chatSource) =>
          isChatSourceUsableForTarget(chatSource, memory, target),
        );
    }

    return Boolean(canonicalSource.chat_message_id)
      && referencedChatMessageIds.has(canonicalSource.chat_message_id ?? '')
      && readUsableCanonicalChatMessageSources(db, canonicalSource.chat_message_id ?? '').some((chatSource) =>
        isChatSourceUsableForTarget(chatSource, memory, target),
      );
  });
}

function collectWorkerSourceReferences(jsonStrings: Array<string | null>): {
  rawEventIds: string[];
  chatMessageIds: string[];
} {
  const rawEventIds = new Set<string>();
  const chatMessageIds = new Set<string>();

  for (const jsonString of jsonStrings) {
    if (!jsonString) {
      continue;
    }

    const parsed = parseJsonValue(jsonString);
    if (parsed === undefined) {
      continue;
    }

    collectSourceReferencesFromValue(parsed, { rawEventIds, chatMessageIds });
  }

  return {
    rawEventIds: [...rawEventIds],
    chatMessageIds: [...chatMessageIds],
  };
}

function parseJsonValue(jsonString: string): unknown | undefined {
  try {
    return JSON.parse(jsonString) as unknown;
  } catch {
    return undefined;
  }
}

function collectSourceReferencesFromValue(
  value: unknown,
  output: { rawEventIds: Set<string>; chatMessageIds: Set<string> },
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSourceReferencesFromValue(item, output);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();
    if (normalizedKey === 'raweventid' || normalizedKey === 'sourceraweventid') {
      addStringSourceId(output.rawEventIds, nestedValue);
    }
    if (normalizedKey === 'chatmessageid' || normalizedKey === 'sourcechatmessageid') {
      addStringSourceId(output.chatMessageIds, nestedValue);
    }

    collectSourceReferencesFromValue(nestedValue, output);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addStringSourceId(target: Set<string>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      addStringSourceId(target, item);
    }
    return;
  }

  if (typeof value !== 'string') {
    return;
  }

  const trimmed = value.trim();
  if (trimmed.length > 0) {
    target.add(trimmed);
  }
}

function readUsableRawEventChatSources(db: Database.Database, rawEventId: string): AcceptanceChatSourceEvidence[] {
  return db.prepare(
    `SELECT raw_events.id AS raw_event_id,
            raw_events.created_at AS source_created_at,
            chat_messages.conversation_id AS conversation_id,
            chat_messages.conversation_type AS conversation_type,
            chat_messages.group_id AS group_id,
            ${senderCanonicalUserIdExpression('chat_messages.sender_id')} AS sender_canonical_user_id
       FROM raw_events
       JOIN chat_messages ON chat_messages.raw_event_id = raw_events.id
                         AND chat_messages.conversation_id = raw_events.conversation_id
      WHERE raw_events.id = ?
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'
        AND chat_messages.sender_id <> 'bot-self'
        AND chat_messages.conversation_type IN ('private', 'group')`,
  ).all(rawEventId) as AcceptanceChatSourceEvidence[];
}

function readUsableCanonicalChatMessageSources(
  db: Database.Database,
  chatMessageId: string,
): AcceptanceChatSourceEvidence[] {
  return db.prepare(
    `SELECT raw_events.id AS raw_event_id,
            raw_events.created_at AS source_created_at,
            chat_messages.conversation_id AS conversation_id,
            chat_messages.conversation_type AS conversation_type,
            chat_messages.group_id AS group_id,
            ${senderCanonicalUserIdExpression('chat_messages.sender_id')} AS sender_canonical_user_id
       FROM chat_messages
       JOIN raw_events ON raw_events.id = chat_messages.raw_event_id
                      AND raw_events.conversation_id = chat_messages.conversation_id
      WHERE chat_messages.id = ?
        AND chat_messages.sender_id <> 'bot-self'
        AND chat_messages.conversation_type IN ('private', 'group')
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'`,
  ).all(chatMessageId) as AcceptanceChatSourceEvidence[];
}

function readUsableLegacyChatMessageSources(
  db: Database.Database,
  sourceId: string,
): AcceptanceChatSourceEvidence[] {
  return db.prepare(
    `SELECT raw_events.id AS raw_event_id,
            raw_events.created_at AS source_created_at,
            chat_messages.conversation_id AS conversation_id,
            chat_messages.conversation_type AS conversation_type,
            chat_messages.group_id AS group_id,
            ${senderCanonicalUserIdExpression('chat_messages.sender_id')} AS sender_canonical_user_id
       FROM chat_messages
       JOIN raw_events ON raw_events.id = chat_messages.raw_event_id
                      AND raw_events.conversation_id = chat_messages.conversation_id
      WHERE (chat_messages.id = ? OR chat_messages.message_id = ?)
        AND chat_messages.sender_id <> 'bot-self'
        AND chat_messages.conversation_type IN ('private', 'group')
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'`,
  ).all(sourceId, sourceId) as AcceptanceChatSourceEvidence[];
}

function senderCanonicalUserIdExpression(senderIdColumn: string): string {
  return `(
    SELECT platform_accounts.canonical_user_id
      FROM platform_accounts
     WHERE platform_accounts.platform = 'qq'
       AND platform_accounts.status = 'active'
       AND (
         platform_accounts.platform_account_id = ${senderIdColumn}
         OR (
           substr(${senderIdColumn}, 1, length('qq-')) = 'qq-'
           AND platform_accounts.platform_account_id = substr(${senderIdColumn}, length('qq-') + 1)
         )
       )
     LIMIT 1
  )`;
}

function isChatSourceCompatibleWithMemory(
  source: AcceptanceChatSourceEvidence,
  memory: AcceptanceSelectedMemory,
): boolean {
  if (memory.scope === 'user') {
    if (!memory.canonical_user_id || source.sender_canonical_user_id !== memory.canonical_user_id) {
      return false;
    }

    if (source.conversation_type === 'group') {
      return memory.visibility === 'same_group_only'
        && isNormalizedAcceptanceGroupId(memory.group_id)
        && source.group_id === memory.group_id;
    }

    if (memory.visibility === 'private_only') {
      return source.conversation_type === 'private';
    }

    if (memory.visibility === 'same_group_only') {
      return false;
    }

    return true;
  }

  if (memory.scope === 'group') {
    return source.conversation_type === 'group'
      && (
        (Boolean(memory.group_id) && memory.group_id === source.group_id)
        || (Boolean(memory.conversation_id) && memory.conversation_id === source.conversation_id)
      );
  }

  if (memory.scope === 'conversation') {
    return Boolean(memory.conversation_id) && memory.conversation_id === source.conversation_id;
  }

  if (memory.scope === 'global' || memory.scope === 'system') {
    return memory.visibility === 'public';
  }

  return false;
}

function isChatSourceUsableForTarget(
  source: AcceptanceChatSourceEvidence,
  memory: AcceptanceSelectedMemory,
  target: AcceptanceMemoryTarget,
): boolean {
  return (!target.triggerEventId || source.raw_event_id !== target.triggerEventId)
    && Number.isFinite(source.source_created_at)
    && source.source_created_at < target.cutoff
    && source.source_created_at <= target.provenanceCutoff
    && (
      !target.requiredSourceGroupId
      || (
        source.conversation_type === 'group'
        && source.group_id === target.requiredSourceGroupId
      )
    )
    && isChatSourceCompatibleWithMemory(source, memory);
}

function isMemoryVisibleInAcceptanceContext(
  memory: {
    visibility: 'private_only' | 'same_user_any_context' | 'same_group_only' | 'public';
    group_id: string | null;
    conversation_id: string | null;
  },
  context: {
    conversation_id: string;
    conversation_type: 'private' | 'group';
    group_id: string | null;
  },
): boolean {
  if (memory.visibility === 'public' || memory.visibility === 'same_user_any_context') {
    return true;
  }

  if (memory.visibility === 'private_only') {
    return context.conversation_type === 'private';
  }

  if (memory.visibility === 'same_group_only') {
    return context.conversation_type === 'group'
      && (
        (Boolean(memory.group_id) && memory.group_id === context.group_id)
        || (Boolean(memory.conversation_id) && memory.conversation_id === context.conversation_id)
      );
  }

  return false;
}

function isMemoryScopedToAcceptanceContext(
  memory: {
    scope: 'global' | 'user' | 'group' | 'conversation' | 'tool' | 'system';
    canonical_user_id: string | null;
    visibility: 'private_only' | 'same_user_any_context' | 'same_group_only' | 'public';
    group_id: string | null;
    conversation_id: string | null;
  },
  context: {
    conversation_id: string;
    conversation_type: 'private' | 'group';
    group_id: string | null;
    sender_canonical_user_id: string | null;
  },
): boolean {
  if (memory.scope === 'user') {
    return Boolean(memory.canonical_user_id)
      && memory.canonical_user_id === context.sender_canonical_user_id;
  }

  if (memory.scope === 'group') {
    return context.conversation_type === 'group'
      && (
        (Boolean(memory.group_id) && memory.group_id === context.group_id)
        || (Boolean(memory.conversation_id) && memory.conversation_id === context.conversation_id)
      );
  }

  if (memory.scope === 'conversation') {
    return Boolean(memory.conversation_id)
      && memory.conversation_id === context.conversation_id;
  }

  if (memory.scope === 'global' || memory.scope === 'system') {
    return memory.visibility === 'public';
  }

  return false;
}

function parseStrictStringArrayJson(value: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed)
      || parsed.some((item) => typeof item !== 'string' || item.trim().length === 0)
    ) {
      return undefined;
    }

    const ids = parsed as string[];
    return new Set(ids).size === ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}

function parseContextMemoryIds(value: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const ids: string[] = [];
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.memoryId !== 'string' || item.memoryId.trim().length === 0) {
        return undefined;
      }
      ids.push(item.memoryId);
    }
    return new Set(ids).size === ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}

function haveSameStringMembers(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function readReviewedToolExecutionCount(db: Database.Database): number {
  return readScalarCount(
    db,
    `SELECT COUNT(DISTINCT tool_calls.id) AS count
       FROM tool_calls
       INNER JOIN agent_turns
               ON agent_turns.id = tool_calls.turn_id
       INNER JOIN context_traces
               ON context_traces.id = agent_turns.context_pack_id
              AND context_traces.turn_id = agent_turns.id
       INNER JOIN action_decisions
               ON action_decisions.id = agent_turns.action_decision_id
              AND action_decisions.turn_id = agent_turns.id
       INNER JOIN action_executions
               ON action_executions.action_decision_id = action_decisions.id
       INNER JOIN raw_events
               ON raw_events.id = agent_turns.trigger_event_id
       INNER JOIN chat_messages
               ON chat_messages.raw_event_id = raw_events.id
       INNER JOIN chat_messages AS bot_messages
               ON bot_messages.message_id = action_executions.executed_message_id
              AND bot_messages.conversation_id = context_traces.conversation_id
              AND bot_messages.conversation_type = context_traces.conversation_type
              AND bot_messages.sender_id = 'bot-self'
       INNER JOIN raw_events AS bot_raw_events
               ON bot_raw_events.id = bot_messages.raw_event_id
       INNER JOIN evaluator_decisions
               ON evaluator_decisions.id = tool_calls.evaluator_decision_id
       INNER JOIN model_invocations
               ON model_invocations.id = evaluator_decisions.model_invocation_id
       INNER JOIN audit_log
               ON audit_log.event_id = tool_calls.id
              AND audit_log.category = 'tool'
              AND audit_log.event_type = 'tool.executed'
              AND audit_log.evaluator_decision_id = evaluator_decisions.id
      WHERE agent_turns.status = 'completed'
        AND ${nonMockPiIdentityPredicate()}
        AND agent_turns.completed_at IS NOT NULL
        AND action_executions.status = 'success'
        AND action_executions.action_type IN ('reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification')
        AND action_executions.executed_message_id IS NOT NULL
        AND length(trim(action_executions.executed_message_id)) > 0
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'
        AND raw_events.conversation_id = agent_turns.conversation_id
        AND context_traces.conversation_id = agent_turns.conversation_id
        AND chat_messages.conversation_id = context_traces.conversation_id
        AND chat_messages.conversation_type = context_traces.conversation_type
        AND bot_raw_events.type = 'bot.response'
        AND bot_raw_events.source = 'agent'
        AND bot_raw_events.platform = 'qq'
        AND bot_raw_events.conversation_id = context_traces.conversation_id
        AND ${acceptanceConversationScopePredicate({ includeBotResponse: true })}
        AND tool_calls.requested_by = 'pi'
        AND tool_calls.status = 'success'
        AND evaluator_decisions.domain = 'tool'
        AND evaluator_decisions.decision = 'approve'
        AND evaluator_decisions.risk_level <> 'prohibited'
        AND evaluator_decisions.turn_id = agent_turns.id
        AND evaluator_decisions.tool_name = tool_calls.tool_name
        AND evaluator_decisions.actor_class = tool_calls.actor_class
        AND evaluator_decisions.actor_user_id IS tool_calls.actor_user_id
        AND evaluator_decisions.invocation_context = tool_calls.invocation_context
        AND model_invocations.purpose = 'evaluator'
        AND (
          model_invocations.call_number = 1
          OR (
            model_invocations.call_number = 2
            AND EXISTS (
              SELECT 1
              FROM model_invocations AS first_evaluator_attempt
              WHERE first_evaluator_attempt.purpose = 'evaluator'
                AND first_evaluator_attempt.evaluator_request_id = model_invocations.evaluator_request_id
                AND first_evaluator_attempt.call_number = 1
                AND first_evaluator_attempt.evaluator_domain = model_invocations.evaluator_domain
                AND first_evaluator_attempt.turn_id IS model_invocations.turn_id
                AND first_evaluator_attempt.job_attempt_id IS model_invocations.job_attempt_id
                AND first_evaluator_attempt.provider = model_invocations.provider
                AND first_evaluator_attempt.model = model_invocations.model
                AND first_evaluator_attempt.prompt_version = model_invocations.prompt_version
                AND first_evaluator_attempt.status = 'failed'
                AND first_evaluator_attempt.error_code = 'invalid_structured_output'
                AND evaluator_decisions.request_created_at <= first_evaluator_attempt.started_at
                AND first_evaluator_attempt.completed_at <= model_invocations.started_at
                AND NOT EXISTS (
                  SELECT 1
                  FROM model_invocation_sources AS correction_source
                  LEFT JOIN model_invocation_sources AS first_source
                    ON first_source.model_invocation_id = first_evaluator_attempt.id
                   AND first_source.source_ordinal = correction_source.source_ordinal
                   AND first_source.raw_event_id = correction_source.raw_event_id
                  WHERE correction_source.model_invocation_id = model_invocations.id
                    AND first_source.model_invocation_id IS NULL
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM model_invocation_sources AS first_source
                  LEFT JOIN model_invocation_sources AS correction_source
                    ON correction_source.model_invocation_id = model_invocations.id
                   AND correction_source.source_ordinal = first_source.source_ordinal
                   AND correction_source.raw_event_id = first_source.raw_event_id
                  WHERE first_source.model_invocation_id = first_evaluator_attempt.id
                    AND correction_source.model_invocation_id IS NULL
                )
            )
          )
        )
        AND model_invocations.status = 'completed'
        AND model_invocations.context_id IS NULL
        AND model_invocations.evaluator_request_id = evaluator_decisions.request_id
        AND model_invocations.evaluator_domain = evaluator_decisions.domain
        AND model_invocations.turn_id = evaluator_decisions.turn_id
        AND model_invocations.job_attempt_id IS evaluator_decisions.job_attempt_id
        AND ${nonPlaceholderIdentityPredicate('model_invocations.provider')}
        AND ${nonPlaceholderIdentityPredicate('model_invocations.model')}
        AND length(trim(
          model_invocations.prompt_version,
          char(9) || char(10) || char(11) || char(12) || char(13) || ' '
        )) > 0
        AND evaluator_decisions.evaluator_version =
          model_invocations.provider || '/' || model_invocations.model || '/' || model_invocations.prompt_version
        AND raw_events.created_at <= agent_turns.started_at
        AND agent_turns.started_at <= evaluator_decisions.request_created_at
        AND evaluator_decisions.request_created_at <= model_invocations.started_at
        AND model_invocations.started_at <= model_invocations.completed_at
        AND model_invocations.completed_at <= evaluator_decisions.decided_at
        AND evaluator_decisions.request_created_at <= evaluator_decisions.decided_at
        AND evaluator_decisions.decided_at <= tool_calls.created_at
        AND evaluator_decisions.decided_at <= audit_log.timestamp
        AND tool_calls.created_at <= action_decisions.created_at
        AND audit_log.timestamp <= action_decisions.created_at
        AND action_decisions.created_at <= action_executions.executed_at
        AND action_executions.executed_at <= bot_raw_events.created_at
        AND bot_raw_events.created_at <= agent_turns.completed_at
        AND json_type(
          CASE
            WHEN json_valid(evaluator_decisions.source_event_ids) = 1
              THEN evaluator_decisions.source_event_ids
            ELSE '[]'
          END
        ) = 'array'
        AND EXISTS (
          SELECT 1
            FROM json_each(
              CASE
                WHEN json_valid(evaluator_decisions.source_event_ids) = 1
                  THEN evaluator_decisions.source_event_ids
                ELSE '[]'
              END
            ) AS source_event
           WHERE source_event.type = 'text'
             AND source_event.value = agent_turns.trigger_event_id
        )
        AND json_array_length(
          CASE
            WHEN json_valid(evaluator_decisions.source_event_ids) = 1
              THEN evaluator_decisions.source_event_ids
            ELSE '[]'
          END
        ) = (
          SELECT COUNT(*)
            FROM model_invocation_sources
           WHERE model_invocation_sources.model_invocation_id = model_invocations.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM json_each(
              CASE
                WHEN json_valid(evaluator_decisions.source_event_ids) = 1
                  THEN evaluator_decisions.source_event_ids
                ELSE '[]'
              END
            ) AS invocation_source
            LEFT JOIN model_invocation_sources
              ON model_invocation_sources.model_invocation_id = model_invocations.id
             AND model_invocation_sources.source_ordinal = CAST(invocation_source.key AS INTEGER)
           WHERE invocation_source.type <> 'text'
              OR model_invocation_sources.raw_event_id IS NULL
              OR model_invocation_sources.raw_event_id <> invocation_source.value
        )
        AND audit_log.actor_class = tool_calls.actor_class
        AND audit_log.actor_user_id IS tool_calls.actor_user_id
        AND audit_log.invocation_context = tool_calls.invocation_context`,
  );
}

function nonMockPiIdentityPredicate(alias = 'agent_turns'): string {
  return `${nonPlaceholderIdentityPredicate(`${alias}.pi_provider`)}
    AND ${nonPlaceholderIdentityPredicate(`${alias}.pi_model`)}`;
}

function nonPlaceholderIdentityPredicate(column: string): string {
  const normalized = `lower(trim(${column}, char(9) || char(10) || char(11) || char(12) || char(13) || ' '))`;
  return `length(${normalized}) > 0
    AND ${normalized} NOT GLOB 'mock*'
    AND ${normalized} NOT GLOB 'test*'
    AND ${normalized} NOT GLOB 'stub*'
    AND ${normalized} NOT GLOB 'fake*'`;
}

function readCompleteNonMockLinkedMentionReplyPairCount(db: Database.Database): number {
  return readScalarCount(
    db,
    `SELECT COUNT(*) AS count
       FROM (
         SELECT mention_turns.id AS mention_turn_id,
                reply_turns.id AS reply_turn_id
           FROM agent_turns AS mention_turns
           INNER JOIN context_traces AS mention_contexts
                   ON mention_contexts.id = mention_turns.context_pack_id
                  AND mention_contexts.turn_id = mention_turns.id
           INNER JOIN action_decisions AS mention_decisions
                   ON mention_decisions.id = mention_turns.action_decision_id
                  AND mention_decisions.turn_id = mention_turns.id
           INNER JOIN action_executions AS mention_executions
                   ON mention_executions.action_decision_id = mention_decisions.id
           INNER JOIN raw_events AS mention_raw_events
                   ON mention_raw_events.id = mention_turns.trigger_event_id
           INNER JOIN chat_messages AS mention_messages
                   ON mention_messages.raw_event_id = mention_raw_events.id
           INNER JOIN chat_messages AS mentioned_bot_messages
                   ON mentioned_bot_messages.message_id = mention_executions.executed_message_id
                  AND mentioned_bot_messages.conversation_id = mention_contexts.conversation_id
                  AND mentioned_bot_messages.conversation_type = 'group'
                  AND mentioned_bot_messages.group_id = mention_messages.group_id
                  AND mentioned_bot_messages.sender_id = 'bot-self'
           INNER JOIN raw_events AS mentioned_bot_raw_events
                   ON mentioned_bot_raw_events.id = mentioned_bot_messages.raw_event_id
           INNER JOIN agent_turns AS reply_turns
                   ON reply_turns.id <> mention_turns.id
                  AND reply_turns.conversation_id = mention_turns.conversation_id
           INNER JOIN context_traces AS reply_contexts
                   ON reply_contexts.id = reply_turns.context_pack_id
                  AND reply_contexts.turn_id = reply_turns.id
                  AND reply_contexts.conversation_id = mention_contexts.conversation_id
                  AND reply_contexts.conversation_type = 'group'
                  AND reply_contexts.group_id = mention_contexts.group_id
           INNER JOIN action_decisions AS reply_decisions
                   ON reply_decisions.id = reply_turns.action_decision_id
                  AND reply_decisions.turn_id = reply_turns.id
           INNER JOIN action_executions AS reply_executions
                   ON reply_executions.action_decision_id = reply_decisions.id
           INNER JOIN raw_events AS reply_raw_events
                   ON reply_raw_events.id = reply_turns.trigger_event_id
           INNER JOIN chat_messages AS reply_messages
                   ON reply_messages.raw_event_id = reply_raw_events.id
                  AND reply_messages.conversation_id = reply_contexts.conversation_id
                  AND reply_messages.conversation_type = 'group'
                  AND reply_messages.group_id = mention_messages.group_id
                  AND reply_messages.reply_to_message_id = mentioned_bot_messages.message_id
           INNER JOIN chat_messages AS reply_bot_messages
                   ON reply_bot_messages.message_id = reply_executions.executed_message_id
                  AND reply_bot_messages.conversation_id = reply_contexts.conversation_id
                  AND reply_bot_messages.conversation_type = 'group'
                  AND reply_bot_messages.group_id = reply_messages.group_id
                  AND reply_bot_messages.sender_id = 'bot-self'
           INNER JOIN raw_events AS reply_bot_raw_events
                   ON reply_bot_raw_events.id = reply_bot_messages.raw_event_id
          WHERE mention_turns.status = 'completed'
            AND reply_turns.status = 'completed'
            AND ${nonMockPiIdentityPredicate('mention_turns')}
            AND ${nonMockPiIdentityPredicate('reply_turns')}
            AND mention_turns.completed_at IS NOT NULL
            AND reply_turns.completed_at IS NOT NULL
            AND mention_executions.status = 'success'
            AND reply_executions.status = 'success'
            AND mention_executions.action_type IN ('reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification')
            AND reply_executions.action_type IN ('reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification')
            AND mention_executions.executed_message_id IS NOT NULL
            AND length(trim(mention_executions.executed_message_id)) > 0
            AND reply_executions.executed_message_id IS NOT NULL
            AND length(trim(reply_executions.executed_message_id)) > 0
            AND mention_executions.executed_message_id = mentioned_bot_messages.message_id
            AND reply_executions.executed_message_id = reply_bot_messages.message_id
            AND mention_raw_events.type = 'chat.message.received'
            AND mention_raw_events.source = 'gateway'
            AND mention_raw_events.platform = 'qq'
            AND mention_raw_events.conversation_id = mention_turns.conversation_id
            AND reply_raw_events.type = 'chat.message.received'
            AND reply_raw_events.source = 'gateway'
            AND reply_raw_events.platform = 'qq'
            AND reply_raw_events.conversation_id = reply_turns.conversation_id
            AND mention_messages.conversation_id = mention_contexts.conversation_id
            AND mention_messages.conversation_type = 'group'
            AND mention_messages.mentions_bot = 1
            AND mention_messages.sender_id <> 'bot-self'
            AND reply_messages.has_quote = 1
            AND reply_messages.mentions_bot = 0
            AND reply_messages.sender_id <> 'bot-self'
            AND reply_messages.reply_to_message_id = mention_executions.executed_message_id
            AND ${normalizedGroupIdPredicate('mention_messages.group_id')}
            AND mention_contexts.group_id = mention_messages.group_id
            AND reply_contexts.group_id = mention_messages.group_id
            AND mentioned_bot_raw_events.type = 'bot.response'
            AND mentioned_bot_raw_events.source = 'agent'
            AND mentioned_bot_raw_events.platform = 'qq'
            AND mentioned_bot_raw_events.conversation_id = mention_contexts.conversation_id
            AND reply_bot_raw_events.type = 'bot.response'
            AND reply_bot_raw_events.source = 'agent'
            AND reply_bot_raw_events.platform = 'qq'
            AND reply_bot_raw_events.conversation_id = reply_contexts.conversation_id
            AND mentioned_bot_messages.id <> reply_bot_messages.id
            AND mentioned_bot_messages.message_id <> reply_bot_messages.message_id
            AND mentioned_bot_raw_events.id <> reply_bot_raw_events.id
            AND mention_raw_events.id <> reply_raw_events.id
            AND mention_executions.id <> reply_executions.id
            AND mention_raw_events.created_at <= mention_turns.started_at
            AND mention_turns.started_at <= mention_contexts.created_at
            AND mention_contexts.created_at <= mention_decisions.created_at
            AND mention_decisions.created_at <= mention_executions.executed_at
            AND mention_executions.executed_at <= mentioned_bot_raw_events.created_at
            AND mentioned_bot_raw_events.created_at <= mention_turns.completed_at
            AND mentioned_bot_raw_events.created_at <= reply_raw_events.created_at
            AND reply_raw_events.created_at <= reply_turns.started_at
            AND reply_turns.started_at <= reply_contexts.created_at
            AND reply_contexts.created_at <= reply_decisions.created_at
            AND reply_decisions.created_at <= reply_executions.executed_at
            AND reply_executions.executed_at <= reply_bot_raw_events.created_at
            AND reply_bot_raw_events.created_at <= reply_turns.completed_at
            AND json_valid(reply_decisions.reasons) = 1
            AND json_type(reply_decisions.reasons) = 'array'
            AND EXISTS (
              SELECT 1
                FROM json_each(reply_decisions.reasons) AS reason
               WHERE reason.type = 'text'
                 AND reason.value = 'reply_to_bot'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM chat_messages AS mention_siblings
               WHERE mention_siblings.raw_event_id = mention_raw_events.id
                 AND mention_siblings.id <> mention_messages.id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM chat_messages AS reply_siblings
               WHERE reply_siblings.raw_event_id = reply_raw_events.id
                 AND reply_siblings.id <> reply_messages.id
            )
          GROUP BY mention_turns.id, reply_turns.id
       ) AS linked_pairs`,
  );
}

function readCompleteLinkedTargetedFlowConversationCounts(
  db: Database.Database,
  options: { requireNonMockPi?: boolean } = {},
): { private: number; group: number; other: number } {
  return readConversationEvidenceCounts(
    db,
    `SELECT ${conversationTypeExpression('agent_turns.conversation_id', 'context_traces.conversation_type')} AS value,
            COUNT(DISTINCT agent_turns.id) AS count
       FROM agent_turns
       INNER JOIN context_traces
               ON context_traces.id = agent_turns.context_pack_id
              AND context_traces.turn_id = agent_turns.id
       INNER JOIN action_decisions
               ON action_decisions.id = agent_turns.action_decision_id
              AND action_decisions.turn_id = agent_turns.id
       INNER JOIN action_executions ON action_executions.action_decision_id = action_decisions.id
       INNER JOIN raw_events ON raw_events.id = agent_turns.trigger_event_id
       INNER JOIN chat_messages ON chat_messages.raw_event_id = raw_events.id
       INNER JOIN chat_messages AS bot_messages
               ON bot_messages.message_id = action_executions.executed_message_id
              AND bot_messages.conversation_id = context_traces.conversation_id
              AND bot_messages.conversation_type = context_traces.conversation_type
              AND bot_messages.sender_id = 'bot-self'
       INNER JOIN raw_events AS bot_raw_events
               ON bot_raw_events.id = bot_messages.raw_event_id
      WHERE agent_turns.status = 'completed'
        ${options.requireNonMockPi ? `AND ${nonMockPiIdentityPredicate()}` : ''}
        AND action_executions.status = 'success'
        AND action_executions.action_type IN ('reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification')
        AND action_executions.executed_message_id IS NOT NULL
        AND length(trim(action_executions.executed_message_id)) > 0
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'
        AND raw_events.conversation_id = agent_turns.conversation_id
        AND context_traces.conversation_id = agent_turns.conversation_id
        AND chat_messages.conversation_id = context_traces.conversation_id
        AND chat_messages.conversation_type = context_traces.conversation_type
        AND bot_raw_events.type = 'bot.response'
        AND bot_raw_events.source = 'agent'
        AND bot_raw_events.platform = 'qq'
        AND bot_raw_events.conversation_id = context_traces.conversation_id
        AND ${acceptanceConversationScopePredicate({
          includeBotResponse: true,
          requireExactGroupMention: true,
        })}
      GROUP BY value`,
  );
}

function readCompleteLinkedBotResponseFlowConversationCounts(
  db: Database.Database,
): { private: number; group: number; other: number } {
  return readConversationEvidenceCounts(
    db,
    `SELECT ${conversationTypeExpression('agent_turns.conversation_id', 'context_traces.conversation_type')} AS value,
            COUNT(DISTINCT agent_turns.id) AS count
       FROM agent_turns
       INNER JOIN context_traces
               ON context_traces.id = agent_turns.context_pack_id
              AND context_traces.turn_id = agent_turns.id
       INNER JOIN action_decisions
               ON action_decisions.id = agent_turns.action_decision_id
              AND action_decisions.turn_id = agent_turns.id
       INNER JOIN action_executions ON action_executions.action_decision_id = action_decisions.id
       INNER JOIN raw_events ON raw_events.id = agent_turns.trigger_event_id
       INNER JOIN chat_messages ON chat_messages.raw_event_id = raw_events.id
       INNER JOIN chat_messages AS bot_messages
               ON bot_messages.message_id = action_executions.executed_message_id
              AND bot_messages.conversation_id = context_traces.conversation_id
              AND bot_messages.conversation_type = context_traces.conversation_type
              AND bot_messages.sender_id = 'bot-self'
       INNER JOIN raw_events AS bot_raw_events
               ON bot_raw_events.id = bot_messages.raw_event_id
      WHERE agent_turns.status = 'completed'
        AND action_executions.status = 'success'
        AND action_executions.action_type IN ('reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification')
        AND action_executions.executed_message_id IS NOT NULL
        AND length(trim(action_executions.executed_message_id)) > 0
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'
        AND raw_events.conversation_id = agent_turns.conversation_id
        AND context_traces.conversation_id = agent_turns.conversation_id
        AND chat_messages.conversation_id = context_traces.conversation_id
        AND chat_messages.conversation_type = context_traces.conversation_type
        AND bot_raw_events.type = 'bot.response'
        AND bot_raw_events.source = 'agent'
        AND bot_raw_events.platform = 'qq'
        AND bot_raw_events.conversation_id = context_traces.conversation_id
        AND ${acceptanceConversationScopePredicate({ includeBotResponse: true })}
      GROUP BY value`,
  );
}

function readCompleteLinkedReplyToBotFlowConversationCounts(
  db: Database.Database,
  options: { requireNonMockPi?: boolean } = {},
): { private: number; group: number; other: number } {
  return readConversationEvidenceCounts(
    db,
    `SELECT ${conversationTypeExpression('agent_turns.conversation_id', 'context_traces.conversation_type')} AS value,
            COUNT(DISTINCT agent_turns.id) AS count
       FROM agent_turns
       INNER JOIN context_traces
               ON context_traces.id = agent_turns.context_pack_id
              AND context_traces.turn_id = agent_turns.id
       INNER JOIN action_decisions
               ON action_decisions.id = agent_turns.action_decision_id
              AND action_decisions.turn_id = agent_turns.id
       INNER JOIN action_executions ON action_executions.action_decision_id = action_decisions.id
       INNER JOIN raw_events ON raw_events.id = agent_turns.trigger_event_id
       INNER JOIN chat_messages ON chat_messages.raw_event_id = raw_events.id
       INNER JOIN chat_messages AS replied_bot_messages
               ON replied_bot_messages.message_id = chat_messages.reply_to_message_id
              AND replied_bot_messages.conversation_id = chat_messages.conversation_id
              AND replied_bot_messages.conversation_type = chat_messages.conversation_type
              AND replied_bot_messages.group_id = chat_messages.group_id
              AND replied_bot_messages.sender_id = 'bot-self'
       INNER JOIN raw_events AS replied_bot_raw_events
               ON replied_bot_raw_events.id = replied_bot_messages.raw_event_id
       INNER JOIN chat_messages AS response_bot_messages
               ON response_bot_messages.message_id = action_executions.executed_message_id
              AND response_bot_messages.conversation_id = context_traces.conversation_id
              AND response_bot_messages.conversation_type = context_traces.conversation_type
              AND response_bot_messages.group_id = chat_messages.group_id
              AND response_bot_messages.sender_id = 'bot-self'
       INNER JOIN raw_events AS response_bot_raw_events
               ON response_bot_raw_events.id = response_bot_messages.raw_event_id
      WHERE agent_turns.status = 'completed'
        ${options.requireNonMockPi ? `AND ${nonMockPiIdentityPredicate()}` : ''}
        AND action_executions.status = 'success'
        AND action_executions.action_type IN ('reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification')
        AND action_executions.executed_message_id IS NOT NULL
        AND length(trim(action_executions.executed_message_id)) > 0
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'
        AND raw_events.conversation_id = agent_turns.conversation_id
        AND context_traces.conversation_id = agent_turns.conversation_id
        AND context_traces.conversation_type = 'group'
        AND chat_messages.conversation_id = context_traces.conversation_id
        AND chat_messages.conversation_type = 'group'
        AND chat_messages.has_quote = 1
        AND chat_messages.mentions_bot = 0
        AND chat_messages.sender_id <> 'bot-self'
        AND chat_messages.reply_to_message_id IS NOT NULL
        AND length(trim(chat_messages.reply_to_message_id)) > 0
        AND ${normalizedGroupIdPredicate('chat_messages.group_id')}
        AND context_traces.group_id = chat_messages.group_id
        AND replied_bot_messages.group_id = chat_messages.group_id
        AND response_bot_messages.group_id = chat_messages.group_id
        AND replied_bot_messages.id <> response_bot_messages.id
        AND replied_bot_messages.message_id <> response_bot_messages.message_id
        AND replied_bot_raw_events.id <> response_bot_raw_events.id
        AND replied_bot_raw_events.created_at <= raw_events.created_at
        AND raw_events.created_at <= action_executions.executed_at
        AND action_executions.executed_at <= response_bot_raw_events.created_at
        AND replied_bot_raw_events.type = 'bot.response'
        AND replied_bot_raw_events.source = 'agent'
        AND replied_bot_raw_events.platform = 'qq'
        AND replied_bot_raw_events.conversation_id = context_traces.conversation_id
        AND response_bot_raw_events.type = 'bot.response'
        AND response_bot_raw_events.source = 'agent'
        AND response_bot_raw_events.platform = 'qq'
        AND response_bot_raw_events.conversation_id = context_traces.conversation_id
        AND json_valid(action_decisions.reasons) = 1
        AND json_type(
          CASE
            WHEN json_valid(action_decisions.reasons) = 1 THEN action_decisions.reasons
            ELSE '[]'
          END
        ) = 'array'
        AND EXISTS (
          SELECT 1
            FROM json_each(
              CASE
                WHEN json_valid(action_decisions.reasons) = 1 THEN action_decisions.reasons
                ELSE '[]'
              END
            ) AS reason
           WHERE reason.type = 'text'
             AND reason.value = 'reply_to_bot'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM chat_messages AS sibling_messages
           WHERE sibling_messages.raw_event_id = raw_events.id
             AND sibling_messages.id <> chat_messages.id
        )
      GROUP BY value`,
  );
}

function readCompleteLinkedReplyFlowConversationCounts(
  db: Database.Database,
): { private: number; group: number; other: number } {
  return readConversationEvidenceCounts(
    db,
    `SELECT ${conversationTypeExpression('agent_turns.conversation_id', 'context_traces.conversation_type')} AS value,
            COUNT(DISTINCT agent_turns.id) AS count
       FROM agent_turns
       INNER JOIN context_traces
               ON context_traces.id = agent_turns.context_pack_id
              AND context_traces.turn_id = agent_turns.id
       INNER JOIN action_decisions
               ON action_decisions.id = agent_turns.action_decision_id
              AND action_decisions.turn_id = agent_turns.id
       INNER JOIN action_executions ON action_executions.action_decision_id = action_decisions.id
       INNER JOIN raw_events ON raw_events.id = agent_turns.trigger_event_id
       INNER JOIN chat_messages ON chat_messages.raw_event_id = raw_events.id
      WHERE agent_turns.status = 'completed'
        AND action_executions.status = 'success'
        AND action_executions.action_type IN ('reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification')
        AND action_executions.executed_message_id IS NOT NULL
        AND length(trim(action_executions.executed_message_id)) > 0
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'
        AND raw_events.conversation_id = agent_turns.conversation_id
        AND context_traces.conversation_id = agent_turns.conversation_id
        AND chat_messages.conversation_id = context_traces.conversation_id
        AND chat_messages.conversation_type = context_traces.conversation_type
        AND ${acceptanceConversationScopePredicate()}
      GROUP BY value`,
  );
}

function readCompleteLinkedChatFlowConversationCounts(
  db: Database.Database,
): { private: number; group: number; other: number } {
  return readConversationEvidenceCounts(
    db,
    `SELECT ${conversationTypeExpression('agent_turns.conversation_id', 'context_traces.conversation_type')} AS value,
            COUNT(DISTINCT agent_turns.id) AS count
       FROM agent_turns
       INNER JOIN context_traces
               ON context_traces.id = agent_turns.context_pack_id
              AND context_traces.turn_id = agent_turns.id
       INNER JOIN action_decisions
               ON action_decisions.id = agent_turns.action_decision_id
              AND action_decisions.turn_id = agent_turns.id
       INNER JOIN action_executions ON action_executions.action_decision_id = action_decisions.id
       INNER JOIN raw_events ON raw_events.id = agent_turns.trigger_event_id
       INNER JOIN chat_messages ON chat_messages.raw_event_id = raw_events.id
      WHERE agent_turns.status = 'completed'
        AND action_executions.status = 'success'
        AND raw_events.type = 'chat.message.received'
        AND raw_events.source = 'gateway'
        AND raw_events.platform = 'qq'
        AND raw_events.conversation_id = agent_turns.conversation_id
        AND context_traces.conversation_id = agent_turns.conversation_id
        AND chat_messages.conversation_id = context_traces.conversation_id
        AND chat_messages.conversation_type = context_traces.conversation_type
        AND ${acceptanceConversationScopePredicate()}
      GROUP BY value`,
  );
}

function readCompleteLinkedFlowConversationCounts(
  db: Database.Database,
): { private: number; group: number; other: number } {
  return readConversationEvidenceCounts(
    db,
    `SELECT ${conversationTypeExpression('agent_turns.conversation_id', 'context_traces.conversation_type')} AS value,
            COUNT(DISTINCT agent_turns.id) AS count
       FROM agent_turns
       INNER JOIN context_traces ON context_traces.turn_id = agent_turns.id
       INNER JOIN action_decisions ON action_decisions.turn_id = agent_turns.id
       INNER JOIN action_executions ON action_executions.action_decision_id = action_decisions.id
      WHERE agent_turns.status = 'completed'
        AND action_executions.status = 'success'
      GROUP BY value`,
  );
}

function readCompletedTurnConversationCounts(
  db: Database.Database,
): { private: number; group: number; other: number } {
  return readConversationEvidenceCounts(
    db,
    `SELECT ${conversationTypeExpression('agent_turns.conversation_id', 'context_traces.conversation_type')} AS value,
            COUNT(DISTINCT agent_turns.id) AS count
       FROM agent_turns
       LEFT JOIN context_traces ON context_traces.turn_id = agent_turns.id
      WHERE agent_turns.status = 'completed'
      GROUP BY value`,
  );
}

function readSuccessfulActionConversationCounts(
  db: Database.Database,
): { private: number; group: number; other: number } {
  return readConversationEvidenceCounts(
    db,
    `SELECT ${conversationTypeExpression('agent_turns.conversation_id', 'context_traces.conversation_type')} AS value,
            COUNT(DISTINCT action_executions.id) AS count
       FROM action_executions
       INNER JOIN action_decisions ON action_decisions.id = action_executions.action_decision_id
       INNER JOIN agent_turns ON agent_turns.id = action_decisions.turn_id
       LEFT JOIN context_traces ON context_traces.turn_id = agent_turns.id
      WHERE action_executions.status = 'success'
      GROUP BY value`,
  );
}

function conversationTypeExpression(conversationIdColumn: string, conversationTypeColumn: string): string {
  return `CASE
    WHEN ${conversationTypeColumn} IN ('private', 'group') THEN ${conversationTypeColumn}
    WHEN ${conversationIdColumn} LIKE 'private:%' THEN 'private'
    WHEN ${conversationIdColumn} LIKE 'group:%' THEN 'group'
    ELSE 'other'
  END`;
}

function acceptanceConversationScopePredicate(options: {
  includeBotResponse?: boolean;
  requireExactGroupMention?: boolean;
} = {}): string {
  return `(
    chat_messages.conversation_type = 'private'
    OR (
      chat_messages.conversation_type = 'group'
      ${options.requireExactGroupMention ? 'AND chat_messages.mentions_bot = 1' : ''}
      AND ${normalizedGroupIdPredicate('chat_messages.group_id')}
      AND context_traces.group_id = chat_messages.group_id
      ${options.includeBotResponse ? 'AND bot_messages.group_id = chat_messages.group_id' : ''}
    )
  )`;
}

function normalizedGroupIdPredicate(column: string): string {
  return `(
    ${column} IS NOT NULL
    AND trim(${column}) = ${column}
    AND length(${column}) BETWEEN length('qq-group-') + 5 AND length('qq-group-') + 12
    AND substr(${column}, 1, length('qq-group-')) = 'qq-group-'
    AND substr(${column}, length('qq-group-') + 1, 1) GLOB '[1-9]'
    AND substr(${column}, length('qq-group-') + 1) NOT GLOB '*[^0-9]*'
  )`;
}

function isNormalizedAcceptanceGroupId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^qq-group-[1-9][0-9]{4,11}$/.test(value);
}

function readConversationEvidenceCounts(
  db: Database.Database,
  sql: string,
): { private: number; group: number; other: number } {
  const counts = { private: 0, group: 0, other: 0 };
  const rows = db.prepare(sql).all() as Array<{ value: string | null; count: number }>;

  for (const row of rows) {
    if (row.value === 'private' || row.value === 'group') {
      counts[row.value] = row.count;
    } else {
      counts.other += row.count;
    }
  }

  return counts;
}

function readIntegrityOk(db: Database.Database): boolean {
  const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
  return row?.integrity_check === 'ok';
}

function readForeignKeyViolationCount(db: Database.Database): number {
  return db.prepare('PRAGMA foreign_key_check').all().length;
}

function readConversationTypeCounts(
  db: Database.Database,
  table: 'chat_messages' | 'context_traces',
): { total: number; private: number; group: number } {
  const counts = readKnownValueCounts(db, table, 'conversation_type', ['private', 'group']);
  return {
    total: counts.total,
    private: counts.private,
    group: counts.group,
  };
}

function readKnownValueCounts<const T extends readonly string[]>(
  db: Database.Database,
  table: string,
  column: string,
  knownValues: T,
): Record<T[number], number> & { total: number; other: number } {
  const result = Object.fromEntries(knownValues.map((value) => [value, 0])) as Record<T[number], number>;
  let other = 0;
  const rows = db.prepare(
    `SELECT ${column} AS value, COUNT(*) AS count FROM ${table} GROUP BY ${column}`,
  ).all() as Array<{ value: string | null; count: number }>;

  for (const row of rows) {
    const value = row.value ?? '';
    if (knownValues.includes(value)) {
      result[value as T[number]] = row.count;
    } else {
      other += row.count;
    }
  }

  return {
    ...result,
    total: readTableCount(db, table),
    other,
  };
}

function readTableCount(db: Database.Database, table: string): number {
  return readScalarCount(db, `SELECT COUNT(*) AS count FROM ${table}`);
}

function readScalarCount(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  return row.count;
}

function hasRequiredAcceptanceHints(summary: LocalAcceptanceDatabaseSummary): boolean {
  return (
    summary.database.integrityOk &&
    summary.evidenceHints.foreignKeysClean &&
    summary.evidenceHints.privateFlowRowsPresent &&
    summary.evidenceHints.groupFlowRowsPresent &&
    summary.evidenceHints.privateCompletedTurnPresent &&
    summary.evidenceHints.groupCompletedTurnPresent &&
    summary.evidenceHints.privateSuccessfulActionPresent &&
    summary.evidenceHints.groupSuccessfulActionPresent &&
    summary.evidenceHints.privateContextTracePresent &&
    summary.evidenceHints.groupContextTracePresent &&
    summary.evidenceHints.privateCompleteLinkedFlowPresent &&
    summary.evidenceHints.groupCompleteLinkedFlowPresent &&
    summary.evidenceHints.privateCompleteLinkedChatFlowPresent &&
    summary.evidenceHints.groupCompleteLinkedChatFlowPresent &&
    summary.evidenceHints.privateCompleteLinkedReplyFlowPresent &&
    summary.evidenceHints.groupCompleteLinkedReplyFlowPresent &&
    summary.evidenceHints.groupCompleteLinkedReplyToBotFlowPresent &&
    summary.evidenceHints.privateCompleteLinkedBotResponseFlowPresent &&
    summary.evidenceHints.groupCompleteLinkedBotResponseFlowPresent &&
    summary.evidenceHints.privateCompleteLinkedTargetedFlowPresent &&
    summary.evidenceHints.groupCompleteLinkedTargetedFlowPresent &&
    summary.evidenceHints.privateNonMockCompleteLinkedTargetedFlowPresent &&
    summary.evidenceHints.groupNonMockCompleteLinkedTargetedFlowPresent &&
    summary.evidenceHints.groupNonMockCompleteLinkedReplyToBotFlowPresent &&
    summary.evidenceHints.groupNonMockCompleteLinkedMentionReplyPairPresent &&
    summary.evidenceHints.reviewedToolExecutionPresent &&
    summary.evidenceHints.memoryGovernanceRowsPresent &&
    summary.evidenceHints.selectedGovernedMemoryContextPresent &&
    summary.evidenceHints.conservativeGroupDerivedUserMemoryPresent
  );
}

function containsUnsafeSecretAssignment(line: string): boolean {
  const authorizationBearer = /\bauthorization\b\s*:\s*bearer\s+["']?([^"'\s`]+)/i.exec(line);
  if (authorizationBearer) {
    return !isClearlyRedactedOrPlaceholder(authorizationBearer[1] ?? line);
  }

  const assignment =
    /\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|cookie|authorization|password|passwd|pwd|recovery(?:[_-]?(?:code|codes|key|keys|token|tokens))?)\b\s*(?::|=|\s+bearer\s+)\s*["']?([^"'\s`]+)/i.exec(
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
  if (/\b(?:qq|group|uin|群|群号|QQ号|QQ ID|group ID)[\w\s/-]{0,24}(?::|=|\s)\s*\d{5,12}\b/i.test(line)) {
    return true;
  }

  return /(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/.test(line);
}

function isClearlyRedactedOrPlaceholder(value: string): boolean {
  const normalized = value.trim();
  return /^<redacted(?:[-_:][A-Za-z0-9_.-]+)?>$/i.test(normalized)
    || /^\[REDACTED:[A-Za-z0-9_.-]+\]$/.test(normalized)
    || /^\$\{[A-Z][A-Z0-9_]*(?::-lethebot-local-token)?\}$/.test(normalized)
    || normalized === 'lethebot-local-token'
    || /^\*{3,}$/.test(normalized)
    || /^internal[-\s]?id(?::(?!\d+$)[A-Za-z0-9_.-]{1,64})?$/i.test(normalized)
    || /^(?:hash|sha256):[a-f0-9]{8,128}$/i.test(normalized);
}

function redactForDisplay(value: string): string {
  const homePathRedacted = redactHomePaths(value);
  const platformRedacted = redactPlatformIdentifiers(homePathRedacted);
  const assignmentRedacted = redactSecretAssignmentsForDisplay(platformRedacted);
  const secretRedacted = assignmentRedacted
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9])/g, '[REDACTED:api_key_like_token]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt_like_token]');
  return redactPlatformIdentifiers(redactSecretsInText(secretRedacted).text);
}

function redactHomePaths(value: string): string {
  const quoted = value.replace(
    /(["'`])(?:[A-Za-z]:[\\/]Users[\\/][^\\/"'`]+|\/(?:home|Users)\/[^/"'`]+|\/root)(?:[\\/][^"'`]*)?\1/gi,
    (_match, quote: string) => `${quote}[REDACTED:home_path]${quote}`,
  );
  const homeRedacted = quoted.replace(
    /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+|\/(?:home|Users)\/[^/\s"'`]+|\/root)(?:[\\/][^\s"'`]*)?/gi,
    '[REDACTED:home_path]',
  );
  const windowsRedacted = homeRedacted.replace(
    /\b[A-Za-z]:[\\/][^\s"'`,)\]}]+/g,
    '[REDACTED:absolute_path]',
  );
  return windowsRedacted.replace(
    /(?<![:/A-Za-z0-9])\/(?!\/)[^\s"'`,)\]}]+/g,
    (path) => (/^\/tmp(?:\/|$)/.test(path) || path === '/dev/null'
      ? path
      : '[REDACTED:absolute_path]'),
  );
}

function redactSecretAssignmentsForDisplay(value: string): string {
  return value.replace(
    /(?<![A-Za-z0-9])(?:[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|cookie|authorization|password|passwd|pwd|recovery(?:[_-]?(?:code|codes|key|keys|token|tokens))?))\s*(?::|=|\s+bearer\s+)\s*["']?[^"'\s`/\\]+/gi,
    '[REDACTED:secret_assignment]',
  );
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    overwrite: false,
    requireAcceptanceHints: false,
    requireComplete: false,
    summarizeDb: false,
  };
  const normalizedArgs = args.filter((arg) => arg !== '--');

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index] ?? '';

    if (arg === '--overwrite') {
      parsed.overwrite = true;
      continue;
    }

    if (arg === '--require-complete') {
      parsed.requireComplete = true;
      continue;
    }

    if (arg === '--require-acceptance-hints') {
      parsed.requireAcceptanceHints = true;
      continue;
    }

    if (arg === '--summarize-db') {
      parsed.summarizeDb = true;
      continue;
    }

    if (arg === '--db') {
      const value = normalizedArgs[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing database path after --db');
      }
      parsed.db = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--db=')) {
      const value = arg.slice('--db='.length);
      if (!value) {
        throw new Error('Missing database path after --db');
      }
      parsed.db = value;
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

  if (args.summarizeDb && args.validate) {
    throw new Error('Conflicting CLI modes: --summarize-db cannot be combined with --validate');
  }

  if ((args.summarizeDb || args.validate) && (args.out || args.overwrite)) {
    throw new Error('Conflicting CLI modes: validation and DB summary cannot use template output options');
  }

  if (args.requireComplete && !args.validate) {
    throw new Error('--require-complete can only be used with --validate');
  }

  if (args.requireAcceptanceHints && !args.summarizeDb) {
    throw new Error('--require-acceptance-hints can only be used with --summarize-db');
  }

  if (args.summarizeDb) {
    if (!args.db) {
      throw new Error('Missing database path after --db');
    }
    const summary = summarizeLocalAcceptanceDatabase(args.db);
    process.stdout.write(JSON.stringify(summary, null, 2));
    process.stdout.write('\n');
    if (
      !summary.database.integrityOk ||
      summary.database.foreignKeyViolations > 0 ||
      (args.requireAcceptanceHints && !hasRequiredAcceptanceHints(summary))
    ) {
      process.exitCode = 1;
    }
    return;
  }

  if (args.validate) {
    const content = readFileSync(args.validate, 'utf8');
    const result = validateLocalAcceptanceEvidence(content, { requireComplete: args.requireComplete });
    process.stdout.write(
      JSON.stringify(
        {
          path: redactForDisplay(args.validate),
          requireComplete: args.requireComplete,
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
