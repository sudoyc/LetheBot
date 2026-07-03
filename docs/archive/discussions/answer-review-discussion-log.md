# LetheBot answer-review 逐题讨论记录

来源文档：

- `docs/answer.md`
- `docs/answer-review.md`
- `docs/discussion-boundaries-and-questions.md`

用途：

这份文档用于记录我们针对 `docs/answer-review.md` 中关键问题的逐项讨论结果。它不是最终架构文档，也不是实现计划。只有当某个问题被你确认“已经明晰”后，才把它记录为阶段性决策；之后再决定是否同步到正式 docs。

---

# 讨论流程

1. 每次只讨论一个问题或一个边界。
2. 我先给出问题拆解、风险、候选模型和建议默认值。
3. 你可以直接接受、反驳、补充、或要求继续展开某个分支。
4. 当你说“这个明晰了 / 记录这个 / 下一个问题”时，我把结论写入本文档的对应条目。
5. 未确认的内容只写为“待确认假设”，不作为最终设计决策。

---

# 记录格式

每个问题按这个结构记录：

```md
## Dx. 问题标题

状态：讨论中 / 阶段性明确 / 延后 / 需要调研

问题背景：

讨论要点：

阶段性结论：

硬边界 / hard policy：

MVP 默认：

长期方向：

需要同步到正式文档：

后续问题：
```

---

# 待讨论队列

优先按 `docs/answer-review.md` 的 D1-D8 推进：

1. D1. Agent 审核层到底是什么？
2. D2. 哪些动作必须有硬策略，不允许只靠 LLM？
3. D3. Memory visibility / sensitivity 怎么设计？
4. D4. MVP 中哪些 memory 可以自动 active？
5. D5. 群聊主动发言的 action model 是什么？
6. D6. Pi tools 暴露原则是什么？
7. D7. MVP P0 到底是“schema 有”还是“功能完整”？
8. D8. 默认日志 / retention 策略是什么？

补充队列，之后再讨论：

- Pi session 与 QQ conversation/thread 的映射。
- ContextPack 是否需要可 replay。
- 群聊 thread detection 的 MVP 边界。
- 主动 DM 的边界。
- nickname history 是 metadata 还是 memory。
- reaction-only / 合并转发 / 长回复折叠的协议能力调研。

---

# D1. Agent 审核层到底是什么？

状态：阶段性明确；高风险直通开关留到 D2/D6 继续细化

## 问题背景

你多次倾向“交给 agent 判断 / 交给 agent 审核 / 不要让我人工 review”。这和 LetheBot 的隐私、记忆治理、权限审计之间有张力。

如果 agent 审核层只是 Pi 自己在 prompt 里判断，会有几个问题：

- Pi 同时是回答者和审核者，容易自我授权；
- prompt 规则无法可靠阻止越权工具调用；
- 记忆写入、删除、跨 scope 注入这类操作需要可审计的结构化决策；
- 之后排查“为什么记住/为什么发言/为什么用了某条记忆”会缺少稳定证据。

所以 D1 要决定的是：所谓“agent 层”到底是系统里的哪个边界、输出什么、能不能执行动作。

## 本轮用户确认

你确认了以下方向：

1. 可以接受 agent 审核层不是 Pi 自己，而是 LetheBot orchestrator 里的独立 evaluator。
2. 甚至可以考虑引入另一个独立 Pi，或其他独立模型/agent，用作审计 evaluator。
3. 可以接受“agent 可以判断，但不能直接执行高风险动作”的默认边界。
4. 但由于 bot 会从始至终运行在 Docker 里，需要保留一个配置开关，允许 bot 在某些部署/实验模式下直接执行高风险操作。
5. MVP 中 evaluator 和 Pi 使用同一个底层模型 API 是可以接受的；关键区别不在模型来源，而在调用阶段、prompt、输入裁剪、输出 schema 和执行权限。
6. 第一版 evaluator 覆盖范围基本接受：群聊是否回复、跨 scope memory 注入、memory proposal 是否自动 active、危险工具调用、主动 DM、admin digest 等都可以纳入。
7. 你更偏向多一层 evaluator，而不是为了低延迟省掉它。理由是这样聊天更可控、更有趣，也方便后续优化审核策略。

## 待确认假设

我建议先把 agent 审核层定义成 LetheBot orchestrator 内部的一个“结构化评估器”，而不是 Pi 内核本身。

它可以调用 LLM，也可以使用规则，但它不直接执行高风险动作，只输出 structured decision，由 policy gate / action executor 决定是否执行。

## 候选模型

### 模型 A：Pi 自审

流程：

```text
ContextPack -> Pi -> Pi 自己决定回答、用工具、提记忆、是否发言
```

优点：

- 最简单；
- 交互自然；
- 工具调用链短。

缺点：

- 容易越权；
- 不适合长期记忆治理；
- 很难区分“回答推理”和“安全审核”；
- 不利于 debug 和回滚。

我不建议作为 LetheBot 的主架构，只能作为低风险玩具原型。

### 模型 B：规则 gate + Pi 回答

流程：

```text
事件 -> deterministic policy gate -> ContextPack -> Pi -> response/router
```

优点：

- 简单、可控；
- 明确阻止一部分硬风险；
- MVP 容易做。

缺点：

- 对复杂社交语境判断不足；
- 不能满足你想要的“agent 自动审核/整理”；
- 很多灰区只能保守处理。

适合作为 MVP 的底座，但不够完整。

### 模型 C：规则 gate + 独立 LLM evaluator + Pi 回答

流程：

```text
事件 / 候选动作
  -> deterministic pre-policy gate
  -> LLM evaluator 输出结构化 decision
  -> deterministic post-policy gate
  -> allowed action executor
  -> Pi response / tool / memory proposal / silence
```

优点：

- agent 可以判断复杂上下文；
- 规则仍然掌握硬边界；
- evaluator 输出结构化结果，方便审计；
- Pi 不直接拥有 memory lifecycle；
- 更符合“agent-mediated but policy-gated”。

缺点：

- 架构复杂一点；
- 每次 turn 可能多一次模型调用；
- evaluator 和 Pi 可能判断不一致，需要合并策略。

这是我当前建议的主线。

### 模型 D：多阶段 agent committee

流程：

```text
extractor agent -> risk reviewer agent -> policy evaluator agent -> Pi responder
```

优点：

- 审核更细；
- 适合长期产品化或高风险操作。

缺点：

- MVP 过重；
- latency 高；
- debug 成本高；
- 可能变成“agent 为了审核 agent 而无限膨胀”。

不建议进入 MVP，只作为未来可扩展方向。

## D1 阶段性结论

> Agent 审核层属于 LetheBot Orchestrator，不属于主回答 Pi 内核。它是一个 policy-gated LLM evaluator：可以读取经过脱敏/裁剪的事件、候选记忆、候选工具调用或候选回复动作，输出结构化 decision；默认不能直接执行高风险动作。所有执行都必须经过 deterministic policy gate 和 action executor。Pi 负责最终 reasoning/表达/tool-call proposal，但 durable memory lifecycle、跨 scope 记忆注入、危险工具权限、删除/禁用、群聊主动发言最终执行权属于 LetheBot。

补充结论：

- evaluator 可以是另一个独立 Pi、另一个模型、或同一模型 API 的不同调用阶段。
- MVP 不强求模型物理隔离；先保证逻辑隔离：独立 prompt、独立输入裁剪、独立结构化输出、独立审计记录、独立执行 gate。
- 后续如果需要更强审计，可以把 evaluator 替换成独立模型、独立 Pi session、甚至多 evaluator pipeline，而不改变主架构。
- 默认模式下，高风险动作必须经 policy gate；但系统需要保留显式配置开关，用于 Docker 沙盒/实验部署中允许 bot 直接执行高风险操作。
- 这个直通开关不能是隐式 prompt 行为，必须是配置项，并且应进入审计日志。具体开关粒度留到 D2/D6 讨论。

## 建议输出 schema 草案

```ts
interface AgentReviewDecision {
  decisionId: string;
  subjectType:
    | "attention"
    | "memory_proposal"
    | "memory_promotion"
    | "memory_retrieval"
    | "tool_call"
    | "response_send"
    | "privacy_boundary";
  action:
    | "allow"
    | "deny"
    | "downgrade"
    | "defer"
    | "propose_only"
    | "ask_owner"
    | "silence";
  riskLevel: "low" | "medium" | "high" | "prohibited";
  confidence: number;
  reasons: string[];
  requiredPolicies: string[];
  redactions: string[];
  auditSummary: string;
}
```

这个 schema 只是讨论起点，不是最终 TypeScript 接口。

## 本轮已明确

- D1 采用模型 C 作为主线：规则 gate + LLM evaluator + Pi 回答/执行提案。
- evaluator 是 LetheBot orchestrator 的一部分，不是主回答 Pi 的自审 prompt。
- evaluator 和 Pi 可以先使用同一个大模型 API；工程上按不同角色、不同 prompt、不同输入/输出契约隔离。
- 多一层 evaluator 是可接受的，优先级高于减少一次模型调用。
- 第一版 evaluator 的覆盖范围可以较广，至少包括：群聊发言、跨 scope memory 注入、memory promotion、危险工具、主动 DM、admin digest。

## 留到 D2/D6 继续讨论

- “高风险直通开关”的粒度：全局开关、按 tool 开关、按群/用户开关、按部署模式开关，还是组合。
- 哪些 hard policy 即使在 Docker 中也不允许绕过。
- 哪些动作可以在 `unsafe_docker_experiment_mode` 之类配置下直通。
- evaluator 的失败模式：失败时默认 deny、defer、还是让主 Pi 继续。
- 是否需要两个级别：`review_required` 和 `confirmation_required`。

---

# D2. 哪些动作必须有硬策略，不允许只靠 LLM？

状态：阶段性明确；已修正：风险开关只控制是否绕过 LLM evaluator，不控制功能启用/禁用

## 问题背景

D1 已经确定 LetheBot 会引入 evaluator，但 evaluator 仍然是 LLM/agent 判断。D2 要定义的是：哪些边界不能只靠 LLM 自觉遵守，而必须由 deterministic policy gate、权限系统、配置项或 action executor 强制执行。

这里的关键不是“完全不相信 LLM”，而是区分：

- 哪些事情可以让 LLM 判断；
- 哪些事情 LLM 只能建议，不能执行；
- 哪些事情 owner 可以在 Docker/实验模式中显式放开；
- 哪些事情即使放开高风险工具，也必须保留最小不变量。

## 本轮用户确认

你确认了以下方向：

1. 可以接受存在 hard policy，但希望这些策略可以由 owner 配置。
2. “永不绕过”的核心范围应该相对小，不要把系统限制得太死。
3. 对初步列出的最小 hard policy 基本接受：secret/prohibited 不进 prompt、deleted/disabled memory 不注入、private_only memory 不在群里公开引用、raw QQ ID / account ID 作为受控 identity metadata 使用、Pi/evaluator 不绕过 service 层直接改 DB、高风险执行需要 audit log。
4. 你说的“允许 bot 直接执行高风险操作”主要指工具执行类，而不是默认让所有记忆/社交行为都直通。
5. 可以设置多组开关，而不是一个总开关；初步分为：工具执行、记忆行为、群聊/社交行为。
6. `tools` / `memory` / `social` 三组开关暂时够用，不需要额外的 `logging` / `privacy` / `admin` / `identity` 组。
7. 修正：这里不应该引入“关闭功能”的开关。功能启用/禁用会导致能力缺失，不属于 D2 风险开关。D2 的开关只控制某类能力是否必须经过 LLM evaluator 审计，或是否允许 owner 配置为绕过 evaluator。
8. Docker 实验模式下，工具执行可以默认更开放，例如允许网络、文件写入、长任务、sandbox.run 不逐次确认。
9. memory 风险矩阵可以接受：low risk + 明确来源可自动 active；medium risk 只 proposal；high risk reject 或 admin digest；prohibited 不写 durable memory。
10. social 中主动群聊和主动 DM 应该分开开关。
11. 暂时不需要 `deploymentMode` 总模式；直接配置各组 risk toggles 即可。

## D2 当前建议模型

把策略分成三层：

### L0：最小安全不变量

这些不是“LLM 是否同意”的问题，而是系统层不变量。它们可以通过 owner 配置调节细节，但不应该被 Pi/evaluator 在单次 turn 中自行绕过。

候选 L0：

