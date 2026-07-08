# Operations

The first deployment target is one local machine or small VPS running one Node process, one SQLite database, one bot account, and one QQ group.

## Runtime Processes

Recommended MVP processes:

- `gateway`: SnowLuma / OneBot WS or HTTP event receiving and message routing.
- `api`: internal HTTP server and governance CLI entrypoints.
- `worker`: summarization, extraction, retention, memory conflict scans,
  memory decay review scans, memory consolidation candidate scans, admin
  digests, backup, and maintenance jobs.
- `pi-runtime`: embedded in API at first; split later only if needed.

For MVP these can be one Node process with module boundaries preserved in code.

## Local Deterministic Smoke

Use the local smoke script as a fast operator sanity check after dependency,
schema, tool-registry, or governance CLI changes:

```bash
pnpm --silent smoke
```

The smoke path uses a disposable SQLite database under the OS temp directory,
runs migrations, exercises `MemoryRepository`, `IdentityRepository`,
`AttentionEngine`, `MockPi`, `ContextBuilder`, `ToolRegistry`/`PolicyGate`,
`BackgroundWorker`, and basic `GovernanceCLI` disable/enable flows, then removes
the temp DB directory. It is deterministic and does not contact real
SnowLuma/QQ/NapCat or external Pi providers.

Smoke failure diagnostics are bounded and display-redacted before direct
`console.error`: secret-like text, QQ/platform-ID-like values, raw stack frames,
source paths, and `node_modules` paths should not appear in stderr. Use
`pnpm --silent smoke` when copying output into an evidence note so package
manager lifecycle noise is minimized. Assignment-shaped adjacent diagnostics
such as `api_key=sk-...-qq-...` preserve both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker evidence in
formatted smoke errors while omitting raw values and stack paths.

## Background Worker Runtime

The app process registers an in-process durable background worker in the local
profile. In non-test runtime it starts a timer-based scheduler that:

- polls `jobs` through `JobRepository` leases/attempt rows;
- extends the active job lease while a durable handler is still running, so a
  second worker cannot reclaim the same job merely because the original handler
  is longer than the initial lease window;
- honors retry backoff by keeping failed jobs pending until their next
  `scheduled_at`; other ready jobs can still be claimed while a delayed retry
  waits;
- keeps type-restricted repository claim polling bounded to matching job types:
  a summary-only claim can take ready summary work without failing unrelated
  expired extraction leases, while the matching extraction poller still records
  the expired max-attempt failure when it runs;
- writes `worker_heartbeats` while idle/running/error;
- preserves the latest `error` heartbeat, including its redacted current-job
  linkage and details, across later empty polls so a final worker failure stays
  inspectable until the worker claims new work and transitions back through
  `running`/`idle`; deterministic worker tests cover both the empty-poll
  retention path and the later-success recovery path that clears the retained
  error heartbeat;
- redacts secret-like and QQ/platform-ID-like substrings before writing
  lease-expiry retry diagnostics, job/attempt errors, job/attempt structured
  results, and worker heartbeat details, and before returning worker
  `TaskResult.output` / `TaskResult.error` values to in-process callers.
  Adjacent secret/platform fragments such as `sk-...-qq-...` keep both secret
  and platform marker classes in returned `TaskResult.output` /
  `TaskResult.error` values, persisted job results, attempt results,
  job/attempt errors, and heartbeat details without exposing raw values. The
  same durable job/attempt/heartbeat boundary preserves both
  `[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker evidence
  for assignment-shaped adjacent diagnostics such as `api_key=sk-...-qq-...`
  before returning `TaskResult.output` / `TaskResult.error` and before
  persisting job/attempt/heartbeat evidence, including structured result object
  keys. The
  same returned-error redaction is used by the legacy in-memory
  `processNext()` path. Structured diagnostic object keys and values are both
  sanitized; raw worker IDs remain internal local keys for exact lookup and
  heartbeat/attempt linkage;
- executes concrete `summary`, `extraction`, `retention`, `admin_digest`,
  `conflict`, `decay`, and `consolidation` handlers;
- fails unsupported durable job types visibly and terminally instead of
  coercing them to a known handler or retrying deterministic bad input until
  `max_attempts`. The failed job, single failed attempt, returned worker error,
  and heartbeat details are redacted before persistence/display while the raw
  job `type` remains in the local `jobs` row and in-process
  `BackgroundWorker.list()` output for operator diagnosis instead of being
  displayed as a fake `summary` task;
- discovers conversation-summary candidates and enqueues idempotent `summary`
  jobs;
- enqueues daily idempotent `admin_digest` jobs that write redacted operational
  evidence to `audit_log` using IDs/counts only, not payloads, tool inputs,
  errors, or credential-like values;
- enqueues daily idempotent `conflict` jobs that detect active memory conflicts
  and write redacted `memory.conflict.detected` audit rows using memory IDs and
  title hashes only. The current handler does not automatically supersede,
  delete, or activate memory.
- enqueues daily idempotent `decay` jobs that detect stale low-confidence or
  low-importance active memories and write redacted
  `memory.decay.candidates_detected` audit rows. The current handler does not
  automatically change memory state, confidence, importance, or revisions.
- enqueues daily idempotent `consolidation` jobs that detect duplicate active
  memory groups and write redacted
  `memory.consolidation.candidates_detected` audit rows using memory IDs,
  title hashes, content hashes, and counts only. The current handler does not
  automatically merge, supersede, delete, or otherwise mutate memory records.

Deterministic tests keep wall-clock scheduling disabled through
`LETHEBOT_TEST=true` and drive the same durable worker manually, so tests can
assert `jobs`, `job_attempts`, `worker_heartbeats`, `memory_sources`,
`memory_revisions`, and `audit_log` without waiting for timers.

Current limits:

- summary, extraction, retention, admin-digest, conflict, decay, and
  consolidation handlers are wired. Conflict/decay/consolidation workers remain
  review/audit-only and never mutate memory automatically; owner/admin review
  can explicitly approve a safe supersede through governance CLI for conflict
  or consolidation audit rows.
- the worker runs in-process for the local profile and is not a separate worker
  service yet;
- real SnowLuma/QQ acceptance is still manual/opt-in.

### Opt-in local scheduler soak

Use the opt-in worker soak command to exercise the durable
`JobRepository -> BackgroundWorker -> WorkerScheduler` path with real timers
before a longer local run. The synthetic soak covers every currently registered
durable background task type: `summary`, `extraction`, `retention`,
`admin_digest`, `conflict`, `decay`, and `consolidation`.

```bash
pnpm ops:worker-soak -- --duration-ms=15000 --interval-ms=1000
```

By default the command creates a migrated SQLite database under `/tmp` and
prints its path for inspection. To run against an explicit disposable DB path:

```bash
pnpm ops:worker-soak -- \
  --db=/tmp/lethebot-worker-soak.db \
  --duration-ms=60000 \
  --interval-ms=1000
