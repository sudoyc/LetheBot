# Loop Engineering Preparation

这份文档用于回答：如果目标是先把 LetheBot 的架构、开发文档、prompt、验收标准准备充分，然后交给一条 `/goal` 或 `/loop` 进行超长期实现，应该怎么准备才稳。

结论：

- 这个方向是合理的，而且和当前设计文档的价值一致。
- 但不要期待“一条 prompt 直接无监督完成所有工作”。更稳的形态是：一条 `/goal` 启动主循环，主循环按阶段执行、每阶段有 gate、失败就 checkpoint/ask，而不是无限自动往前冲。
- 准备工作的重点不是继续堆架构，而是把“可执行上下文”补齐：contracts、schemas、phase plans、test gates、agent prompts、checkpoint 文件和失败恢复规则。

## 1. 当前准备状态

### 已经比较充分

当前 docs 已经覆盖：

- 产品愿景：`vision.md`
- 总体架构：`architecture.md`
- 完整流程图：`architecture-flow-overview.md`
- 架构重量评估：`architecture-weight-assessment.md`
- D1-D8 决策索引：`design-decisions.md`
- evaluator / policy / governance：`agent-governance.md`
- memory system：`memory-system.md`
- identity model：`identity-model.md`
- context orchestration：`context-orchestration.md`
- social action model：`social-action-model.md`
- tool registry：`tool-registry.md`
- Pi integration：`pi-integration.md`
- data model：`data-model.md`
- security/privacy：`security-privacy.md`
- MVP roadmap：`mvp-roadmap.md`
- operations / delivery checklist：`operations.md`, `delivery-checklist.md`

这些适合作为“长期边界蓝图”。

### 还不够充分

要让 `/goal` 或 `/loop` 更可靠，仍缺这些可执行层文档：

1. Contract pack
   - event envelopes
   - action decision schema
   - memory record schema
   - tool registry schema
   - context pack schema
   - gateway capability schema
   - error/result envelope

2. Implementation master plan
   - phase-by-phase task list
   - 每个 phase 的 files/tests/commands
   - 每个 phase 的 acceptance criteria
   - 每个 phase 的 rollback/checkpoint

3. Test strategy
   - unit test matrix
   - contract test matrix
   - integration smoke tests
   - fake OneBot/NapCat test harness
   - memory visibility regression tests
   - prompt/context redaction tests

4. Loop prompt pack
   - 一条 `/goal` 主启动 prompt
   - 每个 phase 的 worker prompt
   - reviewer prompt
   - final integration prompt
   - failure recovery prompt

5. State/checkpoint files
   - `docs/loop-state.md`
   - `docs/implementation-log.md`
   - `docs/known-risks.md`
   - `docs/phase-acceptance.md`

6. Agent operating rules
   - context budget discipline
   - gates taxonomy
   - no microservice overbuild
   - preserve dirty worktree boundaries
   - do not trust subagent self-report
   - main controller verifies tests/diffs

See also: `docs/escalation-checklist.md` for decisions the agent must ask the user about.

## 2. Recommended loop engineering model

Use one high-level `/goal` to start the effort, but make the goal itself a supervisor loop:

```text
/goal
Read the docs, create/update loop-state, execute exactly one bounded phase at a time, run gates, checkpoint, then continue only if gates pass. If a gate fails or context degrades, stop with a handoff.
```

Do not use a prompt that says:

```text
Implement the whole bot fully. Keep going until everything is done.
```

That will usually cause one of these failures:

- overbuilding;
- skipping tests;
- losing context;
- ignoring a design boundary;
- hiding partial failures;
- creating a large unreviewable diff;
- mixing code, docs, deployment, and prompt design in one uncontrolled loop.

## 3. Execution profiles for the development loop

The implementation loop should mirror the runtime architecture:

### 3.1 Planner path

Used at the beginning of each phase.

```text
read docs -> inspect repo state -> define exact phase tasks -> update loop-state -> start work
```

Output:

- updated todo;
- exact files to modify;
- expected tests;
- risk notes.

