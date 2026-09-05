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

Writing this contract and its goal prompt delivers the planning artifacts; it
does not launch implementation or prove any product capability. When the user
launches the implementation goal, the entire default target above is required.

### Execution Dependencies

Phase numbers are stable requirement identifiers, not an instruction to finish
P9 before V1-V3. Reconcile the checkpoint with the current worktree first, retain
proved behavior, and implement only the remaining gaps in this order:

1. Recover any failing baseline or required security, persistence, and runtime
   foundations in P0-P3 and P5-P8.
2. Complete V1, then V2, then V3, including their governance, operations, and
   cross-module integration. A blocked live check does not block this local work.
3. Freeze the complete candidate and run P4, the live part of P6, and P9 against
   that candidate. Earlier live canaries are useful diagnostics, but are not
   final evidence for a later build.
4. Audit every required delivery row and hand off the release. If runtime,
   schema, dependencies, or effective configuration change during acceptance,
   identify a new candidate and repeat the required final acceptance and soak.

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

Required scenarios:

- Explicit first-party teaching retains the complete workflow and its canonical
  source; quotations, third-party claims, questions, and ordinary examples do
  not become instructions. Repeated-evidence learning has a documented threshold
  and exact source set; replayed events do not count as independent evidence.
- Private and group teaching obey their different activation and visibility
  policies. A selected procedure influences an allowed follow-up ContextPack
  and its trace, including after restart; an incompatible user/group sees none.
- Inspect, revise, approve/reject/expire, disable/delete/restore/supersede, and
  rollback use the existing governance authority. Retry or concurrent learning
  cannot duplicate a procedure or reactivate a deleted/rejected one.
- Writer and retrieval controls work independently, including queued work,
  disable/reenable, and ordinary fact fallback. Historical sources, revisions,
  and audits survive these controls and lifecycle operations.

### Semantic Retrieval (`DEL-V2`)

Semantic retrieval is an additional ranking signal, never the source of truth.
The design must preserve FTS/structured fallback when the embedding provider is
unavailable, must version model and index metadata, and must apply scope,
visibility, lifecycle, sensitivity, and ownership filters before ranking and
limits. Rebuilding or changing an index must not mutate memory truth or bypass
governance. Provider failures, timeouts, unknown dimensions, and stale indexes
must have bounded, observable outcomes.

Required scenarios:

- Run the same versioned synthetic corpus and queries with FTS-only and semantic
  retrieval under identical count/token budgets. Include paraphrases without
  shared keywords, lexical matches, irrelevant distractors, and forbidden
  scopes. Freeze expected source IDs, `k`, and the corpus digest before tuning;
  report recall@k for each query class. Semantic retrieval must recover eligible
  paraphrase sources missed by FTS without regressing the lexical baseline;
  forbidden selections and token-budget violations must remain zero.
- Fixed synthetic vectors prove deterministic ranking and failure behavior;
  they do not prove embedding quality. Also run the corpus through the supported
  real embedding model, locally or through an authorized provider, and record
  model/version, dimensions, latency, and bounded resource usage. The default
  test suite remains offline and credential-free.
- Content edits, disable/delete, policy changes, and index/model changes cannot
  expose stale content. Rebuild, cancellation, retry, and restart converge;
  failure or feature disable returns to the governed FTS/structured path.
- Record the local storage/model choice and any remote text-egress boundary.
  Existing chat-provider configuration alone must not silently enable remote
  embedding of the memory store. Schema, index backup/restore, and rollback
  follow the existing migration and operations contracts.

### Reflection and Importance (`DEL-V3`)

Reflection is a proposal-producing background capability. It may summarize
patterns, identify conflicts, or recommend importance changes, but it cannot
directly rewrite an active memory. Each proposal needs a stable ID, exact source
set, reason, score inputs, confidence, scope, and expiry. Apply, reject, expire,
retry, concurrent review, and rollback must be auditable and idempotent.

Required scenarios:

- A bounded, source-backed interaction window creates a reflection or importance
  proposal with versioned scoring inputs and a reason. A copied literal score
  or pre-existing maintenance scan alone does not prove long-term learning.
- Insufficient evidence, third-party claims, revoked/deleted sources, opted-out
  scopes, and conflicting evidence cannot produce an unauthorized active fact
  or broaden visibility. Revalidate source and revision evidence on apply.
- Inspection, review, apply, reject, expire, concurrent review, restart/retry,
  and rollback retain one transactional source/revision/audit chain. Before
  approval, active memory and its governed ranking remain unchanged.
- Approval has an explainable effect on an eligible later ContextPack; rollback
  restores the prior governed behavior. Disable controls stop new learning or
  application without destroying history or preventing ordinary conversation.