```

Do not point this command at a production DB unless you intentionally want to
write synthetic `jobs`, `job_attempts`, and `worker_heartbeats` rows. The output
is aggregate-only: job status/type counts, attempt status counts, idle heartbeat
state, lease-extension observation counts, tick/processed counts, and FK-clean
status. The synthetic summary job waits for at least one active-lease extension
before completing, so the soak proves the real timer path exercises durable
lease heartbeats rather than only short handlers. It intentionally omits job
payloads, attempt result/error text, worker details, and secret-like values.
Successful worker-soak JSON display is redacted like other ops JSON output, so
secret-like or QQ/platform-ID-like values embedded in an explicit `--db` path or
operator-provided `--worker-id` do not appear in stdout. The local DB and worker
rows still use the raw operator-provided values as internal local keys. The
soak command suppresses scheduler info/debug logs on this synthetic path so
stdout remains machine-readable JSON even when the default runtime log level is
not overridden.

Expected healthy evidence:

- `success: true`
- `jobs.completed: 7`
- `jobAttempts.failed: 1` and `jobAttempts.plannedRetryObserved: true`
- `jobAttempts.running: 0`
- `leaseExtensions.observed: true` and `leaseExtensions.count >= 1`
- `workerHeartbeat.status: "idle"`
- `workerHeartbeat.currentJobIdPresent: false`
- `foreignKeyViolations: 0`

If the soak finishes but these health criteria are not met, the command still
prints the same redacted aggregate JSON evidence and exits non-zero so it can be
used as an operator gate without losing diagnostic counts.

This command is still a local synthetic soak, not real SnowLuma/QQ acceptance
and not a multi-hour production soak.

### Local acceptance evidence files

Use the redaction-first evidence template for manual SnowLuma/QQ acceptance
records:

```bash
pnpm acceptance:evidence-template -- --out=/tmp/lethebot-acceptance-evidence.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
```

Use non-sensitive evidence file names. The evidence script redacts paths in its
own JSON output and errors, but the package manager can echo raw script
arguments before the script runs. If a local path or argument might contain a
token, cookie, QQ ID, group ID, username, or other private identifier, rename it
to a neutral `/tmp` path before invoking the package script, or run with
`pnpm --silent`, for example:

```bash
pnpm --silent acceptance:evidence-template -- --out=/tmp/lethebot-acceptance-evidence.md
pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
```

Do not copy non-silent package-manager lifecycle output into evidence files when
command arguments contain sensitive values. The validator reports only rule IDs,
line numbers, and counts for detected unsafe content; it must not echo matched
secret-like values or raw message text.

The evidence CLI rejects malformed arguments explicitly: `--out` / `--out=` and
`--validate` / `--validate=` without a following file path fail, unknown options
fail, and bare positional arguments in template mode fail. Use either
`--out=/tmp/lethebot-acceptance-evidence.md` or
`--out /tmp/lethebot-acceptance-evidence.md`; parser errors are redacted by the
script before display.

When documenting HTTP checks, use redacted placeholders such as
`Authorization: Bearer <redacted-token>`. The validator accepts explicit
redacted/placeholder bearer values, but raw bearer tokens and API-key-like values
remain findings and are not echoed in validator output. API-key-like `sk-...`
tokens and numeric QQ/group/platform-ID-like values embedded in legacy
identifier text after non-alphanumeric separators such as `_sk-...` or
`_12345678901` are also findings. Evidence CLI display redaction also redacts
prefixed platform identifiers embedded in legacy/free-text paths, such as
`legacy_qq-...`, without leaving partial `legacy_qq-` remnants in JSON output or
errors. Adjacent secret/platform fragments such as `sk-...-qq-...` are redacted
with the same marker-preserving display order used by other operator
diagnostics, so both secret and platform redaction markers remain visible
without exposing raw values.

## Governance CLI Review Actions

Use `list-memory-reviews` to inspect conflict/consolidation review audit
candidates before approving a lifecycle change:

```bash
pnpm cli list-memory-reviews
pnpm cli list-memory-reviews --memory <memory-id> --include-details
pnpm cli list-memory-reviews --status unresolved
pnpm cli list-memory-reviews --status resolved
pnpm cli list-memory-reviews --event-type memory.conflict.detected
pnpm cli list-memory-reviews --event-type memory.consolidation.candidates_detected
pnpm cli list-memory-reviews --event-type memory.decay.candidates_detected
pnpm cli summarize-memory-reviews
pnpm cli summarize-memory-reviews --status unresolved
pnpm cli summarize-memory-reviews --memory <memory-id>
pnpm cli list-memory --state active --scope user --sensitivity normal --source-type user_command
pnpm cli export-memory --state active --scope user --source-type user_command
pnpm cli why --turn <turn-id>
pnpm cli why --conversation <conversation-id> --type private
pnpm cli list-privacy-preferences --type proactive_dm --state opted_out
pnpm cli set-privacy-opt-out <canonical-user-id> proactive_dm --reason <reason>
pnpm cli clear-privacy-opt-out <canonical-user-id> proactive_dm --reason <reason>
pnpm cli list-audit --category tool --level full --risk high
pnpm cli list-event-failures
pnpm cli list-event-failures --stage pi_inference --include-details
pnpm cli list-action-decisions --decided-by pi --risk high
pnpm cli list-action-executions --action-type reply_short --status failed
pnpm cli list-tool-calls --status error
pnpm cli list-jobs --status failed
pnpm cli list-job-attempts --status failed
pnpm cli list-worker-heartbeats --status error
pnpm cli summarize-governance-health
```

Governance CLI top-level runtime failures, including SQLite database open
failures from an invalid `LETHEBOT_DB_PATH` and configuration validation
failures from invalid environment values, are reported through the same
redacted error path as command validation failures. Config loading for DB-backed
commands is lazy, so `--help` remains available without opening the configured
database or dumping raw validation issues. Spawned CLI coverage asserts these
failures produce empty stdout for failing DB-backed commands and concise
redacted stderr without DB paths, raw env values, source paths, zod issue dumps,
error class names, stack traces, `node_modules` frames, secret-like fragments,
or QQ/platform-ID-like values. Representative coverage includes
`summarize-governance-health`, `list-memory`, and the top-level help path, and
verifies the intended DB is not mutated.

Privacy-preference `--reason` values are redacted before durable persistence:
secret-like strings and QQ/platform-ID-like values are replaced in
`privacy_preferences.reason` and audit `details`, including values embedded
after non-alphanumeric separators in legacy/free-text operator reasons such as
`legacy_qq-...` and `legacy_123456789`. Adjacent secret/platform fragments such
as `sk-...-qq-...` and assignment-shaped operator reasons such as
`api_key=sk-...-qq-...` keep both secret and platform marker classes without
exposing raw values. CLI command output and `list-privacy-preferences` inspection output
also redact platform-like user fields, legacy/free-text `preferenceType` /
`state` display values, and legacy/free-text actor metadata such as
`updatedBy.actorClass` and `updatedBy.context`. Assignment-shaped canonical
user IDs such as `api_key=sk-...-qq-...` remain usable as raw local
`--user` filter keys for exact owner/admin lookup, while the displayed
`canonicalUserId` and reason preserve both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker classes and
omit raw fragments. Audit `event_id` remains a raw local filter key for
owner/admin lookup; do not copy raw event IDs into shared reports.

`redact-display-profile` also redacts secret-like and QQ/platform-ID-like
operator-provided user/group identifiers before writing durable audit
`summary` and `details`. The audit `event_id` remains the raw local
`<canonicalUserId>:<groupId>` lookup key for owner/admin filtering, but shared
reports should use `list-audit --event-type display_profile.redact` output so
display copies are redacted.

Memory lifecycle audits created through the governed repository also redact
secret-like and QQ/platform-ID-like memory identifiers before writing durable
audit `summary` and structured `details`, including nested JSON object keys and
values. Revision reasons are redacted before durable `memory_revisions`
storage. Adjacent secret/platform fragments such as `sk-...-qq-...` use the
same platform-before-secret-after-platform ordering, so stored revision/audit
evidence keeps both marker classes without exposing raw values. Assignment-shaped
adjacent operator text such as `api_key=sk-...-qq-...` likewise keeps both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker evidence,
including structured audit detail keys. The audit
`event_id` remains the raw local memory ID lookup key for owner/admin filtering;
do not copy raw platform-like event IDs into shared reports.

`show-memory` source and revision evidence is display data, not raw durable
storage output. `memory_sources.memory_id`, `source_type`, `source_id`, and
`extracted_by` plus `memory_revisions.id`, `memory_id`, `change_type`, `actor`,
`reason`, `evaluator_decision_id`, and structured state snapshots are redacted
before JSON display; this includes legacy/free-text `source_type`,
`extracted_by`, and `change_type` values that contain secret-like or
QQ/platform-ID-like fragments. Raw `memory_sources` and `memory_revisions` rows
remain local exact evidence for DB inspection and FK checks.

The generic audit repository applies the same final redaction guard before
durable persistence: audit `summary` and structured `details` are recursively
redacted even for `level='full'` entries, including object keys and numeric
platform-ID fields such as `senderId`, `group_ids`, `targetUserId`,
`recipientGroupIds`, and `messageId`; `redacted` is forced true when that guard
changes text. This protects tool, worker, memory-review, and proposal/rejection
audit writers that route through `AuditRepository.create()`. Raw `event_id`
values remain local exact lookup keys. Spawned governance inspection applies the
same structured numeric platform-ID display redaction for included details from
legacy/direct rows. Adjacent secret/platform fragments such as `sk-...-qq-...`
and assignment-shaped fragments such as `api_key=sk-...-qq-...` are redacted
before durable audit persistence with a marker-preserving
platform-before-secret-after-platform order, so both marker classes remain in
stored `summary` / `details` evidence without exposing raw values.

The command reports audit IDs, event types, redacted summaries, candidate
memory ID groups, resolution status, resolution audit IDs when available, and
optional redacted details. Secret-like and QQ/platform-ID-like substrings are
redacted from displayed review audit IDs, event IDs, candidate memory ID groups,
resolution audit IDs, superseded/replacement/disabled memory IDs, and included
details. Adjacent secret-like and QQ/platform-ID-like fragments in stored review
display fields keep both secret and platform redaction markers without exposing
raw values. Raw `--memory` filters and stored audit rows remain exact local
lookup keys. It does not display memory contents. A candidate is `resolved` when a
later governed `memory.supersede` or `memory.disable` audit row references that
review audit ID; otherwise it is `unresolved`.
`summarize-memory-reviews` returns redacted aggregate counts by review event
type and resolution status, including candidate group counts, memory-reference
counts, resolution audit counts, superseded/replacement counts, and disabled
counts. Its echoed `--memory` filter value is display-redacted. It does not
include audit details, memory titles, or memory contents.
When review audit details or exact `--memory` filters contain assignment-shaped
adjacent local identifiers such as `api_key=sk-...-qq-...`, both
`list-memory-reviews` and `summarize-memory-reviews` preserve
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` in display JSON
while continuing to use raw SQLite IDs as exact local lookup keys.
Both `list-memory-reviews` and `summarize-memory-reviews` validate
`--event-type` and `--status` before dispatch; invalid values fail with
redacted stderr, empty stdout, no source-path or stack leakage, no persisted
mutation, and clean SQLite FK state. Spawned CLI coverage includes invalid
memory-review filters with embedded secret-like and QQ/platform-ID-like
fragments.
`summarize-governance-health` returns redacted aggregate operator health counts
across memory reviews, action decisions/executions, tool calls, jobs, expired
running job leases, worker heartbeats, event-processing failures, and audit
rows. Dynamic aggregate keys derived from free-text database values such as
failure stage, job type, worker type, audit event type, or audit risk level are
redacted before display. Assignment-shaped adjacent aggregate keys such as
`api_key=sk-...-qq-...` preserve both `[REDACTED:api_key_assignment]` and
`[REDACTED:platform_id]` in the displayed JSON while raw SQLite rows remain
unchanged for local lookup/counting evidence. It is intended for quick triage
and intentionally omits payloads, memory contents, tool input/output, job
payload/result, and heartbeat details.
Memory inspection/export commands validate finite enum filters before dispatch:
`--state` accepts `proposed`, `active`, `rejected`, `superseded`, `disabled`,
or `deleted`; `--scope` accepts `global`, `user`, `group`, `conversation`,
`tool`, or `system`; `--sensitivity` accepts `normal`, `personal`,
`sensitive`, `secret`, or `prohibited`; `--source-type` accepts `raw_event`,
`chat_message`, `tool_output`, `worker_extraction`, or `user_command`.
`--source-context`, `--source-id`, `--user`, `--group`, and `--conversation`
remain free-form data filters. Invalid enum values fail before DB mutation and
are redacted before display.
`show-memory` and `export-memory` redact display copies of memory IDs, owner
IDs, group/conversation/subject IDs, source context/source event IDs, source
rows, revision IDs, revision actor/reason text, and evaluator decision IDs.
Dirty/legacy memory-record classification fields such as `scope`, `visibility`,
`sensitivity`, `authority`, `kind`, and `state` are also treated as display
strings and redacted before CLI output; `list-memory` applies the same display
redaction to human-readable scope/state/visibility lines. The raw IDs and raw
legacy classification values remain exact local lookup keys in SQLite and CLI
filters.
When governance inspection commands include structured payloads or details
(`--include-details`, `--include-payload`, `--include-actions`,
`--include-result`, or `--include-audit-entry`), both JSON object keys and
values are redacted before display. Raw filter values remain exact local lookup
keys, but secret-like or QQ/platform-ID-like substrings embedded in legacy
stored JSON property names must not appear in CLI stdout/stderr.
Repository-backed `tool_calls` rows apply the same defensive redaction before
durable persistence for input/output payload keys and values plus error
diagnostics. Adjacent secret/platform fragments such as `sk-...-qq-...` preserve
both secret and platform marker classes while hiding raw values, and the
`secrets_redacted` flag is set when the final guard changes stored data.
`list-action-decisions` also treats `decided_by` and `risk_level` as display
fields. The migrated schema constrains them to finite values, but legacy or
manually repaired DBs can contain free-text classification values; displayed
classification fields are redacted before JSON output while raw rows remain
local DB evidence.
List-style governance commands validate `--limit` before dispatch. Limits must be
base-10 integers from `1` to `1000`; `why --limit` uses the same rule with a
smaller maximum of `200` recent messages. Invalid limit values fail before DB
mutation and are redacted before display. Job type and worker type filters are
open business strings, not closed enums.
Commander-level parser errors such as unknown commands, unknown options, and
missing required arguments also use the same display redaction before writing to
stderr. These failures occur before DB mutation and should leave stdout empty.
Validation and parser stderr for assignment-shaped adjacent values such as
`api_key=sk-...-qq-...` must preserve both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker evidence
while omitting the raw secret/platform fragments.
`why --turn` uses the raw turn ID as an exact local lookup key, then prints a
redacted context-trace explanation with context-pack ID, selected/candidate
memory IDs, rejected-memory reasons, applied filters, identity fields, and
token-budget evidence including used/max tokens and the per-area breakdown, plus
recent-message IDs. Running `why` without `--turn` resolves the latest agent
turn. `why --turn` and `why --conversation` are mutually exclusive; supplying
both fails before stored-trace lookup or context rebuild so an ambiguous request
cannot display an unrelated trace. Output/display text redacts secret-like and
platform-like turn, context-pack, conversation, group, memory, and
recent-message identifiers when those fields contain QQ/platform-shaped values.
Missing-turn/no-turn failures exit non-zero with empty stdout and concise
redacted stderr, without stack traces. The command must not print raw message
text, memory titles/content, or secret-like values embedded in stored trace
fields.

