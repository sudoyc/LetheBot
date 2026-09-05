# Loop State - Recovery

**Date:** 2026-07-10 03:45 local shell time (CST +0800)
**Phase:** Phase 5 acceptance evidence hardening / aggregate DB summary selected governed-memory tool-source compatibility validation.
**Status:** Current acceptance DB summary selected governed-memory tool-source compatibility slice is full-gate green, including group- and conversation-scoped tool-source regression coverage. `acceptance:db-summary --require-acceptance-hints` rejects memory-governance completion evidence when selected user memory is backed only by another user's successful tool call, selected group memory is backed only by a successful tool call from another group context, or selected conversation memory is backed only by a successful tool call from another conversation context. Real SnowLuma/QQ controlled acceptance remains manual/opt-in and unproven.
**Fact source:** current worktree, command output in the active continuation, and canonical docs. Historical appended recovery notes are archived in `docs/archive/loop/loop-state-recovery.md` and must remain context only, not completion proof.

## Current Snapshot

Fresh status for this continuation after the latest full gate:

```bash
2026-07-10 03:45:24 CST +0800
tracked_dirty=58 untracked=19 total=77
```

Pi packages:

- `@earendil-works/pi-agent-core 0.80.2`
- `@earendil-works/pi-ai 0.80.2`

Latest targeted gates in this acceptance DB summary selected governed-memory tool-source compatibility slice:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "tool sources" --silent
# initially exited 1 because selectedGovernedMemoryContexts stayed 1 when a selected user memory source was changed to another user's successful tool call
# after fix exited 0; 2 passed | 48 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "group memory tool sources" --silent
# exited 0; 2 passed | 50 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "conversation memory tool sources" --silent
# exited 0; 2 passed | 52 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 54 passed

pnpm typecheck
# initially exited 2 after the fix because rowExists became unused, then exited 0 after deleting the unused helper
pnpm lint
# exited 0
```

Latest final full gate after this acceptance DB summary selected governed-memory tool-source compatibility slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1245 passed | 8 skipped tests
```

Previous targeted gates in this acceptance DB summary selected governed-memory worker-source provenance slice:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "worker memory sources" --silent
# initially exited 1 because selectedGovernedMemoryContexts stayed 1 when a selected memory source was changed to a completed worker job without chat/raw provenance
# after fix exited 0; 2 passed | 46 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 48 passed

pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the acceptance DB summary selected governed-memory worker-source provenance slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1239 passed | 8 skipped tests
```

Previous targeted gates in this acceptance DB summary selected governed-memory owner/scope-compatible source evidence slice:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "memory owner" --silent
# initially exited 1 because selectedGovernedMemoryContexts stayed 1 when a user memory source was replaced with another user's inbound chat row

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "memory owner|usable source|source links" --silent
# after fix exited 0; 3 passed | 43 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 46 passed

pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the acceptance DB summary selected governed-memory owner/scope-compatible source evidence slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1237 passed | 8 skipped tests
```

Previous targeted gates in this acceptance DB summary selected governed-memory usable-source evidence slice:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "usable source" --silent
# initially exited 1 because selectedGovernedMemoryContexts stayed 1 after the memory source row was repointed to a rejected tool call

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "usable source|source links" --silent
# after fix exited 0; 2 passed | 43 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 45 passed
```

Previous final full gate after the acceptance DB summary selected governed-memory usable-source evidence slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1236 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the acceptance DB summary selected governed-memory source-link resolvability slice:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "source links" --silent
# initially exited 1 because selectedGovernedMemoryContexts stayed 1 after the memory source row was repointed to a missing chat-message source
# after fix exited 0; 1 passed | 43 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 44 passed
```

Previous final full gate after this acceptance DB summary selected governed-memory source-link resolvability slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1235 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the acceptance DB summary selected governed-memory scope/actor slice:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "other user|visible in the flow context" --silent
# exited 0; 1 passed | 42 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 43 passed
```

Previous final full gate after the acceptance DB summary selected governed-memory scope/actor slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1234 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the acceptance DB summary selected governed-memory visibility slice:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "visible in the flow context" --silent
# initially exited 1 because selectedGovernedMemoryContexts was 1 when a group flow selected private_only memory
# after fix exited 0; 1 passed | 41 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 42 passed
```