### 3.2 Implementation path

Used for code changes.

```text
write failing tests -> implement minimal code -> run tests -> update docs if needed -> checkpoint
```

Output:

- small diff;
- test output;
- phase log.

### 3.3 Review path

Used after implementation tasks.

```text
spec review -> quality review -> security/privacy review -> contract review
```

Output:

- PASS / REQUEST_CHANGES;
- concrete file:line issues;
- no vague “looks good”.

### 3.4 Integration path

Used at phase end.

```text
run narrow tests -> run broader tests -> inspect git diff -> update loop-state -> commit only if instructed
```

Output:

- verification evidence;
- changed files;
- known risks;
- next phase recommendation.

### 3.5 Handoff path

Used when context is getting heavy, a gate fails, or the agent must stop.

```text
write loop-state -> write implementation-log -> summarize current phase -> list next exact command/prompt
```

Output:

- fresh-session-ready handoff;
- no hidden state only in chat.

## 4. Gates

Every long loop needs named gates.

### 4.1 Pre-flight gates

Before each phase:

- repo status captured;
- required docs exist;
- current phase has acceptance criteria;
- dependencies understood;
- no unrelated dirty files will be touched;
- test command known, or missing test command is documented.

If this fails: do not start implementation.

### 4.2 Revision gates

After each task:

- spec compliance review;
- code quality review;
- tests pass;
- docs updated if behavior changed;
- no accidental scope creep.

If this fails: revise up to 3 cycles, then escalate.

### 4.3 Escalation gates

Ask the human when:

- product behavior is ambiguous;
- design docs conflict;
- a test requires real credentials or live QQ environment;
- a phase wants to delete or rewrite existing work;
- a security/privacy boundary is unclear;
- repeated revision cycles do not converge.

### 4.4 Abort gates

Stop and checkpoint when:

- context is degraded enough that the agent starts becoming vague;
- dependency/network/API access blocks progress;
- tests are failing for unclear reasons;
- a subagent/tool attempts out-of-scope destructive changes;
- repo state becomes unsafe.

## 5. What one `/goal` should actually do

A good `/goal` should not just say “build LetheBot”. It should encode this behavior:

1. Read the canonical docs.
2. Treat docs as source of truth unless live code contradicts them.
3. Capture git status.
4. Create `docs/loop-state.md` if missing.
5. Pick the next incomplete phase.
6. Convert that phase into bite-sized tasks.
7. Implement only that phase.
8. Run tests and contract checks.
9. Update docs if implementation reveals drift.
10. Write a checkpoint.
11. Continue to the next phase only if gates pass and context remains healthy.
12. Stop with a handoff if blocked.

## 6. Recommended phase order

The current MVP roadmap is good, but for loop engineering it should be expanded into executable phases:

### Phase A: Repository foundation

Goal:

- TypeScript/Node project skeleton.
- Test runner.
- Lint/typecheck.
- Config loader.
- Structured logging.

Acceptance:

- `pnpm test`, `pnpm typecheck`, `pnpm lint` exist and pass.
- `.env` is ignored.
- No runtime bot behavior yet.

### Phase B: Core contracts

Goal:

- Define event envelope, action decision, context pack, memory record, tool registry schemas.

Acceptance:

- Schema unit tests pass.
- Invalid examples fail validation.
- Docs examples match schema.

### Phase C: Storage foundation

Goal:

- SQLite + migrations.
- raw events, identity, memory, audit base tables.

Acceptance:

- migrations run on empty DB;
- repository tests pass;
- deletion/disable retrieval invariant tested.

### Phase D: Gateway simulator first

Goal:

- Fake OneBot/Gateway test harness before live NapCat.

Acceptance:

- simulated private/group message becomes internal event;
- raw event is persisted;
- response router can send to fake sink.

### Phase E: NapCat / OneBot adapter

Goal:

- Real gateway adapter behind the same contract.

Acceptance:

- can connect/send/receive in a controlled environment, or skip live test with documented missing credentials.

