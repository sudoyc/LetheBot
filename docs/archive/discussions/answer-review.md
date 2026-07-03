# LetheBot 初步回答复盘与下一轮讨论提纲

来源：`docs/answer.md`

用途：这份文档不是最终设计决策，也不是实现计划。它用于把初步回答拆成三类：

1. 已经比较明确、可以进入设计 docs 的方向；
2. 需要进一步讨论的关键矛盾；
3. 下一轮应该优先问清楚的问题。

核心判断：你的回答整体倾向很明确——LetheBot 首先是一个“自然、有趣、随叫随到、具备工具能力的 QQ 群友/助手”，并且你更愿意让 agent 层承担大量判断、审核、整理工作，而不是让你频繁人工 review。但这会和隐私、治理、权限、可审计性形成张力。下一轮重点应该不是继续发散功能，而是设计“agent 可以判断，但不能越权”的中间层。

---

# 1. 已经比较明确的方向

## 1.1 产品身份

你倾向于：

- 按场景混合；
- 当前偏玩具，但保留未来产品化/转型能力；
- 交互体验要自然，最终要像一个真实群友/人类一样参与；
- 不希望它只是“记忆系统 demo”，而是要好玩、自然、有工具能力。

可以沉淀为设计原则：

> LetheBot 的核心产品形态是“有厚记忆和工具能力的自然交互型 bot runtime”。MVP 先服务 QQ 私聊/群聊玩具实验，但架构上保留向长期产品化演进的空间。

## 1.2 人格与记忆分离

你希望：

- 有人格感；
- 人格主要体现在交互语气和参与方式；
- 但人格注入不应该影响记忆判断、隐私边界和治理逻辑。

可以沉淀为设计原则：

> Persona layer 只能影响表达风格，不拥有 memory policy、retrieval policy、tool permission 或 governance 权限。

这点很重要，因为它能避免“角色扮演”污染长期记忆和安全策略。

## 1.3 私聊和群聊都需要主动能力

你不想做一个只能被动 @ 的死 bot。你明确倾向：

- 私聊可以主动；
- 群聊也可以主动；
- 但主动程度应该由 agent/审核层动态判断；
- 即使前层触发了后端，后端仍应保留“不回复”的权力。

可以沉淀为设计原则：

> Attention Engine 不输出简单的 yes/no，而输出带权重、理由、风险和 action type 的决策。Reasoning/response 层仍可拒绝发言。

## 1.4 治理界面优先级

你已经明确：

- CLI first, web later；
- 需要 owner/admin 概念；
- owner/admin 可以直接查看/编辑记忆；
- 更详细解释入口放 CLI/web；
- 群里可以让 bot 用自然语言解释，但后台要有更详细 trace。

可以沉淀为 MVP 默认：

> MVP 治理从 CLI 开始，web UI 后置。群聊中的解释是 redacted/natural language explanation；owner/admin CLI 提供完整 trace。

## 1.5 记忆基础机制

你已经倾向：

- confidence 用数值；
- importance 同时影响检索排名和保留策略；
- memory revisions 要有；
- memory conflict 进入 proposal，然后交给 agent 层处理；
- episode/summary 边界先按 worker proposal 试错；
- delete MVP 默认足够：立刻影响 retrieval，保留回滚/诊断能力。

可以沉淀为 MVP 默认：

> Memory schema 从第一版支持 numeric confidence、importance、revision history、proposal lifecycle、retrieval exclusion。冲突解决先不做复杂 UI，进入 agent-reviewed proposals。

## 1.6 技术栈与数据层

你已经接受：

- TypeScript/Node 可以是主 runtime；
- Python sidecar 可以存在；
- Gateway 边界可以接受；
- SQLite WAL 暂时没有替代理由；
- graph 延后；
- FTS first、embedding later 可以接受；
- 需要完整 job 表；
- plugin marketplace 不做，先做 tool registry。

可以沉淀为架构原则：

> MVP 应该是 TypeScript service + SQLite WAL + Drizzle/schema + job table + tool registry；Python sidecar 只处理 ML/媒体/实验任务，不拥有 durable state。

## 1.7 玩具实验

你明确早期想要：

- `/why` 解释；
- 梦境整理；
- 用户专属 interaction style；
- 自然、有工具能力、随叫随到的群友感。

你不想早期做：

- relationship graph；
- 多 agent / 多人格 orchestration；
- plugin marketplace；
- 过重的人格化记忆。

可以沉淀为早期实验：

> 早期玩具性来自自然交互、工具能力、可解释记忆、后台梦境整理，而不是复杂人格系统或社交关系图谱。

---

# 2. 最大的设计张力

## 2.1 “相信 LLM/agent 判断” vs “治理和隐私不能完全交给 LLM”