1. `secret/prohibited` 内容默认不进入普通 prompt。
2. `deleted` / `disabled` memory 不能被 retrieval 注入。
3. `private_only` memory 默认不得在群聊公开引用。
4. raw QQ ID / account ID 不是普通 memory；它是受控 identity metadata。可以在身份消歧、用户明确需要、平台操作或当前对话确有必要时进入 prompt，但应 purpose-bound、最小化、结构化，不应作为普通 memory 自由注入。
5. Pi/evaluator/tool 不能绕过 LetheBot service/policy 层直接改 durable DB。
6. 高风险执行必须留下 audit log。

注意：这里的“不可绕过”指不能由 LLM 临场绕过；owner 可以通过配置改变某些默认策略，但这种改变本身必须显式、可审计、可回滚。

### L1：默认 gate，可由 owner 配置直通

这些是你希望 Docker/实验部署中可以放开的部分。默认应经过 evaluator + policy gate；但 owner 可以按模块或 scope 打开更激进行为。

注意：这里的开关不是“是否允许这个功能存在”。D2 不引入关闭功能的开关。

每类能力都默认仍然存在；配置只决定它是否必须经过 LLM evaluator：

- `required`：必须经过 evaluator；
- `bypass`：owner 允许该类能力绕过 evaluator，直接进入 deterministic policy / action executor。

也就是说，绕过 evaluator 不等于关闭 audit log，也不等于允许绕过 L0 不变量。

建议拆成三组开关：

#### L1-tools：工具执行开关

用于控制代码执行、网络、文件、长期任务等。

候选配置：

```yaml
evaluatorPolicy:
  tools:
    sandboxRun:
      evaluator: "required" # required | bypass
    networkTools:
      evaluator: "bypass"
    filesystemWrite:
      evaluator: "bypass"
    longRunningTasks:
      evaluator: "bypass"
    requireAuditLog: true
```

解释：这是你最明确想保留直通能力的部分。因为 bot 整体运行在 Docker 中，可以在个人实验环境里提高工具自主性。

#### L1-memory：记忆行为开关

用于控制自动 active、跨 scope 注入、自动修改/合并 memory。

候选配置：

```yaml
evaluatorPolicy:
  memory:
    autoActiveLowRisk:
      evaluator: "required"
    autoActiveMediumRisk:
      evaluator: "required"
    crossScopeInjection:
      evaluator: "required"
    autoEditOrSupersede:
      evaluator: "required"
    requireSourceMetadata: true
```

解释：记忆行为比工具执行更容易污染长期状态，所以默认应该比 tools 保守。可以允许低风险自动 active，但 medium/high 风险默认 proposal。

#### L1-social：群聊/社交行为开关

用于控制主动群聊、主动 DM、敏感解释、长回复等。

候选配置：

```yaml
evaluatorPolicy:
  social:
    proactiveGroupReply:
      evaluator: "required"
    proactiveDM:
      evaluator: "required"
    privateMemoryMentionInGroup:
      evaluator: "required"
    sensitiveTopicReply:
      evaluator: "required"
    requireCooldown: true
```

解释：社交行为的风险不是容器能完全隔离的，主要是冒犯、泄漏、打扰、破坏群氛围。因此默认应比工具直通更保守。

### L2：LLM/evaluator 可自由判断的软策略

这些可以主要交给 evaluator 和 Pi：

- 回复语气；
- 是否简短；
- 是否 reaction-only；
- 是否生成 admin digest；
- 是否把某段内容作为 low-risk proposal；
- 本轮回答的组织方式；
- 工具结果如何解释给用户。

## D2 阶段性倾向

> LetheBot 应该有一个很小的 L0 hard policy 核心，防止 LLM 临场越权；但大部分高风险能力通过 owner-configurable evaluator policy 管理。开关不要只有一个全局 unsafe mode，而应至少拆成 `tools`、`memory`、`social` 三组。每个开关只表达“是否需要 evaluator 审计 / 是否允许绕过 evaluator”，不表达“功能是否启用”。工具执行类可以在 Docker 实验环境中更激进；记忆和社交类默认更保守，因为它们的风险主要是长期状态污染和人际/隐私影响，不能完全靠 Docker 隔离。

## D2 阶段性结论

1. L0 最小 hard policy 先保留 6 条：
   - `secret/prohibited` 内容默认不进入普通 prompt；
   - `deleted` / `disabled` memory 不能被 retrieval 注入；
   - `private_only` memory 默认不得在群聊公开引用；
   - raw QQ ID / account ID 不作为普通 memory；进入 prompt 需 purpose-bound、最小化、结构化；
   - Pi/evaluator/tool 不能绕过 LetheBot service/policy 层直接改 durable DB；
   - 高风险执行必须留下 audit log。
2. evaluator policy 分三组：`tools`、`memory`、`social`。
3. D2 不引入关闭功能的开关；功能启用/禁用不属于这里的风险开关。
4. 每个开关只控制是否需要 LLM evaluator 审计。
5. `evaluator: bypass` 表示绕过 LLM evaluator，不表示绕过 L0 hard policy、权限记录或 audit log。
6. Docker 实验环境中，`tools` 组可以默认更开放，即更多工具类动作允许绕过 evaluator。
7. `memory` 组采用风险矩阵默认值：low risk 可自动 active；medium risk proposal；high risk reject/admin digest；prohibited 不写 durable memory。
8. `social` 组里主动群聊和主动 DM 分开控制 evaluator policy。
9. 暂时不引入 `deploymentMode` 总模式，避免配置层过早复杂化。

## 留到后续继续讨论

- D3：memory visibility / sensitivity 字段如何定义。
- D4：low / medium / high / prohibited 的 memory 风险分类细则。
- D5：social 开关和群聊 action model 如何配合。
- D6：tool registry metadata 中如何表达 evaluator policy、permissions、audit level 和 sandbox policy。

---

# D3. Memory visibility / sensitivity 怎么设计？

状态：逐条讨论中；D3.1 已确认

## 问题背景

D3 要解决的是 memory 的边界问题：一条记忆属于谁、能在哪些上下文使用、能不能公开说出来、内容有多敏感、谁能改删、它来自哪里。

这个问题会影响：

- 私聊记忆能不能用于群聊；
- 群聊发言能不能进入个人画像；
- memory 自动 active 的风险判断；
- ContextPack 检索和注入策略；
- `/why` 解释时能展示到什么程度；
- 删除/禁用和跨 scope 使用权限。

## D3.1 是否要把 memory 边界拆成多个字段，而不是只靠 scope？

状态：已确认

### 讨论结论

接受拆分为五个概念：

1. `scope`：这条 memory 属于谁/哪个空间。
2. `visibility`：这条 memory 可以在哪些上下文被使用或注入。
3. `sensitivity`：内容本身有多敏感。
4. `authority`：谁有权改、删、批准跨 scope 使用。
5. `source_context`：这条 memory 来自哪里。

### 理由

只靠 `scope` 不够表达实际边界。

例如两条 memory 都可能是 `scope=user`：

- “用户喜欢简洁回答”：可以安全影响群聊中 bot 对该用户的回答长度，但不一定需要公开解释来源。
- “用户私聊说自己在做某个私人项目”：默认不应该进入群聊 ContextPack，也不应该在群里被公开引用。

两者同属 user memory，但 visibility 和 sensitivity 完全不同。

### 初步落地方式

先按完整概念设计，但实现可以分层：

- `scope`、`visibility`、`sensitivity` 是 memory record 的核心字段。
- `authority` 可以先通过 owner fields、role、permissions 表达，不一定一开始做复杂 ACL。
- `source_context` 可以从 `memory_sources` / `source_event` 推导，但概念上必须存在，用于 evaluator 和 policy gate 判断跨上下文使用风险。

### 后续继续讨论

- D3.2：`scope` 的枚举和值域。
- D3.3：`visibility` 的枚举和值域。
- D3.4：`sensitivity` 的枚举和值域。
- D3.5：`authority` 的最小权限模型。
- D3.6：`source_context` 如何从来源事件推导。

## D3.2 scope 的枚举和值域

状态：已确认

### 讨论结论

schema 从第一天保留全部 6 个 scope：

1. `user`
2. `group`
3. `conversation`
4. `system`
5. `tool`
6. `global`

MVP 实际主要使用：

- `user`
- `group`
- `conversation`
- `system`

`tool` 和 `global` 先作为 schema 预留或少量内部用途，不作为早期主要记忆归属。

### 各 scope 含义

#### `user`

归属某个用户。

典型内容：

- 用户偏好；
- 用户边界；
- 用户项目背景；
- 用户纠正过 bot 的方式；
- 用户专属 interaction style。

#### `group`

归属某个群。

典型内容：

- 群规则；
- 群常见话题；
- 群 rolling summary；
- 群里的长期项目/资源；
- 群级工具使用偏好。

#### `conversation`

归属某个具体会话或短期讨论上下文。

典型内容：

- 某个私聊线程的短期上下文；
- 某个群中某段讨论的临时 summary；
- 尚未确定是否值得提升为 `user` / `group` memory 的上下文。

#### `system`

归属 LetheBot 系统本身。

典型内容：

- bot 行为配置；
- owner 设置；
- prompt / policy version；
- 系统级 correction；
- 全局安全和治理策略。

#### `tool`

归属某个工具或工具使用流程。

典型内容：

- 某个工具调用习惯；
- 工具失败模式；
- 工具输出处理规则；
- 可沉淀为 procedural memory 的工具经验。

MVP 可以先少用，等 tool registry 稳定后再扩大。

#### `global`

跨全部上下文适用。

使用原则：

- MVP 尽量少用；
- 只用于非常明确、非隐私、跨所有上下文都适用的事实或规则；
- 不要把普通用户偏好、群规则、工具习惯偷懒写成 `global`。

### 理由

从第一天保留完整 scope 枚举，可以避免后续补 scope 时迁移 schema、检索逻辑、权限逻辑和 ContextPack 逻辑。

但 MVP 只重点使用 `user` / `group` / `conversation` / `system`，可以避免过早复杂化。

### 后续约束

- `scope` 只表达归属，不表达可见性。
- 是否能跨私聊/群聊使用，由 D3.3 的 `visibility` 决定。
- 是否敏感，由 D3.4 的 `sensitivity` 决定。
- 谁能改删，由 D3.5 的 `authority` 决定。

## D3.3 visibility 的枚举和值域

状态：阶段性明确；保持简单，不添加 `same_conversation_only` / `group_allowed`

### 讨论结论

`visibility` 不要设计得太复杂。P0 先保留少量值，用来表达 memory 可以在哪些上下文被使用、注入或公开引用。

P0 visibility：

1. `private_only`
2. `same_user_any_context`
3. `same_group_only`
4. `owner_admin_only`
5. `public`

不加入：

- `same_conversation_only`
- `group_allowed`

### 各 visibility 含义

#### `private_only`

只能在私聊、owner/admin 私有上下文、或明确私有的 ContextPack 中使用。

典型内容：

- 用户私聊透露的私人项目；
- 用户个人状态；
- 私密偏好；
- 默认私聊记忆。

默认行为：

- 不进入群聊普通 prompt；
- 不在群里公开引用；
- 可以在 owner/admin CLI 中查看，前提是权限满足。

#### `same_user_any_context`

同一个用户参与的上下文中都可以影响 bot 行为，但不等于可以公开引用来源或内容。

典型内容：

- 用户喜欢简洁回答；
- 用户希望 bot 不要 cue 自己；
- 用户偏好的语言、技术深度、输出格式；
- 用户对 bot 互动方式的边界。

默认行为：

- 可以影响群聊中 bot 对该用户的回复方式；
- 不应在群里说“因为你私聊告诉我……”。

#### `same_group_only`

只能在所属群内使用。

典型内容：

- 群规则；
- 群 rolling summary；
- 群内资源；
- 群内长期话题；
- 群级工具使用偏好。

默认行为：

- 可以进入该群的 ContextPack；
- 不应自动进入其他群或私聊，除非后续有明确导出/引用机制。

#### `owner_admin_only`

只给 bot owner/admin 治理、debug、审计使用，不进入普通 Pi prompt。

典型内容：

- 高风险 proposal；
- prompt/context trace；
- 安全告警；
- 工具执行敏感摘要；
- evaluator 的高风险判断理由。

#### `public`

跨上下文可用，且公开引用低风险。

典型内容：

- 公开项目事实；
- 明确公开的 bot 行为规则；
- 非敏感工具说明；
- owner 明确标记可公开的公共知识。

### 不加入的值

#### 不加入 `same_conversation_only`

原因：

- 和 `scope=conversation` 有重叠；
- P0 会增加 evaluator 和检索逻辑复杂度；
- 临时会话上下文可以先通过 `scope=conversation` + 生命周期/过期策略表达。