Stored context traces also have a repository-level final guard: rejected reasons,
filter strings, injected identity-field labels, and memory title/source-context
metadata are redacted before durable insertion. Raw context/turn/conversation,
memory, and recent-message IDs stay exact local lookup evidence and are redacted
only at display/share boundaries. Adjacent secret/platform fragments such as
`sk-...-qq-...` in stored trace narrative metadata and token-budget layer
name/version fields keep both marker classes without exposing raw values.
Assignment-shaped adjacent metadata such as `api_key=sk-...-qq-...` preserves
both the assignment secret marker and the platform marker before insertion.
Failed agent turns store redacted runtime/Pi diagnostics in
`agent_turns.response_text`; embedded legacy/free-text platform identifiers such
as `legacy_qq-...` and underscore-delimited numeric IDs are redacted before
persistence. Adjacent secret/platform fragments such as `sk-...-qq-...` keep
both secret and platform marker classes in persisted failed-turn diagnostics
without exposing raw values. Assignment-shaped adjacent diagnostics such as
`api_key=sk-...-qq-...` keep both the secret-assignment marker and
`[REDACTED:platform_id]` in persisted failed-turn evidence. PiAdapter direct-console `runTurn` failure
diagnostics use the same marker-preserving redaction before `console.error`;
raw stacks are replaced with `[REDACTED:stack]`, and adjacent
secret/platform fragments keep both marker classes in returned failed-turn error
messages and console diagnostics. Assignment-shaped adjacent runtime diagnostics
such as `api_key=sk-...-qq-...` also preserve both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` in returned failed
outputs and direct-console diagnostics while omitting raw fragments.
When rebuilding without a stored trace, `why --conversation` requires an explicit
`--type private|group`; otherwise it fails before resolving the latest stored
turn or dispatching context rebuild. Group conversation rebuilds also require
`--group <group-id>` so ContextBuilder can apply group-scoped memory retrieval
and same-group visibility filters instead of silently building a group context
without group scope. Private conversation rebuilds reject `--group` so a private
context cannot carry group identity fields or group-scoped retrieval hints. `why
--type` accepts only `private` or `group`; invalid values fail before context
dispatch and are redacted before display.

Privacy preference commands support only `proactive_dm` and
`memory_association` preference types. `list-privacy-preferences` supports only
`opted_in` and `opted_out` state filters. Invalid type/state values fail before
DB mutation and are redacted before display.

`list-event-failures` reads durable `event_processing_failures` rows. It
uses raw `--raw-event` and `--turn` values as exact local owner/admin lookup
keys, but output/display JSON redacts platform-like `id`, `rawEventId`, and
`turnId` values before printing. Legacy/free-text stored `stage` values are also
display-redacted, while valid coarse stage values remain readable. It returns
coarse stage, conversation type, error class, and SHA-256 hashes for
message/sender/conversation/error correlation. It must not return platform IDs,
message text, display names, or raw error strings. The optional `--stage` filter is validated against the known
coarse event-processing stages: `raw_event_store`, `identity_resolution`,
`display_metadata`, `chat_message_store`, `attention_analysis`, `turn_create`,
`context_building`, `pi_inference`, `social_decision`, `action_execution`,
`bot_response_persist`, `memory_extraction`, and `turn_complete`.

Audit inspection validates finite enum filters before dispatch:
`list-audit --category` accepts `tool`, `memory`, `social`, `evaluator`, or
`system`; `list-audit --level` accepts `summary`, `redacted_full`, or `full`;
`list-audit --risk` accepts `low`, `medium`, `high`, or `prohibited`. Invalid
values fail before DB mutation and are redacted before display. Dirty/legacy
`audit_log.category` and `audit_log.level` values are treated as display strings
and redacted before JSON output, even though valid filters remain finite enums.
Prohibited audit risk filtering uses the same redacted display path as high-risk
rows and matches the governance-health `audit.prohibitedRisk` /
`highOrProhibitedRiskAuditEvents` counts.

Action/tool inspection commands validate finite enum filters before dispatch:
`list-action-decisions --decided-by` accepts `attention`, `pi`, or
`evaluator`; `list-action-decisions --risk` accepts `low`, `medium`, `high`,
or `prohibited`; `list-action-executions --action-type` accepts
`silent_store`, `silent_summarize_later`, `reply_short`, `reply_full`,
`reply_with_tool`, `propose_memory`, `admin_digest`,
`schedule_background_task`, `dm_user`, `react_only`, `send_folded_forward`,
or `ask_clarification`; `list-action-executions --status` accepts `success`,
`downgraded`, `failed`, or `rejected`; `list-tool-calls --status` accepts
`success`, `error`, `timeout`, or `rejected`. Invalid values fail before DB
mutation and are redacted before display. Raw `--turn` values remain exact
lookup keys for action/tool inspection, while output/display `turnId` values are
redacted when they contain platform-like identifiers. Tool-call legacy or
manual-repair classification fields such as `requested_by` and `status` are
treated as display strings and redacted before JSON output, even though valid
`list-tool-calls --status` filters remain finite enums. `list-action-executions`
also redacts platform-like `executedMessageId` values before display. Legacy or
dirty-DB action-execution classification fields such as `status` and
`audit_level` are treated as display strings and redacted before JSON output,
even though current valid filters remain finite enums. Free-text
diagnostic fields such as action-execution `downgradedFrom` / `errorCode` and
tool-call `errorCode` are display-redacted like error messages, because legacy
or adapter-provided diagnostic codes can contain secret-like or platform-like
substrings. Action-executor reply and `dm_user` send failures are redacted
before the execution result is returned and before
`action_executions.error_message` is persisted; this includes
QQ/platform-ID-like values embedded after non-alphanumeric separators in
legacy/free-text adapter errors, such as `legacy_qq-...` or
`legacy_123456789`, and adjacent secret/platform fragments such as
`sk-...-qq-...` where both secret and platform marker classes must remain
visible while raw values are omitted. Assignment-shaped adjacent diagnostics
such as `api_key=sk-...-qq-...` must preserve both the secret-assignment marker
and `[REDACTED:platform_id]` in returned/persisted send-failure evidence.

Repository-backed action decisions and executions also have a final storage
guard. Stored action narrative fields, structured payload object keys/values,
ordinary suppressors, ID-shaped numeric payload fields such as `targetUserId`,
`recipientGroupIds`, and `ownerMessageId`, and execution diagnostics are
redacted before insertion; valid internal cooldown control keys
(`constraints.cooldownKey` and `cooldown:<cooldownKey>` suppressors), action
targets, and executed message IDs remain exact local lookup evidence.
Adjacent secret/platform fragments such as `sk-...-qq-...` in stored action
narratives or execution diagnostics keep both secret and platform marker
classes while hiding raw values.
Governance/ops display commands must redact those identifiers before
stdout/stderr or shared reports.

Job inspection commands validate status filters before dispatch:
`list-jobs --status` accepts `pending`, `running`, `completed`, or `failed`;
`list-job-attempts --status` accepts `running`, `completed`, or `failed`;
`list-worker-heartbeats --status` accepts `idle`, `running`, `stopping`, or
`error`. Invalid status values fail before DB mutation and are redacted before
display. Raw `--job` / `--worker` filters remain exact local lookup keys, while
platform-like job IDs are redacted in `list-jobs`, `list-job-attempts`, and
`list-worker-heartbeats` output. Legacy or dirty-DB status values in `jobs`,
`job_attempts`, and `worker_heartbeats` are treated as display strings and
redacted before JSON output, even though current valid filters remain finite
enums.

`JobRepository` redacts structured diagnostic persistence for completed job
results, attempt results, and worker heartbeat details, including object keys,
secret/platform-like text, and numeric platform-ID fields such as `senderId`,
`group_ids`, `targetUserId`, `recipientGroupIds`, and `messageId`, while
preserving ordinary counters. Assignment-shaped adjacent job diagnostics such
as `api_key=sk-...-qq-...` keep both assignment-secret and platform marker
classes before persistence. Raw job payloads, idempotency keys, worker IDs, and
job IDs remain local control/lookup evidence and are redacted by spawned
inspection output before sharing.

Governance inspection output redacts secret-like and platform-like actor,
worker, lease, row, linkage, turn, executed-message, job, and event-failure
identifiers, including values embedded in legacy/free-text fields after
non-alphanumeric separators, in JSON fields such as audit
`id`/`eventId`/`evaluatorDecisionId`,
audit/tool-call `actor.canonicalUserId`, audit/tool-call legacy/free-text actor
metadata (`actor.actorClass`, `actor.context`, and tool-call `context`),
action/tool `id`/`turnId`, action-execution
`id`/`actionDecisionId`/`executedMessageId`/`downgradedFrom`, action/tool
`errorCode`, job `id`/`leaseOwner`, job-attempt
`id`/`jobId`/`workerId`, worker-heartbeat `workerId`/`currentJobId`, and
event-failure `id`/`rawEventId`/`turnId`. Raw filter arguments such as
`--event-id`, `--turn`, `--decision`, `--job`, and `--worker` remain exact local
lookup keys for owner/admin use; do not copy raw platform-like filter values
into shared reports.

Use `supersede-memory` for explicit owner/admin memory review approval. The
command only supersedes the selected old record; it does not merge or rewrite
memory content.

```bash
pnpm cli supersede-memory <old-memory-id> <replacement-memory-id> \
  --review-audit <memory-conflict-or-consolidation-audit-id>
