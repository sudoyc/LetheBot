# Long-Term Development `/goal` Prompt

下面整段可直接作为 LetheBot 下一阶段长期开发 `/goal`。默认允许本地代码、测试和文档工作；commit、push、真实 Provider/QQ、部署和 private data 操作分别需要明确授权。
启动时使用下方完整 prompt，并按实际授权调整 flags；后续恢复同一 goal 时保留
仍适用的用户授权。生成本文不等于启动实现，完成标准见
[交付契约](../long-term-development-delivery.md)。

````text
You are the long-term implementation owner for /home/ycyc/projects/LetheBot.

OBJECTIVE

Advance LetheBot from its current deterministic-ready local state to an
evidence-backed, production-ready local-first QQ private/group chatbot. Execute
the stable P0-P9 operational program and the original-vision core product
phases V1-V3 in docs/long-term-development-constraints.md, using the delivery
units and handoff contract in docs/long-term-development-delivery.md. The
default target includes governed episodic, semantic, procedural, and reflective
memory; ContextBuilder-owned retrieval and prompt assembly; policy-gated tools;
durable workers; owner/admin governance; and release, rollback, restore, and
long-soak evidence.

This is a persistent implementation goal, not a planning-only pass. Continue through independently actionable slices until TARGET_COMPLETE or until every safe local/non-secret item is exhausted and one exact NEEDS_DECISION or BLOCKED_EXTERNAL condition remains. A passed test file, one phase, BASIC_USABLE, a progress report, context compaction, or difficult remaining work is not a stop condition.

AUTHORITY FLAGS

Use these defaults unless the user who launches or updates this goal explicitly changes an individual flag:

- LOCAL_CODE_TEST_DOCS=AUTHORIZED
- SYNTHETIC_TMP_EVIDENCE=AUTHORIZED
- COMMITS=NOT_AUTHORIZED
- PUSH=NOT_AUTHORIZED
- LIVE_PROVIDER=NOT_AUTHORIZED
- LIVE_QQ=NOT_AUTHORIZED
- LIVE_DEPLOYMENT_OR_RESTART=NOT_AUTHORIZED
- PRIVATE_DB_OR_RAW_CHAT_READ=NOT_AUTHORIZED
- DESTRUCTIVE_CLEANUP_OR_REVERT=NOT_AUTHORIZED
- SCOPE_EXPANSION=NOT_AUTHORIZED

One authorization never implies another. Commit authorization does not imply push. Read-only runtime inspection does not imply provider, QQ, container, deployment, credential, or private-row access. Never print or persist credential values while proving that configuration exists.
Preserve applicable explicit user authorization across continuation, compaction,
and interruption of this goal. Unrelated archived tasks and old runtime evidence
do not authorize new actions. Missing publication or live authority does not
prevent independent local implementation and verification.

CONTROL PLANE AND READING ORDER

Before the first change, read in this order:

1. AGENTS.md
2. docs/long-term-development-constraints.md
3. docs/long-term-development-delivery.md
4. docs/long-running-goal-state.md
5. docs/README.md
6. docs/architecture.md
7. docs/design-decisions.md
8. docs/security-privacy.md
9. docs/test-strategy.md
10. docs/operations.md
11. docs/local-container-acceptance.md
12. only the canonical domain docs, source, tests, schema, and migrations needed by the selected slice

Treat docs/long-term-development-constraints.md as the stable program and safety
contract, docs/long-term-development-delivery.md as the stable delivery and
handoff contract, and docs/long-running-goal-state.md as the only mutable
checkpoint. Stable product decisions belong in docs/design-decisions.md;
behavior contracts belong in their owning canonical docs.

Treat the archived gap analysis, direction review, superseded plan, old goal
prompts, loop states, completion reports, test counts, percentages, runtime IDs,
and prior summaries under `docs/archive/` as hypotheses or historical evidence
only. Never create a second current roadmap, status log, or checkpoint.

CURRENT STARTING PRIORITY TO REVERIFY

- Reconcile `docs/long-running-goal-state.md` with a fresh deterministic gate
  before changing code or status.
- The local P0-P3 and P5-P9 contracts are recorded as deterministic-ready; do
  not reopen those phases without a new failure or contradictory evidence.
- V1-V3 are required core-product phases. Reverify their actual state using the
  checkpoint, code, and the scenario contract in the delivery document;
  do not assume an earlier partial implementation completes a phase.
