# Test Strategy

This document describes the test surfaces and commands that exist in the
current LetheBot repository. Tests use Vitest and TypeScript. The default gate
is deterministic and credential-free.

## Required Gates

Use the narrowest relevant test while developing, then run the applicable
repository gate.

```bash
# One file or one regression
pnpm exec vitest run tests/unit/pi/pi-adapter.test.ts --silent
pnpm exec vitest run tests/integration/e2e-conversation.test.ts -t "failed turn" --silent

# All default deterministic tests
pnpm test:run

# Static checks
pnpm typecheck
pnpm lint
git diff --check

# Release gate: typecheck, lint, build, artifact preflight, default tests, diff hygiene
pnpm release:check
```

`pnpm test` starts Vitest's interactive development mode. Automation and
completion evidence use `pnpm test:run` or `pnpm release:check`.

Do not hardcode pass counts in stable documentation. Counts change as focused
regressions are added; command exit status and the current output are evidence.

## Test Layers

### Unit Tests

`tests/unit/` covers module contracts and edge behavior, including:

- event, memory, context, action, audit, tool, identity, and agent types;
- repositories and SQLite migration compatibility;
- attention, policy, action execution, evaluator, Pi, and tool boundaries;
- worker leases, attempts, retries, heartbeats, and idempotency;
- configuration, logging, redaction, deployment helpers, acceptance helpers,
  and operations helpers.

Unit tests should use deterministic inputs and avoid network access, local
credential files, real account identifiers, and persistent workspace data.

### Gateway Fakes

`tests/fakes/fake-onebot.ts` is the protocol-level fake for OneBot behavior.
Gateway and integration tests use it or local in-process HTTP/WebSocket fixtures
to prove normalization, send behavior, authentication, reconnect handling, and
capability fallbacks without contacting QQ or SnowLuma.

### Integration Tests

`tests/integration/` exercises boundaries across real repository modules. Major
surfaces include:

- raw-event-first persistence and ingress admission recovery;
- identity resolution, context history, memory extraction/retrieval/injection,
  and the full conversation chain;
- action decisions/executions, tool and audit links, turn failure behavior, and
  graceful shutdown;
- file operations, application activation/rollback, maintenance commands, and
  generated deployment behavior.

Persistence tests use disposable databases. A behavior that changes durable
state should assert the relevant rows and lifecycle transitions and finish with
an empty `PRAGMA foreign_key_check` result.

### Deterministic End-to-End Tests

The default suite includes credential-free end-to-end coverage such as
`tests/e2e/full-memory-cycle.test.ts`. It also includes the deterministic guard
in `tests/e2e/deepseek-real-api.test.ts`.

`tests/e2e/pi-real-api.test.ts` is opt-in and skipped by default. Its presence
in a default Vitest run is not real-provider evidence.

### Phase Acceptance Scaffold

`tests/phase-acceptance/phase-a.test.ts` retains the repository-foundation
acceptance check. Current completion evidence comes from the focused suites and
`pnpm release:check`, not from nonexistent per-phase package scripts.

## Critical Regression Invariants

Tests should preserve these P0 boundaries.

### Persistence And Traceability

- Raw events exist before derived chat, turn, action, tool, job, or memory rows.
- The event -> chat -> turn -> context -> decision -> execution chain remains
  queryable and foreign-key clean.
- A matching automatic extraction candidate commits its inbound chat row and
  reference-only job atomically before Attention can return; reply, evaluator,
  and send outcomes do not control admission.
- A deferred group question commits its derived chat row, source-bound
  Attention candidate, and exact `{ candidateId }` job together; a failed
  enqueue leaves none of those derived rows.
- Caught failures become bounded, redacted, durable terminal evidence.
- Startup recovery is idempotent and does not replay work whose external
  delivery state is unknown.
- A recorded delayed delivery may be reused on worker retry, but tests must not
  describe this as external exactly-once delivery. They must retain a
  fail-closed case for an indeterminate turn/send and acknowledge the crash
  interval between QQ/OneBot acceptance and local execution evidence.

### Memory And Context Privacy

- Deleted, disabled, superseded, expired, secret, prohibited, or invisible
  memory is excluded immediately.
- Long-term memory writes retain scope, owner, source, timestamp, confidence,
  lifecycle, revision, and audit evidence.
- Visibility filtering happens before retrieval limits and token budgeting.
- Private/user/group context never leaks into an incompatible scope.
- Platform identifiers, display metadata, secrets, and raw tool output are
  minimized and redacted before prompt, audit, or operator display.
- Outbound memory wording is authorized only by the exact selected active record
  or fully committed same-turn `memory.propose` effect; unsafe unsupported
  propositions are neutralized without being echoed.

### Authority Boundaries

