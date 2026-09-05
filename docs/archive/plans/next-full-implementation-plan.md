# Next Full Implementation Plan

**Status:** superseded planning snapshot, created 2026-07-03. It is not the
current roadmap or completion evidence; revalidate every gap against current
code, tests, and `long-running-goal-state.md` before acting on it.

**Scope:** complete all core LetheBot functions described by the canonical architecture, not only the first QQ reply loop.

This document replaced older MVP/post-MVP phase plans at the time it was
written. It is now retained as planning context only.

## 1. Purpose

LetheBot should become a persistent, local-first QQ chatbot with:

- reliable OneBot/SnowLuma runtime integration;
- auditable event ingestion;
- governable long-term memory;
- context orchestration with visibility/sensitivity boundaries;
- Pi-based reasoning and tool proposals;
- evaluator/policy/action-executor governance;
- background summarization/extraction/consolidation;
- user/admin governance for inspect, disable, delete, supersede, and explain;
- reproducible local and container acceptance.

The 2026-07-03 snapshot proposed closing the then-observed gaps between current
code and the target behavior in one development loop.

## 2. Authority and Evidence

Follow `long-term-development-constraints.md` as hard rules.

Minimum evidence rules:

1. Current worktree, current command output, current tests, and current database behavior are the source of truth.
2. `docs/archive/` files are not completion evidence.
3. Every feature completion claim needs a verification command or database/file assertion.
4. Do not commit secrets, `.env`, logs, SQLite databases, API keys, or private QQ identifiers.
5. Commit only explicit paths, one functional unit at a time.

## 3. Current Snapshot

This snapshot comes from the current source/doc scan on 2026-07-03 and recent local SnowLuma acceptance work. It is not a replacement for the baseline gate.

### Recently verified runtime path

- SnowLuma Docker Framework stack can run with LetheBot.
- QQ login through SnowLuma Framework was completed during local acceptance.
- LetheBot can connect to OneBot WS and report `/healthz` `ok` when the adapter is ready.
- `PI_PROVIDER=openai`, `PI_MODEL=deepseek-v4-flash`, `PI_BASE_URL`, and `PI_API_KEY` can drive real Pi responses when injected from local secret files.
- A private message can trigger a real Pi response and outbound message delivery in the local acceptance stack.

### Current implementation strengths

- `OneBotAdapter` exists for OneBot protocol integration.
- `src/index.ts` writes `raw_events` before derived `chat_messages`.
- Identity/display metadata is separated through `IdentityRepository` and display profile tables.
- `AttentionEngine` performs deterministic trigger/suppressor classification.
- `ContextBuilder` loads recent messages, retrieves memory, filters visibility/sensitivity, and records a trace.
- `MemoryRepository.create()` performs governed transactional writes to `memory_records`, `memory_sources`, `memory_revisions`, `audit_log`, and FTS.
- Pi adapter, mock Pi, DeepSeek/OpenAI-compatible path, tool registry, policy gate, workers, governance CLI, operations scripts, and tests exist.

### Known architecture gaps

- `src/index.ts` still owns too many orchestration concerns; gateway, ingestion, turn execution, action execution, and memory extraction are not clean services yet.
- The chat path builds separate ad hoc `turn-${Date.now()}` IDs for context and Pi; `agent_turns` is not the durable root for the turn.
- `agent_turns`, `action_decisions`, and `action_executions` tables exist but the main runtime does not persist the normal reply lifecycle into them.
- `AttentionEngine` can output `needs_evaluation`, but the main chain does not invoke an LLM/agent social evaluator for reply decisions.
- Social action output is not yet the central runtime contract; the runtime still sends a direct text reply after Pi.
- There is no dedicated `ActionExecutor` / `ResponseRouter` service for social, memory, tool, background, and platform actions.
- Cooldowns, action budgets, proactive DM policy, reaction fallback, and folded-forward delivery are not complete runtime behavior.
- Memory extraction exists, but full proposal/evaluator/action-executor flow and governance approval loop are incomplete.
- Background scheduler exists, but production job registration, idempotent job records, worker attempts, and lifecycle metrics need hardening.
- Tool governance exists in shape, but full tool-call persistence, sandbox enforcement, output secret scanning, and dangerous-tool evaluator linkage need completion.
- Governance CLI exists, but full inspect/approve/reject/disable/delete/supersede/export/why coverage must be verified and filled.
- Default deterministic gates must be re-run before new feature work.

