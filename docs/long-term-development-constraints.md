# Long-Term Development Program And Constraints

**Purpose:** 本文档定义 LetheBot 下一阶段长期开发的稳定执行合同、阶段路线、验收证据和回滚边界。它补充 `AGENTS.md` 和各领域 canonical docs；当前事实、当前 phase 和下一步只记录在 `docs/long-running-goal-state.md`。

本文档不是完成证明。阶段编号和退出条件保持稳定，状态随当前 worktree 和新证据变化。

## 0. Program Objective

目标是把 LetheBot 从 `EXPERIMENTAL_NOT_NORMAL` 推进到可验证的本地优先 QQ 私聊/群聊产品：

- OneBot 入口具备明确的信任边界、请求上限和隐私安全日志；
- 不同会话可以受控并发，同会话保持有序，队列等待受 deadline 约束；
- 每次 Pi/provider 调用都有可关联、可汇总、可恢复的 durable ledger；
- 真实 QQ、Provider、工具和记忆路径通过受控验收，而不是由 mock 或健康检查代替；
- 长期记忆的提取、冲突、合并、衰减和删除均可审计、可复核、可回滚；
- 工具目录对实际用户有用，同时保持 registry、policy、sandbox、audit 和 redaction 边界；
- `src/index.ts` 的组合、入口、turn orchestration 和 worker runtime 被渐进拆分，不改变行为；
- owner/admin 可以通过同一 governance service 检查和控制记忆、上下文、模型调用、工具和任务；
- 发布、升级、回滚、备份、恢复和长时间 soak 有当前证据。

## 1. Authority And Document Control

### 1.1 Precedence

冲突时按以下顺序处理：

1. 用户最新的明确指令和针对具体操作的授权；
2. `AGENTS.md`、隐私/安全规则和非破坏性 worktree 规则；
3. 本文档的长期执行合同；
4. `docs/README.md`、`docs/architecture.md`、`docs/design-decisions.md` 和相关领域 canonical docs；
5. 当前代码、当前测试、当前数据库行为和本次命令输出；
6. `docs/long-running-goal-state.md` 中可回溯到当前证据的状态；
7. gap analysis、旧 roadmap、旧 prompt、archive 和历史完成报告。

代码描述“现在有什么”，不自动证明行为正确；架构文档描述“应该有什么”，不自动证明已经实现。

### 1.2 Single Control Plane

- `docs/long-running-goal-state.md` 是唯一可变的状态/checkpoint。
- 本文档保存稳定约束、阶段顺序和退出条件，不累积命令流水账或当前 test count。
- 稳定产品决策写入 `docs/design-decisions.md`。
- 领域 contract 随实现更新到其 owning canonical doc。
- `docs/prompts/repair-and-long-term-development-goal.md` 是本 program 的执行 prompt。
- `docs/group-chat-reliability-constraints.md` 继续约束相关行为，但它不是完整产品路线。
- `docs/one-shot-full-completion-constraints.md`、旧 goal prompts 和 `docs/next-full-implementation-plan.md` 仅作历史/方法参考。

### 1.3 Evidence Status Vocabulary

只使用以下状态，禁止把它们混写为“完成”：

| Status | Meaning |
|---|---|
| `UNVERIFIED` | 当前 worktree 尚未主动核验。 |
| `REPRODUCED` | 已有失败测试或可重复证据，修复尚未通过。 |
| `DETERMINISTIC_READY` | 相关本地测试、DB/FK 检查和 release gate 已通过；不代表真实运行。 |
| `LIVE_PROVED` | 在明确授权的目标 runtime 上完成受控验收，证据已脱敏并通过 validator。 |
| `PHASE_COMPLETE` | 本 phase 的 outcome、tests、evidence、rollback proof 和全部 exit criteria 当前都成立。 |
| `NEEDS_DECISION` | 唯一剩余阻碍是明确的产品/架构选择，且其他独立工作已完成。 |
| `BLOCKED_EXTERNAL` | 唯一剩余阻碍是明确的外部授权、凭据、session、服务或 runtime 状态。 |
| `TARGET_COMPLETE` | P0-P9 全部 `PHASE_COMPLETE`，最终矩阵无 required gap，最终 gates 与 live/soak 证据当前有效。 |

`pnpm release:check` 通过只支持 `DETERMINISTIC_READY`。健康容器、HTTP 200、成功发送一条消息、历史 live 结果都不能单独支持 `LIVE_PROVED` 或 `TARGET_COMPLETE`。

状态必须带 scope：单个 requirement 或 P4 可以是 `BLOCKED_EXTERNAL`，同时
goal 仍为 `ACTIVE` 并继续其他本地 phase。只有所有独立安全工作都完成后，
goal-level status 才能使用 `NEEDS_DECISION` 或 `BLOCKED_EXTERNAL`。

