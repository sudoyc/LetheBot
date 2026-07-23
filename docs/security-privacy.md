# Security and Privacy

LetheBot is local-first and memory-heavy, so privacy rules must be part of the architecture rather than a later feature.

## Principles

- Users must be able to inspect long-term memory.
- Users must be able to delete memory.
- Durable memory must include source metadata.
- Platform identifiers are operational identity data. They may be used in local prompts when needed for identity disambiguation, platform operations, user-requested ID handling, permissions, or debug, but should be purpose-bound, minimal, and structured.
- Secrets must never be committed or stored as ordinary memory/audit content.
- Deletion and disable operations must affect retrieval immediately.

## Sensitive Data

Treat the following as sensitive or governed:

- Raw chat logs.
- User profiles and user memory.
- Group summaries and group memory.
- API keys, model credentials, cookies, private keys, and tokens.
- Tool outputs containing local paths, private files, personal data, or secrets.
- Audit logs and raw tool inputs/outputs.
- Event-processing failure diagnostics.
- Nickname/group-card history when it contains personal names, contact info, sensitive status, or other personal data.

QQ user IDs and group IDs are governed operational identity data. They are not equivalent to API secrets, but they should not be dumped into ordinary prompt context or public output unless the current task needs them.

Operator digests and worker outputs are also display/evidence boundaries.
`admin_digest` may count failed jobs/actions/tools/audit rows, but returned
samples and generated audit details must redact dynamic IDs and classifier
strings before exposure, including job type, action type, tool name, and audit
event type, while leaving raw local DB rows available for exact owner/admin
lookup.

## Retention

Retention should be configurable by storage class:

- Raw events.
- Chat messages.
- Summaries.
- Active memories.
- Disabled memories.
- Tool logs and audit logs.
- Display metadata / nickname history.
- Identity tombstones.

## Memory Deletion

Deletion requirements:

- Exclude deleted records from retrieval immediately.
- Preserve minimal tombstones only if needed for audit, opt-out, or preventing accidental re-linking/re-creation.
- Allow full purge mode later.
- Rebuild derived indexes after deletion.
- Ensure disabled/deleted/superseded memory cannot be injected into ordinary prompts.

## Identity and Display Data Governance

Users should be able to request:

- user memory list/disable/delete/correct/export;
- display profile and nickname history deletion/redaction;
- proactive DM opt-out;
- memory association opt-out;
- account unlink.

P0 may expose these controls through owner/admin CLI first. Ordinary user requests can become admin digests or evaluator-mediated actions until self-service commands exist.

Implemented account unlink uses `platform_accounts.status=disabled` as a
reversible local tombstone. `unlink-platform-account qq <platform-account-id>`
updates the mapping and redacted identity audit evidence in one transaction.
Inactive mappings cannot resolve to the previous canonical user or be
automatically reactivated. A newly claimed inactive-account event keeps only
its governed raw event and ingress receipt; it does not reach display/history,
chat, turn/context, Pi, action, send, or memory-extraction paths and is not
classified as an event-processing failure.

Implemented durable opt-outs are stored in `privacy_preferences`:

- `proactive_dm=opted_out` rejects proactive `dm_user` actions during action execution. User-requested DM actions are not blocked by this preference. `dm_user.target.userId` is the gateway delivery user ID, while opt-out enforcement uses `dm_user.target.canonicalUserId`; proactive DMs without a canonical target are rejected before any privacy lookup or gateway send. `dm_user` execution evidence records bounded proactive metadata (`dm_proactive`, trigger, opt-out status, redaction level, and cooldown key) after redacting free-text reason/cooldown material.
- `memory_association=opted_out` rejects user-scoped memory candidates before durable `memory_records` writes, including `propose_memory` action execution. Rejections are auditable without copying candidate content into execution evidence.
- Privacy preference reasons and audit details are redacted before durable storage. Adjacent secret/platform fragments such as `sk-...-qq-...` and assignment-shaped operator reasons such as `api_key=sk-...-qq-...` preserve both marker classes without storing raw values.
- Opt-out `reason` text is operator metadata, not prompt memory. Secret-like
  values and QQ/platform-ID-like values are redacted before durable
  `privacy_preferences.reason` and audit `details` persistence, including
  legacy/free-text values embedded after non-alphanumeric separators such as
  `legacy_qq-...` and `legacy_123456789`. Audit
  `event_id` remains an exact local lookup key; shared/displayed details must
  use redacted fields.