- The next local product slice is the earliest incomplete V1-V3 unit; the next
  external proof remains the P4/P6/P9 acceptance matrix: authorized Provider/QQ
  behavior, controlled restart/restore/rollback, and a real soak.
- Do not infer live readiness from mocks, healthy containers, historic samples,
  or an archived handoff. If a new local issue is found, reproduce it with a
  focused deterministic test and update the owning canonical document.

COLD START AND RESUME

Run:

```bash
date '+%Y-%m-%d %H:%M:%S %Z %z'
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
pnpm release:check
```

On a cold start:

1. Reconcile HEAD/status with the checkpoint without deleting, resetting, reverting, staging, or overwriting unknown work.
2. If the baseline is red, do recovery only until deterministic gates are green. Add a focused regression for a real behavior defect; do not patch around an environment-only listener/IPC restriction.
3. Replace the concise snapshot in docs/long-running-goal-state.md with current branch/HEAD/worktree, authority flags, baseline result, selected phase/slice, requirement ID, allowed/protected paths, assertions, commands, rollback boundary, and exact next action.
4. Start at the earliest incomplete phase. Do not reopen a phase whose current exit criteria are already proved, but do not inherit a completed status without checking its cited evidence against the current worktree.

On resume after compaction/interruption:

1. Compare HEAD/status with the checkpoint and record drift instead of reverting it.
2. Re-read the selected phase section and its domain contract.
3. Re-run the last narrow gate when the slice or relevant paths are not known clean.
4. Continue the recorded exact next action before selecting new work.

STATUS VOCABULARY

Use only UNVERIFIED, REPRODUCED, DETERMINISTIC_READY, LIVE_PROVED, PHASE_COMPLETE, NEEDS_DECISION, BLOCKED_EXTERNAL, and TARGET_COMPLETE as defined in the constraints. Green deterministic tests never imply live proof. A checkpoint statement is not proof unless it cites current command/file/DB/live evidence.

PHASE PROGRAM

Use phase IDs as stable references, with this dependency order:

1. Reconcile P0, then repair any remaining P1-P3 and P5-P8 foundation gaps.
2. Complete V1 -> V2 -> V3 and their integration into governance and operations.
3. Freeze the full candidate, then finish P4, P6 live checks, and P9 acceptance.
4. Audit and deliver that same candidate. Product/schema/dependency/effective
   configuration changes require a new candidate and final acceptance/soak.

Preparatory P4 canaries and P9 disposable rehearsals may run earlier when their
prerequisites are satisfied. P9 cannot finish before V1-V3. Missing P4 authority
never blocks independent local V1-V3 work. The sections below retain their IDs;
they are not instructions to redo already-proved phases.

P0 - Fresh baseline and failure reproduction
- Rebaseline the repository.
- Reproduce or disprove each starting risk.
- Build a compact requirement/gap matrix and select the earliest incomplete
  requirement; select a P1 regression only when an actual security gap remains.
- Make no production, schema, dependency, or live change in this phase.

P1 - Ingress trust, request bounds, and privacy-safe logs
- Default to loopback. Expose reverse HTTP events only for HTTP transport or an
  explicit enable; fail closed for tokenless non-loopback event ingress.
- Reject requests with no usable auth before body buffering where possible.
- Use a default 262144-byte body limit and 5000-ms body deadline; bound both
  Content-Length and streamed bytes and handle abort/error/slow/oversize bodies
  without duplicate responses or partial DB/governance effects.
- Validate Bearer or bounded SnowLuma HMAC input.
- Replace full-event logs with bounded metadata and cover 5-12 digit platform identifier redaction.
- Update deployment, environment, security, and tests to the same contract.

P2 - Scheduling fairness, conversation concurrency, and deadlines
- P2A: isolate or prioritize delayed Attention/interactive jobs so maintenance backlog cannot starve them; prove lease/retry/shutdown behavior with deterministic clocks.
- P2B: remove shared mutable Pi turn context; preserve one-at-a-time
  per-conversation FIFO while allowing 2 cross-conversation turns by default
  (hard configuration maximum 16) and at most 128 queued turns.
- Start an absolute deadline at queue admission and include provider/tool/abort cleanup.
- Keep P2A and P2B independently reversible. Put any required migration in its own slice.

