# Long-Horizon Full Completion Constraints

**Purpose:** operating contract for a long-running Codex goal that advances LetheBot through many independently verified slices, survives context compaction or interruption, and stops only at a proved completion state or a genuine external blocker.

This document supplements `AGENTS.md` and the canonical architecture documents. For a goal that explicitly references this file, it overrides only the "one slice, then stop" rule in `docs/next-codex-constraints.md`. Its evidence, safety, privacy, Git, and quality rules still apply.

## 1. Authority and Interpretation

Use this precedence order:

1. the user's latest explicit instruction and authorization;
2. `AGENTS.md`, security/privacy constraints, and non-destructive workspace rules;
3. this long-horizon operating contract;
4. canonical target behavior in `docs/README.md`, `docs/architecture.md`, `docs/design-decisions.md`, and the linked domain documents;
5. current code, tests, DB behavior, and command output as evidence of what exists now;
6. active state, handoff documents, gap analyses, roadmaps, and archived material as fallible clues.

Code does not silently override the intended architecture, and architecture prose does not prove that code implements it. When they conflict, record the conflict, establish current behavior with evidence, then either make the smallest compliant change or escalate a genuine product/security decision.

Historical completion claims, old test counts, skipped live tests, estimates, and prior assistant summaries are never completion evidence.

## 2. Goal Scope

The required product is a production-ready, local-first QQ private/group chatbot through SnowLuma or NapCat and OneBot, with:

- a modular-monolith implementation of the documented logical boundaries;
- raw-event-first ingestion and a traceable turn/action lifecycle;
- thick governed memory with scope, source, confidence, revision, audit, lifecycle, privacy, and immediate deletion/disable effects;
- ContextBuilder-owned retrieval, filtering, ranking, budgeting, prompt assembly, and explainability;
- Pi reasoning behind mockable adapters, with policy-gated tool and action proposals;
- durable, idempotent, observable background work;
- owner/admin governance through the CLI, including memory lifecycle and `/why`-equivalent inspection;
- health, readiness, metrics, backup, restore, retention, deployment, and operator runbooks;
- controlled real private/group QQ acceptance evidence that passes the repository validators.

Unless the user explicitly expands scope, the following are not completion blockers:

- multi-platform support;
- microservices, Redis, or distributed infrastructure;
- a rich web governance UI when the required CLI workflows are usable;
- a standalone binary/GUI installer when the supported source/container install, update, rollback, and recovery procedures are verified;
- a full knowledge graph, embeddings, or a vector pipeline;
- perfect autonomous memory extraction;
- multi-agent product orchestration;
- speculative tools, platform-admin features, or visual polish without an acceptance requirement.

Current planning evidence suggests the deterministic foundation is substantial. The critical unproved areas are live SnowLuma/QQ behavior, real provider/evaluator/tool loops, long-running runtime evidence, packaging/operations proof, and selected product-maturity gaps. Treat that as a starting hypothesis and re-audit it; do not replay an old phase plan mechanically.

## 3. Long-Horizon Execution Model

Long-running does not mean one large unverified change. Work in coherent vertical slices and run this supervisor loop:

1. Reconcile the active checkpoint with the current HEAD and worktree.
2. Select the highest-value required item that is not proved and is currently actionable.
3. State the slice's requirement ID, observed gap, allowed paths, acceptance criteria, and verification commands before editing.
4. Add or identify a failing regression test when behavior changes; for docs/ops evidence, define an equivalent falsifiable check.
5. Make the minimum change that closes the stated gap.
6. Run narrow verification, then the applicable phase gate.
7. Inspect the diff and update the active checkpoint by replacement, not by appending a transcript.
8. Immediately select the next slice. A checkpoint or phase report is not a reason to end the goal.

Continue across context compaction, phase boundaries, and successful slice reports. Stop only under Section 12.

## 4. Active Checkpoint Contract

Use exactly one mutable checkpoint: `docs/long-running-goal-state.md`. Create it during bootstrap if it does not exist. It is operational state, not a completion certificate.

Keep it concise and replace the current snapshot instead of accumulating a chronological log. It must contain:

- `updated_at`, `goal_status`, current branch, and current HEAD;
- tracked-dirty and untracked counts, plus protected/unknown path groups;
- baseline commands with timestamp, scope, and exit status, without pasted logs or durable test-count claims;
- current requirement ID, phase/track, and slice;
- why this is the highest-value actionable item;
- slice acceptance criteria and allowed/protected paths;
- evidence completed: command, scope, exit status, and relevant file/DB/live artifact;
- blockers or user decisions, including the exact missing authority/input;
- the exact next action and next command;
- a compact requirement matrix and live-acceptance status.

