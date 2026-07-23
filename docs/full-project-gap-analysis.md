# LetheBot Full Project Gap Analysis

**Date:** 2026-07-11 20:05 local shell time (CST +0800)
**Purpose:** current-state synthesis against the architecture documents, plus a scoped estimate of what remains before LetheBot can be called a complete production-ready local QQ / SnowLuma chatbot.

This is not a completion certificate. Current worktree, command output, tests, and live acceptance evidence remain authoritative.

Current-state note (2026-07-11): deterministic acceptance tooling now rejects
the mock provider and fixed-mock source compose target in complete mode. Required
DB hints demand non-placeholder declared Pi identity for private, exact-mention,
and reply-to-bot turns, plus one source-bound evaluator-approved successful Pi
tool/audit chain in coherent turn/action/response time order. This closes local
validator false positives only; declared identities do not prove external calls,
and real SnowLuma/QQ evidence is still absent.

## Evidence Used

Fresh status command:

```bash
date '+%Y-%m-%d %H:%M:%S %Z %z'
git status --short
git status --short | awk '{ total++; if ($1 ~ /^\?\?/) untracked++; else tracked++ } END { printf "tracked_dirty=%d untracked=%d total=%d\n", tracked+0, untracked+0, total+0 }'
```

Observed at `2026-07-11 20:05:44 CST +0800`:

- Current dirty worktree: `tracked_dirty=118`, `untracked=45`, `total=163`.
- Existing tracked and untracked WIP spans source, tests, migrations, docs, scripts, and root scratch paths; it remains protected from cleanup, staging, or destructive reconciliation.
- Scratch/backup paths must not be deleted, staged, read, or committed without explicit user approval.

Latest deterministic full gate recorded after complete-validator provider/tool evidence hardening:

- `pnpm release:check` exited `0`.
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm build` and offline release preflight passed.
- `pnpm test:run` passed with `87 passed | 1 skipped` test files and `1593 passed | 8 skipped` tests.
- `git diff --check` passed as part of `release:check`.

Primary architecture references:

- `docs/architecture.md`
- `docs/contracts.md`
- `docs/data-model.md`
- `docs/sqlite-schema.md`
- `docs/memory-system.md`
- `docs/context-orchestration.md`
- `docs/social-action-model.md`
- `docs/agent-governance.md`
- `docs/tool-registry.md`
- `docs/pi-integration.md`
- `docs/security-privacy.md`
- `docs/operations.md`
- `docs/local-container-acceptance.md`
- `docs/next-codex-project-state.md`
- `docs/next-codex-constraints.md`

## Architecture-Aligned Current State

### 1. Gateway Adapter

Architecture target: OneBot / QQ protocol adaptation only; receive/send, parsing, media/quote normalization, retry/reconnect, gateway capability reporting.

Current evidence:

- `src/gateway` exists with OneBot adapter implementation and Fake OneBot tests.
- Deterministic HTTP/WebSocket coverage is strong for private/group messages, quotes, media metadata, malformed payloads, redaction, unsupported event no-side-effect behavior, and outbound message ID fallback.
- Deployment and verification scripts exist for NapCat / SnowLuma / OneBot.

Missing / weak:

- Real SnowLuma/QQ private and group acceptance is still unrun in current evidence.
- Actual platform edge cases beyond Fake OneBot remain unproven.
- Long-lived reconnect/soak evidence against the real runtime is not yet available.

Assessment: **mostly implemented for deterministic/fake runtime; incomplete for real platform readiness.**

### 2. Ingestion / Raw Event Store

Architecture target: normalize internal events and write raw events before downstream records.

Current evidence:

- SQLite schema includes `raw_events`, `chat_messages`, and `event_processing_failures`.
- Integration/e2e tests assert raw event, chat message, turn, context, action, execution, and FK-clean evidence for fake flows.
- Unsupported/malformed event paths avoid unintended DB side effects.

Missing / weak:

- Live raw-event evidence from real SnowLuma / QQ is absent.
- Retention and deletion policies exist but need production run validation over real data.

Assessment: **strong deterministic implementation; live evidence missing.**

### 3. Attention Engine / Social Action Model

Architecture target: trigger scores and suppressors produce action candidates, not a simple yes/no reply.

Current evidence:

- `src/attention`, social action docs, action decision/execution repositories, suppressor/explainability paths, and DB-backed tests exist.
- `why` can explain context and linked action decisions/executions.
- Deterministic app-path coverage now proves true `react_only` delivery through
  `FakeOneBot.sendReaction()` with a successful action execution and no
  `bot.response` chat row, preserving the distinction between reaction-only
  side effects and message replies.
- Deterministic fallback coverage now proves `react_only` face/text fallback
  delivery persists downgraded action-execution evidence, the executed fallback
  message ID, and same-path `bot.response` / `bot-self` evidence using the
  delivered reaction text rather than the raw Pi draft.

Missing / weak:

- Broader real group behavior, anti-spam/cooldown behavior, proactive DM, owner/admin flows, and live reaction/folded-forward platform behavior need real acceptance and product tuning.
- Real `OneBotAdapter` capability reporting is now conservative for current implementation, but true emoji-like reactions, folded-forward node delivery, and their live platform behavior remain unproven/future.

Assessment: **useful core exists; advanced social behavior remains incomplete.**

### 4. Thick Memory Layer

Architecture target: governed long-term memory with scope, lifecycle, source links, revisions, rollback/supersede, visibility/sensitivity policy, and governance.

Current evidence:

- `src/memory`, memory repositories, proposal service, extraction workers, lifecycle commands, source/revision/audit rows, privacy preferences, and retrieval exclusion tests exist.
- Memory review queues and explicit supersede/disable approval paths exist.
- Context traces record selected/rejected memory evidence.

Missing / weak:

- Real chat-derived memory behavior has not been proven with live QQ/SnowLuma acceptance.
- Automatic merge/consolidation/decay mutation is intentionally not implemented; current workers mostly detect and create review evidence.
- Embeddings / semantic similarity are optional/future and not the main current retrieval mechanism.
- No rich governance UI; CLI is primary.

Assessment: **governed memory foundation is strong; mature automatic memory operations and UX remain incomplete.**

### 5. Context Orchestrator

Architecture target: ContextBuilder owns retrieval, filtering, ranking, budgeting, prompt assembly, identity injection, and trace evidence.

Current evidence:

- `src/context` exists with tests for token budget, selected/rejected memory, identity/participant boundaries, and context trace evidence.
- Governance explainability can inspect context/action paths.

Missing / weak:

- Token accounting and ranking can continue maturing beyond deterministic approximations.
- Real multi-turn production behavior with live QQ and governed memory affecting answers remains unproven.
- Participant display/name behavior is tested but needs real group acceptance.

Assessment: **solid deterministic core; production tuning remains.**

### 6. Pi Agent Runtime

Architecture target: Pi owns reasoning and tool/action proposals but not durable storage, platform delivery, policy enforcement, or dangerous execution.

Current evidence:

- Pi dependencies resolve to `@earendil-works/pi-agent-core 0.80.2` and `@earendil-works/pi-ai 0.80.2` in recent baselines.
- Mock/default deterministic tests pass.
- Real API tests are gated/skipped without credentials. The legacy DeepSeek harness is now deterministic-only and cannot pass placeholder live-provider assertions.
- PiAdapter baseUrl propagation has deterministic unit coverage for DeepSeek-compatible and generic provider models.
- Failed turn diagnostics are redacted.

Missing / weak:

- Real model-provider behavior is still not proven as part of the default gate; default tests only prove gating/configuration and mockable adapter behavior.
- End-to-end Pi tool calling under real provider load and timeout/rate-limit conditions needs controlled tests.
- More production-grade turn streaming and retry behavior may be needed.

Assessment: **mockable integration exists; real provider production readiness remains partial.**

### 7. Evaluator / Policy Gate

Architecture target: deterministic L0 policy plus optional evaluator review for risky actions, memory activation, tools, proactive replies, and redaction decisions.

Current evidence:

- Policy gate and evaluator stubs exist.
- Tool/action/memory paths include deterministic safety checks, audit, redaction, and tests.
- `evaluator=bypass` constraints are documented.

Missing / weak:

- Full LLM-backed evaluator workflows for risky memory/action decisions remain incomplete or not proven live.
- Rich operator review flows are CLI-first and not a complete product UI.
- Policy coverage for future tools/actions must expand as surface area grows.

Assessment: **deterministic enforcement foundation exists; full evaluator product remains incomplete.**

### 8. Action Executor / Response Router

Architecture target: execute approved social, memory, tool, background, and platform actions with audit, cooldowns, capability downgrades, and rollback handles.

Current evidence:

- `src/actions` exists with action decision/execution repositories and executor tests.
- Fake private/group outbound paths persist action executions.
- Failure/downgrade diagnostics are redacted and explainable.

Missing / weak:

- Live platform send path through SnowLuma/QQ remains unproven.
- Broader action types such as reaction/folded-forward/proactive DM/platform admin remain future or partial.
- Long-running action rollback behavior needs broader evidence.

Assessment: **core reply execution exists; full action surface incomplete.**

### 9. Tool Layer

Architecture target: registry-backed tools with permissions, sandbox policy, audit, output sensitivity, and policy/evaluator linkage.

Current evidence:

- File and network tool handlers, path validator, tool registry, tool call repository, policy/audit/redaction tests exist.
- Path boundary and redaction coverage is strong.
- PiAdapter now returns adapter-audited rejected tool-call IDs in `PiAdapterOutput.toolCallIds`, so failed turns caused by evaluator-required or policy-denied tools remain correlated with durable `tool_calls` / `audit_log` evidence.

Missing / weak:

- Actual product tools beyond filesystem/network are limited.
- Real Pi-proposed tool-call loop under provider execution needs stronger end-to-end evidence; deterministic governance now explains persisted turn-linked tool-call outcomes without payload leakage.
- UI/operator controls for tool permissions remain CLI/docs-heavy.

Assessment: **safe tool substrate exists; product tool catalog and live Pi loop need expansion.**

### 10. Background Workers

Architecture target: summarization, extraction, embeddings, decay, conflict detection, maintenance, and review workflows outside chat path.

Current evidence:

- `src/workers`, durable job repository, attempts, leases, heartbeats, scheduler, and operations worker-soak exist.
- Synthetic local worker soak proves all current durable task types aggregate-only on temp DB; the latest 60-second run completed all 7 durable job types with planned retry, lease extension, idle heartbeat, and `foreignKeyViolations=0`.
- Summary/extraction/admin-digest/conflict/decay/consolidation behavior has deterministic coverage.

Missing / weak:

- Long-running production soak is not proven.
- Conflict/decay/consolidation are review/audit-heavy rather than automatic governed mutation.
- Embedding update pipeline remains optional/future.

Assessment: **durable worker substrate is strong; production soak and mature automation remain.**

### 11. Governance UI / CLI

Architecture target: inspect, delete, disable, rollback/supersede memory, explain `/why`, inspect audit/tools/actions/jobs, and preserve privacy.

Current evidence:

- Governance CLI is substantial: memory lifecycle, privacy preferences, display redaction, audit/action/tool/job/event-failure inspection, `why`, review summaries, compact governance-health triage, and redaction coverage.
- `why` includes context/action decision/action execution and linked tool-call summary evidence.
- `summarize-governance-health --compact` gives operator triage counts without dynamic aggregate keys, row classifiers, payloads, raw IDs, or stored free-text values.

Missing / weak:

- No rich web UI is implemented.
- CLI output is powerful but may be too large/technical for non-developer operators.
- Owner/admin authentication and multi-user governance UX need productization.

Assessment: **CLI governance is strong; human-facing product UI is incomplete.**

### 12. Operations / Deployment / Acceptance

Architecture target: reliable local deployment, health/readiness/metrics, backup/restore, retention, evidence collection, controlled SnowLuma/QQ acceptance.

Current evidence:

- Operations docs/scripts exist for smoke, backup/restore, retention, metrics, worker-soak, deployment, OneBot verification, and local acceptance evidence.
- `/healthz`, `/readyz`, `/metrics`, Prometheus format, ops CLI, and redaction tests exist.
- Evidence template and validator now include share-safety plus opt-in `--require-complete` completion checks.
- Complete-mode acceptance tooling rejects the checked mock provider and the
  fixed-mock source compose target. Aggregate DB hints require non-placeholder
  declared Pi identities for all three required flows and one successful
  Pi-requested tool chain with matching evaluator decision, audit, trigger source,
  actor/context, delivered action, and coherent timestamps.
- `pnpm ops:doctor` now provides a read-only local DB/configuration preflight with integrity/FK/schema/count/config-boolean evidence and spawned non-leakage/read-only/FK-clean coverage.
- `pnpm release:check` now gives operators a named deterministic install/update/release gate that expands to the required typecheck/lint/test/diff-check sequence, and `docs/operations.md` chains it with backup, frozen install, `ops:doctor`, health/readiness, optional OneBot verify, and acceptance validators.

Missing / weak:

- Real controlled SnowLuma/QQ acceptance is the largest gap.
- Multi-hour or multi-day local runtime soak remains unproven.
- Release packaging/install/update story is improved at runbook/script level but remains incomplete as a distributable installer/update/rollback artifact.
- Observability dashboards and alerting are minimal.

Assessment: **deterministic ops are good; live acceptance and packaging remain.**

## Completion Estimate

This estimate treats “complete project” as:

> A production-ready local-first QQ/SnowLuma chatbot with governed memory, Pi reasoning, audited tools/actions/workers, usable operator governance, documented deployment/backup/retention, and real private/group QQ acceptance evidence.

It is not a line-count metric.

| Area | Weight | Current estimate | Missing share |
|---|---:|---:|---:|
| Gateway + real QQ path | 15% | 9/15 | 6/15 |
| Ingestion + persistence integrity | 10% | 8.5/10 | 1.5/10 |
| Memory governance | 15% | 11/15 | 4/15 |
| Context orchestration | 10% | 7.5/10 | 2.5/10 |
| Pi runtime + evaluator/policy | 15% | 9/15 | 6/15 |
| Tools/action execution | 10% | 7/10 | 3/10 |
| Workers + ops durability | 10% | 7.5/10 | 2.5/10 |
| Governance UX | 7% | 4.5/7 | 2.5/7 |
| Packaging/live acceptance/docs consolidation | 8% | 4/8 | 4/8 |
| **Total** | **100%** | **67.5%** | **32.5%** |

### Bottom Line

- **Deterministic/fake-runtime MVP foundation:** about **82-86% complete**.
- **Production-ready complete project:** about **66-70% complete**.
- **Missing before complete production claim:** about **30-35%**, concentrated in real SnowLuma/QQ acceptance, long-running runtime evidence, real provider/evaluator/tool loops, richer governance UX, packaging, and docs consolidation.

## Highest-Value Remaining Work

1. **Real controlled SnowLuma/QQ acceptance**
   - private chat loop;
   - two distinct same-group turns: an exact @bot loop, then a no-mention reply
     to that stored bot response;
   - replies through action executor;
   - governed memory affects answers without leakage;
   - at least one accepted turn exercises an evaluator-approved successful Pi tool;
   - evidence passes default validator and `--require-complete`.

2. **Worktree stabilization**
   - decide fate of untracked scratch/backup paths and whether to promote or archive the untracked project-planning docs;
   - package current tracked WIP into reviewable commit groups if user authorizes commits;
   - avoid deleting scratch without explicit approval.

3. **Production runtime hardening**
   - longer local soak;
   - SnowLuma reconnection/error behavior;
   - backup/restore/retention proof on disposable DBs;
   - release/install/update runbook.

4. **Real Pi/provider and evaluator workflows**
   - controlled real provider test;
   - timeout/rate-limit/failure evidence;
   - risky-action evaluator path;
   - policy-gated tool-calling loop.

5. **Memory automation maturity**
   - governed conflict/consolidation/decay actions beyond review-only detection;
   - optional embedding pipeline if needed;
   - group-to-user memory confirmation UX.

6. **Governance product UX**
   - compact owner/admin commands;
   - optional lightweight web UI;
   - review queues and operator runbooks.

## Suggested Sequencing for the One-Shot Goal

1. Stabilize current worktree and reconcile docs.
2. Run full deterministic baseline.
3. Close any failing gates before feature work.
4. Complete missing architecture capabilities with DB-backed tests.
5. Run deterministic full gate repeatedly after major phases.
6. Perform real SnowLuma/QQ acceptance only with explicit local runtime/secrets authorization.
7. Validate real evidence with both share-safety and `--require-complete`.
8. Produce final completion audit that maps every architecture requirement to current evidence.

## Current Requirement-by-Requirement Completion Audit - 2026-07-08 15:51 CST

This is a current-state audit, not a final completion certificate. It maps the
objective's required product scope to the strongest current evidence and the
remaining proof needed before production-ready completion can be claimed.

Latest gate evidence for this audit after the audit/status doc edits:

```bash
pnpm release:check
```

The command exited `0` in the current worktree and reported `73 passed | 1
skipped` test files and `1191 passed | 8 skipped` tests. `release:check`
expands to `pnpm typecheck && pnpm lint && pnpm test:run && git diff --check`.

| Requirement | Current status | Current evidence | Missing proof before completion |
|---|---|---|---|
| QQ / SnowLuma / OneBot private chat loop | **Externally blocked / unproven live** | Deterministic Fake OneBot private-message e2e and adapter unit coverage; local acceptance runbooks and evidence validator exist. | Real local SnowLuma/QQ private message sent to the bot, response delivered through LetheBot, redacted evidence recorded under `/tmp`, both validators pass. |
| QQ group `@bot` loop and reply/mention semantics | **Externally blocked / unproven live** | Deterministic group e2e coverage for exact mention, reply-to-bot, at-all inertness, non-bot quote inertness, malformed metadata no-side-effect paths. | Two real, distinct same-group turns through SnowLuma/OneBot: exact `@bot`, then a no-mention reply to that stored bot response, with redacted linked DB/action evidence and both validators passing. |
| Gateway protocol boundary | **Proved for deterministic/fake runtime; live incomplete** | `tests/unit/gateway/onebot-adapter.test.ts`, `tests/integration/e2e-conversation.test.ts`, and deploy/verify tests cover parsing, malformed payloads, WebSocket pending cleanup, send response fallback, and redaction. | Real adapter behavior under actual SnowLuma account session and longer reconnect/soak evidence. |
| Raw ingestion and chat persistence | **Proved deterministically** | Schema/repository/e2e tests assert `raw_events`, `chat_messages`, downstream turn/action rows, unsupported-event no-side-effect behavior, and FK-clean state. | Live raw/chat rows from real acceptance, shared only as redacted counts/internal IDs. |
| Governed memory writes preserve source/revision/audit | **Proved deterministically for implemented flows** | Memory repository/proposal/lifecycle CLI tests cover `memory_records`, `memory_sources`, `memory_revisions`, audit rows, privacy opt-outs, restore/disable/delete/supersede, and FK checks. | Live chat-derived memory acceptance showing governed memory affects allowed answers without leakage. |
| Retrieval excludes deleted/disabled/superseded/secret/prohibited/private-in-group records | **Proved deterministically** | Memory/context tests and `why`/context trace evidence cover selected/rejected memories, visibility/sensitivity filters, private-in-group rejection, and lifecycle exclusion. | Same behavior demonstrated in real private/group acceptance evidence. |
| ContextBuilder owns retrieval, ranking/budgeting, identity injection, and trace evidence | **Proved deterministically for current implementation** | Context builder, Pi prompt adapter, context trace repository, and CLI `why` tests cover prompt-layer token evidence, identity/participant boundaries, selected/rejected memory, and redacted trace display. | Production tuning and live group participant/display metadata acceptance. |
| Pi reasoning boundary does not directly mutate storage or send platform messages | **Partially proved** | Pi adapter and tool-adapter tests cover mock/default operation, baseUrl propagation, failed-turn redaction, prompt rendering boundaries, opt-in real-provider gating, and failed-turn rejected tool-call ID linkage to durable `tool_calls` / `audit_log` evidence. | Controlled real provider/evaluator/tool-loop run with timeout/rate-limit behavior and action/tool proposals passing through LetheBot policy/executor. |
| Evaluator / policy gate for risky actions/tools/memory | **Partially proved** | Deterministic policy/tool/action/memory tests cover permission checks, evaluator-required dangerous paths, L0 retrieval boundaries, and audit/redaction. | LLM-backed evaluator workflows and real risky-action acceptance remain unproven. |
| Action executor and response router | **Proved deterministically for core replies and reaction/fallback paths; live incomplete** | Fake private/group flows persist action decisions/executions, outbound bot response rows using the actual delivered action text or `react_only` fallback reaction text, failure/downgrade redaction, true `react_only` reaction side effects without bot-response rows, downgraded `react_only` face/text fallback bot-response evidence, and FK-clean evidence. | Real SnowLuma/QQ sends proving action executor/router delivery on private and group paths. |
| Tool registry, sandbox, permission, audit, redaction | **Proved deterministically for current tool catalog** | File/network/tool registry/tool-call repository tests cover permissions, sandbox/path/network boundaries, audit summaries, payload/error redaction, `why` linked tool-call summaries, and PiAdapter return linkage for rejected tool-call attempts. | Broader product tool catalog and real Pi-proposed tool-call loop evidence. |
| Durable workers, retries, leases, heartbeats, maintenance jobs | **Proved deterministically for current job types** | Job repository, worker scheduler, worker-soak, metrics, and governance-health tests cover attempts, retries, leases, heartbeats, failure visibility, review jobs, aggregate-only output, and FK-clean temp DBs. | Multi-hour/day production soak and live runtime behavior remain unproven. |
| Backup/restore/retention/doctor/rollback ops | **Proved deterministically on disposable DBs** | `tests/integration/ops-maintenance-cli.test.ts`, `pnpm ops:doctor`, backup/restore/retention/metrics tests, `pnpm ops:rehearse-maintenance`, `pnpm ops:rehearse-rollback`, and `docs/operations.md` runbooks. The maintenance rehearsal creates a disposable migrated DB, backs it up, restores it, runs read-only doctor before/after retention, applies retention on the restored copy, and emits aggregate-only FK-clean evidence. The rollback rehearsal restores a pre-update backup over a synthetic update and proves pre/post rollback aggregate counts/fingerprints match. | Operator-run evidence against the real deployment DB path during local acceptance, recorded only as redacted aggregate status. |
| Governance CLI inspect/modify/explain flows | **Strong deterministic evidence; no rich UI** | CLI tests cover memory lifecycle, privacy preferences, display redaction, audit/action/tool/job/event-failure inspection, `why`, memory reviews, compact governance-health, and redaction/FK behavior. | Non-technical web UI remains future; owner/admin auth/product UX still needs productization if required beyond CLI. |
| Health/readiness/metrics/ops output non-leakage | **Proved deterministically** | HTTP health/readiness/metrics tests, ops CLI tests, runtime logger tests, and redaction tests cover DB/adapter degraded states, count-only metrics, Prometheus bounded labels, and no secret/platform leakage. | Live acceptance snapshots from real runtime without raw private identifiers. |
| Deployment/install/update/release runbooks | **Improved but incomplete** | `pnpm release:check` and operations runbook now define deterministic gate, backup, frozen install, maintenance and rollback rehearsals, doctor, health/readiness, optional verify, and evidence validators. Deploy artifact generation now avoids embedding current OneBot token, bot QQ ID, or OneBot URL values into Docker/systemd/PM2 files. | No full distributable installer/update/rollback package; no real operator install/update rehearsal against live SnowLuma/QQ session. |
| Acceptance evidence tooling | **Tooling proved; filled evidence missing** | `pnpm acceptance:evidence-template`, default validator, and `--require-complete` validator have unit/spawned coverage and docs. Complete mode rejects mock provider/source-compose selection, placeholder/failed status evidence, and missing memory/privacy proof. Required DB hints separately require private, exact-mention, and reply-to-bot turns with non-placeholder declared Pi identity, plus one successful Pi-requested tool call joined to an approving non-prohibited evaluator decision, trigger source, actor/context, `tool.executed` audit, delivered reply, and coherent timestamps. Output remains aggregate-only and path-redacted. | Filled `/tmp/lethebot-acceptance-evidence.md` from an explicitly configured real provider and real SnowLuma/QQ acceptance passing both validators. Stored identities and joins do not prove external calls, and offline validation cannot verify the process-local `execution_binding` HMAC. |
| Final completion audit with no unproven item | **Not achieved** | This matrix identifies current evidence and gaps. | Every row above must be `proved` with live evidence where required; current live acceptance rows remain unproven. |


### PiAdapter Rejected Tool-Call Traceability Update - 2026-07-09 02:59 CST

Added deterministic evidence that rejected tool attempts remain turn-linkable even
when they fail the Pi turn. `PiAdapter` now records tool-call IDs for
adapter-audited attempts that reach execution-time policy, including
evaluator-required rejections, policy denials, handler errors, and successes.
The targeted regression drives an evaluator-required tool from inside
`agent.prompt`; the handler is not called, `PiAdapterOutput.status` is `failed`,
`toolCallIds` contains the rejected call ID, and the same ID has redacted
`tool_calls` / `audit_log` rows with clean SQLite foreign keys.

Verification for this slice:

```bash
pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand -t "rejected tool call ids"
# exited 0; 45 passed
pnpm typecheck && pnpm lint && pnpm test:run tests/unit/pi/pi-adapter.test.ts -- --runInBand
# exited 0; typecheck/lint passed; 45 passed
pnpm release:check
# exited 0; 73 passed | 1 skipped test files; 1191 passed | 8 skipped tests
```

This remains deterministic Pi/tool boundary evidence, not real provider or live
SnowLuma/QQ acceptance evidence.

### Current completion decision

Do not call LetheBot production-ready yet. The deterministic/fake-runtime core is
strong and currently gate-green, but the required real SnowLuma/QQ private and
group acceptance evidence is still missing. The next completion-critical action
is to run the documented local acceptance flow with explicitly authorized
runtime/session/secrets and validate `/tmp/lethebot-acceptance-evidence.md` with
both acceptance validators.

### Acceptance Evidence Tooling Update - 2026-07-08 16:01 CST

The Phase 5 evidence template/runbook was tightened so a completed live
acceptance file must record both validator self-checks:

```bash
pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md
pnpm --silent acceptance:validate-evidence -- /tmp/lethebot-acceptance-evidence.md --require-complete
```

`validateLocalAcceptanceEvidence(..., { requireComplete: true })` now also
requires checked evidence that default validation exits `0`, complete validation
exits `0`, and validator output reports only redacted path/status/count fields and
static finding metadata without echoing matched raw values. Targeted validator coverage passed earlier, and the current final `pnpm release:check` passed with `73 passed | 1 skipped`
test files and `1191 passed | 8 skipped` tests. This is still tooling evidence,
not filled live SnowLuma/QQ acceptance evidence.

### Ops Maintenance Rehearsal Update - 2026-07-08 16:11 CST

Added a deterministic disposable maintenance rehearsal:

```bash
pnpm ops:rehearse-maintenance
```

The command defaults to a migrated `/tmp` SQLite DB, seeds only synthetic
non-secret rows, runs backup, restore, read-only doctor before retention,
30-day retention on the restored copy, read-only doctor after retention, and
prints aggregate-only JSON. Targeted integration coverage passed with
`tests/integration/ops-maintenance-cli.test.ts` reporting `19 passed`. A direct
local run with `pnpm --silent ops:rehearse-maintenance` exited `0` with
`success=true`, backup/restore integrity OK, doctor before/after
`overall="ok"`, `foreignKeyViolations=0`, and expected old-row deletion counts
for raw events, chat messages, audit rows, event-processing failures, deleted
memory, memory sources, and memory revisions. This is deterministic local ops
evidence, not live SnowLuma/QQ acceptance or a distributable installer/rollback
artifact. Final `pnpm release:check` after this slice exited `0` with `72
passed | 1 skipped` test files and `1124 passed | 8 skipped` tests.

### Ops Rollback Rehearsal Update - 2026-07-08 16:32 CST

Added a deterministic disposable rollback rehearsal:

```bash
pnpm ops:rehearse-rollback
```

The command defaults to a migrated `/tmp` SQLite DB, seeds only synthetic
non-secret pre-update rows, backs it up, applies a synthetic update across raw
events, chat messages, event-processing failures, audit rows, memory records,
memory sources, and memory revisions, restores the backup over the same DB path
with overwrite enabled, runs read-only doctor, and prints aggregate-only JSON
with counts plus SHA-256 fingerprints. Targeted integration coverage passed
with `2 passed | 18 skipped`; full
`tests/integration/ops-maintenance-cli.test.ts` passed with `20 passed`; direct
`pnpm --silent ops:rehearse-rollback` exited `0` with `success=true`,
`restoredMatchesBackup=true`, `syntheticRowsRemoved=true`,
`overall="ok"`, and `foreignKeyViolations=0`. This improves deterministic
install/update rollback evidence, but it is not live SnowLuma/QQ acceptance or
a full distributable installer/update package. Final `pnpm release:check` after
this slice exited `0` with `72 passed | 1 skipped` test files and `1126 passed
| 8 skipped` tests.

### Acceptance Complete-Status Validator Update - 2026-07-08 16:42 CST

Strengthened the opt-in complete acceptance validator so checked evidence cannot
claim completion with failed or degraded status values. `--require-complete`
now requires checked `/healthz` health, database, and adapter-ready status,
`/readyz` readiness, private and group `agent_turns` completion, and private and
group `action_executions` success. Checked `failed`, `rejected`, `degraded`,
`not_ready`, or placeholder status values produce `invalid-complete-status` or
placeholder findings. The template now also asks for group `agent_turns` status
evidence. Targeted local acceptance evidence coverage passed with `20 passed`;
`pnpm typecheck` and `pnpm lint` passed. This is still evidence-tooling
hardening, not filled live SnowLuma/QQ acceptance evidence.

### Acceptance Memory/Privacy Completion Gate Update - 2026-07-08 16:47 CST

Strengthened the opt-in complete acceptance validator so memory/privacy proof is
required, not optional. `--require-complete` now requires checked evidence that
governed memory affects an allowed follow-up answer without cross-scope or
private-in-group leakage, group-derived user memory remains conservative and
source-linked to `group_chat` when applicable, lifecycle/sensitivity exclusions
apply to ordinary context, and a user/admin can inspect relevant memory through
governance CLI with redaction. Targeted local acceptance evidence coverage
passed with `21 passed`; `pnpm typecheck` and `pnpm lint` passed. This is still
evidence-tooling hardening, not filled live SnowLuma/QQ acceptance evidence.

### Acceptance Mixed-Redaction Validator Update - 2026-07-08 16:58 CST

Hardened the default local acceptance evidence share-safety validator so a raw
QQ/group/platform-like number is still rejected even if the same evidence line
also contains a nearby `<redacted>` marker or redacted note. This closes a
manual-evidence failure mode where operators could annotate a line as redacted
while accidentally leaving the identifier in place. Targeted local acceptance
evidence coverage passed with `22 passed`; `pnpm typecheck` and `pnpm lint`
passed. This is deterministic evidence-tooling hardening only; filled live
SnowLuma/QQ private/group acceptance evidence is still missing.

### Acceptance Command-Evidence Completion Gate Update - 2026-07-08 17:07 CST

Strengthened the opt-in complete acceptance validator so filled live evidence
cannot skip required command preflight proof. `--require-complete` now requires
checked evidence that both compose `config --quiet` checks passed, the local
`pnpm ops:worker-soak` run exited successfully with aggregate-only output, the
acceptance DB `PRAGMA foreign_key_check` returned no rows, and required command
output summaries omit secrets, raw messages, platform identifiers, local
secret-file contents, and DB row contents. Targeted local acceptance evidence
coverage passed with `23 passed`. This is still deterministic evidence-tooling
hardening only; filled live SnowLuma/QQ private/group acceptance evidence is
still missing.

### Acceptance Runtime-Config Exclusivity Gate Update - 2026-07-08 17:15 CST

Strengthened the opt-in complete acceptance validator so filled live evidence
must identify one concrete runtime configuration. `--require-complete` now
rejects missing or conflicting checked choices in the local configuration
snapshot: exactly one compose target, one Pi provider mode, and one OneBot
transport must be selected. Targeted local acceptance evidence coverage passed
with `24 passed`. This is deterministic evidence-tooling hardening only; filled
live SnowLuma/QQ private/group acceptance evidence is still missing.

### Acceptance DB Summary Required-Hints Update - 2026-07-08 17:34 CST

Added an aggregate-only read-only acceptance DB summary helper mode:

```bash
pnpm acceptance:db-summary -- --db=<acceptance-db-path> --require-acceptance-hints
```

The helper prints redacted-path JSON with integrity/FK status, private/group
chat counts, context trace counts, turn/action status counts,
memory/source/revision counts, tool/audit/failure counts, and boolean evidence
hints. It intentionally omits row IDs, platform IDs, message text, memory
content, tool payloads, audit details, and DB row contents.
`--require-acceptance-hints` exits non-zero unless integrity/FKs are clean and
the aggregate hints show private and group paths separately have chat rows,
context traces, completed turns, and successful actions, plus
memory-governance rows. The evidence template and complete-mode validator now
include this required-hints command as required aggregate DB evidence. Targeted
local acceptance evidence coverage passed with `27 passed`, `pnpm typecheck` /
`pnpm lint` passed. This is deterministic helper tooling only; filled live
SnowLuma/QQ private/group acceptance evidence is still missing.

### Acceptance DB Summary Group-Scope Required-Hints Update - 2026-07-09 10:45 CST

Strengthened `acceptance:db-summary --require-acceptance-hints` so group
completion evidence must carry a real normalized group scope through the same
complete flow. A group path now needs the triggering group `chat_messages` row
to have exact `mentions_bot=1` plus a gateway-normalized
`qq-group-<digits>` `group_id`, and the selected `context_traces` row and
matching bot-response `chat_messages` row must preserve that same group ID.
This prevents group-scope-less or mismatched group rows from satisfying group
`@bot` acceptance DB hints.

Failing-first targeted coverage initially showed group hints stayed true after
the trigger row lost `group_id`. After the fix:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "group scope" --silent
# exited 0; 2 passed | 39 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 41 passed

pnpm release:check
# exited 0; 75 passed | 1 skipped test files; 1232 passed | 8 skipped tests
```