- `list-privacy-preferences --user <canonicalUserId>` uses the raw local
  canonical user ID for exact filtering, but inspection output must redact the
  displayed `canonicalUserId` and opt-out `reason`. Assignment-shaped user IDs
  such as `api_key=sk-...-qq-...` preserve both
  `[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker classes
  in display output without mutating raw `privacy_preferences` rows.

Identity registry deletion may retain minimal tombstones. Tombstones do not enter prompt or retrieval.

Platform-provided display metadata is also treated as untrusted UI data.
Gateway-normalized `senderDisplayName` / `senderCard` fields, normalized
`raw_events.payload`, `display_profiles.current_display_name`, and
`nickname_history.display_name` store secret/platform-ID-redacted text when a
nickname or group card contains credential-shaped or QQ/platform-ID-like
substrings. Raw-event retention and deletion policy still governs the resulting
event audit source.

## Prompt and Context Boundaries

Ordinary prompts must not receive:

- `secret` / `prohibited` content;
- disabled/deleted memory;
- full allowlists/denylists;
- full account mapping tables;
- full nickname history;
- raw audit traces unless in owner/admin debug mode.

Platform IDs may be included when the current task needs them, but they should be structured fields rather than natural-language background.

Pi SDK session state must not become an unbudgeted prompt side channel. The
shared adapter serializes streamed and non-streamed turns through one FIFO lease,
resets the SDK transcript before installing each turn's context, and does not
release ownership until prompt/idle settlement and output or generator cleanup
finish. Only the current `ContextPack` may supply prior conversation history; a
previous user or group's retained SDK messages must never enter a later provider
request. A queued turn's timeout begins only after it owns that lease.

`ContextTraceRepository` stores replayable `/why` evidence with a storage final
guard: rejected-memory reasons, applied filter strings, injected identity-field
labels, and context-trace memory titles/source-context metadata are redacted for
secret-like and QQ/platform-ID-like substrings before insertion. Exact local
lookup identifiers such as context pack ID, turn ID, conversation/group IDs,
selected/candidate/rejected memory IDs, and recent message IDs remain stable in
SQLite and must be redacted at display/share boundaries.
Assignment-shaped adjacent trace metadata such as `api_key=sk-...-qq-...`
preserves both `[REDACTED:api_key_assignment]` and
`[REDACTED:platform_id]` before durable storage.

## Audit Safety

All tools should record at least summary audit in P0.

Audit levels:

- `summary`
- `redacted_full`
- `full`
- `none` reserved for future very low-risk cases

`full` is owner/debug only, short-retention, and still passes secret scanning.

Credential access must never log secret values. If secret scanning detects a credential in input/output, rewrite audit to redacted summary and mark `redactionApplied=true`.
`AuditRepository.create()` is a durable final guard for repository-backed audit
writers: it recursively redacts secret-like and QQ/platform-ID-like text from
audit `summary` and structured `details`, including object keys and numeric
platform-ID fields such as `senderId`, `group_ids`, `targetUserId`,
`recipientGroupIds`, and `messageId`, before persistence, even for `full`
entries. It marks the persisted row as redacted when this guard changes text.
Raw `event_id` values remain local exact lookup keys and should not be copied
into shared reports. Adjacent secret/platform fragments such as `sk-...-qq-...`
and assignment-shaped fragments such as `api_key=sk-...-qq-...` preserve both
secret-assignment/openai-like and platform marker classes in persisted
`summary` / `details` evidence without storing raw values.
`MemoryRepository` applies the same durable redaction to memory lifecycle audit
summary/details and to `memory_revisions.reason` before insertion. Revision
foreign keys and raw memory IDs remain exact local lookup keys, but narrative
operator metadata must not preserve pasted token-like or platform-ID-like text.
Assignment-shaped adjacent revision/audit text such as
`api_key=sk-...-qq-...` keeps both `[REDACTED:api_key_assignment]` and
`[REDACTED:platform_id]` markers, including structured audit detail object keys,
without storing the raw fragments.
`JobRepository` applies the same diagnostic boundary to structured job results,
job-attempt results, job/attempt error diagnostics, and worker-heartbeat details
before persistence: secret-like text, QQ/platform-ID-like text, object keys, and
numeric platform-ID fields such as `senderId`, `group_ids`, `targetUserId`,
`recipientGroupIds`, and `messageId` are redacted, while ordinary counters
remain available. Adjacent secret/platform fragments such as `sk-...-qq-...`
keep both marker classes in durable job/attempt/heartbeat diagnostics without
storing raw values. Assignment-shaped adjacent diagnostics such as
`api_key=sk-...-qq-...` likewise keep both `[REDACTED:api_key_assignment]` and
`[REDACTED:platform_id]` marker evidence, including structured result object
keys. Job payloads, idempotency keys, worker IDs, and job IDs
remain local control/lookup evidence and must be redacted at display/share
boundaries.
Automatic extraction job payloads contain only a canonical chat-message
reference and canonical target-user reference; they do not copy inbound chat or
bot-response text. The extractor logs bounded error names/codes rather than
downstream `Error` objects because an evaluator or repository error can echo
ordinary matched chat text that secret/platform-ID redaction would not remove.
`BackgroundWorker.list()` is an operator diagnostic projection over queued work:
it redacts task type, payload, and idempotency-key display values before return
without mutating the raw in-memory task state or durable job rows used for local
scheduling and lookup. `BackgroundWorker.processNext()` also redacts returned
`TaskResult.output` and `TaskResult.error` values before in-process callers see
them and before completed output is handed to `JobRepository`; adjacent
`sk-...-qq-...` fragments must keep both secret and platform marker classes in
returned and persisted worker diagnostics while omitting raw values.
Assignment-shaped adjacent worker outputs such as `api_key=sk-...-qq-...` must
also keep both `[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]`
marker classes in returned `TaskResult.output` and persisted job/attempt
results, including structured object keys.
OpenAI-like `sk-...` tokens are treated as secret-like even when they appear
inside legacy operator identifiers after non-alphanumeric separators; owner/admin
inspection output must redact those substrings before display.
Runtime structured logs must pass through the shared pino redaction hook before
write. This hook redacts secret-like strings, QQ/platform-ID-like strings,
numeric platform-ID fields including prefixed fields such as `targetUserId`,
`recipientGroupIds`, and `ownerMessageId`, and Error message/stack values. It
also covers legacy/free-text values embedded after non-alphanumeric separators, such as
`legacy_qq-...` and `legacy_123456789`, so logs do not become a side channel for
private platform identifiers. Adjacent secret/platform fragments such as
`sk-...-qq-...` must retain both `[REDACTED:openai_like_api_key]` and
`[REDACTED:platform_id]` marker evidence in structured values, dynamic object
keys, `Error.message`, and log message strings while omitting the raw fragment.
Assignment-shaped adjacent runtime diagnostics such as
`api_key=sk-...-qq-...` must likewise retain the
`[REDACTED:api_key_assignment]` marker and `[REDACTED:platform_id]` marker in
structured log values, dynamic object keys, `Error.message`, log message
strings, fatal startup output, and app-level failure logs instead of letting
assignment redaction swallow the platform marker.
The deterministic local smoke script follows the same direct-console diagnostic
boundary for failure formatting: raw stack frames, source paths, dependency
paths, assignment-shaped secrets, and QQ/platform identifiers are omitted while
both assignment-secret and platform marker classes remain visible for operator
evidence.

Action execution diagnostics are also governed. Reply and `dm_user` send
failures must redact secret-like and QQ/platform-ID-like substrings before
returning the execution result and before persisting
`action_executions.error_message`. Adapter-provided legacy/free-text errors may
contain embedded platform identifiers after non-alphanumeric separators; these
must be replaced with redaction markers rather than partially displayed.
Adjacent send-failure diagnostics such as `sk-...-qq-...` must keep both secret
and platform marker classes in returned and persisted error text while omitting
raw values. Assignment-shaped adjacent diagnostics such as
`api_key=sk-...-qq-...` must likewise preserve the secret-assignment marker and
`[REDACTED:platform_id]` marker instead of letting assignment redaction swallow
the platform evidence.

`ActionRepository` is a durable final guard for repository-backed social-action
ledgers. It redacts secret-like and QQ/platform-ID-like substrings from stored
`action_decisions.actions`, `reasons`, ordinary narrative `suppressors`,
structured object keys, ID-shaped numeric fields including prefixed fields such
as `targetUserId`, `recipientGroupIds`, and `ownerMessageId`, and
action-execution `downgraded_reason`, `error_code`, `error_message`, and
`audit_entry` before insertion. Exact local control/lookup keys remain stable
when they match the internal cooldown-key shape: `target.conversationId` /
`target.userId` / `target.canonicalUserId` / `target.groupId`, `constraints.cooldownKey`,
`cooldown:<cooldownKey>` suppressors, and `executed_message_id` are local
owner/admin evidence and must be redacted at display/share boundaries instead
of being mutated in storage.
The exact unredacted decision is committed only through a versioned keyed HMAC
in `action_decisions.execution_binding`; neither the process-local key nor raw
payload is durable. The same commitment covers the exact durable evaluator
outcome and request/version/actor/context/source/timestamp/domain/turn/risk/
confidence authority metadata and the turn's conversation/trigger source.
Creation clones the complete input before validation. Executor verification
recomputes redaction for durable-row comparison, requires the decision to remain
the turn's current decision, carries the verified source across later awaits,
and never reloads redacted action JSON for side effects. This avoids placing
secret/platform-bearing execution payloads in SQLite while preventing a caller
from reusing a decision ID with a different plan, evaluator authority, or
provenance source. Superseded decisions, null legacy bindings, and bindings from
another process are non-executable.

Agent-turn and app-level failure diagnostics are governed before exposure or
persistence. Thrown Pi/runtime errors and non-completed Pi turn error messages
must redact secret-like and QQ/platform-ID-like substrings before in-memory
event-processing failure exposure and before durable
`agent_turns.response_text` writes. Legacy/free-text provider errors can embed
platform identifiers after underscores or other non-alphanumeric separators;
these must redact as whole platform markers rather than leaving prefixes such as
`legacy_qq-`. Top-level fatal console diagnostics are governed by the same
boundary: adjacent secret/platform fragments such as `sk-...-qq-...` and
assignment-shaped failed-turn diagnostics such as `api_key=sk-...-qq-...` must
keep both secret and platform marker classes in durable strings while stack
fields are replaced with `[REDACTED:stack]`.
PiAdapter direct-console runtime failure diagnostics use the same boundary:
returned failed-turn error messages and `runTurn` console diagnostics must
preserve both secret and platform marker classes for adjacent fragments such as
`sk-...-qq-...` and assignment-shaped adjacent fragments such as
`api_key=sk-...-qq-...`, omit raw platform IDs and bare numeric platform-like
IDs, and replace stack fields with `[REDACTED:stack]`.
PiAdapter prompt display metadata is also prompt-adjacent governed data:
participant `display_name` / `group_card` labels and recent
`sender_display_name` labels must neutralize context delimiters and preserve
both marker classes for assignment-shaped adjacent fragments such as
`api_key=sk-...-qq-...` before model prompt construction.
Pi tool-adapter direct-console diagnostics are also display-only diagnostics:
missing-handler warnings and conversion-failure errors must redact tool names
and exception messages, preserve both marker classes for adjacent
`sk-...-qq-...` fragments and assignment-shaped adjacent fragments such as
`api_key=sk-...-qq-...`, omit raw platform IDs and bare numeric platform-like
IDs, and replace stack fields with `[REDACTED:stack]`.
Network request tool output is prompt/audit-adjacent and must redact
secret-like and QQ/platform-ID-like text before returning response bodies,
headers, status text, or network error messages to callers. Adjacent
`sk-...-qq-...` fragments must preserve both marker classes, including
assignment-shaped header values where token assignment redaction could
otherwise remove the already-detected platform marker.
File-operation tool output follows the same prompt/audit-adjacent rule for file
contents, output paths, directory entry names/paths, audit summaries, validation
reasons, and filesystem error messages. Adjacent `sk-...-qq-...` fragments in
file contents or assignment-shaped filenames must preserve both marker classes
without returning raw platform IDs or bare numeric platform-like IDs.
SQLite verbose SQL output is a direct-console diagnostic boundary. When
`initDatabase({ verbose: true })` is used for local debugging, displayed SQL must
redact secret-like and QQ/platform-ID-like substrings, including adjacent
`sk-...-qq-...` fragments with both marker classes preserved, before
`better-sqlite3` verbose hooks reach `console.log`. Assignment-shaped adjacent
SQL literals such as `api_key=sk-...-qq-...` must likewise preserve both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker classes
without printing raw fragments.
On POSIX, writable `initDatabase()` treats SQLite file mode as a privacy
boundary: it creates or remediates the resolved main database and existing
WAL/SHM sidecars to `0600` before serving. It does not mutate the global umask,
and readonly opens do not change filesystem state. Private parent-directory
ownership remains required; Windows deployments use restrictive ACLs instead.
The container runs as a non-root numeric identity, and its bind directory plus
SQLite main/WAL/SHM files must share that owner. A legacy root-owned `0600`
database requires a stopped-service ownership migration; weakening its mode or
recursively changing co-located SnowLuma state is not an acceptable workaround.
Checked local stacks expose only a dedicated LetheBot data directory to the
application and bind VNC/WebUI/OneBot/application ports to loopback. Sharing a
numeric UID does not authorize LetheBot to see SnowLuma config, QQ state, or
logs.

OneBot deployment and verification operator output is governed display data.
`deploy-napcat` / `verify-napcat` may need raw URLs and tokens for the local
connection attempt, but console output must redact token values, secret-like
substrings, QQ/platform-ID-like substrings, and embedded legacy/free-text
platform identifiers before display. `deploy-napcat` HTTP verification
diagnostics and spawned `verify-napcat` operator output must also preserve both
marker classes for assignment-shaped adjacent OneBot API/operator values such as
`api_key=sk-...-qq-...` without printing raw fragments.
Governance CLI validation and Commander parser errors are also governed display
data. Invalid operator-provided filter values may contain assignment-shaped
adjacent fragments such as `api_key=sk-...-qq-...`; stderr must keep both
secret-assignment and platform marker classes while omitting raw fragments and
must not mutate DB state.
Governance CLI memory-review inspection is a display/share boundary as well:
assignment-shaped adjacent memory IDs in review details or exact `--memory`
filters must preserve both marker classes in `list-memory-reviews` and
`summarize-memory-reviews` output while raw SQLite identifiers remain local
lookup keys.
Ops maintenance CLI output follows the same operator-display boundary. Backup,
restore, metrics, retention, and worker-soak JSON display paths plus parser
errors may contain assignment-shaped adjacent fragments such as
`api_key=sk-...-qq-...`; stdout/stderr must keep both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` without exposing
raw fragments, while raw local filesystem paths and DB rows remain unchanged
for the actual operation. Metrics JSON aggregate keys derived from DB text must
preserve the same two marker classes for assignment-shaped adjacent values while
leaving raw metric source rows unchanged.
Governance health aggregate keys derived from DB text, including action types,
audit event/risk values, job types, worker heartbeat types, and
event-processing stages, follow the same display boundary: assignment-shaped
adjacent fragments such as `api_key=sk-...-qq-...` must preserve both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` without mutating
raw SQLite rows.

OneBot gateway event-handler failures are direct-console/readiness/listener
diagnostics. Listener-thrown errors must be formatted through bounded redaction
before `console.error`, readiness `lastError`, or emitted adapter `error` events;
assignment-shaped adjacent fragments such as `api_key=sk-...-qq-...` must keep
both `[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]`, while raw
fragments, source paths, dependency paths, and stack frames remain omitted.
OneBot gateway send API diagnostics are governed display/readiness data. HTTP
and WebSocket send API response `message` / `wording` fields, thrown request
errors, and adapter readiness `lastError` values must redact secret-like and
QQ/platform-ID-like substrings before being surfaced to action execution,
operators, health/readiness callers, or logs.
OneBot WebSocket lifecycle diagnostics use the same boundary: open-factory
failures, socket `error` events, close reasons, invalid JSON parse diagnostics,
and emitted adapter `error` events must not expose secret-like or
QQ/platform-ID-like substrings through readiness or listener output. WebSocket
close while send API requests are pending must clear pending readiness counts and
reject callers with bounded local diagnostics rather than raw close reasons.
Adapter shutdown must preserve that cleanup/redaction boundary even when socket
close itself throws a sensitive diagnostic. Synchronous WebSocket `socket.send()`
failures after pending request creation must also clear the pending request and
redact caller/readiness diagnostics without creating unhandled raw-error promise
rejections.

Local acceptance evidence tooling is also governed display data. Generated
templates must be redaction-first, validation findings must report rule IDs and
line numbers without echoing matched values, and evidence CLI JSON/errors must
redact secret-like and QQ/platform-ID-like substrings in displayed paths. This
includes legacy/free-text prefixed platform identifiers such as `legacy_qq-...`
and underscore-delimited numeric IDs.

Durable event-processing failure diagnostics must use internal IDs and hashes
only. They must not store platform IDs, message text, display names, or raw
error strings; operator inspection commands should show hashed correlation
fields and redacted details only.

The event-processing admission ledger stores only its internal raw-event lookup
key, bounded lifecycle states/reason codes, and timestamps. Startup recovery
logs and metrics expose aggregate counts only; they must not copy the normalized
payload, message text, platform identifiers, parser diagnostics, or raw errors.

## Tool Safety

Tools should declare:

- capabilities;
- required permissions;
- evaluator policy: `required | bypass`;
- audit level;
- sandbox policy;
- output sensitivity;
- whether they can mutate state;
- whether they can access network;
- whether results are persisted;
- whether they can run long-lived processes.

Dangerous tools should require explicit policy checks before execution. Bypassing LLM evaluator review does not bypass permissions, sandboxing, deterministic hard policy, or audit.

`ToolCallRepository` is a durable final guard for repository-backed tool-call
ledgers. It redacts secret-like and QQ/platform-ID-like substrings from stored
tool input/output payload strings, structured object keys, ID-shaped numeric
fields including prefixed fields such as `targetUserId`, `recipientGroupIds`,
and `ownerMessageId`, `error_code`, and `error_message` before insertion, and
sets `secrets_redacted=1` when the guard changes stored data. Exact local
linkage fields such as `turn_id`, raw actor lookup keys, and tool names remain
stable for owner/admin queries; do not copy raw local identifiers into shared
reports.

See `tool-registry.md`.