```

Safety checks:

- both records must exist and be `active`;
- both records must have non-secret/non-prohibited sensitivity;
- scope, owner identity fields, subject identity, and kind must match;
- the optional `--review-audit` row must be a memory conflict or consolidation
  audit event that references both memory IDs;
- the old memory receives a `supersede` revision with redacted reason text and
  a redacted `memory.supersede` audit row containing the replacement ID and
  review audit ID. The replacement memory remains active.

Use `disable-memory --decay-review-audit` for explicit owner/admin approval of
a stale low-score decay candidate:

```bash
pnpm cli disable-memory <memory-id> --decay-review-audit <memory-decay-audit-id>
```

Safety checks:

- the memory must exist, be `active`, and have non-secret/non-prohibited
  sensitivity;
- the audit row must be a `memory.decay.candidates_detected` event that
  references the memory ID;
- the memory receives a `disable` revision and a redacted `memory.disable`
  audit row containing the decay review audit ID.

## Configuration

Use environment variables for secrets and deployment-specific values:

- `LETHEBOT_DB_PATH`
- `LETHEBOT_RAW_EVENT_RETENTION_DAYS`
- `LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS`
- `LETHEBOT_AUDIT_LOG_RETENTION_DAYS`
- `LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS`
- `LETHEBOT_EVENT_PROCESSING_FAILURE_RETENTION_DAYS`
- `ONEBOT_TRANSPORT`
- `ONEBOT_WS_URL`
- `ONEBOT_HTTP_URL`
- `ONEBOT_TOKEN`
- `LETHEBOT_BOT_QQ_ID`
- `LETHEBOT_PORT`
- `LETHEBOT_HOST`
- `LETHEBOT_HEALTH_PATH`
- `LETHEBOT_METRICS_PATH`
- `LETHEBOT_EVENT_PATH`
- `PI_PROVIDER`
- `PI_MODEL`
- `PI_BASE_URL`
- `PI_API_KEY`

Do not commit `.env` files, logs, SQLite databases, API keys, or private QQ identifiers.

## Health and Readiness

Run:

```bash
curl http://localhost:6700/healthz
curl http://localhost:6700/readyz
```

Expected healthy response fields:

- `status: "ok"`
- `checks.database.ok: true`
- `checks.database.open: true`
- `checks.adapter.ready: true`
- `checks.adapter.hasToken: true | false`
- `checks.adapter.botIdConfigured: true | false`
- `checks.eventProcessing.pending: <number>`
- `checks.eventProcessing.failures: <number>`

`checks.eventProcessing` is intentionally count-only. It must not expose event
IDs, message IDs, sender IDs, display names, message text, or raw error strings.
The legacy in-memory event-processing failure list used by tests/debug stores
redacted error text only; embedded platform-like identifiers in thrown
Pi/runtime errors are redacted before exposure.
`checks.adapter` is also a bounded status object: it exposes readiness, mode,
WebSocket state/counts where applicable, and boolean token/bot-ID configuration
flags, but not OneBot HTTP/WS URLs, query strings, tokens, or raw adapter
errors.

`/readyz` is a readiness-only endpoint. It returns 200 with `status: "ready"`
only when the database query check and adapter readiness both pass; otherwise it
returns 503 with `status: "not_ready"`. The payload is intentionally compact and
does not include adapter URLs, tokens, DB paths, raw errors, raw event IDs,
message IDs, sender IDs, or message text. `/healthz` follows the same adapter
field boundary while additionally reporting count-only event-processing failure
totals. Degraded `/healthz` states for a stopped adapter or closed database use
bounded booleans/counts and still omit raw adapter errors, DB paths, configured
URLs/tokens, and platform identifiers. The default path can be changed with
`LETHEBOT_READINESS_PATH`.

Known failure modes:

| Symptom | Likely cause | Operator action |
|---|---|---|
| `/healthz` returns 503 / `database.ok=false` | DB missing, locked, corrupt, or wrong `LETHEBOT_DB_PATH` | Check path, file permissions, `PRAGMA integrity_check`, restore from backup if corrupt. |
| `/healthz` returns `adapter.ready=false` | app not fully started, adapter stopped, or WS transport disconnected | Check process logs, SnowLuma status, `ONEBOT_TRANSPORT`, and restart service if needed. |
| `/healthz` shows `eventProcessing.failures>0` | One or more async event handlers failed after the HTTP POST was accepted | Check redacted logs, inspect DB rows for the affected time window on a copy, and reproduce with fake events/tests. |
| `/metrics` returns 503 / `metrics_unavailable` | DB closed, locked, or temporarily unreadable | Check `/healthz`, DB path/permissions, and `PRAGMA integrity_check` on a copy. |
| OneBot event POST returns 401 | `ONEBOT_TOKEN` mismatch or SnowLuma reverse HTTP signature/Bearer mismatch | Align token in SnowLuma and `.env`; retry with Bearer or verify SnowLuma `X-Signature`. |

When metrics collection is unavailable, both `/metrics` and
`/metrics?format=prometheus` return the same bounded JSON error
`{"error":"metrics_unavailable"}` with HTTP 503. The error payload must not
include DB paths, adapter URLs, tokens, raw exception text, or platform IDs.
| Group @bot does not trigger | missing/wrong `LETHEBOT_BOT_QQ_ID` | Set bot QQ id to the actual bot account and restart. |
| `pnpm verify:onebot` fails | SnowLuma / OneBot down, wrong transport/URL/token, network issue | Check `ONEBOT_TRANSPORT`, `ONEBOT_WS_URL`, `ONEBOT_HTTP_URL`, token, and SnowLuma process. |
| FK/check failures after maintenance | manual DB edits or unsafe deletion | Stop service, restore from latest verified backup, rerun tests on a copy. |

`pnpm verify:onebot` and `deployLetheBot({ verifyNapCat: true })` display
redacted operator output. They hide configured token values and replace
secret-like or QQ/platform-ID-like substrings in displayed URLs, OneBot API
messages, status text, and troubleshooting hints. This includes platform
identifiers embedded after non-alphanumeric separators in legacy/free-text
values such as `legacy_qq-...` and `legacy_123456789`. Adjacent
secret/platform fragments such as `sk-...-qq-...` keep both secret and platform
redaction markers in operator output without exposing raw values.
`deploy-napcat` HTTP verification API-error messages and spawned
`verify-napcat` operator output with assignment-shaped adjacent diagnostics such
as `api_key=sk-...-qq-...` likewise keep both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` while omitting raw
fragments. The raw configured URL and token are still used for the local
connection attempt; only console display is redacted.