This is deterministic aggregate acceptance-helper hardening only. It still does
not replace real controlled SnowLuma/QQ private and group chat actions or the
filled `/tmp/lethebot-acceptance-evidence.md` passing both validators.

### Acceptance DB Summary Selected Governed-Memory Tool-Source Update - 2026-07-10 03:45 CST

Strengthened and regression-locked `acceptance:db-summary --require-acceptance-hints` so successful
`tool_output` source evidence must be compatible with the selected memory
owner/scope, not merely have `status='success'`. User-scoped memory cannot be
proven by another user's successful tool call. Group-scoped memory cannot be
proven by a successful tool call from another group context, and
conversation-scoped memory cannot be proven by a successful tool call from
another conversation context. When a successful tool call has no stored actor
ID, compatibility can still be inferred from the source turn's sender/context.

Failing-first targeted coverage initially showed
`selectedGovernedMemoryContexts` stayed `1` after the selected user memory
source row was repointed to another user's successful tool call. After the fix:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "tool sources" --silent
# initially exited 1 because another user's successful tool call still counted
# after fix exited 0; 2 passed | 48 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "group memory tool sources" --silent
# exited 0; 2 passed | 50 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "conversation memory tool sources" --silent
# exited 0; 2 passed | 52 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 54 passed

pnpm typecheck
# initially exited 2 because rowExists became unused, then exited 0 after deleting the unused helper
pnpm lint
# exited 0