Previous final full gate after the acceptance DB summary selected governed-memory visibility slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1233 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the acceptance DB summary group-scope validation slice:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "normalized group scope" --silent
# initially exited 1 because group hints stayed true after the trigger row lost group_id
# after fix, targeted group-scope coverage exited 0 below

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "group scope" --silent
# exited 0; 2 passed | 39 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 41 passed
```

Previous final full gate after the acceptance DB summary group-scope validation slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1232 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the governed-memory lifecycle state-machine validation slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "invalid direct lifecycle transitions" --silent
# initially exited 1 because repo.supersede(disabledMemory) resolved
# after fix, targeted lifecycle coverage exited 0 below

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "invalid direct lifecycle transitions|approve proposed memory|reject proposed memory|restore" --silent
# exited 0; 3 passed | 36 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/cli/governance.test.ts tests/integration/cli-main.test.ts -t "memory|MemoryRepository|enable-memory|restore-memory|supersede-memory|approve/reject" --silent
# exited 0; 3 passed test files; 80 passed | 110 skipped tests
```

Previous final full gate after this governed-memory lifecycle state-machine validation slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1230 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the ContextBuilder memory retrieval-limit validation slice:

```bash
pnpm exec vitest run tests/unit/context/builder.test.ts -t "group visibility before user-memory retrieval limits" --silent
# initially exited 1 because selectedMemoryIds was empty when private-only rows consumed the default window
# after fix, targeted context-builder coverage exited 0 below

pnpm exec vitest run tests/unit/context/builder.test.ts -t "group visibility before user-memory retrieval limits|private_only memory in group context|group and conversation summaries" --silent
# exited 0; 3 passed | 12 skipped

pnpm exec vitest run tests/unit/context/builder.test.ts tests/unit/storage/memory-repository.test.ts tests/unit/tools/memory-search.test.ts tests/integration/memory-injection.test.ts --silent
# exited 0; 4 passed test files; 73 passed tests
```

Latest final full gate after this ContextBuilder memory retrieval-limit validation slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1229 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the retrieval/search visibility-limit validation slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "visibility before limit" --silent
# initially exited 1 because group retrieval and search returned [] when private-only rows consumed limit=1
# after fix exited 0; 2 passed | 36 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "visibility before limit|enforce sensitivity, visibility, and state filters|exclude expired active memories" --silent
# exited 0; 5 passed | 33 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/context/builder.test.ts tests/unit/tools/memory-search.test.ts tests/integration/memory-injection.test.ts --silent
# exited 0; 4 passed test files; 72 passed tests
```

Latest final full gate after this retrieval/search visibility-limit validation slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1228 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the proposal-decision lifecycle validation slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "non-proposed memory" --silent
# initially exited 1 because approve(active) resolved without enforcing proposed state
# after fix, proposal-decision targeted coverage exited 0 below

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "non-proposed memory|approve proposed memory|reject proposed memory" --silent
# exited 0; 3 passed | 33 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/cli/governance.test.ts --silent
# exited 0; 3 passed test files; 99 passed tests
```

Latest final full gate after this proposal-decision lifecycle validation slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1226 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the no-return-to-proposed lifecycle validation slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "transitions back to proposed" --silent
# initially exited 1 because updateState resolved and changed an active record back to proposed
# after fix exited 0; 1 passed | 34 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent
# exited 0; 3 passed test files; 79 passed tests
```

Latest final full gate after this no-return-to-proposed lifecycle validation slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1225 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the expiration lifecycle metadata validation slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "invalid memory expiration" --silent
# initially exited 1 because invalid expiresAt resolved and created one memory row
# after fix exited 0; 1 passed | 33 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "malformed explicit memory sources|blank implicit memory source context|duplicate explicit memory source ids|invalid memory expiration" --silent
# exited 0; 4 passed | 30 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent
# exited 0; 3 passed test files; 78 passed tests
```

