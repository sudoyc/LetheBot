# LetheBot Final Sprint `/goal` Prompt (Phase K-M)

完成最后 3 个 Phase，完成 MVP。

```text
/goal Complete LetheBot MVP Phase K-M (final 3 phases).

Working directory: /home/ycyc/projects/LetheBot

Status: ✅ Phase A-J done (10/13). Remaining: K, L, M.

Progress so far:
- 2186 lines TypeScript code
- 33 src files, 23 test files
- 230+ tests passing
- Storage, Gateway, Pi (Mock), Context, Tools, Policy all implemented

## Autonomous Mode
- Auto-continue through Phase K-M
- Stop only for: critical errors or context >85%
- Update docs/loop-state.md after each phase
- Use safe defaults (already applied in Phase E, G)

## Phase K: Background Workers
Docs: docs/architecture.md (Background Workers section)

Tasks:
- Implement summary worker (simple interval-based)
- Implement memory extraction worker
- Wire to memory proposal flow
- Tests: workers can be triggered, produce output

Implementation:
- Use setInterval or simple cron for P0
- Workers read from storage, write proposals to memory_records with state='proposed'
- Keep workers idempotent
- Files: src/workers/summary.ts, src/workers/extraction.ts

Acceptance:
- Can trigger summary worker manually
- Can trigger extraction worker manually
- Workers write to database
- 5+ tests passing

## Phase L: Governance CLI
Docs: docs/security-privacy.md (governance section), docs/memory-system.md

Tasks:
- Implement memory list/delete/disable commands
- Implement /why command (show context pack for a turn)
- Simple CLI with commander or yargs
- Tests: can list and delete memory

Implementation:
- CLI tool: src/cli/governance.ts
- Commands: list-memory, delete-memory, disable-memory, why
- Use existing repositories (MemoryRepository, IdentityRepository)
- Format output as table or JSON

Acceptance:
- pnpm cli list-memory works
- pnpm cli delete-memory <id> works
- pnpm cli why <turn-id> works
- 5+ CLI tests passing

## Phase M: Deployment & Documentation
Docs: docs/operations.md, docs/delivery-checklist.md

Tasks:
- Write deployment checklist
- Document how to connect real NapCat
- Document how to add real Pi API key
- Create smoke test script
- Update README with quick start

Implementation:
- Update README.md with setup instructions
- Create docs/deployment.md with real integration steps
- Create scripts/smoke-test.ts
- Note which parts are mocked (NapCat, Pi)

Acceptance:
- README has clear setup instructions
- docs/deployment.md documents real integrations
- Smoke test can be run
- All phases documented in loop-state.md

## Rules (same as before)
- Modular monolith, SQLite first
- Gateway adapts protocol. Context filters. Pi proposes. Executor executes.
- Write failing tests first
- Run: pnpm typecheck && pnpm lint && pnpm test
- Fix errors (max 3 attempts)
- Update loop-state.md after each phase

## Per-Phase Flow
1. Read phase docs
2. Check loop-state.md
3. Write failing tests
4. Implement minimal code
5. Run tests, typecheck, lint
6. Update loop-state.md: mark done, list files
7. Auto-continue to next phase

## Checkpointing
After Phase L: write full checkpoint to loop-state.md.
If context >85%: stop immediately with handoff.

## Reporting (after each phase)
```
Phase X ✅
Built: [files]
Tests: pass X / total Y
Next: Phase Z (or MVP COMPLETE)
Context: X%
```

## Stop Conditions
1. Critical error after 3 fix attempts
2. Context >85%
3. Phase M complete (MVP DONE!)
4. User interrupt

Begin Phase K now. Target: complete K-M and finish MVP.
```

**字符数:** ~3100 ✅