## 2. Starting Hypotheses To Reverify

以下是选择下一阶段优先级的假设，不是永久事实：

1. OneBot transport、raw/chat persistence、action delivery 和大部分群聊可靠性修复具有较强 deterministic evidence；对应新 build 尚未完成 fresh live acceptance。
2. Reverse HTTP 当前允许无 token 配置并默认绑定非 loopback；请求 body 在认证前无界缓冲。
3. debug 日志可能重复完整 event/chat 内容；QQ-like 标识符的 5-7 位范围与当前 redaction 规则不一致。
4. durable worker 以 `scheduled_at` FIFO 竞争一个执行通道，延迟 Attention 可能被长 maintenance job 阻塞。
5. 一个共享 Pi `Agent` 和 adapter-wide mutable turn context 串行化所有会话；排队时间不在当前 turn timeout 内。
6. 主 Pi turn 的 provider invocation 与 token usage 尚未完整写入 `model_invocations`；未知 usage 被表现为 zero。
7. `src/index.ts` 同时承担 composition root、HTTP、ingress、turn、governance 和 worker wiring，行为改动的 blast radius 过大。
8. Pi 实际暴露的 product tool catalog 很小；memory conflict/consolidation/decay 仍以非破坏性 scan/review evidence 为主。
9. CLI governance 很强，但缺少面向日常 owner/admin 的紧凑本地 UI 和权限会话边界。

P0 必须逐项重现或推翻这些假设，并把结果写入 active checkpoint。不得因为本文列出它们就直接声明 bug 已证明。

## 3. Authorization, Privacy, And Worktree Boundaries

### 3.1 Default Authority

除非启动 goal 的用户指令另有明确设置：

| Action | Default |
|---|---|
| 读取代码、canonical docs、synthetic test DB | allowed |
| 修改本地代码、测试、文档 | allowed for selected slice |
| 创建/覆盖 `/tmp` 中的 synthetic 或 aggregate-only evidence | allowed |
| commit | not authorized |
| push | not authorized |
| destructive cleanup、reset、revert、删除未知 WIP | not authorized |
| 读取/打印真实 credential、QQ ID、raw chat、live DB row | not authorized |
| Provider 调用、QQ send/login、SnowLuma/NapCat 操作 | fresh explicit authority required |
| build/recreate/restart live container/service | fresh explicit authority required |
| destructive or incompatible migration on a non-disposable DB | fresh explicit authority required |

一种授权不推导另一种授权。read-only live inspection 不等于 deploy、Provider call 或 QQ send 授权。

### 3.2 Sensitive Data

- 不提交 `.env`、logs、SQLite DB、API key、token、cookie、QR/session data、真实 QQ/group/message ID 或 raw chat。
- live evidence 只写 `/tmp`，权限按现有 runbook 收紧；只包含 aggregate、status、count、hash 或 redaction marker。
- fixture 必须 synthetic，不从真实 chat 改名复制。
- 未知本地 scratch/backup 内容不读取、不删除、不 stage。
- logger、audit、metrics、health、readiness、CLI 和 UI 都必须经过相同的 identifier/secret redaction contract。

## 4. Non-Negotiable Architecture And Data Invariants

### 4.1 Ownership Boundaries

- Gateway 只做协议适配、auth/capability、收发和平台格式归一化。
- Ingestion 先 durable raw event/admission，再创建 derived rows；重复 event 必须 idempotent。
- ContextBuilder 独占 retrieval、scope filtering、ranking、token budgeting、prompt assembly 和 trace。
- Pi 只负责 reasoning、text/tool proposals 和 provider interaction；不直接拥有 durable mutation、platform send 或 policy authority。
- Action executor 拥有效果执行、capability downgrade、outcome persistence 和 delivery truth。
- Tool execution 必须通过 registry、permission、L0 policy、evaluator policy、sandbox、output bound、redaction 和 audit。
- Worker 必须 durable、idempotent、lease-fenced、source-linked、retryable、observable。
- Governance CLI、QQ command 和 UI 复用同一 application service，不各自写 DB 规则。

### 4.2 Durable Memory

每次 durable memory write 必须具有：

- owner 和 scope；
- exact source event/message/effect；
- source timestamp 和 write timestamp；
- confidence、visibility、sensitivity 和 lifecycle state；
- revision evidence；
- audit/evaluator/actor authority evidence；
- 可执行的 disable/delete/supersede/rollback path。

删除、disable、supersede 和 scope/policy disable 必须立即影响 retrieval，不等待异步 FTS 或 worker。Group-derived user facts 保持 `same_group_only` 和 `proposed`，除非用户在受控流程中确认。第三方陈述不自动成为被陈述人的 active fact。

