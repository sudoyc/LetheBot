# LetheBot Autonomous `/goal` Prompt (Phase C-M 自主完成)

用于在 Phase B 完成后，自主推进到 Phase M。

```text
/goal Complete LetheBot MVP Phase C-M autonomously.

Working directory: /home/ycyc/projects/LetheBot

Status: ✅ Phase A+B done. Starting Phase C (Storage).

## Autonomous Mode
- Auto-continue through Phase C-M
- Stop only for: critical errors, missing creds, or context >85%
- Update docs/loop-state.md after each phase
- Use safe defaults for escalations (below)

## Safe Defaults (Escalation Auto-Decisions)
- Missing Pi API key (Phase G): Create MockPi with placeholders, mark "mock"
- Missing NapCat (Phase E): Test with FakeOneBot, mark "deferred to M"
- Memory threshold (Phase H): confidence >0.8 auto-active, same_user_any_context for medium-risk
- Cooldowns (Phase F): own message 60s, repeated @bot 10s, high-speed >5msg/10s
- Platform admin (Phase I): set_group_card/kick/mute = platform_admin, get_member_list = network

## Docs (read on entering phase)
Core: AGENTS.md (once at start)
C: sqlite-schema.md, data-model.md
D: fake-gateway-design.md, test-strategy.md
E: architecture.md (Gateway)
F: social-action-model.md
G: pi-integration.md
H: memory-system.md, context-orchestration.md
I: tool-registry.md
J: agent-governance.md
K: architecture.md (Workers)
L: security-privacy.md (governance)
M: operations.md, delivery-checklist.md

Read detailed-phase-tasks.md for implementation details.

## Rules (from AGENTS.md)
- Modular monolith, SQLite first, in-process dispatcher
- Gateway adapts protocol. Context Orchestrator filters. Pi proposes. Executor executes.
- Deleted/disabled excluded immediately. Private not in group.
- No hardcoded secrets. evaluatorPolicy = LLM review only, never bypasses L0.

## Per-Phase Flow
1. Read phase docs + detailed-phase-tasks.md
2. Check loop-state.md
3. Write failing tests first
4. Implement minimal code
5. Run: pnpm typecheck && pnpm lint && pnpm test
6. Fix errors (max 3 attempts)
7. Update loop-state.md: mark done, list files, note what's mocked
8. Auto-continue to next phase

## Phases (brief)
C: SQLite schema + repositories (Memory, Event, Identity)
D: FakeOneBot test harness + integration tests
E: OneBotAdapter (WebSocket). If no NapCat: test with Fake, mark mock.
F: AttentionEngine + execution profiles (silent/reply/risk paths)
G: PiSdkAdapter. If no key: MockPi, mark mock.
H: ContextBuilder + MemoryRetrieval with visibility filtering
I: ToolRegistry + echo tool
J: PolicyGate (L0) + Evaluator stub
K: Background workers (summary + extraction)
L: Governance CLI (list/delete memory, /why)
M: Deployment checklist + smoke test

## Checkpointing
Every 2 phases: write full checkpoint to loop-state.md (phases done, structure, what's mocked, next step).
If context >85%: stop immediately, write handoff.

## Reporting (after each phase)
```
Phase X ✅
Built: [files]
Tests: pass X / total Y
Next: Phase Z
Context: X%
```

## Stop Conditions
1. Critical error after 3 fix attempts
2. Context >85%
3. Phase M complete
4. User interrupt

Begin Phase C now. Target: complete C-M without stopping.
```

**字符数:** ~2850 ✅ (低于 4000)