## Backup and Restore

Use the tested maintenance script for online SQLite backup and integrity-checked restore.

```bash
# Backup current configured DB
pnpm ops:backup -- --db=./data/lethebot.db --out=./backups/lethebot-$(date +%Y%m%d-%H%M%S).db

# Restore to a new path first
pnpm ops:restore -- --backup=./backups/lethebot-20260702-120000.db --db=./data/restore-check.db

# Replace production DB only after checking the restore
pnpm ops:restore -- --backup=./backups/lethebot-20260702-120000.db --db=./data/lethebot.db --overwrite
```

Restore procedure:

1. Stop LetheBot.
2. Copy current DB aside if it exists.
3. Restore backup to a temporary path.
4. Run `sqlite3 <restored.db> "PRAGMA integrity_check;"` and a small read-only smoke check.
5. Restore with `--overwrite` only after the temporary restore is verified.
6. Start LetheBot and check `/healthz`.

Keep off-machine backups encrypted if they leave the host.

## Retention Policy

Retention is explicit and operator-run in R9. `0` means keep forever. The script deletes in FK-safe order and purges only `disabled` / `deleted` memories, never active memory.

```bash
pnpm ops:retention -- \
  --db=./data/lethebot.db \
  --raw-days=30 \
  --chat-days=90 \
  --audit-days=90 \
  --memory-days=365 \
  --event-failure-days=90
```

