# Long-Term Development Direction Review

**Date:** 2026-07-02
**Scope:** 依据当前 `docs/` 设计文档、roadmap、post-MVP 计划和当前 worktree review 结果，整理 LetheBot 的长期开发方向，并诊断路线与执行状态是否健康。

## Executive Summary

LetheBot 的长期方向本身是健康的：它不是“套一个向量库的聊天机器人”，而是一个本地优先、可治理、有审计边界的 QQ 长期记忆 agent。核心产品判断清晰：

- 先把 QQ / NapCat / OneBot 跑通，而不是过早多平台抽象。
- 把记忆系统作为一等模块，而不是 Pi/LLM 的附属上下文。
- 让用户能检查、禁用、删除、追溯长期记忆。
- 将 Gateway、Ingestion、Memory、Context、Pi、Policy、Tools、Workers 分层。

但当前执行状态不健康：文档中的“完成”叙述、实际代码、测试结果三者已经发生明显漂移。下一轮长期开发不应继续沿用“Post-MVP 已完成大半”的假设，而应先进入 **Recovery / Stabilization**，把真实基线修复到可信，再推进长期增强。

## Source Documents Considered

主要依据：

- `docs/vision.md`
- `docs/architecture.md`
- `docs/design-decisions.md`
- `docs/memory-system.md`
- `docs/context-orchestration.md`
- `docs/agent-governance.md`
- `docs/tool-registry.md`
- `docs/security-privacy.md`
- `docs/mvp-roadmap.md`
- `docs/POST-MVP-GAP-ANALYSIS.md`
- `docs/detailed-phase-tasks-post-mvp.md`
- `docs/loop-state.md`
- `docs/loop-state-post-mvp.md`
- `docs/MVP-COMPLETE.md`
- `docs/pi-agent-integration.md`
- 当前 worktree 与验证命令输出

## Long-Term Direction Map

### 1. Product Direction: Local-first Governable Memory Bot

长期目标是一个持久本地聊天机器人：能在 QQ 私聊/群聊中长期记住人、群、项目、偏好、规则与流程，同时允许用户治理这些记忆。

这条方向是健康的，因为它聚焦在一个高价值差异点：**记得住，但能解释、能忘记、能删掉**。

长期能力应包括：

- user / group / conversation / system scoped memory;
- inspect / disable / delete / supersede memory;
- visible source metadata and revisions;
- opt-out and unlink flows;
- raw event retention policy;
- answer `/why` / trace for context injection.

### 2. Platform Direction: QQ First, Multi-platform Later

当前 docs 一致要求先把 QQ / NapCat / OneBot 做实。多平台抽象是远期能力，不应阻碍 QQ MVP。

健康点：

- 避免过早抽象。
- Gateway 只适配协议，不参与记忆/推理。
- Gateway capability reporting 可以为 reaction / folded forward / admin actions 做降级。

风险点：

- 当前 OneBot adapter 是简化 HTTP 版本，事件解析、鉴权、回执、错误路径和异步处理都还不够生产化。

### 3. Architecture Direction: Modular Monolith with Strong Boundaries

文档明确强调逻辑边界，不要求微服务。长期应保持模块化单体：

```text
Gateway -> Ingestion -> Raw Event Store
                     -> Attention
                     -> Identity
Memory -> Context Orchestrator -> Pi Runtime -> Policy/Tools/Executor -> Gateway
Workers -> Memory / Summaries / Evaluator / Governance
```

健康点：

- 边界清晰，适合逐步演进。
- 支持 fast path / risk path / background path 分流。

风险点：

- 当前 `src/index.ts` 已经把 ingestion、identity、raw event store、context、Pi、reply、memory extraction 混在一个 handler 里，后续必须拆出可测试的 orchestrator/service 层。

### 4. Memory Direction: Thick Memory, Not Just Vector Search

长期方向明确：raw events 不是 memory；memory records 需要 scope、visibility、sensitivity、authority、source、confidence、state、revision。

健康点：

- 设计已经覆盖 source metadata、visibility/sensitivity、rollback、governance。
- 明确 group-chat-to-user-memory 需要更严规则。

