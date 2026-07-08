# Next Codex Project State Handoff

**Date:** 2026-07-08 09:54 local shell time (CST +0800)
**Purpose:** concise handoff for the next Codex worker. This is not a completion certificate; it is a current-state map and development direction.

## Verified Snapshot

Evidence checked in the current worktree:

```bash
date '+%Y-%m-%d %H:%M:%S %Z %z'
git status --short | awk '{ total++; if ($1 ~ /^\?\?/) untracked++; else tracked++ } END { printf "tracked_dirty=%d untracked=%d total=%d\n", tracked+0, untracked+0, total+0 }'
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
pnpm typecheck && pnpm lint && pnpm test:run && git diff --check
```

Observed:

- Worktree is highly dirty: `tracked_dirty=75`, `untracked=44`, `total=119`.
- Pi dependencies resolve to:
  - `@earendil-works/pi-agent-core 0.80.2`
  - `@earendil-works/pi-ai 0.80.2`
- Latest deterministic full gate observed after the most recent R7/R4 explainability slice exited `0`:
  - `pnpm typecheck` passed.
  - `pnpm lint` passed.
  - `pnpm test:run` passed with `72 passed | 1 skipped` test files and `1123 passed | 22 skipped` tests.
  - `git diff --check` passed.

Do not treat this snapshot as permanent. The next worker must re-run the relevant checks before making claims.

## What Is Healthy

The product direction remains sound:

- local-first QQ / OneBot chatbot;
- NapCat / SnowLuma as the first practical platform loop;
- thick governable memory layer rather than a plain vector store;
- auditable raw event -> message -> turn -> context -> action/tool/job records;
- user/admin control over memory inspection, disable/delete/restore/supersede, privacy preferences, and acceptance evidence;
- Pi behind mockable adapters;
- deterministic default tests without real credentials.

Current dirty worktree already contains substantial working foundations:

- OneBot HTTP/WebSocket fake acceptance and diagnostic redaction coverage.
- Raw event and chat persistence with FK assertions in many tests.
- Agent turn, context trace, action decision/execution, tool call, job, worker heartbeat, audit, memory, and privacy preference repositories.
- Governance CLI inspection/lifecycle paths, including `why` context/action explanation.
- ContextBuilder token budgeting, identity/participant prompt-data boundaries, and selected/rejected memory trace evidence.
- Tool registry/policy/audit/sandbox redaction coverage.
- Durable worker scheduler and ops maintenance / worker-soak evidence.
- Local acceptance evidence template and validator.

## Latest Implemented Slice

Latest completed functional slice:

- **Phase:** R7 governance explainability + R4 action/context observability.
- **Behavior:** spawned `why --turn <turn-id>` now shows linked durable `action_executions` outcomes for the linked action decision.
- **Evidence shown:** execution ID, action type, status, executed-message evidence, downgrade evidence, and failure diagnostics.
- **Safety:** output is redacted; raw executed message IDs, platform IDs, secrets, event text, and chat text are not printed; path is read-only for action/context/audit rows; temp SQLite FKs remain clean.
- **Files touched in that slice:** `src/cli/governance.ts`, `src/cli/main.ts`, `tests/integration/cli-main.test.ts`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

## What Is Not Healthy Yet

The repository is not production-healthy:

1. **Worktree is too dirty for confident continuation.** There are 119 dirty/untracked paths. The next worker must not broad-stage or clean this blindly.
2. **Real SnowLuma/QQ soak is unproven.** Deterministic fake OneBot evidence is strong, but live controlled acceptance has not been run in the latest evidence.
3. **Docs have become append-heavy.** `docs/loop-state-recovery.md` and `docs/long-term-development-direction-review.md` contain useful evidence but are too large and repetitive for efficient planning.
4. **Many tests prove redaction/parser variants.** This is valuable, but the previous loop over-prioritized narrow redaction micro-slices. New work should favor stabilization, production acceptance, and mergeable delivery boundaries.
5. **Optional web UI/richer dashboards remain future work.**
6. **Completion claims remain unsafe unless tied to fresh commands and DB/test evidence.**

## Worktree Hazards

Do not read, print, stage, or commit secrets, local DBs, logs, or private platform identifiers.

Known untracked/scratch-looking paths include examples such as:

- `test-deepseek*.mjs`, `test-pi*.mjs`
- `count_lines.sh`, `*.sh~`
- `.schema chat_messages`
- newly-created directories such as `src/actions/`, `src/operations/`, `tests/unit/actions/`, etc.

Some untracked files are intentional WIP source/test files. Do not delete them without explicit user approval.

## Recommended Development Direction

### Priority 0: Stabilize and package the dirty WIP

Before adding more feature surface:

- build a concise inventory of tracked/untracked changes by subsystem;
- identify which untracked files are intentional source/test/docs and which are scratch;
- ask the user before deleting scratch or committing;
- if commit permission is later granted, propose small explicit commit groups.

### Priority 1: Prove the real local platform loop

Production-ready status requires controlled opt-in SnowLuma/QQ evidence:

- QQ private and group loop through NapCat / OneBot;
- replies delivered through action executor / response router;
- no raw secrets or private QQ IDs in evidence files;
- local acceptance evidence generated and validated with the existing redaction-first tools.

If local secrets/session are not available, do not fake this. Mark it as unproven and continue deterministic work.

### Priority 2: Keep governance explainability useful, not infinite

`why` now covers stored/rebuilt context traces, token budget, selected/rejected memory, identity evidence, linked action decisions, and linked action executions. Further CLI work should be high-value only:

- missing owner/admin flows;
- inspect/delete/restore paths with real user value;
- compact operator output;
- documentation of actual operator commands.

Avoid adding endless parser/redaction variants unless a concrete leak or coverage gap is found.

### Priority 3: Memory governance and context correctness

Continue only with DB-backed evidence:

- memory writes must preserve record/source/revision/audit rows;
- deletion/disable/supersede must affect retrieval immediately;
- group-derived user memory must not become active private fact without confirmation;
- context traces must show selected/rejected memory and token evidence.

### Priority 4: Ops and durability

Keep improving:

- backup/restore/retention on temp DBs;
- worker leases/retries/heartbeats/failure visibility;
- readiness/metrics without credential leakage;
- local runbooks for controlled acceptance.

## Suggested Next Worker First Step

Do not continue the old loop automatically. Start with:

1. Read `AGENTS.md`, `docs/next-codex-constraints.md`, this file, and `docs/prompts/next-codex-goal.md`.
2. Run a fresh baseline.
3. Produce a short subsystem inventory of the dirty worktree.
4. If gates are green, choose one of:
   - stabilization/commit grouping proposal;
   - real local acceptance if the user explicitly provides/authorizes local runtime;
   - one high-value architecture gap with DB-backed tests.
5. Stop after one coherent slice and report evidence.
