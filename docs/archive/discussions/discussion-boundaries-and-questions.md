# LetheBot 讨论边界与问题清单

这是一份给你逐项回答和讨论的中文问卷，用来把 LetheBot 的发散 brainstorm 收敛成明确的产品、记忆、群聊、Pi 集成、治理和 MVP 边界。

它不是实现计划。这里没有回答的问题，都不算已经批准进入实现范围。

## 这份文档要解决什么

LetheBot 同时有很多诱人的方向：

- 厚长期记忆；
- QQ 私聊和群聊体验；
- Pi / Pi-like reasoning core；
- 用户画像和群画像；
- 可治理记忆；
- 后台总结、反思、衰减、合并；
- 好玩的 bot 实验；
- 本地优先和隐私边界。

这些方向如果不先讨论边界，很容易变成“什么都想做”的大泥球。本文档的作用是：把问题拆开，让你可以一条一条回答。

## 建议回答格式

每个问题建议用下面格式回答：

```md
### Qx.y 问题标题

答复类型：已决定 / MVP 默认 / 延后 / 需要调研
我的回答：
理由：
风险：
需要更新的文档：
后续问题：
```

四种答复类型：

- `已决定`：已经可以作为项目设计决策写入 docs。
- `MVP 默认`：先按这个做，未来可以改。
- `延后`：明确不进 MVP，之后再说。
- `需要调研`：需要先查 Pi、NapCat、OneBot、数据库、用户体验或原型验证。

## 讨论规则

1. 先区分产品行为和技术实现，不要混在一起。
2. 先区分 MVP 默认和长期愿景，不要把未来想象当成现在 scope。
3. 记忆、隐私、群聊发言边界都是产品决策，不是单纯后端细节。
4. 不要批准没有来源、scope、confidence、lifecycle、删除语义的自动长期记忆。
5. 好玩的功能不能绕过治理和隐私。
6. Pi 可以推理和提出 memory proposal，但 LetheBot 拥有长期状态、隐私策略和记忆生命周期。
7. raw chat log 不是长期记忆，只是审计和重建材料。
8. vector search 不是事实来源，只是召回索引。
9. QQ 群聊默认视为社交敏感空间：默认沉默，显式邀请后再说话。
10. 涉及隐私的选择，MVP 默认走保守路线。

## 决策标签

回答问题时可以加这些标签：

- `P0-MVP`：第一个可用 QQ + memory demo 前必须决定。
- `P1-早期`：MVP 后很快会需要。
- `P2-以后`：有价值，但不阻塞。
- `实验`：适合玩具/原型，不一定进核心 runtime。
- `策略`：隐私、权限、删除、治理规则。
- `架构`：模块边界、schema、runtime contract、集成方式。
- `UX`：用户可见行为、交互方式、语气。
- `调研`：需要查文档、跑原型或做实验。

## 当前 docs 里的已知边界

这些是现有设计文档中的默认锚点。除非明确推翻，否则先按这些理解：

- LetheBot 是 local-first、privacy-friendly 的。
- 第一平台是 QQ，通过 NapCat / OneBot 接入。
- Pi SDK + TypeScript 是推荐的 reasoning core 集成方式。
- Pi 是 reasoning core，不是 memory database，也不是 platform adapter。
- Gateway 只处理平台协议适配。
- Ingestion 负责归一化事件，并先写 raw logs。
- Thick Memory Layer 负责长期记忆、检索、生命周期和治理。
- Context Orchestrator 负责选择 prompt layers、记忆、近期上下文和 token budget。
- 长期记忆必须带 source metadata、confidence、lifecycle state。
- 删除/禁用必须立刻影响 retrieval。
- SQLite WAL 是 MVP 的 source of truth；vector/graph 都是辅助索引。
- 后台抽取默认产生 proposal，不直接写 active long-term facts。

---

# 1. 产品身份与社交角色

## Q1.1 LetheBot 首要应该像什么？

你更希望它主要像：

- 私人助手；
- 群友；
- 档案员；
- 秘书；
- 系统进程；
- 玩具 / 实验室生物；
- bot runtime；
- 按场景混合？

为什么要问：
这会决定它的语气、主动性、记忆引用方式、以及用户是否会觉得它冒犯。

建议 MVP 默认：
按场景混合，但强制分模式：

- 私聊：助手 + 记忆秘书；
- 群聊：安静的群感知 bot；
- 管理/治理：系统进程 + 档案员；
- 后台：不可见的记忆整理员。

你需要回答：这个默认是否符合你想要的 LetheBot？如果不符合，应该偏向哪一种？

## Q1.2 LetheBot 要不要有强人格？

可选方向：

- 尽量中性，没有强人格；
- 轻度可识别人格；
- 强角色设定；
- 不同模式不同 persona；
- 用户可配置 persona layer。

讨论边界：
人格不能覆盖隐私、记忆治理、群聊礼貌和工具权限。

你需要回答：MVP 里它应该有多少“人格感”？

## Q1.3 用户应该如何感知“它真的记得我”？

你希望用户感受到的是：