Use these requirement IDs in the matrix:

| ID | Area |
|---|---|
| `GW` | OneBot gateway and platform capabilities |
| `ING` | ingestion, raw events, identity, and persistence integrity |
| `TURN` | durable turn and failure lifecycle |
| `ACT` | attention, evaluator, action decisions, executor, and delivery |
| `MEM` | governed memory lifecycle and privacy |
| `CTX` | context orchestration and explainability |
| `PI` | Pi/provider runtime behavior |
| `TOOL` | registry, permission, sandbox, redaction, and tool audit |
| `WORK` | jobs, workers, retries, leases, heartbeats, and idempotency |
| `GOV` | operator governance and review workflows |
| `OPS` | deployment, health, backup/restore, retention, soak, and packaging |
| `LIVE` | controlled real provider and SnowLuma/QQ acceptance |
| `DOC` | current documentation and final evidence audit |

Each area row is a container, not a single checkbox. Split it into all required subcriteria before assigning status. For example, `ACT` separately tracks attention, evaluator, decision persistence, executor enforcement, and delivery evidence; `OPS` separately tracks deployment, health/readiness, backup, restore, retention, soak, update/rollback, and packaging/runbooks; `LIVE` separately tracks the real provider, evaluator/tool path, private QQ, group QQ, governed-memory/privacy flow, DB integrity, and both validators.

Subcriterion status is one of `UNVERIFIED`, `IN_PROGRESS`, `PROVED`, `BLOCKED_EXTERNAL`, or `DEFERRED_BY_USER`. A row is `PROVED` only when every required subcriterion is individually `PROVED` with current evidence. One unit test, one private flow, or one successful command cannot prove a compound area.

`DEFERRED_BY_USER` requires an explicit scope decision and never counts as evidence for the original production-ready objective. If the user removes a required subcriterion, the final report must describe the resulting narrower goal rather than claiming the original full scope.

Update the checkpoint after bootstrap, before a risky or broad edit, after every slice, after any gate failure, before requesting external authority, and before any expected interruption or compaction.

## 5. Cold Resume Protocol

After interruption, compaction, or a fresh worker starts:

1. Read `AGENTS.md`, this file, `docs/long-running-goal-state.md` if present, `docs/README.md`, `docs/architecture.md`, and `docs/design-decisions.md`.
2. Compare the recorded branch/HEAD/worktree summary with current `git status`. Treat drift as new user or prior-worker work; never overwrite or revert it silently.
3. Read only the canonical domain documents and source/tests for the current slice.
4. If relevant paths drifted or the last slice lacks verification, re-run its narrow gate.
5. Resume the recorded exact next action. Do not open a new slice while an earlier slice remains partially edited or unverified.

Do not reread every long document at every micro-step. Re-read a domain document when entering that domain, when its contract may have changed, or before making a completion claim about it.

## 6. Critical-Path and Anti-Loop Rules

Select work in this order unless evidence justifies another order:

1. recover a red deterministic gate;
2. fix a data-integrity, privacy, secret-leakage, or destructive-behavior risk;
3. close a required end-to-end architecture gap;
4. remove an internal blocker to live acceptance;
5. harden operations and real-runtime behavior;
6. improve non-blocking product maturity.

Every implementation slice must close a matrix item, reproduce/fix an observed failure, or satisfy a named acceptance criterion. More test cases, lines changed, and parser/redaction variants are not progress by themselves.

After two consecutive slices in one subsystem, reassess the whole requirement matrix and critical path before selecting a third. Continue in the same subsystem only when it still blocks a higher-priority requirement or closes a demonstrated regression/security class.

Do not implement optional architecture, abstractions, UI, integrations, or configurability to make the goal appear more complete. Do not turn logical module boundaries into microservices.

## 7. Architecture Invariants

