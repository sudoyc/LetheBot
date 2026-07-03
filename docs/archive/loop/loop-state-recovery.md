# Loop State - Recovery

**Date:** 2026-07-02
**Phase:** R0 Baseline and Drift Audit
**Status:** R0 documented; R1 blocked by build/test failures
**Fact source:** current worktree, command output, tests run in this session.

## Ground Rules Applied

- Historical completion claims are treated as unverified historical notes.
- Current worktree and command results are authoritative.
- No commits are allowed unless the user explicitly permits them later.
- Feature expansion is paused while typecheck and deterministic tests are failing.

## Required Reading Completed

Read before changing recovery code:

1. `AGENTS.md`
2. `docs/long-term-development-direction-review.md`
3. `docs/long-term-development-constraints.md`
4. `docs/vision.md`
5. `docs/architecture.md`
6. `docs/design-decisions.md`
7. `docs/memory-system.md`
8. `docs/context-orchestration.md`
9. `docs/agent-governance.md`
10. `docs/tool-registry.md`
11. `docs/security-privacy.md`
12. `docs/mvp-roadmap.md`
13. `docs/test-strategy.md`
14. `docs/sqlite-schema.md`
15. `docs/contracts.md`
16. `docs/POST-MVP-GAP-ANALYSIS.md`
17. `docs/detailed-phase-tasks-post-mvp.md`
18. `docs/loop-state-post-mvp.md`
19. `docs/prompts/repair-and-long-term-development-goal.md`

## Baseline Commands

### `git status --short`

Result: worktree is heavily dirty, including modified tracked files, deleted tracked `docker-compose.yml`, and many untracked docs/tests/src files.

Notable tracked changes at R0:

- `M .env.example`
- `M README.md`
- `D docker-compose.yml`
- `M docs/README.md`
- `M docs/loop-state.md`
- `M eslint.config.js`
- `M package.json`
- `M pnpm-lock.yaml`
- `M src/config/index.ts`
- `M src/tools/registry.ts`
- `M src/types/index.ts`
- `M src/workers/index.ts`
- `M src/workers/memory-extraction.ts`
- `M tests/e2e/full-memory-cycle.test.ts`
- `M tests/integration/memory-extraction.test.ts`
- `M tests/phase-acceptance/phase-a.test.ts`
- `M vitest.config.ts`

Notable untracked additions include recovery/architecture docs, Pi adapter files, evaluator files, tools, scripts, summary worker, real API tests, NapCat tests, and several local/manual test scripts.

### `pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0`

Result: exit 0.

Output shows only direct dependency:

- `@earendil-works/pi-agent-core 0.80.2`

`@earendil-works/pi-ai` exists transitively under `pi-agent-core`, but is not a direct dependency. Current TypeScript imports from `@earendil-works/pi-ai` and `@earendil-works/pi-ai/compat` therefore fail package resolution.

### `pnpm typecheck`

Result: exit 2.

Failures:

- `src/pi/deepseek-provider.ts(9,28): error TS2307: Cannot find module '@earendil-works/pi-ai' or its corresponding type declarations.`
- `src/pi/pi-adapter.ts(22,26): error TS2307: Cannot find module '@earendil-works/pi-ai/compat' or its corresponding type declarations.`
- `src/storage/audit-repository.ts(9,15): error TS2305: Module '../cli/governance' has no exported member 'AuditQueryOptions'.`
- `src/storage/audit-repository.ts(9,34): error TS2305: Module '../cli/governance' has no exported member 'AuditStatsResult'.`

### `pnpm test:run`

Result: exit 1.

Summary from Vitest:

- Test files: `6 failed | 47 passed (53)`
- Tests: `4 failed | 613 passed (617)`

Primary blockers:

1. Pi import drift causes 0-test failed suites:
   - `tests/e2e/pi-real-api.test.ts`
   - `tests/integration/e2e-conversation.test.ts`
   - `tests/phase-acceptance/phase-a.test.ts`
   - `tests/unit/pi/pi-adapter.test.ts`
   - Error: failed to load `@earendil-works/pi-ai/compat` from `src/pi/pi-adapter.ts`.
2. `tests/integration/summary-worker.test.ts` fails because `identityRepo.getOrCreateCanonicalUser` is missing.
3. `tests/unit/workers/summary-worker.test.ts` fails two message-loading cases because summary generation returns `null` where tests expect a summary.
4. Test run writes deployment artifacts to repo root during NapCat deployment tests (`docker-compose.yml`, `lethebot.service`, `ecosystem.config.js` messages observed). This violates `docs/long-term-development-constraints.md` even when assertions pass.

### `pnpm lint`

Result: exit 1.

Summary:

- `157 problems (123 errors, 34 warnings)`

Dominant categories:

- unused variables/args;
- `@typescript-eslint/no-explicit-any` in Pi/tool/deployment code;
- non-null assertion warnings;
- generated/deployment-test related lint debt.

Lint is not the first R1 blocker because typecheck and default deterministic tests are failing, but it must be fixed or explicitly bounded before recovery completion.

## Drift Findings

Historical documents currently contradict baseline evidence:

- `docs/loop-state-post-mvp.md` claims Phase N.7 complete and `332` tests passing, but current `pnpm test:run` fails.
- `docs/POST-MVP-GAP-ANALYSIS.md` says MVP complete and cites `291 tests passing`; this is stale historical context, not current proof.
- Existing completion docs such as `docs/MVP-COMPLETE.md`, `docs/phase-p0-complete.md`, and `docs/COMPLETION-REPORT.md` must not be used as completion evidence unless revalidated.

## Current Blocker List

R1 blockers, in priority order:

1. Direct dependency/import drift for Pi integration: `@earendil-works/pi-ai` is imported but not declared directly.
2. Missing exported audit query/stat types used by `AuditRepository`.
3. Pi unit/e2e test modules cannot load because the Pi adapter import fails.
4. Real API tests need deterministic default gating that avoids importing broken real-provider paths unless explicitly enabled.
5. Summary worker repository/test API drift: tests expect `IdentityRepository.getOrCreateCanonicalUser`.
6. Summary worker message window loading returns insufficient rows for time/message-ID range tests.
7. Deployment tests write root artifacts; these must be redirected to temp/test output or cleaned up in test-safe code.
8. Lint debt is broad and must be reduced after build/test recovery.

## Next R1 Repair Plan

1. Fix package/import drift with the smallest stable change:
   - make `@earendil-works/pi-ai` a direct dependency, or remove direct imports if Pi core exposes a supported model path.
   - update mocks/tests to match actual imports.
2. Move or define `AuditQueryOptions` and `AuditStatsResult` in a stable type module instead of importing nonexistent CLI exports.
3. Re-run `pnpm typecheck`.
4. Fix deterministic test failures:
   - Pi adapter tests load and pass;
   - real API tests are skipped without credentials and do not fail during module load;
   - summary worker integration/unit tests pass through repository/API alignment and real message loading.
5. Prevent tests from writing deployment artifacts to the repo root.
6. Re-run `pnpm test:run`.
7. Start bounded lint cleanup only after typecheck/test baseline is green.

## Changed Files in This Checkpoint

- Created `docs/loop-state-recovery.md`.

---

## R1 Build and Deterministic Test Recovery Update

**Date:** 2026-07-02
**Phase:** R1 Build and Deterministic Test Recovery
**Status:** R1 exit criteria met; proceed to R2 ingestion/persistence integrity.
**Fact source:** current worktree and commands run in this session.

