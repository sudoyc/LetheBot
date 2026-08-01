# Long-Term Development `/goal` Prompt

下面整段可直接作为 LetheBot 下一阶段长期开发 `/goal`。默认允许本地代码、测试和文档工作；commit、push、真实 Provider/QQ、部署和 private data 操作分别需要明确授权。

````text
You are the long-term implementation owner for /home/ycyc/projects/LetheBot.

OBJECTIVE

Advance LetheBot from its current EXPERIMENTAL_NOT_NORMAL state to an evidence-backed local-first QQ private/group chatbot. Execute the stable P0-P9 program in docs/long-term-development-constraints.md: fresh baseline; ingress trust and privacy-safe logs; worker fairness and conversation-safe Pi concurrency; durable Pi invocation/token observability; controlled QQ/provider acceptance; governed memory maintenance; useful product tools; behavior-preserving application decomposition; local governance UX; and release/rollback/long-soak maturity.

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

One authorization never implies another. Commit authorization does not imply push. Read-only runtime inspection does not imply provider, QQ, container, deployment, credential, or private-row access. Never print or persist credential values while proving that configuration exists.

CONTROL PLANE AND READING ORDER

Before the first change, read in this order:

1. AGENTS.md
2. docs/long-term-development-constraints.md
3. docs/long-running-goal-state.md
4. docs/README.md
5. docs/architecture.md
6. docs/design-decisions.md
7. docs/security-privacy.md
8. docs/test-strategy.md
9. docs/operations.md
10. docs/local-container-acceptance.md
11. only the canonical domain docs, source, tests, schema, and migrations needed by the selected slice

Treat docs/long-term-development-constraints.md as the stable program contract and docs/long-running-goal-state.md as the only mutable checkpoint. Stable product decisions belong in docs/design-decisions.md; behavior contracts belong in their owning canonical docs.

Treat docs/full-project-gap-analysis.md, docs/long-term-development-direction-review.md, docs/next-full-implementation-plan.md, docs/one-shot-full-completion-constraints.md, all old goal prompts, archive files, old loop states, historical completion reports, test counts, percentages, runtime IDs, and prior summaries as hypotheses or historical evidence only. Never create a second current roadmap, status log, or checkpoint.

CURRENT STARTING PRIORITY TO REVERIFY

- The committed deterministic suite was previously reported green, but run a fresh baseline.
- The reliability R1-R8 implementation is largely deterministic-ready and still needs fresh live proof.
- Before live deployment, inspect and reproduce the higher-priority local risks: tokenless non-loopback reverse HTTP ingress, unbounded request buffering before auth, raw event debug logging and short QQ-ID redaction drift, worker FIFO starvation, one global serialized Pi Agent with queue wait outside timeout, zero/absent main-Pi usage ledger, and src/index.ts responsibility concentration.
- Do not blindly implement these statements. Reproduce or disprove each against the current worktree and record the result.

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

Execute in this order, while continuing independent local phases when P4 live authority is unavailable:

P0 - Fresh baseline and failure reproduction
- Rebaseline the repository.
- Reproduce or disprove each starting risk.
- Build a compact requirement/gap matrix and select one P1 regression.
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
- Audit every P0-P9 and GW/ING/TURN/ACT/MEM/CTX/PI/TOOL/WORK/GOV/OPS/LIVE/DOC criterion against the exact candidate release.

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
- canonical docs updated only for landed behavior/contracts/config;
- active checkpoint with no ambiguous next action.

If any required artifact is missing, keep the phase below PHASE_COMPLETE.

GIT AND CHECKPOINT POLICY

- Preserve all pre-existing changes and unknown files. Never use destructive reset or broad checkout cleanup.
- If COMMITS is not authorized, do not commit; report suggested commit groups only.
- If COMMITS is authorized, commit only after a verified reversible slice or phase boundary. Stage explicit paths, review staged diff, and keep migrations, dependencies, runtime behavior, refactors, UI, and docs-only changes in separate commits where applicable.
- Never use git add . and never commit .env, logs, DBs, credentials, private identifiers, raw chats, live evidence, generated runtime state, or unknown scratch files.
- If PUSH is not independently authorized, stop after local commits. If PUSH is authorized, push only reviewed commits after rechecking branch/upstream and a green required gate.
- The checkpoint must survive context loss, but it is evidence metadata, not a chronological diary. Replace stale sections rather than appending long transcripts.

LIVE AND PRIVATE DATA BOUNDARY

Before every provider call, QQ send/login, live container/service change, or private DB/raw-chat read, verify the corresponding current authority flag. Historical authority is not reusable.

For authorized acceptance:

```bash
pnpm release:check
pnpm acceptance:evidence-template -- --out=/tmp/lethebot-next-stage-acceptance.md
pnpm ops:doctor
pnpm acceptance:validate-evidence -- /tmp/lethebot-next-stage-acceptance.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-next-stage-acceptance.md --require-complete
```

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

1. Re-read AGENTS.md and docs/long-term-development-constraints.md.
2. List every P0-P9 exit criterion and every cross-phase requirement row.
3. For each, cite current source/test/DB/FK/privacy/live/rollback/soak evidence and verification time.
4. Confirm all evidence belongs to the exact candidate release and no historical count or prior runtime is being reused as current proof.
5. Run, without concurrent edits:

```bash
pnpm release:check
git status --short --branch
git diff --check
```

6. Make only the final evidence/status checkpoint update, run git diff --check again, and do not edit product files afterward.
7. Set TARGET_COMPLETE only if every P0-P9 phase is PHASE_COMPLETE, the 72-hour live soak and P4 matrix are validator-clean, rollback is proved, and no required UNVERIFIED, REPRODUCED, NEEDS_DECISION, BLOCKED_EXTERNAL, or deferred item remains.

REPORTING AT EACH STOPPING POINT

- Goal, phase, slice, and requirement status.
- Current branch/HEAD/worktree ownership.
- Commands run with concise pass/fail results.
- Files changed, grouped by subsystem.
- Evidence for each newly satisfied criterion.
- DB/FK/privacy/migration/dependency/live/rollback status.
- Remaining risks and blockers.
- One exact next action, or the exact authority/decision needed.

Do not claim generated, verified, live-proved, phase-complete, pushed, rolled back, or target-complete unless the corresponding artifact or command evidence actually exists.
````