Latest final full gate after this expiration lifecycle metadata validation slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1224 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the duplicate explicit source provenance validation slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "duplicate explicit memory source ids" --silent
# initially exited 1 because duplicate sourceId inputs resolved and created one memory row
# after fix exited 0; 1 passed | 32 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "malformed explicit memory sources|blank implicit memory source context|duplicate explicit memory source ids" --silent
# exited 0; 3 passed | 30 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent
# exited 0; 3 passed test files; 77 passed tests
```

Previous final full gate after the duplicate explicit source provenance validation slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1223 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the implicit/default memory source provenance validation slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "blank implicit memory source context" --silent
# initially exited 1 because a blank implicit sourceContext still resolved and created a memory row
# after fix exited 0; 1 passed | 31 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "malformed explicit memory sources|blank implicit memory source context" --silent
# exited 0; 2 passed | 30 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent
# exited 0; 3 passed test files; 76 passed tests

pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the implicit/default memory source provenance validation slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1222 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the explicit memory source provenance validation slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "malformed explicit memory sources" --silent
# initially exited 1 because a blank sourceId still created a memory row
# after fix exited 0; 1 passed | 30 skipped

pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/actions/action-executor.test.ts tests/unit/tools/memory-search.test.ts --silent
# exited 0; 3 passed test files; 75 passed tests

pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the explicit memory source provenance validation slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1221 passed | 8 skipped tests
```

Previous targeted gates in the action-execution linkage FK guard coverage slice:

```bash
pnpm exec vitest run tests/unit/storage/database.test.ts -t "action execution memory and job linkage" --silent
# exited 0; 1 passed | 23 skipped

pnpm exec vitest run tests/unit/storage/database.test.ts tests/unit/actions/action-repository.test.ts tests/unit/actions/action-executor.test.ts --silent
# exited 0; 3 passed test files; 61 passed tests

pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the action-execution linkage FK guard coverage slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1220 passed | 8 skipped tests
```

Previous targeted gates in the duplicate generated durable-job group coverage slice:

```bash
pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "duplicate generated durable" --silent
# exited 0; 1 passed | 32 skipped

pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/job-repository.test.ts tests/unit/types/action.test.ts --silent
# exited 0; 4 passed test files; 71 passed tests

pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the duplicate generated durable-job group coverage slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1219 passed | 8 skipped tests
```

Previous targeted gates in the multi durable-job action idempotency collision slice:

```bash
pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "multiple same-type background" --silent
# initially exited 1 because two same-type summary actions reused one generated idempotency key and returned one distinct job ID
# after fix exited 0; 1 passed | 31 skipped

pnpm exec vitest run tests/unit/actions/action-executor.test.ts --silent
# exited 0; 1 passed test file; 32 passed tests

pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/job-repository.test.ts tests/unit/types/action.test.ts --silent
# exited 0; 4 passed test files; 70 passed tests

pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the multi durable-job action idempotency collision slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1218 passed | 8 skipped tests
```

Previous targeted gates in the evaluator-modified action local-control anchoring slice:

```bash
pnpm exec vitest run tests/unit/actions/social-decision-service.test.ts --silent
# exited 0; 1 passed test file; 4 passed tests

pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "local cooldown and redaction constraints"
# initially exited 1 because the event did not enter the risk path; after test correction exited 0; 1 passed test file; 91 passed tests

pnpm exec vitest run tests/unit/actions/social-decision-service.test.ts tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/types/action.test.ts --silent
# exited 0; 4 passed test files; 54 passed tests

pnpm typecheck && pnpm lint
# exited 0
```

Previous final full gate after the evaluator-modified action local-control anchoring slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1217 passed | 8 skipped tests
```

Previous targeted gates in the `SocialDecisionService` private action target identity propagation slice:

```bash
pnpm exec vitest run tests/unit/actions/social-decision-service.test.ts tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/types/action.test.ts --silent
# exited 0; 4 passed test files; 51 passed tests

pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "private reply"
# exited 0; 1 passed test file; 90 passed tests

pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the `SocialDecisionService` private action target identity propagation slice:

```bash
pnpm release:check
# exited 0
# 75 passed | 1 skipped test files
# 1213 passed | 8 skipped tests

git diff --check
# exited 0
```

Previous targeted gates in the `dm_user` canonical/platform target identity boundary slice:

