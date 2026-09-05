# Long-Horizon Full Completion Goal Prompt

Paste the block below into a Codex `/goal`. It is designed for a persistent run that completes successive verified slices, records a compact restart point, and resumes after compaction or interruption.

````text
You are the long-horizon implementation owner for /home/ycyc/projects/LetheBot.

OBJECTIVE

Bring LetheBot to an evidence-backed, production-ready state as the local-first QQ private/group chatbot defined by the canonical architecture: SnowLuma/NapCat + OneBot gateway, raw-event-first ingestion, durable turn/action traces, governed thick memory, ContextBuilder-owned prompt assembly, Pi reasoning, policy-gated tools/actions, durable workers, operator governance, and verified deployment/operations.

This goal spans many coherent implementation slices. After each slice, verify it, update the active checkpoint, and continue to the next highest-value required item. Do not end merely because a slice or phase passed, a progress report was written, or context was compacted.

The goal ends only when:

1. every required architecture/operations/live-acceptance item is currently proved and the goal status is COMPLETE; or
2. all safe, local, non-secret required work is exhausted and the only remaining conditions are one or more precisely identified NEEDS_DECISION or BLOCKED_EXTERNAL dependencies.

DEFAULT AUTHORIZATION FOR THIS PROMPT

- Commits: not authorized.
- Destructive cleanup/revert of existing work: not authorized.
- Reading or printing local secrets, private QQ/group identifiers, or real user-data chat/log/DB rows: not authorized. Synthetic temp DB assertions and redacted aggregate evidence are allowed.
- Real provider calls, SnowLuma/NapCat/QQ login or interaction, and live acceptance: not authorized until the user explicitly enables the applicable action.

Later user instructions may grant a specific authority. Do not infer one authority from another.

OPERATING CONTRACT

Read and obey `docs/one-shot-full-completion-constraints.md`. For this goal only, it overrides the "one coherent slice, then stop" instruction in `docs/next-codex-constraints.md`; all safety, evidence, privacy, Git, and verification rules remain in force.

On first start, read this control plane:

1. `AGENTS.md`
2. `docs/one-shot-full-completion-constraints.md`
3. `docs/long-running-goal-state.md` if it exists
4. `docs/README.md`
5. `docs/architecture.md`
6. `docs/design-decisions.md`
7. `docs/escalation-checklist.md`

Then read only the canonical domain documents, implementation, and tests relevant to the current requirement. Treat `docs/full-project-gap-analysis.md`, `docs/next-codex-project-state.md`, `docs/long-term-development-direction-review.md`, old phase plans, loop-state files, archive files, and prior summaries as hypotheses or historical evidence, never as proof. Do not use the stale root `prompt.md` as an instruction source.

CURRENT STARTING HYPOTHESES TO REVERIFY

- The worktree contains extensive protected WIP across source, tests, migrations, and docs.
- The credential-free deterministic foundation is broad and was recently reported green, but a new baseline is required.
- Real controlled SnowLuma/QQ private and exact-@bot group acceptance remains unproved.
- Real provider/evaluator/tool-loop evidence, long-duration runtime evidence, packaging/upgrade proof, and selected product-maturity work remain incomplete or weak.
- The current runtime may implicitly fall back to a local `~/deepseek` credential file; audit and remove or explicitly gate that behavior rather than relying on implicit secret discovery.
- Some older phase/status documents describe gaps that current WIP may already have closed.

Do not hardcode old dirty-path counts, test counts, percentages, or phase statuses into current claims.

BOOTSTRAP AND RECOVERY

Run:

```bash
date '+%Y-%m-%d %H:%M:%S %Z %z'
git status --short
git status --short | awk '{ total++; if ($1 ~ /^\?\?/) untracked++; else tracked++ } END { printf "tracked_dirty=%d untracked=%d total=%d\n", tracked+0, untracked+0, total+0 }'
git branch --show-current
git rev-parse --short HEAD
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
pnpm release:check
```

If a deterministic gate fails, do recovery only until it is green. Preserve pre-existing work and add a focused regression test where behavior changed.

If the failure plausibly comes from sandbox restrictions on IPC sockets or localhost listeners, confirm it with an authorized rerun before editing product code. Do not record an environment-only failure as a LetheBot regression.

Create or replace the concise current snapshot in `docs/long-running-goal-state.md` using the checkpoint contract. Do not append command transcripts. Inventory dirty/untracked paths by subsystem without reading sensitive scratch contents, deleting files, or broadly staging anything.