pnpm release:check
# exited 0; 75 passed | 1 skipped test files; 1245 passed | 8 skipped tests
```

This is deterministic aggregate acceptance-helper hardening only. It still does
not replace real controlled SnowLuma/QQ private and group chat actions or the
filled `/tmp/lethebot-acceptance-evidence.md` passing both validators.

### Acceptance DB Summary Selected Governed-Memory Worker-Source Update - 2026-07-10 03:23 CST

Strengthened `acceptance:db-summary --require-acceptance-hints` so completed
`worker_extraction` source evidence must preserve explicit raw/chat provenance,
not merely point to any completed job or attempt. The worker row's payload/result
must include raw/chat source identifiers, and those identifiers must resolve to
usable, owner/scope-compatible inbound QQ chat evidence. This prevents a
selected memory from satisfying complete memory-governance DB hints when its
only source is a completed worker row without traceable chat/raw provenance.

Failing-first targeted coverage initially showed
`selectedGovernedMemoryContexts` stayed `1` after the selected memory source
row was repointed to a completed worker job without chat/raw provenance. After
the fix:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "worker memory sources" --silent
# initially exited 1 because completed worker job without chat/raw provenance still counted
# after fix exited 0; 2 passed | 46 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 48 passed

pnpm typecheck
# exited 0
pnpm lint
# exited 0

pnpm release:check
# exited 0; 75 passed | 1 skipped test files; 1239 passed | 8 skipped tests
```

