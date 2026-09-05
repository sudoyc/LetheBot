# Long-Term Development Delivery Contract

This document defines what the long-running goal must deliver. It is a stable
delivery contract, not a progress log. Current status belongs only in
`docs/long-running-goal-state.md`; execution behavior belongs in
`docs/prompts/repair-and-long-term-development-goal.md`; stable safety and
architecture rules belong in `docs/long-term-development-constraints.md`.

## 1. Delivery Scope

The default target is a production-ready, local-first QQ private/group chatbot
through NapCat or SnowLuma and OneBot. The target includes the operational P0-P9
program and the missing core product capabilities from the original vision:

- Pi reasoning behind an explicit LetheBot adapter and evaluator boundary;
- raw-event-first ingestion and a traceable event -> chat -> turn -> context ->
  decision -> execution chain;
- governed episodic, semantic, procedural, and reflective memory with source,
  scope, confidence, lifecycle, revision, audit, and immediate deletion effects;
- ContextBuilder-owned retrieval, ranking, token budgeting, prompt assembly, and
  explainable selection traces;
- policy-gated tools and actions, durable workers, identity separation, and
  owner/admin governance;
- deployment, health/readiness, metrics, backup, restore, rollback, and sustained
  operation evidence;
- fresh real Provider/QQ evidence for the exact candidate release.

The following remain outside the default target unless the user explicitly sets
`SCOPE_EXPANSION=AUTHORIZED`: a second platform adapter, multi-agent product
orchestration, a full knowledge-graph UI, shell or platform-admin tools, and
distributed infrastructure. They may be planned separately, but must not be
silently treated as completed or as blockers for the default QQ target.

## 2. Required Delivery Units

Every row must be `PHASE_COMPLETE` with current evidence before the default
target can be called `TARGET_COMPLETE`.

| ID | Required result | Minimum evidence |
|---|---|---|
| `DEL-ARCH` | Logical ownership boundaries are preserved in the modular monolith. | Characterization tests, source review, and no duplicate production path. |
| `DEL-GW` | OneBot private/group ingress, normalization, capability handling, reconnect, and bounded delivery work. | Gateway tests, malformed/auth/duplicate cases, and authorized live protocol evidence. |
| `DEL-ING` | Raw events are durable before derived records and admission is idempotent. | Fresh SQLite rows, transaction assertions, FK check, and duplicate/recovery tests. |
| `DEL-TURN` | Per-conversation ordering, bounded cross-conversation concurrency, deadlines, cancellation, and failure recovery work. | Barrier-based deterministic tests plus live overlap evidence when authorized. |
| `DEL-PI` | Every provider request is ledgered with source/turn ownership, status, latency, and typed or explicitly unknown usage. | Repository/adapter tests, metrics/CLI parity, and provider evidence. |
| `DEL-MEM` | Memory writes, proposals, review, disable/delete/restore/supersede, conflict, consolidation, and decay are governed and reversible. | Source/revision/audit rows, immediate retrieval exclusion, retry and rollback tests. |
| `DEL-RET` | Retrieval is scope-safe, visibility-safe, budgeted, ranked, and explainable. | FTS/semantic ranking tests, context traces, cross-scope negative tests, and token-bound checks. |
| `DEL-ACT` | Decisions, effects, delivery truth, downgrade, retry, and indeterminate outcomes are durable and redacted. | Action/effect/delivery tests, FK checks, and authorized delivery/failure samples. |
| `DEL-TOOL` | The reviewed tool catalog is useful without opening unsafe capabilities. | Permission, evaluator, sandbox, bounds, redaction, audit, effect, and rollback tests. |
| `DEL-WORK` | Workers are durable, lease-fenced, fair, idempotent, observable, and restart-safe. | Retry/heartbeat/recovery tests, maintenance rehearsal, and soak evidence. |
| `DEL-GOV` | CLI, QQ governance, and local UI share the same authority and mutation semantics. | Scope/auth/CSRF/redaction/parity tests and synthetic browser evidence. |
| `DEL-OPS` | Install, update, migration, health, backup/restore, retention, rollback, and operator runbooks are executable. | Release gates, disposable rehearsals, artifact digests, and prior-release recovery. |
| `DEL-V1` | Procedural memory and reusable skills work end to end. | Explicit teaching or repeated evidence creates a governed procedure; retrieval, governance, source chain, revision, disable/delete, and rollback all pass. |
| `DEL-V2` | Semantic retrieval improves recall without replacing deterministic controls. | Versioned embedding/index records, visibility-before-ranking tests, FTS fallback, rebuild/rollback, bounded provider behavior, and recall evidence. |
| `DEL-V3` | Reflection and importance scoring produce reviewable learning proposals. | Source-backed proposal, explainable score, no direct worker mutation, review/apply/rollback, idempotency, and retrieval impact tests. |
| `DEL-LIVE` | The exact candidate release passes the real Provider/QQ acceptance matrix and sustained operation checks. | Validator-clean aggregate evidence for private/group turns, tools, memory, restart, restore/rollback, and the 72-hour soak. |
| `DEL-DOC` | Canonical docs describe observed behavior and operators can reproduce the supported workflows. | Link/command review, current checkpoint, release report, and no stale completion claims. |