- 它能延续旧话题；
- 它理解我的偏好；
- 它知道我的项目背景；
- 它知道群里的长期上下文；
- 它能说清楚自己为什么想起某件事；
- 它记得但不冒犯；
- 它有点好玩；
- 其他？

反过来，哪些表现会让你觉得“这太 creepy 了”？

## Q1.4 私聊和群聊体验应该差异多大？

需要讨论的维度：

- 回复频率；
- 可用记忆范围；
- 语气；
- 是否能提旧事；
- 是否主动追问；
- 工具权限；
- 解释详细程度；
- 是否能主动发起话题。

建议 MVP 默认：
私聊默认响应；群聊只在 @、回复 bot、命令触发时响应。

你需要回答：这个默认够保守吗？会不会太像死 bot？

## Q1.5 LetheBot 能不能主动发起对话？

可能场景：

- 私聊提醒；
- admin 记忆审核；
- 群每日总结；
- 工具任务完成；
- 每周回顾；
- 检测到未解决问题；
- 玩笑/吐槽/参与群聊。

你需要回答：
哪些场景允许主动私聊？哪些允许主动群聊？哪些只能 admin-only？

## Q1.6 LetheBot 社交上绝对不该做什么？

候选硬规则：

- 在群里暴露私聊记忆；
- 公开推断人际关系；
- 未被要求时提敏感事实；
- 在冲突中继续拱火；
- 高频插话；
- 解释梗把梗杀死；
- 对不确定上下文表现得很确定；
- 把玩笑当事实记忆；
- 其他？

你需要回答：哪些应该成为 hard policy？

---

# 2. 私聊 / 群聊记忆边界

## Q2.1 私聊记忆能不能用于群聊？

可选规则：

- 永远不能；
- 只有显式标记为可共享才可以；
- 只有用户在群里主动调用才可以；
- 只有非敏感偏好可以；
- 用户可配置；
- 群可配置。

建议 MVP 默认：
私聊记忆默认不能自动进入群聊 ContextPack。除非 memory 明确有 visibility metadata，或者用户本轮显式要求引用。

你需要回答：这个边界是否足够？有没有例外？

## Q2.2 群聊发言能不能更新某个用户的私人画像？

可选规则：

- 永远不能；
- 只有用户明确说“记住”；
- 只能生成 group-scoped memory；
- 可以生成低置信度 profile proposal；
- 多次重复后可以 active；
- admin 可配置。

风险：
人在群里的表现不一定代表私人偏好。

你需要回答：MVP 应该允许哪一种？

## Q2.3 私聊里的隐私偏好能否影响群聊行为？

例子：

- “以后不要在群里 cue 我。”
- “不要总结我在群里的发言。”
- “我不希望你把我的群聊内容写进画像。”

你需要回答：
这种偏好是全局生效、按群生效，还是只在私聊生效？

## Q2.4 如何连接同一个人在私聊和群聊里的身份？

需要考虑：

- QQ 平台 ID；
- LetheBot 内部 user ID；
- 多 QQ 账号；
- nickname history；
- 手动 identity linking；
- identity link 是否可以进入 prompt。

建议 MVP 默认：
内部可以有 identity link，但 prompt 中默认不暴露具体 QQ ID。

你需要回答：MVP 是否需要多账号合并？还是先不做？

## Q2.5 MVP 必须有哪些 memory scope？

候选 scope：

- global；
- user；
- group；
- conversation；
- tool；
- system。

你需要回答：
这些都要从第一天进入 schema 吗？哪些可以只作为预留？

---

# 3. 记忆类型与生命周期

## Q3.1 MVP 必须支持哪些 memory kind？

候选类型：

- fact：事实；
- preference：偏好；
- boundary：边界 / 禁忌；
- correction：用户纠正；
- episode：时间绑定事件；
- summary：摘要；
- procedure：流程/技能；
- group_norm：群规则/群文化；
- meme：梗；
- relationship_hint：关系线索；
- open_loop：未完成事项；
- artifact：文件/链接/项目对象；
- ritual：周期性仪式；
- uncertainty：不确定假设。

建议 MVP 默认：
先做 `fact`、`preference`、`boundary`、`summary`、`procedure`、`group_norm`。

你需要回答：这个集合是否太多/太少？

## Q3.2 所有自动抽取的记忆是否都必须先成为 proposal？

可选规则：

- 是，除了用户明确说“记住这个”；
- 是，永远先 proposal；
- 高置信度事实可以自动 active；
- 重复出现多次后可以自动 active；
- admin 可配置。

建议 MVP 默认：
后台抽取只生成 `proposed`。手动/admin 创建可以直接 `active`。

你需要回答：有没有自动 active 的例外？

## Q3.3 什么算“明确同意记住”？

可能表达：

- “记住我喜欢简洁回答”；
- “以后别这样”；
- “下次你应该……”；
- 群 admin 设置群规；
- 用户接受 memory proposal；
- `/remember` 命令；
- emoji reaction；
- 其他自然语言。

你需要回答：哪些表达足够强，可以直接写 active memory？

## Q3.4 哪些内容绝不能自动写入 active memory？

候选硬排除：