This is deterministic aggregate acceptance-helper hardening only. It still does
not replace real controlled SnowLuma/QQ private and group chat actions or the
filled `/tmp/lethebot-acceptance-evidence.md` passing both validators.

### Acceptance DB Summary Selected Governed-Memory Owner/Scope Source Update - 2026-07-10 03:13 CST

Strengthened `acceptance:db-summary --require-acceptance-hints` so selected
inbound raw/chat source evidence must be compatible with the selected memory
owner/scope, not merely usable in isolation. User-scoped memories now require
raw/chat source evidence from the same canonical owner; `private_only` user
sources must be private, `same_group_only` user sources must match group or
conversation, group-scoped sources must match memory group/conversation, and
conversation-scoped sources must match memory conversation. This prevents a
selected user memory from satisfying complete memory-governance DB hints when
its only usable chat source came from another user.

Failing-first targeted coverage initially showed
`selectedGovernedMemoryContexts` stayed `1` after the selected memory source
row was repointed to another user's inbound chat row. After the fix:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "memory owner" --silent
# initially exited 1 because another user's chat source still counted

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "memory owner|usable source|source links" --silent
# exited 0; 3 passed | 43 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 46 passed

pnpm typecheck
# exited 0
pnpm lint
# exited 0

pnpm release:check
# exited 0; 75 passed | 1 skipped test files; 1237 passed | 8 skipped tests
```

This is deterministic aggregate acceptance-helper hardening only. It still does
not replace real controlled SnowLuma/QQ private and group chat actions or the
filled `/tmp/lethebot-acceptance-evidence.md` passing both validators.

### Acceptance DB Summary Selected Governed-Memory Usable-Source Update - 2026-07-10 03:03 CST

Strengthened `acceptance:db-summary --require-acceptance-hints` so selected
governed-memory completion evidence must resolve to usable durable source
evidence, not just any existing row. Usable source evidence for this helper is
an inbound QQ `chat.message.received` raw event with a linked inbound
non-bot chat row, an inbound non-bot chat row linked to that raw event, a
successful tool call whose actor or source turn context is compatible with the selected memory boundary, or a completed job/job attempt with explicit compatible raw/chat provenance in payload/result. Bot-response chat rows, rejected/error tool calls, successful tool calls from another user/context, completed worker rows without compatible chat/raw provenance, orphan source IDs,
and `user_command`-only source links do not satisfy
`selectedGovernedMemoryContextPresent`, even when memory source/revision rows
exist and SQLite FKs are clean.

Failing-first targeted coverage initially showed
`selectedGovernedMemoryContexts` stayed `1` after the selected memory source
row was repointed to a rejected tool call. After the fix:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "usable source" --silent
# initially exited 1 because rejected tool-call source evidence still counted

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "usable source|source links" --silent
# exited 0; 2 passed | 43 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 45 passed

pnpm release:check
# exited 0; 75 passed | 1 skipped test files; 1236 passed | 8 skipped tests
```

