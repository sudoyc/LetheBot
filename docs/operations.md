# Operations

The first deployment target is one local machine or small VPS running one Node process, one SQLite database, one bot account, and one QQ group.

## Runtime Processes

Recommended MVP processes:

- `gateway`: SnowLuma / OneBot WS or HTTP event receiving and message routing.
- `api`: internal HTTP server and governance CLI entrypoints.
- `worker`: summarization, extraction, retention, memory conflict scans,
  memory decay review scans, memory consolidation candidate scans, admin
  digests, delayed Attention rechecks, and their scheduler/discovery jobs.
  Backup is an operator-run maintenance command, not a registered background
  handler.
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
- runs at most one invocation of each registered scheduler job name at a time;
  an interval tick is skipped while that same job remains in flight, while
  independently named jobs may still run concurrently;
- extends the active job lease while a durable handler is still running, so a
  second worker cannot reclaim the same job merely because the original handler
  is longer than the initial lease window;
- fences completion, failure, renewal, and automatic-extraction evaluator
  effects to the exact current attempt number, matching worker/lease owner, and
  an unexpired lease. A late heartbeat cannot revive an expired lease, and a
  handler that loses authority returns a failed attempt result instead of
  reporting an uncommitted completion;
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
- executes concrete `summary`, `extraction`, `attention_recheck`, `retention`,
  `admin_digest`, `conflict`, `decay`, and `consolidation` handlers.

The following ActionExecutor routes are separate from timer scheduling:

- accepts approved `propose_memory` actions when an action executor has a
  governed `MemoryRepository` and traceable turn source. The executor creates a
  `proposed` memory through `MemoryRepository.create`, links it to the
  triggering `raw_event`, writes normal memory revision/audit evidence, links
  `action_executions.executed_memory_id`, returns `executed.memoryId`, and
  performs no gateway send. User-scoped proposals respect
  `memory_association=opted_out`: the executor rejects before source lookup or
  memory creation and records only rejected action-execution evidence;
- accepts approved `silent_summarize_later` actions when an action executor has
  a durable `JobRepository`, scheduling a no-send durable `summary` job,
  linking `action_executions.executed_job_id`, and storing only bounded
  provenance, target conversation fields, and a redacted reason summary. Since
  this is durable job scheduling rather than a pure no-op, prohibited or
  evaluator-unapproved decisions are rejected before any job row is created;
- accepts approved `schedule_background_task` actions only for those known
  durable task types when an action executor has a durable `JobRepository`.
  The action executor generates the local idempotency key instead of copying a
  model-supplied key, stores redacted worker-consumable task fields plus
  bounded audit provenance and `taskPayload`, links
  `action_executions.executed_job_id`, and performs no gateway send.

The durable worker and scheduler also:

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
  errors, or credential-like values. Digest sample identifiers and classifier
  fields such as job type, action type, tool name, and audit event type are
  display/evidence-redacted before returning worker output or writing the
  generated digest audit details, while raw source rows remain local DB evidence;
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

- summary, extraction, delayed-Attention recheck, retention, admin-digest,
  conflict, decay, and consolidation handlers are wired.
  Conflict/decay/consolidation workers remain review/audit-only and never
  mutate memory automatically; owner/admin review can explicitly approve a safe
  supersede through governance CLI for conflict or consolidation audit rows.
- the worker runs in-process for the local profile and is not a separate worker
  service yet;
- real SnowLuma/QQ acceptance is still manual/opt-in.

### Delayed Attention runtime and evidence

An unmentioned QQ group question is persisted but does not immediately call Pi
or send a message. After raw-event admission, the derived chat row,
source-bound `attention_candidates` row, and scheduled `attention_recheck` job
are committed in one `IMMEDIATE` transaction. A failure in candidate/job
creation rolls back all three derived writes while leaving the raw event and
failed admission evidence available for recovery diagnosis.

The candidate uses local ingress time (`raw_events.created_at`, matched by the
accepted admission/receipt time) as the policy clock. Its job has the exact
payload `{ candidateId }`, becomes claimable at ingress plus 15 seconds, and is
bound to the source raw event, chat row, exact conversation, and exact group.
The handler reconstructs and revalidates the stored event instead of copying
message text into the job payload. A malformed payload, mismatched source/job,
or missing durable execution context fails closed.

At recheck, the active job attempt lease fences the single terminal decision.
The policy applies these suppressors in order: `thread_expired` at 120 seconds,
an explicit later human reply to the source message, more than five human
messages in the exact group during ten seconds, and an already-reserved budget
of two responses in that group during ten minutes. Otherwise it records a
`respond` decision, which reserves the group budget, and re-enters the normal
turn/action path with `proactive=true` and a `delayed_recheck` trigger marker.
Suppression completes the job without Pi or a gateway send. Candidate,
decision, suppressor, job, and job-attempt IDs provide bounded terminal
evidence; raw message content remains in its source rows.

Decision replay is idempotent. A retry after a completed turn or a recorded
message action reuses that terminal evidence instead of creating another turn
or send. An indeterminate prior turn/delivery state fails closed. This is local
duplicate suppression, not an external exactly-once guarantee: SQLite and the
QQ/OneBot send are not one transaction, so a process loss after remote
acceptance but before local execution evidence can still leave an ambiguous
delivery. Do not claim external exactly-once delivery from a completed job.

### Draining before rollback

An older worker that does not recognize `attention_recheck` must never be
started while this release can still enqueue that type. Before a rollback,
quiesce OneBot ingress upstream while leaving the current v5 process and its
in-process worker running, then wait for both views to become empty:

```bash
pnpm cli list-jobs --type attention_recheck --status pending
pnpm cli list-jobs --type attention_recheck --status running
```

Allow for the 15-second due time and configured retry backoff; inspect terminal
failed jobs and their attempts instead of rewriting them. Once no pending or
running rechecks remain, take a verified backup and stop the current process.
During an unconfirmed managed v4-to-v5 activation, normal activation recovery
restores the pre-upgrade v4 snapshot before restarting v4. After v5 has been
confirmed, there is no in-place schema downgrade: restoring a reviewed pre-v5
backup under the stopped-service procedure is required, and it discards all
later database writes. Prefer a forward fix when those writes must be retained.
Never point a v4 release at the v5 database or delete candidate/job rows to make
an old worker appear compatible.

### Group summary policy and v6 rollback

Schema v6 keeps group summaries default-off. Each actual enable/disable
transition advances the policy generation and writes one redacted audit event.
Enable establishes an exclusive monotonic local eligibility epoch above the
requested clock, prior policy timestamp, every persisted exact-group chat
ingress, and every normalized exact-group QQ raw ingress still awaiting a
`chat_messages` row. Discovery and source loading use `raw_events.created_at`,
so messages from an earlier generation, pending normalization, or a disabled
interval cannot be backfilled. Disable advances its transition time beyond the
created/updated timestamps of bound pending jobs when representable, saturates
at `Number.MAX_SAFE_INTEGER`, and atomically fails the jobs with
`group_summary_policy_disabled`; this remains valid if the wall clock rolls
back. A running job is stopped by its next policy/lease fence and terminalizes
without retry; a Provider call already in flight may leave completed invocation
evidence but cannot commit summary memory.

QQ and CLI policy audits redact platform/secret-shaped group and source display
values. Use the purpose-bound SHA-256 `groupIdHash` for correlation across
`group.summary_policy_changed` rows; do not query or publish the redacted
`details.groupId` as an exact scope key.

Before rolling a v6 deployment back to v5, first stop new summary discovery and
action enqueue, then let or terminalize all pending/running group summary jobs
under the v6 process. Stop the process and restore the verified pre-v6 SQLite
snapshot before starting v5 code. There is no in-place schema downgrade, and v5
must never be pointed at a database containing the v6 policy/binding tables.
Restoring the snapshot intentionally discards later policy, job, and memory
writes; use a forward fix when those writes must be retained. The schema-v6
rehearsal covers populated online backup/restore and a v5-to-v6-to-v5 snapshot
rollback with clean integrity and foreign keys.