- 密码、API key、token、cookie、secret；
- 原始 QQ ID、账号 ID、私有身份绑定；
- 未证实指控；
- 医疗、财务、法律、亲密关系、政治等敏感个人信息；
- 第三方私聊内容；
- 原始聊天全文；
- 工具输出中的本地路径或私有文件内容；
- 临时情绪发言；
- 明显玩笑、反讽；
- 群冲突中的关系判断；
- 其他？

你需要回答：这些是否都应 hard exclude？还要补哪些？

## Q3.5 confidence 怎么表示？

可选方案：

- low / medium / high；
- 0-1 数值；
- 证据次数；
- confidence + sensitivity；
- confidence + source type；
- 多字段组合。

你需要回答：MVP 用 enum 够不够？长期是否要数值？

## Q3.6 importance 怎么表示？

importance 可能来自：

- 用户明确说重要；
- 多次重复出现；
- 经常被检索；
- 影响安全/隐私；
- 影响回答质量；
- 长期项目相关；
- 群规则相关。

你需要回答：importance 应该影响检索排名、保留时长，还是两者都影响？

## Q3.7 记忆如何过期或衰减？

可选方案：

- MVP 不做 decay；
- 每条 memory 可有 `expires_at`；
- 不同 kind 默认不同 decay；
- 后台产生 stale proposal；
- 定期让用户 review。

你需要回答：哪些 memory kind 从一开始就需要过期时间？

## Q3.8 记忆冲突怎么处理？

例子：

- 用户以前喜欢详细回答，现在喜欢简洁；
- 群规则变了；
- 两个人对群规说法不同；
- bot 推断过一件事，后来被纠正。

可选策略：

- 新的覆盖旧的；
- 旧的标记 `superseded`；
- 两者都保留，但标注适用上下文；
- 询问用户/admin；
- 创建 conflict object。

建议 MVP 默认：
用户纠正优先于推断记忆；其他冲突进入 proposal/admin review。

你需要回答：这个默认是否合适？

## Q3.9 memory revisions 和 diff 要不要从第一天做？

问题：
即使 UI 暂时不展示 diff，是否也要从 schema 上保存 `memory_revisions`？

建议：
要。后期补记忆版本历史会很痛。

你需要回答：同意吗？

## Q3.10 episode 和 summary 的边界是什么？

问题：
一件发生过的事什么时候应该成为 episodic memory，什么时候只进入 rolling summary？

你需要回答：是否需要明确规则？还是先按后台 worker proposal 试错？

---

# 4. 记忆治理 UX

## Q4.1 谁能查看哪些记忆？

角色：

- bot owner/admin；
- 单个用户；
- 群 admin；
- 普通群成员；
- tool/plugin；
- Pi agent 本身。

你需要回答：每种角色能看到哪些 scope？

## Q4.2 MVP 治理界面是什么？

可选方案：

- CLI only；
- 私聊命令；
- 简单 web UI；
- 直接查 SQLite；
- CLI first, web later。

建议 MVP 默认：
CLI first。更快、更安全、更可审计。

你需要回答：是否接受先做 CLI？

## Q4.3 第一批治理命令需要哪些？

候选命令：

- list memories；
- search memories；
- show memory source；
- create memory；
- propose memory；
- accept proposal；
- reject proposal；
- disable memory；
- delete memory；
- show memory revisions；
- show memories used in an agent turn；
- export user/group memory。

你需要回答：哪些是 P0？

## Q4.4 MVP 里的 delete 到底是什么意思？

可选语义：

- 立刻排除 retrieval；
- 保留 tombstone 用于审计；
- 删除 content 但保留 metadata；
- 连 raw source events 一起 purge；
- 重建 derived indexes；
- 以后支持 full erase。

建议 MVP 默认：
删除后的 memory 立刻不能被检索；保留最小 tombstone；embedding/derived index 需要失效或重建。

你需要回答：这个删除语义够不够？

## Q4.5 用户能不能直接编辑 memory 内容？

可选方案：

- admin only；
- 用户能编辑自己的 memory；
- 用户只能提出 edit proposal；
- 群 admin 能编辑群规；
- 不允许 edit，只能 supersede。

你需要回答：哪个模型最可审计？

## Q4.6 如何解释“本次回答用了哪些记忆”？

可能界面：

- 私聊 `/why`；
- admin CLI 查看 turn context；
- web UI context trace；
- 群聊里只给极简解释；
- 群聊里永远不解释 private memory。

你需要回答：群聊里能安全解释到什么程度？

## Q4.7 memory proposal 应该怎么审核？

可选方案：

- 按 scope 的 inbox；
- 每日 digest；
- 一条条 accept/reject；
- 低风险 bulk accept；
- 敏感类别自动 reject；
- 只有用户要求才 review。

你需要回答：你能接受多少 review 负担？

---

# 5. 群聊注意力与参与策略

## Q5.1 群聊中哪些触发一定会回复？

候选 hard trigger：

- @bot；
- 回复 bot 消息；
- bot 名字/昵称；
- 命令前缀；
- 群 admin 指令；
- 明确问 bot；
- 工具结果完成。