你在多个问题中倾向于：

- 交给 agent 判断；
- 交给 agent 审核；
- 不想手动 review；
- 相信 LLM 能处理很多复杂上下文。

但项目现有设计原则又要求：

- 长期记忆可审计；
- 删除立刻影响 retrieval；
- 记忆写入要有 source/confidence/lifecycle；
- Pi 不应该拥有 memory lifecycle；
- 隐私边界不能只靠 prompt。

建议的折中架构：

```text
事件/候选行为
  -> deterministic policy gate
  -> LLM/agent evaluator
  -> action proposal / response decision
  -> audit log + rollback path
  -> only allowed actions execute
```

也就是说：

- agent 可以判断；
- 但 agent 判断之前有硬策略；
- agent 判断之后也只能产出受限 action；
- 高风险动作需要降级、延后、或 owner/admin fallback；
- 所有判断必须记录理由和输入摘要。

需要下一轮重点讨论：哪些事情可以交给 agent，哪些必须由 deterministic policy gate 拦住？

## 2.2 “别让我 review” vs “长期记忆不能污染”

你明确说不想 review memory proposal，希望交给 agent 层，多层安全审计 + rollback + admin fallback。

这说明不能把“人工审核 inbox”当核心 UX。更适合的模型是：

- 默认 agent review；
- 低风险自动处理；
- 中风险进入 silent proposed/disabled；
- 高风险拒绝或只给 owner/admin digest；
- 用户只在需要时介入；
- 所有 active memory 可回滚。

需要讨论的关键是风险分级：

- 哪些 memory 可以 agent 自动 active？
- 哪些只能 proposed？
- 哪些必须 rejected/prohibited？
- 哪些需要 owner/admin digest？

## 2.3 “session 不敏感 bot” vs “私聊记忆泄漏风险”

你希望最终 bot 不要太受 session 边界限制，私聊里的整理后记忆有必要进入群聊。这个方向符合“厚记忆 bot”，但也是最敏感的设计点。

不能简单做“私聊 memory 可用于群聊”。建议拆成三层：

1. `scope`：这条记忆属于谁/哪个群/哪个会话。
2. `visibility`：这条记忆允许在哪些场景被使用。
3. `sensitivity`：这条记忆本身有多敏感。

例如：

```text
scope=user
authority=user-owned
visibility=private_only | same_user_any_context | group_allowed | public
sensitivity=normal | personal | sensitive | secret | prohibited
```

这样可以支持你的目标：

- session 不敏感；
- 但不是无边界；
- 可以通过 agent 判断和 policy filter 共同决定是否注入。

需要讨论：哪些记忆默认可跨 session？哪些必须 private_only？

## 2.4 “所有消息都可以纳入” vs “raw log 不是 memory”

你说群记忆中“从协议层能接受到的所有消息都可以考虑纳入”。这可以理解为：raw event store 应该完整接收和保存，而不是所有内容都变成 active memory。

建议明确区分：

- raw event：能接收到就按 retention policy 记录；
- derived summary：后台整理后的摘要；
- memory proposal：可能值得长期保留的候选；
- active memory：可被检索并注入的长期状态。

需要下一轮确认：你说的“纳入”是指 raw ingest 还是 active memory 候选？我的建议是：raw ingest 可以广，active memory 必须窄。

## 2.5 “所有工具都暴露给 Pi” vs “Pi 不能越权”

你在 Q9.1 说“都暴露给 Pi”。这需要重新拆解。

可以暴露给 Pi 的不应该是裸权限工具，而是 mediated tools：

- `memory.search` 可以直接暴露，但受 scope/privacy filter。
- `memory.propose` 可以暴露。
- `memory.create_active` 不应直接暴露给 Pi，最多是 owner/admin tool。
- `memory.delete` 不应直接暴露给 Pi，最多是 request/delete proposal。
- `qq.send_message` 可以暴露，但必须走 response router/attention/cooldown。
- `sandbox.run` 需要 sandbox policy 和 confirmation。

建议原则：

> Pi 可以看到很多工具，但每个工具都是带权限、scope、审计和 policy gate 的 facade，而不是直接操作数据库或平台。

## 2.6 “P0 都做”导致 MVP 膨胀

你在几个问题中回答“都是 P0”“都做出来吧”“候选都加上”。这表达了方向，但实现上需要拆成：

- schema P0；
- internal API P0；
- CLI P0；
- UI P1；
- full policy P1/P2；
- experimental P2。

例如 Q4.3 治理命令“都是 P0”：

可以拆成：

- P0 CLI：list/search/show/create/disable/delete/show-turn-context。
- P1 CLI：proposal inbox accept/reject/revisions/export。
- P1/P2 web：可视化 diff、bulk review、timeline。

否则 MVP 会太大。