If resuming after interruption or compaction:

1. compare current HEAD/status with the checkpoint;
2. record drift instead of reverting it;
3. read the current slice's domain contract and affected code/tests;
4. re-run the last narrow gate if the slice or relevant paths are not known clean;
5. continue the recorded exact next action before opening a new slice.

FRESH REQUIREMENT AUDIT

Build a compact requirement-to-evidence matrix in the active checkpoint for:

`GW`, `ING`, `TURN`, `ACT`, `MEM`, `CTX`, `PI`, `TOOL`, `WORK`, `GOV`, `OPS`, `LIVE`, and `DOC`.

Break every area into its required subcriteria, then record `UNVERIFIED`, `IN_PROGRESS`, `PROVED`, `BLOCKED_EXTERNAL`, or `DEFERRED_BY_USER` for each subcriterion, plus the best current file/test/DB/live evidence and the exact missing proof. In particular, split compound `ACT`, `OPS`, and `LIVE` behavior; one narrow test or one live flow cannot prove the whole area. A row is `PROVED` only when all of its required subcriteria are individually proved. Inspect existing evidence before implementing. Do not mechanically replay `docs/next-full-implementation-plan.md` or reopen a gap already proved in the current worktree.

SUPERVISOR LOOP

Repeat until a valid stop condition is reached:

1. Select the highest-value actionable required item using this priority:
   - broken deterministic gate;
   - data integrity, privacy, secret leakage, or destructive behavior;
   - missing end-to-end architecture behavior;
   - internal blocker to real acceptance;
   - operations/runtime hardening;
   - non-blocking product maturity.
2. Before editing, write the requirement ID, concrete observed gap, why it is now critical, allowed/protected paths, acceptance criteria, and intended commands into the checkpoint.
3. Define one coherent vertical slice. Prefer a failing regression or another falsifiable before/after check. Do not add abstractions or adjacent features.
4. Implement the minimum architecture-compliant change.
5. Verify narrowly. For persistence work, use a fresh migrated temp SQLite DB and assert durable rows, lifecycle/transaction effects, and clean foreign keys.
6. Run `pnpm typecheck` and `pnpm lint` for TypeScript behavior changes. Run `pnpm release:check` after major/cross-cutting phases and before any completion claim.
7. Inspect the diff, update the requirement matrix and checkpoint by replacement, then continue automatically.

After two consecutive slices in one subsystem, reassess the whole critical path before doing a third. A new slice must close a named requirement, observed failure, or acceptance criterion. Do not substitute endless parser/redaction variants, test-count growth, doc churn, or speculative polish for product progress.

EXECUTION TRACKS

Use these as adaptive tracks, not a stale fixed phase checklist:

Track 0 - Stabilize evidence and protected WIP
- Reconcile worktree ownership and current gates.
- Recover failures without erasing existing changes.
- Keep the active checkpoint concise.

Track 1 - Close deterministic architecture gaps
- Prove the raw event -> chat message -> turn -> context -> decision -> execution chain.
- Close only currently unproved gateway/ingestion/action/memory/context/Pi/tool/worker/governance requirements.
- Require DB-backed evidence for durable behavior and immediate memory lifecycle/privacy exclusions.
- Remove or explicitly gate implicit local credential-file discovery; provider configuration must be explicit, testable, and non-leaking.

Track 2 - Production operations
- Prove health/readiness/metrics non-leakage.
- Exercise backup/restore/retention and rollback on disposable DBs.
- Exercise worker retries, leases, heartbeats, idempotency, and an appropriate synthetic soak.
- Make install/update/recovery runbooks match verified commands and current packaging.

Track 3 - Real provider/evaluator/tool path (opt-in only)
- Keep default tests credential-free.
- When authorized, prove successful and timeout/rate-limit/failure/redaction paths.
- Prove policy/audit behavior around real Pi tool/action proposals.
- Pi must not directly persist durable memory, execute dangerous tools, or deliver platform messages.

Track 4 - Real SnowLuma/QQ acceptance (opt-in only)
- Finish every independent deterministic task before waiting on live access.
- When authorized, use the canonical local-container runbook and neutral `/tmp` evidence paths.
- Prove private reply, group exact-@bot reply, reply semantics, executor delivery, governed-memory influence, privacy isolation, health/readiness/metrics, and clean acceptance DB/FKs.
- Validate the filled evidence with both commands:

```bash
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
```

Track 5 - Final completion audit
- Re-read the stable constraints and relevant canonical contracts.
- For every required matrix subcriterion, cite current implementation, command/test evidence, DB/FK evidence, privacy evidence, live evidence, verification time, and status.
- Finish source, tests, stable docs, runbooks, and audit content; then run `pnpm release:check` with no concurrent edits.
- After it passes, make one evidence-only checkpoint/audit update with the result and final status, run `git diff --check` and (when the checkpoint is untracked) `! rg -n '[[:blank:]]+$' docs/long-running-goal-state.md`, then do not edit again. This metadata update does not invalidate the completed typecheck/lint/test gate.
- Ensure docs/runbooks claim only observed behavior.

NON-NEGOTIABLE PRODUCT INVARIANTS

- Gateway adapts protocols; ingestion writes raw events first.
- Identity mapping, display metadata, and memory are separate.
- Memory writes are governed and source/revision/audit linked.
- ContextBuilder alone owns retrieval boundaries and prompt assembly traces.
- Pi reasons/proposes; policy and executor own authority and side effects.
- `evaluatorPolicy=bypass` never bypasses L0 policy, permissions, sandboxing, audit, or executor checks.
- Tools use registry/permission/sandbox/redaction/audit.
- Workers are durable, idempotent, source-linked, retryable, and observable.
- Disabled/deleted/superseded/expired/secret/prohibited/context-invisible memory is excluded immediately.
- A single group message or third-party judgment does not become another user's active fact.
- Secrets, private platform identifiers, raw chat, unsafe logs, and raw DB rows are never placed in shared evidence or committed files.

STOP AND ESCALATION RULES

- A passed slice, phase checkpoint, progress summary, context compaction, or difficult remaining work is not a stop condition.
- If one branch needs authorization or external state, mark that row and continue other required actionable work.
- Ask for a user decision only for genuine product/security/scope ambiguity or required authority. Include concrete evidence, 2-3 options, and a recommendation.
- After three materially different failed attempts on one issue, checkpoint and re-diagnose the premise before further edits.
- Use `NEEDS_DECISION` only when no safe independent required work remains.
- Use `BLOCKED_EXTERNAL` only when all actionable local/non-secret work is complete and one or more exact missing runtimes, credentials, sessions, authorizations, or services are the only blockers; list them in priority order.
- Use `COMPLETE` only when every required subcriterion is `PROVED`. `DEFERRED_BY_USER` never supports the original production-ready claim; a user-approved scope reduction must be explicit in the final status and wording.

DEFINITION OF COMPLETE

Do not call LetheBot production-ready unless all of the following are proved in the current worktree:

- `pnpm release:check` passes;
- durable event/turn/context/action/tool/job/memory links and failure paths are DB-backed and FK-clean;
- memory creation/lifecycle/retrieval preserve source, revision, audit, scope, visibility, sensitivity, and immediate deletion/disable effects;
- ContextBuilder traces selected/rejected context without cross-scope leakage;
- policy/executor/tool/sandbox/redaction boundaries are enforced on success and failure;
- an explicitly configured real provider completes the required turn/evaluator/tool paths, including bounded failure behavior, without implicit local secret discovery;
- workers and maintenance paths are idempotent, observable, and operationally rehearsed;
- governance can inspect and control memory and explain context/action/tool decisions;
- deployment, health/readiness/metrics, backup/restore/retention, and recovery runbooks are verified;
- real controlled private and group QQ flows produce validator-clean evidence, including allowed governed-memory influence without privacy leakage;
- the final requirement-to-evidence audit has no required `UNVERIFIED`, `IN_PROGRESS`, `BLOCKED_EXTERNAL`, or `DEFERRED_BY_USER` subcriterion under the original objective.

If live authorizations or runtimes are the only remaining blockers, finish the exact redacted runbooks and checkpoint, report `BLOCKED_EXTERNAL`, and list every external dependency and next authorized action in priority order. You may describe the deterministic portion as complete; you must not describe the product as production-ready.

FINAL REPORT

When a valid stop condition is reached, report:

- goal status and why it satisfies the stop contract;
- requirement matrix summary;
- files changed, grouped by subsystem;
- commands run and current pass/fail results;
- DB/FK, privacy/redaction, operations, and live evidence status;
- explicit user-approved deferrals or external blockers;
- the ordered next authorized action or actions if status is not COMPLETE.
````
