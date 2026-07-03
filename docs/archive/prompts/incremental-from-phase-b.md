# LetheBot Incremental `/goal` Prompt (从 Phase B 开始)

适用于已完成 Phase A 的情况，逐步推进而不是一次性加载全部文档。

```text
/goal Continue LetheBot MVP from Phase B onwards.

Working directory: /home/ycyc/projects/LetheBot

## Current Status
Phase A ✅ completed:
- Repository, pnpm, TypeScript, ESLint, Vitest configured
- Basic project structure exists

Starting from: Phase B (Core Contracts)

## Essential Docs (read only when needed)
Core: AGENTS.md, docs/loop-state.md
Phase B: docs/contracts.md, docs/detailed-phase-tasks.md (Phase B section)
Phase C: docs/sqlite-schema.md, docs/data-model.md
Phase D+: Read relevant docs when you reach that phase

Do NOT read all 18 docs upfront. Read on-demand to preserve context.

## Core Rules (abbreviated)
- Modular monolith, not microservices
- SQLite + in-process first
- Gateway = protocol adapter only
- Pi proposes, Executor executes
- Deleted/disabled memory excluded immediately
- Private memory not in group context
- No hardcoded secrets/keys/IDs
- evaluatorPolicy: required|bypass = LLM review only, never bypasses L0 policy

## Loop Discipline
1. Check docs/loop-state.md for current phase
2. Update loop-state.md: phase, tasks, blockers, next step
3. One phase at a time, gates between phases
4. Write failing tests first, minimal code, run tests, inspect diff
5. Gates: Pre-flight, Revision (max 3), Escalation, Abort
6. If context >70%, checkpoint to loop-state.md and stop
7. No commit unless instructed

## Phases
B. Core contracts - implement contracts.md interfaces
C. Storage foundation - SQLite schema + migrations
D. Gateway simulator - FakeOneBot test harness
E. NapCat adapter - real OneBot (escalate if no creds)
F. Attention + profiles - execution paths
G. Pi runtime - Pi SDK adapter (escalate if no API key)
H. Context + memory v0 - ContextPack + retrieval
I. Tool registry v0 - tool metadata
J. Evaluator/policy gate - policy checks
K. Background workers - async summaries
L. Governance CLI - inspect/delete memory
M. Live soak - real QQ multi-day test

## Your First Actions
1. Read docs/loop-state.md to confirm phase
2. Read docs/contracts.md (Phase B requirement)
3. Read docs/detailed-phase-tasks.md Phase B section
4. Create todo for Phase B tasks only
5. Implement one task at a time
6. Update loop-state.md after each task
7. Run gates before moving to Phase C

## Reporting
Each update: phase, files changed, tests run + results, gates status, blockers, next exact step.

## Context Management
If you notice context getting heavy (>70%), immediately:
1. Update loop-state.md with current progress
2. Write detailed next-step instructions
3. Stop cleanly with handoff message

Begin Phase B now.
```