## 4. Full Functional Completion Map

| Area | Target behavior | Current implementation | Required work | Completion evidence |
|---|---|---|---|---|
| Baseline gate | Known green/known debt state before feature work | Tests and lint state not rechecked by this docs pass | Run `git status --short`, `pnpm typecheck`, `pnpm test:run`, `pnpm lint`; record failures before feature work | Command output in final report or status doc |
| Gateway / OneBot | Protocol-only adapter for WS/HTTP send/receive, auth, reconnect, capabilities, media/quote, exact bot mention | OneBot adapter and SnowLuma compose exist; private real path recently worked | Harden reconnect/readiness; normalize media/quote/reply; capability reporting; avoid protocol decisions leaking into memory/Pi | Unit/integration WS tests, fake OneBot tests, local SnowLuma smoke |
| Ingestion | Normalize events, write raw event first, write derived rows with valid FK, idempotent duplicate handling | `src/index.ts` writes raw and chat rows directly | Extract ingestion service; add duplicate/idempotency handling; distinguish user/bot/system/tool events cleanly | DB-level assertions for raw/chat FK and duplicate behavior |
| Identity/display | Raw QQ IDs mapped to canonical users; display profiles separate from memory; deletion/redaction possible | Identity repo and display profile recording exist | Verify group/private account type semantics; add opt-out/unlink/delete flows; avoid raw ID prompt injection except purpose-bound | Identity tests + governance CLI assertions |
| Turn lifecycle | Every non-silent candidate turn has durable `agent_turns` state and status transitions | Tables exist; main chain does not write them | Introduce `TurnRepository`/service; one stable `turnId`; persist pending/running/completed/failed/aborted, tokens, model, trigger event | Integration test checks `agent_turns` rows for success and failure |
| Attention | Fast deterministic prefilter only; emits signals and path | Implemented deterministic weights/suppressors | Add stateful suppressors/cooldowns; keep no LLM in fast path; pass gray/risk cases to evaluator/action layer | Attention unit tests + action-decision integration tests |
| Social evaluator | Risk-triggered structured LLM/agent review for proactive/group/gray actions | Stub evaluator exists; not wired into main reply decision | Add evaluator interface/runtime; structured schema; invoke for `needs_evaluation` and risky actions; persist decisions | Tests with mock evaluator and real-gated evaluator |
| Action decisions | Structured `ActionDecision` / `ActionPlan` owns reply/dm/tool/memory/background choices | Types and tables exist; runtime bypasses them | Build decision service; convert attention/Pi/evaluator results to plans; persist reasons/suppressors | DB assertions for `action_decisions` |
| Action executor / response router | Executes approved social, memory, tool, background, and platform actions with audit/cooldown/capability fallback | Direct `adapter.sendMessage()` in `src/index.ts` | Create executor/router; persist `action_executions`; support reply, DM, reaction, folded-forward fallback, schedule job, memory proposal | Integration/e2e tests assert sent messages and execution rows |
| Context orchestration | Recent history + selected/rejected memory trace + identity trace + token budget; no forbidden memory injection | ContextBuilder does much of this | Persist context packs/blocks/links if schema supports; improve token estimates; participant context; group/private boundary tests | Context tests with selected/rejected memory IDs and token budget |
| Pi runtime | Reasoning core wrapper, real/mock providers, streaming/events, tool proposals, failed turns observable | PiAdapter and mock exist; real DeepSeek path recently worked | Link to turn lifecycle; persist events/tool calls; normalize errors/timeouts; avoid missing-provider imports; real tests gated by env | Unit tests + skipped-by-default real API test + turn DB assertions |
| Tool registry/policy/sandbox | All tools registered with capabilities, permissions, evaluator policy, audit, sandbox, output sensitivity | Registry/policy/handlers exist | Enforce sandbox policies consistently; persist tool calls; scan secret_possible output; evaluator for dangerous tools | Tool integration tests + audit/tool_call rows |
| Memory lifecycle | Candidate → policy/evaluator → proposed/active/rejected; sources/revisions/audit; disable/delete/supersede excludes immediately | Repository governed writes strong; extraction creates durable memories | Add proposal workflow, evaluator linkage, conflict/supersede, group-to-user constraints, user confirmation/admin digest | Full memory lifecycle e2e and DB assertions |
| Background workers | Idempotent summary/extraction/consolidation/decay/conflict jobs with job attempts and metrics | Worker classes/scheduler exist | Register jobs; persist job/attempt/heartbeat rows; idempotency keys; retry/backoff; admin digest outputs | Worker tests with duplicate runs and job status assertions |
| Governance CLI/UI | Inspect/list/show/approve/reject/disable/delete/supersede/export memory; `/why` context trace; redacted audit | CLI exists with some operations | Fill missing commands; add action/evaluator/tool audit inspection; optional minimal web UI later | CLI tests and manual command examples |
| Operations | Health/readiness, backup/restore, retention, metrics, container acceptance, runbooks | Docs/scripts exist; health exists | Add event failure endpoint/CLI; improve metrics; keep container docs current for SnowLuma Framework | Ops script tests + local container smoke |
| Testing | Default deterministic suite covers core contracts; live API/runtime gated | Many unit/integration/e2e tests exist | Rebaseline; add missing DB-level and e2e tests per gap; keep real API/SnowLuma tests opt-in | `pnpm typecheck`, `pnpm test:run`, lint/debt status |
| Documentation | Canonical docs reflect current architecture and operations | Docs cleaned and archive created | Keep plan updated at phase boundaries; do not add stale completion claims | README and plan links remain current |