### Opt-in local scheduler soak

Use the opt-in worker soak command to exercise the durable
`JobRepository -> BackgroundWorker -> WorkerScheduler` path with real timers
before a longer local run. The synthetic soak covers every currently registered
general-purpose background task type: `summary`, `extraction`, `retention`,
`admin_digest`, `conflict`, `decay`, and `consolidation`. It deliberately does
not fabricate an `attention_recheck`, because that handler requires a real
source-bound candidate and exact job payload; exercise that path with the
focused delayed-Attention and `REL-ATT-02` tests on a migrated disposable DB.

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

Use a disposable DB whose `jobs`, `job_attempts`, and `worker_heartbeats` tables
are all empty. The command checks this before its first write and fails closed
rather than claiming unrelated ready work. Do not point it at a production DB.
The output
is aggregate-only: job status/type counts, attempt status counts, idle heartbeat
state, lease-extension observation counts, tick/processed counts, sustained-load
window counts, bounded-drain status, and FK-clean status. The initial batch still
covers all seven task types. A separately scheduled producer then enqueues one
unique retention job per interval throughout the timed phase, including while a
consumer handler is in flight. The synthetic summary job waits for at least one
active-lease extension before completing, so the soak proves the real timer path
exercises durable lease heartbeats rather than only short handlers. It
intentionally omits job payloads, attempt result/error text, worker details, and
secret-like values. When the requested duration ends, the soak stops both
scheduler jobs, drains their last in-flight handlers, and drains tracked pending
jobs with both an attempt cap and a short wall-clock deadline before reading
aggregate rows or closing SQLite. Individual calls are additionally bounded by
the synthetic handlers' own deadlines.
Successful worker-soak JSON display is redacted like other ops JSON output, so
secret-like or QQ/platform-ID-like values embedded in an explicit `--db` path or
operator-provided `--worker-id` do not appear in stdout. The local DB and worker
rows still use the raw operator-provided values as internal local keys. The
soak command suppresses scheduler info/debug logs on this synthetic path so
stdout remains machine-readable JSON even when the default runtime log level is
not overridden.

Expected healthy evidence:

- `success: true`
- `load.windows: 3`, with every `enqueuedByWindow` and `completedByWindow`
  value at least 1
- `load.lastEnqueueOffsetMs >= durationMs - 2 * intervalMs`
- `load.emptyPolls: 0`
- `drain.timedOut: false`
- `schedulerErrors.total: 0`
- `isolation.clean: true`
- `jobs.total == jobs.completed == 7 + load.enqueued`, with no pending,
  running, or failed jobs