```bash
pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "dm_user" --silent
# initially exited 1; proactive opt-out was checked against platform target.userId and missing canonical targets still attempted privacy lookup
# after fix exited 0; 5 passed | 26 skipped

pnpm exec vitest run tests/unit/actions/action-executor.test.ts --silent
# exited 0; 31 passed

pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts tests/unit/storage/database.test.ts tests/unit/cli/governance.test.ts tests/unit/types/action.test.ts --silent
# exited 0; 5 passed test files; 103 passed tests

pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the `dm_user` canonical/platform target identity boundary slice:

```bash
pnpm release:check
# exited 0
# 74 passed | 1 skipped test files
# 1212 passed | 8 skipped tests
```

Previous final full gate after the `dm_user` proactive-audit metadata slice:

```bash
pnpm release:check
# exited 0
# 74 passed | 1 skipped test files
# 1211 passed | 8 skipped tests
```

Previous final full gate after the durable local-action L0 guard coverage slice:

```bash
pnpm release:check
# exited 0
# 74 passed | 1 skipped test files
# 1210 passed | 8 skipped tests
```

Previous final full gate after the `propose_memory` memory-association opt-out enforcement slice:

```bash
pnpm release:check
# exited 0
# 74 passed | 1 skipped test files
# 1208 passed | 8 skipped tests
```

Previous final full gate after the `silent_summarize_later` durable summary job scheduling / final-guard slice:

```bash
pnpm release:check
# exited 0
# 74 passed | 1 skipped test files
# 1203 passed | 8 skipped tests
```

Previous full gate after the initial `silent_summarize_later` durable summary job scheduling slice:

```bash
pnpm release:check
# exited 0
# 74 passed | 1 skipped test files
# 1201 passed | 8 skipped tests
```

Previous final full gate after the `schedule_background_task` action durable job scheduling slice:

```bash
pnpm release:check
# exited 0
# 74 passed | 1 skipped test files
# 1199 passed | 8 skipped tests
```

Previous targeted gate in the `admin_digest` dynamic sample redaction slice:

```bash
pnpm test:run tests/unit/workers/admin-digest.test.ts -- --runInBand
# initially exited 1; dynamic sample IDs/classifier fields leaked assignment-shaped secret/platform fragments
# after fix exited 0; 1 passed
```

Previous final full gate after the `admin_digest` dynamic sample redaction slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
git diff --check
# exited 0
pnpm release:check
# exited 0
# 74 passed | 1 skipped test files
# 1196 passed | 8 skipped tests
```

Previous targeted gate in the governance `/why` default latest-turn linked tool-call explainability slice:

```bash
pnpm test:run tests/integration/cli-main.test.ts -- --runInBand -t "without --turn"
# exited 0; 121 passed
```

Previous final full gate after this governance `/why` latest-turn slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
git diff --check
# exited 0
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1195 passed | 8 skipped tests
```

Previous targeted gate in the PiAdapter `group.recent_summary` privacy-boundary slice:

```bash
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "group.recent_summary"
# exited 0; 48 passed
```

Previous final full gate after this PiAdapter privacy-boundary slice:

```bash
pnpm typecheck
# exited 0
pnpm lint
# exited 0
git diff --check
# exited 0
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1195 passed | 8 skipped tests
```

Previous targeted gate in the acceptance DB-summary tool-call status aggregation slice:

```bash
pnpm test:run tests/unit/scripts/local-acceptance-evidence.test.ts -- --runInBand -t "summarizes an acceptance database with aggregate-only redacted evidence|fails required acceptance DB hints"
# exited 0; 39 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
git diff --check
# exited 0
```

Previous final full gate after the acceptance DB-summary tool-call status aggregation slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1194 passed | 8 skipped tests
```

Previous targeted gate in the `/why` failed-turn linked tool-call explainability slice:

```bash
pnpm test:run tests/integration/cli-main.test.ts -- --runInBand -t "failed turns with linked redacted tool-call evidence"
# exited 0; 121 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
git diff --check
# exited 0
```

Previous final full gate after the `/why` failed-turn linked tool-call explainability slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1194 passed | 8 skipped tests
```

Previous targeted gate in the PiAdapter `beforeToolCall`-only rejection traceability slice:

```bash
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "beforeToolCall-only rejected tool call ids"
# exited 0; 47 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 47 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous final full gate after the PiAdapter `beforeToolCall`-only rejection traceability slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1193 passed | 8 skipped tests
```

Previous targeted gate in the PiAdapter handler-error tool-call traceability slice:

```bash
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "errored tool call ids"
# exited 0; 46 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 46 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Previous targeted gate in the PiAdapter rejected tool-call traceability slice:

```bash
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "rejected tool call ids"
# exited 0; 45 passed
pnpm typecheck && pnpm lint && pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; typecheck/lint passed; 45 passed
```

Latest full gate before this memory lifecycle slice:

```bash
pnpm release:check
# exited 0
# 72 passed | 1 skipped test files
# 1144 passed | 8 skipped tests
```

Latest targeted gate in this memory-governance slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts --silent
# exited 0; 28 passed
pnpm exec vitest run tests/unit/memory/proposal-service.test.ts tests/unit/workers/memory-extraction.test.ts tests/integration/memory-retrieval.test.ts --silent
# exited 0; 42 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest targeted gate in this memory lifecycle slice:

```bash
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts -t "expired active memories" --silent
# exited 0; 2 passed
pnpm exec vitest run tests/unit/storage/memory-repository.test.ts tests/unit/context/builder.test.ts tests/integration/memory-retrieval.test.ts --silent
# exited 0; 51 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this memory lifecycle slice:

```bash
pnpm release:check
# exited 0
# 72 passed | 1 skipped test files
# 1146 passed | 8 skipped tests
```

Latest targeted gate in this action executor L0 guard slice:

```bash
pnpm exec vitest run tests/unit/actions/action-executor.test.ts -t "evaluator-required|prohibited" --silent
# initially exited 1; sender was called in both bypass cases
# after fix exited 0; 2 passed
pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/unit/actions/action-repository.test.ts --silent
# exited 0; 12 passed
pnpm exec vitest run tests/unit/actions/action-executor.test.ts tests/integration/e2e-conversation.test.ts -t "evaluator-required|prohibited|evaluator rejection|evaluator downgrade" --silent
# exited 0; 4 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this action executor slice:

```bash
pnpm release:check
# exited 0
# 72 passed | 1 skipped test files
# 1148 passed | 8 skipped tests
```

Latest targeted gate in this tool registry L0 permission slice:

```bash
pnpm exec vitest run tests/unit/tools/registry.test.ts -t "user allow and deny" --silent
# initially exited 1; denied/non-allowed users were still allowed
# after fix exited 0; 1 passed
pnpm exec vitest run tests/unit/tools/registry.test.ts tests/integration/file-operations.test.ts tests/unit/pi/pi-adapter.test.ts -t "checkPermission|user allow and deny|Tool Registration|evaluator|required|PolicyGate|tool call" --silent
# exited 0; 17 passed
pnpm exec vitest run tests/unit/tools/registry.test.ts tests/unit/pi/pi-adapter.test.ts --silent
# exited 0; 46 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this tool registry slice:

```bash
pnpm release:check
# exited 0
# 72 passed | 1 skipped test files
# 1149 passed | 8 skipped tests
```

Latest targeted gate in this PiAdapter group-context slice:

```bash
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# initially exited 1; matching allowedGroupIds tool was not exposed and beforeToolCall denied the group-scoped tool
# after fix exited 0; 39 passed
pnpm test:run tests/unit/tools/registry.test.ts tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 49 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this PiAdapter group-context slice:

```bash
pnpm release:check
# exited 0
# 72 passed | 1 skipped test files
# 1152 passed | 8 skipped tests
```

Latest targeted gate in this PiAdapter tool-audit group-context slice:

```bash
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "group context in tool audit"
# initially exited 1; audit details omitted groupId for group-scoped tool success/rejection
# after fix exited 0; 40 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 40 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this PiAdapter tool-audit group-context slice:

```bash
pnpm release:check
# exited 0
# 72 passed | 1 skipped test files
# 1153 passed | 8 skipped tests
```

Latest targeted gate in this groupId normalization slice:

```bash
pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "numeric bot at value"
# initially exited 1 after expectation update; context_traces.group_id stored bare numeric values
# after fix exited 0; 84 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 40 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest targeted gate in this Pi-input groupId E2E proof follow-up:

```bash
pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "numeric bot at value"
# exited 0; 84 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 40 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest targeted gate in this action execution return-value redaction slice:

```bash
pnpm test:run tests/unit/actions/action-repository.test.ts -- --runInBand -t "sensitive action decision"
# initially exited 1; returned ActionExecutionResult still contained raw downgrade/error/audit diagnostics
# after fix exited 0 via the full action-repository file; 3 passed
pnpm test:run tests/unit/actions/action-executor.test.ts -- --runInBand
# exited 0; 9 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this action execution return-value redaction slice:

```bash
pnpm release:check
# exited 0
# 72 passed | 1 skipped test files
# 1153 passed | 8 skipped tests
```

Latest targeted gate in this built-in `memory.search` slice:

```bash
pnpm test:run tests/unit/tools/memory-search.test.ts -- --runInBand
# exited 0; 4 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "memory.search"
# exited 0; 41 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 41 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this built-in `memory.search` slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1158 passed | 8 skipped tests
```

Latest targeted gate in this built-in `memory.propose` slice:

```bash
pnpm test:run tests/unit/tools/memory-search.test.ts -- --runInBand
# exited 0; 7 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "memory.propose|memory.search"
# exited 0; 42 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 42 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this built-in `memory.propose` slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1162 passed | 8 skipped tests
```

Latest targeted gate in this built-in `memory.disable` slice:

```bash
pnpm test:run tests/unit/tools/memory-search.test.ts -- --runInBand
# exited 0; 9 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "memory.disable|memory.propose|memory.search"
# exited 0; 43 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 43 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this built-in `memory.disable` slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1165 passed | 8 skipped tests
```

Latest targeted gate in this built-in `group.recent_summary` slice:

```bash
pnpm test:run tests/unit/tools/memory-search.test.ts -- --runInBand
# exited 0; 11 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "group.recent_summary|memory.disable|memory.propose|memory.search"
# exited 0; 44 passed
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; 44 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this built-in `group.recent_summary` slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1168 passed | 8 skipped tests
```

Latest targeted gate in this `reply_with_tool` action executor slice:

```bash
pnpm test:run tests/unit/actions/action-executor.test.ts -- --runInBand
# exited 0; 11 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this `reply_with_tool` action executor slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1170 passed | 8 skipped tests
```

Latest targeted gate in this `react_only` action executor slice:

```bash
pnpm test:run tests/unit/actions/action-executor.test.ts -- --runInBand -t "react_only"
# initially exited 1; react_only was rejected as not implemented and no reaction/fallback side effects occurred
# after fix exited 0; 15 passed
pnpm test:run tests/unit/actions/action-executor.test.ts -- --runInBand
# exited 0; 15 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this `react_only` action executor slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1174 passed | 8 skipped tests
```

Latest targeted gate in this `send_folded_forward` action executor slice:

```bash
pnpm test:run tests/unit/actions/action-executor.test.ts -- --runInBand -t "send_folded_forward"
# initially exited 1; send_folded_forward was rejected as not implemented and no fallback side effect occurred
# after fix exited 0; 18 passed
pnpm test:run tests/unit/actions/action-executor.test.ts -- --runInBand
# exited 0; 18 passed
pnpm typecheck
# exited 0
pnpm lint
# exited 0
```

Latest final full gate after this `send_folded_forward` action executor slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1177 passed | 8 skipped tests
```

Latest targeted gate in this FakeOneBot reaction observability slice:

```bash
pnpm test:run tests/fakes/fake-onebot.test.ts -- --runInBand -t "sendReaction|reset"
# initially exited 1; reaction inspection/assertion helpers did not exist
# after fix exited 0; 31 passed
```

Latest targeted gate in this real OneBotAdapter capability slice:

```bash
pnpm test:run tests/unit/gateway/onebot-adapter.test.ts -- --runInBand -t "implemented OneBot gateway capabilities"
# initially exited 1; OneBotAdapter reported folded-forward capabilities as true
# after fix exited 0; 47 passed
```

Latest targeted gate in this acceptance DB-summary `reply_with_tool` slice:

```bash
pnpm test:run tests/unit/scripts/local-acceptance-evidence.test.ts -- --runInBand -t "reply_with_tool success|folded-forward fallback|requires complete linked chat flows to include a delivered reply action|requires delivered reply actions"
# initially exited 1 before the fix; reply_with_tool success with persisted bot.response rows did not count as delivered reply evidence
# after fix and folded-forward negative regression exited 0; 38 passed
```

Latest targeted gate in this outward-action `bot.response` persistence slice:

```bash
pnpm test:run tests/integration/e2e-conversation.test.ts -- --runInBand -t "reply_with_tool delivery|folded-forward text fallback"
# initially exited 1; both sent paths lacked persisted bot.response rows
# after fix exited 0; 86 passed
```

Latest targeted gate in this delivered-text `bot.response` traceability slice:

```bash
pnpm test:run tests/integration/e2e-conversation.test.ts -t "evaluator-modified delivered text"
# initially exited 1; bot.response contained the raw Pi draft instead of the delivered action payload text
# after fix exited 0; 1 passed | 87 skipped
```

Latest targeted gate in this `react_only` face/text fallback `bot.response` traceability slice:

```bash
pnpm test:run tests/integration/e2e-conversation.test.ts -t "react_only face-message fallback"
# initially exited 1; the fallback send had no persisted bot.response row
# after fix exited 0; 1 passed | 88 skipped