### Changes Applied in R1

Build/test recovery changes now present in worktree include:

- Added direct dependency `@earendil-works/pi-ai@^0.80.2` in `package.json` / `pnpm-lock.yaml`.
- Added stable audit query/stat types in `src/types/audit.ts` and updated `src/storage/audit-repository.ts` import path.
- Added `IdentityRepository.getOrCreateCanonicalUser(...)` compatibility API.
- Fixed summary worker message-window behavior and ensured the built summary prompt is passed into Pi context.
- Made real API tests deterministic by default: real Pi/DeepSeek API paths require explicit `LETHEBOT_RUN_REAL_API_TESTS=1` and credentials.
- Redirected deployment-test generated files into test output via `DeploymentOptions.outputDir`.
- Fixed `ContextBuilder` compatibility and memory retrieval/filter behavior needed by existing tests.
- Reduced lint errors without broad refactor:
  - removed `any` from src lint-blocking paths by using `unknown`, narrowed records, and existing types;
  - removed unused test imports/variables;
  - removed unnecessary regex escapes;
  - kept existing non-null assertion warnings as non-blocking lint warnings.

### Verification Commands

#### `pnpm typecheck`

Result: exit 0.

#### `pnpm lint`

Result: exit 0.

ESLint still reports 33 warnings, all non-blocking `@typescript-eslint/no-non-null-assertion` warnings in existing src/tests paths. There are 0 lint errors.

#### `pnpm test:run`

Result: exit 0.

Summary:

- Test Files: `52 passed | 1 skipped (53)`
- Tests: `641 passed | 22 skipped (663)`

Real API tests remain skipped by default when explicit env/credentials are absent.

### Important Evidence Observed During Passing Tests

`pnpm test:run` passes, but logs still show real ingestion/persistence integrity failures in the E2E conversation path:

- `SqliteError: FOREIGN KEY constraint failed`
- Stack points to `LetheBotApp.storeChatMessage` in `src/index.ts`.
- This happens while processing fake/private and fake/group `chat.message.received` events.

This means R1 is green as a local loop, but R2 is still necessary. Passing tests alone are currently weak for persistence because the failing async event path is logged rather than asserted as a test failure.

### R1 Exit Criteria Assessment

- `pnpm typecheck`: pass.
- default deterministic `pnpm test:run`: pass.
- `pnpm lint`: pass with warnings only.
- No commit made.

R1 is complete by command evidence. Next phase is R2.

## R2 Initial Blocker List

R2 starts from these observed issues:

1. `src/index.ts` event handling logs FK failures when storing `chat_messages`.
2. Current HTTP/E2E tests can pass despite async `handleEvent` persistence failure.
3. `storeRawEvent` / `storeChatMessage` must be audited so `chat_messages.raw_event_id` references a real `raw_events.id`.
4. Fake private/group event tests need DB side-effect assertions, not only HTTP status or no-crash assertions.
5. Async event handler failures need a test-observable path.

---

## R2 Ingestion and Persistence Integrity Update

**Date:** 2026-07-02
**Phase:** R2 Ingestion and Persistence Integrity
**Status:** R2 core exit criteria met for fake/private and fake/group webhook persistence.
**Fact source:** current worktree and commands run in this session.

### Problem Confirmed

During the R1 passing `pnpm test:run`, E2E conversation logs showed asynchronous event handler failures:

- `SqliteError: FOREIGN KEY constraint failed`
- stack: `LetheBotApp.storeChatMessage` in `src/index.ts`

This proved default tests were weak: HTTP 200 could pass while event persistence failed asynchronously.

### Changes Applied in R2

- `src/index.ts`
  - `storeRawEvent(...)` now returns and uses the actual `raw_events.id` from the internal event envelope.
  - `storeChatMessage(...)` now receives the real `rawEventId` and writes a valid `chat_messages.raw_event_id` FK.
  - bot replies now create a synthetic `raw_events` row (`source='agent'`, `type='bot.response'`) before writing the bot `chat_messages` row.
  - event handling is queued through `enqueueEvent(...)` so async handler work is tracked.
  - added `waitForIdle()` for tests/operator checks to wait for pending event processing.
  - added `getEventProcessingFailures()` so async handler failures are observable outside logs.
  - added `getDatabase()` for integration tests to assert DB side effects.
  - app config is loaded in the constructor instead of relying on stale module-level config; this lets tests set `LETHEBOT_DB_PATH`/`LETHEBOT_TEST` before constructing the app.
  - test mode / `PI_PROVIDER=mock` uses a deterministic empty-response Pi runtime so default E2E persistence tests do not call real APIs or send real NapCat replies.
  - `stop()` now closes the DB connection after stopping adapter/scheduler.
- `tests/integration/e2e-conversation.test.ts`
  - uses a temp SQLite DB via `LETHEBOT_DB_PATH` and `LETHEBOT_TEST=true`.
  - posts events through a helper that waits for `app.waitForIdle()`.
  - asserts `app.getEventProcessingFailures()` remains empty after tests.
  - asserts private message persistence creates joined `raw_events`/`chat_messages` rows.
  - asserts group message persistence includes group id and mention flag.
  - asserts `PRAGMA foreign_key_check` returns no violations.
  - concurrent webhook test now waits for async event processing and checks FK integrity.

### Verification Commands

#### Narrow R2 check

`pnpm typecheck && pnpm test:run tests/integration/e2e-conversation.test.ts`

Result: exit 0.

Summary for the narrow test:

- Test Files: `1 passed (1)`
- Tests: `15 passed (15)`

#### Full checks

`pnpm lint`

Result: exit 0.

- 0 errors.
- 33 warnings, all existing `@typescript-eslint/no-non-null-assertion` warnings.

`pnpm typecheck`

Result: exit 0.

`pnpm test:run`

Result: exit 0.

Summary:

- Test Files: `52 passed | 1 skipped (53)`
- Tests: `641 passed | 22 skipped (663)`

### R2 Exit Criteria Assessment

- Fake/private webhook events create valid `raw_events` and `chat_messages` rows: verified in `tests/integration/e2e-conversation.test.ts`.
- Fake/group webhook events create valid `raw_events` and `chat_messages` rows: verified in `tests/integration/e2e-conversation.test.ts`.
- Foreign key integrity is tested: `PRAGMA foreign_key_check` asserted in E2E conversation tests.
- Async handler failures are visible: `getEventProcessingFailures()` added and asserted empty after event processing.
- HTTP status-only weakness reduced: E2E tests now wait for async processing and assert DB rows.

R2 core is complete by command/file evidence. Next phase is R3 Memory Governance Foundation.

### Known R2/R3 Boundary Gaps

- `src/index.ts` remains a large handler. R2 fixed persistence integrity without doing a broad orchestrator extraction.
- Memory extraction still creates active memories directly; this is a R3 governance issue, not solved in R2.
- Long-term memory writes still need guaranteed `memory_sources`, `memory_revisions`, and `audit_log` rows.

---

## R3 Memory Governance Foundation Update

**Date:** 2026-07-02
**Phase:** R3 Memory Governance Foundation
**Status:** R3 core exit criteria met for governed durable memory writes, deterministic secret blocking, source/revision/audit linkage, and retrieval/search exclusion rules.
**Fact source:** current worktree and commands run in this session.

### Changes Applied in R3