- `evaluatorPolicy=bypass` never bypasses L0 policy, permissions, sandboxing,
  output handling, audit, or the action executor.
- Pi and evaluators propose; governed services and executors own durable state
  and external effects.
- QQ governance reparses persisted raw/chat/account evidence and requires the
  configured bot owner or the persisted owner/admin role of the exact current
  group; recognized unauthorized commands receive deterministic denial.
- Group governance listing never exposes private/global/other-group memory,
  even to the bot owner, and group owner/admin forget cannot cross the same
  group-safe boundary.
- Recognized QQ governance runs before Attention in a zero-token local turn and
  calls no Pi, evaluator, or tool. Replies still use the action executor;
  duplicate ingress, successful delivery, handled send failure, and thrown
  persistence failure retain their distinct durable contracts.
- Prepared local tool effects and their terminal evidence commit atomically.
- Output limits and cooperative deadlines remain bounded; tests cover
  pre-abort, timer expiry, synchronous elapsed overruns, wait-for-settlement,
  cleanup/reuse, fixed failure evidence, and no late prepared-effect commit
  without inventing rollback semantics for already-completed external effects.

### Operations

- Health, readiness, metrics, backup, restore, retention, worker soak, release
  activation, rollback, and shutdown tests use disposable local state.
- Worker soak evidence must sustain enqueue and successful completion across
  three time windows, include a late enqueue, observe no empty load-phase poll,
  and terminally drain every tracked job; an initial burst followed by idle
  polling is not sufficient.
- Operator output contains aggregate or redacted evidence, not raw chats,
  secrets, private identifiers, or sensitive paths.
- Offline release-preflight tests do not start the guarded application.
  Application rollback rehearsal does start real built LetheBot A/B child
  processes, but only with mock Pi, loopback-isolated HTTP OneBot, synthetic
  SQLite, bounded probes/stops, and aggregate path-free output; it does not call
  providers or QQ.

## Conversation Reliability Matrix

Transport and persistence assertions are necessary but do not prove that a
multi-person conversation is usable. The active group reliability repair uses
the following behavior scenarios. Fixtures must be synthetic and
content-minimal; never copy live messages, names, identifiers, provider output,
or database rows into the repository.