建议 MVP 默认：
只响应 @bot、reply-to-bot、命令前缀。

你需要回答：是否加 bot 名字/昵称触发？

## Q5.2 以后哪些 soft trigger 可以接受？

候选 soft trigger：

- 有直接问题且 bot 很可能有帮助；
- 群里在讨论 bot 能力；
- 有人问“谁记得……”；
- 话题命中订阅 watcher；
- bot 有相关工具结果；
- 低流量时段的问题无人回答。

你需要回答：哪些软触发不会显得烦？

## Q5.3 哪些情况必须抑制发言？

候选 suppressor：

- 高速闲聊；
- 情绪冲突；
- 敏感个人话题；
- bot 刚说过话；
- 多个真人正在回答；
- 引用目标不确定；
- 玩梗线程，解释会杀梗；
- 消息明显不是给 bot 的。

你需要回答：哪些 suppressor 即使被 @ 也应该谨慎？

## Q5.4 LetheBot 是否应该只 reaction 不文字回复？

可能用途：

- 表示收到；
- 暗中保存为 summary 素材；
- 标为 memory candidate；
- 给 admin 发审核项；
- 轻量参与群氛围。

你需要回答：是否想要 reaction-only 行为？NapCat/OneBot 是否需要先调研支持情况？

## Q5.5 群聊 cooldown 怎么设计？

可能 cooldown：

- 每群；
- 每用户；
- 每 thread；
- 每工具；
- 每命令；
- burst limit；
- daily cap。

你需要回答：MVP 至少需要哪些防刷屏限制？

## Q5.6 遇到争吵或高情绪对话时怎么办？

可选策略：

- 默认沉默，除非直接命令；
- 被要求时做降温；
- 事后中性总结；
- 不从冲突中建立 relationship memory；
- 敏感 proposal 默认拒绝或标高风险。

建议 MVP 默认：
冲突中默认沉默，不做长期关系判断。

你需要回答：是否同意？

## Q5.7 LetheBot 能不能因为群聊内容私聊某个人？

例子：

- 用户在群里问了敏感问题；
- memory review 需要确认；
- 工具结果不适合公开；
- 群讨论触发了私人 reminder。

风险：
意外私聊可能很冒犯。

你需要回答：MVP 是否禁止这种主动 DM？

---

# 6. 群记忆与社会上下文

## Q6.1 群记忆允许包含什么？

候选内容：

- 群规则；
- 常见话题；
- 长期项目；
- 共享链接/资源；
- rolling summary；
- 梗；
- 成员昵称；
- 角色线索；
- 未解决决策。

你需要回答：哪些 MVP 安全？哪些以后再说？

## Q6.2 梗和黑话怎么存？

可选策略：

- MVP 不做；
- 只做低置信度 proposal；
- group-scoped memory；
- 需要人工确认；
- 不复用就过期；
- 绝不主动解释。

风险：
误解梗会很尴尬。

你需要回答：梗记忆进不进早期版本？

## Q6.3 要不要做关系图谱？

可选方向：

- 不做；
- 只做互动统计图；
- 做 topic expertise graph；
- 只记录显式确认关系；
- 完整 social graph 以后再说；
- 只给 admin 看。

建议 MVP 默认：
不做关系图谱。最多以后做话题/活跃度聚合。

你需要回答：是否同意暂缓？

## Q6.4 成员角色能不能自动推断？

例子：

- “经常回答 Linux 问题”；
- “群 admin”；
- “项目维护者”；
- “梗来源”；
- “新成员”。

你需要回答：哪些角色线索可以自动 proposal？哪些必须确认？

## Q6.5 nickname history 怎么处理？

问题：

- nickname history 是 memory，还是 identity metadata？
- 旧昵称是否可搜索？
- 旧昵称能否进入 prompt？
- 冒犯性/临时昵称怎么处理？

你需要回答：MVP 是否只把 nickname 当 metadata？

## Q6.6 群摘要按什么组织？

可选组织方式：

- 按时间；
- 按主题；
- 按参与者；
- 按事件；
- 按决策/open loop；
- 混合。

建议 MVP 默认：
时间窗口 rolling summary + topic tags。

你需要回答：是否需要从一开始支持 topic summary？

## Q6.7 多线程群聊上下文怎么表示？

挑战：

- 多个话题并行；
- reply chain；
- 引用；
- 话题跳跃；
- 图片/表情；
- 延迟回复。

你需要回答：MVP 是否需要显式 thread detection？还是 recent messages 足够？

---

# 7. Context Orchestration

## Q7.1 ContextPack schema 还缺什么？

现有候选字段：

- turnId；
- platform；
- conversationScope；
- userProfile；
- groupProfile；
- recentMessages；
- retrievedMemories；
- systemLayers；
- interactionState；
- tokenBudget。

你需要回答：为了隐私、可解释、replay，还需要哪些字段？

## Q7.2 必须有哪些 prompt layer？

候选层：