- `src/storage/memory-repository.ts`
  - `create(...)` is now the governed durable memory write path.
  - A create transaction now writes `memory_records`, `memory_sources`, `memory_revisions`, `audit_log`, and updates `memory_fts`.
  - `updateState(...)`, `disable(...)`, and `delete(...)` now create memory revision and audit rows for lifecycle changes.
  - New create options support explicit source links, actor metadata, revision reasons, audit summaries, and deterministic local policy decision IDs.
  - Retrieval and search now default to active non-secret/non-prohibited memory and apply context visibility filtering.
  - FTS rows are written by the repository path; tests no longer require a manual FTS rebuild to find newly created memory.
- `src/memory/secret-scan.ts`
  - Added deterministic L0 scanning for obvious API keys, GitHub tokens, JWTs, AWS access keys, private keys, password/API-key/token/cookie assignments, and recovery-code style content.
  - Secret/prohibited memory create attempts are blocked before `memory_records` writes.
- `src/workers/memory-extraction.ts`
  - Removed the direct SQL fallback for memory creation; the worker now always uses `MemoryRepository`.
  - Private first-party extracted memories go through deterministic repository governance before becoming active.
  - Group-chat-derived user memories are stored as `proposed`, with `source_context='group_chat'`, same-group visibility, and no active retrieval by default.
  - Extracted memories carry source links, revision rows, and memory audit rows.
- `src/workers/summary-worker.ts`
  - Summary memories now pass source message links into `MemoryRepository.create(...)` so source links, revision, audit, and memory record are created through one governed path.
  - Removed the separate post-create source-link write path.
- `src/index.ts`
  - The app now passes the shared `MemoryRepository` into `MemoryExtractionWorker`.
  - Extraction receives message ID, timestamp, conversation type, and group ID so group-derived user memory can follow stricter policy.
- Tests strengthened:
  - `tests/unit/storage/memory-repository.test.ts`
    - verifies create writes source/revision/audit/FTS rows;
    - verifies secret-like content is rejected without memory rows;
    - verifies disabled/deleted/superseded memories are excluded from ordinary retrieval/search;
    - verifies search enforces sensitivity/visibility/state filters.
  - `tests/unit/workers/memory-extraction.test.ts`
    - verifies extraction uses the repository-governed path even when no repo is passed;
    - verifies secret-like extracted facts do not become durable memory;
    - verifies group-chat-derived user memory is proposed, not active.
  - `tests/unit/workers/summary-worker.test.ts`
    - verifies summary memory source links still exist and revision/audit rows are created.

### Verification Commands

#### Narrow R3 checks

`pnpm test:run tests/unit/storage/memory-repository.test.ts`

Result: exit 0.

Summary:

- Test Files: `1 passed (1)`
- Tests: `22 passed (22)`

`pnpm test:run tests/unit/workers/memory-extraction.test.ts`

Result: exit 0.

Summary:

- Test Files: `1 passed (1)`
- Tests: `29 passed (29)`

`pnpm test:run tests/unit/workers/summary-worker.test.ts tests/integration/summary-worker.test.ts`

Result: exit 0.

Summary from the final two-file check before full suite:

- Test Files: `2 passed (2)`
- Tests: `25 passed (25)`

#### Full checks

`pnpm typecheck`

Result: exit 0.

`pnpm lint`

Result: exit 0.

- 0 errors.
- 29 warnings, all existing `@typescript-eslint/no-non-null-assertion` warnings in unrelated paths/tests.

`pnpm test:run`

Result: exit 0.

Summary:

- Test Files: `52 passed | 1 skipped (53)`
- Tests: `649 passed | 22 skipped (671)`

### R3 Exit Criteria Assessment

- Deleted, disabled, superseded memories are excluded from ordinary retrieval/search: verified in `tests/unit/storage/memory-repository.test.ts`.
- Secret/prohibited memory is blocked before durable write or excluded from search/retrieval if legacy rows exist: verified in `tests/unit/storage/memory-repository.test.ts` and `tests/unit/workers/memory-extraction.test.ts`.
- `private_only` memory is not injected into group context: existing memory injection/context tests remain passing, and search visibility filtering is covered in `tests/unit/storage/memory-repository.test.ts`.
- Durable memory changes create source/revision/audit rows: verified in repository, extraction-worker, and summary-worker tests.
- FTS write path is automatic through `MemoryRepository.create(...)`: verified by search immediately after create without manual rebuild.
- Group-chat-derived user memory follows stricter rules: verified as `proposed` and absent from active retrieval in `tests/unit/workers/memory-extraction.test.ts`.

R3 core is complete by current command/file evidence. Next phase is R4 Context and Pi Runtime Recovery.

### Known R3/R4 Boundary Gaps

- `MemoryRepository.create(...)` now records deterministic local policy decision IDs, but there is not yet a full evaluator-backed memory decision table.
- Context trace still records selected memory IDs but not rejected memory IDs/reasons; this belongs to R4/R7 maturation.
- `src/index.ts` remains a large handler; R3 only changed the memory extraction call path needed for governance.

---

## R4 Context and Pi Runtime Recovery Update

**Date:** 2026-07-02
**Phase:** R4 Context and Pi Runtime Recovery
**Status:** R4 core exit criteria met for mockable Pi turn conversion, multi-turn user/bot history, context memory selection trace, summary retrieval, and visibility/sensitivity/scope filtering.
**Fact source:** current worktree and commands run in this session.

### Changes Applied in R4

- `src/pi/pi-adapter.ts`
  - Bot-authored recent messages are now preserved as Pi `assistant` messages instead of being silently dropped.
  - Historical assistant messages include the Pi SDK-required metadata fields (`api`, `provider`, `model`, zero `usage`, `stopReason`, `timestamp`) so `AgentMessage` remains type-correct.
  - Model metadata has fallbacks so mocked Pi/model objects do not make message conversion fail.
- `tests/unit/pi/pi-adapter.test.ts`
  - Pi dependency imports are mocked through `@earendil-works/pi-ai/compat` so construction does not require real provider setup.
  - The recent-message conversion test now asserts user → assistant → user ordering and assistant metadata.
  - The mock Agent now initializes state from the constructor `initialState`, matching PiAdapter expectations more closely.
- `src/context/builder.ts`
  - Recent message loading joins `raw_events` so agent-originated rows are recognized as bot history.
  - Sender IDs are normalized without double-prefixing existing `qq-...` / `user-...` IDs; bot rows normalize to `bot-self`.
  - Retrieval now includes user, conversation, group, and global memory paths, maps selected memories into `MemoryBlock`s, and records trace fields.
  - Context packs now record `memory.selectedMemoryIds`, `injectedIdentityFields`, and `trace` (`candidateMemoryIds`, `selectedMemoryIds`, `rejectedMemories`, `filtersApplied`).
- `src/types/context.ts`
  - Added explicit memory block and trace shapes for selected/rejected memory observability.
- `src/workers/summary-worker.ts`
  - The summarizer system prompt is centralized as `SUMMARY_SYSTEM_PROMPT` and reused by both normal and retry LLM calls.
- `tests/unit/context/builder.test.ts`
  - Added assertions for private-only rejection in group context, deleted-memory exclusion from selected IDs, group/conversation summaries, trace fields, and identity-field recording.
- `tests/integration/context-history.test.ts`
  - Added assertions that bot history is retained as bot context and that already-normalized QQ sender IDs are not double-prefixed.

### Verification Commands

#### Narrow R4 checks