This is deterministic aggregate acceptance-helper hardening only. It still does
not replace real controlled SnowLuma/QQ private and group chat actions or the
filled `/tmp/lethebot-acceptance-evidence.md` passing both validators.

### Acceptance DB Summary Selected Governed-Memory Source-Link Update - 2026-07-10 00:37 CST

Strengthened `acceptance:db-summary --require-acceptance-hints` so selected
governed-memory completion evidence must have at least one source link that
resolves to a durable source row. `chat_message` sources resolve through
`chat_messages.id` or `chat_messages.message_id`, and table-backed source
links also resolve through `raw_events`, `tool_calls`, `jobs`, or
`job_attempts`. Orphan source IDs and `user_command`-only source links no
longer satisfy `selectedGovernedMemoryContextPresent`, even when
`memory_sources` / `memory_revisions` rows exist and SQLite FKs are clean.

Failing-first targeted coverage initially showed
`selectedGovernedMemoryContexts` stayed `1` after the selected memory source
row was repointed to a missing chat-message source. After the fix:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "source links" --silent
# exited 0; 1 passed | 43 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 44 passed

pnpm release:check
# exited 0; 75 passed | 1 skipped test files; 1235 passed | 8 skipped tests
```

This is deterministic aggregate acceptance-helper hardening only. It still does
not replace real controlled SnowLuma/QQ private and group chat actions or the
filled `/tmp/lethebot-acceptance-evidence.md` passing both validators.
### Acceptance DB Summary Selected Governed-Memory Visibility Update - 2026-07-10 00:07 CST

Strengthened `acceptance:db-summary --require-acceptance-hints` so selected
governed-memory completion evidence must be visible in the same complete
acceptance flow context. A selected memory still must be active,
source/revision-linked, and non-secret/prohibited; now `private_only` counts
only for private flows, while `same_group_only` counts only for matching group
or conversation scope. This prevents a group complete flow that selected
`private_only` memory from satisfying memory-governance DB hints.

Failing-first targeted coverage initially showed `selectedGovernedMemoryContexts`
stayed `1` after the group flow selected `private_only` memory. After the fix:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "visible in the flow context" --silent
# exited 0; 1 passed | 41 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 42 passed

pnpm release:check
# exited 0; 75 passed | 1 skipped test files; 1233 passed | 8 skipped tests

git diff --check
# exited 0
```