1. global safety / behavior rules；
2. bot persona；
3. platform rules；
4. privacy boundary；
5. group rules；
6. user profile；
7. group profile；
8. current interaction state；
9. active thread summary；
10. recent messages；
11. retrieved memories；
12. tool availability；
13. latest user message；
14. response style constraints。

你需要回答：哪些是 P0？哪些以后再加？

## Q7.3 token budget 怎么分？

候选预算：

- system/persona 固定；
- privacy policy 固定；
- user profile 小而精；
- group profile 中等；
- recent messages 自适应；
- retrieved memories 自适应；
- tool results 严格封顶；
- 保留 completion budget。

你需要回答：MVP 哪些部分必须 hard cap？

## Q7.4 memory retrieval 排名依据是什么？

候选信号：

- scope match；
- 当前 speaker；
- 当前 group；
- semantic similarity；
- keyword match；
- recency；
- importance；
- confidence；
- sensitivity；
- lifecycle state；
- 以前是否有用；
- 是否 pinned。

建议规则：
先做 scope/lifecycle/privacy filter，再 ranking。

你需要回答：这个顺序是否接受？

## Q7.5 被拒绝的 candidate memories 要不要记录？

好处：

- 可解释；
- debug retrieval；
- 隐私审计；
- 优化 ranking。

风险：
Rejected log 本身可能包含敏感信息。

你需要回答：MVP 记录 rejected reason 还是不记录？

## Q7.6 用户能不能查看完整 prompt？

可选方案：

- admin only；
- 只能看 redacted prompt；
- 只能看 prompt layer summary；
- 私聊允许 exact prompt；
- 永不存完整 prompt。

你需要回答：怎样平衡可观测性和隐私？

## Q7.7 ContextPack 是否需要可 replay？

Replay 可以用于 debug、测试和回归验证。

你需要回答：MVP 是“可解释即可”，还是要“足够 replay”？

---

# 8. Pi 集成边界

## Q8.1 MVP 是否只走 Pi SDK？

可选方案：

- SDK only；
- SDK 主线，RPC fallback；
- RPC first，为了隔离；
- 先抽象 ReasoningCore，具体实现后定。

当前 docs 默认：
TypeScript 内嵌 Pi SDK。

你需要回答：是否保留 RPC fallback 作为早期备选？

## Q8.2 ReasoningCore interface 需要暴露什么？

现有候选：

- `runTurn(input)`；
- `streamTurn(input)`；
- `abort(runId)`。

你需要回答：
是否还要暴露 tool hook events、compaction hooks、session metadata、model settings？

## Q8.3 哪些 LetheBot 能力暴露成 Pi tools？

候选 tools：

- memory.search；
- memory.propose；
- memory.explain；
- memory.disable；
- group.recent_summary；
- qq.send_message；
- qq.react；
- sandbox.run；
- task.schedule；
- tool.use；
- governance.request_review。

你需要回答：哪些是 P0？哪些太危险不能先给 Pi？

## Q8.4 哪些能力必须留在 Pi 外部控制？

候选外部控制：

- active memory 写入；
- memory 删除；
- 跨 scope 使用 memory；
- 群聊主动发言；
- 危险工具权限；
- token budget；
- privacy policy；
- identity linking；
- retention policy。

你需要回答：这些是否都不能交给 Pi？长期有没有例外？

## Q8.5 Pi session 如何映射 QQ 会话？

可选方式：

- 每个 conversation 一个 Pi session；
- 每个 user 一个；
- 每个 group 一个；
- 每个 active thread 一个；
- 完全 stateless，每次只用 LetheBot ContextPack；
- hybrid。

风险：
Pi session memory 可能和 LetheBot durable memory 重复甚至冲突。

你需要回答：MVP 偏 stateless 还是保留 Pi session？

## Q8.6 Pi compaction 和 LetheBot memory consolidation 如何分工？

建议默认：
Pi compaction 只管短期 session；长期 durable memory 完全由 LetheBot 管。

你需要回答：是否同意？

## Q8.7 Pi 不可用时怎么办？

可选方案：

- 只记录，不回复；
- 回复简单 unavailable message；
- fallback 到其他模型；
- admin alert；
- 自动关闭群聊回复。

你需要回答：MVP fallback 是什么？

---

# 9. 工具体系与沙盒

## Q9.1 第一批 tools 是哪些？

候选 P0：

- memory.search；
- memory.propose；
- memory.create/admin；
- memory.disable/delete/admin；
- group.recent_summary；
- qq.send_message；
- qq.react，如果支持；
- turn.explain。

你需要回答：哪些暴露给 Pi，哪些只能 admin/系统内部用？

## Q9.2 tool registry 必须有哪些 metadata？

候选字段：

- name；
- description；
- input schema；
- output schema；
- required permissions；
- 是否修改状态；
- 是否访问网络；
- 是否访问文件系统；
- 是否需要 sandbox；
- 结果持久化策略；
- allowed scopes；
- 是否需要确认；
- audit level。

你需要回答：第一版 registry schema 必须包含哪些？

## Q9.3 哪些 tools 需要 sandbox？

候选：

- 代码执行；
- shell；
- 文件系统；
- 浏览器自动化；
- 网络抓取；
- 媒体处理；
- 第三方 API；
- 长时间 agent 任务。

