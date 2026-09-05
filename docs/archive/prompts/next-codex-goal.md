# Next Codex Goal Prompt

Copy the following block into the next Codex `/goal`.

```text
You are working in /home/ycyc/projects/LetheBot.

Goal: stabilize and continue LetheBot development from the current dirty worktree without repeating the previous endless micro-slice loop. Build fresh evidence, recover gates if needed, then perform exactly one high-value, coherent slice toward production readiness or worktree stabilization. Stop and report after that slice.

Required reading first:
1. AGENTS.md
2. docs/next-codex-project-state.md
3. docs/next-codex-constraints.md
4. docs/long-term-development-constraints.md
5. docs/long-term-development-direction-review.md only for latest evidence context, not as completion proof
6. docs/loop-state-recovery.md only for latest evidence context, not as completion proof
7. Domain docs relevant to the touched area only, such as:
   - docs/architecture.md
   - docs/contracts.md
   - docs/data-model.md
   - docs/sqlite-schema.md
   - docs/memory-system.md
   - docs/context-orchestration.md
   - docs/social-action-model.md
   - docs/agent-governance.md
   - docs/tool-registry.md
   - docs/pi-integration.md
   - docs/security-privacy.md
   - docs/test-strategy.md
   - docs/local-container-acceptance.md
   - docs/operations.md

Critical premises:
- Do not trust historical completion claims.
- Current worktree, command output, test results, and database assertions are authoritative.
- Do not commit, stage broad paths, delete untracked files, read secret files, or expose private QQ/platform identifiers unless explicitly authorized.
- Real SnowLuma/QQ production readiness is unproven unless a controlled local acceptance run is actually performed and evidence is validator-clean.
- Avoid continuing low-value parser/redaction micro-slices. Prefer stabilization, real acceptance, or a clearly missing architecture/data-integrity capability.

Fresh baseline:
```bash
date '+%Y-%m-%d %H:%M:%S %Z %z'
git status --short
git status --short | awk '{ total++; if ($1 ~ /^\?\?/) untracked++; else tracked++ } END { printf "tracked_dirty=%d untracked=%d total=%d\n", tracked+0, untracked+0, total+0 }'
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
pnpm typecheck
pnpm lint
pnpm test:run
git diff --check
```

If typecheck/lint/test fails:
- do recovery only;
- write or update a focused regression test when possible;
- stop after restoring the gate and report.

If baseline is green:
1. Produce a concise dirty-worktree inventory by subsystem.
2. Choose one high-value slice:
   - worktree stabilization / commit-group proposal;
   - controlled SnowLuma/QQ acceptance if the user explicitly authorizes and local runtime/secrets are available;
   - one missing production-readiness or data-integrity gap with DB-backed tests;
   - concise docs consolidation if code is already sufficient.
3. State why this slice is higher value than more redaction/parser variants.
4. Implement only that slice.
5. Run narrow relevant tests, then final relevant gate:
   - code slice: `pnpm typecheck && pnpm lint && pnpm test:run && git diff --check`
   - docs-only slice: `git diff --check` minimum
6. Update status docs concisely; do not paste huge logs.
7. Stop and report.

Definition of done for one slice:
- Changed lines all trace to the selected slice.
- Relevant tests pass.
- Typecheck/lint pass for code changes.
- Default deterministic tests pass for code changes unless the user approves a bounded exception.
- Persistence changes include DB-level assertions and clean FK evidence.
- Docs mention only verified behavior.
- Remaining gaps are explicit.

Reporting format:
- Current status and selected slice.
- Commands run and results.
- Files changed.
- Evidence-backed behavior.
- Remaining risks/gaps, especially real SnowLuma/QQ acceptance if still unrun.
- Recommended next exact step.
```