`pnpm test:run tests/unit/pi/pi-adapter.test.ts tests/unit/context/builder.test.ts tests/integration/context-history.test.ts tests/integration/memory-retrieval.test.ts tests/integration/summary-worker.test.ts`

Result: exit 0.

Summary:

- Test Files: `5 passed (5)`
- Tests: `46 passed (46)`

After strengthening the PiAdapter assistant metadata assertion, an intermediate full run failed because the test mock Agent did not copy `initialState.model` into `state.model`. The mock was corrected and the PiAdapter narrow test passed:

`pnpm typecheck && pnpm test:run tests/unit/pi/pi-adapter.test.ts`

Result: exit 0.

Summary for the narrow PiAdapter test:

- Test Files: `1 passed (1)`
- Tests: `20 passed (20)`

#### Full checks

`pnpm typecheck && pnpm lint && pnpm test:run`

Result: exit 0.

- `pnpm typecheck`: pass.
- `pnpm lint`: pass with 0 errors and 29 existing `@typescript-eslint/no-non-null-assertion` warnings.
- `pnpm test:run`: pass.
  - Test Files: `52 passed | 1 skipped (53)`
  - Tests: `651 passed | 22 skipped (673)`

### R4 Exit Criteria Assessment

- Mock Pi turn test passes: verified by `tests/unit/pi/pi-adapter.test.ts`.
- PiAdapter import/dependency stability and mockability: verified by mocked `@earendil-works/pi-ai/compat` construction path and passing unit tests without real provider credentials.
- Multi-turn context includes user and bot history: verified by `tests/unit/pi/pi-adapter.test.ts` and `tests/integration/context-history.test.ts`.
- ContextBuilder retrieves user, group, conversation summaries, and recent messages with filters: verified by `tests/unit/context/builder.test.ts`, `tests/integration/context-history.test.ts`, and `tests/integration/memory-retrieval.test.ts`.
- ContextPack records selected memories and identity fields: verified by `tests/unit/context/builder.test.ts`.
- Rejected memory trace is present where feasible: verified for builder-level visibility rejection; repository-level SQL exclusions remain enforced before trace candidate enumeration.
- System/persona prompt is not hardcoded in PiAdapter or gateway call sites: ordinary turn prompt construction remains centralized through `src/context/persona.ts`; summary-worker prompt is now a local constant reused across its LLM calls.

R4 core is complete by current command/file evidence. Next phase is R5 Tool, Policy, Sandbox, and Audit Hardening.

### Known R4/R5 Boundary Gaps

- Context trace cannot yet list memories filtered out inside `MemoryRepository.retrieve(...)` SQL before candidates reach `ContextBuilder`; it records builder-level candidate/selected/rejected IDs only.
- Token budgeting is still an approximate character-based estimate and should mature later.
- PiAdapter tool output secret scanning remains a stub; this is explicitly an R5 tool/policy hardening issue.
- `src/index.ts` remains a large orchestration handler; R4 did not refactor it beyond using the existing centralized persona builder.
- No commit was made.

---

## R5 Tool, Policy, Sandbox, and Audit Hardening Update

**Date:** 2026-07-02
**Phase:** R5 Tool, Policy, Sandbox, and Audit Hardening
**Status:** R5 core exit criteria met for resolved function tool handlers, double policy enforcement, file path hardening, secret-like output redaction, tool audit records, and ordinary-user denial of write/delete tools.
**Fact source:** current worktree and commands run in this session.

### Changes Applied in R5

- `src/types/tool.ts`
  - Normalized `ToolRegistryEntry.handler` to a resolved `ToolHandler` function.
  - Added `ToolHandlerRequest` so handlers receive `toolCallId`, `turnId`, `toolName`, input, actor, and invocation context through one typed request object.
- `src/tools/registry.ts`
  - `register(...)` now rejects unresolved non-function handlers.
  - Added `getHandler(...)` for PiAdapter/runtime execution of already-resolved handlers.
- Tool registration call sites
  - File operation tools and network request tool now register resolved async function handlers rather than string/module-path handler references.
  - Real-API E2E helper tool registration was updated to the resolved-handler shape so default suite loading does not regress.
- `src/pi/pi-adapter.ts`
  - Pi tool conversion executes only resolved function handlers from `ToolRegistry.getHandler(...)`.
  - `PolicyGate.checkToolCall(...)` is enforced both in `beforeToolCall(...)` and inside the wrapped `execute(...)` function, so a filtered/bypassed Pi tool cannot skip L0 permission/evaluator checks by directly invoking `execute`.
  - Rejected/blocked tool attempts are audited from both preflight (`beforeToolCall`) and execution-denial paths when an audit repository is configured.
  - Successful, failed, and rejected tool calls write `audit_log` records through `AuditRepository` with tool category, event type, actor/context, capabilities, risk level, redaction flag, and structured details according to audit level.
  - `auditLevel: none` is upgraded to summary at execution time for P0 audit coverage.
  - `secret_possible` tool output is scanned/redacted before returning content to Pi, and structured audit details are recursively secret-redacted.
- `src/index.ts`
  - Production PiAdapter construction now receives the shared `AuditRepository`, so real tool execution paths can persist audit records.
- `src/memory/secret-scan.ts`
  - Added `redactSecretsInText(...)`, reusing deterministic secret patterns to replace matched secret-like text with `[REDACTED:<pattern>]`.
- `src/tools/file-operations/path-validator.ts`
  - Hardened workspace and allowed-path checks with `path.relative(...)` boundary checks instead of string prefix checks.
  - Hardened symlink escape detection by resolving the nearest existing ancestor for paths whose final target does not yet exist.
  - Added explicit coverage for sibling-prefix attacks and symlink ancestors escaping the workspace.
- Tests strengthened:
  - `tests/unit/tools/registry.test.ts` verifies unresolved string handlers are rejected.
  - `tests/unit/pi/pi-adapter.test.ts` verifies successful tool audit, preflight rejected audit, execute-time policy denial audit, evaluator-required blocking, and `secret_possible` output redaction before prompt/audit details.
  - `tests/unit/tools/path-validator.test.ts` verifies workspace prefix sibling, allowed-path prefix, symlink ancestor escape, and `isPathAllowed(...)` boundary behavior.
  - `tests/integration/file-operations.test.ts` verifies ordinary users cannot use write/delete tools from private or group chat contexts.

### Verification Commands

#### Narrow R5 checks

`pnpm typecheck && pnpm test:run tests/unit/pi/pi-adapter.test.ts`

Result: exit 0.

Summary:

- `pnpm typecheck`: pass.
- PiAdapter narrow test: `1 passed (1)` test file, `23 passed (23)` tests.

`pnpm test:run tests/unit/pi/pi-adapter.test.ts tests/unit/tools/registry.test.ts tests/unit/policy/gate.test.ts tests/unit/tools/path-validator.test.ts tests/unit/tools/read-file.test.ts tests/unit/tools/write-file.test.ts tests/unit/tools/delete-file.test.ts tests/integration/file-operations.test.ts`

Result: exit 0.

Summary:

- Test Files: `8 passed (8)`
- Tests: `122 passed (122)`

#### Full checks

`pnpm typecheck && pnpm lint && pnpm test:run`

Result: exit 0.

- `pnpm typecheck`: pass.
- `pnpm lint`: pass with 0 errors and 29 existing `@typescript-eslint/no-non-null-assertion` warnings.
- `pnpm test:run`: pass.
  - Test Files: `52 passed | 1 skipped (53)`
  - Tests: `660 passed | 22 skipped (682)`