pnpm typecheck && pnpm lint && pnpm test:run tests/integration/e2e-conversation.test.ts -t "react_only action execution|react_only face-message fallback|evaluator-modified delivered text"
# exited 0; 3 passed | 86 skipped
```

Latest targeted gate in this acceptance DB-summary `react_only` fallback boundary slice:

```bash
pnpm test:run tests/unit/scripts/local-acceptance-evidence.test.ts -t "react_only face-message fallback|folded-forward fallback|reply_with_tool success"
# exited 0; 3 passed | 36 skipped
```

Latest final full gate after this acceptance DB-summary `react_only` fallback boundary slice:

```bash
pnpm release:check
# exited 0
# 73 passed | 1 skipped test files
# 1190 passed | 8 skipped tests
```

Latest final full gate after this groupId normalization slice:

```bash
pnpm release:check
# exited 0
# 72 passed | 1 skipped test files
# 1153 passed | 8 skipped tests
```

## Active WIP Boundary

This document is intentionally short. Do not append full per-slice transcripts here. For detailed historical notes, use the archive path above. Keep only:

- current phase/status;
- latest authoritative command evidence;
- changed-file summary;
- remaining live acceptance gap;
- exact next action.

## Worktree Hazards

Do not broad-stage, delete, or commit without explicit user approval.

Known untracked inventory remains 19 paths, including new built-in memory tool source/test paths, scratch/backup files, and untracked planning docs. Do not read/delete/stage scratch or backup paths. The objective explicitly names `docs/one-shot-full-completion-constraints.md` and `docs/full-project-gap-analysis.md` as planning inputs; treat other untracked paths as off-limits unless the user authorizes them.

## Remaining Production Gaps

Not production-ready yet:

1. Real SnowLuma/QQ private chat acceptance evidence is missing.
2. Real group exact `@bot` acceptance evidence is missing.
3. Real action executor / response router delivery evidence is missing beyond deterministic/fake and DB-summary gates.
4. Governed-memory live acceptance without privacy leakage is missing.
5. `/tmp/lethebot-acceptance-evidence.md` has not been filled from live runtime and has not passed both validators in complete mode.
6. Real provider/evaluator/tool-loop evidence remains opt-in/incomplete.
7. Multi-hour/day live soak and final installer/update artifact remain incomplete.
8. Untracked scratch hygiene remains unresolved and requires user authorization.

## Exact Next Actions

If no local SnowLuma/QQ runtime/session is explicitly authorized, continue deterministic work only:

1. Keep `docs/next-codex-project-state.md` synchronized with the latest verified status.
2. If deterministic work continues, choose another high-value architecture gap with DB-backed tests, such as the next conservative capability-gated action executor path, or ask the user for explicit authorization to clean/promote/delete untracked scratch/planning paths.
3. Re-run the narrowest relevant gate after any new code/docs change and keep `pnpm release:check` green before handing off.
4. Do not claim production readiness until real private/group SnowLuma/QQ evidence passes both validators.

If the user explicitly authorizes local runtime/secrets/session, switch to Phase 5 and run the documented redaction-first acceptance flow using `/tmp/lethebot-acceptance-evidence.md`.