## 5. Workstreams

### A. Baseline and Worktree Hygiene

Tasks:

- Run baseline gates before feature work:
  - `git status --short`
  - `pnpm typecheck`
  - `pnpm test:run`
  - `pnpm lint` or record lint debt
- Inspect untracked files and never stage generated secrets, local logs, DB files, `.env`, API keys, or private QQ identifiers.
- If baseline fails, stop feature expansion and do recovery first.

Evidence:

- Baseline command output.
- Explicit list of known failures if any.

### B. Gateway and Runtime Compatibility

Tasks:

- Keep gateway protocol-only.
- Verify OneBot WS and reverse HTTP auth behavior.
- Harden reconnect/readiness and outbound HTTP/WS token handling.
- Normalize CQ array/string messages, `@bot`, quote/reply, sender role, group card, media/file metadata.
- Expose gateway capabilities for reaction, face fallback, folded-forward, and platform admin operations.
- Keep SnowLuma Framework and source-build compose acceptance paths documented.

Evidence:

- Unit tests for OneBot parsing/auth.
- FakeOneBot private/group tests.
- Manual local container smoke for real QQ when credentials/session exist.

### C. Ingestion, Identity, and Raw Event Store

Tasks:

- Extract ingestion from `src/index.ts` into a service with a narrow interface.
- Persist `raw_events` before all derived rows.
- Add idempotency for repeated OneBot events.
- Ensure `chat_messages.raw_event_id` always references a real event.
- Persist bot/system/tool events with explicit event source and legal FK behavior.
- Resolve canonical users and display metadata without turning display fields into memory.

Evidence:

- Integration tests assert FK validity and duplicate handling.
- DB-level checks for raw/chat rows after synthetic and fake gateway messages.

### D. Turn Lifecycle and Observability

Tasks:

- Introduce one stable `turnId` for each response candidate.
- Persist `agent_turns` before context/Pi execution.
- Update status on running/completed/failed/aborted.
- Store model/provider, trigger raw event, context pack ID, response text, token counts, and failure reason.
- Add observable event-processing failures through CLI or health/debug endpoint without leaking sensitive content.