风险点：

- 当前实现中自动提取直接 active，且没有完整 `memory_sources` / `memory_revisions` / `audit_log` 链路。
- secret/prohibited 内容过滤尚未形成硬门。

### 5. Context Direction: Explicit Context Orchestration

长期目标是让 ContextBuilder 负责检索、裁剪、排序、token budgeting 和 trace，而不是简单 dump 最近消息。

健康点：

- 文档定义了 context injection 顺序和可观察性。
- 强调身份字段最小化注入。

风险点：

- 当前 ContextBuilder 的 retrieval 较粗，未完整处理 sensitivity、source trace、group/conversation summary、identity injection reasons。

### 6. Pi Direction: Pi Owns Reasoning, Not Storage or Execution

长期目标是 Pi SDK embedded integration。Pi 应只做 reasoning、tool proposal、turn state，不应直接写 durable memory 或执行危险工具。

健康点：

- 文档边界正确。
- Tool hook 和 PolicyGate 的设计方向正确。

风险点：

- 当前 Pi import/dependency 已断，导致 typecheck/test 主链路失败。
- Tool handler 类型和运行时形态不一致。

### 7. Governance / Policy Direction

长期方向是：LLM evaluator 可以判断模糊风险，但 L0 hard policy 是确定性边界。

健康点：

- `evaluatorPolicy: required | bypass` 的语义清楚。
- bypass 只跳过 LLM evaluator，不跳过 permission / audit / sandbox / L0。

风险点：

- 当前实现中 audit 和 evaluator 多数还是 stub/TODO。
- Tool output secret scanning 当前不实际扫描。

### 8. Tool Direction

长期目标是 tool registry + policy + sandbox + audit 的工具系统。

健康点：

- 文档的 metadata categories 是对的。
- 文件工具已有雏形。

风险点：

- Registry 的 `handler` 类型与 PiAdapter 运行时调用冲突。
- Sandbox policy 没有系统性执行。
- Path validation 需进一步硬化路径前缀边界。

### 9. Operations Direction

长期需要 systemd/pm2/docker、healthcheck、backup、retention、observability。

健康点：

- 有部署与 troubleshooting 文档雏形。
- 有 health endpoint。

风险点：

- 部署脚本测试会在 repo root 写生成物。
- 当前 `docker-compose.yml` 显示为 deleted，说明部署资产状态混乱。

## Health Diagnosis

| Area | Direction Health | Implementation Health | Diagnosis |
|---|---:|---:|---|
| Product vision | 8/10 | 4/10 | 愿景聚焦，但现状离可用产品仍远。 |
| Architecture boundaries | 8/10 | 3/10 | 文档边界清晰，主入口实现趋向“大 handler”。 |
| Memory governance | 9/10 | 2/10 | 设计非常强，实现违反 source/revision/audit/secret gate。 |
| Context orchestration | 8/10 | 4/10 | 方向正确，实现仍是最小检索和粗过滤。 |
| Pi integration | 7/10 | 2/10 | 思路正确，当前依赖/import 断裂。 |
| Tool policy | 8/10 | 3/10 | Metadata 方向对，handler/audit/sandbox 未闭环。 |
| Testing | 7/10 | 3/10 | 测试很多，但关键路径和实际失败被掩盖。 |
| Documentation process | 7/10 | 3/10 | 文档丰富，但“完成状态”与事实漂移。 |
| Operations | 6/10 | 3/10 | 有初稿，尚未形成可靠部署闭环。 |

**Overall:** 方向健康，执行链路不健康。应停止继续声明 MVP/Post-MVP 完成，先做 evidence-based recovery。

## Unhealthy Symptoms

### 1. Completion Drift

多个文档声明 MVP / Phase N 已完成，但当前验证显示：

- `pnpm typecheck` fails;
- `pnpm lint` fails;
- `pnpm test:run` fails;
- Pi-related suites cannot load;
- summary-worker tests fail;
- persistence implementation存在外键断裂风险。

这说明 loop-state / completion report 不能作为事实来源，只能作为历史叙事。

### 2. Tests Are Not Strong Enough as Product Evidence