| ID | Scenario | Required deterministic assertions |
|---|---|---|
| `REL-CTX-01` | Three or more human speakers, including duplicate display names | Each selected human has a distinct opaque `speakerRef`; repeated messages from the same human reuse it; current speaker is explicit; no prompt-visible ref contains a platform/canonical ID. |
| `REL-CTX-02` | Historical display metadata changes or is unavailable | Identity stays attached to the same opaque ref; display data is an untrusted optional label; unavailable display uses an explicit unknown label rather than another speaker's data. |
| `REL-QUOTE-01` | Current message replies to a same-conversation bot or human message inside the rolling window | Context identifies current message, exact target message ref, target speaker ref, and bot/human role; Pi rendering and token budget include the relation. |
| `REL-QUOTE-02` | Reply target is older than the rolling window, missing, or from another conversation | One bounded same-conversation lookup may include the older target; missing targets are marked unresolved; cross-conversation targets are rejected and cannot trigger/influence the turn. |
| `REL-ATT-01` | Low-risk direct mention/reply/question combinations | Addressing selects the reply fast path independently of risk; combining relevance signals does not invoke the risk evaluator; strong-trigger cooldown behavior remains as locked in D9. |
| `REL-ATT-02` | Unmentioned question and later group activity | Chat/candidate/job persistence is atomic; no Pi/send/claim occurs before the local-ingress-based 15-second due time; the exact source is revalidated; expiry at 120 seconds, an explicit human reply, more than five exact-group messages per ten seconds, and the two-response exact-group/ten-minute budget produce bounded terminal suppressor/decision/job-attempt evidence. An unsuppressed recheck is proactive and carries `delayed_recheck`; retry reuses the one decision and recorded terminal turn/delivery without duplicating local work; group isolation and foreign keys remain clean. |
| `REL-ADMIN-01` | Narrative management text, recognized member command, and exact-group admin command | Narrative and prefix collisions stay ordinary; every recognized family is intercepted before Attention; unauthorized members receive fixed denial and authorized invalid syntax receives usage. The local non-proactive reply action, execution, delivered bot row, zero-token turn, and admission agree, with zero Pi/evaluator/tool calls. |
| `REL-EVAL-01` | Provider returns valid, fenced, malformed, extra-field, or schema-invalid evaluator output | Native structured mode is used when supported; at most one correction attempt is separately ledgered; terminal governed failure stays fail-closed with durable bounded evidence and no external effect. |
| `REL-EVAL-02` | Ordinary response candidate versus actually risky action | Ordinary relevance never depends on evaluator parsing; a true-risk evaluator failure does not become an unexplained failed admission. |
| `REL-MEM-01` | No memory effect, proposal success/failure, active memory, and unrelated or ambiguous evidence | No effect, failed/partial proposal, inactive/unselected memory, target mismatch, unsafe proposition, and unrelated or ambiguous evidence produce neutral wording; a fully committed same-turn `memory.propose` effect produces pending-review wording; only exact selected active evidence permits durable wording. Returned and stored decisions carry the same guard suppressor and action text, delivered text equals the persisted bot response, the turn retains the pre-guard Pi draft, ordinary non-claim language is unchanged, and foreign keys remain clean. |
| `REL-MEM-02` | Private recall, group proposal, opted-in group summary, and restart | Private memory recalls only in allowed scope; group-derived user memory stays proposed/same-group; summary requires per-group opt-in; approved memory remains available after process/container restart. |
| `REL-MEM-03` | Opted-in group-summary frozen-window continuity | Canonical local-ingress planning freezes exact post-budget sources; discovery/action routes converge; policy races and invalid source sets fail before Provider/effect; later old-clock rows cannot join; completed windows are disjoint and terminally failed windows do not block newer sources; pending/running sources survive retention; final memory and invocation sources match; integrity and foreign keys remain clean. |
| `REL-GOV-01` | QQ/CLI list, forget, summary lifecycle, and prior-turn explanation | The 512-character exact parser, one canonical raw/chat derivation, canonical `qq-group-[1-9][0-9]{4,11}` scope, and persisted identity proof enforce bot-owner/exact-group authority; group listing/forget stay group-safe while private bot-owner and known-ID authority follow their wider contracts. Forget is immediately unretrievable with revision/audit evidence and bounded ID/decision projections. Summary is default-off, idempotent, generation/audit bound, cancel-on-disable, and no-backfill across persisted chat ingress, pending-normalization raw ingress, or rollback/future clocks; redacted policy audits correlate through `groupIdHash`. The mutation/audit and reply decision commit atomically before send; injected decision failure rolls them back. `/why` selects only the latest prior exact-conversation ingress. CLI records `local_admin`; replies, titles, stderr, and audit bodies are bounded/redacted, deduplicated, executor-routed, and preserve the completed-turn/failed-execution contract on handled send failure. Integrity and foreign keys remain clean. |
| `REL-RET-01` | At least 12 synthetic retrieval queries, each with one expected same-scope source, eight or more newer/higher-importance same-scope distractors, and incompatible-scope records | Existing ranking may skip R8 only when the expected source is selected in 12/12 under production count/token limits, incompatible selections are zero, and selection/rejection trace reasons are complete; otherwise query/FTS/quote/thread ranking is required. |
| `REL-SCOPE-01` | Similar users/messages across two groups | History, quote targets, participant refs, memory, action targets, and bot responses remain in the exact conversation; integrity and foreign-key checks are clean. |

Minimum test ownership:

- context and quote scenarios:
  `tests/integration/context-history.test.ts`,
  `tests/unit/context/builder.test.ts`, and
  `tests/unit/pi/pi-adapter.test.ts`;
- Attention/action scenarios:
  Attention unit tests, `tests/unit/actions/social-decision-service.test.ts`,
  `tests/unit/attention/delayed-attention-service.test.ts`, scheduled/unsupported
  type coverage in `tests/unit/workers/background.test.ts`, schema-v5 migration
  and retention tests, and focused `REL-ATT-02` flows in
  `tests/integration/e2e-conversation.test.ts`;
- evaluator scenarios:
  `tests/unit/evaluator/model-evaluator.test.ts` and
  `tests/unit/evaluator/pi-ai-client.test.ts` across social, memory, and tool
  domains, plus schema-migration/model-invocation repository tests and DB-backed
  social, memory, and required-tool terminal evidence;
- memory-claim truthfulness:
  `tests/unit/actions/memory-claim-truthfulness.test.ts` for evidence binding,
  correction, safe echo, and ordinary-language boundaries, plus the focused
  `REL-MEM-01` flow in `tests/integration/e2e-conversation.test.ts` for action,
  delivery, bot-response, raw-draft, and foreign-key integrity;
- memory/governance/worker scenarios:
  focused memory extraction, retrieval/injection, summary-worker, governance,
  scheduler, and full-memory-cycle suites. `REL-MEM-03` additionally belongs to
  the group-summary job service, index wiring, action executor, SQLite
  maintenance, summary integration, and frozen-window conversation E2E suites.
- QQ governance grammar, source proof, authority, redaction, listing, forget,
  summary, and `/why` service behavior:
  `tests/unit/governance/qq-command.test.ts`,
  `tests/unit/governance/service.test.ts`,
  `tests/unit/config/index.test.ts`, and
  `tests/unit/storage/group-summary-policy-repository.test.ts`;