- `jobAttempts.total == jobs.total + 1`
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
pnpm acceptance:db-summary -- --db=./data/lethebot.db --require-acceptance-hints
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
```

Use non-sensitive evidence file names. The evidence script redacts paths in its
own JSON output and errors, but the package manager can echo raw script
arguments before the script runs. If a local path or argument might contain a
token, cookie, QQ ID, group ID, username, or other private identifier, rename it
to a neutral `/tmp` path before invoking the package script, or run with
`pnpm --silent`, for example:

```bash
pnpm --silent acceptance:evidence-template -- --out=/tmp/lethebot-acceptance-evidence.md
pnpm --silent acceptance:db-summary -- --db=./data/lethebot.db --require-acceptance-hints
pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
```

Do not copy non-silent package-manager lifecycle output into evidence files when
command arguments contain sensitive values. The validator reports a redacted
path, status/count fields, and static finding line/rule/message fields; it must
not echo matched secret-like values or raw message text.

`pnpm acceptance:db-summary -- --db=<path>` opens the SQLite database read-only
and prints aggregate-only acceptance evidence including generation time, a
redacted DB path, integrity/FK status, raw-event/chat/context/turn/action counts,
memory record/source/revision and selected governed-memory counts,
tool/reviewed-tool counts, failure/audit counts, detailed acceptance-flow counts,
and boolean evidence hints. It redacts the displayed DB path and does not print row
IDs, platform IDs, message text, memory content, tool input/output payloads,
tool error diagnostics, audit details, or DB row contents.
For final acceptance evidence, add `--require-acceptance-hints`; that mode exits
non-zero unless the aggregate hints show clean integrity/FKs plus separate
private and group flow evidence: chat row, context trace, completed turn, and
successful action for each path, with the context trace and successful action
linked to the same completed turn through the turn's selected durable
`context_pack_id` / `action_decision_id` rows for each path and that turn
source-linked to the same path's normalized chat row and `chat.message.received`
gateway QQ raw event, with a delivered reply action (`reply_short`,
`reply_full`, `reply_with_tool`, or `ask_clarification`) carrying an
`executed_message_id` that is persisted as a same-path `bot.response` /
`bot-self` chat row. Downgraded `send_folded_forward` text fallback is not
counted as delivered-reply success for complete acceptance because real folded
forward node delivery is not implemented. Downgraded `react_only` face/text
fallback is also not counted as delivered-reply success for complete acceptance:
it may be persisted as same-path `bot.response` traceability evidence when a
fallback message is actually sent, but it remains reaction fallback evidence,
not proof of the required private/group reply loop. Group completion requires
two distinct completed turns and internally consistent delivered-reply chains
with gateway-normalized `qq-group-<5-12 digits>` scope. One triggering normalized chat row
must carry `mentions_bot=1` for an exact bot mention. The other must be an
inbound reply to a stored bot response with quote metadata, `mentions_bot=0`, a
non-empty `reply_to_message_id` resolving to a same-group `bot-self` message
backed by a distinct `bot.response` raw event, and an action-decision reasons
JSON array containing the exact `reply_to_bot` reason. Its successful action
must link another separately persisted same-group bot response, with
nondecreasing durable times from quoted response to inbound event, action
execution, and new response. Each trigger,
context trace, and bot-response row must preserve its chain's group ID; the exact
mention turn cannot also count as the reply-to-bot proof. The manual live sequence
must use one target group; the aggregate helper compares the two chains' normalized
group/conversation identity without printing either identifier.

Required hints also demand non-empty, non-placeholder `pi_provider` and
`pi_model` identities for the private targeted, group exact-mention, and group
reply-to-bot turns. Values beginning with `mock`, `test`, `stub`, or `fake` do
not count. At least one completed non-mock delivered turn must include a
Pi-requested successful tool call linked to an approving, non-prohibited tool
evaluator decision and one completed non-placeholder evaluator invocation,
matching request/domain/turn, ordered sources, provider/model/prompt version,
turn/tool/actor/context and trigger source, plus a matching `tool.executed`
   audit. Invocation, evaluator, tool/audit, action, bot-response, and turn
   timestamps must form the runtime order. Complete acceptance
   also requires memory governance rows and at least one complete acceptance flow
   whose selected `context_pack_id` context references an active,
   source/revision-linked, non-secret/prohibited governed memory with at least one
   usable durable source evidence row, visible in that same private/group flow
   context, and scoped to that same sender, group, conversation, or public/system
   boundary. The record and latest governing revision must predate actual context
   creation, expiry must be later than context creation, and durable chronology must
   satisfy turn start <= context creation <= action decision <= action execution <=
   turn completion. Source timestamps and canonical chat/tool evidence must be no
   later than record creation and the governing revision, and must predate the
   selected context; post-hoc provenance does not count. For
   `resolution_state='internal'`, usable provenance is resolved only
through the source-type-specific canonical column: `raw_event_id`,
`chat_message_id`, successful `tool_call_id`, or exactly one completed
extraction `job_id` / `job_attempt_id`. A worker row counts only when the same
memory also has a separate internal canonical raw/chat source row and the
completed job payload/result references that exact evidence. Historical
`legacy_unresolved` rows use bounded compatibility lookup by
`source_type` / `source_id`; `external` rows do not prove inbound QQ evidence.
Inbound raw/chat evidence must resolve to an inbound QQ
`chat.message.received` raw event and non-bot chat row and remain compatible
with the selected memory boundary: user-scoped memory sources must come from the
same canonical owner, group-scoped sources must match the memory
group/conversation, and conversation-scoped sources must match the memory
conversation. Orphan source IDs, `user_command`-only source links,
bot-response chat rows, another user's chat/tool source for user memory,
completed worker rows without compatible chat/raw provenance, and rejected/error
tool-call rows do not satisfy complete memory-governance DB hints.

Provider/model strings remain declared local identities rather than
cryptographic remote attestation. The linked terminal invocation proves the
runtime recorded a Provider call; the opt-in real-API test supplies network-level
proof. The offline summary also cannot verify the
process-local action `execution_binding` HMAC; live execution plus both evidence
validators remains required.

The evidence CLI rejects malformed arguments explicitly: `--out` / `--out=` and
`--validate` / `--validate=` without a following file path fail, unknown options
fail, and bare positional arguments in template mode fail. Use either
`--out=/tmp/lethebot-acceptance-evidence.md` or
`--out /tmp/lethebot-acceptance-evidence.md`; parser errors are redacted by the
script before display.

Use `--require-complete` only after filling an actual manual acceptance record.
Default validation remains a share-safety/redaction check, so an empty template
can be validator-clean for sharing. The opt-in complete check requires the core
health, OneBot, private chat, group exact-@bot, same-group reply-to-bot without a
mention, memory/privacy, FK, and final accepted checklist evidence to be checked
and rejects checked placeholder values,
conflicting final decisions, and checked failed/degraded status values. Completed
acceptance rejects the checked `mock` provider and the fixed-mock
`docker-compose.local-acceptance.yml`; select the Framework compose target and
explicit real-provider credential injection. It also requires checked evidence
that all three required flows have non-placeholder Pi identities and that one
accepted turn contains the reviewed successful Pi tool chain described above.
Completed
acceptance must record healthy `/healthz`, ready `/readyz`, a completed private
turn, two distinct completed same-group mention/reply-to-bot turns, and
successful action executions for each chain; a checked
`failed`/`rejected`/`degraded`/`not_ready` line is still incomplete evidence.
Memory/privacy completion evidence must also show a governed-memory effect on an
allowed follow-up answer, conservative source-linked handling for group-derived
user memory, lifecycle/sensitivity exclusions from ordinary context, and
redacted governance CLI inspection. Do not mark live acceptance complete with
chat send evidence alone.

`--require-complete` is a Markdown attestation/shape validator. It does not
execute the checked commands, query or cross-bind the acceptance database,
contact a provider/OneBot/QQ, authenticate operator claims, or verify the
process-local `execution_binding` HMAC. The operator must run and corroborate the
documented commands and DB summary separately.

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
pnpm cli delete-memory <memory-id>
pnpm cli memory-summary status --group qq-group-<5-12-digit-id>
pnpm cli memory-summary enable --group qq-group-<5-12-digit-id>
pnpm cli memory-summary disable --group qq-group-<5-12-digit-id>
pnpm cli why --turn <turn-id>
pnpm cli why --conversation <conversation-id> --type private
pnpm cli list-privacy-preferences --type proactive_dm --state opted_out
pnpm cli set-privacy-opt-out <canonical-user-id> proactive_dm --reason <reason>
pnpm cli clear-privacy-opt-out <canonical-user-id> proactive_dm --reason <reason>
pnpm cli unlink-platform-account qq <platform-account-id>
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
pnpm cli summarize-governance-health --compact
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
verifies the intended DB is not mutated. Parser, validation, and caught-error
messages are control-stripped, whitespace-collapsed to one line, redacted, and
capped at 2,048 characters including the human-readable error prefix.

`memory-summary --group` accepts only
`qq-group-[1-9][0-9]{4,11}`. Invalid/non-canonical group scope fails before
mutation, and successful output reports only state, change status, and
canceled-job count. It does not echo the group ID, generation, eligibility
epoch, policy audit ID, or raw policy object.

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

`unlink-platform-account` accepts the raw platform account ID only as a local
exact lookup key. Successful output and durable summary/details omit the raw
account ID, the active-to-disabled update and audit insert are atomic, and
unknown/already inactive rows fail without mutation. Stop or drain the service
before unlink when the operator also requires cancellation of already-running
turns; ordinary unlink guarantees denial for identity resolution beginning
after the transaction commits.

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

`delete-memory` treats its argument as an exact local lookup key only. Human
output and durable audit summary/details show the ID only when it is bounded,
grammar-safe, and free of secret/platform-shaped text; otherwise they use
`[redacted-id]`. The delete decision stored in the lifecycle snapshot uses a
purpose-bound SHA-256 digest, not the raw ID. This prevents long,
control-bearing, or platform-like identifiers from expanding CLI or audit
bodies while retaining the exact audit `event_id` for local lookup.

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
Use `summarize-governance-health --compact` for quick operator triage. Compact
output intentionally omits dynamic aggregate keys and row-level classifiers; it
includes only overall status, attention counters, coarse table totals, and
latest failure/heartbeat timestamps. It does not include payloads, memory
contents, tool input/output, job payload/result, heartbeat details, audit
summaries/details, event-failure details, action payloads, raw IDs, or stored
dynamic strings.
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
recent-message IDs. When durable `tool_calls` rows are linked to the turn, `why`
also prints redacted tool-call summaries with ID, tool name, status,
`requested_by`, duration, error code, and bounded error message. It must not
print tool input/output payloads, raw failed-turn runtime response text, raw
event/chat text, or platform identifiers. Running `why` without `--turn`
resolves the latest agent turn and uses the same linked tool-call summary path
for that resolved turn, without pulling tool calls from older turns. `why --turn`
and `why --conversation` are mutually exclusive; supplying
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
also redacts platform-like `executedMessageId`, `executedMemoryId`, and
`executedJobId` values before display. Legacy or dirty-DB action-execution classification fields such as `status` and
`audit_level` are treated as display strings and redacted before JSON output,
even though current valid filters remain finite enums. Free-text
diagnostic fields such as action-execution `downgradedFrom` / `errorCode` and
tool-call `errorCode` are display-redacted like error messages, because legacy
or adapter-provided diagnostic codes can contain secret-like or platform-like
substrings. `dm_user` execution audit evidence also records bounded proactive
metadata (`dm_proactive`, trigger, opt-out status, redaction level, and
cooldown key) for success, rejection, and failure paths; free-text reasons and
cooldown keys are redacted before persistence. `dm_user.target.userId` is the
gateway delivery user ID, while proactive opt-out enforcement uses
`dm_user.target.canonicalUserId`; proactive DMs missing that canonical target
are rejected before privacy lookup or gateway send. Action-executor reply and
`dm_user` send failures are redacted before the execution result is returned and
before `action_executions.error_message` is persisted; this includes
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
`id`/`actionDecisionId`/`executedMessageId`/`executedJobId`/`downgradedFrom`, action/tool
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
- `LETHEBOT_READINESS_PATH`
- `LETHEBOT_METRICS_PATH`
- `LETHEBOT_EVENT_PATH`
- `PI_PROVIDER`
- `PI_MODEL`
- `PI_BASE_URL`
- `PI_API_KEY`
- `PI_TURN_TIMEOUT_MS`
- `EVALUATOR_PROVIDER`
- `EVALUATOR_MODEL`
- `EVALUATOR_BASE_URL`
- `EVALUATOR_API_KEY`
- `EVALUATOR_TIMEOUT_MS`
- `EVALUATOR_MAX_RETRIES`
- `EVALUATOR_TEMPERATURE`
- `EVALUATOR_PROMPT_VERSION`

Do not commit `.env` files, logs, SQLite databases, API keys, or private QQ identifiers.

`PI_TURN_TIMEOUT_MS` is the cooperative production `runTurn()` deadline in
integer milliseconds. It defaults to `120000`; startup rejects values outside
`1..2147483647`. Expiry asks Pi to abort and waits for the run to settle before
the turn is failed. It does not force-stop providers or in-process tools that
ignore cancellation.

The non-test social/tool evaluator uses a stateless structured model request.
When `EVALUATOR_PROVIDER` and `EVALUATOR_MODEL` are both unset, it inherits the
complete Pi provider/model/base/key identity. Setting either identity field
requires both; that separate identity does not inherit the Pi endpoint or key.
`EVALUATOR_TIMEOUT_MS` defaults to `30000` and accepts `1..2147483647`;
`EVALUATOR_MAX_RETRIES` defaults to `1` and accepts `0..10`; temperature defaults
to `0` and accepts `0..1`. Missing non-mock credentials, invalid configuration,
provider failure, timeout, malformed JSON, wrong-domain output, extra spoofed
metadata, or oversized output fails closed and never falls back to the stub.
`LETHEBOT_TEST=true` or an explicit evaluator identity of
`EVALUATOR_PROVIDER=mock` plus `EVALUATOR_MODEL=mock` selects the rule-driven
stub and performs no evaluator provider call.

This configured evaluator reaches social decisions, evaluator-required Pi
tools, and automatic background memory extraction. Extraction persists the
structured decision under the exact current job attempt and commits it with the
governed memory or rejection audit in one transaction. Every non-mock evaluator
call first writes a source-bound `model_invocations` row and terminalizes it as
completed, failed, or aborted without storing prompt/response content. Successful
structured results are accepted only when the tool/social/memory writer can link
the exact completed invocation through
`evaluator_decisions.model_invocation_id`. A non-mock evaluator-version string,
an unlinked invocation, or a non-completed invocation is not reviewed-action
evidence.

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
The checked-in LetheBot Compose healthchecks require a successful `/healthz`
HTTP status; a reachable 503 is unhealthy, not a successful liveness probe.
Before a SnowLuma account session starts OneBot, this accurately reports the
container as `unhealthy` while the process may still be running and serving
bounded degraded health and metrics responses.

Known failure modes:

| Symptom | Likely cause | Operator action |
|---|---|---|
| `/healthz` returns 503 / `database.ok=false` | DB missing, locked, corrupt, or wrong `LETHEBOT_DB_PATH` | Check path, file permissions, `PRAGMA integrity_check`, restore from backup if corrupt. |
| `/healthz` returns `adapter.ready=false` | app not fully started, adapter stopped, or WS transport disconnected | Check process logs, SnowLuma status, `ONEBOT_TRANSPORT`, and restart service if needed. |
| `/healthz` shows `eventProcessing.failures>0` | One or more async event handlers failed after the HTTP POST was accepted | Check redacted logs, inspect DB rows for the affected time window on a copy, and reproduce with fake events/tests. |
| `/metrics` returns 503 / `metrics_unavailable` | DB closed, locked, or temporarily unreadable | Check `/healthz`, DB path/permissions, and `PRAGMA integrity_check` on a copy. |
| OneBot event POST returns 401 | `ONEBOT_TOKEN` mismatch or SnowLuma reverse HTTP signature/Bearer mismatch | Align token in SnowLuma and `.env`; retry with Bearer or verify SnowLuma `X-Signature`. |
| OneBot event POST returns 503 / `event_unavailable` | Ingress admission is not open yet, is closed during shutdown, or the atomic canonical raw-event/receipt claim failed | If the service is starting or stopping, retry only after readiness is healthy. Otherwise check redacted logs and database health, correct the local fault, then retry. A closed-ingress request is never claimed; a failed claim leaves no partial raw event or receipt. |
| Group @bot does not trigger | missing/wrong `LETHEBOT_BOT_QQ_ID` | Set bot QQ id to the actual bot account and restart. |
| `pnpm verify:onebot` fails | SnowLuma / OneBot down, wrong transport/URL/token, network issue | Check `ONEBOT_TRANSPORT`, `ONEBOT_WS_URL`, `ONEBOT_HTTP_URL`, token, and SnowLuma process. |
| FK/check failures after maintenance | manual DB edits or unsafe deletion | Stop service, restore from latest verified backup, rerun tests on a copy. |

When metrics collection is unavailable, both `/metrics` and
`/metrics?format=prometheus` return the same bounded JSON error
`{"error":"metrics_unavailable"}` with HTTP 503. The error payload must not
include DB paths, adapter URLs, tokens, raw exception text, or platform IDs.

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

Writable database initialization on POSIX creates the main SQLite file with mode
`0600` before opening it, resolves symlinked database paths, and remediates the
real main file plus existing `-wal` / `-shm` sidecars to `0600`. SQLite creates
later sidecars from that private main-file mode. Initialization fails closed if
the mode cannot be enforced and does not change the process-global umask.
Readonly opens, including `ops:doctor`, do not create or chmod database files.
On Windows, enforce an equivalent restrictive ACL on the data directory and
files.

Container file mode and ownership are separate boundaries. LetheBot images run
as non-root `node` by default, and Compose maps a selected numeric
`LETHEBOT_UID` / `LETHEBOT_GID`. The bind directory and existing database,
`-wal`, and `-shm` files must be owned by that identity; `0600` root-owned files
cannot be repaired by a non-root process. Migrate ownership only while LetheBot
is stopped, target only the LetheBot database files, and keep their mode at
`0600`. Never resolve this by using `chmod 666` or recursively changing a
directory that also contains SnowLuma state.
The checked local stacks bind only `./data/lethebot` into the application and
bind management/API ports to `127.0.0.1`; SnowLuma config, QQ state, and logs
must not be mounted into LetheBot merely because both services use UID 1000.
Before upgrading an older Compose or generated deployment that mounted the
parent `./data`, stop LetheBot and move the exact SQLite main/WAL/SHM set using
the verified backup and rollback procedure in
[Local Container Acceptance](local-container-acceptance.md#from-old-parent-bind-to-dedicated-lethebot-bind).
Creating the new directory and starting first can silently select a new empty
database; never recursively change ownership of a parent shared with SnowLuma.

Startup treats `schema_version` and the migration-derived structure as
fail-closed compatibility boundaries. The release requires the contiguous
`001` through `006` migration set, targets schema v6, and reads only v1 through
v6. Malformed/noncontiguous metadata or a version above 6 is rejected before
any migration schema/data write. For a missing or valid-empty ledger, v1
compatibility patches and migrations v2-v6 run in one `IMMEDIATE` transaction;
each version is recorded only after the result matches its migration-derived
table, column/type/nullability/default/primary-key, foreign-key,
required-index, supported CHECK, virtual-table, and migration-owned trigger
contract and `PRAGMA foreign_key_check` is clean. A same-named but incompatible
legacy object therefore aborts and rolls back every patch and DDL change
instead of being stamped current. Existing v1-v6 metadata is idempotent, keeps
its original timestamps, and receives the same structural validation. Three exact
early-v1 memory CHECK shapes are upgraded transactionally: the runner rebuilds
`memory_records`, `memory_revisions`, and/or `memory_sources` from the current
migration definition, preserves rowids, rows, indexes, and triggers, then
requires the full structure and FK data to validate before commit. Foreign-key
enforcement is disabled only on that migration connection for the rebuild
transaction and is restored afterward; `foreign_key_check` remains the commit
gate. Any other constraint drift fails closed. Do not delete or rewrite version
rows to force an older release to start; keep the service stopped and use a
compatible release or the verified stopped-service restore procedure.

## Backup and Restore

Use the tested maintenance script for online SQLite backup and an atomic,
integrity- and foreign-key-checked restore.

```bash
# Backup current configured DB
pnpm ops:backup -- --db=./data/lethebot.db --out=./backups/lethebot-$(date +%Y%m%d-%H%M%S).db