HTTP tests 能验证 200，但不能证明异步事件处理成功。部分 E2E tests 以 mock 或 skipped real API 路径为主，容易高估系统健康度。

下一步测试必须转向：

- DB rows actually written;
- foreign keys valid;
- context contains expected history/memory;
- deleted/disabled/secret memories excluded;
- webhook failure visibility;
- audit/revision/source rows created.

### 3. Governance Intent Not Enforced

设计中最关键的 privacy/governance 是 LetheBot 的产品护城河，但当前 implementation 尚未强制：

- secret scanning stub;
- memory auto-active direct write;
- missing memory_sources/revisions/audit;
- search path missing boundary filters.

### 4. Implementation Pressure Created Shortcuts

多处代码显示“先让测试过”的痕迹：

- hard-coded temporary IDs;
- direct SQL in app handler;
- summary prompt unused;
- dependency/import drift;
- stale docs claiming completion.

后续长期开发必须把“快速推进”改成“证据驱动推进”。

## Healthy Long-Term Development Strategy

### Reset Premise

未来所有 `/goal` prompt 必须从以下前提出发：

1. 当前 worktree 是唯一事实来源。
2. 文档中的 completion claims 均需重新验证。
3. 先修复 build/type/test baseline，再继续功能开发。
4. 不用“测试很多”代表“核心链路健康”。
5. 对 memory/privacy/tool/audit 的要求是 P0，不是 polish。

### Recovery Before Expansion

长期开发应分两段：

#### Stage A: Recovery / Stabilization

目标：让仓库重新达到可信可迭代状态。

必做：

- restore typecheck;
- restore deterministic tests;
- fix dependency drift;
- fix event/chat persistence integrity;
- separate ingestion/orchestration from HTTP handler;
- repair config/docs drift;
- remove or quarantine stale completion docs.

#### Stage B: Governed Product Growth

目标：在稳定基线之上补完整产品能力。

长期方向：

- memory proposal/evaluator/action-executor pipeline;
- source/revision/audit complete lifecycle;
- context trace and `/why`;
- group summary and conversation summary;
- tool sandbox/audit/secret scanning;
- real QQ soak test;
- governance CLI -> lightweight UI;
- retention/backup/metrics/ops.

## Recommended Phase Model

Use the new prompt in `docs/prompts/repair-and-long-term-development-goal.md` and constraints in `docs/long-term-development-constraints.md`.

High-level phases:

1. **R0 Baseline & Evidence Reset** — capture real status, mark stale docs as unverified.
2. **R1 Build & Test Recovery** — make typecheck and deterministic test subset pass.
3. **R2 Ingestion & Persistence Integrity** — raw_events/chat_messages/agent turns with valid FK and tests.
4. **R3 Memory Governance Foundation** — sources/revisions/audit/secret gate/proposal flow.
5. **R4 Context & Pi Runtime Recovery** — stable Pi abstraction, no broken deps, correct context conversion.
6. **R5 Tool & Policy Hardening** — handler resolution, sandbox, audit, secret scanning.
7. **R6 Background Summaries & Retrieval Quality** — summaries use real messages and source links.
8. **R7 Governance CLI & Explainability** — inspect/delete/disable/why with trace visibility.
9. **R8 QQ Production Loop** — NapCat real endpoint, response router, soak test readiness.
10. **R9 Long-Term Ops** — backup, retention, metrics, deployment reproducibility.

## What Success Looks Like

A future “healthy” LetheBot state must be proven by evidence:

- `pnpm typecheck` passes.
- `pnpm lint` is either passing or has a documented rule exception list.
- deterministic `pnpm test:run` passes without real API credentials.
- live/real API tests are explicitly gated and not part of default green path.
- a fake OneBot event results in valid raw_events + chat_messages + context trace.
- memory extraction creates proposal/source/revision/audit records.
- deleted/disabled/superseded/secret/prohibited memory is excluded from ordinary retrieval immediately.
- ContextPack trace records selected/rejected memory IDs and reasons.
- tool calls are permission checked, sandboxed, audited, and secret-scanned.
- docs status pages match current command evidence.