对既有长期记忆的 conflict resolution、consolidation 和 decay mutation 不得由 scan worker 自动执行；worker 只生成 bounded proposal/review evidence。任何 apply action 都需 governance authority、transactional revision/source/audit 和 rollback proof。D11 允许的新增 private memory activation policy 不因此被静默扩大。

### 4.3 Persistence

- SQLite foreign keys 始终启用。
- persistence test 必须检查 durable rows、transaction boundary、restart behavior 和空 `PRAGMA foreign_key_check`。
- migration 必须独立成 slice，包含 fresh DB、sequential upgrade、old/new compatibility、backup/restore 和 cross-version rollback rehearsal。
- schema、dependency upgrade、live deployment、behavior change、large refactor 不得出现在同一 slice。

## 5. Slice Execution Contract

每个 phase 由一个或多个可独立回滚的 vertical slice 完成。每个 slice 按固定循环执行：

1. 从 checkpoint 选择一个 requirement ID 和一个可观察 gap。
2. 写清 allowed paths、protected paths、acceptance assertions、commands 和 rollback boundary。
3. 对行为修复先添加会失败的 regression；对 refactor 先补 characterization test。
4. 实现满足测试的最小改动，不清理邻近代码。
5. 跑 focused tests；TypeScript 改动再跑 typecheck/lint；cross-module 或 phase exit 跑 `pnpm release:check`。
6. persistence slice 使用 fresh migrated temp DB，并验证 integrity/FK/rollback。
7. 检查完整 diff 和 secret/private artifact 风险。
8. 以替换 snapshot 的方式更新 `docs/long-running-goal-state.md`，记录下一步。
9. 只有全部 exit criteria 成立才把 phase 标记为 `PHASE_COMPLETE`。

连续在同一 subsystem 完成两个 slice 后，重新审查 P0-P9 critical path。不得用不断增加 parser/redaction edge case、test count、文档流水账或无用户故事的抽象来代替产品进展。

## 6. Baseline, Git, Checkpoint, And Rollback

### 6.1 Baseline Commands

每次 cold start 和 phase exit 至少执行：

```bash
date '+%Y-%m-%d %H:%M:%S %Z %z'
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
pnpm release:check
```

若 deterministic gate 失败，先恢复 gate；不得在未知红线之上扩功能。环境限制导致的 listener/IPC 失败必须先被复核，不能直接改产品代码掩盖。

### 6.2 Checkpoint Minimum Fields

`docs/long-running-goal-state.md` 每次替换 snapshot 时至少记录：

- timestamp、branch、HEAD、worktree inventory；
- selected program/phase/slice 和 requirement ID；
- observed gap 或 failing regression；
- allowed/protected paths 和 authority boundary；
- commands 与 pass/fail summary；
- DB/FK/privacy/live evidence 类型和路径类别，不写敏感内容；
- changed files；
- exit criteria 状态；
- rollback point 和 rollback result；
- exact next action；
- `NEEDS_DECISION` 或 `BLOCKED_EXTERNAL` 的唯一具体条件。

### 6.3 Git

- 只有启动 goal 明确授权 commits 时，才可在 verified slice/phase boundary commit。
- 每次只 `git add <explicit paths>`；禁止 `git add .`。
- commit 前检查 `git diff --check`、unstaged/staged diff 和 staged file list。
- migration、dependency、runtime behavior、refactor、UI 应分别 commit。
- push 需要独立授权；commit 授权不包含 push。
- rollback 优先使用 feature/config disable、旧 release activate 或反向小 commit；不使用 destructive reset 清理共享 worktree。

### 6.4 Stop And Escalation

出现以下条件时暂停该 branch 并记录证据；若有其他安全独立工作则继续：

- 产品行为存在两种以上合理语义，canonical docs 无决策；
- 需要不可逆/破坏性迁移或无法证明 cross-version rollback；
- 当前 live schema/runtime 与计划不兼容；
- 需要 credential、private row、QQ interaction、Provider call 或 deployment authority；
- rollback rehearsal 失败或 prior release 无法恢复 ready；
- 连续三种实质不同的尝试仍未解决同一 failure；
- 修复需要扩大到未选定 subsystem 或会覆盖未知 WIP。

只有全部安全本地工作完成后才可把整个 goal 标为 `NEEDS_DECISION` 或 `BLOCKED_EXTERNAL`。

## 7. Phase Roadmap

### P0: Fresh Baseline And Failure Reproduction

**Outcome:** 建立当前可信基线，逐项确认或推翻第 2 节假设，选定第一个 P1 slice。

**Implementation scope:**