# Restore to a new path first
pnpm ops:restore -- --backup=./backups/lethebot-20260702-120000.db --db=./data/restore-check.db

# Replace production DB only after checking the restore
pnpm ops:restore -- --backup=./backups/lethebot-20260702-120000.db --db=./data/lethebot.db --overwrite
```

Backup writes and validates a private same-directory candidate, then publishes
it without replacing any existing destination entry. Choose a new output path;
an existing file, symlink, or other directory entry is preserved and the command
fails. On POSIX hosts, a successful backup is forced to mode `0600` before
integrity verification and success reporting. A non-`ok` integrity result
removes the staged candidate, publishes no destination, and fails the command.
Restore copies into the private
staging directory, forces the candidate database to `0600`, and only then validates and
publishes that inode, so a permissive backup mode is not inherited by the
restored database. Keep backup directories private as well. On Windows, use a
restrictive directory/file ACL because Unix mode bits do not express the full
access-control policy.

Restore copies the backup into a unique private staging directory beside the
target, then validates `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.
Without `--overwrite`, it publishes the validated inode with an atomic
same-filesystem no-clobber link, so a target entry created during validation is
preserved and the command fails. Explicit `--overwrite` instead publishes with
one replacing rename after the same validation and sidecar checks. A copy,
validation, or publication failure removes the staged candidate. The command
rejects backup/target aliases and refuses to proceed while target `-wal` or
`-shm` sidecars exist. It does not make a safety backup automatically.
This is atomic file publication for a stopped service, not safe replacement of
a live SQLite handle and not a power-loss durability guarantee.

