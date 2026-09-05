# Next Codex Project State Handoff

**Date:** 2026-07-10 03:45 local shell time (CST +0800)
**Purpose:** concise handoff for the next Codex worker. This is not a completion certificate; it is a current-state map and development direction.

## Verified Snapshot

Evidence checked in the current worktree before and during the latest production-readiness slice:

```bash
date '+%Y-%m-%d %H:%M:%S %Z %z'
git status --short | awk '{ total++; if ($1 ~ /^\?\?/) untracked++; else tracked++ } END { printf "tracked_dirty=%d untracked=%d total=%d\n", tracked+0, untracked+0, total+0 }'
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
pnpm typecheck
pnpm lint
pnpm test:run
git diff --check
```

Observed:

- Current worktree after the latest status check at `2026-07-10 03:45:24 CST +0800`: `tracked_dirty=58`, `untracked=19`, `total=77`.
- Pi dependencies resolve to:
  - `@earendil-works/pi-agent-core 0.80.2`
  - `@earendil-works/pi-ai 0.80.2`
- Latest deterministic full gate after the acceptance DB summary selected governed-memory group/conversation tool-source regression slice exited `0` via `pnpm release:check`:
  - `pnpm typecheck` passed.
  - `pnpm lint` passed.
  - `pnpm test:run` passed with `75 passed | 1 skipped` test files and `1245 passed | 8 skipped` tests.
  - `git diff --check` passed as part of `release:check`.
- Latest acceptance DB summary validation now has aggregate-only DB-backed evidence proving selected governed-memory completion hints reject successful `tool_output` sources unless the tool actor or source turn context is compatible with the selected memory boundary. A selected user-scoped memory backed only by another user's successful tool call no longer satisfies complete hints; selected group/conversation memories backed only by successful tool calls from other group/conversation contexts no longer satisfy complete hints; successful tool calls from the same source turn sender, same group context, or same conversation context still count. The previous active/source/revision/non-secret visibility/scope gates, raw/chat owner/scope gates, and worker-source provenance gates still apply.
- Latest governed-memory lifecycle state-machine validation has DB-backed evidence proving invalid direct repository transitions, such as disabled -> superseded, are rejected before durable state/revision/audit mutation while valid restore/delete/proposal-decision paths remain green.
- Recent ContextBuilder validation has DB-backed evidence proving group prompt-context assembly uses context-aware user/global memory retrieval before bounded limits, so many inaccessible `private_only` user memories cannot starve visible group-context user memories while a bounded rejection trace remains available.
- Recent retrieval/search visibility-limit validation has DB-backed evidence proving context visibility is applied before `LIMIT` / FTS rank limiting, so inaccessible `private_only` rows cannot consume the bounded group-context result window ahead of visible `same_user_any_context` rows.
- Recent memory source provenance validation has DB-backed evidence proving malformed explicit, duplicate explicit, and implicit memory source links are rejected before durable memory rows are written: blank `sourceId`, duplicate explicit `sourceId` values in one create request, blank implicit `sourceContext`-derived source IDs, non-finite `sourceTimestamp` inputs, or non-finite `expiresAt` lifecycle metadata create no `memory_records`, `memory_sources`, `memory_revisions`, or memory audit rows and leave SQLite FKs clean. When both explicit `sources[]` and `sourceContext` are omitted, the repository still uses the deterministic `memory:<memoryId>` fallback source ID.

Do not treat this snapshot as permanent. The next worker must re-run the relevant checks before making claims. Current tracked changes include local acceptance evidence tooling/tests/docs, real-provider harness cleanup/tests/docs, `why` tool-call explainability code/tests, compact governance-health output/tests/docs, `ops:doctor` / maintenance / rollback preflight code/tests/docs, `release:check` install/update/release preflight docs, deployment artifact privacy hardening, plus active status docs and archived pre-consolidation status snapshots. The latest acceptance-evidence slice requires selected governed-memory context evidence to have at least one usable memory source link resolving to durable source evidence, be bound through the turn's durable `context_pack_id`, be visible in that same private/group flow context, be scoped to that same sender, group, conversation, or public/system boundary, be compatible with the selected memory owner/scope for inbound raw/chat source evidence, require completed worker job/attempt sources to carry explicit compatible raw/chat provenance in payload/result, and require successful tool-call sources to have compatible actor or source-turn context. The preceding selected-memory visibility and group-scope slices require group complete-acceptance DB hints to carry the same normalized group scope through trigger chat, selected context trace, and bot-response evidence. The docs consolidation slice keeps active recovery/direction handoffs concise while preserving long historical notes under `docs/archive/**`. The acceptance-evidence slices strengthen complete-mode validation so failed/degraded/not-ready evidence, missing governed-memory/privacy evidence, missing command-preflight/worker-soak/FK evidence, missing/failing aggregate DB summary required-hints evidence, group DB evidence without an exact `mentions_bot=1` trigger row and normalized group scope, and conflicting/missing runtime config choices cannot be checked as complete, and strengthen default share-safety validation so nearby redaction markers cannot hide raw platform-like numbers on the same line. The untracked paths remain intentionally unstaged and mostly untouched; the three one-shot/gap-analysis docs are untracked project-planning artifacts referenced by the current goal, while scratch/backup paths still require explicit user authorization before deletion, ignore-rule changes, promotion, staging, or commit.

The current latest slice expands deterministic aggregate acceptance DB evidence.
`acceptance:db-summary --require-acceptance-hints` now fails memory-governance
completion when a complete group/private flow selects a governed memory whose
source evidence is an otherwise successful `tool_output` row but the tool actor
or source turn context is incompatible with the selected memory boundary. A
selected user-scoped memory backed only by another user's successful tool call
does not count; a selected group-scoped memory backed by a successful tool
call from another group context also does not count; a selected
conversation-scoped memory backed by a successful tool call from another
conversation context also does not count; successful tool calls from the same
source turn sender, same group context, or same conversation context still count.
Bot-response chat rows, rejected/error tool calls, orphan sources, another
user's chat source, another user's tool source, and completed worker rows without
compatible chat/raw provenance do not count.

## What Is Healthy

The product direction remains sound:

- local-first QQ / OneBot chatbot;
- NapCat / SnowLuma as the first practical platform loop;
- thick governable memory layer rather than a plain vector store;
- auditable raw event -> message -> turn -> context -> action/tool/job records;
- user/admin control over memory inspection, disable/delete/restore/supersede, privacy preferences, and acceptance evidence;
- Pi behind mockable adapters;
- deterministic default tests without real credentials;
- opt-in real-provider tests no longer contain placeholder pass assertions or implicit local secret-file reads.

Current tracked code/test state already contains substantial working foundations:

- OneBot HTTP/WebSocket fake acceptance and diagnostic redaction coverage.
- Raw event and chat persistence with FK assertions in many tests.
- Agent turn, context trace, action decision/execution, tool call, job, worker heartbeat, audit, memory, and privacy preference repositories.
- Governance CLI inspection/lifecycle paths, including `why` context/action/tool-call explanation.
- ContextBuilder token budgeting, identity/participant prompt-data boundaries, and selected/rejected memory trace evidence.
- Tool registry/policy/audit/sandbox redaction coverage.
- Durable worker scheduler and ops maintenance / rollback / worker-soak evidence.
- Read-only `ops:doctor` preflight evidence for migrated SQLite DB integrity/FK/schema/count/config-boolean checks.
- `release:check` deterministic package script and install/update/release runbook that ties release gating to typecheck/lint/test/diff-check, backup, doctor, health/readiness, optional OneBot verify, and acceptance validators.
- Current requirement-by-requirement completion audit matrix in `docs/full-project-gap-analysis.md`, explicitly marking live SnowLuma/QQ acceptance as unproven.
- Local acceptance evidence template and validator, including redaction/share-safety checks and opt-in completion checks for filled manual evidence; complete mode now rejects checked failed/degraded/not-ready status values for health/readiness/agent turns/action executions, requires governed-memory/privacy proof plus command-preflight, worker-soak, FK-clean acceptance DB proof, and aggregate-only `acceptance:db-summary --require-acceptance-hints` proof, and requires exactly one checked runtime option for compose target, Pi provider, and OneBot transport. The DB summary required-hints path also requires group flow evidence to come from the triggering normalized chat row with `mentions_bot=1` and a normalized `qq-group-<digits>` group ID preserved through selected context and bot-response evidence, while private flow evidence is targeted by private conversation type, and now requires at least one complete acceptance flow whose durable `context_pack_id` selected context includes an active source/revision-linked governed memory with a usable source link resolving to durable source evidence, visible in that same flow context, scoped to that same sender, group, conversation, or public/system boundary, owner/scope-compatible for inbound raw/chat sources, compatible with actor/source-turn context for successful tool-call sources, and backed by explicit compatible raw/chat provenance for completed worker sources. Share-safety validation also rejects raw platform-like numbers even when a nearby redaction marker appears on the same line.

## Latest Implemented Slice