P3 - Pi invocation ledger and usage observability
- Add source/turn-owned pi_turn model invocation evidence for every provider request, including tool follow-ups and corrections/retries.
- Extract typed provider usage where available; store unknown as unknown, never as fabricated zero.
- Record queue/provider/total latency, terminal status, bounded failure code, and recovery of stale running entries without prompt/response leakage.
- Reconcile agent-turn totals, metrics, CLI, and later UI to the same ledger semantics.
- If schema changes, prove fresh DB, sequential upgrade, backup/restore, old/new compatibility, and cross-version rollback in a separate migration slice.

P4 - Controlled QQ/provider acceptance
- Run only after explicit LIVE_PROVIDER, LIVE_QQ, and applicable LIVE_DEPLOYMENT_OR_RESTART authority.
- Use the exact LIVE-PRI-01, LIVE-GRP-01, LIVE-QUOTE-01, LIVE-RAPID-01, LIVE-MEM-01, LIVE-GOV-01, LIVE-TOOL-01, and LIVE-OPS-01 matrix in the constraints.
- Keep all filled evidence aggregate-only under /tmp and run both validators.
- Restore the prior verified release on any attribution, isolation, privacy, auth, unsupported-memory-claim, or direct-trigger loss.
- If authority is absent, mark only P4 BLOCKED_EXTERNAL and continue independent P5-P8 work.

P5 - Governed memory maintenance
- Turn conflict/consolidation/decay scans into stable proposals and explicit review/apply/rollback flows.
- Preserve owner/scope/source/timestamp/confidence/lifecycle/revision/audit evidence.
- Never let a scan worker directly mutate active memories.
- Make disable/delete/supersede/policy disable affect retrieval immediately.
- Prove idempotent retry, stale review, concurrent review, restart, and rollback.

P6 - Useful product tool catalog
- Audit implemented vs registered vs permitted vs live-proved tools.
- Deliver the first bounded catalog from the constraints: governed memory/group summary, read-only runtime status, workspace-root read/list, and allowlisted bounded fetch.
- Require prepared effect plus explicit approval for write/delete/network side effects.
- Keep shell, credential access, and platform-admin exposure outside the default phase scope.
- Prove permission, evaluator, sandbox, path/network, timeout, output limit, redaction, audit, effect, retry, and rollback behavior.

P7 - Behavior-preserving application decomposition
- Add characterization tests first.
- Extract, one responsibility at a time: HTTP server, ingress admission/recovery, turn application service, background runtime, then the composition root.
- Do not mix behavior, schema, dependencies, tool features, UI, or broad formatting into an extraction slice.
- End with no domain SQL or turn pipeline in the composition root and no duplicate production path.

P8 - Local governance experience
- Define operator tasks/information architecture, then select the smallest reviewed frontend dependency strategy.
- Bind loopback by default and use an HTTP admin session/CSRF boundary independent of QQ roles.
- Build memory/review, source/revision detail, why trace, model/tool/job health, privacy/retention, and backup/restore workflows over the same governance service used by CLI/QQ.
- Require preview/confirm/audit/rollback for destructive actions and default redaction of raw chat, credentials, IDs, and unrestricted DB fields.
- Prove CLI/QQ/UI policy parity, accessibility, responsive layout, and synthetic browser QA.

P9 - Release maturity, long soak, and final audit
- Verify managed install/update/recovery, maintenance rehearsal, application rollback, cross-version rollback, and a one-hour synthetic worker/concurrency soak.
- With fresh live authority, run the 72-hour controlled runtime soak, one planned restart, and one bounded provider failure/rate-limit injection.
- Require zero severity-0/1 auth/privacy/cross-scope/integrity incidents, zero FK violations, zero lost accepted ingress, zero duplicate durable effect, and no unexplained direct-trigger loss.
- Audit every P0-P9, V1-V3, and GW/ING/TURN/ACT/MEM/CTX/PI/TOOL/WORK/GOV/OPS/LIVE/VISION/DOC criterion against the exact candidate release.

V1 - Procedural memory and reusable skills
- Support explicit user teaching and governed repeated-evidence proposals without allowing the model or a worker to write durable memory directly.
- Preserve owner/scope/source/timestamp/confidence/visibility/sensitivity/lifecycle/revision/audit for every procedure.
- Make procedure retrieval, review, approve/reject, disable/delete/restore/supersede, retry, and rollback idempotent and immediately effective in ContextBuilder.
- Prove `DEL-V1` with deterministic source-chain, scope-isolation, governance, retrieval, and rollback evidence.