Restore procedure:

1. Stop LetheBot.
2. Copy current DB aside if it exists.
3. Restore backup to a temporary path.
4. Run integrity and foreign-key checks plus a small read-only smoke check.
5. Restore with `--overwrite` only after the temporary restore is verified.
6. Start LetheBot and check `/healthz`.

Keep off-machine backups encrypted if they leave the host.

## Retention Policy

Retention is explicit and operator-run. `0` means keep forever. The script
deletes in provenance- and FK-safe order and purges only `disabled` / `deleted`
memories, never active memory.

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

- `memory_records`: first hard-purge only `state IN ('disabled', 'deleted')` with `updated_at < cutoff`, plus `memory_sources` and `memory_revisions`; rebuild `memory_fts` after purge.
- `chat_messages`: delete rows with `timestamp < cutoff` unless a remaining `internal` memory source pins the row through `chat_message_id` / `raw_event_id`, a `legacy_unresolved` source matches a historical chat/raw alias, a pending/running extraction job names its canonical row in a valid reference-only payload, or the row is the source of a pending/running delayed-Attention candidate. `external` rows do not pin chat evidence. Completed/failed jobs do not pin the row; malformed extraction payloads do not abort retention.
- `model_invocation_sources`: immediately before raw-event deletion, remove source links whose raw events satisfy the same raw retention predicate. The result reports the number as `modelInvocationSourcesDeleted`; completed invocation and model-context metadata remain available without retaining expired chat evidence.
- `raw_events`: delete rows with `timestamp < cutoff` only after dependent chat rows are gone and excluding events still referenced by `agent_turns`, an `internal` memory source's `raw_event_id`, a matching `legacy_unresolved` raw-event alias, `accepted`/`processing` event admissions, or a pending/running delayed-Attention candidate. `external` rows do not pin raw evidence.
- `event_ingress_receipts`: deleted only by `ON DELETE CASCADE` when their canonical raw event is deleted.
- `event_processing_admissions`: `accepted` and `processing` rows pin the canonical raw event; terminal `completed`, `failed`, and `interrupted_review` rows do not pin indefinitely and cascade when that raw event becomes eligible.
- `audit_log`: delete rows with `timestamp < cutoff`.
- `event_processing_failures`: delete rows with `occurred_at < cutoff`.

A retained memory deliberately pins the inbound chat/raw evidence needed to
audit its provenance, even when that evidence is older than the raw/chat cutoff.
Disable/delete and purge the memory before expecting its pinned source rows to
expire. Because memory purge runs before chat/raw retention, newly unpinned
eligible evidence may be deleted later in the same retention transaction.

Pending/running `attention_recheck` jobs similarly pin their exact candidate
source rows so the handler can reconstruct the event. Once the job is
`completed` or `failed`, that retention pin is released. If the terminal source
then expires, source deletion cascades its candidate/decision/suppressor policy
rows while the already-terminal `jobs` and `job_attempts` evidence remains.

When a purged memory was created by an action execution, retention preserves the
immutable execution row but clears its `executed_memory_id` lookup link before
deleting the memory. The retention result reports this as
`actionMemoryLinksCleared`; remaining action audit fields stay intact.

Ingress deduplication lasts for the actual lifetime of the canonical
`raw_events` row. Duplicate receipts do not refresh the canonical event
timestamp used by retention. Chat rows, memory sources, and agent turns can pin
the raw row beyond `--raw-days`, so the configured raw cutoff is not a fixed
dedupe TTL. When an unpinned canonical raw row is deleted, its receipts cascade
and the unique claim key is released; a later replay can be accepted and run
downstream again. Permanent idempotency would require retaining the canonical
row or a separately retained dedupe tombstone.

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

Both formats expose aggregate ingress receipt dispositions and event-admission
lifecycle states. They do not expose admission/raw-event IDs or stored payloads.

Run a local read-only database/configuration preflight:

```bash
pnpm ops:doctor -- --db=./data/lethebot.db
```

`ops:doctor` opens the SQLite database read-only, runs
`PRAGMA integrity_check`, counts `PRAGMA foreign_key_check` violations, verifies
that the expected migrated tables including the admission ledger exist, reports fixed-key row counts for core
tables, and reports only configuration booleans such as whether OneBot token,
bot ID, URLs, and server paths are configured. It does not contact
SnowLuma/QQ/OneBot, does not call model providers, does not read local secret
files, and does not print configured URLs, tokens, bot IDs, DB row payloads, raw
message text, audit details, tool input/output, job payloads/results, or worker
details. Output paths and other display strings are passed through the same ops
redaction boundary as backup/restore/metrics/worker-soak JSON output.

Run a disposable maintenance rehearsal before handoff or after changing
maintenance code:

```bash
pnpm ops:rehearse-maintenance
```

By default this creates a migrated SQLite database under `/tmp`, seeds only
synthetic non-secret rows, backs it up, restores it to a second disposable DB,
runs read-only `ops:doctor` evidence before and after retention, applies a
30-day retention policy to the restored copy, and prints aggregate-only JSON:
backup/restore integrity, doctor overall/schema/FK status, fixed table counts,
and retention deletion counts. It does not contact SnowLuma/QQ/OneBot, does not
call model providers, and does not read local secret files. Do not point it at
a production DB; it refuses to reuse an existing `--db` path and intentionally
writes synthetic source/backup/restore rows.

To inspect the generated SQLite files while still using a disposable path:

```bash
pnpm ops:rehearse-maintenance -- --db=/tmp/lethebot-maintenance-rehearsal.db
```

Successful rehearsal JSON display is redacted like other ops output, so
secret-like or QQ/platform-ID-like fragments in explicit paths are not printed.
The command is deterministic local evidence for backup/restore/retention/doctor
plumbing; it is not live SnowLuma/QQ acceptance and not a production install or
rollback artifact.