#### 不加入 `group_allowed`

原因：

- 容易和 `same_user_any_context` / `same_group_only` 混淆；
- 具体“允许哪些群”可以以后用 allowlist 或 policy 扩展，而不是 P0 visibility 枚举。

### 后续约束

- `visibility` 表达可用边界，不表达归属；归属仍由 `scope` 表达。
- `visibility` 不等于敏感等级；敏感等级由 D3.4 的 `sensitivity` 表达。
- 同一条 memory 即使 visibility 允许影响行为，也不一定允许在当前上下文公开解释来源。

## D3.4 sensitivity 的枚举和值域

状态：已确认

### 讨论结论

P0 sensitivity 保留 5 档：

1. `normal`
2. `personal`
3. `sensitive`
4. `secret`
5. `prohibited`

保留 `secret`，不把它简单合并进 `prohibited`。理由是：secret 类内容可能需要被工具或 secret manager 使用，但不能作为普通 memory content 保存或注入；prohibited 则是明确不允许作为 durable memory 保留内容本身。

### 各 sensitivity 含义

#### `normal`

普通低风险内容。

典型内容：

- 用户喜欢简洁回答；
- 群规则；
- 公开项目技术偏好；
- 常见话题 summary；
- 非敏感工具说明。

默认行为：

- 可进入普通检索和 ContextPack；
- 仍受 `visibility` 限制；
- 可以作为 low-risk auto-active 候选。

#### `personal`

个人相关但不高度敏感。

典型内容：

- 用户项目背景；
- 用户常用工具；
- 用户沟通偏好；
- 用户在群里的普通长期兴趣；
- 用户专属 interaction style。

默认行为：

- 可以进入 ContextPack，但需要更严格的 visibility 检查；
- 群聊公开引用要谨慎；
- 可作为 auto-active 候选，但应优先要求明确来源或重复证据。

#### `sensitive`

敏感个人、群体、关系、安全相关内容。

典型内容：

- 财务、健康、亲密关系、政治倾向；
- 群冲突相关总结；
- 个人身份关联；
- 工具输出中的私有路径/文件摘要；
- 未证实的负面评价。

默认行为：

- 不自动 active；
- 不进普通群聊 prompt；
- 默认只进入 proposal / owner_admin_only / private_only；
- 需要 evaluator 或 admin digest。

#### `secret`

秘密、凭证、安全材料。

典型内容：

- API key；
- token；
- cookie；
- password；
- 私钥；
- 账号恢复码；
- 真实账号绑定细节。

默认行为：

- 不进入普通 prompt；
- 不作为 durable memory content 保存；
- 最多保存 redacted audit summary 或 source tombstone；
- 如果工具需要使用，应走 secret manager / tool credential store，而不是 memory system。

#### `prohibited`

明确不允许作为 memory 保留的内容。

典型内容：

- 原始聊天全文；
- 第三方私聊内容；
- 明显违法/危险请求的可执行细节；
- 未证实的人身指控；
- 群冲突里对人际关系的定性判断；
- 用户要求删除或不要记录的内容。

默认行为：

- 不写 durable memory；
- 已存在则删除/禁用并排除 retrieval；
- 只允许最小 audit / tombstone，如果必要；
- evaluator 只能输出 reject / redact / admin_digest，不应输出 active memory。

### 后续约束

- `sensitivity` 只表达内容风险，不表达可见范围；可见范围由 `visibility` 控制。
- `secret` 和 `prohibited` 都不能进入普通 prompt，但处理方式不同：secret 应转交 credential/secret 管理，prohibited 应拒绝保留内容本身。
- D4 会继续细化哪些内容属于 low / medium / high / prohibited 的 memory 风险分类。

## D3.5 authority 的最小权限模型

状态：已确认

### 讨论结论

接受最小 authority 模型，但 P0 实现不做复杂 ACL。

authority 用来回答：谁有权查看、改、删、批准这条 memory 的使用边界。

P0 角色概念：

1. `bot_owner`
2. `memory_subject`
3. `group_owner_or_admin`
4. `system`
5. `tool`

### 角色含义

#### `bot_owner`

最高治理权限。

可以：

- 查看所有 memory / proposals / audit trace；
- 编辑、删除、禁用、回滚；
- 批准高风险跨 scope 行为；
- 修改 evaluator policy。

#### `memory_subject`

这条 memory 直接涉及的人。

可以：

- 查看关于自己的 user memory；
- 要求删除/禁用关于自己的 memory；
- 设置自己的 visibility 偏好；
- 拒绝群聊发言进入个人画像。

P0 可以先不实现完整用户自助界面，但 schema 必须能表达 subject。

#### `group_owner_or_admin`

群管理者。

可以：

- 管理 group-scoped memory；
- 设置群规则；
- 删除/禁用群 summary；
- 管理群内 bot 行为策略。

不能：

- 查看某个用户的 `private_only` user memory；
- 覆盖 `memory_subject` 的个人隐私边界。

#### `system`

系统自动创建或维护的 authority。

用于：

- policy version；
- worker generated summary；
- system memory；
- internal operational metadata。

#### `tool`

工具相关 authority。

用于：

- 工具运行偏好；
- 工具失败模式；
- 工具输出摘要；
- procedural memory proposal。

限制：

- 工具不拥有最终删除、跨 scope 使用或 active 权限；
- 工具只能 propose，是否 active 仍走 policy / evaluator / owner 规则。

### P0 schema 建议

memory record 至少保留：

- `owner_user_id?`
- `owner_group_id?`
- `authority_roles`
- `subject_user_ids`
- `created_by_actor`
- `last_modified_by_actor`

### P0 权限规则

- `bot_owner` 可治理全部。
- `memory_subject` 可删除/禁用涉及自己的 memory。
- `group_owner_or_admin` 可治理 `scope=group` 的 memory。
- `tool` / `system` 只能自动创建 proposal 或维护内部记录，不能绕过 policy active/delete。
- 多人相关 memory 默认不允许某一方单方面 active 成敏感事实，应进入 proposal / admin digest。

### 实现取舍

接受完整 authority 概念，但实现可以分阶段：

- MVP CLI 先只给 `bot_owner`。
- schema 先保留 `subject_user_ids` / `owner_user_id` / `owner_group_id`。
- 普通用户自助治理后置，但不要让 schema 设计阻断这个方向。

## D3.6 source_context 如何从来源事件推导

状态：已确认

### 讨论结论

接受 P0 保留 6 个 source context：

1. `private_chat`
2. `group_chat`
3. `admin_cli`
4. `tool_result`
5. `background_worker`
6. `imported_document`

但需要注意：`background_worker` 更准确地说是 extraction actor / processing actor，而不一定是原始来源。实现上应允许同时记录：

- 原始来源 context，例如 `group_chat` / `private_chat`；
- 抽取者，例如 `background_worker`；
- source event 链接。

也就是说，不要让后台 worker 抹掉原始来源。

### 建议数据关系

`memory_records` 保存当前 memory 的归属、可见性、敏感度、生命周期等：

- `id`
- `scope`
- `visibility`
- `sensitivity`
- `lifecycle_state`
- `confidence`
- `importance`

`memory_sources` 保存来源链：

- `memory_id`
- `source_event_id`
- `source_context`
- `source_actor_id`
- `source_conversation_id`
- `source_group_id?`
- `source_user_id?`
- `extracted_by?`
- `captured_at`

### 各 source_context 含义

#### `private_chat`

来自用户私聊。

默认：

- 倾向 `private_only` / `same_user_any_context`；
- 不自动进入 group prompt；
- 跨群聊公开引用要非常谨慎。

#### `group_chat`

来自群聊。

默认：

- 倾向 `same_group_only`；
- 可以用于 group summary；
- 进入个人画像需要更谨慎。

#### `admin_cli`

来自 bot owner/admin 显式写入。

默认：

- authority 高；
- 可以直接 active；
- 但仍要显式设置 visibility / sensitivity。

#### `tool_result`

来自工具输出。

默认：

- 需要按 tool metadata 判断敏感性；
- 本地路径、文件内容、账号信息要谨慎；
- procedural memory 可以 propose；
- 不应默认把原始工具输出长期保存为 memory content。

#### `background_worker`

来自后台总结、抽取、合并、反思等处理流程。

默认：

- 不直接说明“事实”，而是 proposal；
- source 应链回原始 events；
- confidence 根据证据计算；
- 作为 `extracted_by` / `processing_actor` 使用时，应同时保留原始 `source_context`。

#### `imported_document`

来自导入文档、配置或知识库。

默认：

- 按导入时设置的 scope / visibility / sensitivity 使用；
- 可能适合 `public` / `system` / `group`；
- 不能默认全局可见。

### P0 使用规则

- 私聊来源默认不公开进群。
- 群聊来源默认不升级成个人画像 active，除非 low risk + repeated evidence / explicit。
- admin_cli 来源可以直接 active，但必须显式 visibility / sensitivity。
- tool_result 来源默认不要把原始内容长期保存，先摘要或提案。
- background_worker 来源默认 proposal，并链回原始 events。
- imported_document 来源看导入时的 scope / visibility 设置。

### D3 小结

D3 当前阶段已经确认完整的 memory boundary 五元组：

- `scope`
- `visibility`
- `sensitivity`
- `authority`
- `source_context`

其中：

- `scope` 表达归属；
- `visibility` 表达可用/注入边界；
- `sensitivity` 表达内容风险；
- `authority` 表达治理权限；
- `source_context` 表达来源和跨上下文风险。

---

# D4. MVP 中哪些 memory 可以自动 active？

状态：讨论中；D4.1 已确认采用 agent-mediated auto active

## 问题背景

D4 要决定 memory lifecycle 中 `proposed -> active` 的默认策略。

用户倾向“不想人工 review，交给 agent 层诊断判断”。因此 D4 不应设计成纯 deterministic rule，也不应设计成所有后台抽取都只能 proposal。

但长期 memory 一旦污染，会持续影响 ContextPack、回答风格、群聊行为和用户画像。Docker 沙盒不能隔离长期状态污染和社交/隐私风险。

所以 D4 的核心原则是：

> 允许 agent evaluator 判断哪些 memory 可以自动 active，但 evaluator 必须受 L0 hard filter、结构化输出、policy/action executor 和 audit/rollback 约束。

## D4.1 自动 active 的决策权属于谁？

状态：已确认

### 讨论结论

采用 agent-mediated auto active：

```text
memory candidate
  -> L0 hard filter
  -> agent evaluator / risk classifier
  -> structured decision
  -> policy/action executor
  -> memory_records + sources + revisions + audit log
```

也就是说：

- agent evaluator 可以判断候选 memory 是否值得 active；
- 但 agent 不能绕过 hard policy 直接写 DB；
- 真正落库由 policy/action executor 执行；
- 所有自动 active 都必须可审计、可回滚。

### L0 hard filter

这些内容不进入 agent 自由裁量，不能自动 active。evaluator 最多输出 reject / redact / admin_digest：

- `sensitivity=secret`；
- `sensitivity=prohibited`；
- deleted / disabled source；
- 没有 source metadata；
- 明显第三方私聊内容；
- 原始聊天全文；
- 未证实的人身指控；
- 群冲突里对人际关系的定性判断；
- 用户明确说不要记录 / 忘掉。

### agent evaluator 负责判断的问题

evaluator 可以根据上下文判断：

- 这是不是长期稳定偏好；
- 是不是玩笑、反讽、临时情绪；
- 是否只是一次性事件；
- 是否有重复证据；
- source_context 是否足够可信；
- visibility 应该是什么；
- sensitivity 应该是什么；
- 是否需要降级为 proposal；
- 是否只进入 owner_admin digest。

### structured decision 动作

候选 action：

- `active`
- `proposal`
- `reject`
- `admin_digest`
- `ask_owner`
- `ask_subject`
- `redact`

### D4.1 风险分级默认

采用折中方案 C：

- low risk：agent evaluator 可自动 active。
- medium risk：agent evaluator 可自动 active，但必须 visibility 保守，例如 `private_only` / `owner_admin_only` / `same_group_only`；不能 `public`，不能跨私聊到群公开引用。
- high risk：默认 proposal / admin digest。
- secret / prohibited：reject / redact，不 active。

### 自动 active 的最低落库条件

即使 evaluator 输出 `active`，executor 仍需检查：

- 未命中 L0 hard filter；
- `scope` / `visibility` / `sensitivity` / `authority` / `source_context` 已填写或可推导；
- source metadata 完整；
- confidence 达到当前策略阈值；
- lifecycle transition 可审计；
- 可 rollback。