Latest completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary selected governed-memory group/conversation tool-source compatibility regression gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` now counts `tool_output` memory source evidence only when the `tool_calls` row is successful and its actor or source turn context is compatible with the selected memory boundary. This slice regression-locks user-, group-, and conversation-scoped boundaries: user memory cannot be proven by another user's successful tool call, group memory cannot be proven by another group's successful tool call, conversation memory cannot be proven by another conversation's successful tool call, and matching source-turn sender/group/conversation context still counts when actor metadata is absent.
- **Evidence shown:** failing-first targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "tool sources" --silent` initially exited `1` because `selectedGovernedMemoryContexts` stayed `1` when the selected user memory source was changed to another user's successful tool call. After the fix, targeted user tool-source coverage exited `0` with `2 passed | 48 skipped`; targeted group tool-source regression coverage exited `0` with `2 passed | 50 skipped`; targeted conversation tool-source regression coverage exited `0` with `2 passed | 52 skipped`; full local acceptance evidence coverage exited `0` with `54 passed`; `pnpm typecheck` initially exited `2` because the fix made `rowExists` unused, then exited `0` after deleting the unused helper and remained green after the group/conversation regression tests; `pnpm lint` exited `0`; final `pnpm release:check` exited `0` with `75 passed | 1 skipped` test files and `1245 passed | 8 skipped` tests.
- **Safety:** deterministic synthetic SQLite DB/spawned CLI tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private QQ/group identifier, token, cookie, memory content, tool input/output, or DB row payload was read or printed. Seeded secret/platform values plus synthetic tool source IDs/output text are asserted absent from summary JSON/stdout.
- **Files touched in this slice:** `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary selected governed-memory worker-source provenance gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` now counts `worker_extraction` memory source evidence only when the completed `jobs` / `job_attempts` row carries explicit raw/chat source identifiers in payload/result and those identifiers resolve to usable, owner/scope-compatible inbound QQ chat evidence. A completed worker job without chat/raw provenance no longer proves selected governed-memory completion, while a completed worker job with compatible `sourceChatMessageId` still counts.
- **Evidence shown:** failing-first targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "worker memory sources" --silent` initially exited `1` because `selectedGovernedMemoryContexts` stayed `1` when the selected memory source was changed to a completed worker job without chat/raw provenance. After the fix, targeted worker-source coverage exited `0` with `2 passed | 46 skipped`; full local acceptance evidence coverage exited `0` with `48 passed`; `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1239 passed | 8 skipped` tests.
- **Safety:** deterministic synthetic SQLite DB/spawned CLI tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private QQ/group identifier, token, cookie, memory content, memory source ID, worker payload/result, or DB row payload was read or printed. Seeded secret/platform values plus synthetic worker job IDs/payload text are asserted absent from summary JSON/stdout.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary selected governed-memory owner/scope-compatible source gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` now counts selected governed-memory completion evidence only when any inbound raw/chat source evidence is compatible with the selected memory owner/scope. User-scoped memory chat/raw sources must resolve to the same canonical owner; `private_only` user memory sources must be private; `same_group_only` user memory sources must match group or conversation; group-scoped sources must match memory group/conversation; conversation-scoped sources must match memory conversation; global/system still count only when public. This prevents a selected user memory owned by the acceptance sender from being proven by another user's otherwise usable inbound chat row.
- **Evidence shown:** failing-first targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "memory owner" --silent` initially exited `1` because `selectedGovernedMemoryContexts` stayed `1` when the selected memory source was changed to another user's inbound chat row. After the fix, combined targeted coverage `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "memory owner|usable source|source links" --silent` exited `0` with `3 passed | 43 skipped`; full local acceptance evidence coverage exited `0` with `46 passed`; `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1237 passed | 8 skipped` tests.
- **Safety:** deterministic synthetic SQLite DB/spawned CLI tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private QQ/group identifier, token, cookie, memory content, memory source ID, tool payload, or DB row payload was read or printed. Seeded secret/platform values plus synthetic other-user source text/source IDs are asserted absent from summary JSON/stdout.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary selected governed-memory usable-source evidence gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` now counts selected governed-memory completion evidence only when the selected memory has at least one `memory_sources` row whose source link resolves to usable durable source evidence. Usable source evidence is an inbound QQ `chat.message.received` raw event with a linked inbound non-bot chat row, an inbound non-bot chat row linked to such a raw event, a successful tool call whose actor or source turn context is compatible with the selected memory boundary, or a completed job/job attempt with explicit compatible raw/chat provenance in payload/result. Orphan source IDs, `user_command`-only source links, bot-response chat rows, and rejected/error tool-call rows no longer satisfy `selectedGovernedMemoryContextPresent`, even when memory source/revision rows exist and SQLite foreign keys are clean.
- **Evidence shown:** failing-first targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "usable source" --silent` initially exited `1` because `selectedGovernedMemoryContexts` stayed `1` when the memory source was changed to a rejected tool call. After the fix, combined targeted coverage `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "usable source|source links" --silent` exited `0` with `2 passed | 43 skipped`; full local acceptance evidence coverage exited `0` with `45 passed`; `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1236 passed | 8 skipped` tests.
- **Safety:** deterministic synthetic SQLite DB/spawned CLI tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private QQ/group identifier, token, cookie, memory content, memory source ID, tool payload, or DB row payload was read or printed. Seeded secret/platform values plus synthetic rejected-tool and bot-response source IDs are asserted absent from summary JSON/stdout.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary selected governed-memory scope/actor gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` now counts selected governed-memory completion evidence only when the selected memory is active, source/revision-linked, non-secret/prohibited, visible in the same complete acceptance flow context, and scoped to that same actor/context boundary. User-scoped memory must belong to the triggering sender's active QQ platform-account mapping; group-scoped memory must match the flow group or conversation; conversation-scoped memory must match the flow conversation; global/system memory counts only when public. This prevents a flow that selects another user's user-scoped memory from satisfying complete memory-governance DB hints.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "other user|visible in the flow context" --silent` exited `0` with `1 passed | 42 skipped`; full local acceptance evidence coverage exited `0` with `43 passed`; `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1234 passed | 8 skipped` tests.
- **Safety:** deterministic synthetic SQLite DB/spawned CLI tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private QQ/group identifier, token, cookie, memory content, or memory ID was read or printed. Seeded secret/platform values are asserted absent from summary JSON/stdout.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary selected governed-memory visibility gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` now counts selected governed-memory completion evidence only when the selected memory is active, source/revision-linked, non-secret/prohibited, and visible in the same complete acceptance flow context. `public` and `same_user_any_context` remain visible, `private_only` counts only for private flows, and `same_group_only` counts only for matching group/conversation scope. This prevents a group flow that selected `private_only` memory from satisfying complete memory-governance DB hints.
- **Evidence shown:** failing-first targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "visible in the flow context" --silent` initially exited `1` because `selectedGovernedMemoryContexts` remained `1` after the group flow selected `private_only` memory. After the fix, the same targeted coverage exited `0` with `1 passed | 41 skipped`; full local acceptance evidence coverage exited `0` with `42 passed`; `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1233 passed | 8 skipped` tests.
- **Safety:** deterministic synthetic SQLite DB/spawned CLI tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private QQ/group identifier, token, cookie, memory content, or memory ID was read or printed. The seeded secret/platform values are asserted absent from summary JSON/stdout.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary group-scope required-hints gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` now requires group complete-acceptance evidence to preserve gateway-normalized `qq-group-<digits>` group scope through the triggering group `chat_messages` row, the selected `context_traces` row, and the matching bot-response `chat_messages` row. Exact `mentions_bot=1` is still required for group targeting, and private paths remain targeted by private conversation type.
- **Evidence shown:** failing-first targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "normalized group scope" --silent` initially exited `1` because group hints stayed true after the trigger row lost `group_id`. After the fix, targeted group-scope coverage `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "group scope" --silent` exited `0` with `2 passed | 39 skipped`; full local acceptance evidence coverage exited `0` with `41 passed`; `pnpm typecheck`, `pnpm lint`, and final `pnpm release:check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1232 passed | 8 skipped` tests.
- **Safety:** deterministic synthetic SQLite DB/spawned CLI tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private QQ/group identifier, token, or cookie was read or printed. The seeded secret/platform values are asserted absent from summary JSON/stdout.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic governed-memory lifecycle state-machine hardening.
- **Behavior:** `MemoryRepository.updateState()` now enforces a repository-level lifecycle state machine before durable mutation. Proposed records can only move to active/rejected/deleted; active records can move to disabled/deleted/superseded; disabled/rejected/deleted records can only restore to active or delete where applicable; and superseded records can only be deleted. Invalid direct transitions are rejected before state, revision, audit, retrieval visibility, or FK state changes.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "invalid direct lifecycle transitions" --silent` initially exited `1` because `repo.supersede(disabledMemory)` resolved. After the fix, targeted lifecycle coverage `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "invalid direct lifecycle transitions|approve proposed memory|reject proposed memory|restore" --silent` exited `0` with `3 passed | 36 skipped`. Related `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/cli/governance.test.ts tests/integration/cli-main.test.ts -t "memory|MemoryRepository|enable-memory|restore-memory|supersede-memory|approve/reject" --silent` exited `0` with `3 passed` test files and `80 passed | 110 skipped` tests. `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1230 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB/spawned-CLI tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic memory IDs/content and asserts no unintended state/retrieval/revision/audit mutation plus FK-clean state.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/contracts.md`, `docs/memory-system.md`, `docs/sqlite-schema.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic ContextBuilder memory retrieval-limit hardening.
- **Behavior:** `ContextBuilder.retrieveMemory()` now retrieves prompt-eligible user/global memories with the current private/group context before bounded repository limits apply, and uses separate scoped lookups for group/conversation-bound memories instead of passing context IDs as broad metadata filters. It also keeps bounded no-context scans for rejection trace evidence, preserving owner/admin explainability without letting inaccessible `private_only` memories starve visible group-context memories.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/context/builder.test.ts -t "group visibility before user-memory retrieval limits" --silent` initially exited `1` because selected memory IDs were empty when 50 high-importance private-only user memories consumed the default retrieval window before a visible `same_user_any_context` memory. After the fix, targeted `pnpm exec vitest run tests/unit/context/builder.test.ts -t "group visibility before user-memory retrieval limits|private_only memory in group context|group and conversation summaries" --silent` exited `0` with `3 passed | 12 skipped`. Related `pnpm exec vitest run tests/unit/context/builder.test.ts tests/unit/storage/memory-repository.test.ts tests/unit/tools/memory-search.test.ts tests/integration/memory-injection.test.ts --silent` exited `0` with `4 passed` test files and `73 passed` tests. `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1229 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic memory records and asserts selected prompt memory plus bounded rejection evidence.
- **Files touched in this slice:** `src/context/builder.ts`, `tests/unit/context/builder.test.ts`, `docs/context-orchestration.md`, `docs/contracts.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic governed-memory retrieval/search visibility-limit hardening.
- **Behavior:** `MemoryRepository.retrieve()` now applies context visibility predicates before `ORDER BY ... LIMIT`, and `MemoryRepository.search()` now joins FTS rows to `memory_records` so lifecycle, sensitivity, metadata, and context visibility predicates run before FTS rank limiting. Inaccessible private-only memories can no longer consume a bounded group-context result window ahead of visible memories.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "visibility before limit" --silent` initially exited `1` because group retrieval and group search both returned `[]` when a higher-ranked private-only row consumed `limit=1`. After the fix, the same targeted coverage exited `0` with `2 passed | 36 skipped`. Broader targeted coverage `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "visibility before limit|enforce sensitivity, visibility, and state filters|exclude expired active memories" --silent` exited `0` with `5 passed | 33 skipped`. Related `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/context/builder.test.ts tests/unit/tools/memory-search.test.ts tests/integration/memory-injection.test.ts --silent` exited `0` with `4 passed` test files and `72 passed` tests. `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1228 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic memory content and asserts visibility-bounded results plus existing lifecycle/sensitivity/expiration behavior.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/contracts.md`, `docs/memory-system.md`, `docs/sqlite-schema.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic governed-memory proposal-decision lifecycle hardening.
- **Behavior:** `MemoryRepository.approve()` and `MemoryRepository.reject()` now reject non-proposed records before durable mutation. This enforces proposal-only approval/rejection at the repository boundary, not only in the governance CLI, and leaves non-proposed record state, retrieval visibility, revision rows, memory audit rows, and SQLite FKs unchanged.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "non-proposed memory" --silent` initially exited `1` because `approve(active)` resolved. After the fix, targeted proposal-decision coverage `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "non-proposed memory|approve proposed memory|reject proposed memory" --silent` exited `0` with `3 passed | 33 skipped`. Related `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/cli/governance.test.ts --silent` exited `0` with `3 passed` test files and `99 passed` tests. `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1226 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic internal IDs and asserts no unintended state/retrieval/revision/audit mutation plus FK-clean state.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/contracts.md`, `docs/memory-system.md`, `docs/sqlite-schema.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic governed-memory no-return-to-proposed lifecycle hardening.
- **Behavior:** `MemoryRepository.updateState()` now rejects attempts to transition an existing memory record back to `state='proposed'` after creation. Proposal state remains a governed create-time state, while later lifecycle changes must use active/rejected/superseded/disabled/deleted transitions with revision/audit evidence. Rejected transition attempts leave the record state, revision rows, memory audit rows, and SQLite FKs unchanged.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "transitions back to proposed" --silent` initially exited `1` because `updateState()` resolved and mutated the active record to proposed. After the fix it exited `0` with `1 passed | 34 skipped`. Related `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent` exited `0` with `3 passed` test files and `79 passed` tests. `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1225 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic internal IDs and asserts no unintended state/revision/audit mutation plus FK-clean state.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/contracts.md`, `docs/memory-system.md`, `docs/sqlite-schema.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic governed-memory expiration lifecycle metadata hardening.
- **Behavior:** `MemoryRepository.create()` now validates optional `expiresAt` before durable writes. Non-finite expiration dates are rejected before any memory/source/revision/audit rows are written, so invalid lifecycle metadata cannot silently create permanent or unreliable long-term memory.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "invalid memory expiration" --silent` initially exited `1` because the promise resolved and created a memory row. After the fix it exited `0` with `1 passed | 33 skipped`. Combined provenance/lifecycle coverage `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "malformed explicit memory sources|blank implicit memory source context|duplicate explicit memory source ids|invalid memory expiration" --silent` exited `0` with `4 passed | 30 skipped`. Related `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent` exited `0` with `3 passed` test files and `78 passed` tests. `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1224 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic internal IDs and asserts no orphan/partial memory lifecycle/provenance rows plus FK-clean state.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/contracts.md`, `docs/memory-system.md`, `docs/sqlite-schema.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic governed-memory duplicate explicit source provenance hardening.
- **Behavior:** `MemoryRepository.create()` now rejects duplicate explicit `sourceId` values within a single `sources[]` create request before any durable write. This prevents SQLite primary-key dedupe from silently storing fewer `memory_sources` rows than the requested/audited source count and keeps provenance evidence unambiguous.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "duplicate explicit memory source ids" --silent` initially exited `1` because the promise resolved and created a memory row. After the fix it exited `0` with `1 passed | 32 skipped`. Combined source-provenance coverage `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "malformed explicit memory sources|blank implicit memory source context|duplicate explicit memory source ids" --silent` exited `0` with `3 passed | 30 skipped`. Related `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent` exited `0` with `3 passed` test files and `77 passed` tests. `pnpm typecheck`, `pnpm lint`, final `pnpm release:check`, and final `git diff --check` exited `0`; `release:check` reported `75 passed | 1 skipped` test files and `1223 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic internal IDs and asserts no orphan/partial memory provenance rows plus FK-clean state.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/contracts.md`, `docs/memory-system.md`, `docs/sqlite-schema.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic governed-memory implicit source provenance hardening.
- **Behavior:** `MemoryRepository.create()` now validates the default/implicit source path as well as explicit `sources[]`. If callers omit `sources[]` but pass a blank/whitespace-only `sourceContext`, the repository rejects the write before any durable memory/source/revision/audit rows are written. If both `sources[]` and `sourceContext` are omitted, the existing deterministic `memory:<memoryId>` fallback remains valid.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "blank implicit memory source context" --silent` initially exited `1` because the promise resolved and created a memory row. After the fix it exited `0` with `1 passed | 31 skipped`. Combined source-provenance coverage `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "malformed explicit memory sources|blank implicit memory source context" --silent` exited `0` with `2 passed | 30 skipped`. Related `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent` exited `0` with `3 passed` test files and `76 passed` tests. `pnpm typecheck` and `pnpm lint` exited `0`. Final `pnpm release:check` exited `0` with `75 passed | 1 skipped` test files and `1222 passed | 8 skipped` tests. Final `git diff --check` exited `0`.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic internal IDs and asserts no orphan/partial memory provenance rows plus FK-clean state.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/contracts.md`, `docs/memory-system.md`, `docs/sqlite-schema.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic governed-memory provenance hardening.
- **Behavior:** `MemoryRepository.create()` now validates explicit source links before durable write transactions. Blank/whitespace-only `sourceId` values and non-finite `sourceTimestamp` values are rejected before any `memory_records`, `memory_sources`, `memory_revisions`, or memory `audit_log` rows are written.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "malformed explicit memory sources" --silent` initially exited `1` because a blank `sourceId` still created a memory row; after the fix it exited `0` with `1 passed | 30 skipped`. Related `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent` exited `0` with `3 passed` test files and `75 passed` tests. `pnpm typecheck` and `pnpm lint` exited `0`. Final `pnpm release:check` exited `0` with `75 passed | 1 skipped` test files and `1221 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic internal IDs and asserts no orphan/partial memory provenance rows plus FK-clean state.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/contracts.md`, `docs/memory-system.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic persistence integrity / Phase 6 completion-audit preparation.
- **Behavior:** fresh migrated SQLite databases now have explicit DB-backed coverage proving `action_executions.executed_job_id` and `action_executions.executed_memory_id` are real foreign-key protected local lookup links, not ad hoc nullable text. Attempts to insert an action execution linked to a missing `jobs` row or missing `memory_records` row fail and leave no partial `action_executions` row.
- **Evidence shown:** Targeted `pnpm exec vitest run tests/unit/storage/database.test.ts -t "action execution memory and job linkage" --silent` exited `0` with `1 passed | 23 skipped`. Related `pnpm exec vitest run tests/unit/storage/database.test.ts tests/unit/actions/action-repository.test.ts tests/unit/actions/action-executor.test.ts --silent` exited `0` with `3 passed` test files and `61 passed` tests. `pnpm typecheck` and `pnpm lint` exited `0`. Final `pnpm release:check` exited `0` with `75 passed | 1 skipped` test files and `1220 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic internal IDs and asserts FK-clean state.
- **Files touched in this slice:** `tests/unit/storage/database.test.ts`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic duplicate generated durable-job group coverage hardening.
- **Behavior:** Runtime behavior is the same as the preceding durable-job idempotency fix: single generated durable job actions keep backward-compatible keys, while duplicate same-group generated durable jobs receive `:actionN` suffixes. This slice closes the remaining coverage gap by proving the rule for `admin_digest` and `silent_summarize_later`, not only `schedule_background_task`.
- **Evidence shown:** Targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "duplicate generated durable" --silent` exited `0` with `1 passed | 32 skipped`, proving two `admin_digest` actions and two `silent_summarize_later` actions in one decision create four distinct pending jobs, expected `:actionN` idempotency keys, four successful action executions, distinct job IDs, and FK-clean temp DB state. Related `pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/job-repository.test.ts tests/unit/types/action.test.ts --silent` exited `0` with `4 passed` test files and `71 passed` tests. `pnpm typecheck` and `pnpm lint` exited `0`. Final `pnpm release:check` exited `0` with `75 passed | 1 skipped` test files and `1219 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic group/conversation labels and asserts FK-clean job/action linkage.
- **Files touched in this slice:** `tests/unit/actions/action-executor.test.ts`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic multi durable-job action idempotency collision hardening.
- **Behavior:** `ActionExecutor` now calculates generated durable-job idempotency suffixes across the priority-sorted action list before execution. Single `admin_digest`, `silent_summarize_later`, and `schedule_background_task` actions keep their previous generated keys, while duplicate same-group durable jobs in one decision receive deterministic `:actionN` suffixes. This prevents multiple same-type background-task actions from reusing one idempotency key and accidentally sharing a single `jobs` row.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "multiple same-type background" --silent` initially exited `1` because two summary actions produced only one distinct job ID; after the fix it exited `0` with `1 passed | 31 skipped`. Full `pnpm exec vitest run tests/unit/actions/action-executor.test.ts --silent` exited `0` with `32 passed`. Related `pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/job-repository.test.ts tests/unit/types/action.test.ts --silent` exited `0` with `4 passed` test files and `70 passed` tests. `pnpm typecheck` and `pnpm lint` exited `0`. Final `pnpm release:check` exited `0` with `75 passed | 1 skipped` test files and `1218 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The regression uses synthetic group/conversation labels and asserts FK-clean job/action linkage.
- **Files touched in this slice:** `src/actions/executor.ts`, `tests/unit/actions/action-executor.test.ts`, `docs/contracts.md`, `docs/social-action-model.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic evaluator-modified action local-control anchoring.
- **Behavior:** `SocialDecisionService` now re-anchors evaluator `modifiedAction` output to the locally constructed base action target and merges constraints without allowing weaker local controls. Evaluators may change action type, payload, and reason, and may add/strengthen constraints, but cannot replace `target.conversationId`, platform delivery `target.userId`, `target.groupId`, canonical governance `target.canonicalUserId`, evaluator-required status, local cooldown key/duration, local response-token cap, local redaction strictness, or locally required capabilities before action-decision persistence/execution.
- **Evidence shown:** `pnpm exec vitest run tests/unit/actions/social-decision-service.test.ts --silent` exited `0` with `4 passed`, including DB-backed target-spoof, weakened-constraints, and downgrade-short-cooldown regressions. Related `pnpm exec vitest run tests/unit/actions/social-decision-service.test.ts tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/types/action.test.ts --silent` exited `0` with `4 passed` test files and `54 passed` tests. App-path `pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "local cooldown and redaction constraints"` exited `0` with `1 passed` test file and `91 passed` tests, proving a group evaluator-modified `reply_with_tool` still preserves local cooldown/redaction/token constraints and downgrades a repeated group reply through the original cooldown key. `pnpm typecheck && pnpm lint` exited `0`. Final `pnpm release:check` exited `0` with `75 passed | 1 skipped` test files and `1217 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB/app-path tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Spoofed target IDs, weakened constraint values, and shortened cooldown suggestions are synthetic test inputs used to prove target/control anchoring.
- **Files touched in this slice:** `src/actions/social-decision-service.ts`, `tests/unit/actions/social-decision-service.test.ts`, `tests/integration/e2e-conversation.test.ts`, `docs/contracts.md`, `docs/social-action-model.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic `SocialDecisionService` private action target identity propagation.
- **Behavior:** `SocialDecisionService` now threads `input.actor.canonicalUserId` into base action target construction for private replies. Persisted private reply actions keep `target.userId` as the normalized platform sender/delivery ID and `target.canonicalUserId` as the actor canonical governance ID. Group reply targets remain group-scoped and do not copy the group sender into `canonicalUserId` as if it were a DM recipient.
- **Evidence shown:** Failing-first `pnpm exec vitest run tests/unit/actions/social-decision-service.test.ts --silent` initially exited `1` because the private target lacked `canonicalUserId`; after the fix it exited `0` with `1 passed`. Related `pnpm exec vitest run tests/unit/actions/social-decision-service.test.ts tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/types/action.test.ts --silent` exited `0` with `4 passed` test files and `51 passed` tests. App-path `pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "private reply"` exited `0` with `1 passed` test file and `90 passed` tests, asserting persisted `action_decisions.actions` preserves platform `target.userId` plus the resolved `platform_accounts.canonical_user_id`. `pnpm typecheck` and `pnpm lint` exited `0`. Final `pnpm release:check` exited `0` with `75 passed | 1 skipped` test files and `1213 passed | 8 skipped` tests; `git diff --check` exited `0`.
- **Safety:** deterministic temp-DB/app-path tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded platform-shaped IDs are synthetic test values and remain local DB control evidence.
- **Files touched in this slice:** `src/actions/social-decision-service.ts`, `tests/unit/actions/social-decision-service.test.ts`, `tests/integration/e2e-conversation.test.ts`, `docs/contracts.md`, `docs/social-action-model.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic `dm_user` canonical/platform target identity boundary.
- **Behavior:** `ActionTarget` now distinguishes `target.userId` as the platform delivery user ID from `target.canonicalUserId` as the privacy/governance user ID. `ActionExecutor` checks proactive-DM opt-out against `target.canonicalUserId`, never the platform delivery ID, sends through the gateway with `target.userId`, and rejects proactive DMs missing a canonical target with `PROACTIVE_DM_CANONICAL_USER_REQUIRED` before privacy lookup or gateway send. `ActionRepository` preserves `target.canonicalUserId` as exact local action-decision control evidence alongside conversation/user/group target keys.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "dm_user" --silent` initially exited `1` because proactive opt-out was checked against platform `target.userId` and missing canonical targets still attempted privacy lookup; after the fix it exited `0` with `5 passed | 26 skipped`. Full `tests/unit/actions/action-executor.test.ts` exited `0` with `31 passed`. Related `pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/database.test.ts tests/unit/cli/governance.test.ts tests/unit/types/action.test.ts --silent` exited `0` with `5 passed` test files and `103 passed` tests. `pnpm typecheck` and `pnpm lint` exited `0`. Final `pnpm release:check` exited `0` with `74 passed | 1 skipped` test files and `1212 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded platform-shaped target IDs were used only as synthetic test values and asserted absent from durable audit strings where redaction applies.
- **Files touched in this slice:** `src/types/action.ts`, `src/actions/executor.ts`, `src/actions/action-repository.ts`, `tests/unit/actions/action-executor.test.ts`, `tests/unit/actions/action-repository.test.ts`, `tests/unit/types/action.test.ts`, `docs/contracts.md`, `docs/social-action-model.md`, `docs/security-privacy.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic `dm_user` proactive-audit metadata persistence.
- **Behavior:** `ActionExecutor` now appends bounded `dm_user` audit metadata to `action_executions.audit_entry` on success, rejection, and failure paths: `dm_proactive`, `dm_trigger`, `dm_opt_out`, `dm_redaction_level`, and `dm_cooldown_key`. Proactive-DM opt-out rejection still occurs before any gateway send; user-requested DMs remain allowed. Action reasons and cooldown keys are redacted through the executor before durable persistence, preserving secret/platform marker classes without storing raw secret-like or QQ/platform-ID-like fragments.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "dm_user" --silent` initially exited `1` because the audit entries lacked `dm_proactive`, `dm_trigger`, and related metadata; after the fix, the same command exited `0` with `4 passed | 26 skipped`, full `tests/unit/actions/action-executor.test.ts` exited `0` with `30 passed`, related `pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/database.test.ts tests/unit/cli/governance.test.ts --silent` exited `0` with `4 passed` test files and `87 passed` tests, `pnpm typecheck` and `pnpm lint` exited `0`, and final `pnpm release:check` exited `0` with `74 passed | 1 skipped` test files and `1211 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded action reasons and cooldown keys containing secret/platform-like fragments are asserted absent from durable `action_executions.audit_entry`.
- **Files touched in this slice:** `src/actions/executor.ts`, `tests/unit/actions/action-executor.test.ts`, `docs/social-action-model.md`, `docs/security-privacy.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic DB-backed L0 guard coverage for durable local actions.
- **Behavior:** No runtime implementation change was needed; the existing `ActionExecutor.getPolicyRejection()` path already guards every non-`silent_store` action. New DB-backed tests prove prohibited decisions and evaluator-required-but-not-passed decisions reject durable local actions (`admin_digest`, `propose_memory`, and `schedule_background_task`) before job or memory side effects. The regressions assert no gateway send, no `jobs`, `memory_records`, `memory_sources`, or `memory_revisions` rows, rejected `action_executions` with `PROHIBITED_ACTION_DECISION` or `EVALUATOR_NOT_PASSED`, null job/memory linkage columns, and FK-clean temp DB state.
- **Evidence shown:** Targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "durable local actions" --silent` exited `0` with `2 passed | 27 skipped`; full `tests/unit/actions/action-executor.test.ts` exited `0` with `29 passed`; related `pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/database.test.ts tests/unit/cli/governance.test.ts --silent` exited `0` with `4 passed` test files and `86 passed` tests; `pnpm typecheck` and `pnpm lint` exited `0`; final `pnpm release:check` exited `0` with `74 passed | 1 skipped` test files and `1210 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The new tests assert rejected durable actions create no job/memory side-effect rows.
- **Files touched in this slice:** `tests/unit/actions/action-executor.test.ts`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic `propose_memory` memory-association opt-out enforcement.
- **Behavior:** `ActionExecutor` now rejects user-scoped `propose_memory` actions when the target user has `memory_association=opted_out`. The check runs after payload parsing but before turn-source lookup and before `MemoryRepository.create`, so no `memory_records`, `memory_sources`, or `memory_revisions` rows are created. The rejected `action_executions` row uses `error_code="MEMORY_ASSOCIATION_OPT_OUT"`, contains bounded audit evidence (`memory_association_opt_out=true`) without copying candidate content, and performs no gateway send. Group/conversation/global proposals are unchanged.
- **Evidence shown:** Failing-first targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "memory association" --silent` initially exited `1` because the action still succeeded and wrote memory; after the fix, `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "memory association|propose_memory" --silent` exited `0` with `4 passed | 23 skipped`, full `tests/unit/actions/action-executor.test.ts` exited `0` with `27 passed`, related `pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/database.test.ts tests/unit/cli/governance.test.ts --silent` exited `0` with `4 passed` test files and `84 passed` tests, `pnpm typecheck` and `pnpm lint` exited `0`, and final `pnpm release:check` exited `0` with `74 passed | 1 skipped` test files and `1208 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. The new rejection path creates no memory rows and does not copy candidate memory content into execution rejection evidence.
- **Files touched in this slice:** `src/actions/executor.ts`, `tests/unit/actions/action-executor.test.ts`, `docs/contracts.md`, `docs/social-action-model.md`, `docs/operations.md`, `docs/security-privacy.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic `propose_memory` governed proposed-memory action execution.
- **Behavior:** `ActionExecutor` now handles approved `propose_memory` actions by creating governed proposal-only memory through `MemoryRepository.create` instead of rejecting the action as unwired. It requires a configured `MemoryRepository` plus a traceable turn source, creates one `memory_records` row in `state='proposed'`, links `memory_sources` to the triggering `raw_event`, writes normal `memory_revisions` and `audit_log` evidence, stores `source_context='action_executor:propose_memory'` instead of copying raw action-provided `sourceContext`, persists `action_executions.executed_memory_id`, returns `executed.memoryId`, and performs no gateway send. Secret/prohibited proposal content is rejected by deterministic memory policy before any memory row is written. `LetheBotApp` passes the runtime `MemoryRepository` to the executor, governance inspection exposes display-redacted `executedMemoryId`, owner/admin `/why` can summarize `memory=<id>` action effects, and startup migration applies an additive compatibility patch for existing local v1 DBs that lack the new column/index.
- **Evidence shown:** Targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "propose_memory" --silent` exited `0` with `3 passed | 23 skipped`; targeted repository/schema coverage `pnpm exec vitest run tests/unit/actions/action-repository.test.ts tests/unit/storage/database.test.ts -t "memory linkage|job and memory linkage|executed memory" --silent` exited `0` with `2 passed | 25 skipped`; targeted governance inspection coverage `pnpm exec vitest run tests/unit/cli/governance.test.ts -t "action decisions, executions" --silent` exited `0` with `1 passed | 29 skipped`; targeted spawned `/why` CLI coverage `pnpm exec vitest run tests/integration/cli-main.test.ts -t "linked action-decision suppressor evidence" --silent` exited `0` with `1 passed | 120 skipped`; combined related coverage `pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/database.test.ts tests/unit/cli/governance.test.ts --silent` exited `0` with `4 passed` test files and `83 passed` tests; final `pnpm release:check` exited `0` with `74 passed | 1 skipped` test files and `1207 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded secret/platform-bearing action reasons and raw action `sourceContext` text were redacted or omitted before durable memory/action/governance evidence, and policy-blocked secret content created no memory rows.
- **Files touched in this slice:** `src/actions/executor.ts`, `src/actions/action-repository.ts`, `src/storage/database.ts`, `src/index.ts`, `src/cli/governance.ts`, `src/cli/main.ts`, `migrations/001_initial_schema.sql`, `tests/unit/actions/action-executor.test.ts`, `tests/unit/actions/action-repository.test.ts`, `tests/unit/storage/database.test.ts`, `tests/unit/cli/governance.test.ts`, `tests/integration/cli-main.test.ts`, `docs/contracts.md`, `docs/sqlite-schema.md`, `docs/social-action-model.md`, `docs/operations.md`, `docs/agent-governance.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic `schedule_background_task` action durable job scheduling.
- **Behavior:** `ActionExecutor` now handles approved `schedule_background_task` actions by scheduling known durable local background jobs instead of rejecting the action or sending a gateway message. It requires a configured durable job repository, accepts only finite durable task types (`summary`, `extraction`, `consolidation`, `decay`, `conflict`, `admin_digest`, and `retention`), enqueues one pending job with generated `action:schedule_background_task:<decisionId>:<taskType>` idempotency so raw model-supplied idempotency keys cannot persist secrets/platform IDs, stores redacted worker-consumable task fields plus bounded audit provenance and `taskPayload`, persists `action_executions.executed_job_id`, and returns `executed.jobId`.
- **Evidence shown:** Targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "schedule_background_task" --silent` first failed because `schedule_background_task` was still rejected as `ACTION_NOT_IMPLEMENTED`, then exited `0` with `1 passed | 19 skipped`; related `pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts --silent` exited `0` with `2 passed` test files and `23 passed` tests; follow-up `pnpm typecheck` and `pnpm lint` exited `0`; final `pnpm release:check` exited `0` with `74 passed | 1 skipped` test files and `1199 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded secret/platform-bearing action reasons, task payload fields, and raw action idempotency key material were redacted or omitted before durable job payload/evidence persistence, while safe local conversation labels remain available for bounded lookup context.
- **Files touched in this slice:** `src/types/action.ts`, `src/actions/executor.ts`, `tests/unit/actions/action-executor.test.ts`, `docs/contracts.md`, `docs/social-action-model.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic `admin_digest` action durable job linkage.
- **Behavior:** `ActionExecutor` now handles approved `admin_digest` actions by scheduling durable local background jobs instead of rejecting the action or sending a gateway message. It requires a configured durable job repository, enqueues one pending `admin_digest` job with `action:admin_digest:<decisionId>` idempotency, stores only coarse redacted payload fields (`source`, `actionDecisionId`, action type, conversation type, digest window, and redacted reason summary), persists `action_executions.executed_job_id`, and returns `executed.jobId`. `LetheBotApp` passes the runtime `JobRepository` to the executor, governance inspection exposes display-redacted `executedJobId`, and `runMigration` applies an additive compatibility patch for existing local v1 DBs that lack the new column/index.
- **Evidence shown:** Targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "admin_digest" --silent` first failed because `admin_digest` was still rejected as `ACTION_NOT_IMPLEMENTED`, then exited `0` with `1 passed | 18 skipped`; targeted schema-compatibility coverage `pnpm exec vitest run tests/unit/storage/database.test.ts -t "action execution job linkage" --silent` exited `0` with `1 passed | 22 skipped`; targeted governance inspection coverage `pnpm exec vitest run tests/unit/cli/governance.test.ts -t "action decisions, executions, and tool calls" --silent` exited `0` with `1 passed | 29 skipped`; combined related coverage `pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/database.test.ts tests/unit/cli/governance.test.ts --silent` exited `0` with `4 passed` test files and `75 passed` tests. Final `pnpm release:check` exited `0` with `74 passed | 1 skipped` test files and `1198 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded secret/platform-bearing action reasons and job IDs were redacted in job payload and governance display evidence, while exact local IDs remain DB lookup evidence.
- **Files touched in this slice:** `src/actions/executor.ts`, `src/actions/action-repository.ts`, `src/storage/database.ts`, `src/index.ts`, `src/cli/governance.ts`, `src/cli/main.ts`, `migrations/001_initial_schema.sql`, `tests/unit/actions/action-executor.test.ts`, `tests/unit/storage/database.test.ts`, `tests/unit/cli/governance.test.ts`, `docs/contracts.md`, `docs/sqlite-schema.md`, `docs/social-action-model.md`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 6 deterministic `admin_digest` dynamic sample redaction boundary.
- **Behavior:** `AdminDigestWorker.generate()` now redacts dynamic sample identifiers and classifier fields before returning digest evidence or writing generated `admin_digest.generated` audit details. The boundary covers failed job IDs/types, action-execution IDs/action types/status strings, tool-call IDs/tool names/status strings, and high-risk audit IDs/event types. Raw source DB rows remain unchanged local evidence; the digest returns counts plus redacted samples only, never payloads, tool input/output, error diagnostics, raw chat text, seeded secrets, or platform-like IDs.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/workers/admin-digest.test.ts -- --runInBand` first failed on leaked dynamic sample identifiers/classifier fields, then exited `0` with `1 passed`; related `pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "admin digest jobs"` exited `0` with `89 passed`; follow-up `pnpm typecheck`, `pnpm lint`, and `git diff --check` exited `0`; final `pnpm release:check` exited `0` with `74 passed | 1 skipped` test files and `1196 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB worker tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded assignment-shaped secret/platform values were redacted in returned worker output and generated audit details.
- **Files touched in this slice:** `src/workers/admin-digest.ts`, `tests/unit/workers/admin-digest.test.ts`, `docs/operations.md`, `docs/security-privacy.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 4 deterministic governance `/why` default latest-turn linked tool-call explainability.
- **Behavior:** Owner/admin `why` without `--turn` now has explicit deterministic coverage proving the latest resolved turn uses the same linked redacted tool-call summary path as `why --turn`. The regression seeds older and latest turns with linked tool calls, then proves only the latest turn's tool-call ID, tool name, status, `requested_by`, duration, error code, and bounded error message are displayed after redaction. It also proves older-turn tool calls, tool input/output payloads, raw event/chat text, seeded secret-like fragments, and raw platform-like IDs are omitted and the command is read-only/FK-clean.
- **Evidence shown:** Targeted `pnpm test:run tests/integration/cli-main.test.ts -- --runInBand -t "without --turn"` exited `0` with `121 passed`; follow-up `pnpm typecheck`, `pnpm lint`, and `git diff --check` exited `0`; final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1195 passed | 8 skipped` tests.
- **Safety:** deterministic spawned CLI / temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded secret-like and platform-like values were redacted in displayed `/why` output and persisted tool-call evidence.
- **Files touched in this slice:** `tests/integration/cli-main.test.ts`, `docs/operations.md`, `docs/agent-governance.md`, `docs/pi-integration.md`, `docs/tool-registry.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 4 deterministic PiAdapter `group.recent_summary` privacy boundary.
- **Behavior:** PiAdapter no longer exposes the built-in group-only `group.recent_summary` tool in private turns, and a group turn without a current group identifier returns only a rejected no-data result instead of falling back to any other group. The regression seeds other-group text plus secret/platform-like fragments and proves private prompts hide the tool, the missing-group rejection does not read or leak other-group rows, and persisted `tool_calls` / `audit_log` evidence contains only redacted rejection summaries.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "group.recent_summary"` exited `0` with `48 passed`; follow-up `pnpm typecheck`, `pnpm lint`, and `git diff --check` exited `0`; final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1195 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB PiAdapter tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded secret-like/platform-like values and other-group text stayed out of prompt-facing and persisted rejection evidence.
- **Files touched in this slice:** `src/pi/pi-adapter.ts`, `tests/unit/pi/pi-adapter.test.ts`, `docs/pi-integration.md`, `docs/tool-registry.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 deterministic acceptance DB-summary tool-call status aggregation.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<path>` remains read-only and aggregate-only, but `counts.toolCalls` is now a status breakdown (`total`, `success`, `error`, `timeout`, `rejected`, `other`) rather than a lone total. The regression seeds successful, rejected, and errored tool calls with secret/platform-bearing input/output/error payloads and proves the JSON summary exposes only counts while omitting tool payloads, tool diagnostics, raw message text, platform-like IDs, and DB row contents.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/scripts/local-acceptance-evidence.test.ts -- --runInBand -t "summarizes an acceptance database with aggregate-only redacted evidence|fails required acceptance DB hints"` exited `0` with `39 passed`; follow-up `pnpm typecheck`, `pnpm lint`, and `git diff --check` exited `0`; final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1194 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB acceptance-summary tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/operations.md`, `docs/local-container-acceptance.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 4 deterministic governance `/why` failed-turn linked tool-call explainability.
- **Behavior:** Owner/admin `why --turn <turn-id>` explanations now include linked redacted tool-call summaries even when the turn itself failed and has no action decision. The spawned-CLI regression seeds a failed `agent_turns.status="failed"` row with a stored context trace and linked rejected/error `tool_calls`, then proves `/why` displays the tool-call ID, tool name, status, `requested_by`, duration, error code, and redacted error message without printing tool input/output payloads, failed-turn raw runtime response text, raw raw-event/chat text, seeded secret-like values, or raw platform-like IDs. The command is read-only and leaves the DB rows unchanged with clean foreign keys.
- **Evidence shown:** Targeted `pnpm test:run tests/integration/cli-main.test.ts -- --runInBand -t "failed turns with linked redacted tool-call evidence"` exited `0` with `121 passed`; `pnpm typecheck`, `pnpm lint`, and `git diff --check` exited `0`; final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1194 passed | 8 skipped` tests.
- **Safety:** deterministic spawned CLI / temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded secret-like and platform-like values were redacted in displayed `/why` output and persisted tool-call evidence.
- **Files touched in this slice:** `tests/integration/cli-main.test.ts`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/agent-governance.md`, `docs/tool-registry.md`, `docs/pi-integration.md`, `docs/operations.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 4 deterministic PiAdapter `beforeToolCall`-only rejection traceability.
- **Behavior:** `PiAdapter` already audits and records tool-call IDs when Pi reaches the `beforeToolCall` hook and policy/evaluator review blocks execution before the wrapped tool handler runs. This slice adds a deterministic temp-DB regression for that hook-only path during `agent.prompt`: when Pi triggers `beforeToolCall`, the evaluator boundary rejects the tool, no handler runs, the turn fails, and `PiAdapterOutput.toolCallIds` still contains the rejected call ID so the failed turn can be correlated with durable `tool_calls` and `audit_log` evidence.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "beforeToolCall-only rejected tool call ids"` exited `0` with `47 passed`; full `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand` exited `0` with `47 passed`; `pnpm typecheck` and `pnpm lint` exited `0`; final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1193 passed | 8 skipped` tests; `git diff --check` passed.
- **Safety:** deterministic temp-DB PiAdapter tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded secret-like hook args were redacted in persisted `tool_calls` and `audit_log` evidence.
- **Files touched in this slice:** `tests/unit/pi/pi-adapter.test.ts`, `docs/pi-integration.md`, `docs/tool-registry.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 4 deterministic PiAdapter handler-error tool-call traceability.
- **Behavior:** `PiAdapter` already records tool-call IDs for adapter-audited attempts that reach execution-time policy, including evaluator-required rejections, policy denials, handler errors, and successes. This slice adds a deterministic temp-DB regression for the handler-error path during `agent.prompt`: when Pi proposes an evaluator-bypass tool whose handler throws and the turn fails, `PiAdapterOutput.toolCallIds` still contains the errored call ID so the failed turn can be correlated with durable `tool_calls` and `audit_log` evidence.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "errored tool call ids"` exited `0` with `46 passed`; full `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand` exited `0` with `46 passed`; `pnpm typecheck` and `pnpm lint` exited `0`; final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1192 passed | 8 skipped` tests; `git diff --check` passed.
- **Safety:** deterministic temp-DB PiAdapter tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded secret-like handler input/error text was redacted in returned failed-turn output plus persisted `tool_calls` and `audit_log` evidence.
- **Files touched in this slice:** `tests/unit/pi/pi-adapter.test.ts`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 4 deterministic PiAdapter rejected tool-call traceability.
- **Behavior:** `PiAdapter` records tool-call IDs for adapter-audited attempts that reach execution-time policy, including evaluator-required rejections, policy denials, handler errors, and successes. When Pi proposes a tool that is rejected by the current policy/evaluator boundary and the turn fails, `PiAdapterOutput.toolCallIds` still contains the rejected call ID so the failed turn can be correlated with durable `tool_calls` and `audit_log` evidence.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "rejected tool call ids"` exited `0` with `45 passed`; follow-up `pnpm typecheck && pnpm lint && pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand` exited `0` with `45 passed`; final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1191 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB PiAdapter tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed. Seeded secret-like tool input was redacted in persisted `tool_calls` and `audit_log` evidence.
- **Files touched in this slice:** `src/pi/pi-adapter.ts`, `tests/unit/pi/pi-adapter.test.ts`, `docs/pi-integration.md`, `docs/tool-registry.md`, `docs/full-project-gap-analysis.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 deterministic acceptance DB-summary `react_only` fallback boundary.
- **Behavior:** `acceptance:db-summary --require-acceptance-hints` remains strict about complete delivered-reply evidence. Downgraded `react_only` face/text fallback may now have same-path `bot.response` traceability from the app path, but it is still reaction fallback evidence and must not satisfy complete private/group reply-loop acceptance hints. Runbooks now call out both `send_folded_forward` fallback and `react_only` fallback as excluded from complete delivered-reply success.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/scripts/local-acceptance-evidence.test.ts -t "react_only face-message fallback|folded-forward fallback|reply_with_tool success"` exited `0` with `3 passed | 36 skipped`. Final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1191 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB acceptance-summary tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/operations.md`, `docs/local-container-acceptance.md`, `docs/full-project-gap-analysis.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic `react_only` face-message fallback `bot.response` traceability.
- **Behavior:** Main turn handling now treats downgraded `react_only` executions with an executed message ID as reply-like delivery evidence. If the gateway cannot perform a true reaction but can send a face/text fallback, LetheBot persists the fallback message as `bot.response` / `bot-self` evidence using the delivered `payload.reaction`; true reactions without a message ID still do not create bot-response chat rows, and `agent_turns.response_text` continues to preserve the raw Pi draft.
- **Evidence shown:** Targeted `pnpm test:run tests/integration/e2e-conversation.test.ts -t "react_only face-message fallback"` first failed because the fallback send had no persisted `bot.response` row; after the fix it passed with `1 passed | 88 skipped`. Follow-up `pnpm typecheck && pnpm lint && pnpm test:run tests/integration/e2e-conversation.test.ts -t "react_only action execution|react_only face-message fallback|evaluator-modified delivered text"` exited `0` with `3 passed | 86 skipped`. The then-current full `pnpm release:check` exited `0`; the current authoritative full-gate count is recorded in the verified snapshot above.
- **Safety:** deterministic Fake OneBot / temp-DB integration tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/index.ts`, `tests/integration/e2e-conversation.test.ts`, `docs/social-action-model.md`, `docs/pi-integration.md`, `docs/full-project-gap-analysis.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic delivered-text `bot.response` traceability.
- **Behavior:** Main turn handling now persists the actual delivered reply action `payload.text` as `bot.response` evidence when a successful reply-like action or folded-forward fallback returns an executed message ID. This closes the gap where evaluator/tool-modified outbound text was sent through the executor but the persisted `bot.response` row still used the raw Pi draft; `agent_turns.response_text` continues to preserve the original Pi output for reasoning evidence.
- **Evidence shown:** Targeted `pnpm test:run tests/integration/e2e-conversation.test.ts -t "evaluator-modified delivered text"` first failed because the bot-response row contained the Pi draft; after the fix it passed with `1 passed | 87 skipped`. The then-current full `pnpm release:check` exited `0`; the current authoritative full-gate count is recorded in the verified snapshot above.
- **Safety:** deterministic Fake OneBot / temp-DB integration tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/index.ts`, `tests/integration/e2e-conversation.test.ts`, `docs/social-action-model.md`, `docs/pi-integration.md`, `docs/full-project-gap-analysis.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic `react_only` `/why` effect explainability.
- **Behavior:** Owner/admin `why` output now derives a display-redacted `effect=` label for `react_only` executions from durable action-execution status/message evidence: `true_reaction` for successful true reactions with no message ID, `face_message_fallback` for downgraded reaction fallbacks with an executed message ID, and `silent_reaction_fallback` for downgraded reaction fallbacks without a message ID. This keeps governance explanations aligned with the distinction between true reactions, fallback messages, and silent evidence.
- **Evidence shown:** Targeted `pnpm test:run tests/integration/cli-main.test.ts -t "react_only side-effect labels"` first failed because `effect=` labels were absent, then passed with `1 passed | 119 skipped`. The then-current full `pnpm release:check` exited `0`; the current authoritative full-gate count is recorded in the verified snapshot above.
- **Safety:** deterministic spawned CLI / temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/cli/governance.ts`, `src/cli/main.ts`, `tests/integration/cli-main.test.ts`, `docs/social-action-model.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic true `react_only` app-path evidence.
- **Behavior:** A full integration flow now routes an evaluator-approved `react_only` action through `LetheBotApp` and `ActionExecutor` using `FakeOneBot` with `reactions.emojiLike=true`. The test proves true reaction side effects are recorded separately from fake sent messages, the action execution is persisted as `status="success"` without `executed_message_id`, and main turn handling does not create `bot.response` / `bot-self` chat-message evidence for reaction-only delivery.
- **Evidence shown:** Targeted `pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "react_only action execution"` passed with `87 passed`. The then-current full `pnpm release:check` exited `0`; the current authoritative full-gate count is recorded in the verified snapshot above.
- **Safety:** deterministic Fake OneBot / temp-DB integration tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `tests/integration/e2e-conversation.test.ts`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic fake-gateway reaction observability.
- **Behavior:** `FakeOneBot.sendReaction()` now records reaction side effects independently from fake sent messages. Tests can inspect `getSentReactions()`, `getLastSentReaction()`, and `assertReactionSent()`, and `reset()` clears reaction history. This preserves the distinction between true reaction delivery and face/text fallback messages in deterministic tests.
- **Evidence shown:** Targeted `pnpm test:run tests/fakes/fake-onebot.test.ts -- --runInBand -t "sendReaction|reset"` initially failed because reaction helpers did not exist; after implementation it passed with `31 passed`.
- **Safety:** deterministic fake-gateway tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `tests/fakes/fake-onebot.ts`, `tests/fakes/fake-onebot.test.ts`, `docs/fake-gateway-design.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 gateway capability truthfulness / real OneBotAdapter folded-forward capability alignment.
- **Behavior:** Real `OneBotAdapter.getCapabilities()` now reports only currently implemented delivery capabilities: QQ face/text reaction fallback remains available, true emoji-like reaction is unavailable, and group/private/custom folded-forward node delivery is unavailable. This prevents reasoning/policy layers from treating real folded-forward node delivery as proven while preserving FakeOneBot's stronger configurable capabilities for deterministic executor tests.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/gateway/onebot-adapter.test.ts -- --runInBand -t "implemented OneBot gateway capabilities"` initially failed because folded-forward capabilities were reported as `true`; after the capability report was corrected it passed with `47 passed`.
- **Safety:** deterministic unit test only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/gateway/onebot-adapter.ts`, `tests/unit/gateway/onebot-adapter.test.ts`, `docs/contracts.md`, `docs/social-action-model.md`, `docs/pi-integration.md`, `docs/full-project-gap-analysis.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / `reply_with_tool` delivered-reply DB-summary alignment.
- **Behavior:** `acceptance:db-summary --require-acceptance-hints` now treats successful `reply_with_tool` action executions as delivered reply evidence when the execution has an `executed_message_id` and that message is persisted as a same-path `bot.response` / `bot-self` chat row. This matches the action executor and main turn persistence behavior for prepared tool-assisted replies. `send_folded_forward` downgraded text fallback is intentionally still excluded from complete acceptance delivered-reply evidence because real OneBot/NapCat folded-forward node delivery is not implemented.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/scripts/local-acceptance-evidence.test.ts -- --runInBand -t "reply_with_tool success|requires complete linked chat flows to include a delivered reply action|requires delivered reply actions"` initially failed because the group `reply_with_tool` flow had persisted bot-response evidence but `completeLinkedReplyFlows`, `completeLinkedBotResponseFlows`, and `completeLinkedTargetedFlows` were `0`; after the SQL delivered-reply list was updated it passed with `37 passed`. A follow-up negative regression for `send_folded_forward` downgraded fallback also passed; the combined targeted acceptance-summary filter passed with `38 passed`.
- **Safety:** deterministic temp-DB acceptance-summary tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real acceptance DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/operations.md`, `docs/local-container-acceptance.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic outward-action `bot.response` persistence evidence.
- **Behavior:** Main turn handling now recognizes newly wired outward action paths that actually produced a gateway message ID. Successful `reply_with_tool` deliveries and downgraded `send_folded_forward` text fallbacks are treated as persisted bot-response candidates, so after action execution LetheBot creates the same-path `raw_events(type="bot.response")` and `chat_messages(sender_id="bot-self")` evidence already used by ordinary replies. This keeps local acceptance DB evidence aligned with all currently supported outward reply-like paths without treating silent downgrades, failed sends, true reactions, or unsupported actions as bot replies.
- **Evidence shown:** Targeted `pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "reply_with_tool delivery|folded-forward text fallback"` initially failed because both sent paths had action execution rows but no persisted `bot.response` rows; after the fix it passed with `86 passed`. Final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1179 passed | 8 skipped` tests.
- **Safety:** deterministic Fake OneBot / temp-DB integration tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/index.ts`, `tests/integration/e2e-conversation.test.ts`, `docs/pi-integration.md`, `docs/social-action-model.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic `send_folded_forward` conservative fallback action executor boundary.
- **Behavior:** `ActionExecutor` now handles `send_folded_forward` instead of rejecting it as unwired. Real OneBot/NapCat folded-forward node delivery is still not implemented; this slice adds only conservative fallback semantics. When the action contains a target and safe prepared `payload.text`, the executor sends that one text fallback and persists a `downgraded` `action_executions` row with `downgradedFrom="send_folded_forward"`. When no fallback text or target is available, it records downgraded silent evidence and performs no gateway side effect. The existing L0 prohibited-risk and evaluator-required guards run before fallback delivery.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/actions/action-executor.test.ts -- --runInBand -t "send_folded_forward"` initially failed because `send_folded_forward` was still rejected as not implemented and no fallback side effect occurred; after the fix it passed with `18 passed`. Full action-executor coverage passed with `18 passed`; `pnpm typecheck` and `pnpm lint` passed. Final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1177 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/actions/executor.ts`, `tests/unit/actions/action-executor.test.ts`, `docs/social-action-model.md`, `docs/pi-integration.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic `react_only` capability-gated action executor boundary.
- **Behavior:** `ActionExecutor` now executes `react_only` through gateway capability checks rather than rejecting it as unwired. It requires `payload.reaction` and `payload.messageId`, prefers true gateway `sendReaction` when `reactions.emojiLike=true`, falls back to a face/text message when `reactions.faceMessage=true`, and otherwise records a downgraded silent execution with no gateway side effect. The existing L0 prohibited-risk and evaluator-required guards run before true reaction or fallback delivery, so direct action-decision callers cannot bypass evaluator rejection through this lightweight side-effect path.
- **Evidence shown:** Targeted `pnpm test:run tests/unit/actions/action-executor.test.ts -- --runInBand -t "react_only"` initially failed because `react_only` was still rejected as not implemented and no reaction/fallback side effects occurred; after the fix it passed with `15 passed`. Full action-executor coverage passed with `15 passed`; `pnpm typecheck` and `pnpm lint` passed. Final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1174 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/actions/executor.ts`, `src/types/action.ts`, `tests/unit/actions/action-executor.test.ts`, `docs/contracts.md`, `docs/social-action-model.md`, `docs/pi-integration.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic `reply_with_tool` action executor delivery boundary.
- **Behavior:** `ActionExecutor` now treats `reply_with_tool` as an outward reply delivery action. Tool execution, tool policy, sandbox/audit, and tool-result persistence remain PiAdapter / ToolRegistry responsibilities; the executor only sends the already-prepared `payload.text` to the normal reply target, then persists a normal `action_executions` result. The same L0 prohibited-risk and evaluator-required guards used for ordinary replies run before any gateway sender call, so direct action-decision callers cannot bypass evaluator rejection by choosing `reply_with_tool`.
- **Evidence shown:** `pnpm test:run tests/unit/actions/action-executor.test.ts -- --runInBand` passed with `11 passed`; `pnpm typecheck` and `pnpm lint` passed. Final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1170 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/actions/executor.ts`, `tests/unit/actions/action-executor.test.ts`, `docs/social-action-model.md`, `docs/pi-integration.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic built-in `group.recent_summary` group-context read-only boundary.
- **Behavior:** LetheBot now registers `group.recent_summary` with built-in tools. Its metadata declares `read_context`, group-chat-only permissions, `evaluatorPolicy=bypass`, `redacted_full` audit, no filesystem/network access, in-process bounded execution, and `secret_possible` output. The handler reads only bounded recent `chat_messages` rows for the current runtime group, returns aggregate counts and sanitized chronological excerpts, labels speakers as `participant_N` or `bot`, omits raw sender IDs, group IDs, message IDs, raw event IDs, and other groups' text, and redacts secret/platform-like fragments before prompt-facing results and persisted `tool_calls` / `audit_log` details.
- **Evidence shown:** `pnpm test:run tests/unit/tools/memory-search.test.ts -- --runInBand` passed with `11 passed`; `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "group.recent_summary|memory.disable|memory.propose|memory.search"` passed with `44 passed`; full PiAdapter coverage passed with `44 passed`; `pnpm typecheck` and `pnpm lint` passed. Final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1168 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/tools/builtins/memory-search.ts`, `src/index.ts`, `src/pi/pi-adapter.ts`, `tests/unit/tools/memory-search.test.ts`, `tests/unit/pi/pi-adapter.test.ts`, `docs/pi-integration.md`, `docs/tool-registry.md`, `docs/context-orchestration.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic built-in `memory.disable` lifecycle boundary.
- **Behavior:** LetheBot now registers `memory.disable` with built-in tools. Its metadata declares `read_context` + `modifies_memory`, `evaluatorPolicy=required`, `redacted_full` audit, no filesystem/network access, and sensitive output. The current PiAdapter policy gate rejects direct Pi execution until evaluator approval is wired and persists rejected `tool_calls` / `audit_log` evidence while leaving target memory active. The direct handler disables only allowed non-deleted active memory through `MemoryRepository`, records revision/audit evidence, returns no durable memory/source IDs, allows ordinary actors only for their own eligible user memory, rejects disallowed/proposed/missing requests without mutation, and removes disabled memory from ordinary retrieval immediately.
- **Evidence shown:** `pnpm test:run tests/unit/tools/memory-search.test.ts -- --runInBand` passed with `9 passed`; `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "memory.disable|memory.propose|memory.search"` passed with `43 passed`; full PiAdapter coverage passed with `43 passed`; `pnpm typecheck` and `pnpm lint` passed. Final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1165 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/tools/builtins/memory-search.ts`, `tests/unit/tools/memory-search.test.ts`, `tests/unit/pi/pi-adapter.test.ts`, `docs/pi-integration.md`, `docs/tool-registry.md`, `docs/memory-system.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic built-in `memory.propose` proposal boundary.
- **Behavior:** LetheBot now registers `memory.propose` with built-in tools. Its metadata declares `read_context` + `modifies_memory`, `evaluatorPolicy=required`, `redacted_full` audit, no filesystem/network access, and sensitive output. The current PiAdapter policy gate rejects direct Pi execution until evaluator approval is wired and persists rejected `tool_calls` / `audit_log` evidence without creating memory. The direct handler remains proposal-only: it creates only `state=proposed` memory through `MemoryRepository`, links source metadata to the tool call, records memory revision/audit evidence, returns no durable memory/source IDs, keeps group-chat user proposals `same_group_only`, rejects ordinary-user global proposals, and returns rejected output for deterministic secret/prohibited policy without durable rows.
- **Evidence shown:** `pnpm test:run tests/unit/tools/memory-search.test.ts -- --runInBand` passed with `7 passed`; `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "memory.propose|memory.search"` passed with `42 passed`; full PiAdapter coverage passed with `42 passed`; `pnpm typecheck` and `pnpm lint` passed. Final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1162 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/tools/builtins/memory-search.ts`, `tests/unit/tools/memory-search.test.ts`, `tests/unit/pi/pi-adapter.test.ts`, `docs/pi-integration.md`, `docs/tool-registry.md`, `docs/memory-system.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic built-in `memory.search` tool.
- **Behavior:** LetheBot now registers `memory.search` as an initial product-like read-only tool at app startup. The handler uses `MemoryRepository.retrieve/search`, requires canonical actor identity, returns only visible current-user/current-group/global memory for the invocation context, excludes other users' group-derived memory, omits durable memory IDs and source event IDs, and coarsens source context before returning output to Pi. The PiAdapter path proves exposure/execution through ToolRegistry/PolicyGate boundaries with persisted `tool_calls` and `audit_log` rows, redacted output details, and group context in audit details.
- **Evidence shown:** `pnpm test:run tests/unit/tools/memory-search.test.ts -- --runInBand` passed with `4 passed`; `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "memory.search"` passed with `41 passed`; full PiAdapter coverage passed with `41 passed`; `pnpm typecheck` and `pnpm lint` passed. Final `pnpm release:check` exited `0` with `73 passed | 1 skipped` test files and `1158 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/tools/builtins/memory-search.ts`, `src/tools/index.ts`, `src/index.ts`, `tests/unit/tools/memory-search.test.ts`, `tests/unit/pi/pi-adapter.test.ts`, `docs/pi-integration.md`, `docs/tool-registry.md`, `docs/memory-system.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic action execution return-value redaction.
- **Behavior:** `ActionRepository.createExecution()` now returns redacted downgrade reason, diagnostic code/message, and audit-entry values matching the durable `action_executions` row. This closes a direct-caller gap where persistence was redacted but the returned `ActionExecutionResult` still exposed raw diagnostics.
- **Evidence shown:** targeted regression `pnpm test:run tests/unit/actions/action-repository.test.ts -- --runInBand -t "sensitive action decision"` initially failed because the returned execution result contained raw downgrade/error/audit text; after the fix, full action repository coverage passed with `3 passed`, action executor coverage passed with `9 passed`, and `pnpm typecheck` / `pnpm lint` passed. Final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1153 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `src/actions/action-repository.ts`, `tests/unit/actions/action-repository.test.ts`, `docs/social-action-model.md`, `docs/sqlite-schema.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic Pi input group identity proof.
- **Behavior:** The existing group-flow E2E now captures the Pi runtime input and asserts the same gateway-normalized group identifier is present in both `ContextPack.conversation.groupId` and `actor.groupId`. This closes the proof gap between durable context traces and the actual Pi call boundary.
- **Evidence shown:** targeted `pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "numeric bot at value"` passed with `84 passed`, PiAdapter unit coverage passed with `40 passed`, and `pnpm typecheck` / `pnpm lint` passed. Final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1153 passed | 8 skipped` tests.
- **Safety:** deterministic Fake OneBot / temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, private platform identifier, token, or cookie was read or printed.
- **Files touched in this slice:** `tests/integration/e2e-conversation.test.ts`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic group identity normalization.
- **Behavior:** LetheBot now keeps the gateway-normalized `qq-group-*` group identifier through ContextBuilder, durable `context_traces.group_id`, Pi actor context, and group-scoped tool policy checks. This removes the previous split where chat rows/display metadata used `qq-group-*` while context/tool paths saw the stripped numeric suffix.
- **Evidence shown:** regression first failed after expectations were updated because group context traces still stored bare numeric group IDs. After the fix, targeted `pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "numeric bot at value"` passed with `84 passed`, PiAdapter unit coverage passed with `40 passed`, and `pnpm typecheck` / `pnpm lint` passed. Final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1153 passed | 8 skipped` tests.
- **Safety:** deterministic Fake OneBot / temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/index.ts`, `tests/integration/e2e-conversation.test.ts`, `docs/contracts.md`, `docs/context-orchestration.md`, `docs/sqlite-schema.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic PiAdapter / tool audit context hardening.
- **Behavior:** PiAdapter tool audit details now include the runtime `groupId` whenever group context is present for a tool execution attempt. This gives owner/admin review durable evidence for group-scoped tool execution or rejection without changing SQLite schema or exposing allowlist tables to ordinary prompts.
- **Evidence shown:** regression first failed because successful and rejected group-scoped tool audits omitted `groupId`. After the fix, targeted `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "group context in tool audit"` passed with `40 passed`, full PiAdapter unit coverage passed with `40 passed`, and `pnpm typecheck` / `pnpm lint` passed. Final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1153 passed | 8 skipped` tests.
- **Safety:** deterministic temp-DB unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/pi/pi-adapter.ts`, `tests/unit/pi/pi-adapter.test.ts`, `docs/tool-registry.md`, `docs/pi-integration.md`, `docs/sqlite-schema.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic PiAdapter / tool policy context hardening.
- **Behavior:** `PiAdapter` now builds a registry `ActorContext` that includes the current group identifier from `actor.groupId` or `ContextPack.conversation.groupId`, and uses it for tool exposure, wrapped handler execution, and `beforeToolCall` policy checks. Group-scoped tools declared with `allowedGroupIds` are visible/executable only in matching group chats; non-matching group contexts remain filtered.
- **Evidence shown:** regression first failed because a matching `allowedGroupIds` tool was not exposed and `beforeToolCall` denied the group-scoped call. After the fix, targeted `pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand` passed with `39 passed`, registry/PiAdapter coverage passed with `49 passed`, and `pnpm typecheck` / `pnpm lint` passed. Final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1152 passed | 8 skipped` tests.
- **Safety:** deterministic unit tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/pi/pi-adapter.ts`, `src/index.ts`, `src/types/tool.ts`, `tests/unit/pi/pi-adapter.test.ts`, `docs/contracts.md`, `docs/tool-registry.md`, `docs/pi-integration.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic tool registry / policy hardening.
- **Behavior:** `ToolRegistry.checkPermission()` now enforces declared `deniedUserIds`, `allowedUserIds`, `deniedGroupIds`, and `allowedGroupIds` after actor-class and invocation-context checks. Deny lists win, and non-empty allow lists reject missing/non-matching canonical user or group identifiers.
- **Evidence shown:** regression first failed because a denied user was still allowed. After the fix, targeted `pnpm exec vitest run tests/unit/tools/registry.test.ts -t "user allow and deny" --silent` passed with `1 passed`, related registry/file/Pi policy coverage passed with `17 passed`, full registry/PiAdapter unit coverage passed with `46 passed`, `pnpm typecheck` / `pnpm lint` passed, and final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1149 passed | 8 skipped` tests.
- **Safety:** deterministic unit/integration tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/tools/registry.ts`, `tests/unit/tools/registry.test.ts`, `docs/tool-registry.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic action executor / policy hardening.
- **Behavior:** `ActionExecutor` now rejects outward reply/DM side effects before calling the gateway sender when `riskLevel="prohibited"` or when an evaluator-required outward action lacks `evaluatorPassed=true`. The current no-outward-effect `silent_store` / `silent_summarize_later` paths remain allowed to preserve audit/control evidence for evaluator rejection and downgrade flows.
- **Evidence shown:** regression first failed because direct bypass decisions still called `sendMessage` in both evaluator-not-passed and prohibited-risk cases. After the fix, targeted `pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "evaluator-required|prohibited" --silent` passed with `2 passed`, full action repository/executor coverage passed with `12 passed`, evaluator downgrade/rejection compatibility coverage passed with `4 passed`, `pnpm typecheck` / `pnpm lint` passed, and final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1148 passed | 8 skipped` tests.
- **Safety:** deterministic SQLite temp-DB and fake gateway tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/actions/executor.ts`, `tests/unit/actions/action-executor.test.ts`, `docs/social-action-model.md`, `docs/agent-governance.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic memory lifecycle/retrieval hardening.
- **Behavior:** `MemoryRepository.retrieve` and `MemoryRepository.search` now exclude expired active memories at the repository layer, so lifecycle expiration is enforced before ordinary context retrieval/search instead of relying only on `ContextBuilder`'s later rejection filter.
- **Evidence shown:** regression first failed because expired active records were returned from both retrieve and search. After the fix, targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "expired active memories" --silent` passed with `2 passed`, full memory repository + context builder + memory retrieval coverage passed with `51 passed`, `pnpm typecheck` / `pnpm lint` passed, and final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1146 passed | 8 skipped` tests.
- **Safety:** deterministic SQLite temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/memory-system.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 2 deterministic memory-governance hardening / repository L0 final guard.
- **Behavior:** `MemoryRepository.create` now prevents direct governed-repository callers from storing group-chat-derived user memory as ordinary private/user-wide/public memory. When `scope="user"` and `source_context` starts with `group_chat`, unsafe ordinary visibility is forced to `same_group_only`, and the policy adjustment is recorded in `memory_revisions.reason` plus `audit_log.details.policyAdjustments`.
- **Evidence shown:** regression first failed with `expected 'private_only' to be 'same_group_only'`; after the fix, targeted `pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "group-chat-derived" --silent` passed, full `tests/unit/storage/memory-repository.test.ts` passed with `28 passed`, related proposal/extraction/retrieval tests passed with `42 passed`, `pnpm typecheck` / `pnpm lint` passed, and final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1144 passed | 8 skipped` tests.
- **Safety:** deterministic SQLite temp-DB tests only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real DB rows, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `docs/memory-system.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary selected governed-memory context gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` now exits non-zero unless memory governance evidence includes at least one complete acceptance flow whose durable `context_pack_id` selected context has `selected_memory_ids` referencing an active, source/revision-linked, non-secret/prohibited memory. This prevents an acceptance DB with only memory source/revision rows, or with an unselected/unrelated context trace selecting memory, from satisfying the memory-governance DB hint.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent` passed with `36 passed`; `pnpm typecheck` and `pnpm lint` passed; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1143 passed | 8 skipped` tests.
- **Safety:** deterministic helper/tooling only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real SQLite row dump, QR code, QQ ID, group ID, token, cookie, memory content, or memory ID was printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 3 production hardening / status-document consolidation.
- **Behavior:** `docs/loop-state-recovery.md` and `docs/long-term-development-direction-review.md` are now concise active handoffs instead of append-heavy historical transcripts. Their pre-consolidation contents are preserved in existing tracked archive paths: `docs/archive/loop/loop-state-recovery.md` and `docs/archive/reviews/long-term-development-direction-review.md`. This reduces recovery overhead while keeping historical context available as non-authoritative evidence.
- **Evidence shown:** post-slice `git diff --check` and `pnpm release:check` exited `0`; `pnpm test:run` reported `72 passed | 1 skipped` test files and `1141 passed | 8 skipped` tests.
- **Safety:** docs-only consolidation; no runtime code, local SnowLuma/QQ runtime, local secret file, raw chat text, SQLite row dump, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/archive/loop/loop-state-recovery.md`, `docs/archive/reviews/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary exact group @bot required-hints gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` now includes targeted linked-flow evidence. A private path is targeted by `conversation_type="private"`; a group path must prove the triggering normalized chat row has `mentions_bot=1` in the same selected-turn, QQ raw-event, delivered-reply, persisted-bot-response chain. This prevents an ordinary group chat row with complete turn/action/bot-response rows from satisfying group @bot acceptance DB hints.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent` passed with `34 passed`; `pnpm typecheck` and `pnpm lint` passed; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1141 passed | 8 skipped` tests.
- **Safety:** deterministic helper/tooling only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real SQLite row dump, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary persisted bot-response flow required-hints gate.
- **Behavior:** `pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints` keeps the read-only aggregate-only JSON summary, but exits non-zero unless integrity/FKs are clean and private and group paths separately show chat row, context trace, completed turn, successful action evidence, a complete linked flow where the same completed turn has both a context trace and a successful action execution, and a source-linked complete reply flow where that turn uses its selected durable `context_pack_id` / `action_decision_id` rows, is tied back to the same path's normalized chat row plus `chat.message.received` gateway QQ raw event, has a delivered reply action (`reply_short`, `reply_full`, `reply_with_tool`, or `ask_clarification`) with an `executed_message_id`, and has that sent message persisted as a same-path `bot.response` / `bot-self` chat row. This prevents an empty, incomplete, one-sided, split-evidence, unnormalized/unrelated-trigger, selected-pointer-mismatched, non-QQ/non-chat raw-event, non-reply-success, or missing-bot-response acceptance DB from satisfying the DB-summary command evidence item. The helper still redacts the displayed DB path and does not print row IDs, platform IDs, message text, memory content, tool payloads, audit details, or DB row contents.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent` passed with `33 passed`; `pnpm typecheck` and `pnpm lint` passed; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1140 passed | 8 skipped` tests.
- **Safety:** deterministic helper/tooling only; no local SnowLuma/QQ runtime, local secret file, raw chat text, real SQLite row dump, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / runtime-config exclusivity gate.
- **Behavior:** `local-acceptance-evidence --validate <path> --require-complete` now rejects missing or conflicting checked choices in the local configuration snapshot. Completed evidence must select exactly one compose target, one Pi provider mode, and one OneBot transport, preventing a final evidence file from being accepted with contradictory runtime configuration.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent` passed with `24 passed`; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1131 passed | 8 skipped` tests.
- **Safety:** deterministic evidence-tooling only; no local SnowLuma/QQ runtime, local secret file, raw chat text, SQLite row dump, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/full-project-gap-analysis.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / command-preflight completion gate.
- **Behavior:** `local-acceptance-evidence --validate <path> --require-complete` now requires checked command evidence for both compose `config --quiet` preflights, aggregate-only `pnpm ops:worker-soak` success, FK-clean acceptance DB evidence, and non-leaking required-command summaries. This prevents a filled live evidence file from claiming completion while skipping deterministic command preflight/soak proof.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent` passed with `23 passed`; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1130 passed | 8 skipped` tests.
- **Safety:** deterministic evidence-tooling only; no local SnowLuma/QQ runtime, local secret file, raw chat text, SQLite row dump, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/full-project-gap-analysis.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / mixed-redaction share-safety.
- **Behavior:** `local-acceptance-evidence --validate <path>` no longer lets a nearby `<redacted>` marker or redacted note suppress raw QQ/group/platform-like number detection on the same evidence line. Operators must redact the actual identifier, not annotate around it.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent` passed with `22 passed`; `pnpm typecheck` and `pnpm lint` passed; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1129 passed | 8 skipped` tests.
- **Safety:** deterministic evidence-tooling only; no local SnowLuma/QQ runtime, local secret file, raw chat text, SQLite row dump, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/full-project-gap-analysis.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / governed-memory completion gate.
- **Behavior:** `local-acceptance-evidence --validate <path> --require-complete` now requires memory/privacy acceptance proof: governed memory affects an allowed follow-up answer without cross-scope/private-in-group leakage, group-derived user memory remains conservative and source-linked when applicable, lifecycle/sensitivity exclusions affect ordinary context, and user/admin governance CLI inspection works with redaction.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent` passed with `21 passed`; `pnpm typecheck` and `pnpm lint` passed; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1128 passed | 8 skipped` tests.
- **Safety:** deterministic evidence-tooling only; no local SnowLuma/QQ runtime, local secret file, raw chat text, SQLite row dump, QR code, QQ ID, group ID, token, or cookie was read or printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/full-project-gap-analysis.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / completion gate precision.
- **Behavior:** `local-acceptance-evidence --validate <path> --require-complete` now rejects checked failed/degraded/not-ready acceptance status values instead of treating any checked line as complete. Complete evidence must record healthy `/healthz`, DB ok, adapter ready, ready `/readyz`, completed private and group `agent_turns`, and successful private and group `action_executions`. The template now includes group `agent_turns` status evidence.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent` passed with `20 passed`; `pnpm typecheck` and `pnpm lint` passed; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1127 passed | 8 skipped` tests.
- **Safety:** this is deterministic evidence tooling only. It does not read or print local secrets, SnowLuma/QQ logs, QR codes, chat text, SQLite row contents, QQ IDs, group IDs, or tokens.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/full-project-gap-analysis.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** R9 rollback rehearsal / install-update preflight hardening.
- **Behavior:** added `pnpm ops:rehearse-rollback`, a disposable rollback rehearsal that creates a migrated synthetic SQLite DB, backs it up, applies a synthetic update across raw/chat/failure/audit/memory source/revision rows, restores the backup over the same DB path with overwrite enabled, runs read-only doctor, and emits aggregate-only counts plus SHA-256 fingerprints proving rollback restored the pre-update DB state.
- **Evidence shown:** targeted `pnpm exec vitest run tests/integration/ops-maintenance-cli.test.ts -t "rollback|malformed" --silent` passed with `2 passed | 18 skipped`; full `pnpm exec vitest run tests/integration/ops-maintenance-cli.test.ts --silent` passed with `20 passed`; direct `pnpm --silent ops:rehearse-rollback` exited `0` with `success=true`, backup/restore integrity OK, `restoredMatchesBackup=true`, `syntheticRowsRemoved=true`, doctor `overall="ok"`, and `foreignKeyViolations=0`; `pnpm typecheck`, `pnpm lint`, and final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1126 passed | 8 skipped` tests.
- **Safety:** the rehearsal refuses existing explicit `--db` paths, seeds only synthetic non-secret rows, does not contact SnowLuma/QQ/OneBot, does not call model providers, and does not read local secret files. Output is redacted through the ops JSON display boundary and omits row payloads.
- **Files touched in this slice:** `src/scripts/ops-maintenance.ts`, `package.json`, `tests/integration/ops-maintenance-cli.test.ts`, `docs/operations.md`, `docs/full-project-gap-analysis.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** R9 deployment artifact privacy / packaging hardening.
- **Behavior:** `deploy:docker`, `deploy:systemd`, and `deploy:pm2` now generate reviewable deployment artifacts that reference runtime environment variables instead of embedding the operator's current `ONEBOT_TOKEN`, `LETHEBOT_BOT_QQ_ID`, or OneBot URL values. Docker Compose uses runtime `${...}` interpolation, systemd uses `EnvironmentFile=-<workdir>/.env`, and PM2 reads `process.env.*`.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/deploy-napcat.test.ts --silent` passed with `31 passed`; `pnpm typecheck` and `pnpm lint` passed; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1125 passed | 8 skipped` tests.
- **Safety:** generated artifacts remain useful for local deployment review while avoiding copied tokens, bot QQ IDs, and private OneBot URL values. Tests seed secret/platform-shaped env values and prove generated Docker/systemd/PM2 files do not contain raw secret, raw bot/platform ID, or raw token values.
- **Files touched in this slice:** `src/scripts/deploy-napcat.ts`, `tests/unit/scripts/deploy-napcat.test.ts`, `docs/operations.md`, `docs/full-project-gap-analysis.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** R9 ops durability / install-update preflight hardening.
- **Behavior:** added `pnpm ops:rehearse-maintenance`, a disposable maintenance rehearsal that creates a migrated synthetic SQLite DB, backs it up, restores it, runs read-only doctor before and after applying a 30-day retention policy to the restored copy, and emits aggregate-only JSON for integrity, schema/FK status, fixed counts, and deletion counts.
- **Evidence shown:** baseline `pnpm release:check` was green before implementation. Targeted `pnpm exec vitest run tests/integration/ops-maintenance-cli.test.ts -t "rehearses backup|rejects malformed" --silent` passed; full `pnpm exec vitest run tests/integration/ops-maintenance-cli.test.ts --silent` passed with `19 passed`; direct `pnpm --silent ops:rehearse-maintenance` exited `0` with `success=true`, backup/restore integrity OK, doctor before/after `overall="ok"`, and `foreignKeyViolations=0`; final `pnpm release:check` exited `0` with `72 passed | 1 skipped` test files and `1124 passed | 8 skipped` tests.
- **Safety:** the rehearsal seeds only synthetic non-secret rows and does not contact SnowLuma/QQ/OneBot, call model providers, or read local secret files. Output is redacted through the existing ops JSON boundary; tests seed secret/platform-like explicit paths/env and prove raw values are absent while local rows use exact internal paths only.
- **Files touched in this slice:** `src/scripts/ops-maintenance.ts`, `package.json`, `tests/integration/ops-maintenance-cli.test.ts`, `docs/operations.md`, `docs/full-project-gap-analysis.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 5 acceptance evidence hardening / Phase 6 completion-audit preparation.
- **Behavior:** the local acceptance evidence template now explicitly records the validator self-checks needed for final live acceptance: default share-safety validation, `--require-complete` validation, and confirmation that validator output contains only rule IDs, line numbers, and counts. The documented evidence commands now include both validator modes, with `pnpm --silent` variants for sensitive path/argument hygiene.
- **Evidence shown:** targeted `pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent` passed with `19 passed`; the then-current `pnpm release:check` exited `0`; the current authoritative full-gate count is recorded in the verified snapshot above.
- **Safety:** this remains deterministic tooling/runbook evidence only. No real SnowLuma/QQ session, local secret file, QR code, chat log, SQLite row dump, private QQ ID, group ID, token, or raw message text was read or printed.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/local-container-acceptance.md`, `docs/operations.md`, `docs/loop-state-recovery.md`, `docs/next-codex-project-state.md`, `docs/full-project-gap-analysis.md`, `docs/long-term-development-direction-review.md`.