This is deterministic aggregate acceptance-helper hardening only. It still does
not replace real controlled SnowLuma/QQ private and group chat actions or the
filled `/tmp/lethebot-acceptance-evidence.md` passing both validators.
### Acceptance DB Summary Selected Governed-Memory Scope/Actor Update - 2026-07-10 00:21 CST

Strengthened `acceptance:db-summary --require-acceptance-hints` so selected
governed-memory completion evidence must be scoped to the same complete
acceptance flow actor/context, not merely visible. User-scoped selected memory
now must belong to the triggering sender through an active QQ platform-account
mapping; group-scoped memory must match the flow group or conversation;
conversation-scoped memory must match the flow conversation; global/system
memory counts only when public. This prevents a complete flow that selected
another user's user-scoped memory from satisfying memory-governance DB hints.

Targeted and full deterministic coverage after the fix:

```bash
pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts -t "other user|visible in the flow context" --silent
# exited 0; 1 passed | 42 skipped

pnpm exec vitest run tests/unit/scripts/local-acceptance-evidence.test.ts --silent
# exited 0; 43 passed

pnpm release:check
# exited 0; 75 passed | 1 skipped test files; 1234 passed | 8 skipped tests
```

This is deterministic aggregate acceptance-helper hardening only. It still does
not replace real controlled SnowLuma/QQ private and group chat actions or the
filled `/tmp/lethebot-acceptance-evidence.md` passing both validators.