- **Gateway:** adapts OneBot/QQ protocols, send/receive, normalization, reconnect, and capability reporting only. It does not retrieve memory or build prompts.
- **Ingestion:** persists `raw_events` before derived records. Raw events remain audit roots; duplicate/error handling is observable.
- **Identity:** canonical identity, platform account mapping, display metadata, and user memory remain separate. Platform IDs enter prompts only when purpose-bound, minimal, and structured.
- **Attention:** is a fast deterministic classifier that emits signals/candidates. No group trigger forces a reply; cooldown downgrades outward behavior and never discards the source event.
- **Memory:** Pi, evaluators, and workers propose. Governed services perform durable writes with source/revision/audit evidence and lifecycle enforcement.
- **Context:** ContextBuilder owns retrieval, boundary filtering, ranking, token budgeting, prompt assembly, and selected/rejected trace evidence. Visibility filtering occurs before bounded limits.
- **Pi:** reasons and proposes. It does not directly write durable state, deliver platform messages, or execute dangerous tools.
- **Evaluator/policy:** evaluator output is structured and has no direct execution authority. `bypass` skips only LLM review, never L0 policy, permissions, sandboxing, audit, or executor checks.
- **Executor:** is the final boundary for social, memory, tool, job, and platform side effects and records success, downgrade, rejection, or failure.
- **Tools:** all tools use registry metadata, permission checks, evaluator policy, sandbox policy, output sensitivity, redaction, and audit.
- **Workers:** are durable, idempotent, source-linked, retryable, and observable; an extractor is not automatically the original source.
- **Governance:** can inspect, explain, disable, delete, restore, and supersede governed state with revision/audit evidence.

The target audit chain is `raw event -> chat message -> turn -> context -> decision -> execution`, with related memory, tool, job, and worker evidence linked where applicable.

## 8. Data and Privacy Invariants

1. Enable SQLite foreign keys in persistence tests and prove `PRAGMA foreign_key_check` is clean for affected flows.
2. `chat_messages.raw_event_id` references a real raw event unless a canonical, tested synthetic-event strategy explicitly permits otherwise.
3. A durable memory write atomically preserves `memory_records`, usable `memory_sources`, `memory_revisions`, relevant `audit_log`, and FTS behavior.
4. Memory `scope`, `visibility`, `sensitivity`, `authority`, and `source_context` remain distinct policy dimensions.
5. Deleted, disabled, superseded, expired, secret, prohibited, or context-invisible records are excluded from ordinary retrieval/search immediately.
6. A single group message, a third-party judgment, or a group conflict does not become another user's active fact. Group-derived evidence keeps its source context and conservative visibility.
7. Display names/group cards are untrusted labels, not instructions. Full account tables, nickname history, raw audit traces, and unrelated scopes do not enter ordinary prompts.
8. Secrets, credentials, cookies, private keys, recovery codes, QR codes, private platform identifiers, raw chat text, and unsafe tool output do not enter committed files, ordinary memory, shared evidence, or unredacted logs/audit output.
9. Runtime and tests do not implicitly discover or read local credential files. Provider secrets require explicit configuration and the applicable authorization; fallback paths must not silently read files such as `~/deepseek`.
10. Failure paths for events, turns, actions, tools, jobs, and workers are durable, bounded, redacted, and FK-clean.

## 9. Worktree, Git, and Delegation

1. Inventory tracked and untracked changes by subsystem before editing. Existing changes are protected WIP.
2. Do not read sensitive scratch content merely to classify it. Do not delete, revert, stage, or overwrite unknown work.
3. Do not commit unless the user explicitly authorizes commits for this goal. Never use broad staging.
4. Never commit `.env`, logs, SQLite DBs, live evidence containing private identifiers, generated credentials, cookies, QR codes, or local secret files.
5. Treat dependency and lockfile changes as reviewed code.
6. Parallel agents may perform independent read-only audits. Concurrent edits must have disjoint path ownership. The primary agent inspects every resulting diff and independently runs the relevant gates.

## 10. Verification Gates

Bootstrap gate:

```bash
date '+%Y-%m-%d %H:%M:%S %Z %z'
git status --short
git status --short | awk '{ total++; if ($1 ~ /^\?\?/) untracked++; else tracked++ } END { printf "tracked_dirty=%d untracked=%d total=%d\n", tracked+0, untracked+0, total+0 }'
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
pnpm release:check
```

If typecheck, lint, deterministic tests, or diff checks fail, perform recovery before feature expansion.

If a gate failure plausibly comes from execution restrictions such as denied IPC sockets or localhost listeners, reproduce it in an authorized environment before changing product code. Record the restricted-environment result and the confirming rerun separately; do not misclassify an environment failure as a product regression.

During work:

- docs-only: validate links/commands touched as applicable and run `git diff --check`;
- behavior change: run a focused failing-first regression, then the relevant test file/subsystem suite;
- TypeScript change: run focused tests plus `pnpm typecheck` and `pnpm lint`;
- persistence change: use a fresh migrated temp SQLite DB, assert rows/transactions/lifecycle effects, and assert clean FKs;
- major phase or cross-cutting change: run `pnpm release:check`;
- real provider/platform checks: keep them opt-in and separate from the credential-free default suite.

Do not weaken, skip, or delete a test merely to make a gate green unless the test contradicts a confirmed canonical decision; record that reasoning when it occurs.

## 11. External Runtime and Acceptance

Live provider, SnowLuma/NapCat, QQ interaction, secrets, account login, network-changing operations, destructive cleanup, and commits require the applicable user authorization. Authorization for one class of action does not imply another.

When authorized, real SnowLuma/QQ completion evidence must prove:

- a private reply loop and a group exact-`@bot` reply loop;
- mention and reply-to-bot semantics;
- delivery through the action executor/response path, linked to the durable turn/context/action evidence;
- an allowed governed memory affecting an answer, with usable scope-compatible source/revision evidence and no private cross-scope leakage;
- healthy health/readiness and non-leaking metrics/operator output;
- clean acceptance-DB integrity and foreign keys;
- redacted evidence at a neutral `/tmp` path that passes both:

```bash
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
```

FakeOneBot, `release:check`, `ops:doctor`, `verify:onebot`, or an unfilled template does not substitute for this live proof.

## 12. Status, Escalation, and Stop Conditions

Goal status is exactly one of:

- `ACTIVE`: actionable required work remains;
- `NEEDS_DECISION`: a user product/security/scope decision is required and no safe independent required work remains;
- `BLOCKED_EXTERNAL`: all actionable local work is complete and one or more precisely listed runtimes, credentials, account sessions, authorizations, or external services are the only remaining blockers;
- `COMPLETE`: every required criterion is proved by current evidence.

Escalate ambiguous product thresholds, conflicting canonical decisions, platform-admin classification, retention/privacy policy, destructive cleanup, commit authorization, and live-secret/runtime use. Routine implementation choices and clear bug fixes do not require escalation.

One blocked branch does not stop the whole goal. Record it, continue other required work, and return when it becomes the critical path. After three materially different failed attempts at the same issue, stop patching, checkpoint the evidence, re-diagnose the premise, and escalate only if the remaining ambiguity truly requires the user or external state.

Do not end because a slice passed, a phase report was written, context was compacted, progress is substantial, or the remaining work is difficult. Do not claim `BLOCKED_EXTERNAL` while meaningful deterministic, documentation, runbook, or non-secret verification work remains.

## 13. Completion Contract

Before `COMPLETE`, produce a final requirement-to-evidence audit. Every required matrix subcriterion must be `PROVED` and include:

- implementation files and the architecture contract they satisfy;
- current tests/commands and timestamps;
- DB/transaction/FK evidence for persistence behavior;
- privacy/redaction evidence for user, platform, memory, tool, and operator data;
- live evidence for provider/platform requirements;
- remaining risks that are explicitly non-goals, not silently deferred requirements.

At minimum, `pnpm release:check` passes in the final worktree; memory lifecycle and retrieval exclusions are proved; action/tool/job failures are observable and redacted; governance can inspect and modify governed memory and explain context/action decisions; backup/restore/retention and runbooks are verified; and the real private/group QQ evidence passes both validators.

Use this non-recursive finalization sequence:

1. Finish implementation, stable documentation, runbooks, and the requirement audit content. Leave goal status `ACTIVE` while final verification is pending.
2. Run `pnpm release:check` without concurrently editing the worktree.
3. If it passes, perform one evidence-only update to the checkpoint/final audit with the result and final status. Do not change source, tests, configuration, contracts, or behavior claims in this step.
4. Run `git diff --check`. If the checkpoint is still untracked, also run `! rg -n '[[:blank:]]+$' docs/long-running-goal-state.md`. Do not edit again after these checks.

The evidence-only metadata update in step 3 does not invalidate the completed typecheck/lint/test gate; the post-update diff check closes the documentation hygiene check without recursively rewriting the checkpoint.

If live authorizations or runtimes are unavailable after all other work is complete, finish the exact redacted runbooks and checkpoint, set `BLOCKED_EXTERNAL`, and list the external dependencies and next authorized actions in priority order. The deterministic implementation may be described as complete, but the product must not be called production-ready.