Evidence:

- Success and failure tests assert `agent_turns` status transitions.
- Pi failure is recorded as failed turn, not silent no-response success.

### E. Attention, Social Evaluator, and Action Decision

Tasks:

- Keep `AttentionEngine` as deterministic prefilter, not a full policy engine.
- Add stateful suppressors/cooldowns outside raw-event persistence.
- For `needs_evaluation` and high-risk social actions, invoke evaluator with trimmed structured input.
- Persist `action_decisions` with `decided_by`, actions, risk, confidence, reasons, suppressors, evaluator flags.
- Use structured actions: `silent_store`, `reply_short`, `reply_full`, `reply_with_tool`, `propose_memory`, `admin_digest`, `schedule_background_task`, `dm_user`, `react_only`, `send_folded_forward`, `ask_clarification`.

Evidence:

- Unit tests for trigger/suppressor scoring.
- Integration tests for private reply, group silent, group @bot, group `needs_evaluation`, cooldown downgrade.
- DB assertions for `action_decisions`.

### F. Action Executor and Response Router

Tasks:

- Create a central executor for social, memory, tool, background, and platform actions.
- Enforce deterministic L0 policy before execution.
- Apply cooldown/budget/capability fallback at execution time.
- Persist `action_executions` for success, downgraded, failed, and rejected outcomes.
- Replace direct `adapter.sendMessage()` in `src/index.ts` with executor/router calls.
- Add reaction and folded-forward fallback paths when gateway capabilities support them.

Evidence:

- Integration tests assert outbound fake messages plus `action_executions` rows.
- Failure tests assert rejected/failed rows and audit entries.

### G. Context Orchestration Completion

Tasks:

- Persist context packs/blocks/links or provide equivalent durable trace.
- Improve participant context with display name, role, owner/admin/trusted flags, and purpose-bound platform IDs.
- Record selected and rejected memory IDs with reasons.
- Keep secret/prohibited/deleted/disabled/superseded/private-in-group exclusions deterministic.
- Calculate token budget from actual injected text, not placeholder constants only.
- Include bot historical messages in recent context when relevant.

Evidence:

- Context tests cover private vs group boundaries, selected/rejected IDs, identity field trace, token budget, bot-message history.
- CLI `/why` or equivalent can show redacted trace.

### H. Pi Runtime and Tool Calls

Tasks:

- Keep Pi behind `ReasoningCore`/adapter interface.
- Link Pi turns to `agent_turns` and action decisions.
- Persist Pi events and tool calls where schema supports it.
- Make real API tests opt-in through env vars; mock tests remain default.
- Normalize provider/base URL/model errors and timeouts.
- Ensure tool hooks always pass through `PolicyGate`, audit, sandbox, and secret scanning.

Evidence:

- Mock Pi unit tests.
- PiAdapter integration tests with tool-call approval/rejection.
- Real DeepSeek/OpenAI-compatible smoke skipped unless env is present.

### I. Memory Lifecycle and Governance Path

Tasks:

- Keep `MemoryRepository` as the durable write path.
- Add explicit memory candidate/proposal service.
- Apply deterministic secret/prohibited scanner before evaluator and before durable writes.
- Invoke memory evaluator/risk classifier for auto-active decisions.
- Enforce group-chat-to-user-memory constraints.
- Implement reject, approve, disable, delete, restore, supersede, and conflict handling with revisions/audit.
- Ensure deletion/disable/supersede affects retrieval immediately and FTS stays consistent.

Evidence:

- Full memory lifecycle e2e: message → candidate/proposal → approve/active → retrieval → disable/delete/supersede → retrieval exclusion.
- DB assertions for records, sources, revisions, audit, FTS behavior.

### J. Background Workers

Tasks:

- Decide which workers run in-process for the local profile.
- Register summary, extraction, consolidation, decay, conflict detection, retention/admin digest jobs.
- Add job rows, attempts, heartbeats, leases, retries, and idempotency keys.
- Ensure workers preserve source links back to raw events/messages.
- Ensure worker failures are visible but do not corrupt chat path.