- 运行 baseline，检查 active checkpoint 与 HEAD/worktree drift。
- 对 ingress、logger、job claim、Pi lease/timeout、model ledger、tool wiring 和 monolith responsibility 做 bounded code/test inspection。
- 为每个 gap 写 requirement row、可验证 assertion、预计 touched paths 和 rollback boundary。
- 不做 runtime、schema、dependency 或 live 变更。

**Verification:** baseline commands；必要时运行现有 focused tests证明当前行为，不修改 production semantics。

**Required evidence:** 当前命令结果；gap matrix；first slice 的 before/after assertions；worktree ownership inventory。

**Rollback:** docs/checkpoint-only diff 可直接按文件撤销；不得撤销其他人的 work。

**Exit criteria:** baseline 绿或 recovery 已完成；P1 security gaps 各自为 `REPRODUCED` 或有反证；checkpoint 指向唯一 next slice。

### P1: Ingress Trust, Request Bounds, And Privacy-Safe Logs

**Outcome:** 未认证、超限或不完整的 reverse HTTP event 在 parse/admission/DB/governance 前被拒绝，默认部署不意外暴露入口，日志不复制聊天或短 QQ 标识符。

**Implementation scope:**

- 默认 bind 改为 loopback。reverse HTTP event endpoint 只在 HTTP transport
  或独立显式 enable 时开放；启用后，非-loopback bind 在无 token 时
  startup fail-closed。loopback development 可显式允许 tokenless mode。
- 引入 `LETHEBOT_MAX_EVENT_BODY_BYTES`，默认 `262144`，同时检查
  `Content-Length` 和 streaming bytes；引入
  `LETHEBOT_EVENT_BODY_TIMEOUT_MS`，默认 `5000`。处理 abort/error/slow body，
  超限返回 `413`，超时返回 `408`，且只响应一次。
- 无可用 auth header 时在读取 body 前返回 `401`。Bearer 可 header-first 验证；SnowLuma HMAC 只对 bounded raw body 验证。
- 未认证 event 不进入 role normalization、raw admission、admin/governance 或 metrics side effects。
- 移除完整 event debug dump；只记录 bounded type/status/count/hash metadata。
- identifier redaction 与 QQ 允许的 5-12 位范围一致，并覆盖 string、numeric 和嵌套 fields。

**Focused verification:**

```bash
pnpm vitest run tests/unit/config/index.test.ts tests/unit/gateway/onebot-adapter.test.ts tests/unit/logger/index.test.ts tests/integration/e2e-conversation.test.ts
pnpm typecheck
pnpm lint
pnpm release:check
```

**Required evidence:** 无 token/non-loopback startup rejection；WS-only mode 不开放
reverse HTTP event route；401-before-body；413/408/no partial DB rows；valid
Bearer/HMAC acceptance；5-12 digit redaction；debug logs 无 raw message。

**Rollback:** 保留旧 config 名称兼容；通过明确 loopback dev flag 回退开发行为。若默认值影响部署，旧 release 可恢复，且新 release 未接收未认证流量前不迁移数据。

**Exit criteria:** 所有 security assertions 通过；docs/deployment、`.env.example` 和 security docs 与 fail-closed behavior 一致；release gate 绿；无 live deploy。

### P2: Scheduling Fairness, Conversation Concurrency, And Deadlines

**Outcome:** latency-sensitive work 不被 maintenance backlog 饿死；同会话按序、不同会话受控并发；deadline 覆盖 queue wait、provider work、tool loop 和 abort cleanup。

**P2A worker scope:**

- 给 delayed Attention/interactive work 独立 claim lane 或等价 persisted priority/fairness contract。
- general maintenance 不得 claim interactive-only work；interactive lane 空闲时的 borrowing 必须显式、可测、可关闭。
- 使用 fake clock/deferred task 证明 backlog、lease expiry、retry 和 shutdown drain，不依赖脆弱 wall-clock sleep。
- 优先避免 migration；若 priority 必须持久化，迁移独立成后续 slice。

**P2B Pi scope:**

- 去除 adapter-wide mutable turn state；每个 turn 使用隔离 session/agent context。
- 加 per-conversation FIFO 和 bounded global concurrency：
  `PI_MAX_CONCURRENT_TURNS=2`，每会话并发固定为 `1`，配置最大值 `16`；
  `PI_MAX_QUEUED_TURNS=128`，超限 admission 产生 durable overloaded outcome，
  不静默丢弃。
- queue admission 时即建立 absolute deadline；排队超时不触发 provider call。
- abort/timeout 后 session、tool context、events 和 lease 必须释放，不污染下一 turn。
- admission processing 失败、shutdown 和 duplicate ingress 维持原有 durable semantics。

