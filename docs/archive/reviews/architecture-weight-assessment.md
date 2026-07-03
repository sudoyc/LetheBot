# Architecture Weight Assessment

本评估回答三个问题：

1. 当前架构设计是否过重？
2. 是否会影响 bot 的使用和对话效率？
3. 是否需要继续优化架构设计？

结论先行：

- 架构作为“边界设计”并不过重；作为“一次性全量实现 / 多服务化实现”会过重。
- 对话效率的主要风险不是组件数量，而是把 evaluator、memory extraction、tool audit、background summary 等慢路径放进每轮热路径。
- 需要优化，但优化方向不是删掉治理边界，而是定义 fast path / risk path / background path，并明确 P0 合并实现策略。

## 1. 是否架构设计过重？

### 判断

当前设计偏完整、偏长期正确，但不应该按图中每个框都拆成独立服务。

它包含很多层：

- Gateway Adapter
- Ingestion / Raw Event Store
- Identity Registry
- Attention Engine
- Context Orchestrator
- Pi Agent Runtime
- Evaluator / Policy Gate
- Action Executor
- Tool Registry / Tool Orchestrator / Sandbox
- Thick Memory Layer
- Background Workers
- Governance UI / CLI
- Response Router
- Audit Log

如果把这些都实现为独立服务、独立数据库、独立队列、独立部署，MVP 会明显过重。

但如果把它们视作“模块边界 / 数据边界 / 权限边界”，并在 P0 中合并到一个进程或少数几个模块中，设计是合理的。

### 哪些边界不能删

这些边界建议保留，即使实现上可以很轻：

1. Gateway 不直接做 memory retrieval / agent prompting。
2. Raw event 先落库或至少先持久化，方便审计和重放。
3. Context Orchestrator 负责 prompt 最小化和 visibility/sensitivity 过滤。
4. Pi 不直接写 durable memory，不直接执行高风险工具，不直接发所有动作。
5. Action Executor 统一执行发送、memory write、tool side effect，并记录 audit。
6. Memory 有 lifecycle、source、visibility、sensitivity。
7. Tool 有 capability/permission/evaluator/audit/sandbox metadata。

这些不是“工程炫技”，而是避免以后 bot 变成不可解释的一坨 handler。

### 哪些可以 P0 简化

这些可以先简化：

- Event Bus：先用进程内 dispatcher + 数据库表，不需要 Kafka/RabbitMQ。
- Background Workers：先用一个 worker loop 或 cron，不需要完整任务平台。
- Governance UI：先 CLI，不急着做 Web UI。
- Tool Registry：先用 typed config / JSON schema，不急着做复杂管理后台。
- Evaluator：只对风险 action 调用，不对每轮普通聊天调用。
- Sandbox：先限制 shell/network/credential 工具；普通 QQ send/message 工具不需要重型 sandbox。
- Audit：P0 默认 summary + selected redacted_full，不要全量 full log。

## 2. 是否会影响 bot 使用和对话效率？

会，前提是实现方式错误。

### 最危险的低效实现

以下做法会明显拖慢和打扰 bot：

1. 每条群消息都进入 Pi 推理。
2. 每次回复都再调用一次 LLM evaluator。
3. 每轮都做深度 memory search / embedding rerank / full audit trace。
4. 每条消息都尝试抽取 user memory。
5. 每个工具调用都阻塞主回复，而不是可异步化。
6. 主动 DM、admin digest、summary 都在热路径同步执行。
7. 为了审计保存完整上下文和工具输出，导致 I/O 放大和隐私压力。

这些会导致：

- 群聊里 bot 反应慢；
- 普通闲聊成本升高；
- 复杂 action 阻塞简单回复；
- 用户感觉 bot “想太多”；
- 群聊噪音增加。

### 正确的热路径

普通聊天热路径应该很短：

```text
Gateway
  -> Ingestion + raw event append
  -> Attention fast check
  -> if no action: stop / enqueue background summary
  -> if reply needed: ContextPack minimal build
  -> Pi response
  -> deterministic output/action checks
  -> Action Executor send
```

普通低风险回复不应该默认经过：

- full evaluator；
- memory extraction；
- background summarization；
- expensive tool policy path；
- governance UI；
- full audit trace。

### 建议定义五条执行路径

#### 1. Silent fast path

适用：大多数普通群消息。

```text
receive -> normalize -> raw append -> attention says no outward action -> stop
```

可选：异步 enqueue summary。

目标：不打扰群聊，不消耗模型调用。

#### 2. Reply fast path

适用：私聊、@bot、reply-to-bot、低风险直接问题。

```text
receive -> raw append -> attention -> context build -> Pi -> simple checks -> send
```

不默认跑 LLM evaluator。

#### 3. Risk path

适用：主动群发言、主动 DM、跨 scope memory、memory auto-active、危险工具、平台管理。

```text
candidate action -> deterministic pre-policy -> LLM evaluator if required -> policy gate -> executor
```

允许慢一点，因为这是高风险路径。

#### 4. Tool path

适用：工具调用。

```text
Pi proposes tool -> registry metadata -> permissions/sandbox/audit -> run -> redacted result -> Pi or async notify
```

