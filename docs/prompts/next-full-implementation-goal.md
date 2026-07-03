# `/goal` Prompt: Complete LetheBot Full Functionality

复制下面整段作为下一轮长期开发 prompt。

```text
You are working in /home/ycyc/projects/LetheBot.

Goal: complete all core LetheBot functions described by the canonical docs, not only MVP/private-message reply. Finish the full architecture: OneBot/SnowLuma runtime, ingestion, identity, turn lifecycle, attention/evaluator/action executor, context orchestration, Pi runtime, memory lifecycle, tools/sandbox/audit, background workers, governance CLI/UI path, operations, tests, and local/container acceptance.

Start rules:
1. Read AGENTS.md first.
2. Read these docs before changing code:
   - docs/README.md
   - docs/long-term-development-constraints.md
   - docs/next-full-implementation-plan.md
   - docs/architecture.md
   - docs/design-decisions.md
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
3. Do not trust docs/archive/* as completion evidence. Archive files are historical context only.
4. Do not commit or expose `.env`, logs, SQLite DBs, API keys, cookies, tokens, or private QQ identifiers.
5. Make surgical changes. Do not refactor unrelated code. Prefer explicit schemas and service boundaries.

Baseline gate before feature work:
- Run `git status --short` and inspect untracked files.
- Run `pnpm typecheck`.
- Run `pnpm test:run` or a clearly justified deterministic subset if the full suite is temporarily blocked.
- Run `pnpm lint` or record current lint debt.
- If baseline fails, do recovery first. Do not add unrelated features on top of a broken baseline.

Implementation order:
Phase 1: Persist turn lifecycle.
- One stable turnId per non-silent response candidate.
- Persist `agent_turns` status transitions and link trigger raw event, context, model/provider, response, tokens, failures.
- Tests must assert DB rows and FK validity.

Phase 2: Persist action decisions and route replies through an ActionExecutor/ResponseRouter.
- Convert Attention/Pi/evaluator outputs into `ActionDecision` / `ActionPlan`.
- Persist `action_decisions` and `action_executions`.
- Replace direct send-message behavior in the main chain with executor/router calls.
- Tests must cover private reply, group silent, group @bot reply, and send failure.

Phase 3: Complete social evaluator and cooldowns.
- Keep AttentionEngine deterministic and fast.
- Wire risk/gray `needs_evaluation` path through a structured evaluator.
- Add cooldown/budget suppressors and downgrade behavior.
- Persist evaluator/action reasoning.

Phase 4: Complete context trace.
- Persist or reconstruct context packs/blocks/links.
- Record selected and rejected memory IDs with reasons.
- Record injected identity fields and token budget based on actual text.
- Ensure forbidden memory is never injected.

Phase 5: Complete governed memory lifecycle.
- Add memory candidate/proposal service.
- Apply deterministic secret/prohibited scanning.
- Invoke memory evaluator/risk classifier for auto-active decisions.
- Implement approve/reject/disable/delete/restore/supersede/conflict handling.
- Preserve sources, revisions, audit, and FTS consistency.

Phase 6: Complete tool governance.
- Ensure every tool has capabilities, permissions, evaluator policy, audit level, sandbox policy, and output sensitivity.
- Persist tool calls and audit rows.
- Enforce path/network/execution limits and secret scanning.

Phase 7: Complete background workers.
- Add job records, attempts, leases/heartbeats, retries, idempotency keys.
- Register summary/extraction/consolidation/decay/conflict/admin-digest workers.
- Workers must preserve source links and avoid duplicate durable memory on retry.

Phase 8: Complete governance CLI/UI path.
- CLI first: list/filter/show memory, approve/reject proposals, disable/delete/restore/supersede, export, why/context trace, audit/action/tool inspection, display profile redaction, proactive-DM and memory-association opt-outs.
- Add tests on temp SQLite.

Phase 9: Runtime acceptance and docs.
- Keep default tests deterministic and fake/runtime-local.
- Keep real DeepSeek/Pi tests gated by explicit env vars.
- Keep real SnowLuma/QQ tests manual or opt-in.
- If local real acceptance is needed and files exist, inject secrets from `/tmp/pi_base_url` and `/tmp/pi_api_key`; never write their contents to the repo.
- Update docs only when behavior/contracts/envs change.

Commit rules:
- Commit逐功能, small and reversible.
- Before each commit run:
  - `git status --short`
  - `git diff -- <explicit paths>`
  - `git add <explicit paths only>`
  - `git diff --cached --stat`
  - `git diff --cached -- <explicit paths>`
- Never use broad `git add .`.
- Use concise commit messages, for example:
  - `feat(turns): persist agent turn lifecycle`
  - `feat(actions): route replies through action executor`
  - `feat(memory): add governed proposal lifecycle`
  - `test(acceptance): cover full fake onebot loop`

Definition of done:
- QQ private and group chat work through OneBot/SnowLuma in controlled local acceptance.
- Raw events, chat messages, agent turns, action decisions, action executions, tool calls, memory writes, and audit rows persist with valid links.
- Reply/no-reply is controlled by Attention + Evaluator + Action Executor.
- ContextBuilder governs memory injection and records trace.
- Memory lifecycle is inspectable, reversible, deletable, source-linked, and excludes disabled/deleted/superseded/secret/prohibited/private-in-group memory immediately.
- Tools are registered, policy-checked, sandboxed, audited, and secret-scanned.
- Workers are idempotent and source-linked.
- Governance CLI can inspect and control memory/context/action/audit state.
- `pnpm typecheck`, deterministic `pnpm test:run`, and lint status are green or have a documented user-approved exception.

Report after each phase:
- What changed.
- Files changed.
- Commands run and pass/fail.
- DB/schema evidence where relevant.
- Remaining gaps and next exact step.
```