**Focused verification:**

```bash
pnpm vitest run tests/unit/storage/job-repository.test.ts tests/unit/workers/background.test.ts tests/unit/pi/pi-adapter.test.ts tests/integration/app-shutdown.test.ts tests/integration/e2e-conversation.test.ts
pnpm typecheck
pnpm lint
pnpm release:check
```

**Required evidence:** maintenance backlog 下 interactive task 有界启动；同会话 order 保持；至少两个不同会话在 deterministic barrier 上并发；global cap 生效；queue timeout 不调用 provider；shutdown 无 lease/session leak。

**Rollback:** P2A lane 可单独 disable/drain；P2B concurrency 可配置回 `1`。任何 schema work 遵循 migration rollback contract，不与 concurrency implementation 同 commit。

**Exit criteria:** P2A/P2B 分别 verified；无 shared turn leakage；deadline/cancellation metrics 可观察；release gate 绿。

### P3: Pi Invocation Ledger And Usage Observability

**Outcome:** 每个主 Pi provider request 都能关联到 turn/source，真实 usage 可汇总，缺失 usage 显式为 unknown，失败/abort/retry 不消失。

**Implementation scope:**

- 扩展 `model_invocations` 支持 `pi_turn` purpose 和 exact turn ownership。
- provider 初始 request、tool-follow-up 和 correction/retry 分别 ledger；不得只为整个 turn 写一个模糊 aggregate。
- 从 typed Pi events/provider metadata 提取 input/output/cache/reasoning usage；没有 metadata 时存 `NULL/unknown`，不写伪造 zero。
- 记录 queue wait、provider latency、total latency、terminal status、bounded error code 和 model/provider identity；不记录 prompt/raw response。
- `agent_turns` totals 由 invocation evidence 聚合或保持 unknown；metrics/CLI/UI 使用相同口径。
- stale running invocation 的 startup recovery 和 timeout/abort transition 必须可重入。

**Focused verification:**

```bash
pnpm vitest run tests/unit/storage/model-invocation-repository.test.ts tests/unit/pi/pi-adapter.test.ts tests/unit/operations/sqlite-maintenance.test.ts tests/integration/e2e-conversation.test.ts
pnpm typecheck
pnpm lint
pnpm release:check
```

**Required evidence:** known usage 精确汇总；unknown 不等于 zero；多 request/tool loop ordinal 正确；timeout/failure/abort terminal；source/turn FK clean；metrics 不泄露 payload。

**Rollback:** schema migration 单独交付，具有 old/new release compatibility、snapshot restore 和 cross-version rehearsal；UI/metrics consumers 能容忍 unknown/new purpose。

**Exit criteria:** deterministic ledger matrix 全绿；fresh DB/upgrade/rollback 通过；主 Pi turn 不再以无解释 zero usage 完成。

### P4: Controlled QQ And Provider Acceptance

**Outcome:** 在 P1-P3 后的 reviewed build 上证明核心私聊/群聊、并发、账本、工具和记忆行为，达到 `BASIC_USABLE`；没有授权时准确停在 `BLOCKED_EXTERNAL`，不伪造 live proof。

**Implementation scope:**

- 只修复 canary 揭示且可用 synthetic regression 重现的问题。
- 不在 live session 中直接试探 schema、依赖升级或大 refactor。
- 使用 `docs/local-container-acceptance.md` 和 standard evidence validator；所有填充 evidence 保持 `/tmp` aggregate-only。

**Live acceptance matrix:**

| ID | Scenario | Required result |
|---|---|---|
| `LIVE-PRI-01` | 10 个 private direct turns | 10/10 accepted、terminal、delivered；conversation/source/action/turn 一致。 |
| `LIVE-GRP-01` | 至少 2 位参与者、20 个 exact-mention turns | 20/20 direct triggers terminal/delivered；0 speaker/scope error。 |
| `LIVE-QUOTE-01` | 12 个 reply-to-bot/quote turns，含 rolling window 外 target | 12/12 exact same-conversation target；0 proximity guess、0 cross-group match。 |
| `LIVE-RAPID-01` | 至少 3 个会话的 10 个 overlapping turns | 同会话有序、跨会话有 overlap、0 state/tool/context crossover。 |
| `LIVE-MEM-01` | private proposal/approval/restart/recall；opted-in exact-group continuity | recall 只在允许 scope；disable/delete 立即消失；0 private-in-group leak。 |
| `LIVE-GOV-01` | `/memory`、`/why`、group summary policy 和 unauthorized attempts | exact authority/scope；unauthorized 0 effect；audit 完整且输出脱敏。 |
| `LIVE-TOOL-01` | 一个允许的 Pi tool 和一个 denied tool | success/denial 都有 turn/evaluator/tool/audit evidence；0 payload leak。 |
| `LIVE-OPS-01` | readiness、DB integrity/FK、invocation usage、restart | ready；integrity ok；FK 0；主 Pi ledger 非空且 usage 口径正确。 |