## 2.7 “记录所有日志” vs “日志本身是敏感数据”

你倾向记录所有日志来保留诊断能力，这对开发非常有用，但也会让 audit/context/prompt trace 成为高敏数据。

建议：

- 开发模式：更完整日志；
- 默认运行：结构化摘要 + source IDs；
- owner/admin 可开 verbose trace；
- prompt/context trace 权限高于普通 memory；
- 支持 redaction 和 retention。

需要讨论：默认日志详细程度是什么？测试群阶段是否开 full trace？

---

# 3. 建议下一轮优先讨论的 8 个核心问题

不要继续从 Q1 到 Q16 顺着聊。建议下一轮先聊这 8 个，因为它们会决定后续架构。

## D1. Agent 审核层到底是什么？

你多次说“交给 agent 层”。需要明确：

- 是 Pi 自己判断？
- 是 LetheBot 外部单独调用 LLM 做 policy evaluator？
- 是 deterministic rules + LLM evaluator？
- 是多阶段 pipeline？
- 它的输出 schema 是什么？
- 它能执行动作，还是只能提出建议？

建议默认：

> Agent 审核层属于 LetheBot orchestrator，不属于 Pi 内核。它输出结构化 decision，不直接越权执行。

## D2. 哪些动作必须有硬策略，不允许只靠 LLM？

候选 hard policy：

- 不在群里泄漏 private_only memory；
- secret/prohibited 永不注入；
- 删除/禁用立刻影响 retrieval；
- Pi 不能直接 active/delete memory；
- 群冲突中不生成 relationship active memory；
- 工具执行必须经过 permission gate；
- raw QQ ID 不进入 prompt，除非 debugging/admin。

需要你确认 hard policy 列表。

## D3. Memory visibility/sensitivity 怎么设计？

需要决定最小字段：

- `scope`：属于谁；
- `visibility`：哪里可用；
- `sensitivity`：有多敏感；
- `authority`：谁能改/删；
- `lifecycle_state`：proposed/active/disabled/deleted 等。

这是解决跨私聊/群聊问题的核心。

## D4. MVP 中哪些 memory 可以自动 active？

你不想 review，但也不能让长期记忆污染。

可以讨论一个风险矩阵：

- low risk + explicit command：auto active；
- low risk + repeated evidence：agent reviewed active；
- medium risk：proposed/disabled；
- high risk：reject 或 owner digest；
- prohibited：不写 durable memory。

## D5. 群聊主动发言的 action model 是什么？

与其问“要不要回复”，不如定义 action types：

- `silent_store`；
- `react_only`；
- `reply_short`；
- `reply_full`；
- `send_folded_forward`；
- `dm_user`；
- `admin_digest`；
- `schedule_background_task`；
- `propose_memory`。

然后每次由 Attention Engine + agent evaluator 输出 action。

## D6. Pi tools 暴露原则是什么？

需要把“都暴露给 Pi”改成更安全的原则：

- search/propose/read-only 可以宽；
- send/execute/mutate 需要 gate；
- admin/delete/active memory 只能 request；
- dangerous tools 需要 sandbox + confirmation。

## D7. MVP P0 到底是“schema 有”还是“功能完整”？

你倾向很多东西都加，但实现上需要区分：

- P0 schema：字段/表先有；
- P0 internal：服务内部可用；
- P0 CLI：owner 可操作；
- P1 UX：用户友好操作；
- P2 automation：更智能更自动。

这是控制项目复杂度的关键。

## D8. 默认日志/retention 策略是什么？

需要决定：

- 测试阶段 full trace 是否可接受；
- 默认是否存完整 prompt；
- raw events 保留多久；
- deleted memory 的 sources 怎么处理；
- backups 是否加密；
- audit logs 谁能看。

---

# 4. 对若干未明确问题的建议默认答案

以下不是最终决策，只是下一轮讨论的建议起点。

## Q2.5 memory scope

建议：schema 从第一天支持全部 scope：

- `global`
- `user`
- `group`
- `conversation`
- `tool`
- `system`

但 MVP 实际主要使用：

- `user`
- `group`
- `conversation`
- `system`

`tool` 和 `global` 可以先作为预留/少量内部用途。

## Q3.1 memory kind

你不想类型太繁杂，这是合理的。建议 MVP 不做很多硬类型，而采用：

P0 hard kind：

- `fact`
- `preference`
- `boundary`
- `summary`
- `procedure`
- `group_norm`

其他通过 tags 表达：

- meme；
- relationship_hint；
- open_loop；
- artifact；
- ritual；
- uncertainty。

这样避免 schema 太复杂，同时保留表达力。

## Q3.7 decay/expiry

建议 MVP：