If CLI flags are omitted, the script uses:

- `LETHEBOT_RAW_EVENT_RETENTION_DAYS`
- `LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS`
- `LETHEBOT_AUDIT_LOG_RETENTION_DAYS`
- `LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS`
- `LETHEBOT_EVENT_PROCESSING_FAILURE_RETENTION_DAYS`

Retention behavior:

- `chat_messages`: delete rows with `timestamp < cutoff`.
- `raw_events`: delete rows with `timestamp < cutoff` only after dependent chat rows are gone and excluding events still referenced by `agent_turns`.
- `audit_log`: delete rows with `timestamp < cutoff`.
- `event_processing_failures`: delete rows with `occurred_at < cutoff`.
- `memory_records`: hard-purge only `state IN ('disabled', 'deleted')` with `updated_at < cutoff`, plus `memory_sources` and `memory_revisions`; rebuild `memory_fts` after purge.

Run backup before retention.

## Metrics and Logging

Get a JSON metrics snapshot:

```bash
curl http://localhost:6700/metrics
pnpm ops:metrics -- --db=./data/lethebot.db
pnpm ops:metrics -- --db=./data/lethebot.db --since=2026-07-01T00:00:00Z
```

Get the same count-only metrics as Prometheus text:

```bash
curl 'http://localhost:6700/metrics?format=prometheus'
pnpm ops:metrics -- --db=./data/lethebot.db --format=prometheus
```