Run a disposable rollback rehearsal after changing backup/restore or local
update runbooks:

```bash
pnpm ops:rehearse-rollback
```

By default this creates a migrated SQLite database under `/tmp`, seeds only
synthetic non-secret pre-update rows, backs it up, applies a synthetic update
that adds rows across raw events, chat messages, event failures, audit, memory
records, memory sources, and memory revisions, then restores the backup over
the same DB path with overwrite enabled. The command runs read-only doctor after
the rollback and prints aggregate-only JSON: backup/restore integrity, rollback
doctor overall/schema/FK status, table counts before update / after synthetic
update / after rollback, and SHA-256 fingerprints proving the rolled-back DB
matches the pre-update backup without printing row payloads. It refuses to reuse
an existing explicit `--db` path, does not contact SnowLuma/QQ/OneBot, does not
call model providers, and does not read local secret files.

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
- `eventIngressReceipts.total`
- `eventIngressReceipts.byDisposition` (`accepted` / `duplicate` only)
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

Ingress receipt metrics count retained receipt rows and use `received_at` for
`--since`; they are not monotonic process counters. Prometheus exposes the
bounded `lethebot_event_ingress_receipts_total` and
`lethebot_event_ingress_receipts_disposition_total{disposition="..."}` series
without raw event IDs, platform IDs, payloads, or dynamic labels.

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

## Graceful Shutdown

`SIGINT`, `SIGTERM`, and direct application `stop()` use one idempotent shutdown
sequence:

1. close HTTP and WebSocket ingress admission;
2. concurrently stop/drain scheduler handlers, close the HTTP listener, and
   await all accepted event tasks while the OneBot adapter remains available
   for outbound turn completion;
3. stop the adapter, then close SQLite.

An HTTP event finishing after admission closes receives bounded `503` without a
raw-event claim or ingress receipt. Repeated signals do not start another close
sequence. Shutdown deliberately has no timeout that closes SQLite beneath an
unresolved provider, tool, sender, or worker call. If the process supervisor
forces termination first, graceful drain alone is not crash recovery. Startup
replays only valid accepted or evidence-empty processing work. Evidence-bearing
delivery/effect-unknown work is quarantined for manual review and is not resent
automatically.

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
4. Disable the tool or tighten registry/action policy before reproducing with a
   controlled new input or deterministic test. Persisted turns are not
   replayable execution authority.

### Database corruption or accidental deletion

1. Stop LetheBot.
2. Copy current DB, WAL, and SHM files aside for analysis.
3. Restore the latest verified backup to a temporary path.
4. Run integrity and FK checks.
5. Replace production DB only after verification.

## Dependency Update Policy

- Treat dependency and lockfile changes as reviewed code.
- Update one dependency group at a time.
- Before update: run `pnpm release:check` and record baseline.
- After update: run `pnpm release:check` plus relevant real-provider/live checks only if explicitly configured.
- Do not update Pi SDK, SQLite, or tool/sandbox dependencies together unless the change is specifically a compatibility migration.
- Never commit generated secrets, `.env`, logs, DB files, or root deployment artifacts from tests.

## Install / Update / Release Preflight

Use the same deterministic gate before packaging, local install handoff, or
dependency updates:

```bash
pnpm release:check
```