### 关键边界

同意“让 agent 判断是否 active”。

不同意“agent 可以绕过 hard policy 直接 active”。

LetheBot 的设计目标不是让 LLM 自由写记忆，而是让 LLM 参与记忆治理。

### 后续继续讨论

- D4.2：low / medium / high risk 如何具体分类。
- D4.3：explicit remember / correction / repeated evidence / admin_cli 的默认 active 策略。
- D4.4：群聊来源进入 user memory 的限制。
- D4.5：自动 active 后如何回滚、supersede 和解释。

## D4.2 low / medium / high risk 如何具体分类

状态：阶段性明确；后续可按实际运行数据调整

### 讨论结论

接受当前 low / medium / high / secret-prohibited 的分类框架，作为 MVP 默认策略。后续可以根据真实群聊和私聊运行数据调整。

补充原则：

- `owner_admin_only` 可以保存 high risk 的摘要、告警或 digest；
- 但这不等于把高风险事实 active 成普通可检索 memory；
- 高风险内容默认不进入普通 ContextPack。

### Low risk

可以由 evaluator 自动 active。

典型内容：

- 用户明确偏好：简洁 / 详细 / 语言 / 格式；
- 用户纠正 bot 的交互方式；
- 群 admin 明确设置的群规则；
- 非敏感公开项目事实；
- 工具 / 流程的低风险经验总结；
- 用户明确 `/remember` 的非敏感事实。

条件：

- source metadata 完整；
- visibility 合理；
- sensitivity 为 `normal` 或低风险 `personal`；
- 不涉及第三方隐私或关系判断。

### Medium risk

evaluator 可 active，但 visibility 必须保守。

典型内容：

- 用户项目背景，但不是公开项目；
- 用户长期兴趣或技术栈，但来源是群聊推断；
- 群内某个长期话题 summary；
- tool_result 的摘要，可能含私有路径或账号线索；
- 用户的个人习惯，但不是明确说“记住”；
- 多次重复出现的偏好，但没有显式确认。

默认：

- 可以 active，但通常应使用 `private_only` / `same_group_only` / `owner_admin_only`；
- 不设为 `public`；
- 不公开解释来源；
- 不跨私聊到群公开引用。

### High risk

不自动 active，只进入 proposal / admin digest。

典型内容：

- 健康、财务、亲密关系、政治倾向；
- 个人身份绑定；
- 群冲突总结；
- 对某人的负面评价；
- 多人关系判断；
- 可能影响人际关系的结论；
- 从群聊推断出的私人画像；
- 单次情绪性表达。

默认：

- proposal / admin_digest；
- sensitivity 通常为 `sensitive`；
- 不进入普通群聊 prompt；
- 需要后续确认、更强证据或 owner/admin 处理。

### Secret / prohibited

不 active。

典型内容：

- API key / token / cookie / password / 私钥；
- 原始聊天全文；
- 第三方私聊内容；
- 用户明确不要记录；
- 未证实指控；
- 群冲突里定性“谁和谁关系不好”。

默认：

- reject / redact；
- 不写普通 durable memory；
- 如果需要审计，只保留最小 redacted audit / tombstone。

### 调整机制

此分类不是永久固定规则。MVP 运行后应根据：

- 实际误记忆案例；
- 用户纠正；
- 群聊冒犯/泄漏风险；
- retrieval 污染情况；
- owner/admin 审计反馈；

持续调整 evaluator prompt、risk classifier 和 policy defaults。

## D4.3 explicit remember / correction / repeated evidence / admin_cli 的默认 active 策略

状态：阶段性明确；先按当前默认策略推进，后续可调整

### 讨论结论

接受 7 类常见触发来源的默认 active 策略。

总原则：

- explicit remember、correction、admin_cli 的权重更高；
- background_worker、tool_result、repeated evidence 需要 evaluator 判断；
- 所有路径都不能绕过 secret / prohibited、source metadata、visibility / sensitivity 和 audit/rollback 要求；
- explicit remember 可以更强，但不能强到绕过 L0 hard filter。

### 1. explicit remember

用户明确表达记忆意图，例如：

- “记住我喜欢简洁回答”；
- “以后你要这样”；
- `/remember ...`。

默认策略：

- low risk：evaluator 可 auto active；
- medium risk：evaluator 可 active，但 visibility 必须保守；
- high risk：proposal / admin digest；
- secret / prohibited：reject / redact。

### 2. correction

用户纠正 bot，例如：

- “别这样叫我”；
- “以后不要在群里 cue 我”；
- “你刚才理解错了，我其实是……”

默认策略：

- 行为/偏好 correction 优先级高；
- low / medium 可以 auto active；
- 如果涉及隐私或群聊边界，visibility 保守；
- 如果是用户要求忘记 / 不要记录，应直接影响 retrieval / policy，而不是普通 proposal。

### 3. repeated evidence

多次出现但没有显式说“记住”，例如：

- 用户经常要求短回答；
- 用户经常用某工具；
- 群里反复出现某个规则或习惯。

默认策略：

- low risk 可由 evaluator auto active；
- medium risk 可 active 但 visibility 保守；
- high risk 不 auto active；
- 需要记录 source_count / time_span / evidence summary。

### 4. admin_cli

owner/admin 显式写入。

默认策略：

- 可以直接 active；
- 但必须显式设置 visibility / sensitivity；
- 如果没设置，由系统提示补全或 evaluator 建议默认值。

### 5. group admin rule

群 admin 设置群规则。

默认策略：

- low / normal group rule 可 active；
- `scope=group`；
- `visibility=same_group_only`；
- `authority=group_owner_or_admin + bot_owner`。

### 6. background_worker extraction

后台 worker 总结或抽取。

默认策略：

- 默认走 evaluator；
- low risk 可 auto active；
- medium risk 可 active 但 visibility 保守；
- high risk proposal / admin digest；
- 必须链回原始 sources。

### 7. tool_result

工具结果产生的记忆候选。

默认策略：

- 不保存原始敏感输出；
- low risk procedural memory 可 auto active；
- medium risk 只保存摘要，visibility 保守；
- high risk owner_admin_only digest；
- secret 交给 secret manager，不进 memory。

### 后续调整点

这些默认策略先用于 MVP。后续如果真实运行中出现过多误记忆、漏记忆或污染 retrieval，再调整：

- explicit remember 的强度；
- background_worker 是否更保守；
- tool_result 是否默认 proposal；
- repeated evidence 的 source_count / time_span 阈值。

## D4.4 群聊来源进入 user memory 的限制

状态：已确认

### 讨论结论

群聊来源可以进入 user memory，但默认必须更谨慎。

核心原则：

- group_chat -> user memory 需要 explicit 或 repeated evidence。
- 单次 group_chat 普通发言不能 active 成 user memory。
- 第三方评价不能 active 成被评价者的 user memory。
- 群冲突 / 关系判断不能 active 成 user memory。
- 如果 active，source_context 必须保留 `group_chat`，不能伪装成 `private_chat`。
- visibility 默认不设为 `public`。

### 情况 1：用户在群聊中明确对 bot 说“记住”

例子：

- “@bot 记住我喜欢短回答”；
- “以后别在群里 cue 我”；
- “这个项目是我的，之后你可以记一下”。

默认策略：

- 可以按 explicit remember 处理；
- `scope=user`；
- `source_context=group_chat`；
- visibility 由 evaluator 决定，通常为 `same_user_any_context` 或 `private_only`；
- 如果会影响群聊行为，不等于可以公开引用来源。

### 情况 2：用户普通群聊发言被系统推断成偏好/画像

例子：

- 某人经常问 Rust；
- 某人经常要短回答；
- 某人经常在群里提某项目。

默认策略：

- low risk + repeated evidence：可以 agent-mediated auto active；
- medium risk：可以 active，但 visibility 必须保守；
- high risk：proposal / admin digest；
- 单次普通发言不应 active 成 user memory。

### 情况 3：群聊中其他人评价某个用户

例子：

- “A 就是喜欢拖延”；
- “B 和 C 关系不好”；
- “D 最近肯定不舒服”。

默认策略：

- 不自动 active 成被评价者的 user memory；
- 多数进入 high risk / prohibited；
- 只能作为 group event / summary 的谨慎摘要，且不能定性人；
- 不能作为用户画像事实。

### 理由

群聊里的表现不一定代表用户稳定偏好；群聊中的第三方评价更不能直接成为被评价者画像。LetheBot 可以学习群聊语境，但不能把群聊噪声、玩笑、冲突或他人评价变成长期用户事实。

## D4.5 自动 active 后如何回滚、supersede 和解释

状态：已确认

### 讨论结论

接受自动 active 后必须具备 rollback / supersede / explanation 能力。

理由：既然 LetheBot 会减少人工 review、更多依赖 agent-mediated auto active，就必须增强事后治理能力，避免误记忆长期污染 ContextPack。

### 1. revision / rollback

所有 auto active 都必须写 `memory_revisions`。

记录内容包括：

- previous_state；
- new_state；
- evaluator_decision_id；
- reason；
- source ids；
- created_by_actor，例如 evaluator / action_executor；
- timestamp。

要求：

- owner/admin 可以回滚；
- memory_subject 未来应能删除/禁用涉及自己的 memory；
- rollback 后必须立刻影响 retrieval。

### 2. supersede，不静默覆盖

如果新记忆和旧记忆冲突，例如：

- 用户以前喜欢详细回答，现在喜欢简洁；
- 群规则变了；
- 工具流程更新了。

默认策略：

- 不直接静默覆盖旧 content；
- 新建 revision 或新 memory；
- 旧 memory 标记 `superseded`；
- context retrieval 只取 active/current；
- 保留冲突理由和来源。

### 3. explanation / why

自动 active 的 memory 必须能解释：

- 为什么 active；
- 来源是什么；
- evaluator 判断理由是什么；
- confidence 是多少；
- visibility / sensitivity 为什么这样设；
- 后来有没有被 supersede。

解释边界：

- 群聊里不能完整解释敏感来源；
- 普通 `/why` 只显示 redacted explanation；
- owner/admin CLI 显示完整 trace。

### D4.5 默认规则

- 所有 auto active 必须有 revision。
- 所有 auto active 必须可 disable / delete。
- 所有 auto active 必须有 evaluator decision / audit summary。
- 冲突默认 supersede，不静默覆盖。
- high / medium risk 的 auto active 需要更详细 reason。
- `/why` 面向普通上下文只显示 redacted explanation；owner/admin CLI 显示完整 trace。

### D4 小结

D4 当前阶段确认：

- 自动 active 采用 agent-mediated 模型；
- medium risk 可以自动 active，但 visibility 必须保守；
- low / medium / high / secret-prohibited 风险分类先作为 MVP 默认；
- explicit remember、correction、admin_cli 权重更高；
- group_chat 进入 user memory 要求 explicit 或 repeated evidence；
- 自动 active 必须有 revision / rollback / supersede / explanation。

---

# D5. 群聊主动发言的 action model 是什么？

状态：讨论中；D5.1 已确认 action model

## 问题背景

D5 要解决群聊参与策略：LetheBot 不应该只输出“要不要回复”的 boolean，而应该输出结构化 action。这样才能表达：沉默、稍后总结、reaction、短回复、工具回复、私聊、admin digest、后台任务等不同参与方式。

用户前置倾向：

- 群聊和私聊都应该有主动能力；
- 不希望只有 hard trigger，更希望动态权重判断；
- 即使前层触发后端，后端也应保留“不回复”的权力；
- 需要 reaction-only；
- 主动 DM 可以有，但必须受控；
- 长回复需要考虑 QQ/NapCat 的折叠或合并转发。

## D5.1 action 类型

状态：已确认

### 讨论结论

接受结构化 action model，并按 P0/P1/协议调研分层。

P0 action：

1. `silent_store`
2. `silent_summarize_later`
3. `reply_short`
4. `reply_full`
5. `reply_with_tool`
6. `propose_memory`
7. `admin_digest`
8. `schedule_background_task`
9. `dm_user`

协议支持后启用，但 schema 先保留：

10. `react_only`
11. `send_folded_forward`

P1 / 视体验再增强：

12. `ask_clarification`

### 各 action 含义

#### `silent_store`

不回复，只记录 raw event / recent context。

用于普通群聊消息、无需响应的上下文积累。

#### `silent_summarize_later`

不回复，但进入后台 summary / memory proposal 队列。

用于有长期价值但不适合当场打断群聊的内容。

#### `reply_short`

短回复。

用于群聊高频场景、轻量回答、确认、低打扰回应。

#### `reply_full`

完整回复。

