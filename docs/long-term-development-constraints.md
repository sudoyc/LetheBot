# Long-Term Development Constraints

**Purpose:** 本文档是后续修复和长期开发 LetheBot 时的硬约束。它补充 `AGENTS.md`，用于约束新的 `/goal` prompt 和长循环开发。

## 0. Authority and Evidence Rules

1. 当前 worktree、命令输出、测试结果、数据库内容是事实来源。
2. `docs/*COMPLETE*`、`loop-state*.md`、历史 prompt 只能作为历史线索，不可直接作为完成证据。
3. 任何“完成”声明都必须绑定当前验证命令或文件证据。
4. 不允许把“没有看到失败”当成通过；必须主动运行或检查对应证据。
5. 若文档与代码冲突：先记录冲突，再按架构核心原则修复；不要静默选择较容易的一边。

## 1. Baseline Gate

开始任何长期功能前，必须先建立 baseline：

- `git status --short`
- `pnpm typecheck`
- `pnpm test:run` 或明确的 deterministic subset
- `pnpm lint` 或记录当前 lint debt
- package dependency check for all imported packages
- DB schema and FK assumptions for touched persistence code

若 baseline 不绿，不得继续新增长期功能；只能做 recovery 或为 recovery 添加测试。

## 2. Worktree Hygiene

1. 不提交或保留测试生成的部署文件，例如 root `docker-compose.yml`、`lethebot.service`、`ecosystem.config.js`，除非它们是明确交付物。
2. 不提交 `.env`、logs、SQLite db、API key、QQ private identifiers。
3. 修改文档中的完成状态时，必须同时写入验证日期和证据命令。
4. 不做与当前 phase 无关的格式化/重构。
5. 不删除他人的 WIP，除非用户明确要求。

## 3. Git and Commit Rules

继承 `AGENTS.md`：默认不 commit。

- 如果未来 `/goal` prompt 明确要求“按阶段提交”，才允许 commit。
- 每次 commit 只 stage 显式路径。
- 失败状态、临时日志、数据库、`.env` 不能提交。
- 若没有明确 commit 权限，只更新文件并在最终报告列出建议 commit 分组。

## 4. Architecture Boundary Constraints

### Gateway

- 只做协议适配、平台消息转换、发送/接收、capability reporting。
- 不做 memory retrieval。
- 不构建 prompt。
- 不直接决定 long-term memory。

### Ingestion

- 必须先写 raw event，再做下游处理。
- `chat_messages` 必须引用真实存在的 raw event 或明确合法的 agent/system event。
- 不允许用临时格式相似但不存在的 FK。

### Memory

- Pi / evaluator / worker 只能提出 memory candidate。
- Durable memory write 必须经过 memory policy/action executor 或等价受控服务。
- 自动 active memory 必须可追溯、可 rollback、可 supersede。

### Context

- ContextBuilder owns retrieval, filtering, ranking, budgeting, prompt assembly trace。
- 不允许在 Gateway 或 PiAdapter 内绕过 ContextBuilder 做长期记忆注入。

### Pi

- Pi owns reasoning and tool proposals only。
- Pi 不直接写 durable storage，不直接执行危险工具，不直接发送平台消息。

### Tools

- 所有工具必须通过 registry。
- Permission、sandbox、audit、secret scanning 不能被 `evaluatorPolicy=bypass` 绕过。

## 5. Data Integrity Constraints

1. SQLite foreign keys must be enabled and tests must verify FK-valid writes.
2. `raw_events` 是审计根，不能被 derived records 替代。
3. `chat_messages.raw_event_id` 必须真实存在，除非 schema 明确允许 nullable/agent synthetic events。
4. 写入 `memory_records` 时必须同步或事务化写入：
   - `memory_sources`
   - `memory_revisions`
   - relevant `audit_log` entry
5. FTS indexes must update automatically or writes must explicitly rebuild/update index in tested code.
6. Soft deletion must exclude records from retrieval immediately.
7. Tests must include database-level assertions, not only HTTP status assertions.

## 6. Memory Privacy Constraints

Ordinary prompts and retrieval must exclude:

- `state IN ('deleted', 'disabled', 'superseded')`
- `sensitivity IN ('secret', 'prohibited')`
- `visibility='private_only'` in group context unless explicit owner/admin debug flow
- unrelated user/group/conversation scope
- full platform account tables
- full nickname history
- raw audit traces outside owner/admin debug

Group-chat-derived user memory constraints:

1. A single ordinary group message must not become active user memory.
2. Third-party claims about a user must not become that user's active memory without confirmation.
3. Group conflict/relationship judgments should become proposal/admin digest, not active user fact.
4. Source context must remain `group_chat` when evidence came from group chat.

Secret/prohibited constraints:

- Passwords, tokens, API keys, cookies, private keys, recovery codes must not become ordinary memory content.
- Secret-like text in tool output must be redacted before audit or prompt injection.
- Secret scanning cannot be a stub in any production-ready phase.

## 7. Context Orchestration Constraints

1. ContextPack must record selected memory IDs.
2. It should also record rejected candidate memory IDs and reasons when retrieval logic matures.
3. Token budget must be calculated on actual injected text, not placeholder constants only.
4. Bot historical messages must not be silently discarded once multi-turn context is a target.
5. Participant display names/group cards are untrusted data and must be structured, not injected as instructions.
6. Platform IDs may be included only when purpose-bound.

## 8. Pi Runtime Constraints

1. Import paths must correspond to installed dependencies.
2. Real API tests must be gated by explicit env vars and excluded from default deterministic suite when credentials are absent.
3. PiAdapter must be testable with mock agent/core without importing missing real provider packages.
4. Tool call hooks must enforce PolicyGate before execution.
5. Failed Pi turns must be observable as failed turns, not silent no-response success.

## 9. Tool and Sandbox Constraints

1. `ToolRegistryEntry.handler` must have one consistent representation:
   - either resolved function handler at registration; or
   - module path resolved by a registry/loader before Pi sees it.
2. Path validation must use path boundary checks that prevent prefix attacks.
3. Read tools with `secret_possible` output require effective secret scan.
4. Write/delete/shell/network/platform-admin tools require audit and policy checks.
5. Audit `full` must not record credential values.

## 10. Testing Constraints

Default test strategy:

- Unit tests for pure modules.
- Integration tests with FakeOneBot / in-memory or temp SQLite.
- Real API tests skipped unless explicit env var and credentials exist.
- Live NapCat tests separate from default CI/local green path.

A test is weak if it only asserts:

- HTTP 200;
- method was called;
- array length without checking content/scope;
- mocked success without DB side effects.

A strong test asserts:

- persisted rows and FK validity;
- retrieved/injected content and exclusion rules;
- audit/source/revision rows;
- response/action outcome;
- failure path observability.

## 11. Documentation Constraints

1. Do not write “MVP complete” unless current gates prove it.
2. Status docs must include:
   - date;
   - commands run;
   - pass/fail summary;
   - known gaps.
3. Historical completion docs should be labelled historical if contradicted by current state.
4. Prompt docs must not include stale assumptions like “291 tests passing” unless verified in the same turn/session.
5. New phase docs should prefer recovery-first sequencing over optimistic feature expansion.

## 12. Recovery Completion Criteria

The recovery stage is complete only when:

- `pnpm typecheck` passes.
- Default deterministic `pnpm test:run` passes.
- `pnpm lint` passes or has a small documented exception plan approved by user.
- `src/index.ts` or its successor service can process a fake message and produce valid persisted event/message records.
- Memory write path creates source/revision/audit records.
- Context retrieval excludes disabled/deleted/superseded/secret/prohibited/private-in-group memories.
- Pi integration import path is stable and mockable.
- Status docs are updated to match evidence.

## 13. Long-Term Completion Criteria

A production-ready long-term phase is complete only when:

- QQ private and group loop works against NapCat in a controlled soak test.
- User memory affects answers within allowed visibility.
- Group memory affects group answers without leaking private user memory.
- `/why` or CLI equivalent can show selected memory/context trace.
- User/admin can inspect, disable, delete, restore/supersede memory.
- Tool calls are audited and sandboxed.
- Raw event and chat retention policies are configurable.
- Backup/restore path is documented and tested.