你需要回答：sandbox.run 进 MVP 吗？还是明确延后？

## Q9.4 工具结果如何变成记忆？

可选规则：

- 永远不自动沉淀；
- 只生成 procedural memory proposal；
- 用户说记住才写；
- tool-specific distillation；
- 多次成功 workflow 后生成 proposal。

风险：
工具输出常包含本地路径、credential、临时状态。

你需要回答：默认应该多保守？

## Q9.5 哪些长期运行工具允许存在？

候选：

- reminder；
- RSS/blog watcher；
- project watcher；
- background summarizer；
- memory consolidation；
- daily digest；
- file watcher；
- CI/status watcher。

你需要回答：哪些是产品功能，哪些只是内部 worker？

## Q9.6 plugin 如何安装和信任？

问题：

- 只允许本地 plugin？
- 是否需要签名？
- 是否要 permission manifest？
- admin approval？
- per-group enable？
- per-user enable？

你需要回答：MVP 是否先不做 plugin marketplace，只做内置 tool registry？

---

# 10. 后台 worker 与反思

## Q10.1 MVP 有哪些 background jobs？

候选：

- group rolling summary；
- private conversation summary；
- memory proposal extraction；
- embedding update；
- stale memory scan；
- conflict detection；
- job cleanup；
- audit compaction。

建议 MVP 默认：
只做 group rolling summary 和 memory proposal extraction。

你需要回答：是否还要 private summary？

## Q10.2 后台任务能不能直接发消息？

可选规则：

- MVP 永远不直接发；
- 只发 private admin digest；
- 用户 reminder 例外；
- 群 summary 只能命令触发；
- admin opt-in 后可定时发群。

风险：
自动发群消息很容易讨厌。

你需要回答：MVP 允许哪种？

## Q10.3 “梦境整理”要不要成为产品语言？

可选：

- 只是内部 worker nickname；
- admin 私聊 digest；
- 用户可见玩具功能；
- 群每周仪式；
- 不使用这个比喻。

你需要回答：你喜欢这个概念吗？还是太中二？

## Q10.4 后台抽取如何验证？

候选机制：

- source event links；
- confidence score；
- proposal inbox；
- 抽样人工 review；
- regression eval set；
- 禁止直接 active writes。

你需要回答：MVP 至少做哪些？

## Q10.5 workers 如何保证 idempotent？

需要讨论：

- job key；
- source event window ID；
- retry semantics；
- duplicate proposal detection；
- partial failure handling。

你需要回答：MVP 是否需要完整 job 表，还是简单定时任务即可？

---

# 11. 数据模型与存储

## Q11.1 SQLite WAL 是否就是 MVP source of truth？

当前 docs 默认是 yes。

你需要回答：有没有理由在 MVP 前引入 Postgres、Qdrant、Redis 或 graph DB？

建议默认：没有。

## Q11.2 P0 表有哪些？

候选 P0 表：

- platform_accounts；
- platform_users；
- platform_groups；
- identity_links；
- nickname_history；
- raw_events；
- chat_messages；
- agent_runs；
- agent_events；
- tool_calls；
- memory_records；
- memory_sources；
- memory_revisions；
- memory_access_log；
- context_packs；
- context_blocks；
- context_memory_links；
- jobs；
- job_attempts。

你需要回答：哪些能延后？哪些必须第一版 schema 就有？

## Q11.3 graph tables 要不要从第一天建？

可选方案：

- 不建；
- 只预留空 schema；
- 只做 topic graph；
- 以后再做完整 graph。

风险：
过早 graph modeling 会拖慢 MVP。

你需要回答：是否完全延后 graph？

## Q11.4 embeddings 什么时候引入？

可选：

- FTS 跑通后再加；
- memory retrieval 一开始就加；
- 只给 summaries 加；
- Python sidecar；
- sqlite-vec first；
- 以后 external vector DB。

建议 MVP 默认：
SQLite FTS first；memory lifecycle 稳定后再加 embeddings。

你需要回答：是否接受？

## Q11.5 raw event 默认保留多久？

需要分别讨论：

- 私聊；
- 群聊；
- media metadata；
- tool outputs；
- 被删除用户相关数据；
- disabled memory sources；
- backups。

你需要回答：MVP local deployment 的默认 retention 是什么？

## Q11.6 backup/export 怎么做？

可选能力：

- 整个 SQLite backup；
- per-user export；
- per-group export；
- memory-only export；
- redacted export；
- encrypted backup。

你需要回答：MVP 要 backup 吗？还是先手动复制 SQLite？

---

# 12. 技术栈与模块边界

## Q12.1 TypeScript/Node 是否是主 runtime？

当前 docs 推荐 Node.js 22+ 和 TypeScript，因为 Pi SDK 偏 TS-native。

你需要回答：core 里有没有部分从一开始就应该用 Python/Go/Rust？

## Q12.2 Python sidecar 负责什么？

候选：

- local embeddings；
- reranker；
- clustering；
- OCR；
- speech；
- experimental memory extraction；
- media processing。