The gate builds the runtime entrypoint and validates its required release
metadata before running the default test corpus:

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm release:preflight && pnpm test:run && git diff --check
```

`release:preflight` fails if the built `dist/index.js`, any checked-in migration
from `001` through `006`, `package.json`, or `pnpm-lock.yaml` is missing. It also
requires an exact `packageManager` pnpm version whose major matches the lockfile
format major and an exact-key `lethebotSchema` contract. The v6 contract targets
6, reads versions 1 through 6, and records whether a legacy absent/empty ledger
may be adopted. Preflight then loads the built
entrypoint dependency graph in a bounded Node child process without starting
the guarded application main. This proves the minimum source-release layout is
present, loadable, and carries reviewed schema compatibility metadata; it does
not create a standalone package or inspect local credentials, data, logs, or
databases.

It does not contact SnowLuma/QQ/OneBot, does not call model providers, and does
not prove live acceptance. Run it after dependency or configuration-template
changes and before handing a local install to another operator.

Systemd and PM2 application releases use one managed root:

```text
<root>/releases/<release-id>/{dist,migrations,node_modules,package.json,pnpm-lock.yaml}
<root>/current -> releases/<release-id>
<root>/previous -> releases/<prior-id>
<root>/.activation-state.json
<root>/.release-rollback/
<root>/shared/bin/{managed-startup.js,release-artifact.js,manifest.json,package.json}
<root>/shared/ecosystem.config.cjs  # PM2 only
<root>/shared/runtime.env
<root>/shared/data/lethebot.db
<root>/shared/logs/
```

`current` and `previous` are relative links so sibling temporary links can be
published with same-directory rename. Activation, confirmation, and explicit
recovery serialize through `<root>/.activation.lock`. The current journal writer
uses `schemaVersion: 2` with exact keys `schemaVersion`, `operationId`,
`operationKind`, `phase`, `candidateReleaseId`, `candidateDigest`,
`originalReleaseDigest`, `originalPointers`, `targetPointers`, and
`rollbackSnapshot`. Pointer absence is `null`, extra fields fail validation, and
schema v1 is read only as a legacy pointer-only recovery input. Valid v2 phases
are `intent_recorded`, `snapshot_ready`, `awaiting_confirmation`, `confirming`,
and `rollback_completed`. The writer uses the fixed unpublished
`<root>/.activation-state.tmp`, then file sync, rename, and managed-root
directory sync.

`candidateDigest` and `originalReleaseDigest` cover built `dist`, migrations,
package/lock metadata, and the structure/owner/permissions/link targets of the
release-local dependency tree. Every release entry must share the release-root
owner and be non-group/world-writable; dependency links must resolve inside the
canonical dependency tree. For systemd install releases and gate assets as
root-owned, then grant the fixed `lethebot` account read/execute access. PM2
normally has controller, daemon, and release under one UID, so its same-UID
check-to-exec race is a documented weaker boundary.

After the prior process stops, v2 activation creates a private verified SQLite
snapshot under `.release-rollback`, records whether the source existed plus its
SHA-256, schema, mode, UID, and GID, and persists `snapshot_ready` before pointer
publication. The snapshot is operation rollback state, not the retained
operator backup.
For example, activation from `(current=A, previous=C)` to release B passes
through `(A,A)` before reaching `(B,A)`; rollback passes through the same
ambiguous `(A,A)` pair on the way back to `(A,C)`. The pending intent determines
which exact original pair recovery must restore. Individual sibling-link
renames are atomic, but the two-link transition is not one atomic operation;
the ordered durable writes do not provide a full power-loss atomicity guarantee.
Recovery accepts only the recorded original pair, intended pair, `(A,A)`
intermediate, or the journal-explained `(B,C)` partial rollback pair. Any other
pair fails closed. Without a marker, duplicate `current`/`previous` links or a
`previous` link without `current` are invalid rather than guessed at.

These commands own the pointer links, operation-owned temporary links,
journal, startup permits, activation lock, rollback snapshot, and restore
scratch file. They never delete a release directory. On rollback they restore
the pre-activation SQLite state before old code starts. Prepare the shared
directories and restricted `runtime.env` before first activation.
Moving an older checkout-local environment or database into `shared` is a
separate one-time stopped-service maintenance operation: take a verified backup
and account for WAL/SHM sidecars before moving anything.
Generate systemd/PM2 assets only into exactly `<root>/shared`. The protocol-3
stable gate manifest binds the gate and release-digest helper hashes. Systemd
uses a root `ExecCondition`, unsets Node/dynamic-linker injection variables, and
then starts as `lethebot`; PM2 runs the stable launcher in `launch` mode, removes
the same dangerous environment variables, and suppresses restart on exit 78.
The controller validates the installed unit/ecosystem binding and gate bundle
before downtime. Keep `runtime.env` to the conservative `KEY=value` subset
shared by systemd and Node's dotenv parser.

Recommended local install/update sequence:

1. Record the currently deployed revision, select an explicitly reviewed target
   revision, choose a single safe release ID, and prepare that target as a
   direct child of the managed release directory. Do not overwrite the running
   checkout in place:

   ```bash
   git -C <root>/current rev-parse --verify HEAD
   git worktree add --detach <root>/releases/<release-id> <reviewed-target-revision>
   ```

   On the first installation there is no `current` revision to record; skip
   only the first command. The first activation publishes `current` without a
   prior rollback target.

2. In the prepared checkout, install frozen dependencies and run the release
   gate. This compiles and preflights `dist/index.js` before downtime begins:

   ```bash
   cd <root>/releases/<release-id>
   pnpm install --frozen-lockfile
   pnpm release:check
   ```

   Treat the prepared release, including installed dependencies, as immutable
   through confirmation or rollback. The activator content-hashes the compiled
   `dist`, migrations, and required release metadata, and fingerprints dependency
   paths/types/inodes/owners/modes/sizes/mtime/ctime plus internal symlink
   targets. This fast dependency metadata digest detects ordinary mutation but
   is not a byte-level software-bill-of-materials signature.

3. Rehearse maintenance, database rollback, and application-pointer rollback on
   disposable state, then run the read-only doctor against the shared database
   while the current release is still serving:

   ```bash
   pnpm --silent ops:rehearse-maintenance
   pnpm --silent ops:rehearse-rollback
   pnpm --silent ops:rehearse-application-rollback
   env -i PATH="$PATH" HOME="$HOME" \
     node --env-file=<root>/shared/runtime.env --import tsx \
     src/scripts/ops-maintenance.ts doctor \
     --db=<root>/shared/data/lethebot.db
   ```

   The application rollback rehearsal consumes the already-built `dist`; it
   does not rebuild or change the candidate. In private temporary roots it
   copies that same reviewed build into A and B release slots, invokes
   `node current/dist/index.js` through the managed symlink, and uses mock Pi
   plus loopback-isolated HTTP OneBot. Real health/readiness probes cover
   successful A-to-B slot activation. A second B uses a deliberately mismatched
   readiness route, so fixed `/readyz` fails and the activator must stop B,
   restore pointers, and restart/probe A. Aggregate output also requires
   empty-ledger v6 adoption, stable v1/v2/v3/v4/v5/v6 timestamps, preserved synthetic sentinel
   and a stable logical fingerprint of every non-internal schema
   object and table row after A readiness, clean integrity/FKs, stopped child
   processes, and removed temporary state. It does not call a provider or QQ. Because both
   slots contain the same build, this command proves built-process, pointer,
   probe, rollback, and shared-DB preservation mechanics; it does not prove
   compatibility between two different LetheBot versions. A real update must
   additionally retain the prior reviewed release and exercise candidate start
   plus prior-release restart on a disposable copy of production-shaped data.

   Use the aggregate-only cross-version command with two immutable managed
   release directories:

   ```bash
   pnpm --silent ops:rehearse-cross-version -- \
     --prior-release=/srv/lethebot/releases/<v5-release> \
     --candidate-release=/srv/lethebot/releases/<v6-release>
   ```

   This proves readiness-failure rollback to runnable v5, startup-gate denial
   plus explicit recovery for a crashed unconfirmed v6, and wrong-confirmation
   preservation followed by exact confirmation and marker-free v6 restart. It
   checks the prior/current ledgers and the v6 group-summary policy/binding table
   boundary.
   Output contains only aggregate booleans; input paths and synthetic DB content
   are not emitted.

4. Take an online pre-update SQLite backup while the current release is still
   serving. Validate and retain it for database recovery; it is not used for an
   ordinary application rollback:

   ```bash
   pnpm --silent ops:backup -- \
     --db=<root>/shared/data/lethebot.db \
     --out=<absolute-backup-dir>/lethebot-pre-update.db
   ```

5. Run activation from the prepared release with the service manager that owns
   the installed managed artifact:

   ```bash
   pnpm --silent ops:activate-release -- \
     --root=<root> \
     --release=<release-id> \
     --manager=systemd
   ```

   Use `--manager=pm2` for PM2. Before downtime the command runs offline
   preflight, validates release/dependency ownership and digest, verifies the
   protocol-3 gate and installed supervisor binding, and waits for a bounded
   `.activation.lock`. If a valid journal exists, it reconciles that operation
   before considering the candidate. It opens the shared DB read-only and checks
   the observed ledger against the candidate schema contract; malformed or
   out-of-range state exits `schema-incompatible` before intent, stop, snapshot,
   or pointer changes.

   A clean activation writes phase `intent_recorded`, stops the prior process,
   creates/verifies/fsyncs the private SQLite snapshot, then writes
   `snapshot_ready`. Only after that does it publish `previous` and `current`,
   issue the exact one-use startup permit, start the candidate, and verify health
   then readiness. Health completion removes the claimed permit; readiness moves
   the journal to `awaiting_confirmation`. The defaults are
   `http://127.0.0.1:6700`, `/healthz`, and `/readyz`; explicit endpoint flags are
   available for reviewed custom paths.

   PM2 activation deletes the old process record and starts a fresh stable
   launcher so removed environment keys do not survive. A failed delete is
   ignored only when the bounded PID check confirms `lethebot` is absent. The
   gate permit binds canonical root, operation, release, and release digest;
   automatic restart while the journal remains cannot reuse the claimed permit.

6. Candidate start, health, or readiness failure automatically stops the
   managed service, validates the prior release digest, restores the exact
   pre-activation SQLite state, restores the original pointer pair, and only
   then restarts/rechecks the original `current` release. If no DB existed before
   activation, rollback removes a DB created by the candidate. Main DB
   WAL/SHM/journal files and operation-owned restore scratch files are handled
   under the stopped-service boundary. A fully successful restoration reports
   `activation-failed`. An incomplete candidate stop, DB restore, pointer
   restore, restart, probe, or cleanup reports `rollback-failed` and retains the
   journal for retry. Deterministic temporary links are removed only after
   validation against the recorded operation.
   If the initial attempt to stop the prior release fails, activation reports
   `stop-failed` and also retains the intent because the supervisor API cannot
   prove whether that process remained running.

   If stopping the failed candidate itself fails, the activator does not start
   the prior release concurrently. It reports `rollback-failed (stop-candidate)`
   and retains the pending intent for explicit operator recovery:

   ```bash
   pnpm --silent ops:recover-release -- \
     --root=<root> \
     --manager=systemd
   ```

   Use `--manager=pm2` for PM2 and reviewed endpoint overrides when needed. With
   no journal, explicit recovery is lifecycle-free and reports
   `recovered: false`. With a valid journal it stops the service, clears only
   operation-owned startup state, restores DB then pointers, starts/probes the
   original release, records `rollback_completed`, and cleans the snapshot and
   journal. A crash after `rollback_completed` does not permit a false success:
   the retry starts/probes the prior release again before cleanup. Explicit
   recovery of `awaiting_confirmation` means rollback.

   Malformed journal, unexplained pointers, foreign temp/snapshot/permit state,
   or changed prior bytes/dependencies exits `invalid-recovery-state`; lifecycle,
   restore, probe, or cleanup failure exits `recovery-failed`. The stable startup
   gate is the host-start fail-closed hook while a journal exists, even though
   recovery work itself runs only through this command or the next activation.

   New lock temps encode nonce, PID, and canonical process identity in
   `.activation-lock-v2.<nonce>.<pid>.<base64url-identity>.tmp`. A live empty or
   partial writer is preserved without blocking the atomic hard-link contest; a
   dead/PID-reused writer is reclaimed only when its stable bytes are an exact
   prefix of the encoded owner record. A partial legacy temp, malformed temp, or
   old directory-valued `.activation.lock` cannot prove ownership and must be
   reviewed manually. Never remove it while an activation, confirmation, or
   recovery process may still run. `cleanup-failed` means owned lock cleanup
   could not be verified.

   The operation snapshot restores POSIX mode/UID/GID, but not extended ACLs or
   xattrs. Capture/reapply those separately where they are part of the deployment
   policy. The separately retained `ops:backup` artifact remains the disaster
   recovery point after confirmation; it is not deleted with operation state.

   Do not prune, replace, or convert to symlinks the candidate, original
   `current`, or original `previous` release directories named by a pending
   `.activation-state.json`. Recovery fails closed until every referenced direct
   release directory is intact.

   After candidate observation, explicitly confirm the exact release and
   activation operation returned by `ops:activate-release`:

   ```bash
   pnpm --silent ops:confirm-release -- \
     --root=<root> \
     --release=<release-id> \
     --operation-id=<operation-id> \
     --manager=systemd
   ```

   Confirmation rechecks pointers, release/dependency digest, schema range,
   snapshot, health, and readiness. It writes `confirming` before removing the
   operation snapshot and journal. If interrupted in `confirming`, repeat the
   exact command: it restarts the candidate through the stable gate and probes
   it before cleanup. Until confirmation, another activation returns
   `confirmation-required`. After confirmation no persistent release digest is
   retained, so the root ownership/immutability policy remains authoritative.