## 3. Product Capability Acceptance

### Procedural Memory (`DEL-V1`)

The implementation must support a user story such as “when I ask for this kind
of work, summarize files in this format” without granting the model direct
database access. The complete path is:

```text
explicit user instruction or governed repeated evidence
  -> candidate and evaluator/policy decision
  -> source-linked procedure proposal
  -> review or allowed activation
  -> ContextBuilder retrieval
  -> owner inspection, revision, disable, delete, restore
```

Procedure content must retain source context, scope, visibility, sensitivity,
confidence, lifecycle, and revision history. A procedure must not silently turn
into a tool permission or platform action.

### Semantic Retrieval (`DEL-V2`)

Semantic retrieval is an additional ranking signal, never the source of truth.
The design must preserve FTS/structured fallback when the embedding provider is
unavailable, must version model and index metadata, and must apply scope,
visibility, lifecycle, sensitivity, and ownership filters before ranking and
limits. Rebuilding or changing an index must not mutate memory truth or bypass
governance. Provider failures, timeouts, unknown dimensions, and stale indexes
must have bounded, observable outcomes.

### Reflection and Importance (`DEL-V3`)

Reflection is a proposal-producing background capability. It may summarize
patterns, identify conflicts, or recommend importance changes, but it cannot
directly rewrite an active memory. Each proposal needs a stable ID, exact source
set, reason, score inputs, confidence, scope, and expiry. Apply, reject, expire,
retry, concurrent review, and rollback must be auditable and idempotent.

## 4. Evidence and Release Requirements

The final evidence set must be tied to one immutable candidate release and may
contain only aggregate values, booleans, status enums, bounded timings, hashes,
counts, and redaction markers. It must not contain credentials, raw chat, real
QQ/group/message IDs, private database rows, cookies, QR/session data, or private
file paths.

At minimum, the delivery run must produce:

```bash
pnpm release:check
pnpm test:coverage
pnpm ops:doctor
pnpm ops:rehearse-maintenance
pnpm ops:rehearse-rollback
pnpm ops:rehearse-application-rollback
pnpm ops:worker-soak -- --duration-ms=3600000 --interval-ms=1000
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
```

The live commands run only after the corresponding authority flags are granted.
The default deterministic suite must remain credential-free. Persistence work
must use fresh migrated temporary databases and finish with an empty
`PRAGMA foreign_key_check` result.

## 5. Handoff Package

The final handoff must include these files or links:

- the exact candidate and prior release identifiers/digests;
- the final requirement-to-evidence matrix with verification timestamps;
- migration compatibility and backup/restore/rollback results;
- test, typecheck, lint, build, coverage, and package results;
- live acceptance and soak summaries, redacted and validator-clean;
- changed source, schema, configuration, tests, docs, and runbooks grouped by
  subsystem;
- operator start/stop/health/governance/backup/recovery instructions;
- explicit non-goals, user-approved deferrals, and external blockers;
- one rollback command sequence for the candidate and one recovery sequence for
  the prior release.

Use this report shape:

```text
Goal status: COMPLETE | BLOCKED_EXTERNAL | NEEDS_DECISION
Candidate: <immutable release identifier>
Prior release: <immutable release identifier>
Scope: default QQ core | explicitly expanded scope

Requirement matrix:
  DEL-ARCH: <status + evidence reference>
  ...
  DEL-DOC: <status + evidence reference>

Verification:
  <command>: <exit status and concise result>

Changed paths:
  <subsystem>: <paths>

Rollback and recovery:
  <result and evidence reference>

Remaining blockers or decisions:
  <exact item, authority/decision needed, and next action>
```

## 6. Completion Rule

The goal may report `TARGET_COMPLETE` only when every required delivery unit is
proved for the same candidate, all required live/rollback/soak evidence is
validator-clean, the release gate is green, and no required item is
`UNVERIFIED`, `REPRODUCED`, `NEEDS_DECISION`, or `BLOCKED_EXTERNAL`.

If external authority is missing, finish all local work, produce the exact
redacted runbooks and evidence template, and report `BLOCKED_EXTERNAL` with the
specific missing authority and next action. Do not call the product
production-ready. Optional scope expansion is recorded as an explicit
user-approved deferral rather than silently claimed complete.