**Focused verification after fresh authority:**

```bash
pnpm release:check
pnpm acceptance:evidence-template -- --out=/tmp/lethebot-next-stage-acceptance.md
pnpm ops:doctor
pnpm acceptance:validate-evidence -- /tmp/lethebot-next-stage-acceptance.md
pnpm acceptance:validate-evidence -- /tmp/lethebot-next-stage-acceptance.md --require-complete
```

**Required evidence:** validator-clean aggregate file、release digest/rollback ref、scenario counts、zero-tolerance violations、DB/FK summary、deployment/restart outcome。

**Rollback:** canary 前保存并验证 prior managed release；任一 attribution、privacy、auth、unsupported-memory-claim 或 direct-trigger loss 立即停止 sends，恢复 prior release，验证 readiness/schema/integrity，再记录失败。

**Exit criteria:** 矩阵全绿且两个 validators 通过才可写 `BASIC_USABLE` 和 `LIVE_PROVED`。缺少授权时本 phase 为 `BLOCKED_EXTERNAL`，不阻止继续 P5-P8 的独立 deterministic work。

### P5: Governed Memory Maintenance Completion

**Outcome:** conflict、consolidation、decay 从 audit-only scan 成为 previewable、reviewable、transactional、reversible 的治理流程，不引入无监督自动改写。

**Implementation scope:**

- scan 输出稳定 proposal IDs、candidate source set、reason、confidence 和 proposed effect。
- owner/user/admin 根据 exact scope review；approve/reject/expire 都产生 actor/revision/audit evidence。
- apply consolidation 保留所有 source links 和 superseded records；conflict resolution 不抹去争议历史；decay 默认 proposed disable，不物理删除。
- re-run/retry/idempotency、concurrent review、stale proposal 和 rollback 都有明确语义。
- 扩展 QQ/CLI/UI review queue 时复用 governance service。

**Focused verification:**

```bash
pnpm vitest run tests/unit/workers/memory-conflict.test.ts tests/unit/workers/memory-consolidation.test.ts tests/unit/workers/memory-decay.test.ts tests/unit/storage/memory-repository.test.ts tests/unit/governance/service.test.ts tests/integration/memory-retrieval.test.ts tests/integration/e2e-conversation.test.ts
pnpm typecheck
pnpm lint
pnpm release:check
```

P5 首个对应 slice 必须先创建以下计划测试，再运行上述完整 command；
文件当前不存在不代表可以跳过该行为：

- `tests/unit/workers/memory-conflict.test.ts`
- `tests/unit/workers/memory-consolidation.test.ts`
- `tests/unit/workers/memory-decay.test.ts`

**Required evidence:** proposal-to-review-to-apply-to-rollback 全链；source/revision/audit/FK；disabled/superseded immediate retrieval exclusion；duplicate retry 0 duplicate mutation。

**Rollback:** 关闭对应 maintenance apply capability 后仍可 scan；rollback 通过新 revision/supersede transition，不删除历史。

**Exit criteria:** 三类 maintenance lifecycle 全部 deterministic-ready；无 background worker 可直接修改 active record；governance docs/commands 同步。

### P6: Useful Product Tool Catalog

**Outcome:** 在已验证的 tool substrate 上提供一组有清晰用户故事的本地优先工具，而不是仅有内部 memory tools 或无策略地开放 shell/network。

**Implementation scope:**

- 先审计当前实际注册并暴露给 Pi 的工具，区分 implemented、registered、permitted、live-proved。
- 第一批目标：governed memory query/proposal、exact-group summary、read-only runtime status、受 workspace root 限制的 read/list、allowlisted bounded fetch。
- write/delete/network side effect 采用 prepared effect + explicit approval；shell、credential access、platform admin 保持独立未来决策，不因本 phase 默认开放。
- 每个工具声明 schema、capability、scope、permission、evaluator policy、timeout、output bytes、network/path policy、sensitivity、audit level 和 rollback/effect semantics。
- 提供 owner-facing enable/disable/config inspection，并让 Pi 只看到当前 actor 可执行的目录。

**Focused verification:**

```bash
pnpm vitest run tests/unit/tools tests/unit/pi/tool-adapter.test.ts tests/unit/pi/pi-adapter.test.ts tests/unit/storage/tool-call-repository.test.ts tests/integration/file-operations.test.ts
pnpm typecheck
pnpm lint
pnpm release:check
```