边界：
Python sidecar 不拥有 durable memory state。

你需要回答：这个边界是否接受？

## Q12.3 Gateway Adapter 边界是否接受？

允许 Gateway 做：

- NapCat/OneBot 连接；
- message send/receive；
- 平台事件解析；
- media/quote normalization；
- reconnect/retry。

禁止 Gateway 做：

- memory retrieval；
- prompt construction；
- Pi reasoning；
- 长期 memory 写入，除了 raw event ingestion。

你需要回答：这个边界是否足够硬？

## Q12.4 Context Orchestrator 负责什么？

候选职责：

- attention decision 所需输入准备；
- ContextPack construction；
- prompt layer selection；
- memory retrieval coordination；
- token budgeting；
- context logging；
- privacy filters。

你需要回答：Attention Engine 是独立模块，还是 Context Orchestrator 的一部分？

## Q12.5 Tool Orchestrator 和 Tool Registry 怎么分工？

需要决定：

- 谁检查 permission？
- 谁记录 audit？
- 谁实际执行 tool？
- 谁把 tool 暴露给 Pi？
- 谁决定 tool result 是否持久化？

你需要回答：这两个模块的边界怎么画？

## Q12.6 是否需要 HTTP API/server？

可选：

- MVP 不做 HTTP API；
- internal Fastify/Hono API；
- CLI 直接打开 SQLite；
- CLI 调 service API；
- web UI 以后复用同一 API。

架构风险：
CLI 直接查 SQLite 快，但可能绕过 service policy。

你需要回答：MVP CLI 应该直连 DB，还是通过 service？

---

# 13. 治理、隐私与权限

## Q13.1 群记忆归谁所有？

可选：

- bot owner；
- 群主/管理员；
- 全体群成员共同；
- 每条 memory 有自己的 owner；
- 按 scope 分所有权。

你需要回答：QQ 群语境下哪种 ownership 可接受？

## Q13.2 群成员要求 bot 忘记某件事时怎么办？

场景：

- 关于 TA 自己；
- 关于别人；
- 关于公开群事件；
- 关于群规；
- 关于 bot 犯错；
- 关于 raw event logs。

建议策略方向：
关于个人的信息应立即排除 retrieval。群公共事实可能需要 admin review 或匿名化处理。

你需要回答：MVP 具体规则是什么？

## Q13.3 sensitivity 是否要独立于 scope？

候选 sensitivity：

- public；
- group-public；
- private；
- sensitive；
- secret；
- prohibited。

问题：
同一个 scope 内也可能有不同敏感度。

你需要回答：MVP 是否需要 sensitivity 字段？

## Q13.4 MVP 有哪些权限？

候选权限：

- 查看自己的 memory；
- 查看 group memory；
- 编辑自己的 memory；
- 请求删除；
- 删除自己的 memory；
- 管理 group memory；
- 管理 global rules；
- 管理 tools；
- 查看 audit logs；
- export data。

你需要回答：哪些权限第一版需要？

## Q13.5 audit logs 如何保护？

audit logs 本身也可能敏感。

需要决定：

- 谁能看 audit logs？
- 保留多久？
- 是否 redacted？
- 能否 purge？
- prompt/context trace 是否属于 audit logs？

你需要回答：MVP audit 策略是什么？

## Q13.6 删除 memory 后派生物怎么处理？

派生物包括：

- embeddings；
- summaries；
- user profile fragments；
- group profile fragments；
- context packs；
- cached prompts；
- graph edges；
- exports/backups。

你需要回答：MVP 里哪些派生物必须立即更新？哪些可以延后修复？

---

# 14. 好玩的实验

## Q14.1 早期最值得做哪 2-3 个玩具功能？

候选：

- memory inbox；
- `/why` 解释；
- 每日/每周群摘要；
- 梦境整理；
- 群梗候选；
- memory map；
- topic graph；
- self-reflection log；
- 用户专属 interaction style；
- sandbox skill learning。

你需要回答：最多选 2-3 个早期实验。

## Q14.2 要不要把记忆人格化？

可选：

- 不要，保持技术化；
- 只用轻微比喻；
- memory garden；
- dream 整理；
- archivist persona；
- 每个用户一个 memory creature。

风险：
人格化会掩盖隐私、正确性和控制边界。

你需要回答：你喜欢哪种尺度？

## Q14.3 要不要做周报/回顾？

可能类型：

- 用户私人周报；
- 群话题周报；
- memory changes review；
- unresolved questions review；
- bot self-correction review。

你需要回答：哪种真的有用，而不是只是可爱？

## Q14.4 要不要多 agent / 多人格？

可选：

- 不要；
- 只在后台 worker 命名上区分角色；
- prompt-layer personas；
- separate Pi sessions；
- 以后做 multi-agent orchestration。

建议 MVP 默认：
MVP 不做多 agent orchestration。

你需要回答：是否同意？

## Q14.5 什么样的好玩行为是安全的？

问题：
哪些玩法只操作低敏感数据，或者必须显式调用，因此可以早做？

你需要回答：你希望 LetheBot 第一眼“好玩”的点是什么？

---