- 不自动删除 active memory；
- 每条 memory 支持 nullable `expires_at`；
- summaries 可以有默认过期或滚动窗口；
- low-confidence proposals 可以定期归档；
- stale scan P1，不阻塞 MVP。

## Q7.3 token budget

建议 MVP 先做硬 cap，而不是复杂优化：

- system/privacy/platform rules：固定上限；
- user profile：小上限；
- group profile：中上限；
- recent messages：按 token 剩余动态截断；
- retrieved memories：按 rank top-k + token cap；
- tool results：强制摘要和硬 cap；
- completion：预留固定比例。

## Q8 Pi 集成

建议默认：

- 保留 `ReasoningCore` interface；
- Pi SDK 是主实现；
- RPC fallback 可作为 P1/调研，不阻塞 MVP；
- Pi session 只作为短期 reasoning/session state；
- durable memory 永远由 LetheBot 管；
- Pi tools 只暴露 mediated facade。

## Q9.5 长期运行工具

建议分成两类：

内部 workers：

- summarizer；
- memory proposal extraction；
- embedding update；
- job cleanup。

用户可见 long-running tools：

- reminder；
- watcher；
- digest；
- project monitor。

MVP 只做内部 workers。用户可见长期工具 P1。

## Q10.1 background jobs

建议 MVP：

- group rolling summary；
- memory proposal extraction；
- job cleanup；
- private summary 先 opt-in 或后置。

## Q11.5 raw retention

建议下一轮单独定。临时建议：

- 测试期：保留完整 raw events，方便 debug；
- 正常运行默认：可配置 retention；
- deleted/disabled memory 不等于立刻删除 raw source，但必须立刻排除 retrieval；
- full purge 作为后续能力。

## Q12.6 HTTP API/server

虽然你担心 HTTP API/server 变慢，但如果 CLI 直接查 DB，后续权限和 policy 会分散。

建议折中：

- MVP service 内部有清晰 application service 层；
- CLI 可以先本地调用同一套 service code 或轻量 API；
- 不必一开始做公开 HTTP API；
- web UI 之前再固定 API surface。

---

# 5. 需要从 answer.md 转成正式 docs 的候选决策

下面这些可以在进一步确认后写入正式设计文档。

## 候选决策 A：LetheBot 的产品定位

LetheBot MVP 是偏玩具和实验的 QQ bot，但架构上按可扩展 runtime 设计。它在不同上下文中呈现不同姿态：私聊助手、群聊群友、后台档案员、治理系统进程。

可能更新：

- `docs/vision.md`
- `docs/mvp-roadmap.md`

## 候选决策 B：Persona 与 Memory Policy 分离

Persona 只影响交互风格，不影响记忆写入、隐私边界、工具权限和治理策略。

可能更新：

- `docs/context-orchestration.md`
- `docs/security-privacy.md`

## 候选决策 C：Agent-mediated but policy-gated

LetheBot 可以大量使用 LLM/agent 做判断和审核，但所有高风险操作必须经过 deterministic policy gate，并输出可审计 structured decision。

可能更新：

- `docs/architecture.md`
- `docs/memory-system.md`
- `docs/security-privacy.md`
- `docs/context-orchestration.md`

## 候选决策 D：CLI first, web later

MVP 治理界面先做 CLI，web UI 后置。owner/admin 拥有直接查看、编辑、删除、回滚和解释入口。

可能更新：

- `docs/mvp-roadmap.md`
- `docs/operations.md`

## 候选决策 E：Tool registry before plugin marketplace

MVP 做内置 tool registry 和权限/audit metadata，不做 plugin marketplace。

可能更新：

- `docs/architecture.md`
- `docs/pi-integration.md`
- `docs/security-privacy.md`

---

# 6. 下一轮建议对话方式

建议下一轮不要再一次性回答 50 个问题，而是按主题小批量推进。

推荐第一轮只讨论：

1. Agent 审核层是什么；
2. 哪些 hard policy 不能交给 LLM；
3. memory scope / visibility / sensitivity；
4. 哪些记忆可自动 active；
5. Pi tools 如何 mediated exposure。

如果这五个问题定下来，后续数据模型、ContextPack、tool registry、attention engine 都会清晰很多。

---

# 7. 给下一轮对话的短提示

可以直接用下面这段开启下一轮：

```text
我们基于 docs/answer.md 和 docs/answer-review.md 继续讨论 LetheBot。请优先帮我设计 agent-mediated but policy-gated 的架构：

1. agent 审核层到底是什么；
2. 哪些 hard policy 不能交给 LLM；
3. memory scope / visibility / sensitivity 怎么设计；
4. 哪些 memory 可以自动 active，哪些只能 proposal/reject；
5. Pi tools 怎么 mediated exposure，避免 Pi 越权。

先不要写实现代码，先做设计收敛。
```