用于私聊、明确提问、低频技术讨论或 owner/admin 询问。

#### `reply_with_tool`

调用工具后回复。

必须走 tool policy、audit log 和必要的 evaluator policy。

#### `propose_memory`

不一定回复，但触发 memory proposal / auto active decision。

可与其他 action 并存，例如 `reply_short + propose_memory`。

#### `admin_digest`

不打扰群聊，只给 owner/admin 摘要或告警。

用于高风险 proposal、工具异常、隐私边界问题、后台整理结果。

#### `schedule_background_task`

安排后台任务，例如总结、watcher、提醒、长工具任务。

作为 P0 保留，因为 memory/summary worker 本来就需要任务调度。

#### `dm_user`

从群聊事件触发私聊某个用户。

放入 P0，但必须：

- evaluator required；
- cooldown；
- 不带敏感原文；
- 不显得像监控或越界；
- 可配置策略。

#### `react_only`

只发表情/点赞/轻量 reaction，不文字回复。

schema 先保留，实际能力需要调研 NapCat / OneBot 支持。

#### `send_folded_forward`

长回复折叠或合并转发。

schema 先保留，实际能力需要调研 NapCat / OneBot 支持。

#### `ask_clarification`

请求澄清。

私聊更常用；群聊中谨慎使用，避免打断或显得过度参与。先作为 P1 / 体验优化项。

### 组合 action

action 不一定互斥。常见组合：

- `silent_store + silent_summarize_later`
- `reply_short + propose_memory`
- `reply_with_tool + send_folded_forward`
- `silent_summarize_later + admin_digest`
- `reply_short + schedule_background_task`

### 后续继续讨论

- D5.2：action 输出 schema。
- D5.3：群聊触发权重和 suppressor。
- D5.4：主动 DM 的边界。
- D5.5：cooldown / anti-spam。
- D5.6：NapCat / OneBot 对 reaction 和合并转发的支持调研。

## D5.2 action 输出 schema

状态：已确认；P0 采用简化版 schema

### 讨论结论

P0 不采用过细的完整 schema，先采用简化版结构化输出。重点是明确字段语义，避免 Attention/Evaluator 只输出“要不要回复”的 boolean。

### P0 schema 草案

```ts
interface ActionDecision {
  actions: ActionPlan[];
  riskLevel: "low" | "medium" | "high" | "prohibited";
  confidence: number;
  reasons: string[];
  suppressors: string[];
}

interface ActionPlan {
  type: ActionType;
  target: ActionTarget;
  priority: number;
  reason: string;
  constraints: {
    evaluatorRequired?: boolean;
    cooldownKey?: string;
    maxResponseTokens?: number;
    redactionLevel?: "none" | "light" | "strict";
  };
}
```

### 必须保留的字段语义

#### `actions[]`

action 可以组合，不是单选。

例如：

- `silent_store + silent_summarize_later`
- `reply_short + propose_memory`
- `reply_with_tool + send_folded_forward`

#### `riskLevel`

用于决定：

- action 是否可执行；
- 是否需要 admin digest；
- 是否需要更严格 redaction；
- 是否允许进入普通群聊回复。

#### `confidence`

用于后续调参和审计。

#### `reasons[]`

给 owner/admin trace，用来解释为什么选择这些 action。

#### `suppressors[]`

记录为什么没说话、为什么降级、为什么选择 silent / digest。

典型 suppressor：

- 高速闲聊；
- 情绪冲突；
- bot 刚刚说过话；
- 多个真人正在回答；
- 引用目标不确定；
- 敏感话题；
- 工具结果不适合公开。

#### `target`

action 目标。

候选 target：

- group；
- user；
- owner_admin；
- internal。

#### `constraints`

执行约束，例如：

- 是否必须经过 evaluator；
- cooldown key；
- 最大回复 token；
- redaction level。

### P0 取舍

暂不采用完整细 schema 中的 `toolNames`、`memoryCandidateIds`、`backgroundJobType` 等专用字段。需要时可以放入后续扩展或 action-specific payload。

重点是：P0 先保证 action decision 可审计、可组合、可降级、可解释。

## D5.3 群聊触发权重和 suppressor

状态：已确认

### 讨论结论

接受 “trigger score + suppressor + action” 的模型。

群聊中不存在“一定回复”的 trigger。即使 @bot、reply-to-bot、命令触发，也可以被 suppressor 降级为 silent / admin_digest / dm_user / short reply。

流程：

```text
message/event
  -> trigger signals 加分
  -> suppressors 降级或阻止
  -> evaluator 输出 action
  -> executor 执行或沉默
```

### 强触发信号

强触发不是强制回复，只是权重很高。

P0 强触发：

- `@bot`
- reply-to-bot
- 命令前缀
- owner/admin 指令

### 暂不作为 P0 强触发

#### bot 名字 / 昵称

先作为 soft trigger 或可配置项。

原因：

- 群聊误触发可能多；
- 可能有人只是讨论 bot，而不是要 bot 回答；
- 后续可以通过群配置或 evaluator 调整。

#### 工具结果完成

不强制发回原上下文。

默认：

- 产生高权重 action；
- evaluator 决定 reply / dm_user / admin_digest / silent；
- 如果结果敏感或不适合公开，优先 dm_user 或 admin_digest。

### 软触发信号

候选 soft trigger：

- 有直接问题且 bot 很可能有帮助；
- 群里有人问“谁记得……”；
- 群里讨论 bot 能力；
- 话题命中 watcher / 订阅；
- 低流量时段问题无人回答；
- bot 最近参与过同一 thread；
- 有可用群记忆能补上下文；
- 有正在进行的任务 / 提醒相关。

### suppressors

suppressor 可以把任何触发降级为更低打扰 action。

候选 suppressor：

- 高速闲聊；
- 情绪冲突；
- 敏感个人话题；
- bot 刚说过话；
- 多个真人正在回答；
- 引用目标不确定；
- 玩梗线程，解释会杀梗；
- 消息明显不是给 bot 的；
- 会泄漏 `private_only` memory；
- 回复需要引用高风险 memory；
- 回复太长但不能折叠；
- 当前群 / 用户 cooldown 命中。

### P0 默认

- `@bot` / reply-to-bot / 命令前缀 / owner-admin 指令是高权重触发，不是强制回复。
- bot 名字/昵称先不做 P0 强触发。
- 工具结果完成不强制发群，只生成高权重 action。
- suppressor 可以把任何触发降级到 silent / admin_digest / dm_user / reply_short。
- 不存在“一定回复”的群聊 trigger。

### 理由

如果目标是“像人一样自然参与群聊”，LetheBot 不能机械地被 @ 就回复。群聊里可能存在冲突、玩梗、敏感话题或多人正在回答；这些情况下，即使被触发，也应该允许 bot 沉默、降级、私聊或只做后台处理。

## D5.4 主动 DM 的边界

状态：已确认

### 讨论结论

DM 不需要做成独立子系统，但必须在 action / policy / audit 层作为特殊 action 单独建模。

也就是说：

- 不需要单独的 DM Service；
- 不需要单独一套权限系统；
- 不需要单独一套记忆模型；
- 不需要复杂新工作流；
- 但 `dm_user` 不能只是普通 reply 的一个参数。

### 架构边界

DM 复用现有：

- auth / identity；
- ResponseRouter；
- Gateway Adapter；
- evaluator policy；
- audit log；
- cooldown system。

但 action / policy 层必须知道“这是 DM”。

建议表达：

```text
ActionDecision
  -> action.type = dm_user
  -> target = { kind: "user", userId }
  -> constraints.dm = {
       triggerKind,
       proactive,
       cooldownKey,
       redactionLevel,
       allowReason,
       optOutRespected
     }
  -> ResponseRouter.sendPrivateMessage(...)
```

### 需要单独记录的 DM 字段

DM action 至少要能表达：

- 是否 proactive；
- 触发来源：`user_requested` / `tool_result` / `memory_review` / `safety_or_privacy` / `reminder`；
- 是否尊重用户 opt-out；
- redaction level；
- cooldown key；
- audit reason。

### P0 默认

#### 用户请求型 DM

例子：

- “私聊我”；
- “结果发我”；
- “这个别发群里”；
- “提醒我一下”。

默认：允许。

#### 工具结果型 DM

工具结果不适合公开，或任务完成后只跟触发者相关。

默认：允许，但需要 redaction / evaluator / audit。

#### bot 主动关怀/提示型 DM

bot 从群聊观察到可能该私聊：

- 敏感话题；
- memory review 需要确认；
- 私人 reminder；
- 群里有人 cue 但公开回答不合适。

默认：允许，但更严格 cooldown / evaluator / audit。

#### 第三方评价或群冲突触发的 DM

默认：禁止或 admin_digest，不直接 DM 被评价者。

原因：这类行为最容易显得像监控、挑拨或越界。

### 硬边界

- 不因为第三方评价主动 DM 被评价者。
- 不因为群冲突主动 DM 某人做心理判断。
- 不发送群聊敏感原文。
- 不暴露 `private_only` memory。
- 同一用户需要主动 DM cooldown。
- 用户可以设置“以后不要主动私聊我”。
- 主动 DM 必须记录 audit。
- 主动 DM 默认 evaluator required。

### 理由

主动 DM 和群聊公开回复可以复用同一个发送通道，但社交风险不同。群聊回复是公开行为；主动 DM 是跨上下文、私密、可能让人觉得被监控的行为。因此 DM 不需要独立系统，但必须在 action/policy/audit 中作为特殊 action 被识别和解释。

## D5.5 cooldown / anti-spam

状态：已确认；采用 budget + suppressor 模型

### 讨论结论

cooldown 不设计成简单的“X 秒内不能回复”，而是采用 budget + suppressor：

```text
action candidate
  -> check cooldown / budget
  -> if exceeded: downgrade action
  -> record suppressor
```

也就是说，cooldown 命中时优先降级 action，而不是直接丢弃事件或让 bot 失忆。

### 降级示例

- `reply_full` -> `reply_short`
- `reply_short` -> `react_only` / `silent_store`
- `dm_user` -> `admin_digest` / `silent_store`
- `reply_with_tool` -> `schedule_background_task` / `dm_user` / `admin_digest`
- `propose_memory` 不一定受普通 reply cooldown 影响

### P0 cooldown 维度

概念上保留 6 个维度：

1. `per_group`
2. `per_user`
3. `per_thread`
4. `per_action_type`
5. `global_bot`
6. `proactive_only`

实现上可以先落地：

- `per_group`
- `per_user`
- `per_action_type`
- `proactive_dm`

其余维度作为 schema / policy 预留。

### 各 action 的默认 budget 行为

- `silent_store` 不受 cooldown。
- `silent_summarize_later` 基本不受普通群聊 cooldown，但受后台任务 budget。
- `propose_memory` 不受回复 cooldown，但受 memory extraction budget。
- `reply_short` 轻度消耗 group budget。
- `reply_full` 重度消耗 group budget。
- `reply_with_tool` 重度消耗 group + tool budget。
- `dm_user` 使用独立 proactive DM cooldown。
- `react_only` 轻度消耗或使用单独 reaction cooldown。
- `admin_digest` 不受群 cooldown，但受 owner/admin digest 频率限制。

### 关键边界

- 没有“一定发出去”的 action；cooldown 可以降级所有 action。
- owner/admin 指令可以有更高优先级，但不等于绕过 audit。
- cooldown 命中必须写进 `suppressors[]`，方便 `/why` 和调参。
- cooldown 不应该阻止 raw event / source / memory candidate 记录，只影响外显动作。
- proactive DM 的 cooldown 要比群聊公开回复更严格。

### 理由

LetheBot 的群聊体验目标是自然参与，而不是机械地抢答或刷屏。budget + suppressor 能保留后台理解和记忆能力，同时控制外显打扰程度。

## D5.6 NapCat / OneBot 对 reaction 和合并转发的支持

状态：已确认；采用 capability-gated 设计，并倾向 P0 实现 NapCat 能力 + fallback

### 调研结论

reaction-only 和 folded forward 都应该进入 schema/action model，但执行层不能假设所有 OneBot / NapCat 部署都支持。

Reasoning / evaluator 只输出 action；Gateway / executor 根据 runtime capability 决定实际发送方式。

### 1. `react_only` 的两种含义

#### A. 发送 QQ 表情消息

OneBot v11 标准消息段支持 `face`：

- `type=face`
- `data.id=...`

这本质上是“发一条表情消息”，不是对某条消息做 reaction。

#### B. 对某条消息设置表情回应 / 表情点赞

NapCat 上游存在扩展 action：