Ops maintenance script errors are display-redacted before they are written to
stderr. Expected CLI failures such as unknown commands, missing required paths,
invalid option-specific retention day values, invalid `--since` values,
invalid `--format` values, invalid worker-soak durations, low-level
backup/restore file errors such as a
missing source database, corrupt source/backup database, existing restore
target, and corrupt retention/metrics database input, unknown options,
unexpected positional arguments, missing option values, empty option values,
and values supplied to boolean flags such as
`--overwrite=<value>` exit non-zero with empty stdout and a concise redacted
error message. The parser accepts both `--name=value` and `--name value` for
value options. `pnpm ops:metrics -- --format=<value>` accepts only `json`
(default) or `prometheus`; invalid values do not silently fall back to JSON.
Secret-like values and QQ/platform-ID-like values embedded in invalid arguments
after non-alphanumeric separators, such as legacy `legacy_qq-...` or
`legacy_123456789` strings, are replaced with redaction markers, and stack
traces/source paths are not printed by the top-level CLI handler. Continue to
use neutral local paths, or `pnpm --silent`, when command-line arguments
themselves might contain private identifiers because package-manager lifecycle
output can appear before the script handles errors.
Assignment-shaped adjacent argument values such as
`api_key=sk-...-qq-...` preserve both `[REDACTED:api_key_assignment]`
and `[REDACTED:platform_id]` in parser errors while omitting raw fragments.

Successful ops JSON output is also display-redacted before stdout serialization.
This affects display fields such as backup/restore paths, worker-soak DB paths,
and operator-provided worker IDs that may contain sensitive substrings. Metrics
JSON also redacts dynamic aggregate object keys derived from database text such
as action type, audit event/risk, job type, and worker type; count collisions
under the same redacted display key are merged. The underlying backup/restore
functions, local worker-soak DB rows, and raw metrics source rows still use the
exact raw local values for filesystem operations and internal local lookup keys,
but printed JSON replaces secret-like values and QQ/platform-ID-like values,
including values embedded after non-alphanumeric separators in legacy/free-text
paths or aggregate keys, with redaction markers. Adjacent secret/platform
fragments such as `sk-...-qq-...` are redacted in a two-pass display order so
both the secret and platform markers remain visible without exposing raw values.
Assignment-shaped adjacent metric aggregate keys such as
`api_key=sk-...-qq-...` preserve both `[REDACTED:api_key_assignment]` and
`[REDACTED:platform_id]` in JSON output while keeping the raw SQLite rows as
internal local metric source data.
Assignment-shaped adjacent display values in ops JSON paths, such as
`api_key=sk-...-qq-...`, likewise keep both assignment-secret and platform
markers without changing the raw local filesystem operation or DB rows.

The HTTP endpoint path defaults to `/metrics` and can be changed with
`LETHEBOT_METRICS_PATH`. It returns the same count-only JSON snapshot shape as
`pnpm ops:metrics`, without job payloads, tool inputs/outputs, raw messages,
adapter tokens, or worker details. JSON aggregate keys derived from dynamic DB
strings are redacted before output. The Prometheus text format uses bounded
labels for known lifecycle/status/type fields and buckets unknown dynamic values
as `other` instead of exposing raw DB strings.

Metrics fields:

- `rawEvents.total`
- `chatMessages.total`
- `agentTurns.total`
- `agentTurns.byStatus`
- `agentTurns.tokensTotal`
- `contextTraces.total`
- `actionDecisions.total`
- `actionDecisions.byDecidedBy`
- `actionDecisions.byRiskLevel`
- `actionDecisions.evaluatorRequired`
- `actionExecutions.total`
- `actionExecutions.byStatus`
- `actionExecutions.byActionType`
- `memoryWrites.total`
- `memoryWrites.byState`
- `policyAuditEvents.total`
- `policyAuditEvents.byCategory`
- `policyAuditEvents.byRiskLevel`
- `policyAuditEvents.byEventType`
- `toolCalls.total`
- `toolCalls.byStatus`
- `toolCalls.secretsRedacted`
- `jobs.total`
- `jobs.byStatus`
- `jobs.byType`
- `jobs.pending`
- `jobs.running`
- `jobs.failed`
- `jobs.expiredRunningLeases`
- `jobAttempts.total`
- `jobAttempts.byStatus`
- `workerHeartbeats.total`
- `workerHeartbeats.byStatus`
- `workerHeartbeats.byWorkerType`
- `eventProcessingFailures.total`
- `eventProcessingFailures.byStage`
- `eventProcessingFailures.byConversationType`

Structured logs should include these operational identifiers when available:

- `conversationId`
- `messageId`
- `eventId`
- `turnId`
- `contextPackId`
- `selectedMemoryIds`
- `toolCallIds`
- `workerJobId`
- `policyDecisionId` / audit event id
- `eventProcessingFailures[]`

Do not log credential values. If a tool output may contain secrets, logs/audit must use redacted summaries.
Runtime structured logs are sanitized through the pino hook before write.
Adjacent secret/platform fragments such as `sk-...-qq-...` and
assignment-shaped fragments such as `api_key=sk-...-qq-...` preserve both
secret/openai-like or assignment markers and platform markers in structured
values, dynamic object keys, `Error.message`, and message strings while hiding
raw values and replacing stack fields with `[REDACTED:stack]`.
`network_request` handler output is prompt/audit-adjacent tool data: response
bodies, response headers, response `statusText`, and thrown network error
messages must be redacted before returning from the handler. Adjacent
secret/platform fragments such as `sk-...-qq-...` must preserve both secret and
platform marker classes in returned output while hiding raw values, including
header assignment forms such as `token=sk-...-qq-...` where assignment redaction
could otherwise swallow the platform marker.
File-operation handler output is also prompt/audit-adjacent: read-file content,
write/delete output paths, list-directory entry names/paths, audit summaries,
validation reasons, and filesystem error messages are redacted before return.
Adjacent secret/platform path or content fragments such as `sk-...-qq-...` must
preserve both marker classes while hiding raw values, including assignment-shaped
filenames such as `token=sk-...-qq-...` and `api_key=sk-...-qq-...`.
Runtime structured logging sanitizes values before write. Secret-like text,
QQ/platform-ID-like strings, numeric platform-ID fields, numeric values in plural
ID arrays such as `senderIds`, `group_ids`, or `platformIds`, prefixed numeric
ID fields such as `targetUserId`, `recipientGroupIds`, or `ownerMessageId`, and
dynamic object keys in diagnostic payloads are redacted before output.
Adjacent secret/platform fragments such as `sk-...-qq-...` preserve both
secret and platform marker classes before write while hiding the raw combined
fragment from structured values, dynamic object keys, `Error.message`, and log
message strings.
Object-key redaction is for display only; durable local lookup keys should
remain in DB/audit rows where those rows are the authoritative evidence.
`Error.message` and `Error.name` are text-redacted, while `Error.stack` is replaced with the bounded marker
`[REDACTED:stack]` instead of printing source paths, `node_modules` frames,
stack frames, or secret/platform-like substrings. Preserve durable failure
evidence through redacted DB/audit rows rather than raw stack dumps in operator
logs.