**Required evidence:** allowed/denied/timeout/truncation/redaction/path escape/network restriction/prepared effect/retry；tool-call/evaluator/audit/turn links；目录不暴露无 backend 或无 permission 工具。

**Rollback:** 每个新 tool 可单独 unregister/disable；prepared effects 未 commit 时可丢弃，已 commit 时使用工具定义的补偿或治理 reversal。

**Exit criteria:** 第一批 catalog 对应的用户故事和负路径全绿；至少一个 read-only 和一个 governed effect path live-proved 于 P4 或 P9；无泛化 shell 默认入口。

### P7: Behavior-Preserving Application Decomposition

**Outcome:** 降低 `src/index.ts` 的责任和变更 blast radius，同时保持所有外部行为、schema、config 和 public contracts。

**Implementation scope and order:**

1. 提取 HTTP health/readiness/metrics/event server。
2. 提取 ingress admission/recovery service。
3. 提取 turn/conversation application service。
4. 提取 background runtime composition。
5. 最后把 `LetheBotApp` 收敛为 composition root/lifecycle owner。

每一步先添加 characterization tests，只移动一个责任；禁止同时改变行为、schema、dependency、tool catalog 或 UI。依赖通过 constructor/interface 显式注入，保持 top-level imports，不引入 container framework。

**Focused verification:**

```bash
pnpm vitest run tests/unit/index.test.ts tests/unit/index-pi-runtime.test.ts tests/unit/index-summary-wiring.test.ts tests/integration/app-shutdown.test.ts tests/integration/ingress-admission-recovery.test.ts tests/integration/e2e-conversation.test.ts
pnpm typecheck
pnpm lint
pnpm release:check
```

**Required evidence:** before/after characterization parity；public imports/config unchanged；startup/shutdown/recovery/concurrent ingress/turn failure behavior unchanged；diff 按责任分组。

**Rollback:** 每次 extraction 独立 commit/slice，可按单一责任反向；不通过 compatibility shim 长期保留两条 production path。

**Exit criteria:** composition root 不包含领域 SQL 或 turn pipeline；HTTP/ingress/turn/worker 各有 narrow contract 和 focused tests；release gate 绿且无 behavior claim change。

### P8: Local Governance Experience

**Outcome:** owner/admin 能高效查看 review queue、memory provenance、context reason、model/tool/job health 和 privacy settings；所有 mutation 仍走同一 governance service。

**Implementation scope:**

- 先定义 operator tasks 和 information architecture，再选择最小依赖方案；任何新 frontend dependency 单独 review/commit。
- UI 初始只绑定 loopback，使用独立的短期 admin session/CSRF boundary；不把 QQ sender role 当 HTTP authentication。
- 必备 views：memory/review queue、record/source/revision detail、`why` trace、model invocations、tool calls、jobs/workers、privacy/retention、backup/restore status。
- destructive operations 提供 preview、明确 confirm、result/rollback link 和 audit evidence。
- 默认不显示 raw chat、credential、private platform IDs 或 unrestricted DB fields。
- CLI/QQ/UI contract tests 保证同一 actor/scope/policy 产生同一 effect。

**Focused verification:**

```bash
pnpm vitest run tests/unit/governance tests/unit/cli/governance.test.ts tests/integration/cli-main.test.ts tests/integration/governance-http.test.ts
pnpm typecheck
pnpm lint
pnpm release:check
```

`tests/integration/governance-http.test.ts` 是 P8 首个 HTTP/UI slice 的计划交付物；
先创建并证明 auth/session/scope 负路径，再运行上述完整 P8 focused command。

**Required evidence:** auth/session/CSRF、scope isolation、redaction、keyboard/focus/accessibility、empty/loading/error/conflict states、preview/confirm/rollback、CLI parity；desktop/mobile browser screenshots 只使用 synthetic data。

**Rollback:** UI server 可独立 disable；关闭 UI 不影响 CLI/QQ governance；UI 无直接 DB mutation path。

**Exit criteria:** 必备 operator workflows 完成；mutation parity 和 privacy tests 全绿；browser visual/accessibility QA 通过；release gate 绿。

### P9: Release Maturity, Long Soak, And Final Audit

**Outcome:** 当前 release 在受控真实 runtime 中经历升级、故障、回滚、restart 和长时间运行，最终 requirement matrix 可支持或否定 `TARGET_COMPLETE`。

**Implementation scope:**