Previous completed production-readiness slice:

- **Phase:** Phase 1 architecture gap audit / Phase 6 completion-audit preparation.
- **Behavior:** `docs/full-project-gap-analysis.md` now includes a current requirement-by-requirement completion audit matrix mapping each major objective requirement to current evidence and missing proof.
- **Evidence shown:** the then-current `pnpm release:check` exited `0` after the audit/status doc edits; the current authoritative full-gate count is recorded in the verified snapshot above. The matrix explicitly says final completion is not achieved and does not treat deterministic/fake evidence as live acceptance.
- **Safety:** no secrets, QQ IDs, group IDs, DB rows, logs, or local runtime files were read or printed. The matrix uses only aggregate/current-state evidence.
- **Files touched in this slice:** `docs/full-project-gap-analysis.md`, `docs/loop-state-recovery.md`, `docs/next-codex-project-state.md`.

Previous completed production-readiness slice:

- **Phase:** R9 packaging / install-update-release preflight.
- **Behavior:** `pnpm release:check` now names the existing required deterministic release gate (`pnpm typecheck && pnpm lint && pnpm test:run && git diff --check`). `docs/operations.md` now documents a local install/update/release sequence: stop service, backup DB, install with frozen lockfile, run release gate, run read-only `ops:doctor`, check health/readiness, and only when explicitly available run OneBot verification plus redacted acceptance evidence validation.
- **Evidence shown:** package manifest syntax check confirmed the script value; the then-current `pnpm release:check` exited `0`; the current authoritative full-gate count is recorded in the verified snapshot above. The runbook explicitly says this deterministic preflight does not contact SnowLuma/QQ/OneBot, does not call model providers, and does not prove production completion without live private/group acceptance evidence.
- **Safety:** no secrets or local runtime files are read; runbook uses neutral `/tmp` evidence paths and `pnpm --silent` for evidence commands.
- **Files touched in this slice:** `package.json`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** R9 ops preflight / production-readiness diagnostics.
- **Behavior:** `pnpm ops:doctor -- --db=./data/lethebot.db` opens the target SQLite DB read-only and reports integrity/FK/schema readiness, fixed-key core row counts, and configuration booleans without contacting SnowLuma/QQ/OneBot or model providers.
- **Evidence shown:** spawned ops CLI coverage seeds sensitive DB path/env values and sensitive raw/chat/turn/job/audit rows, then verifies doctor JSON is aggregate/config-boolean only, redacts the displayed DB path, does not leak URLs/tokens/bot IDs/platform IDs/message/audit content, preserves seeded rows, and leaves SQLite FKs clean.
- **Safety:** `ops:doctor` does not read local secret files, does not print configured OneBot URLs/tokens/bot IDs, DB row payloads, raw message text, audit details, tool input/output, job payloads/results, or worker details. It is a deterministic local preflight, not live SnowLuma/QQ acceptance.
- **Verification:** targeted `pnpm exec vitest run tests/integration/ops-maintenance-cli.test.ts -t "doctor" --silent` passed; full `tests/integration/ops-maintenance-cli.test.ts` passed with `18 passed`; the then-current deterministic gate exited `0`; the current authoritative full-gate count is recorded in the verified snapshot above.
- **Files touched in this slice:** `src/scripts/ops-maintenance.ts`, `package.json`, `tests/integration/ops-maintenance-cli.test.ts`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** R7 governance/operator UX plus R9 ops observability.
- **Behavior:** `pnpm cli summarize-governance-health --compact` now prints a compact operator triage projection derived from the existing detailed governance-health summary. The default `summarize-governance-health` JSON remains unchanged.
- **Evidence shown:** spawned CLI coverage seeds secret/platform-bearing raw events, turns, action decisions/executions, tool calls, jobs, worker heartbeats, event-processing failures, and audit rows; compact output reports only overall status, attention counters, coarse totals, and latest timestamps.
- **Safety:** compact output omits dynamic aggregate keys, row classifiers, payloads, memory contents, tool input/output, job payload/result, heartbeat details, audit summaries/details, event-failure details, action payloads, raw IDs, raw secret-like values, and platform-like identifiers; the spawned path is read-only and FK-clean.
- **Verification:** targeted compact test passed (`1 passed | 118 skipped`); related governance-health tests passed (`3 passed | 116 skipped`); final deterministic gate passed with `72 passed | 1 skipped` test files and `1122 passed | 8 skipped` tests. A subsequent 60-second synthetic worker soak also exited `0` with `success=true`, all 7 durable job types completed, planned retry observed, lease extension observed, idle heartbeat, and `foreignKeyViolations=0`.
- **Files touched in this slice:** `src/cli/main.ts`, `tests/integration/cli-main.test.ts`, `docs/operations.md`, `docs/next-codex-project-state.md`, `docs/long-term-development-direction-review.md`, `docs/full-project-gap-analysis.md`, `docs/loop-state-recovery.md`.