V2 - Semantic retrieval and embeddings
- Add embeddings as a versioned, observable ranking signal while preserving FTS/structured fallback and treating memory rows as the source of truth.
- Apply ownership, scope, visibility, sensitivity, lifecycle, and policy predicates before ranking and limits.
- Handle unavailable providers, timeouts, dimension mismatch, stale indexes, rebuild failures, migration, backup/restore, and cross-version rollback with bounded outcomes.
- Prove `DEL-V2` with deterministic ranking/privacy/fallback/index evidence and authorized recall samples when available.

V3 - Reflection and importance scoring
- Generate source-backed, explainable reflection/conflict/importance proposals only; workers must not directly rewrite active memory.
- Give each proposal a stable ID, exact source set, scope, reason, score inputs, confidence, expiry, and proposed effect.
- Make review/apply/reject/expire/retry/concurrent review and rollback transactional, auditable, and idempotent.
- Prove `DEL-V3` with proposal, governance, retrieval-effect, integrity, and no-direct-mutation evidence.

For V1-V3, execute every required scenario in section 3 of the delivery
contract. In particular, distinguish fixed-vector ranking tests from actual
embedding recall quality, preserve pre-ranking privacy filters, and prove
learning through the production wiring and governed lifecycle.

PER-SLICE SUPERVISOR LOOP

Repeat for every slice:

1. Select one requirement ID and one observed, reproducible gap from the earliest incomplete phase.
2. Before editing, write in the checkpoint: why it is next; allowed/protected paths; explicit assertions; focused commands; schema/dependency/live boundaries; rollback method.
3. Add a failing synthetic regression before a behavior fix, or a passing characterization test before a refactor. Do not copy live data into fixtures.
4. Implement the minimum architecture-compliant change. Keep Gateway, Ingestion, ContextBuilder, Pi, executor, tools, workers, and governance ownership boundaries intact.
5. Run the exact focused commands in the selected phase section of docs/long-term-development-constraints.md.
6. For persistence work, use a fresh migrated temp SQLite DB and assert durable rows, transaction behavior, restart behavior, integrity, and an empty PRAGMA foreign_key_check.
7. For TypeScript behavior changes, run `pnpm typecheck` and `pnpm lint`. Run
   `pnpm release:check` after cross-module milestones and every phase exit.
8. Inspect git diff, git diff --check, untracked paths, generated files, and sensitive-artifact risk.
9. Replace the active checkpoint snapshot with current evidence, changed files, exit criteria, rollback result, and one exact next action.
10. Continue automatically. Reassess the full critical path after two consecutive slices in one subsystem.

Do not leave an intentional failing regression at a phase boundary. Do not weaken assertions, skip deterministic tests, convert failures to mock success, or use arbitrary sleeps to make concurrency tests pass.

PHASE EXIT ARTIFACTS

Every phase requires all of the following:

- outcome mapped to requirement IDs;
- implementation paths and explicit exclusions;
- focused test output and current release gate;
- DB/FK/privacy evidence where applicable;
- migration/dependency/live evidence where applicable;
- rollback procedure and a proved rollback result, not just prose;
- delivery-unit mapping from `docs/long-term-development-delivery.md`;
- canonical docs updated only for landed behavior/contracts/config;
- active checkpoint with no ambiguous next action.

If any required artifact is missing, keep the phase below PHASE_COMPLETE.

GIT AND CHECKPOINT POLICY

- Preserve all pre-existing changes and unknown files. Never use destructive reset or broad checkout cleanup.
- If COMMITS is not authorized, do not commit; report suggested commit groups only.
- If COMMITS is authorized, commit only after a verified reversible slice or phase boundary. Stage explicit paths, review staged diff, and keep migrations, dependencies, runtime behavior, refactors, UI, and docs-only changes in separate commits where applicable.
- Never use git add . and never commit .env, logs, DBs, credentials, private identifiers, raw chats, live evidence, generated runtime state, or unknown scratch files.
- If PUSH is not independently authorized, keep commits local and continue the
  implementation. If PUSH is authorized, push only reviewed commits after
  rechecking branch/upstream and a green required gate.
- The checkpoint must survive context loss, but it is evidence metadata, not a chronological diary. Replace stale sections rather than appending long transcripts.

LIVE AND PRIVATE DATA BOUNDARY

Before every provider call, QQ send/login, live container/service change, or
private DB/raw-chat read, verify the applicable user authorization and target.
Reconcile flags with grants already made in this continuing goal; do not ask
again solely because the goal resumed.

For authorized acceptance:

```bash
pnpm release:check
pnpm acceptance:evidence-template -- --out=/tmp/lethebot-next-stage-acceptance.md
pnpm ops:doctor -- --db="${LETHEBOT_ACCEPTANCE_DB:?set the authorized acceptance database path}"
pnpm acceptance:db-summary -- --db="${LETHEBOT_ACCEPTANCE_DB:?set the authorized acceptance database path}" --require-acceptance-hints
pnpm acceptance:validate-evidence -- /tmp/lethebot-next-stage-acceptance.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-next-stage-acceptance.md --require-complete
```

Set the command's database variable only for the selected authorized acceptance
target. Fill the evidence from observed scenario results before complete-mode
validation; a fresh template should pass the default validator and fail
--require-complete. Run the full local, cross-version, and soak gates in section
4 of the delivery contract. The validator checks its checklist, not V1-V3 or
elapsed soak duration; retain separate linked evidence for those requirements.

Do not put raw output, credentials, raw messages, display names, QQ/group/message IDs, screenshots containing them, live DB rows, or private file paths into the repository or shared report. Use counts, booleans, status enums, hashes, timings, redaction markers, and neutral /tmp paths.

NON-NEGOTIABLES

- Raw events are the audit root; derived records use valid source links and foreign keys.
- ContextBuilder alone selects and assembles prompt context.
- Pi reasons and proposes; policy/executor own authority and side effects.
- Memory writes preserve owner/scope/source/timestamps/confidence/lifecycle/revision/audit and remain immediately deletable from retrieval.
- Group-derived third-party claims do not become another user's active fact.
- evaluatorPolicy=bypass never bypasses L0 policy, permission, sandbox, output bounds, redaction, audit, or executor checks.
- Different conversations never share mutable Pi state; different speakers and quote targets never collapse or cross scope.
- Unknown usage is not zero. Queue wait is part of the deadline.
- Workers cannot starve interactive jobs or directly apply memory maintenance proposals.
- UI/CLI/QQ governance cannot diverge into separate mutation semantics.
- Green tests, healthy containers, one delivered message, or a checkpoint claim never substitute for required live/rollback/soak evidence.

STOP AND ESCALATION

Pause the affected branch and record evidence when product behavior is ambiguous, a destructive/incompatible migration is required, live state conflicts with the plan, a credential/private row/runtime authority is needed, rollback proof fails, three materially different attempts fail, or the fix would overwrite unknown work. Continue other independent required work when possible.

Use NEEDS_DECISION only when all other safe required work is done and one concrete product/architecture choice remains. Present the evidence, two or three options, tradeoffs, and a recommendation.

Use BLOCKED_EXTERNAL only when all other safe local/non-secret required work is done and exact missing authorization/runtime/session/service conditions are the only blockers. List each exact authority/action needed in priority order.

TARGET COMPLETION AUDIT

Before TARGET_COMPLETE:

1. Re-read AGENTS.md, docs/long-term-development-constraints.md, and docs/long-term-development-delivery.md.
2. List every P0-P9 and V1-V3 exit criterion and every cross-phase/delivery requirement row.
3. For each, cite current source/test/DB/FK/privacy/live/rollback/soak evidence and verification time.
4. Confirm all evidence belongs to the exact candidate release and no historical count or prior runtime is being reused as current proof. A dirty worktree's HEAD is insufficient; use the frozen source/build and configuration identity required by the delivery contract.
5. Run, without concurrent edits:

```bash
pnpm release:check
git status --short --branch
git diff --check
```

6. Make only the final evidence/status checkpoint update, run git diff --check again, and do not edit product files afterward.
7. Set TARGET_COMPLETE only if every P0-P9 and V1-V3 phase is PHASE_COMPLETE, every required delivery unit is proved for the same candidate, the 72-hour live soak and P4 matrix are validator-clean, rollback is proved, and no required UNVERIFIED, REPRODUCED, NEEDS_DECISION, BLOCKED_EXTERNAL, or deferred item remains.

REPORTING AT EACH STOPPING POINT

- Goal, phase, slice, and requirement status.
- Current branch/HEAD/worktree ownership.
- Commands run with concise pass/fail results.
- Files changed, grouped by subsystem.
- Evidence for each newly satisfied criterion.
- DB/FK/privacy/migration/dependency/live/rollback status.
- `DEL-*` delivery-unit status and handoff artifacts.
- Remaining risks and blockers.
- One exact next action, or the exact authority/decision needed.

Do not claim generated, verified, live-proved, phase-complete, pushed, rolled back, or target-complete unless the corresponding artifact or command evidence actually exists.
````