### Phase F: Attention + execution profiles

Goal:

- implement silent_fast_path and reply_fast_path.

Acceptance:

- ordinary group message does not call Pi;
- @bot/private message routes to Pi path;
- suppressors/cooldown have tests.

### Phase G: Pi runtime adapter

Goal:

- Pi SDK adapter behind a local ReasoningCore interface.

Acceptance:

- fake model tests pass;
- real model smoke can be optional behind env;
- Pi proposes ActionDecision, not direct side effects.

### Phase H: Context builder + memory v0

Goal:

- manual memory create/search/delete;
- ContextPack visibility/sensitivity filtering.

Acceptance:

- private_only not injected into group;
- deleted/disabled memory excluded immediately;
- selected memory IDs logged.

### Phase I: Tool registry v0

Goal:

- register safe tools and policy metadata.

Acceptance:

- dangerous tool without permission denied;
- evaluatorPolicy bypass does not bypass permissions/audit;
- tool result redaction test exists.

### Phase J: Evaluator/policy gate v0

Goal:

- risk path for memory auto-active, proactive DM, dangerous tools.

Acceptance:

- low-risk memory can active;
- high-risk becomes proposal/admin digest;
- L0 invariants cannot be bypassed.

### Phase K: Background workers

Goal:

- summary/extraction worker loop.

Acceptance:

- worker is idempotent;
- source links preserved;
- does not block reply path.

### Phase L: Governance CLI

Goal:

- inspect/delete/disable memory;
- why trace;
- display profile/nickname deletion basics.

Acceptance:

- deletion immediately affects retrieval;
- CLI output is machine-readable where useful.

### Phase M: Live MVP soak

Goal:

- one QQ private chat and one group running for several days.

Acceptance:

- reply latency tracked;
- no ordinary group spam;
- memory use inspectable;
- failures generate useful logs.

## 7. Prompt preparation principles

The prompt pack should include these invariants:

### 7.1 Do not overbuild

- Do not split services unless a phase explicitly asks.
- P0 is modular monolith.
- Event bus is in-process first.
- SQLite first.
- CLI governance first.

### 7.2 Do not flatten policy

- `evaluatorPolicy` is not `enabled`.
- bypass means bypass LLM evaluator only.
- L0 policy always applies.
- Pi proposes; executor mutates.

### 7.3 Protect conversation UX

- Most ordinary group messages should not call Pi.
- Low-risk replies should avoid evaluator.
- Memory extraction is async unless explicit remember.
- Long output should fold/DM/digest/summarize.

### 7.4 Preserve auditability

- raw event first when feasible;
- action decision IDs;
- memory source IDs;
- selected memory IDs;
- redacted audit for risky paths.

### 7.5 Maintain docs as contracts

- If implementation changes a schema, update docs and tests in the same phase.
- If docs conflict, stop and escalate rather than guessing.

## 8. Suggested prep artifacts to add next

Highest value next docs:

1. `docs/contracts.md`
   - all TypeScript interface sketches and JSON schema decisions.

2. `docs/test-strategy.md`
   - test matrix and required regression cases.

3. `docs/plans/lethebot-mainline-implementation-plan.md`
   - phase A-M expanded into bite-sized implementation tasks.

4. `docs/prompts/loop-goal-lethebot-mainline.md`
   - copy-paste `/goal` prompt.

5. `docs/loop-state.md`
   - mutable checkpoint file for loop execution.

6. `docs/agent-review-prompts.md`
   - spec reviewer, quality reviewer, security/privacy reviewer prompts.

## 9. Final recommendation

Yes, continue preparing before launching `/goal` or `/loop`.

But define “prepared” as:

- architecture decisions are documented;
- contract schemas are explicit;
- phase tasks are executable;
- tests/gates are known;
- prompt pack is copy-pasteable;
- loop state can survive context resets;
- implementation is modular monolith, not premature microservices.

Once those exist, a long-running loop has a real chance of progressing safely. Without them, a single `/goal` will probably produce a large, partially working, hard-to-review prototype.
