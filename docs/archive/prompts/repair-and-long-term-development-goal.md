# Repair and Long-Term Development Goal Prompt

下面是一份新的 `/goal` prompt，用于替代旧的 optimistic post-MVP prompt。它假设当前仓库存在文档/实现/测试漂移，先做 evidence-based recovery，再进入长期完善。

```text
/goal
你是 LetheBot 项目的开发 agent。请在当前 worktree 上执行“修复 + 长期完善”的持续开发目标。

## Objective

先把 LetheBot 从当前不可信的 post-MVP WIP 状态恢复到可验证、可迭代、符合隐私治理约束的稳定基线；然后按长期方向逐步完善 QQ / NapCat、厚记忆层、上下文编排、Pi runtime、工具治理、后台 worker、治理 CLI/UI 和运维能力。

## Critical Premise

不要相信历史 completion claims。`docs/MVP-COMPLETE.md`、`docs/phase-p0-complete.md`、`docs/loop-state.md`、`docs/loop-state-post-mvp.md` 只能作为历史线索；是否完成必须由当前文件和当前命令输出证明。

当前目标不是“继续从 N.8 往后做”，而是先做 recovery audit，再决定真实下一步。

## Required Reading Before Changes

按顺序读取：

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

若这些文档互相冲突，以 `AGENTS.md`、`docs/long-term-development-constraints.md`、当前验证证据和核心 architecture/privacy 原则优先。

## Working Rules

- Work from current state, not memory.
- Make small reversible changes.
- State assumptions when behavior is ambiguous.
- Do not add speculative abstractions.
- Do not bypass privacy/governance rules for speed.
- Do not commit unless the user explicitly asks for commits or this prompt is invoked with “允许按阶段提交”. If commit is not allowed, list suggested commit groups in the final report.
- Do not mark any phase complete without command/file evidence.
- Keep a recovery checkpoint document. If `docs/loop-state-recovery.md` does not exist, create it. Update it at phase boundaries with date, commands, pass/fail, changed files, and next step.

## Baseline Commands

Start by running and recording:

```bash
git status --short
pnpm typecheck
pnpm test:run
pnpm lint
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
```

If a command fails, record exact failure and treat it as recovery work. Do not continue feature expansion while typecheck or default deterministic tests are broken.

## Phase R0: Baseline and Drift Audit

Goal: establish truth.

Tasks:

1. Capture worktree status.
2. Run baseline commands.
3. Identify stale completion claims in docs.
4. Identify broken imports/dependencies.
5. Identify test suites that are weak, skipped, real-API-gated, or misleading.
6. Create/update `docs/loop-state-recovery.md` with the true state.

Exit criteria:

- Baseline is documented.
- Current blocker list is explicit.
- No feature work has started before the blocker list is known.

## Phase R1: Build and Deterministic Test Recovery

Goal: restore a trustworthy local development loop.

Priority order:

1. Fix missing package/import drift for Pi integration.
2. Fix TypeScript errors such as missing exported types.
3. Separate real API tests from default deterministic tests when credentials are absent.
4. Fix or quarantine tests that perform real network/API work without explicit gating.
5. Fix tests that write deployment artifacts to repo root.
6. Make `pnpm typecheck` pass.
7. Make default deterministic `pnpm test:run` pass.
8. Decide with evidence whether lint should be fully fixed now or tracked as a bounded debt. Prefer fixing lint if it is not too broad.

Exit criteria:

- `pnpm typecheck` passes.
- `pnpm test:run` passes without real credentials.
- Lint status is either pass or documented with a concrete cleanup phase.

## Phase R2: Ingestion and Persistence Integrity

Goal: raw event and chat message storage become reliable audit foundations.

Tasks:

1. Extract ingestion/persistence logic from the monolithic event handler if needed.
2. `storeRawEvent` must return the actual raw event ID.
3. `storeChatMessage` must use a valid `raw_event_id`.
4. Bot responses must have a valid event/message persistence strategy.
5. HTTP webhook tests must verify DB side effects, not only status 200.
6. Async event handler failures must be observable.
7. Add FK-valid integration tests.

Exit criteria:

- Fake/private and fake/group events create valid `raw_events` and `chat_messages` rows.
- Foreign key integrity is tested.
- Failures are visible in testable return/status/log path.

## Phase R3: Memory Governance Foundation

Goal: durable memory writes obey LetheBot's product contract.

Tasks:

1. Introduce memory candidate/proposal path if missing.
2. No direct auto-active write without policy decision.
3. Every durable memory write creates:
   - `memory_records`
   - `memory_sources`
   - `memory_revisions`
   - `audit_log`
4. Implement deterministic L0 secret/prohibited detection for obvious passwords/tokens/API keys/private keys.
5. Block or redact secret/prohibited memory content.
6. Ensure group-chat-derived user memory follows stricter rules.
7. Fix `MemoryRepository.search` to enforce scope/visibility/sensitivity/state filters.
8. Ensure FTS updates automatically or via tested write path.

Exit criteria:

- Tests prove deleted/disabled/superseded/secret/prohibited memories are excluded immediately.
- Tests prove private_only memory is not injected into group context.
- Tests prove source/revision/audit rows exist for durable memory changes.

## Phase R4: Context and Pi Runtime Recovery

Goal: Pi receives correct, bounded, explainable context through a stable adapter.

Tasks:

1. Restore PiAdapter import/dependency stability.
2. Ensure PiAdapter is mockable without real provider imports failing.
3. Convert recent user and bot messages correctly; do not silently drop bot history once multi-turn is targeted.
4. ContextBuilder retrieves user, group, conversation summaries, and recent messages with strict filters.
5. ContextPack records selected memories and identity fields.
6. Add trace fields for rejected memories/reasons if feasible.
7. Ensure system/persona prompt is not hardcoded in random call sites.

Exit criteria:

- Mock Pi turn test passes.
- Multi-turn context includes bot and user history where expected.
- Context tests assert inclusion and exclusion by state/visibility/sensitivity/scope.

## Phase R5: Tool, Policy, Sandbox, and Audit Hardening

Goal: tools are useful but governed.

Tasks:

1. Normalize `ToolRegistryEntry.handler` representation.
2. Ensure PiAdapter executes only resolved function handlers.
3. Enforce PolicyGate before tool execution.
4. Implement effective secret scanning for `secret_possible` outputs.
5. Harden file path validation against prefix and symlink escapes.
6. Add audit records for tool calls.
7. Ensure risky tools require evaluator/policy path and cannot be used by ordinary users.

Exit criteria:

- Tests prove bypass does not bypass permissions/sandbox/audit.
- Tests prove secret-like tool output is redacted before audit/prompt.
- Tests prove write/delete tools cannot run from ordinary private/group chat.

## Phase R6: Background Summaries and Retrieval Quality

Goal: workers create useful source-linked summaries without corrupting memory governance.

Tasks:

1. Fix SummaryWorker so it actually sends the conversation text/prompt to the summarizer.
2. Store summaries as governed memory with source links.
3. Make summary retrieval visible to ContextBuilder when appropriate.
4. Prevent duplicate summaries over the same window.
5. Make worker jobs idempotent.

Exit criteria:

- Summary tests assert prompt/input includes real messages.
- Summary memory has source links and revision/audit records.
- ContextBuilder can retrieve appropriate conversation/group summary.

## Phase R7: Governance CLI and Explainability

Goal: owner/admin can inspect and govern memory and trace context use.

Tasks:

1. CLI list/delete/disable/enable must create audit/revision records.
2. Add `/why` or CLI equivalent for last turn/context trace.
3. Add filters by scope/user/group/state/sensitivity/source.
4. Add display profile/nickname history deletion/redaction path or explicit TODO with schema impact.

Exit criteria:

- CLI tests cover state transitions and audit rows.
- Deleted/disabled memory cannot appear in retrieval after CLI action.

## Phase R8: QQ / NapCat Production Loop

Goal: real platform loop is ready for controlled soak testing.

Tasks:

1. Validate OneBot HTTP event auth/token strategy.
2. Parse mentions and CQ at target bot ID correctly.
3. Handle private/group message IDs, sender roles, group cards, quotes, media safely.
4. Send replies through response router or equivalent action executor path.
5. Add healthcheck that covers DB and adapter readiness.
6. Add a fake-to-real parity checklist.

Exit criteria:

- FakeOneBot tests cover private and group paths.
- NapCat integration tests are separate from default unless local service is explicitly configured.
- Deployment docs match actual env vars.

## Phase R9: Long-Term Operations

Goal: make the local-first service maintainable over weeks/months.

Tasks:

1. Retention policy for raw events, chat messages, audit, disabled/deleted memory.
2. Backup/restore script for SQLite.
3. Metrics/logging for turns, memory writes, policy decisions, tool calls.
4. Operator runbook for failures.
5. Dependency update policy.
6. Lightweight governance UI plan if CLI is insufficient.

Exit criteria:

- Backup/restore is tested on a temp DB.
- Operations doc includes actual commands and known failure modes.
- Metrics/logging fields are documented.

## Completion Audit

Before claiming the whole goal is complete:

1. Re-read `docs/long-term-development-constraints.md`.
2. List every phase exit criterion.
3. For each criterion, cite file paths and command evidence.
4. Run final gates:

```bash
pnpm typecheck
pnpm test:run
pnpm lint
```

5. If any gate fails, do not claim completion. Continue recovery or document blocker.

## Reporting Format

At each stopping point, report:

- Current phase and status.
- Commands run and results.
- Files changed.
- Evidence for completed criteria.
- Remaining risks.
- Next recommended step.
```