- `SetMsgEmojiLike`
- payload: `message_id`, `emoji_id`, `set`

这更接近真正的 reaction，但属于 NapCat 扩展能力，不是 OneBot v11 标准能力。需要 runtime probe 验证当前 NapCat 版本、目标消息和返回行为。

### `react_only` fallback 顺序

`react_only` action 使用 capability-gated delivery：

1. preferred: `emoji_like`
   - 使用 NapCat `set_msg_emoji_like` / `SetMsgEmojiLike`；
   - 需要 source `message_id`；
   - 失败后 fallback。
2. fallback: `face_message`
   - 发送 QQ 表情消息；
   - 会产生一条新消息，打扰程度比真正 reaction 高；
   - 应消耗更高 cooldown。
3. final fallback: `silent_store`
   - 如果 reaction 能力不可用、目标消息不支持或 cooldown 命中，就沉默记录。

### 2. `send_folded_forward` / 合并转发

OneBot v11 消息段中：

- `forward` 是接收合并转发；
- `node` 是发送合并转发节点；
- 自定义 `node` 支持 `user_id` / `nickname` / `content`。

NapCat 上游存在 go-cqhttp 兼容 action：

- `GoCQHTTP_SendForwardMsg`
- `GoCQHTTP_SendPrivateForwardMsg`
- `GoCQHTTP_SendGroupForwardMsg`

NapCat `SendMsg` 还有一个重要约束：

- 转发消息不能和普通消息混在一起发送；
- 如果 message 中包含 `node`，则 message 必须全部是 `node`。

### `send_folded_forward` fallback 顺序

`send_folded_forward` action 使用 capability-gated delivery：

1. preferred: group/private forward nodes；
2. fallback 1: “短摘要 + 私聊/后台详情”；
3. fallback 2: 分段短消息，但受 cooldown 严格限制；
4. fallback 3: admin_digest 或 silent，避免刷屏。

### Gateway capability profile

Gateway Adapter 应暴露 capability profile，例如：

```ts
interface GatewayCapabilities {
  reaction: {
    emojiLike: boolean;
    faceMessage: boolean;
  };
  foldedForward: {
    groupForward: boolean;
    privateForward: boolean;
    customNode: boolean;
  };
}
```

能力可以在 Gateway 启动时或首次使用时 probe。

### D5.6 默认策略

- `react_only` 进入 schema / action model。
- `react_only` 默认首选 NapCat emoji-like；不可用则降级为 face message 或 silent。
- face message 不完全等同 reaction，消耗更高 cooldown。
- `send_folded_forward` 进入 schema / action model。
- 长回复超过阈值时，优先折叠 / 合并转发。
- 合并转发不可用时，不直接刷屏，优先摘要、DM、admin_digest 或后台任务。
- Gateway 启动时或首次使用时做 capability probe。
- 所有协议能力都不能成为 reasoning 层假设；reasoning 只输出 action，executor 根据 gateway capability 落地。

### D5 小结

D5 当前阶段确认：

- 群聊参与输出结构化 action，而不是 boolean；
- action 可以组合；
- P0 包含 silent、reply、tool、memory、admin digest、background task、dm_user；
- reaction-only 和 folded forward 进入 schema，但执行 capability-gated；
- trigger 是加权信号，不存在一定回复；
- suppressor 可以降级任何 action；
- DM 不做独立子系统，但作为 action / policy / audit 特殊 action；
- cooldown 采用 budget + suppressor，不直接丢弃事件；
- Gateway 能力不能成为 reasoning 层硬假设。

---

# D6. Tool registry metadata 如何表达 evaluator policy / permissions / audit / sandbox？

状态：讨论中；D6.1 已确认 metadata 拆分方向

## 问题背景

D6 要解决工具注册表如何描述工具能力、权限、审计、沙盒和 evaluator policy。

这和 D2 的修正有关：不要把“功能是否启用/关闭”和“是否需要 LLM evaluator 审计”混在一起。工具是否安装、注册、可用是 tool installation / config 问题；D6 讨论的是已注册工具在执行前后的治理元数据。

## D6.1 工具元数据是否需要同时表达“能力”和“审计策略”？

状态：已确认

### 讨论结论

tool registry metadata 不应该只有 `enabled` / `risk` 这种粗字段，而应该拆开表达：

1. `capabilities`
2. `permissions`
3. `evaluatorPolicy`
4. `auditLevel`
5. `sandboxPolicy`
6. `outputSensitivity`

其中 `evaluatorPolicy` 只控制是否需要 evaluator 审计，不表达工具是否启用/禁用。

### 1. capabilities

工具能做什么。

候选能力：

- `read_only`
- `write_file`
- `network`
- `shell_exec`
- `long_running`
- `sends_message`
- `modifies_memory`
- `external_side_effect`

### 2. permissions

谁或什么上下文可以用。

候选权限：

- `owner_only`
- `admin_only`
- `user_allowed`
- `group_allowed`
- `internal_only`

### 3. evaluatorPolicy

是否需要 LLM evaluator 审计。

候选值：

- `required`
- `bypass`

注意：

- `bypass` 只表示绕过 LLM evaluator；
- 不表示绕过 L0 hard policy；
- 不表示绕过权限；
- 不表示关闭 audit；
- 不表示工具功能是否启用。

### 4. auditLevel

执行后留下多少审计。

候选值：

- `none`
- `summary`
- `full`
- `redacted_full`

### 5. sandboxPolicy

工具如何隔离执行。

候选值：

- `none`
- `local_readonly`
- `local_workspace_write`
- `docker`
- `network_restricted`
- `network_allowed`

### 6. outputSensitivity

工具输出默认敏感度。

候选值：

- `normal`
- `personal`
- `sensitive`
- `secret_possible`

### P0 实现取舍

概念上接受 6 类 metadata。

P0 实现可以先强制：

- `capabilities`
- `evaluatorPolicy`
- `auditLevel`
- `sandboxPolicy`

`permissions` / `outputSensitivity` 可先使用默认值，但 schema 方向不要阻断它们。

### 边界

功能是否安装、注册、可用属于 tool installation / config 层，不在 D6 的 evaluator policy 里表达。D6 只定义已注册工具如何被治理和审计。

### 后续继续讨论

- D6.2：capabilities 的最小枚举。
- D6.3：permissions 是否需要 allowlist。
- D6.4：evaluatorPolicy 的默认值。
- D6.5：auditLevel 如何避免记录 secrets。
- D6.6：sandboxPolicy 如何和 Docker/本地 workspace 配合。

## D6.2 capabilities 的最小枚举

状态：已确认

### 讨论结论

P0 capabilities 保留 11 个，用来表达工具本质上能造成什么影响。

1. `read_context`
2. `read_local`
3. `write_local`
4. `network`
5. `shell_exec`
6. `long_running`
7. `sends_message`
8. `modifies_memory`
9. `external_side_effect`
10. `credential_access`
11. `platform_admin`

一个工具可以同时拥有多个 capability。

### 各 capability 含义

#### `read_context`

读取 LetheBot 内部上下文、memory、raw logs、audit trace。

主要风险：隐私泄漏、越权读取记忆、暴露 raw events。

#### `read_local`

读取本地文件、数据库、配置。

主要风险：读到 secrets、本地隐私、源码、配置。

#### `write_local`

写本地文件、数据库、配置。

主要风险：破坏状态、植入内容、修改配置。

#### `network`

访问外部网络。

主要风险：泄漏数据、触发外部 side effect、SSRF。

#### `shell_exec`

执行 shell / code。

主要风险：几乎可组合出 read/write/network/process side effect，应按高风险处理。

注意：`shell_exec` 不等于自动拥有 `network`，但默认风险等级更高。

#### `long_running`

后台任务、watcher、cron、长工具。

主要风险：持续运行、重复 side effect、资源消耗、难以追踪。

#### `sends_message`

对外发送消息，例如群聊、私聊、邮件、通知。

主要风险：社交影响、隐私泄漏、打扰。

#### `modifies_memory`

创建、修改、删除 durable memory。

主要风险：长期状态污染、错误画像、retrieval 污染。

#### `external_side_effect`

对外部系统产生副作用。

例如：发 issue、发邮件、改 Notion、调用 API 写入、创建订单等。

主要风险：真实世界副作用。

#### `credential_access`

读取或使用 credential / secret manager。

主要风险：凭证泄漏、凭证滥用、权限扩大。

#### `platform_admin`

平台管理动作，例如 QQ 群踢人、禁言、改群名、处理加群请求等。

主要风险：社交/治理副作用，风险高于普通 `sends_message`。

### 设计理由

- `read_context` 和 `read_local` 分开，因为 LetheBot memory/raw logs 的隐私边界不同于文件系统。
- `sends_message` 单独列出，因为群聊/DM 是社交副作用，不等同普通网络请求。
- `external_side_effect` 单独列出，因为有些 API 是 network + write，但需要被明确识别。
- `platform_admin` 单独列出，因为平台管理动作风险高于普通发送消息。

### 后续约束

capability 只是描述工具能做什么，不直接决定能否执行。是否执行还需要结合 permissions、evaluatorPolicy、auditLevel、sandboxPolicy、当前 actor 和上下文判断。

## D6.3 permissions 是否需要 allowlist

状态：已确认

### 讨论结论

permissions 需要支持 allowlist / denylist，但 P0 不做复杂 ACL。

P0 permissions 分三层：

1. actor class
2. invocation context
3. allowlist / denylist

group allowlist 放入 P0，因为 LetheBot 的第一目标就是 QQ 群部署。

### 1. actor class

谁触发工具。

候选：

- `owner`
- `admin`
- `trusted_user`
- `user`
- `group_admin`
- `system_worker`
- `evaluator`
- `tool`

### 2. invocation context

在哪触发工具。

候选：

- `private_chat`
- `group_chat`
- `admin_cli`
- `background_worker`
- `internal`

### 3. allowlist / denylist

细粒度限制：

- `allowedUserIds`
- `allowedGroupIds`
- `deniedUserIds`
- `deniedGroupIds`

注意：

- raw QQ ID / group ID / account ID 属于受控 identity metadata；普通 prompt 可以在身份消歧、用户明确需要、平台操作或当前对话确有必要时看到最小必要 ID；
- allowlist / denylist 属于 policy DB / config；
- evaluator 通常只需要知道 allowed / denied / requires_owner / requires_admin；只有当用户任务需要确认身份、展示 ID、执行平台操作或排查身份映射时，才提供最小必要 ID。

### P0 schema 草案

```ts
interface ToolPermissionPolicy {
  allowedActors: ActorClass[];
  allowedContexts: InvocationContext[];
  allowedUserIds?: string[];
  allowedGroupIds?: string[];
  deniedUserIds?: string[];
  deniedGroupIds?: string[];
}
```

### 默认策略

#### `shell_exec` / `credential_access` / `platform_admin`

默认 owner/admin only。

#### `write_local` / `external_side_effect`

默认 owner/admin 或 trusted_user。

#### `sends_message`

允许 user/group 触发，但主动发送仍走 social evaluator / cooldown / audit。

#### `read_context`

默认 owner/admin/system_worker。

普通用户只能读取自己的可见 memory，不能任意读取 raw logs / audit trace。

#### `modifies_memory`

普通用户可以触发自己的 memory request，但真正写入 durable memory 仍走 memory policy / evaluator / executor。

#### `network`

可由普通用户触发，但取决于具体工具是否有 external side effect。

### 边界

permissions 决定“当前 actor/context 是否允许调用这个工具”。它不替代 evaluatorPolicy、auditLevel 或 sandboxPolicy。

allowlist / denylist 不应作为普通上下文污染 prompt；默认给 evaluator 抽象判断结果。需要 ID 时按 purpose-bound 方式提供最小必要 ID。

## D6.4 evaluatorPolicy 的默认值

状态：已确认

### 讨论结论

P0 `evaluatorPolicy` 只保留两个值：

- `required`
- `bypass`

`evaluatorPolicy` 只控制是否需要 LLM evaluator 审计，不控制工具是否启用/关闭。

registry 给出最低审计要求；runtime policy 可以根据上下文升级审计要求：

- 可以 `bypass -> required`；
- 不能自动 `required -> bypass`；
- 除非 owner config 明确允许更宽松策略。

### 默认可 bypass evaluator 的工具

满足以下条件的工具默认可以 bypass：

- read-only；
- 输出低敏；
- 无外部副作用；
- 不读取 private / sensitive / raw / audit context。

例子：

- 普通公开查询；
- 公开知识检索；
- 只读状态检查。

### 默认 required 的能力

以下 capability 默认需要 evaluator：