- QQ/CLI governance integration:
  focused `REL-ADMIN-01`/`REL-GOV-01` flows in
  `tests/integration/e2e-conversation.test.ts` own pre-Attention routing,
  decisions/executions, delivery/failure, deduplication, and exact-conversation
  isolation; `tests/integration/cli-main.test.ts` owns shared-service
  `local_admin` delete/summary lifecycle, parser failures, redaction, and
  integrity;
- query-aware retrieval:
  `tests/integration/query-aware-memory-retrieval.test.ts` owns the 12-case
  current/quote/thread by private-user/group-user/group-fact/conversation-fact
  matrix, including 51-record same-scope and cross-owner pre-limit cases,
  incompatible group/conversation boundaries, competing query/scope order,
  complete bounded-candidate accounting and durable evidence round-trip, token
  limits, and integrity/foreign keys. ContextBuilder, repository, FTS-query, ContextTrace,
  governance `/why`, and memory-search suites own the focused compatibility
  boundaries.

`BASIC_USABLE` requires `REL-CTX-01/02`, `REL-QUOTE-01/02`, `REL-ATT-01`,
`REL-ADMIN-01`, `REL-EVAL-01/02`, `REL-MEM-01`, and `REL-SCOPE-01`, plus the
controlled live canary. `TARGET_COMPLETE` additionally requires
`REL-ATT-02`, `REL-MEM-02/03`, `REL-GOV-01`, `REL-RET-01`, restart evidence, and
the complete live behavior matrix. A transport-only fake or a healthy live
container cannot satisfy either milestone.

The generated local-acceptance evidence template names every row above and the
R0 deterministic/release baseline. Each row has a fixed scenario ID, expected
classification, generated verification command, and required behavior plus
bounded actual classification, passed/total counts, durable-chain status, and
pass/fail result. `--require-complete` requires each row to be checked with a
passing actual/result, equal positive counts, and verified durable linkage. It
also requires the controlled direct delivered-reply p95 to be at most 15,000
ms, rejects content outside the generated template structure, and limits
placeholder replacements to typed status/count/latency values, fixed safe or
redacted paths, real calendar timestamps/dates, and bounded internal/redacted
labels rather than free-form text.

## Test Data And Time

- Prefer fixed timestamps and synthetic IDs that cannot be confused with real
  accounts.
- Use fresh migrated temporary SQLite databases for persistence flows and clean
  them in `finally`/test teardown.
- For delayed Attention, use the worker's deterministic `now` override to test
  the instant before and at `scheduled_at`; do not sleep for 15 or 120 seconds.
  Anchor policy windows to synthetic local ingress/admission time, not the
  platform message clock, so clock-skew behavior remains deterministic.
- Use fake timers only around the behavior under test, restore real timers in
  teardown, and assert stale timers cannot affect reused objects.
- Seed deliberate secret/platform-shaped values only to prove redaction; never
  use real credentials or account data.

## Real Provider And Live QQ Evidence

Real provider tests require explicit opt-in and credentials. Follow
[the E2E provider guide](../tests/e2e/README.md); do not read implicit local
credential files or turn a skipped test into a pass claim.
The governed-tool probe must join its durable evaluator decision to exactly one
completed evaluator invocation with matching request, domain, owner, sources,
provider/model/prompt identity, and timestamps. A non-placeholder
`evaluator_version` without that link is only declared metadata, not
real-provider evidence.

Real SnowLuma/NapCat/QQ acceptance is a separate controlled workflow. It
requires explicit runtime/session authorization and redacted evidence produced
through [Local Container Acceptance](local-container-acceptance.md). Completion
requires both validators:

```bash
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
```

FakeOneBot, local HTTP/WebSocket fixtures, release checks, and an unfilled
evidence template do not substitute for live acceptance.
The default validator is a heuristic secret/platform/raw-label scan and does
not prove arbitrary free-form text share-safe. Human review remains required.
`--require-complete` additionally enforces the generated template structure,
the full structured R0-R8 matrix, successful status/count/durable-chain values,
required health/readiness/metrics redaction attestations, and the latency bound;
it still does not execute commands or authenticate operator declarations.

## Adding Or Changing Behavior

1. State the observable failure and acceptance criterion.
2. Add a focused failing regression or another falsifiable check.
3. Make the smallest architecture-compliant change.
4. Run the focused test and affected subsystem suite.
5. For TypeScript behavior changes, run typecheck and lint.
6. For persistence changes, assert rows, rollback/lifecycle behavior, and clean
   foreign keys on a fresh database.
7. Run `pnpm release:check` for cross-cutting changes and before completion
   claims.

Do not weaken or skip a test to make a gate pass unless the test contradicts a
confirmed current contract; document that decision when it occurs.