Evidence:

- Worker tests for idempotent duplicate runs.
- Job/attempt DB assertions.
- Summary/extraction source-link assertions.

### K. Tool Registry, Sandbox, and Audit

Tasks:

- Verify all built-in tools declare capabilities, permissions, evaluator policy, audit level, sandbox policy, and output sensitivity.
- Enforce path boundary checks for filesystem tools.
- Enforce execution/network limits for shell/network tools.
- Persist `tool_calls` and audit rows linked to turns/action decisions.
- Scan `secret_possible` outputs before audit, memory proposal, or prompt injection.
- Ensure dangerous tools require evaluator unless explicitly owner-configured, while L0 policy remains mandatory.

Evidence:

- Tool registry schema tests.
- File path traversal tests.
- Secret redaction tests.
- Tool call DB/audit assertions.

### L. Governance CLI / UI

Tasks:

- Complete owner/admin CLI first.
- Commands should cover:
  - list/filter/show memory;
  - approve/reject memory proposals;
  - disable/delete/restore/supersede memory;
  - export visible memory;
  - inspect action/evaluator/tool/audit records;
  - show `/why` context trace;
  - redact display profile/nickname history;
  - manage proactive DM and memory-association opt-outs.
- Optional later: minimal web UI over the same service layer.

Evidence:

- CLI unit tests and integration tests on temp SQLite.
- Manual examples in docs without real private IDs.

### M. Operations and Local Acceptance

Tasks:

- Keep `/healthz` focused on DB and adapter readiness without secret leakage.
- Add debug/admin observability for recent failures, queued jobs, and adapter state.
- Maintain backup/restore/retention/metrics scripts and docs.
- Keep `docker-compose.local-acceptance.yml` for source-build SnowLuma development.
- Keep `docker-compose.snowluma-framework.yml` for QR login and real QQ smoke.
- Document secret injection through env or local temp files, never committed.

Evidence:

- Ops script unit tests.
- Compose config validation.
- Manual local acceptance checklist when real QQ/SnowLuma session is available.

### N. Testing and Documentation

Tasks:

- Add tests before behavior changes when practical.
- Prefer DB-level assertions over HTTP-only or mock-only assertions.
- Keep real API and real SnowLuma tests opt-in.
- Update canonical docs when contracts/env/runtime behavior changes.
- Keep archive docs untouched unless moving historical files.

Evidence:

- Passing deterministic gates or explicit failure/debt list.
- Final report includes commands, changed files, and known gaps.

## 6. Historical Proposed Phase Order

### Phase 0 — Baseline and docs cleanup

Goal: establish current truth before feature work.

Exit criteria:

- `git status --short` reviewed.
- Typecheck/test/lint status known.
- Docs archive and this planning snapshot are in place.

### Phase 1 — Turn lifecycle persistence

Goal: make every non-silent turn auditable.

Work:

- Stable `turnId`.
- `agent_turns` repository/service.
- Persist pending/running/completed/failed.
- Link trigger raw event, context pack, model/provider, response, tokens.

Exit criteria:

- Private fake message creates `raw_events`, `chat_messages`, and `agent_turns` rows.
- Failed Pi turn creates failed row.

### Phase 2 — Action decision and executor skeleton

Goal: route all outward behavior through structured actions.

Work:

- Decision service.
- Executor/router for reply actions.
- `action_decisions` and `action_executions` persistence.
- Direct send in `src/index.ts` replaced.

Exit criteria:

- Private reply and group @bot reply create decision/execution rows.
- Silent group message stores event without outward execution.

### Phase 3 — Social evaluator and cooldowns

Goal: complete reply/no-reply governance.

Work:

- LLM/mock evaluator interface for social decisions.
- Wire `needs_evaluation` path.
- Add cooldown/budget suppressors and downgrade behavior.

Exit criteria:

- Tests cover group risk path, evaluator downgrade/reject, cooldown downgrade.

### Phase 4 — Context trace and retrieval hardening