- `write_local`
- `shell_exec`
- `credential_access`
- `external_side_effect`
- `platform_admin`
- proactive `sends_message`
- `modifies_memory`
- `long_running`
- `read_context` 读取 private / sensitive / raw / audit 时
- `network` + user/private data export 时

### 特殊说明

#### `network`

`network` 本身不一定 required，取决于：

- 是否携带 user/private data；
- 是否产生 external side effect；
- 是否可能泄漏内部上下文；
- 是否只是公开查询。

#### `sends_message`

如果是用户明确请求的当前上下文回复，不一定需要工具级 evaluator。

但以下情况默认 required：

- 主动 DM；
- 跨上下文发送；
- admin digest 中包含敏感摘要；
- 自动发送到外部系统。

#### `modifies_memory`

`modifies_memory` 不一定都需要 tool evaluator，因为 D4 已经定义 memory evaluator / memory policy gate。

但工具层 metadata 仍应标记它需要 memory policy gate，不能直接写 durable memory。

### P0 schema

```ts
type EvaluatorPolicy = "required" | "bypass";
```

更细的 `requireForRisk` / `reason` 可以后续扩展，不进 P0 必需字段。

### 边界

- 高风险工具可以默认 `required`。
- owner 可以显式配置某些高风险工具 `bypass` evaluator，用于 Docker/实验环境。
- 但 `bypass` 不绕过 L0 hard policy、permissions、audit、sandbox 或 action executor。

## D6.5 auditLevel 如何避免记录 secrets

状态：已确认

### 讨论结论

P0 auditLevel 保留四档，但所有工具至少 `summary`。`full` 只允许 owner/debug 显式开启，并且仍必须经过 secret scanner / redaction。

四档：

1. `summary`
2. `redacted_full`
3. `full`
4. `none`

其中：

- `none` 作为概念保留，但 P0 默认不使用；
- P0 所有工具至少 `summary`；
- audit log 本身不能变成 secrets / private data 泄漏源。

### `summary`

记录最小可审计信息：

- tool name；
- actor / context；
- capability；
- success / failure；
- redacted summary；
- timestamps；
- evaluator / action decision id。

不记录完整 input / output。

适合多数工具默认。

### `redacted_full`

记录完整结构，但字段级 redaction。

典型 redaction：

- API key -> `[REDACTED_SECRET]`；
- token / cookie / password / private key -> `[REDACTED_SECRET]`；
- raw QQ ID / account ID -> 默认可保留为受控 identity metadata；如果 audit 面向普通解释或不需要身份消歧，则可 redacted 为 `[REDACTED_ID]`；
- file path -> 可选 hash / relative path / redacted path；
- message text -> 摘要、截断或按 sensitivity redaction；
- tool output -> secret scanner 后保存。

适合有风险但需要 debug 的工具。

### `full`

记录完整 input / output。

只允许：

- owner/admin debug 显式开启；
- 本地实验；
- 明确不含 secret 的工具；
- 短期 retention；
- 不进入普通 prompt / retrieval。

即使是 `full`，也必须经过 secret scanner；命中 secret 时仍要 redaction。

### `none`

不记录工具输入/输出，只记录最小执行计数。

P0 默认不使用。

如果未来引入，也只能用于极低风险、无副作用、无隐私输入的工具。

### P0 默认 auditLevel

- read-only public query: `summary`
- network: `summary` 或 `redacted_full`
- write_local: `redacted_full`
- shell_exec: `redacted_full`
- credential_access: `summary` only，绝不 `full`
- sends_message: `summary` + message id，不默认全文；敏感消息 redacted
- modifies_memory: `redacted_full`，包括 diff 和 source ids，但内容按 sensitivity redaction
- platform_admin: `redacted_full`，必须保留 actor/action/target；普通 prompt 仅在身份确认、平台操作或 debug 需要时看到最小必要 ID
- external_side_effect: `redacted_full`

### 硬规则

任何 audit level 都不能把 secret 原文写进普通 audit。

如果 secret scanner 命中：

- 降级或重写 audit 为 redacted summary；
- 标记 `redactionApplied=true`；
- secret 不进入 memory / retrieval / prompt；
- credential_access 只记录引用或摘要，不记录 secret value。

### 边界

audit log 用于治理、debug 和回放，不是普通 memory。普通 Pi prompt / ContextPack 默认不应读取完整 audit log；如果需要解释，只提供 redacted explanation。

## D6.6 sandboxPolicy 如何和 Docker / 本地 workspace 配合

状态：已确认；采用对象式 SandboxPolicy

### 讨论结论

`sandboxPolicy` 不设计成单个 enum 或简单 `docker: true/false`，而是对象式策略，因为 filesystem、network、execution、runtime、mount 是正交维度。

P0 实现可以先只使用：

- `filesystem`
- `network`
- `execution`
- `maxRuntimeMs`

其他字段作为扩展。

### P0 schema 草案

```ts
interface SandboxPolicy {
  filesystem: "none" | "readonly" | "workspace_write" | "allowed_paths";
  network: "none" | "restricted" | "allowed";
  execution: "none" | "in_process" | "subprocess" | "docker";
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  allowedPaths?: string[];
  allowedDomains?: string[];
}
```

### 字段含义

#### `filesystem`

文件系统访问范围：

- `none`：不访问文件系统；
- `readonly`：只读指定目录；
- `workspace_write`：只能写 workspace；
- `allowed_paths`：只能访问 allowlist 路径。

#### `network`

网络访问范围：

- `none`：禁止网络；
- `restricted`：只允许 allowlist domain / IP / protocol；
- `allowed`：允许一般网络。

#### `execution`

执行隔离方式：

- `none`：无代码执行；
- `in_process`：进程内纯逻辑工具；
- `subprocess`：本机子进程；
- `docker`：容器隔离执行。

#### `maxRuntimeMs` / `maxOutputBytes`

限制长任务、shell、网络工具和大输出，防止资源耗尽或 prompt/audit 爆炸。

#### `allowedPaths` / `allowedDomains`

用于 `allowed_paths` / `restricted` 策略。

### 默认策略

#### `shell_exec`

默认：

- `execution=docker` 或 `subprocess`；
- `filesystem=workspace_write` 或 `allowed_paths`；
- `network=none` 或 `restricted`；
- 必须设置 `maxRuntimeMs`。

#### `read_local`

默认：

- `filesystem=readonly` 或 `allowed_paths`。

#### `write_local`

默认：

- `filesystem=workspace_write` 或 `allowed_paths`。

#### `network`

默认：

- `network=restricted` 或 `allowed`；
- 如果携带 private data，evaluator required。

#### `long_running`

默认需要：

- `maxRuntimeMs` 或 background lease；
- cancellation handle；
- audit heartbeat。

#### `credential_access`

默认：

- 不把 secret 写入 env / log / prompt；
- 只传工具所需的最小 token reference；
- audit 只记录引用和用途，不记录 secret value。

### 边界

- Docker 是一种 execution backend，不等于完整 policy。
- 即使运行在 Docker 中，也仍需要 network、mount、runtime、output 和 audit 限制。
- `network=allowed` 不等于可以携带 private data 出站；是否允许还要看 evaluatorPolicy、permissions 和 audit。

### D6 小结

D6 当前阶段确认：

- tool registry metadata 拆成 capabilities / permissions / evaluatorPolicy / auditLevel / sandboxPolicy / outputSensitivity；
- evaluatorPolicy 不表达功能启用/禁用，只表达是否需要 LLM evaluator；
- capabilities P0 保留 11 个，包括 platform_admin；
- permissions P0 支持 actor/context/allowlist/denylist，group allowlist 入 P0；
- evaluatorPolicy P0 只有 required/bypass，runtime 可以升级但不能自动降级；
- auditLevel P0 至少 summary，full 只允许 owner/debug 显式开启且仍过 secret scanner；
- sandboxPolicy 采用对象式策略，Docker 只是 execution backend。

---

# D7. Identity / nickname / account mapping 如何建模？

状态：讨论中；D7.1 已确认三层拆分

## 问题背景

D7 要解决平台账号、昵称、群名片、用户身份和 user memory 的边界。

QQ 场景中 raw QQ ID、群号、昵称、群名片、头像、临时会话等都很容易被误当成 memory。但它们承担的职责不同：有些是路由/权限/身份映射，有些是显示信息，有些才是长期记忆。

## D7.1 raw QQ ID、昵称、用户身份是不是 memory？

状态：已确认

### 讨论结论

接受三层拆分：

1. identity registry
2. display profile
3. user memory

raw QQ ID 不是普通 memory；nickname history 也不是普通 memory。它们分别属于 identity registry / display profile。只有从昵称或身份信息中推导出的稳定偏好/事实，才可能进入 user memory，并且要走 evaluator / memory policy。

### 1. identity registry

平台账号映射，不是普通 memory。

典型字段：

- `platform = qq`
- `platform_user_id`，即 raw QQ ID
- `canonical_user_id`，LetheBot 内部 UUID
- `first_seen_at`
- `last_seen_at`
- `trust_level`
- `account_status`

用途：

- 路由；
- 权限；
- allowlist / denylist；
- audit trace；
- account mapping。

默认不作为普通 memory 注入 Pi prompt；但在身份消歧、用户明确需要确认 ID、平台操作、权限判断解释或 debug 场景中，可以以最小必要、结构化、purpose-bound 的方式进入 prompt。

### 2. display profile

昵称、群名片、头像等显示信息。

典型字段：

- `current_display_name`
- `group_card`
- `nickname_history`
- `avatar_hash`
- `source_group_id`
- `observed_at`

用途：

- 称呼；
- UI；
- debug；
- 审计；
- 当前上下文展示。

进入 prompt 时要最小化：通常只给当前上下文必要显示名；如果当前任务需要确认身份或使用平台 ID，可以附带最小必要 ID，但不给完整历史。

### 3. user memory

真正关于人的偏好、边界、长期上下文。

例子：

- 用户喜欢简洁回答；
- 用户不想在群里被 cue；
- 用户项目背景；
- 用户偏好的称呼。

这个才走 D3/D4 的 memory boundary。

### 特殊情况：昵称变化能否生成 memory？

可以，但不能直接把 nickname history 当 memory。

例子：用户把群名片改成“请叫我 X”，可以由 evaluator 生成候选 user memory：

- preferred_name = X

但需要：

- source_context 记录来源；
- visibility 保守；
- 不暴露 raw QQ ID；
- 允许用户后续纠正 / 删除 / supersede。

### 边界

- raw QQ ID / account ID 不是普通 memory；默认不自由注入 prompt，但在身份消歧、用户明确需要、平台操作或 debug 场景中可以作为受控 identity metadata 使用。
- nickname 可以进入 prompt，但只给当前上下文必要显示名。
- nickname history 不进普通 prompt。
- identity registry / display profile 不是普通 memory，也不参与普通 semantic retrieval。

### 后续继续讨论

- D7.2：canonical_user_id 和多平台账号绑定。
- D7.3：nickname / group card history 的保留和删除。
- D7.4：身份信息进入 prompt 的最小化策略。
- D7.5：用户如何查看/删除自己的 identity/display data。

## D7.2 canonical_user_id 和多平台账号绑定

状态：已确认

### 讨论结论

接受 `canonical_user_id` + `platform_accounts` + `group_memberships` 三表方向。

即使第一目标是 QQ，也不要让 raw QQ ID 成为系统主键。memory owner、permissions 和 identity mapping 应指向 LetheBot 内部用户 ID。

### 1. canonical_user_id

LetheBot 内部用户 ID。

建议：

- UUID / ULID；
- 不暴露给普通 prompt；
- user memory owner 使用 `canonical_user_id`；
- permissions / identity mapping 也指向 `canonical_user_id`。

### 2. platform_accounts

平台账号映射表。

典型字段：

- `platform`，例如 `qq`；
- `platform_account_id`，即 raw QQ ID；
- `canonical_user_id`；
- `account_type`，例如 private / group_member / temp_session；
- `first_seen_at`；
- `last_seen_at`；
- `status`：active / disabled / deleted；
- `verified_level`：observed / self_claimed / owner_verified。

### 3. group_memberships

用户在群里的成员关系。

典型字段：

- `platform`，例如 `qq`；
- `group_id`；
- `platform_account_id` 或 `canonical_user_id`；
- `role`：member / admin / owner；
- `group_card`；
- `joined_at`；
- `last_seen_at`；
- `status`。

group membership 是 identity/display metadata，不是 ordinary memory。

### 4. account binding 状态

多账号绑定不能只靠“用户说我是同一个人”。