长工具默认异步化。

#### 5. Background path

适用：总结、抽取、反思、embedding、memory decay、conflict detection。

```text
raw events/tool results -> worker -> candidates/proposals -> memory policy -> memory/governance
```

绝对不要阻塞普通回复。

## 3. 是否需要再优化架构设计？

需要，但不是推翻，而是增加“轻量实现策略”和“运行路径分层”。

### 优化 1：明确逻辑边界，不等于部署边界

建议在 architecture 文档中加一句硬规则：

> P0 中这些组件是 logical modules，不要求独立服务；默认可以在一个进程中实现，通过接口、表结构、action schema 和 policy gate 保持边界。

这可以防止后续实现被架构图误导成微服务化。

### 优化 2：加入 execution profiles

建议新增正式设计：

- `silent_fast_path`
- `reply_fast_path`
- `risk_path`
- `tool_path`
- `background_path`
- `admin_governance_path`

每条路径明确：

- 是否调用 Pi；
- 是否调用 evaluator；
- 是否允许工具；
- 是否写 memory；
- 是否同步等待；
- fallback 是什么。

### 优化 3：把 evaluator 从“每轮审查”改成“风险触发审查”

规则：

- 普通私聊/明确 @bot 低风险回复：不跑 LLM evaluator。
- 只做 deterministic checks：deleted memory、private_only、secret scanner、cooldown。
- 主动 DM、自动记忆、高风险工具、平台管理、跨 scope 使用才跑 evaluator。

### 优化 4：ContextPack 分级

建议分三级：

1. `minimal_context`
   - recent messages
   - current participant display
   - user/group short profile

2. `memory_context`
   - selected memory
   - rolling summary
   - source IDs

3. `debug_context`
   - identity details
   - audit trace
   - why info
   - owner/admin only

默认使用 `minimal_context`，避免 prompt 胀大。

### 优化 5：Memory 写入异步优先

普通对话中，memory extraction 不应该阻塞回复。

优先策略：

```text
conversation response first
  -> async memory candidate extraction
  -> low/medium policy
  -> active/proposal/admin digest
```

只有用户明确说 `/remember` 或 “记住...” 时，才可以同步给出确认。

### 优化 6：Tool system 分级实现

P0 不需要所有工具都完美 sandbox。

建议：

- Level 0: no tool / memory search only。
- Level 1: safe read-only tools。
- Level 2: network/read-local tools with audit。
- Level 3: write/shell/platform-admin tools with evaluator + sandbox。

这样不会让工具治理拖慢普通聊天。

### 优化 7：Response policy 要服务体验

群聊体验优先规则：

- 默认短回复；
- 多人正在聊天时倾向 silent/reaction；
- 长内容优先 folded forward 或私聊；
- cooldown 命中时 downgrade，不要完全丢掉原始事件；
- bot 不要因为“架构允许”就积极插话。

## 4. 建议的 P0 模块合并方式

P0 可以这样实现，不重：

```text
lethebot-service
  gateway/
    onebot adapter
  core/
    ingestion
    attention
    context_builder
    action_executor
    policy
  pi/
    runtime adapter
  memory/
    repository
    retrieval
    revisions
  tools/
    registry
    runner
  workers/
    summary_worker
    memory_candidate_worker
  cli/
    governance commands
```

数据库先用一个 Postgres 或 SQLite 原型也可以，表上保留边界：

- raw_events
- chat_messages
- canonical_users
- platform_accounts
- group_memberships
- memory_records
- memory_sources
- memory_revisions
- action_decisions
- tool_calls
- audit_log
- jobs

服务上不拆，数据和接口上拆。

## 5. 对话效率设计目标

建议把效率目标写成体验规则，而不是一开始追求复杂性能指标：

- 大多数普通群消息不调用 Pi。
- 明确 @bot / 私聊尽快回复。
- evaluator 只在风险 path 触发。
- background summary/memory extraction 不阻塞回复。
- tool 调用可以先回应“我去查/我在处理”，长任务完成后再 DM/admin digest/群里短通知。
- ContextPack 默认小，只有需要时扩展。
- Governance 和 full audit 不进入普通对话路径。

## 6. 最终判断

### 是否过重？

作为完整长期架构：不过重。

作为 MVP 全量实现：会过重。

### 是否会影响使用/对话效率？

如果每轮都走全流程，会明显影响。

如果按 fast path / risk path / background path 分层，影响可控，并且能提升群聊体验，因为大多数消息会 silent fast path，复杂动作才走审查。

### 是否需要优化？

需要。

推荐优化不是删掉安全/治理能力，而是：

1. P0 单进程/少模块实现；
2. 逻辑边界保留，部署边界延后；
3. 普通回复 fast path；
4. evaluator 只风险触发；
5. memory extraction/background summary 异步；
6. tool/sandbox 分级启用；
7. ContextPack 分级；
8. admin/governance path 不阻塞聊天。

一句话：

> 当前架构适合作为“长期边界蓝图”，但 MVP 必须实现成“轻量单体 + 快慢路径分离”，否则会显得重、慢、打扰对话。