### R5 Exit Criteria Assessment

- Bypass does not bypass permissions/sandbox/audit: verified by `PolicyGate` tests plus PiAdapter tests that mutate permissions after tool conversion and still get execute-time denial/audit; `beforeToolCall` rejected paths also write audit records.
- PiAdapter executes only resolved function handlers: verified by type-level handler normalization, registry runtime rejection of string handlers, and passing registry/PiAdapter tests.
- Secret-like `secret_possible` tool output is redacted before audit/prompt: verified in `tests/unit/pi/pi-adapter.test.ts`; returned Pi tool content and audit payload do not contain the secret-like source value.
- File path validation resists prefix and symlink escapes: verified in `tests/unit/tools/path-validator.test.ts`.
- Write/delete tools cannot run from ordinary private/group chat users: verified in `tests/integration/file-operations.test.ts`.
- Tool calls produce audit records: verified in `tests/unit/pi/pi-adapter.test.ts` for success, rejection, and execute-time denial paths; production PiAdapter receives `AuditRepository` from `src/index.ts`.

R5 core is complete by current command/file evidence. Next phase is R6 Background Summaries and Retrieval Quality.

### Known R5/R6 Boundary Gaps

- `audit_log` records are written for tool calls, but the schema's `tool_calls` table is not yet populated by PiAdapter. This is a persistence/audit-detail maturation task, not needed for the R5 audit-log exit criteria.
- Tools with `evaluatorPolicy: required` are blocked by PiAdapter until an evaluator/action-executor approval path exists. R5 ensures risky tools cannot be used by ordinary chat users; a later phase must implement approved execution.
- Current sandbox enforcement is concrete for file path boundaries and registry metadata. A generic sandbox executor for future shell/subprocess/docker tools remains later work.
- Some untracked documentation examples still show pre-R5 string/module-path handler examples; runtime types and tests now enforce resolved function handlers.
- No commit was made.

---

## R6 Background Summaries and Retrieval Quality Update

**Date:** 2026-07-02
**Phase:** R6 Background Summaries and Retrieval Quality
**Status:** R6 core exit criteria met for real-message summarizer input, governed source-linked summary memory, ContextBuilder summary retrieval, same-window duplicate prevention, and idempotent repeated summary jobs.
**Fact source:** current worktree and commands run in this session.

### Changes Applied in R6

- `src/workers/summary-worker.ts`
  - Preserves the existing behavior of building the summarizer prompt from loaded `chat_messages` and passing that prompt as the SummaryWorker `ContextPack` recent message to `PiAdapter.runTurn(...)`.
  - Added deterministic summary memory IDs derived from conversation identity and the actual source chat message IDs in the summarized window.
  - Before calling Pi, checks for an existing summary memory for the exact message window.
  - Repeated runs over the same active message window now return the existing summary output without another Pi call or another memory/source/revision/audit write.
  - Existing non-active governed summary memories for the same window are treated as already governed, preventing the worker from recreating disabled/deleted/superseded summaries and bypassing governance.
  - `findConversationsNeedingSummary(...)` now filters out conversations whose current candidate message window already has a summary memory.
  - Summary storage continues to use `MemoryRepository.create(...)`, so summary memories are written through the governed path with `memory_records`, `memory_sources`, `memory_revisions`, `audit_log`, and FTS updates.
- `tests/unit/workers/summary-worker.test.ts`
  - Added a prompt-input assertion proving the summarizer prompt contains real conversation messages and message count metadata.
  - Added same-window idempotency coverage proving a second `generateSummary(...)` call returns the same summary ID, does not call Pi again, and leaves only one memory record, one revision, one audit row, and the original source links.
  - Added `findConversationsNeedingSummary(...)` coverage proving an already summarized message window is no longer returned as needing summary.
- Existing integration coverage remains relevant:
  - `tests/integration/summary-worker.test.ts` verifies generated summaries are stored, linked to source messages, retrievable through `MemoryRepository`, and visible in `ContextBuilder` context packs where appropriate.
  - `tests/unit/context/builder.test.ts` continues to cover summary/context inclusion boundaries.

### Verification Commands

#### R6 baseline/narrow checks

`pnpm test:run tests/unit/workers/summary-worker.test.ts tests/integration/summary-worker.test.ts tests/unit/context/builder.test.ts`

Initial R6 narrow baseline before changes: exit 0.

- Test Files: `3 passed (3)`
- Tests: `32 passed (32)`

`pnpm typecheck && pnpm test:run tests/unit/workers/summary-worker.test.ts tests/integration/summary-worker.test.ts tests/unit/context/builder.test.ts`

After R6 changes: exit 0.

- `pnpm typecheck`: pass.
- Test Files: `3 passed (3)`
- Tests: `35 passed (35)`

`pnpm lint`

Result after removing newly introduced non-null assertions: exit 0.

- 0 errors.
- 29 existing `@typescript-eslint/no-non-null-assertion` warnings.

#### Full checks

`pnpm typecheck && pnpm lint && pnpm test:run`

Result: exit 0.

- `pnpm typecheck`: pass.
- `pnpm lint`: pass with 0 errors and 29 existing `@typescript-eslint/no-non-null-assertion` warnings.
- `pnpm test:run`: pass.
  - Test Files: `52 passed | 1 skipped (53)`
  - Tests: `663 passed | 22 skipped (685)`

### R6 Exit Criteria Assessment

- Summary tests assert prompt/input includes real messages: verified by `tests/unit/workers/summary-worker.test.ts` prompt-input test.
- Summary memory has source links and revision/audit records: verified by `tests/unit/workers/summary-worker.test.ts` and `tests/integration/summary-worker.test.ts` database assertions over `memory_sources`, `memory_revisions`, and `audit_log`.
- ContextBuilder can retrieve appropriate conversation/group summary: verified by `tests/integration/summary-worker.test.ts` ContextBuilder integration and `tests/unit/context/builder.test.ts` summary/context coverage.
- Duplicate summaries over the same window are prevented: verified by the same-window idempotency test; the second run reuses the same deterministic summary ID and does not create another durable memory write.
- Worker jobs are idempotent for repeated same-window execution: verified by the repeated `generateSummary(...)` test and by `findConversationsNeedingSummary(...)` excluding an already summarized window.

R6 core is complete by current command/file evidence. Next phase is R7 Governance CLI and Explainability.

### Known R6/R7 Boundary Gaps

- Summary windows are deterministic over the currently loaded message set, capped by `maxMessagesToSummarize`; more advanced rolling-window scheduling and partial-window continuation remain future retrieval-quality work.
- Existing summary idempotency is implemented in `SummaryWorker`; the generic `BackgroundWorker` queue is still a simple in-memory stub and not yet a durable job scheduler.
- Summary prompts are verified to include real messages, but summary quality scoring/evaluation beyond deterministic storage/retrieval remains future work.
- No commit was made.

---

## R7 Governance CLI and Explainability Update

**Date:** 2026-07-02
**Phase:** R7 Governance CLI and Explainability
**Status:** R7 core exit criteria met for governed memory state transitions, CLI memory filters, CLI-equivalent context explanation, and display profile/nickname history redaction.
**Fact source:** current worktree and commands run in this session.

### Changes Applied in R7