# 15. MVP 范围与成功标准

## Q15.1 MVP demo 主故事是什么？

可选 demo story：

- “它接入 QQ，并通过 Pi 回复。”
- “它记住了用户偏好，并在之后使用。”
- “它记住了群规则，并遵守。”
- “它能解释为什么用了某条记忆。”
- “它能删除记忆，并停止使用。”
- “它能把一天群聊总结成 memory proposals。”
- “它因为 memory inbox / dream digest 显得好玩。”

你需要回答：MVP 最重要的演示故事是哪一个？

## Q15.2 最小可接受运行系统是什么？

候选 minimum：

- 一个 QQ 私聊；
- 一个 QQ 群；
- raw event persistence；
- Pi reply；
- manual active memory；
- context injection；
- memory source metadata；
- delete/disable；
- selected memory logging。

你需要回答：这个够不够？还缺什么？

## Q15.3 明确不进 MVP 的东西有哪些？

候选排除：

- 多平台；
- 完整 web UI；
- 关系图谱；
- 强 persona 系统；
- 后台自动 active memory；
- external vector DB；
- graph DB；
- plugin marketplace；
- 危险 sandbox tools；
- multi-agent orchestration。

你需要回答：确认或修改这个 non-goal 列表。

## Q15.4 第一个目标群应该是什么？

可选：

- 低频技术群；
- 高频朋友群；
- 私人测试群；
- 先只私聊；
- synthetic replay first。

风险：
高频社交群会在系统还不成熟时放大 attention、隐私、summary 的问题。

你需要回答：第一个真实测试环境是什么？

## Q15.5 MVP 跑多久算可用？

可选标准：

- 一次 live test 成功；
- 24 小时；
- 几天；
- 一周；
- 处理 N 条消息；
- 完成 N 次 memory 操作。

当前 docs 提到：一个群和私聊连续跑几天。

你需要回答：你的验收标准是什么？

## Q15.6 哪些情况算 MVP 失败？

候选失败条件：

- memory 不能 inspect；
- 删除 memory 后仍会被检索；
- 私聊记忆泄漏到群里；
- bot 在群里太吵；
- raw events 没有落库；
- context injection 没有日志；
- Pi 集成迫使 memory logic 进入 Pi 内部；
- Gateway 混入 reasoning；
- 用户不知道某条记忆为什么被用。

你需要回答：哪些是 hard blocker？

---

# 16. 需要调研的问题

## R16.1 Pi SDK 能力确认

需要确认：

- session lifecycle；
- event streaming；
- custom tool API；
- context transform hooks；
- tool call hooks；
- compaction primitives；
- abort/cancel support；
- error handling；
- model settings。

你需要回答：这部分是否作为实现前 P0 调研？

## R16.2 NapCat / OneBot 行为确认

需要确认：

- 私聊收发；
- 群聊收发；
- @ mention parsing；
- reply/quote metadata；
- reaction/emoji support；
- media metadata；
- reconnect；
- rate limits；
- message IDs；
- recall/delete events。

你需要回答：哪些协议能力必须先验证？

## R16.3 SQLite 扩展确认

需要评估：

- SQLite FTS；
- sqlite-vec；
- embedding storage；
- WAL + worker 并发；
- backup。

你需要回答：embedding 是否延后到 memory lifecycle 之后？

## R16.4 治理命令原型

需要 prototype：

- memory list/search/show；
- proposal inbox；
- delete/disable；
- turn explanation；
- source inspection。

你需要回答：CLI 原型是否是 MVP 早期里程碑？

## R16.5 记忆抽取质量测试

需要实验：

- 用户偏好抽取；
- 群规则抽取；
- summary faithful；
- conflict detection；
- joke/sarcasm false positives；
- sensitive info filtering。

你需要回答：上线前需要哪些离线 eval？

---

# 17. 建议讨论顺序

建议不要按文档自然顺序硬聊。推荐顺序：

1. MVP 主故事和 non-goals：Q15。
2. 产品身份、私聊/群聊边界：Q1-Q2。
3. 记忆生命周期和禁止写入规则：Q3。
4. 治理、删除、权限：Q4、Q13。
5. 群聊发言策略：Q5-Q6。
6. ContextPack 和 prompt layers：Q7。
7. Pi 边界和 tools：Q8-Q9。
8. 后台 worker：Q10。
9. 数据模型和 runtime 模块：Q11-Q12。
10. 玩具实验：Q14。
11. 调研任务：R16。

原因：
MVP 范围、社交边界、记忆治理应该约束架构，而不是实现后再补。

---

# 18. 决策记录模板

做出结论后，把它复制成下面的格式写进本节或单独的 ADR 文档。

```md
## Decision YYYY-MM-DD: 标题

状态：Accepted / Superseded / Deferred
标签：P0-MVP / P1-早期 / P2-以后 / 实验 / 策略 / 架构 / UX / 调研
回答的问题：
- Qx.y
决策：
理由：
后果：
需要更新的 docs/code：
复查时间：
```

---

# 19. 临时新增问题

讨论中冒出的新问题先放这里，再整理进对应章节。

- TBD