7. If a SnowLuma/QQ session is explicitly available, run the OneBot verifier and
   record redacted acceptance evidence:

   Before generating the DB summary, complete the controlled live sequence with
   explicit non-mock Pi/evaluator configuration: one
   private message; one exact `@bot` message in the target group; then, after the
   bot response is stored, a distinct reply to that response in the same group
   without mentioning the bot. At least one accepted delivered turn must actually
   exercise a Pi-requested tool that the configured model evaluator approves and
   that completes successfully. Do not copy message text or platform identifiers
   into the evidence file.

   ```bash
   env -i PATH="$PATH" HOME="$HOME" \
     node --env-file=<root>/shared/runtime.env --import tsx \
     src/scripts/verify-napcat.ts
   pnpm --silent acceptance:evidence-template -- --out=/tmp/lethebot-acceptance-evidence.md
   pnpm --silent acceptance:db-summary -- --db=<root>/shared/data/lethebot.db --require-acceptance-hints
   pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
   pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
   ```

   The evidence validator treats raw platform-like numbers as unsafe even when a
   different part of the same line says `<redacted>` or `redacted-note`; redact
   the actual identifier rather than annotating it.
   In complete mode it also requires checked command-preflight evidence:
   both compose `config --quiet` checks, aggregate-only `pnpm ops:worker-soak`
   success, FK-clean acceptance DB evidence, and successful
   `acceptance:db-summary --require-acceptance-hints` evidence must be
   recorded before the file can pass `--require-complete`. The local configuration snapshot must
   also select exactly one compose target, one Pi provider mode, and one OneBot
   transport; conflicting checked runtime options are rejected. Complete evidence
   rejects the checked mock provider and the fixed-mock source-build compose target.
   `acceptance:db-summary` output is helper evidence only: it is aggregate-only
   and safe to summarize. The required-hints mode catches empty/incomplete,
   one-sided, or split private/group DB summaries where context/action evidence
   is not linked through the turn's selected durable context/action pointers,
   the completed flow is not source-linked to a normalized chat row and QQ
   gateway chat raw event, the linked success is not a delivered reply
   (`reply_short`, `reply_full`, `reply_with_tool`, or `ask_clarification`)
   with an executed message id persisted as a same-path bot response row,
   attempts to use downgraded `send_folded_forward` fallback as complete
   delivered-reply evidence, attempts to use downgraded `react_only` face/text
   fallback as complete delivered-reply evidence, the DB does not contain both
   distinct group chains (an exact `mentions_bot=1` trigger and a quoted
   `mentions_bot=0` reply resolving to a prior same-group `bot.response` /
   `bot-self` row with exact `reply_to_bot` decision reason and a separately
   stored outbound bot response), either chain loses its gateway-normalized
   `qq-group-<5-12 digits>` ID through trigger/context/response evidence, any required
   private/mention/reply turn carries a mock/test/stub/fake-like Pi identity, no
   accepted turn has the matching evaluator-approved successful Pi tool/audit
   chain in durable runtime order, or no complete
   acceptance flow selected an active, source/revision-linked,
   non-secret/prohibited governed memory with a usable durable source evidence
   row visible in that same flow context and scoped to that same sender, group,
   conversation, or public/system boundary through the turn's durable
   `context_pack_id`, but it does not replace the actual private/group live
   chat actions or the final two validator commands. Stored identity strings do
   not prove an external API call, and this offline helper cannot verify the
   process-local action `execution_binding` HMAC.
   The complete evidence validator itself only parses the Markdown checklist;
   it does not execute commands, query/cross-bind the DB, contact external
   systems, or authenticate the checked attestations.

Do not treat a passing `release:check`, `ops:doctor`, or `verify:onebot` alone
as production completion. Production readiness still requires filled live
private/group SnowLuma/QQ acceptance evidence that passes both acceptance
validators.

## Lightweight Governance UI Plan

CLI remains sufficient for the current governance scope when operators can
inspect, disable, delete, restore, redact display profiles, and explain context.
A lightweight UI becomes necessary when:

- non-technical users need self-service memory review;
- memory proposals need batch approval;
- `/why` traces need comparison across turns;
- display identity redaction/unlink workflows become frequent.

Initial UI scope if built later:

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

Generate local deployment configuration artifacts with:

```bash
pnpm deploy:docker -- --output-dir=/tmp/lethebot-deploy
pnpm deploy:systemd -- --deployment-root=/srv/lethebot --output-dir=/srv/lethebot/shared
pnpm deploy:pm2 -- --deployment-root=/srv/lethebot --output-dir=/srv/lethebot/shared
```

These commands generate Docker Compose, systemd, or PM2 configuration files for
operator review. Generated artifacts intentionally do not embed the current
`ONEBOT_TOKEN`, `LETHEBOT_BOT_QQ_ID`, or OneBot URL values loaded from the
operator environment. Docker Compose uses `${...}` runtime interpolation and
requires `LETHEBOT_IMAGE` to name a reviewed version tag or digest; it does not
mount source or install/build at startup. Systemd uses the required
`<root>/shared/runtime.env`; PM2 loads the same file from the generated
`shared/ecosystem.config.cjs`. Systemd runs the root-owned stable gate as an
`ExecCondition` before executing `<root>/current/dist/index.js`; PM2 executes the
stable launcher, which gates then spawns that entrypoint. Both force
`<root>/shared/data/lethebot.db`; PM2 logs go to `<root>/shared/logs`. Managed
generation rejects any output directory other than exactly `<root>/shared`.
Compose cannot prevent an
operator from supplying a mutable tag such as `latest`; use a registry digest
when cryptographic image immutability is required. Keep the real `.env` local to the target machine and never
commit generated deployment artifacts if they have been manually edited to
include secrets, private QQ IDs, group IDs, cookies, or local paths.

Use neutral generated-artifact paths. If a deployment argument could contain a
credential, private identifier, or private username, rename it first and use
`pnpm --silent` so package-manager argument echo does not occur before the
deployment script's own redaction boundary.

Add Redis, vector services, and split workers only after the simple deployment shows clear pressure.