- `src/cli/governance.ts`
  - `listMemory(...)` now supports governance filters by user, group, conversation, state, scope, sensitivity, source context, linked source type, linked source ID, and limit.
  - `deleteMemory(...)`, `disableMemory(...)`, and `enableMemory(...)` now pass explicit `admin_cli` actor/reason/audit summary metadata into `MemoryRepository.updateState(...)`, so lifecycle changes create clear revision and audit records attributed to governance CLI rather than looking like subject-user actions.
  - Added `explainContext(...)`, a CLI-equivalent `/why` path that rebuilds a ContextBuilder trace for a specified turn, latest turn, or explicit conversation context. It returns selected/candidate/rejected memory IDs, filters applied, injected identity fields, recent message IDs, token budget, and selected memory metadata.
  - Added `redactDisplayProfile(...)`, which redacts `display_profiles.current_display_name` and `nickname_history.display_name` for a user/group scope and writes a `system` audit row for the redaction action.
- `src/cli/main.ts`
  - `list-memory` now exposes additional filters: conversation, scope, sensitivity, source context, source type, source ID, and limit.
  - Added `why` command for CLI context trace/explainability.
  - Added `redact-display-profile` command for display profile/nickname history redaction.
- `tests/unit/cli/governance.test.ts`
  - Strengthened memory lifecycle tests to assert state transitions, immediate retrieval exclusion, `memory_revisions`, and `audit_log` rows for delete/disable/restore.
  - Added list filter coverage for scope, sensitivity, source context, linked source type, and linked source ID.
  - Added context explanation test using a persisted `agent_turns` row and rebuilt ContextBuilder trace.
  - Added display profile/nickname history redaction test with `audit_log` verification.

### Verification Commands

#### R7 narrow checks

`pnpm typecheck && pnpm test:run tests/unit/cli/governance.test.ts`

Result: exit 0.

- `pnpm typecheck`: pass.
- Test Files: `1 passed (1)`
- Tests: `10 passed (10)`

`pnpm lint`

Result after removing the newly introduced unused import: exit 0.

- 0 errors.
- 29 existing `@typescript-eslint/no-non-null-assertion` warnings.

`pnpm test:run tests/unit/cli/governance.test.ts tests/unit/storage/memory-repository.test.ts tests/unit/context/builder.test.ts tests/integration/memory-injection.test.ts`

Result: exit 0.

- Test Files: `4 passed (4)`
- Tests: `48 passed (48)`

#### Full checks

`pnpm typecheck && pnpm lint && pnpm test:run`

Result: exit 0.

- `pnpm typecheck`: pass.
- `pnpm lint`: pass with 0 errors and 29 existing `@typescript-eslint/no-non-null-assertion` warnings.
- `pnpm test:run`: pass.
  - Test Files: `52 passed | 1 skipped (53)`
  - Tests: `666 passed | 22 skipped (688)`

### R7 Exit Criteria Assessment

- CLI tests cover state transitions and audit rows: verified in `tests/unit/cli/governance.test.ts` for delete, disable, and enable/restore paths; tests assert both `memory_revisions` and `audit_log` rows.
- Deleted/disabled memory cannot appear in retrieval after CLI action: verified in `tests/unit/cli/governance.test.ts` through `MemoryRepository.retrieve(...)` after delete/disable.
- Owner/admin can inspect memory with filters: verified by list filter tests for scope, user/group-capable fields, state, sensitivity, source context, source type, and source ID.
- CLI-equivalent `/why` exists: verified by `explainContext(...)` test rebuilding trace for a stored turn and asserting selected/candidate memories, filters, and recent message IDs.
- Display profile/nickname history redaction path exists: verified by `redactDisplayProfile(...)` test over `display_profiles`, `nickname_history`, and `audit_log`.

R7 core is complete by current command/file evidence. Next phase is R8 QQ / NapCat Production Loop.

### Known R7/R8 Boundary Gaps

- `explainContext(...)` currently rebuilds context trace from current DB state instead of reading a persisted immutable context-pack snapshot; schema has `agent_turns.context_pack_id` but no durable `context_packs` table yet.
- Governance CLI redaction covers display profile and nickname history text but does not implement full purge/tombstone semantics for identity unlinking.
- `listMemory(...)` is an owner/admin governance read path; ordinary self-service user commands are still future work.
- No commit was made.

---

## R8 QQ / NapCat Production Loop Update

**Date:** 2026-07-02
**Phase:** R8 QQ / NapCat Production Loop
**Status:** R8 core exit criteria met for deterministic fake/private/group paths, OneBot HTTP auth, target-bot CQ mention parsing, structured QQ metadata handling, minimal response-send path, DB+adapter healthcheck, and deployment env documentation.
**Fact source:** current worktree and commands run in this session.

### Baseline Before R8 Changes

`pnpm typecheck && pnpm lint && pnpm test:run`

Result: exit 0.

- `pnpm typecheck`: pass.
- `pnpm lint`: pass with 0 errors and 29 existing `@typescript-eslint/no-non-null-assertion` warnings.
- `pnpm test:run`: pass.
  - Test Files: `52 passed | 1 skipped (53)`
  - Tests: `666 passed | 22 skipped (688)`

### Changes Applied in R8

- `src/gateway/onebot-adapter.ts`
  - Added reverse HTTP event Bearer-token validation via `validateHttpEventAuth(...)` using configured `ONEBOT_TOKEN`.
  - Added adapter readiness reporting with mode, remote HTTP URL, token presence, bot-id configuration, and last error without exposing token values.
  - Added `connect`/`disconnect`, `getCapabilities`, and unified `sendMessage(...)` path for private/group replies, backed by `send_private_msg` / `send_group_msg` OneBot HTTP APIs.
  - Parses OneBot CQ string and segment-array messages for text, `at`, `reply`, and common media segments.
  - `mentionsBot` is exact when `LETHEBOT_BOT_QQ_ID` is configured; non-target `[CQ:at,qq=...]` no longer triggers bot attention.
  - Parses sender role, group card/display name, quote id, media attachments, message ids, private/group ids into structured internal fields.
- `src/config/index.ts`
  - Added `LETHEBOT_BOT_QQ_ID` / `botQqId` to NapCat config.
- `src/index.ts`
  - Event endpoint now uses configured `LETHEBOT_EVENT_PATH` and rejects unauthorized OneBot event POSTs when `ONEBOT_TOKEN` is set.
  - Health endpoint now uses configured `LETHEBOT_HEALTH_PATH` and reports DB check plus adapter readiness; returns degraded/503 if either fails.
  - HTTP server now listens on configured `LETHEBOT_HOST`.
  - Replies now use the adapter `sendMessage(...)` path instead of separate direct private/group calls.
  - Display names/group cards from gateway events are stored in governed display-profile tables instead of being folded into memory text.
  - `has_media` now reflects non-empty media attachments rather than the mere presence of an empty array.
- `src/types/events.ts`
  - Added structured `senderDisplayName` and `senderCard` fields to chat message events.
- `tests/fakes/fake-onebot.ts` and `tests/fakes/fake-onebot.test.ts`
  - Fake group events now include `groupId`, CQ mention extraction, exact configured bot-id mention detection, quote, and media fields.
  - Fake tests now cover CQ target mention and quote/media parity.
- `tests/unit/gateway/onebot-adapter.test.ts`
  - New tests for reverse HTTP auth, exact target bot CQ mention parsing, sender role/card/quote/media parsing, and unified sendMessage private/group API calls.