Previous completed production-readiness slice:

- **Phase:** R7/R4 governance explainability plus R4 tool-call observability.
- **Behavior:** spawned `why --turn <turn-id>` now includes linked durable `tool_calls` summary evidence for the explained turn, alongside context/action decision/action execution evidence. The output shows redacted tool-call ID, tool name, status, requested-by, duration, and error code/message when present, while omitting tool input/output payloads.
- **Evidence shown:** targeted spawned CLI coverage passed; related type/lint/governance/tool/PiAdapter gate passed with `52 passed | 136 skipped`.
- **Safety:** output reuses existing governance redaction and is read-only for persisted tool/action/context/audit rows; seeded tool input/output, raw secret-like values, raw platform IDs, and raw URLs are absent from stdout; temp SQLite FK evidence remains clean.
- **Files touched in this slice:** `src/cli/governance.ts`, `src/cli/main.ts`, `tests/integration/cli-main.test.ts`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** R4 / Phase 4 real-provider harness hardening.
- **Behavior:** legacy `deepseek-real-api.test.ts` is now a deterministic harness guard instead of a fake live-API suite; it no longer reads `~/deepseek` or contains `expect(true)` placeholder live assertions. The authoritative opt-in provider suite remains `tests/e2e/pi-real-api.test.ts`, now accepting `PI_API_KEY` or `DEEPSEEK_API_KEY`, using `baseUrl` correctly, and asserting invalid-key diagnostics do not echo the test key.
- **Evidence shown:** targeted e2e guard/provider command passed with `5 passed | 8 skipped`; PiAdapter construction coverage passed with custom DeepSeek and generic `baseUrl` assertions; final full deterministic gate passed at `1121 passed | 8 skipped`.
- **Safety:** default tests remain credential-free and do not perform provider network calls; real-provider execution remains explicitly gated by `LETHEBOT_RUN_REAL_API_TESTS=1` plus an env-provided key.
- **Files touched in this slice:** `tests/e2e/deepseek-real-api.test.ts`, `tests/e2e/pi-real-api.test.ts`, `tests/e2e/README.md`, `tests/unit/pi/pi-adapter.test.ts`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/full-project-gap-analysis.md`.

Previous completed production-readiness slice:

- **Phase:** R4 / Phase 4 real-provider harness hardening.
- **Behavior:** legacy `deepseek-real-api.test.ts` is now a deterministic harness guard instead of a fake live-API suite; it no longer reads `~/deepseek` or contains `expect(true)` placeholder live assertions. The authoritative opt-in provider suite remains `tests/e2e/pi-real-api.test.ts`, now accepting `PI_API_KEY` or `DEEPSEEK_API_KEY`, using `baseUrl` correctly, and asserting invalid-key diagnostics do not echo the test key.
- **Evidence shown:** targeted e2e guard/provider command passed with `5 passed | 8 skipped`; PiAdapter construction coverage passed with custom DeepSeek and generic `baseUrl` assertions; final full deterministic gate passed at `1121 passed | 8 skipped`.
- **Safety:** default tests remain credential-free and do not perform provider network calls; real-provider execution remains explicitly gated by `LETHEBOT_RUN_REAL_API_TESTS=1` plus an env-provided key.
- **Files touched in that slice:** `tests/e2e/deepseek-real-api.test.ts`, `tests/e2e/pi-real-api.test.ts`, `tests/e2e/README.md`, `tests/unit/pi/pi-adapter.test.ts`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`, `docs/full-project-gap-analysis.md`.