Goal: make every response explainable.

Work:

- Persist or reconstruct context trace.
- Improve participant identity fields and token budgeting.
- Add selected/rejected memory reasons.

Exit criteria:

- `/why` or CLI equivalent explains selected memory, rejected memory, identity fields, and suppressors.

### Phase 5 — Memory proposal and lifecycle completion

Goal: memory changes become governable end to end.

Work:

- Candidate/proposal service.
- Evaluator/policy integration.
- Approve/reject/disable/delete/restore/supersede flows.
- Group-to-user and secret/prohibited enforcement.

Exit criteria:

- Full memory lifecycle e2e passes with DB source/revision/audit assertions.

### Phase 6 — Tool governance and sandbox completion

Goal: Pi tool proposals are safe, auditable, and useful.

Work:

- Persist tool calls.
- Enforce sandbox/output sensitivity/secret redaction.
- Link tool decisions to turns and action decisions.

Exit criteria:

- Tool call success/reject/failure tests pass with audit rows.

### Phase 7 — Background workers

Goal: summaries, extraction, consolidation, and maintenance run idempotently.

Work:

- Job tables/attempts/heartbeats.
- Register workers.
- Add retry/idempotency/source links.

Exit criteria:

- Worker tests prove duplicate runs do not duplicate durable memory or summaries.

### Phase 8 — Governance CLI completion

Goal: owner/admin can inspect and control memory/actions/context.

Work:

- Fill CLI commands.
- Add redacted output policies.
- Add tests and examples.

Exit criteria:

- CLI covers memory lifecycle and why/audit traces on temp DB.

### Phase 9 — Runtime acceptance hardening

Goal: local and container acceptance prove the integrated loop.

Work:

- FakeOneBot full-flow tests.
- SnowLuma Framework smoke with real session when available.
- DeepSeek/OpenAI-compatible real smoke gated by env.
- Operations docs updated.

Exit criteria:

- Default deterministic gates pass.
- Manual local acceptance checklist documents date, commands, and known gaps.

## 7. Full Completion Definition

The full implementation is complete only when all of the following hold:

- QQ private and group chat work through OneBot/SnowLuma in controlled local acceptance.
- Raw events, chat messages, agent turns, action decisions, action executions, tool calls, memory writes, and audit rows are persisted with valid links.
- Whether to reply is controlled by Attention + Evaluator + Action Executor, not by ad hoc direct sending.
- User memory and group memory influence answers only through ContextBuilder with visibility/sensitivity filters.
- Deleted/disabled/superseded/secret/prohibited/private-in-group memory is excluded immediately.
- Users/admin can inspect, approve, reject, disable, delete, restore, supersede, and explain memory/context decisions.
- Tool calls are registered, policy-checked, sandboxed, audited, and secret-scanned.
- Background workers are idempotent and source-linked.
- Backup, restore, retention, metrics, troubleshooting, and container acceptance docs are current.
- `pnpm typecheck`, deterministic `pnpm test:run`, and lint status are green or explicitly documented with approved debt.

## 8. Commit Strategy

Use small, reversible, functional commits.

Recommended commit groups:

1. `docs: archive historical development docs`
2. `docs: add full implementation plan`
3. `feat(turns): persist agent turn lifecycle`
4. `feat(actions): persist action decisions and executions`
5. `feat(actions): route replies through action executor`
6. `feat(evaluator): wire social evaluator for risk path`
7. `feat(context): persist context trace and memory rejection reasons`
8. `feat(memory): add governed memory proposal lifecycle`
9. `feat(tools): persist and govern tool calls`
10. `feat(workers): add idempotent job lifecycle`
11. `feat(cli): complete governance commands`
12. `test(acceptance): harden fake and container acceptance`

Before each commit:

```bash
git status --short
git diff -- <explicit paths>
git add <explicit paths only>
git diff --cached --stat
git diff --cached -- <explicit paths>
git commit -m "<concise message>"
```

Never stage generated DB files, logs, `.env`, API key files, or private QQ identifiers.