- 完成 install/update/recovery artifact 和 exact migration compatibility。
- 在 disposable data 上演练 backup/restore/retention、application rollback 和 cross-version rollback。
- 运行至少 1 小时 synthetic worker/concurrency soak；在 fresh live authority 下运行 72 小时 controlled runtime soak，包含一次 planned restart 和一次 bounded provider failure/rate-limit injection。
- 定义并检查 auth failure、body rejection、queue wait、turn latency、invocation tokens/status、job age/retry、delivery、memory mutation/retrieval 和 privacy counters。
- 最后逐条审计 P0-P9 和 `GW/ING/TURN/ACT/MEM/CTX/PI/TOOL/WORK/GOV/OPS/LIVE/DOC`。

**Deterministic operations commands:**

```bash
pnpm release:check
pnpm ops:rehearse-maintenance
pnpm ops:rehearse-rollback
pnpm ops:rehearse-application-rollback
pnpm --silent ops:rehearse-cross-version -- \
  --prior-release=<PRIOR_RELEASE> \
  --candidate-release=<CANDIDATE_RELEASE>
pnpm ops:worker-soak -- --duration-ms=3600000 --interval-ms=1000
```

`<PRIOR_RELEASE>` 和 `<CANDIDATE_RELEASE>` 必须是已构建的 immutable managed releases，不得用 placeholder 执行。

**Required evidence:** the following soak acceptance conditions and the command
summaries above, tied to the exact candidate/prior release digests.

- 0 auth/privacy/cross-scope/data-integrity severity-0/1 incident；
- 0 FK violation、stuck running invocation、lost accepted ingress 或 duplicate durable effect；
- direct-trigger matrix 无未解释 loss；
- latency/queue threshold 使用 P2/P3 已声明的 config SLO，并在 checkpoint 记录数值；
- planned restart 后 admissions/jobs/invocations/memory 恢复一致；
- failure injection 后 bounded error、retry/backoff 和 recovery 可观察；
- evidence validators 通过，且未把 raw live content 写入 repo。

**Rollback:** 在 soak 前实际验证 prior release activate；候选失败时停止 ingress/new jobs，drain/cancel incompatible work，恢复 DB/release，验证 ready/integrity/FK 和核心 private canary。

**Exit criteria:** deterministic rehearsals、72h live soak、P4 matrix、rollback proof、current release gate 和 final audit 全部成立。否则保持最精确的 `DETERMINISTIC_READY`、`NEEDS_DECISION` 或 `BLOCKED_EXTERNAL`，不得写 `TARGET_COMPLETE`。

## 8. Cross-Phase Acceptance Matrix

最终审计至少覆盖：

| Requirement | Required proof |
|---|---|
| `SEC` | fail-closed ingress、bounded body、role/effect isolation、privacy-safe logs、negative tests。 |
| `GW/ING` | authorized protocol input 到 raw/admission/chat 的 idempotent、FK-clean chain；malformed/duplicate/auth failure 无 partial effect。 |
| `TURN/CTX/PI` | conversation isolation、bounded concurrency/deadline、exact context trace、provider invocation/token ledger、failure recovery。 |
| `ACT` | decision/execution/delivery truth、capability fallback、suppression/failure evidence。 |
| `MEM` | source/scope/confidence/lifecycle/revision/audit、maintenance review/apply/rollback、immediate deletion exclusion。 |
| `TOOL` | useful catalog、permission/evaluator/sandbox/audit、bounded/redacted output、effect rollback。 |
| `WORK` | fairness、leases、retries、idempotency、heartbeats、restart/soak、no interactive starvation。 |
| `GOV` | QQ/CLI/UI service parity、exact authority/scope、inspect/delete/review/why、redacted output。 |
| `OPS` | managed release、migration compatibility、backup/restore/retention、health/metrics、rollback rehearsal。 |
| `LIVE` | P4 matrix and P9 soak on the exact candidate release with validator-clean aggregate evidence。 |
| `DOC` | canonical contracts/runbooks describe observed behavior；checkpoint contains exact current gap and no stale authority conflict。 |

## 9. Target Completion Contract

`TARGET_COMPLETE` 只在以下条件同时成立时使用：

1. P0-P9 全部 `PHASE_COMPLETE`。
2. final cross-phase matrix 每个 required row 都有当前 file/test/DB/live/rollback evidence。
3. `pnpm release:check` 在无人并发编辑的最终 worktree 上通过。
4. 真实 Provider、QQ、tool、memory、restart 和 72h soak 证据对应同一 reviewed release。
5. 没有 required `UNVERIFIED`、`REPRODUCED`、`NEEDS_DECISION`、`BLOCKED_EXTERNAL` 或 user-deferred item。
6. 最终 checkpoint 仅做 evidence/status 更新，随后 `git diff --check` 通过且不再修改 product files。

缺少 live authority 时，可以准确声明 deterministic phases 已完成，并将 P4/P9 标为 `BLOCKED_EXTERNAL`；不能把它表述为 production-ready。