Each capability needs focused tests at its actual implementation boundaries
plus an end-to-end scenario through the production application wiring. Record
the exact test paths and commands in the checkpoint when the slice is selected;
existing generic memory tests or a `procedure`/`reflection` type literal cannot
stand in for these scenarios. Use fresh migrated synthetic databases, including
restart and concurrent-connection checks where durable behavior is involved.

## 4. Evidence and Release Requirements

The final evidence set must be tied to one immutable candidate release. Record
the source revision or frozen source snapshot (including intended uncommitted
files), lockfile and managed-release digests, schema compatibility, and a
redacted effective-configuration fingerprint. A dirty worktree's HEAD alone
does not identify its build. Creating a frozen local artifact does not require
commit/push authority.

Shared runtime evidence may contain only aggregate values, booleans, status
enums, bounded timings, hashes, counts, and redaction markers. It must not
contain credentials, raw chat, real QQ/group/message IDs, private database rows,
cookies, QR/session data, or private file paths. Public repository/test paths
and synthetic fixture references may appear in the requirement matrix.

At minimum, run the local gates and disposable rehearsals below. They require
the locked dependencies and a supported Node/pnpm toolchain; `release:check`
builds the application used by the rollback rehearsal. Omit `--db` on the
rehearsal and soak commands so they allocate their own disposable databases.

```bash
pnpm release:check
pnpm smoke
pnpm test:coverage
pnpm ops:rehearse-maintenance
pnpm ops:rehearse-rollback
pnpm ops:rehearse-application-rollback
pnpm ops:worker-soak -- --duration-ms=3600000 --interval-ms=1000
```

Build the distinct immutable prior and candidate managed releases using
[`operations.md`](operations.md), then run:

```bash
pnpm --silent ops:rehearse-cross-version -- \
  --prior-release="${LETHEBOT_PRIOR_RELEASE:?set the immutable prior release directory}" \
  --candidate-release="${LETHEBOT_CANDIDATE_RELEASE:?set the immutable candidate release directory}"
```

For authorized live acceptance, select the exact acceptance database explicitly;
do not let `ops:doctor` fall back to an unrelated configured database. The
`LETHEBOT_*` variables in these examples are shell inputs for the commands,
not new application configuration settings.

```bash
pnpm acceptance:evidence-template -- --out=/tmp/lethebot-acceptance-evidence.md
pnpm ops:doctor -- --db="${LETHEBOT_ACCEPTANCE_DB:?set the authorized acceptance database path}"
pnpm acceptance:db-summary -- --db="${LETHEBOT_ACCEPTANCE_DB:?set the authorized acceptance database path}" --require-acceptance-hints
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
```

Fill the template only from observed results of the P4 matrix and the runbook in
[`local-container-acceptance.md`](local-container-acceptance.md). Creating and
validating an empty template is a local check: the default validator should pass
and `--require-complete` should fail. Preserve existing evidence files instead
of overwriting them on resume. Live actions and private database access require
their corresponding authority. Every persistence run must finish with an empty
`PRAGMA foreign_key_check` result.

### Evidence Coverage

The current `src/scripts/local-acceptance-evidence.ts` validator checks redaction
and the shape/values of its controlled QQ acceptance checklist. It does not run
commands, authenticate attestations, prove V1-V3, or measure a 72-hour soak.
Its `--require-complete` success is necessary for that checklist and insufficient
for the overall target. Keep the following evidence separately linked from the
single checkpoint; do not insert arbitrary fields into the strict template:

| Evidence | What it must prove |
|---|---|
| Per-requirement record | `DEL-*` ID and criterion, status, candidate digest, verification time, command/test and exit status, observed result, artifact reference, and exact remaining gap. |
| V1-V3 results | Every scenario in section 3, with synthetic source-chain/DB/trace assertions and actual embedding quality evidence identified separately. |
| Operational rehearsal | Prior/candidate digests, compatibility, backup/restore and cross-version results, integrity/FK checks, and recovery outcome. |
| Real soak | Start/end and elapsed time covering at least 72 hours, sampled counters and SLO values, planned restart and fault/recovery timeline, and each P9 zero-tolerance result. A one-hour worker soak is a different check. |

An artifact digest establishes identity, not correctness. Inspect the underlying
results for every criterion. A missing, stale, or only indirectly covered
criterion remains unverified even when a command or validator is green.

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
Goal status: ACTIVE | TARGET_COMPLETE | BLOCKED_EXTERNAL | NEEDS_DECISION
Candidate: <immutable release identifier>
Prior release: <immutable release identifier>
Scope: default QQ core | explicitly expanded scope
Authority: <applicable grants and remaining external actions>

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