- `tests/integration/e2e-conversation.test.ts`
  - E2E app test now runs with `ONEBOT_TOKEN` and `LETHEBOT_BOT_QQ_ID` configured.
  - Healthcheck asserts database and adapter readiness fields.
  - Private/group persistence tests assert auth, exact mention behavior, sender role, group card display profile, CQ text stripping, quote/media flags, and FK validity.
- `src/scripts/deploy-napcat.ts`, `.env.example`, `docs/deployment.md`, `docs/operations.md`, and related deployment-script tests
  - Deployment env docs/templates now match actual variables used by current code: `LETHEBOT_DB_PATH`, `ONEBOT_HTTP_URL`, `ONEBOT_TOKEN`, `LETHEBOT_BOT_QQ_ID`, `LETHEBOT_*_PATH`, `PI_PROVIDER`, `PI_MODEL`, `PI_BASE_URL`, and `PI_API_KEY`.
  - Deployment docs now include a fake-to-real parity checklist and clarify that default deterministic tests do not require a real NapCat service.

### Verification Commands

#### R8 narrow checks

`pnpm test:run tests/unit/gateway/onebot-adapter.test.ts tests/unit/config/napcat-config.test.ts tests/integration/e2e-conversation.test.ts`

Result: exit 0.

- Test Files: `3 passed (3)`
- Tests: `35 passed (35)`

`pnpm typecheck && pnpm test:run tests/fakes/fake-onebot.test.ts tests/unit/gateway/onebot-adapter.test.ts tests/integration/e2e-conversation.test.ts tests/unit/scripts/deploy-napcat.test.ts`

Result: exit 0.

- `pnpm typecheck`: pass.
- Test Files: `4 passed (4)`
- Tests: `72 passed (72)`

#### Full checks

`pnpm typecheck && pnpm lint && pnpm test:run`

Result: exit 0.

- `pnpm typecheck`: pass.
- `pnpm lint`: pass with 0 errors and 29 existing `@typescript-eslint/no-non-null-assertion` warnings.
- `pnpm test:run`: pass.
  - Test Files: `53 passed | 1 skipped (54)`
  - Tests: `676 passed | 22 skipped (698)`

### R8 Exit Criteria Assessment

- FakeOneBot tests cover private and group paths: verified by `tests/fakes/fake-onebot.test.ts`, now including group id, configured bot CQ mention, quote, and media parity.
- NapCat integration tests are separate from default unless local service is explicitly configured: default tests use fake/local HTTP only; real service verification remains explicit through `pnpm verify:napcat` / controlled soak configuration.
- Deployment docs match actual env vars: updated `.env.example`, `docs/deployment.md`, `docs/operations.md`, and deploy script generated assets to use current env names.
- OneBot HTTP event auth/token strategy: verified by adapter unit tests and E2E app 401 test when `ONEBOT_TOKEN` is configured.
- Mentions/CQ at target bot ID: verified by adapter unit tests and E2E non-target mention persistence test.
- Private/group message IDs, sender roles, group cards, quotes, media: verified by adapter unit tests and E2E DB assertions over `chat_messages`, `display_profiles`, and FK checks.
- Replies are sent through an equivalent response path: adapter `sendMessage(...)` now routes private/group replies through one method and is covered by unit tests for outgoing OneBot HTTP calls.
- Healthcheck covers DB and adapter readiness: verified by E2E `/healthz` assertions.
- Fake-to-real parity checklist exists: added to `docs/deployment.md`.

R8 core is complete by current command/file evidence. Next phase is R9 Long-Term Operations.

### Known R8/R9 Boundary Gaps

- No live NapCat soak was run in this phase; R8 completion is based on deterministic fake/local HTTP tests plus explicit verification tooling/docs.
- The response path is a minimal adapter-level `sendMessage(...)` equivalent, not a full social action executor with cooldowns, folded-forward routing, reactions, or proactive DM policy.
- Healthcheck covers local DB and adapter readiness, not remote NapCat API reachability; remote NapCat check remains `pnpm verify:napcat`.
- CQ parsing covers common `text`, `at`, `reply`, `image`, `record`, `video`, and `file` segments; advanced OneBot/NapCat message variants remain future hardening.
- `LETHEBOT_BOT_QQ_ID` exact matching is available and tested, but production safety still depends on setting the correct bot QQ id in `.env`.
- No commit was made.

---

## R9 Long-Term Operations Update

**Date:** 2026-07-02
**Phase:** R9 Long-Term Operations
**Status:** R9 core exit criteria met for tested SQLite backup/restore, explicit retention policy, operations metrics snapshot, operator runbook, dependency update policy, and governance UI plan.
**Fact source:** current worktree and commands run in this session.

### Changes Applied in R9

- `src/operations/sqlite-maintenance.ts`
  - Added tested SQLite online backup using `better-sqlite3` backup API with post-backup integrity check.
  - Added integrity-checked restore with overwrite protection.
  - Added explicit retention policy for `raw_events`, `chat_messages`, `audit_log`, and hard purge of old `disabled` / `deleted` memories.
  - Retention deletes in FK-safe order, excludes raw events still referenced by `agent_turns`, and rebuilds `memory_fts` after memory purge.
  - Added operations metrics snapshot covering raw events, chat messages, agent turns/tokens/status, memory writes/states, audit policy events, and tool call status/redaction counts.
- `src/scripts/ops-maintenance.ts`
  - Added CLI entrypoint for `backup`, `restore`, `retention`, and `metrics` maintenance commands.
- `package.json`
  - Added `ops:backup`, `ops:restore`, `ops:retention`, and `ops:metrics` scripts.
- `src/config/index.ts` and `.env.example`
  - Added retention config for chat messages, audit logs, and disabled/deleted memory:
    - `LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS`
    - `LETHEBOT_AUDIT_LOG_RETENTION_DAYS`
    - `LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS`
- `tests/unit/operations/sqlite-maintenance.test.ts`
  - Added temp-DB backup/restore test with restored-row assertion.
  - Added retention test that verifies FK integrity and preserves active/recent data.
  - Added metrics test for turns, memory writes, policy audit events, and tool calls.
- `tests/unit/config/index.test.ts`
  - Added retention config load/default/validation coverage.
- `docs/operations.md`
  - Expanded into an operator runbook with actual commands, known failure modes, backup/restore procedure, retention policy, metrics/logging fields, dependency update policy, and lightweight governance UI plan.
- `docs/deployment.md`
  - Added R9 retention env vars to the deployment environment block.

### Verification Commands

#### R9 narrow checks

`pnpm typecheck && pnpm test:run tests/unit/operations/sqlite-maintenance.test.ts`

Result: exit 0.

- `pnpm typecheck`: pass.
- Test Files: `1 passed (1)`
- Tests: `3 passed (3)`

`pnpm typecheck && pnpm test:run tests/unit/operations/sqlite-maintenance.test.ts tests/unit/config/index.test.ts && pnpm lint`

Result: exit 0.

- `pnpm typecheck`: pass.
- Test Files: `2 passed (2)`
- Tests: `8 passed (8)`
- `pnpm lint`: pass with 0 errors and 29 existing `@typescript-eslint/no-non-null-assertion` warnings.

#### Full checks

`pnpm typecheck && pnpm lint && pnpm test:run`

Result: exit 0.

- `pnpm typecheck`: pass.
- `pnpm lint`: pass with 0 errors and 29 existing `@typescript-eslint/no-non-null-assertion` warnings.
- `pnpm test:run`: pass.
  - Test Files: `54 passed | 1 skipped (55)`
  - Tests: `680 passed | 22 skipped (702)`

`pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0`

Result: exit 0.

- `@earendil-works/pi-agent-core 0.80.2`
- `@earendil-works/pi-ai 0.80.2`

### R9 Exit Criteria Assessment

- Backup/restore is tested on a temp DB: verified by `tests/unit/operations/sqlite-maintenance.test.ts` backing up a migrated temp DB, restoring to a separate temp path, and asserting restored rows plus integrity.
- Operations doc includes actual commands and known failure modes: verified in `docs/operations.md` sections for health, backup/restore, retention, metrics, failure runbook, and known failure table.
- Metrics/logging fields are documented: verified in `docs/operations.md` metrics/logging section and implemented by `collectOperationsMetrics(...)`.

R9 core is complete by current command/file evidence.

### Known R9 Boundary Gaps

- Retention is operator-run via CLI in R9; it is not yet scheduled as a durable background job.
- Backup/restore is tested on local temp DBs; no off-host encrypted backup integration is implemented.
- Metrics are JSON snapshots from SQLite, not Prometheus/OpenTelemetry exporters.
- Governance UI remains a documented plan; CLI is still the implemented governance surface.
- No commit was made.

---

## Completion Audit for R0-R9 Recovery Goal

**Date:** 2026-07-02
**Status:** R0-R9 phase exit criteria are met by current command/file evidence. This is not a claim that a live multi-day NapCat soak has already run; live soak remains a future production-readiness activity.

### Constraint Re-read

Re-read `docs/long-term-development-constraints.md` in this session before this audit.

Key constraints still reflected in the final state:

- Current worktree and commands are the evidence source.
- No commit was made.
- Default tests remain deterministic; real API tests are gated/skipped without credentials.
- DB/FK assertions are present in ingestion, memory, summary, R8 E2E, and R9 retention/backup tests.
- Governance paths create source/revision/audit records and retrieval excludes disabled/deleted/secret/prohibited/private-in-group memory.
- Deployment/test-generated artifacts remain directed to `test-output` in tests; root `docker-compose.yml` tracked deletion was not restored.

### Phase-by-phase Exit Criteria Evidence

- **R0 Baseline and Drift Audit**
  - Evidence: `docs/loop-state-recovery.md` R0 section documents `git status --short`, baseline failures, stale completion claims, skipped/real-API-gated tests, and blocker list.
- **R1 Build and Deterministic Test Recovery**
  - Evidence commands in R1/R later full gates: `pnpm typecheck`, `pnpm test:run`, and `pnpm lint` pass; final full gate also passes.
  - Current final evidence: `pnpm typecheck && pnpm lint && pnpm test:run` exit 0; `54 passed | 1 skipped`, `680 passed | 22 skipped`.
- **R2 Ingestion and Persistence Integrity**
  - Evidence files/tests: `src/index.ts`, `tests/integration/e2e-conversation.test.ts`, `tests/integration/data-persistence.test.ts`.
  - Evidence: fake/private and fake/group HTTP events create valid `raw_events` and `chat_messages`; FK checks are asserted; async failures exposed by `getEventProcessingFailures()` / `waitForIdle()`.
- **R3 Memory Governance Foundation**
  - Evidence files/tests: `src/storage/memory-repository.ts`, `tests/unit/storage/memory-repository.test.ts`, `tests/integration/memory-injection.test.ts`, `tests/integration/memory-extraction.test.ts`.
  - Evidence: durable memory writes create `memory_records`, `memory_sources`, `memory_revisions`, and `audit_log`; retrieval excludes deleted/disabled/superseded/secret/prohibited/private-in-group memory.
- **R4 Context and Pi Runtime Recovery**
  - Evidence files/tests: `src/context/builder.ts`, `src/pi/pi-adapter.ts`, `tests/unit/context/builder.test.ts`, `tests/integration/context-history.test.ts`, `tests/unit/pi/pi-adapter.test.ts`.
  - Evidence: mock Pi tests pass; context includes bot/user history; ContextBuilder records selected memory IDs/identity fields/trace and filters by state/visibility/sensitivity/scope.
- **R5 Tool, Policy, Sandbox, and Audit Hardening**
  - Evidence files/tests: `src/tools/registry.ts`, `src/pi/pi-adapter.ts`, `src/tools/file-operations/path-validator.ts`, `tests/unit/tools/registry.test.ts`, `tests/unit/pi/pi-adapter.test.ts`, `tests/unit/tools/path-validator.test.ts`, `tests/unit/policy/gate.test.ts`.
  - Evidence: tests cover handler normalization, policy enforcement before tool execution, redaction of secret-like output before audit/prompt, symlink/prefix path hardening, and ordinary user denial for write/delete-risk paths.
- **R6 Background Summaries and Retrieval Quality**
  - Evidence files/tests: `src/workers/summary-worker.ts`, `tests/unit/workers/summary-worker.test.ts`, `tests/integration/summary-worker.test.ts`.
  - Evidence: summary prompts include real messages, summaries are governed memory with source/revision/audit links, ContextBuilder can retrieve summaries, and same-window generation is idempotent.
- **R7 Governance CLI and Explainability**
  - Evidence files/tests: `src/cli/governance.ts`, `src/cli/main.ts`, `tests/unit/cli/governance.test.ts`.
  - Evidence: CLI disable/delete/enable create revision/audit rows; disabled/deleted memory is excluded immediately; list filters and CLI-equivalent `why` context explanation are tested; display profile/nickname redaction path is tested.
- **R8 QQ / NapCat Production Loop**
  - Evidence files/tests: `src/gateway/onebot-adapter.ts`, `src/index.ts`, `tests/fakes/fake-onebot.test.ts`, `tests/unit/gateway/onebot-adapter.test.ts`, `tests/integration/e2e-conversation.test.ts`, `docs/deployment.md`.
  - Evidence: FakeOneBot private/group paths are covered; OneBot reverse HTTP auth, target bot CQ mention parsing, sender role/card/quote/media handling, adapter `sendMessage(...)`, and DB+adapter `/healthz` are tested; deployment docs match current env vars.
- **R9 Long-Term Operations**
  - Evidence files/tests/docs: `src/operations/sqlite-maintenance.ts`, `src/scripts/ops-maintenance.ts`, `tests/unit/operations/sqlite-maintenance.test.ts`, `docs/operations.md`, `docs/deployment.md`.
  - Evidence: backup/restore tested on temp DB; retention tested with FK check; metrics snapshot implemented/tested; operations doc includes commands, known failure modes, metrics/logging fields, dependency policy, and governance UI plan.

### Final Gate Evidence

Final required gates were run after R9 implementation:

- `pnpm typecheck`: pass.
- `pnpm lint`: pass with 0 errors and 29 existing non-null assertion warnings.
- `pnpm test:run`: pass, `54 passed | 1 skipped (55)` test files, `680 passed | 22 skipped (702)` tests.

### Remaining Production-readiness Risks

- A real NapCat controlled soak has not been executed in this session; the code is ready for controlled soak by R8 criteria, but live production readiness still needs that run.
- Response routing remains minimal adapter-level `sendMessage(...)`, not a full action executor with cooldown/reaction/folded-forward policy.
- R9 maintenance is CLI/operator-run, not yet scheduled/durable automation.
- Metrics are local JSON snapshots, not a metrics server/exporter.
- Context explanation still rebuilds from current DB rather than immutable persisted context-pack snapshots.
- Governance UI is planned but not implemented.
