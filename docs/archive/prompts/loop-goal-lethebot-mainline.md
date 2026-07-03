# LetheBot Mainline `/goal` Prompt

下面这段可以作为未来 `/goal` 或 `/loop` 的主启动 prompt。它不是让 agent 无脑一次性写完整系统，而是启动一个带 gate、checkpoint、阶段执行的长期开发循环。

```text
/goal Build LetheBot MVP through bounded phase-by-phase loop.

You are implementing LetheBot in /home/ycyc/projects/LetheBot.

Read these files first:
1. AGENTS.md  2. docs/README.md  3. docs/vision.md  4. docs/architecture.md
5. docs/architecture-flow-overview.md  6. docs/architecture-weight-assessment.md
7. docs/design-decisions.md  8. docs/mvp-roadmap.md  9. docs/tech-stack.md
10. docs/data-model.md  11. docs/security-privacy.md  12. docs/loop-engineering-prep.md
13. docs/contracts.md  14. docs/test-strategy.md  15. docs/fake-gateway-design.md
16. docs/sqlite-schema.md  17. docs/detailed-phase-tasks.md  18. docs/escalation-checklist.md

Docs are source of truth unless code contradicts them. If docs conflict, stop and record instead of guessing.

Core rules:
- P0: modular monolith, not microservices. Architecture boxes = logical boundaries, not deployment.
- SQLite first, in-process dispatcher, CLI governance first.
- Gateway adapts protocol only. Context Orchestrator owns prompt minimization + visibility filtering.
- Pi proposes actions; Action Executor does writes/sends/side effects.
- evaluatorPolicy: required|bypass controls LLM review only, never bypasses L0 policy/permissions/audit/sandbox.
- Most group messages don't call Pi. Low-risk replies don't call evaluator.
- Memory extraction async unless explicit remember. Deleted/disabled excluded immediately.
- Private memory not referenced in group by default.
- QQ IDs: operational identity data, not secrets. Inject minimal, structured, when needed.
- No hardcoded secrets/API keys/account IDs.

Loop discipline:
1. git status --short --branch, record dirty state.
2. Update docs/loop-state.md: phase, tasks, blockers, test commands, dirty boundaries, next step.
3. One phase at a time. Don't start next until gates pass.
4. Per phase: write failing tests first, minimal code, run tests, inspect diff, update docs if contracts changed, update loop-state.
5. Execution profiles: silent_fast_path, reply_fast_path, risk_path, tool_path, background_path, admin_governance_path.
6. Gates: Pre-flight before phase. Revision after task (max 3). Escalation for ambiguous product/security/design. Abort for unsafe repo/blocked deps/context degradation.
7. If context heavy, checkpoint and stop cleanly.
8. No commit unless instructed. Stage explicit paths only.

Phases: A. Repository foundation  B. Core contracts  C. Storage  D. Gateway simulator
E. NapCat adapter  F. Attention + profiles  G. Pi runtime  H. Context + memory v0
I. Tool registry  J. Evaluator/policy gate  K. Background workers  L. Governance CLI  M. Live soak

First action:
- Read docs. Inspect repo. Create/update docs/loop-state.md. Find first incomplete phase.
- Create todo for that phase only. Begin after pre-flight gate passes.

Report progress: phase, files changed, tests/commands + results, gates passed/failed, blockers, next step.
```
