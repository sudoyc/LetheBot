# Repair and Long-Term Development Goal Prompt

复制下面整段作为 LetheBot 后续“修复 + 长期完善”持续开发 prompt。它假设历史完成声明不可信，要求从当前证据出发；同时承认当前 deterministic baseline 可能已经恢复，但仍必须重新验证。

```text
You are working in /home/ycyc/projects/LetheBot.

Goal: execute LetheBot's repair + long-term development plan on the current worktree. Establish evidence first, recover broken gates if any, then continue the long-term architecture: QQ / OneBot / SnowLuma runtime, ingestion, identity, turn lifecycle, attention/evaluator/action executor, context orchestration, Pi runtime, governed memory, tools/sandbox/audit, durable workers, governance CLI/UI path, operations, tests, and acceptance.

Critical premise:
- Do not trust historical completion claims.
- Treat current worktree, command output, test results, and database behavior as authoritative.
- `docs/archive/**` is historical context only and never completion evidence.
- Do not commit unless the user explicitly allows commits.
- Do not expose or stage `.env`, logs, SQLite DBs, API keys, tokens, cookies, local secret files, or private QQ identifiers.

Required reading before changes:
1. `AGENTS.md`
2. `docs/README.md`
3. `docs/long-term-development-direction-review.md`
4. `docs/long-term-development-constraints.md`
5. `docs/next-full-implementation-plan.md`
6. `docs/architecture.md`
7. `docs/design-decisions.md`
8. `docs/contracts.md`
9. `docs/data-model.md`
10. `docs/sqlite-schema.md`
11. `docs/memory-system.md`
12. `docs/identity-model.md`
13. `docs/context-orchestration.md`
14. `docs/social-action-model.md`
15. `docs/agent-governance.md`
16. `docs/tool-registry.md`
17. `docs/pi-integration.md`
18. `docs/security-privacy.md`
19. `docs/test-strategy.md`
20. `docs/local-container-acceptance.md`
21. `docs/operations.md`
22. `docs/loop-state-recovery.md` if present

Baseline / drift audit commands:
```bash
git status --short
pnpm list @earendil-works/pi-agent-core @earendil-works/pi-ai --depth 0
pnpm typecheck
pnpm lint
pnpm test:run
```

Baseline rules:
- If `pnpm typecheck` or default deterministic `pnpm test:run` fails, do recovery only before feature expansion.
- If lint fails, either fix it or document a bounded exception plan approved by the user.
- Inspect untracked files. Do not blind-stage generated/scratch files.
- Check DB schema/FK assumptions before changing persistence code.

Phase R0: Baseline and drift audit.
- Read required docs.
- Run baseline commands.
- Identify missing/stale docs, broken imports, dependency drift, weak/skipped/real-gated tests, and dirty worktree hazards.
- Create/update `docs/loop-state-recovery.md` with date, commands, pass/fail, changed files, blockers, and next step.
- Do not start feature work before blocker list is known.

Phase R1: Build and deterministic test recovery.
- Fix package/import drift.
- Restore typecheck.
- Restore deterministic tests without real credentials.
- Gate real API/NapCat/SnowLuma tests behind explicit env/local conditions.
- Keep lint status green or documented.

Phase R2: Ingestion and persistence integrity.
- Raw events are written before derived rows.
- `chat_messages.raw_event_id` references a real raw event unless schema explicitly permits a legal synthetic event strategy.
- Fake private/group tests assert DB rows and FK validity.
- Event handling failures are observable.

Phase R3: Memory governance foundation.
- Durable memory writes go through governed services.
- Every durable memory write preserves `memory_records`, `memory_sources`, `memory_revisions`, and `audit_log` evidence.
- Deterministic secret/prohibited scanning runs before ordinary durable memory/prompt injection.
- Deleted/disabled/superseded/secret/prohibited/private-in-group exclusions are tested.
- Proactive-DM and memory-association opt-outs are durable, inspectable, and enforced.

Phase R4: Context and Pi runtime.
- Pi remains behind adapter/core interfaces and is mockable without real provider credentials.
- ContextBuilder owns retrieval, filtering, token budgeting, prompt assembly, and trace.
- Context traces include selected/rejected memory IDs, identity fields, reasons, and token evidence where supported.
- Failed Pi turns are observable, not silent success.

Phase R5: Tool, policy, sandbox, and audit hardening.
- Tool execution always passes through registry, policy gate, sandbox checks, audit, and output redaction.
- `evaluatorPolicy=bypass` does not bypass L0 policy, permissions, sandboxing, or audit.
- Secret-like tool output is redacted before audit or prompt injection.
- Path/network/shell/platform-admin tools are capability and permission checked.

Phase R6: Background workers and durable scheduling.
- Workers are idempotent and source-linked.
- Job rows, attempts, leases, heartbeats, retries, and idempotency keys are persisted.
- Runtime/in-process scheduler uses `JobRepository` leases for concrete summary/extraction/consolidation/decay/conflict/admin-digest/retention jobs where implemented.
- Worker failures are visible and do not corrupt chat path.

Phase R7: Governance CLI and explainability.
- CLI can inspect/filter/show/export memory and audit/action/tool/job/context/privacy state.
- CLI can approve/reject/disable/delete/restore/supersede memory with revision/audit evidence.
- `/why` or CLI equivalent shows redacted context trace.
- Add spawned CLI parser tests, not only service-level tests, for representative commands.

Phase R8: QQ / OneBot / SnowLuma production loop.
- Gateway stays protocol-only.
- Private/group fake OneBot paths cover mentions, replies, sender roles, group cards, quotes/media metadata where supported.
- Replies are delivered through action executor/response router.
- Real SnowLuma/QQ tests are manual or opt-in and never part of the default deterministic gate without explicit local configuration.
- If real local acceptance is run, read secrets only from local secret files such as `/tmp/pi_base_url` and `/tmp/pi_api_key`; never write their contents to repo.
- Generate redaction-first local evidence with `pnpm acceptance:evidence-template -- --out=/tmp/lethebot-acceptance-evidence.md`; before sharing or archiving a filled evidence file, run `pnpm acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md` and treat non-zero findings as blockers.

Phase R9: Long-term operations.
- Backup/restore/retention commands are documented and tested on temp DBs where possible.
- Metrics cover turns, memory writes, context traces, action decisions/executions, tool calls, jobs, and worker heartbeats.
- Health/readiness reports DB and adapter readiness without leaking credentials.
- Operations docs include actual commands and known failure modes.

Per-slice definition of done:
- Narrow relevant tests pass.
- `pnpm typecheck` passes.
- `pnpm lint` passes or has an approved documented exception.
- `pnpm test:run` passes unless a deterministic, user-approved exception is recorded.
- Persistence changes have temp/migrated SQLite tests with DB-level assertions and valid FKs.
- Docs are updated only for real behavior/contract/env changes.
- `docs/loop-state-recovery.md` records evidence and next step.

Final completion audit:
1. Re-read `docs/long-term-development-constraints.md`.
2. List every phase exit criterion.
3. For each criterion, cite current file paths, command evidence, and DB/test evidence.
4. Run final gates:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test:run
   ```
5. Do not claim the whole goal is complete unless current evidence proves every requirement and no required work remains.

Reporting format at each stopping point:
- Current phase and status.
- Commands run and results.
- Files changed.
- Evidence for completed criteria.
- Remaining risks/gaps.
- Next exact step.
```