建议状态：

- `unlinked`
- `self_claimed`
- `owner_verified`
- `rejected`
- `merged`

### P0 规则

- memory owner 使用 `canonical_user_id`，不直接使用 raw QQ ID。
- raw QQ ID 只在 identity mapping / gateway / policy DB 中使用。
- 自动绑定只允许同一个 `platform_account_id -> canonical_user_id`。
- 跨平台 / 多账号合并默认需要 owner/admin 或强验证。
- 删除账号映射不能自动删除所有 memory，但要让 retrieval 立刻不再通过该账号取到相关 user memory，除非另有 verified binding。
- group membership 是身份 metadata，不是普通 memory。

### 理由

现在设计阶段引入 internal canonical ID 成本很低；等 memory、permissions、audit、group membership 都已经用 raw QQ ID 串起来后再迁移，成本会很高，也容易造成删除和权限漏洞。

## D7.3 nickname / group card history 的保留和删除

状态：已确认

### 讨论结论

nickname / group card 需要区分当前值和历史值：

- 当前 nickname / group card 可以视作 conversation participant context；
- nickname / group card history 是 bounded display metadata；
- nickname history 不是普通 user memory，也不默认进入普通 prompt；
- 只有明确称呼偏好或稳定事实，才可能由 evaluator 生成 user memory candidate。

### 当前 nickname / group card

当前值可以进入本轮 ContextPack，用来帮助 bot 理解：

- 谁在说话；
- 如何称呼；
- 当前群内显示身份；
- 群成员角色。

但进入 prompt 时必须最小化、结构化，并视为 untrusted data。

示例字段：

```yaml
participant_display:
  display_name: "..."
  group_card: "..."
  source: "group_card"
  trust: "display_only"
  role: "member"
```

不应给普通 prompt raw QQ ID。

### nickname / group card history

历史值主要用于：

- 身份连续性；
- debug 身份混淆；
- audit “为什么 bot 当时这样称呼”；
- owner/admin 查询；
- 辅助判断 preferred_name 是否变化。

默认不进入普通 prompt。

原因：

- 会污染上下文；
- 可能泄漏用户历史状态；
- LLM 可能从昵称历史乱推断人格/身份；
- nickname 可能包含 prompt injection 或敏感内容。

### 保留策略

P0 策略：

- current display name：保留；
- recent nickname / group_card history：限量或限期保留，例如最近 N 条或最近 90 天；
- old history：可压缩为 hash / redacted / deleted；
- raw nickname history 不进普通 Pi prompt；
- 用户请求删除显示历史时，删除/禁用历史；
- 可以保留最小 tombstone，防止后台 worker 从旧 source 重建已删除 display history。

### lifecycle

display metadata 也应有 lifecycle：

- `active`
- `superseded`
- `redacted`
- `deleted`

### 从昵称推导 memory 的边界

nickname 变化可以触发 preferred_name proposal，但不是自动普通 memory。

可以生成 memory candidate 的情况：

- 用户说“以后叫我 X”；
- 群名片改成“请叫我 X”；
- 用户纠正“别叫我 A，叫我 B”。

候选 memory 仍需走 D3/D4：

- `scope=user`；
- `visibility=same_user_any_context` 或 `private_only`；
- `source_context=group_chat` / `private_chat`；
- `sensitivity=normal` 或 `personal`；
- lifecycle 由 evaluator / policy 决定。

### nickname 必须视为 untrusted text

昵称/群名片可能是：

- prompt injection；
- 情绪状态；
- 手机号/邮箱；
- 真实姓名；
- 梗；
- 攻击性内容；
- 临时身份标记。

因此进入 prompt 时应作为 data，而不是 instruction。

### 边界

- 当前 display name 是 conversation participant metadata。
- display history 是 bounded display metadata。
- display history 不是普通 semantic memory。
- preferred_name 才可能是 user memory，但必须由 evaluator 判断。

## D7.4 身份信息进入 prompt 的最小化策略

状态：已确认

### 讨论结论

接受：QQ ID / group ID / account ID 是 operational identity data。普通 prompt 可以按需看到当前任务必要的 ID，但 identity registry 不能作为普通上下文长期、大范围注入。

这修正了早期“raw QQ ID 默认不进普通 prompt”的过严表述。新的边界是：

- ID 不按 secret 处理；
- ID 也不是普通 memory；
- ID 是受控 identity metadata / operational data；
- 进入 prompt 时应 purpose-bound、最小必要、结构化。

### 普通群聊 ContextPack

默认可给：

- opaque user ref；
- current display name / group card；
- role；
- owner/admin/trusted flags。

示例：

```yaml
participants:
  sender:
    ref: "user:opaque-123"
    display_name: "当前群显示名"
    platform: "qq"
    platform_user_id: "123456789" # only if needed
    role: "member|admin|owner"
    is_bot_owner: false
    is_trusted_user: false
```

### 按需提供的身份信息

以下信息可以在当前任务需要时提供给 Pi：

- platform_user_id / QQ ID；
- group_id；
- message_id；
- platform-specific identifiers。

典型触发场景：

- 用户问“这是谁？”；
- 用户要求确认某个 QQ；
- 平台操作，例如发私聊、禁言、查成员；
- 权限判断解释；
- 把某个 ID 加到 allowlist / denylist；
- debug / owner/admin 查询；
- 聊天上下文本身正在使用 ID。

### 不应默认提供的信息

普通 prompt 不应默认塞入：

- 完整 platform_accounts 表；
- 完整 allowlist / denylist；
- 完整 nickname history；
- 其他群的身份信息；
- audit trace；
- 不相关成员列表。

### 输出给用户的边界

- 如果用户本来就在问 ID，可以输出必要 ID。
- 如果是平台操作结果，可以输出必要 target / message id。
- 普通聊天中不主动暴露他人的 ID。
- 私密/敏感场景中仍应考虑 redaction。

### prompt 注入边界

身份字段和 display 字段都应作为结构化 data 给模型，而不是自然语言 instruction。

特别是 nickname / group_card 仍然是 untrusted text；QQ ID 虽然不是 secret，但也不应被模型当成人格、偏好或事实来源。

### D7.4 边界总结

- QQ ID 不是 API key，不需要像 secret 一样严格隐藏。
- QQ ID 也不是普通 memory，不能被 retrieval 随意注入。
- QQ ID 是 operational identity data，按当前任务需要提供。
- 进入 prompt 要结构化、最小化、purpose-bound。

## D7.5 用户如何查看/删除自己的 identity/display data

状态：已确认

### 讨论结论

接受 data governance 模型：规则和 schema 按用户可治理设计，但 P0 实现节奏可以先偏 owner/admin CLI。普通用户请求可以先进入 admin_digest 或 evaluator-mediated action，后续再做完整自助 UI/命令。

核心原则：

- 用户应该能治理自己的 user memory / display profile / privacy preferences；
- identity registry 不能随便物理删除到系统无法路由、审计、执行 opt-out 或防止重新关联；
- 删除必须立即影响 retrieval；
- 物理删除和 tombstone 删除区分；
- tombstone 不进入 prompt / retrieval。

### 1. user memory

用户可以要求：

- list；
- disable；
- delete；
- correct；
- export redacted summary。

删除 / disable 后必须立刻从 retrieval 中排除。

### 2. display profile / nickname history

用户可以要求：

- 删除历史 nickname / group_card；
- redacted；
- 只保留 current；
- 不用某个称呼。

删除后：

- 不进入 prompt；
- 不用于 preferred_name 推断；
- 不参与普通 ContextPack。

### 3. identity registry

用户可以要求：

- 禁用账号关联；
- opt-out memory association；
- 删除 display/profile。

但 raw platform account mapping 可能保留最小 tombstone：

- platform；
- hashed account id 或 internal tombstone id；
- deletion marker；
- opt-out marker；
- timestamp。

目的不是继续画像，而是：

- 防止系统重新创建同样映射；
- 防止已删除 memory 被重新关联；
- 保证 denylist / opt-out 生效；
- 保留必要 redacted audit continuity。

### 4. account binding / unlink

用户可以请求 unlink。

unlink 后：

- 当前账号不再取到原 `canonical_user_id` 的 memory；
- verified multi-account memory 不再跨账号注入；
- audit 保留 redacted trace；
- 如果存在 tombstone，应只用于防止错误重关联，不进入 prompt/retrieval。

### P0 权限规则

- owner/admin 可以执行所有治理操作。
- memory_subject 可以请求删除/禁用自己的 memory/display data。
- group admin 只能治理 group-scoped memory/display，不能删除用户私有 identity。
- 删除必须立即影响 retrieval。
- 普通用户自助命令可以后置，但 schema 要支持。

### 未来用户命令候选

- `/memory list`
- `/memory forget ...`
- `/memory correct ...`
- `/privacy optout proactive_dm`
- `/privacy optout memory_association`
- `/identity unlink ...`

### D7 小结

D7 当前阶段确认：

- identity registry / display profile / user memory 三层拆分；
- raw QQ ID 不是普通 memory，而是 operational identity data；
- memory owner 使用 `canonical_user_id`，不直接使用 raw QQ ID；
- platform_accounts / group_memberships 是 identity metadata；
- 当前 nickname / group card 是 conversation participant context；
- nickname history 是 bounded display metadata，不默认进普通 prompt；
- QQ ID / group ID / account ID 可以按需进入 prompt，但必须 purpose-bound、最小必要、结构化；
- 用户治理规则按可删除/可禁用/可 unlink 设计，P0 实现可以先 owner/admin CLI。

---

# D8. 将讨论结论同步到正式设计文档

状态：已执行

## 讨论结论

选择 A：保留 discussion log 作为完整讨论记录，同时把已确认结论拆进正式 docs。

执行方式：

1. 保留 `docs/answer-review-discussion-log.md` 作为 D1-D8 的完整推理和取舍记录。
2. 新增 `docs/design-decisions.md` 作为 D1-D8 的简短 decision index。
3. 新增或更新正式设计文档，让后续实现不需要从 3000+ 行讨论日志中找结论。

## 新增正式文档

- `docs/design-decisions.md`
- `docs/agent-governance.md`
- `docs/social-action-model.md`
- `docs/tool-registry.md`
- `docs/identity-model.md`

## 已更新正式文档

- `docs/README.md`
- `docs/architecture.md`
- `docs/memory-system.md`
- `docs/context-orchestration.md`
- `docs/pi-integration.md`
- `docs/data-model.md`
- `docs/security-privacy.md`
- `docs/mvp-roadmap.md`

## 同步落点

### D1 / D2

同步到：

- `agent-governance.md`
- `architecture.md`
- `pi-integration.md`
- `tool-registry.md`
- `security-privacy.md`

内容包括：

- evaluator 是 Orchestrator 边界，不是 Pi 自审；
- `evaluatorPolicy: required | bypass` 只表示是否需要 LLM evaluator；
- bypass 不绕过 L0 hard policy / permissions / audit / sandbox / executor；
- policy groups 为 tools / memory / social。

### D3 / D4

同步到：

- `memory-system.md`
- `context-orchestration.md`
- `agent-governance.md`
- `data-model.md`
- `mvp-roadmap.md`

内容包括：

- memory boundary fields；
- visibility / sensitivity / source_context；
- auto-active policy；
- group chat -> user memory 限制；
- revision / rollback / supersede。

### D5

同步到：

- `social-action-model.md`
- `architecture.md`
- `pi-integration.md`
- `mvp-roadmap.md`

内容包括：

- ActionDecision / ActionPlan；
- trigger score + suppressor；
- no mandatory group reply；
- proactive DM special action；
- cooldown budget；
- reaction / folded-forward capability gate。

### D6

同步到：

- `tool-registry.md`
- `security-privacy.md`
- `architecture.md`
- `pi-integration.md`
- `data-model.md`

内容包括：

- tool capabilities；
- permissions；
- evaluatorPolicy；
- auditLevel；
- sandboxPolicy；
- outputSensitivity。

### D7

同步到：

- `identity-model.md`
- `context-orchestration.md`
- `data-model.md`
- `security-privacy.md`

内容包括：

- identity registry / display profile / user memory 三层拆分；
- canonical_user_id；
- QQ ID / group ID / account ID 是 operational identity data；
- current nickname/group card 是 participant context；
- nickname history 是 bounded display metadata；
- user governance / tombstone / unlink。

## 验证

已验证：

- README 中新增文档链接存在；
- formal docs 均可读取；
- D7 中关于 QQ ID 的过严旧表述已在正式文档中改为 operational identity data；
- 讨论日志仍保留完整上下文和 D1-D8 推进记录。