Earlier completed production-readiness slice:

- **Phase:** R9 local acceptance evidence completion gate.
- **Behavior:** `local-acceptance-evidence --validate <path> --require-complete` now rejects empty/incomplete manual SnowLuma/QQ evidence, checked placeholder values, and conflicting accepted/not-accepted decisions while preserving the default share-safety validator for empty templates.
- **Evidence shown:** targeted unit/spawned CLI coverage passes; final full deterministic gate passes at `1126 passed | 22 skipped`.
- **Safety:** validation output reports only rule IDs, line numbers, and counts; it does not echo raw secret-like values, QQ/platform IDs, raw messages, or sensitive paths.
- **Files touched in this slice:** `src/scripts/local-acceptance-evidence.ts`, `tests/unit/scripts/local-acceptance-evidence.test.ts`, `docs/operations.md`, `docs/local-container-acceptance.md`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`, `docs/next-codex-project-state.md`.

Previous completed stabilization slice:

- **Phase:** R0 worktree stabilization / handoff refresh.
- **Behavior:** refreshed stale project-state evidence from the prior 119-path dirty snapshot to the current baseline: tracked code/test files clean before the docs-only edit, 15 untracked paths remaining, including three untracked project-planning docs.
- **Evidence shown:** fresh baseline commands passed; untracked paths are grouped by subsystem below for explicit cleanup/review.
- **Safety:** no untracked files were read, deleted, staged, or committed; no secret files, logs, SQLite DBs, or private QQ/platform identifiers were accessed.
- **Files touched in this slice:** `docs/next-codex-project-state.md`, `docs/loop-state-recovery.md`.

Previous completed functional code slice:

- **Phase:** R7 governance explainability + R4 action/context observability.
- **Behavior:** spawned `why --turn <turn-id>` now shows linked durable `action_executions` outcomes for the linked action decision.
- **Evidence shown:** execution ID, action type, status, executed-message evidence, downgrade evidence, and failure diagnostics.
- **Safety:** output is redacted; raw executed message IDs, platform IDs, secrets, event text, and chat text are not printed; path is read-only for action/context/audit rows; temp SQLite FKs remain clean.
- **Files touched in that slice:** `src/cli/governance.ts`, `src/cli/main.ts`, `tests/integration/cli-main.test.ts`, `docs/loop-state-recovery.md`, `docs/long-term-development-direction-review.md`.

## What Is Not Healthy Yet

The repository is not production-healthy:

1. **Worktree still has untracked scratch/backup paths.** Current tracked WIP is green under deterministic gates, but 18 untracked paths remain. The next worker must not broad-stage, delete, or inspect scratch files blindly.
2. **Real SnowLuma/QQ soak is unproven.** Deterministic fake OneBot evidence is strong, but live controlled acceptance has not been run in the latest evidence.
3. **Docs have become append-heavy.** `docs/loop-state-recovery.md` and `docs/long-term-development-direction-review.md` contain useful evidence but are too large and repetitive for efficient planning.
4. **Many tests prove redaction/parser variants.** This is valuable, but the previous loop over-prioritized narrow redaction micro-slices. New work should favor stabilization, production acceptance, and mergeable delivery boundaries.
5. **Optional web UI/richer dashboards remain future work.**
6. **Completion claims remain unsafe unless tied to fresh commands and DB/test evidence.**

## Worktree Hazards

Do not read, print, stage, or commit secrets, local DBs, logs, or private platform identifiers.

Known untracked/scratch-looking paths include examples such as:

- **Root diagnostics/scratch:** `.schema chat_messages`, `count_lines.sh`, `prompt.md`, `test-deepseek-direct.mjs`, `test-deepseek.js`, `test-pi-debug.mjs`, `test-pi-simple.mjs`.
- **Editor backups:** `count_lines.sh~`, `docs/archive/discussions/answer.md~`, `docs/archive/discussions/discussion-boundaries-and-questions.md~`.
- **Nested line-count scratch:** `src/count_lines.sh`, `tests/count_lines.sh`.
- **Untracked project-planning docs:** `docs/full-project-gap-analysis.md`, `docs/one-shot-full-completion-constraints.md`, `docs/prompts/one-shot-full-completion-goal.md`.

These were inventoried by path only. Do not read, delete, ignore, stage, or commit them without explicit user approval; some may contain local provider/runtime diagnostics.

## Recommended Development Direction

### Priority 0: Stabilize and package the dirty WIP

Before adding more feature surface:

- confirm whether each untracked scratch/backup path is intentional source/test/docs or disposable scratch;
- ask the user before deleting scratch or committing;
- if cleanup is approved, remove only explicit disposable paths;
- if commit permission is later granted, use small explicit commit groups and never broad-stage.

### Priority 1: Prove the real local platform loop

Production-ready status requires controlled opt-in SnowLuma/QQ evidence:

- QQ private and group loop through NapCat / OneBot;
- replies delivered through action executor / response router;
- no raw secrets or private QQ IDs in evidence files;
- local acceptance evidence generated and validated with the existing redaction-first tools.
- filled evidence can additionally be checked with `--require-complete` so an empty share-safe template is not mistaken for completed acceptance.

If local secrets/session are not available, do not fake this. Mark it as unproven and continue deterministic work.

### Priority 2: Keep governance explainability useful, not infinite

`why` now covers stored/rebuilt context traces, token budget, selected/rejected memory, identity evidence, linked action decisions, linked action executions, and linked tool-call summaries; `summarize-governance-health --compact` now provides aggregate-only operator triage without dynamic keys or row payloads. Further CLI work should be high-value only:

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
- `ops:doctor` / backup / restore / retention / rollback runbook consolidation on disposable DBs;
- worker leases/retries/heartbeats/failure visibility;
- readiness/metrics without credential leakage;
- local runbooks for controlled acceptance.

## Suggested Next Worker First Step

Do not continue the old loop automatically. Start with:

1. Read `AGENTS.md`, `docs/next-codex-constraints.md`, this file, and `docs/prompts/next-codex-goal.md`.
2. Run a fresh baseline.
3. Recheck the 18-path untracked inventory and any tracked docs changes left by this handoff.
4. If gates are green, choose one of:
   - explicit untracked cleanup with user authorization;
   - real local acceptance if the user explicitly provides/authorizes local runtime;
   - one high-value architecture gap with DB-backed tests.
5. Stop after one coherent slice and report evidence.