PiAdapter direct `console.error` failure diagnostics follow the same operator
boundary even though they bypass the pino hook: `runTurn` failures display a
bounded redacted diagnostic string, suppress stack content with
`[REDACTED:stack]`, and return a redacted `PiAdapterOutput.errorMessage`.
Do not reintroduce raw `console.error(..., error)` patterns for runtime errors.

Pi tool-adapter direct `console.warn` / `console.error` diagnostics are also
bounded display data. Missing-handler warnings and conversion-failure errors
redact tool names and exception messages before output, and conversion failures
replace stack content with `[REDACTED:stack]` instead of printing source paths or
frames. Adjacent secret/platform fragments such as `sk-...-qq-...` keep both
secret and platform marker classes in tool-adapter warnings and errors without
displaying raw tool names, raw platform IDs, bare numeric platform-like IDs, or
stack frames. Assignment-shaped adjacent tool names or conversion diagnostics
such as `api_key=sk-...-qq-...` likewise keep both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker evidence
while omitting raw fragments.

The top-level application fatal handler also writes through direct
`console.error`, so it must use `formatFatalErrorForConsole()` rather than
printing raw thrown values. Fatal startup diagnostics keep only bounded redacted
message/name/metadata evidence, redact secret-like and platform-ID-like text,
preserve both marker classes for adjacent secret/platform fragments such as
`sk-...-qq-...` in values and object keys, preserve both the assignment secret
marker and platform marker for assignment-shaped adjacent fragments such as
`api_key=sk-...-qq-...`, and replace stack fields with `[REDACTED:stack]`;
they must not expose raw `Error` objects, source paths, `node_modules` frames,
stack frames, or private QQ-like identifiers. App-level event failure logs use
the same marker-preserving redaction before structured logging and before
failed-turn persistence.

OneBot gateway event-handler failures also have a direct `console.error`
fallback because listener failures can happen before the app-level structured
logger sees the error. That path must print a bounded redacted diagnostic string
instead of a raw or newly-created `Error` object. The emitted `error` event and
readiness `lastError` keep redacted message evidence, while direct console
display suppresses stack content with `[REDACTED:stack]` and avoids source
paths, dependency frames, stack frames, and secret/platform-like fragments.
Assignment-shaped adjacent event-handler diagnostics such as
`api_key=sk-...-qq-...` must preserve both `[REDACTED:api_key_assignment]` and
`[REDACTED:platform_id]` in emitted/readiness/console evidence without exposing
raw fragments.

SQLite verbose SQL diagnostics are another direct-console boundary because
`better-sqlite3` calls the configured `verbose` hook directly. Do not wire it to
raw `console.log`. `initDatabase({ verbose: true })` must route SQL display
through the bounded redaction helper before printing, replacing API-key-like,
secret-assignment, and QQ/platform-ID-like fragments with redaction markers.
Adjacent secret/platform fragments such as `sk-...-qq-...` must preserve both
secret and platform marker classes in verbose SQL output while hiding the raw
combined fragment. Assignment-shaped adjacent SQL values such as
`api_key=sk-...-qq-...` must also retain both
`[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]` marker evidence
without displaying raw fragments.
Verbose SQL is for local debugging only; never copy raw SQL containing private
message text, credentials, or platform identifiers into shared reports.

## Failure Runbook

### Event processing failures

1. Check `/healthz` `checks.eventProcessing.failures`; the health payload is
   count-only and should not reveal private identifiers or raw errors.
2. Use `pnpm cli list-event-failures --include-details` to inspect durable
   hashed diagnostics without raw platform IDs or raw error strings.
3. Check logs for `Failed to handle event` and app `getEventProcessingFailures()` in tests/debug.
4. Confirm `raw_events` has or does not have the event.
5. Run `PRAGMA foreign_key_check;` on a DB copy.
6. Reproduce with `tests/integration/e2e-conversation.test.ts` or a temporary fake event.

### Memory retrieval leak or stale memory

1. Use `pnpm cli why --turn <turn-id>` to inspect selected/rejected memory IDs.
2. Use `pnpm cli list-memory --state active --user <id>` or group/conversation filters.
3. Disable/delete suspect memory through governance CLI.
4. Re-run retrieval test or context explanation before re-enabling.

### Tool/policy/action incident

1. Query `audit_log` by event type/category, `tool_calls` by turn id, and
   `action_decisions` / `action_executions` by the affected turn or decision.
2. Confirm `secrets_redacted=1` when secret-like input/output/error text or
   platform-ID-like payload fields were involved. `ToolCallRepository` applies
   a final durable redaction guard to structured payload keys/values and error
   diagnostics before inserting `tool_calls`; raw `turn_id` and actor lookup
   keys remain exact local query keys.
3. Confirm action decision/execution narrative fields are redacted in storage
   while valid cooldown control keys, targets, and executed message IDs remain
   exact local evidence for debugging cooldown/downstream delivery behavior.
4. Disable the tool or tighten registry/action policy before replaying the turn.

### Database corruption or accidental deletion

1. Stop LetheBot.
2. Copy current DB, WAL, and SHM files aside for analysis.
3. Restore the latest verified backup to a temporary path.
4. Run integrity and FK checks.
5. Replace production DB only after verification.

## Dependency Update Policy

- Treat dependency and lockfile changes as reviewed code.
- Update one dependency group at a time.
- Before update: run `pnpm typecheck && pnpm lint && pnpm test:run` and record baseline.
- After update: run the same gates plus relevant real-provider/live checks only if explicitly configured.
- Do not update Pi SDK, SQLite, or tool/sandbox dependencies together unless the change is specifically a compatibility migration.
- Never commit generated secrets, `.env`, logs, DB files, or root deployment artifacts from tests.

## Lightweight Governance UI Plan

CLI remains sufficient for R9 if operators can inspect, disable, delete, restore, redact display profiles, and explain context. A lightweight UI becomes necessary when:

- non-technical users need self-service memory review;
- memory proposals need batch approval;
- `/why` traces need comparison across turns;
- display identity redaction/unlink workflows become frequent.

P0 UI scope if built later:

- read-only memory list with filters;
- memory detail with source/revision/audit links;
- disable/delete/restore actions through the same governed repository path;
- context explanation view backed by CLI `why` logic;
- display profile/nickname redaction form;
- no raw secret/audit full payload rendering by default.

## Deployment Notes

Start simple:

- One VPS or local machine.
- One SQLite database.
- One bot account.
- One QQ group.

Add Redis, vector services, and split workers only after the simple deployment shows clear pressure.
