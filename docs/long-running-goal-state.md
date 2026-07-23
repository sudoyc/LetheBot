# Long-Running Goal State

- `updated_at`: 2026-07-14 13:05 CST +0800
- `goal_status`: `BLOCKED_EXTERNAL`
- `group_reliability_status`: `ACTIVE`
- `branch`: `main`
- `head`: `10b5db588f48`
- `worktree`: 167 tracked-dirty, 84 untracked, 251 total in the final protected
  completion-audit recount
- `ownership`: every pre-existing source, test, documentation, migration,
  container/configuration, data, and scratch path is protected WIP. No commit,
  staging, cleanup, or revert is authorized.
- `authorization`: deterministic local implementation and aggregate-only,
  read-only inspection are authorized. Prior container, credential, and QQ
  authorization covered the already recorded operations; it is not blanket
  authority for future provider calls, QQ sends, session use, or container
  recreation. Obtain applicable explicit authority when a later slice reaches
  one of those actions. Secrets, raw chat text, private platform identifiers,
  and live database rows remain excluded from committed or shared evidence.

## Baseline

| Time | Check | Scope | Result |
|---|---|---|---|
| 2026-07-12 18:03 CST | worktree/HEAD inventory | protected current workspace | 155 tracked-dirty, 51 untracked; `main@10b5db588f48` |
| 2026-07-12 18:04 CST | `pnpm release:check` | typecheck, lint, build, preflight, deterministic tests, diff hygiene | exit 0; 89 passed / 1 skipped files, 1714 passed / 10 skipped tests |
| 2026-07-12 18:03 CST | Compose/runtime inspection | current Framework stack | LetheBot and SnowLuma healthy with zero restarts |
| 2026-07-12 18:06 CST | schema-v1 baseline image | complete current build context | image `sha256:8406929513b542ce5bf0d484a94ae09b02ad03e9f5dd6cbd58b5b24506ca0872`; schema target/readable range `1/1..1` |
| 2026-07-12 18:07 CST | immutable v1 image export | private neutral `/tmp` artifact | tar SHA256 `6b1495911be431e67931eca70f215dbf4ea657ecc11e81e189b8271ca9dd8e81`; mode `0600` |
| 2026-07-12 18:18 CST | `pnpm release:check` | post target-v1 sequential migration bridge | exit 0; 90 passed / 1 skipped files, 1727 passed / 10 skipped tests |
| 2026-07-12 22:56 CST | focused rollback/gate suite | journal v2, startup gate, release controller/CLI, deployment assets | exit 0; 4 files, 137 tests passed |
| 2026-07-12 22:59 CST | `pnpm release:check` | post rollback/startup/dependency hardening | exit 0; 91 passed / 1 skipped files, 1778 passed / 10 skipped tests |
| 2026-07-12 23:18 CST | frozen-v1 cross-version rollback rehearsal | immutable v1 image process, synthetic distinct schema-v2 candidate, disposable DB/root | exit 0; v2 observed then readiness rejected; DB/schema/metadata restored; frozen v1 restarted ready; operation artifacts removed |
| 2026-07-12 23:28 CST | frozen-v1 managed release bundle | current green v1 `dist`, 001 migration, manifest, lockfile, and release-local dependencies | managed digest `dea6333ca5ebb6f1fa888cb37c1f77f9978755c19b97dc94da28c403de0f4491`; private tar SHA256 `443c1d9843d9a26784cdbe4bd0d6c3e1cb46ae60849ca93ab382ebe3ec524efc` |
| 2026-07-13 00:22 CST | schema-v2 focused gate | sequential runner, migration/preflight, release lifecycle/CLI, static checks | exit 0; 6 files / 198 tests, typecheck and scoped lint passed |
| 2026-07-13 00:23 CST | final v2 managed release bundle | built current release with 001/002, exact 2/1..2 contract, lockfile, dependencies | managed digest `cf23e670ad5d7cfcf6aece256f37fd9372b62b8eeebe016dc2b25fa76c810a11`; private tar SHA256 `0680ea2ecb83acccc9c1ba7a00874cbded85c4602a154f4dc490c20af7ff0bcf` |
| 2026-07-13 00:24 CST | real frozen-v1/final-v2 rehearsal | three disposable roots using distinct immutable managed releases | exit 0; failure rollback, pending crash recovery, wrong/exact confirmation, marker-free restart, DB metadata/integrity/FKs, and cleanup all true |
| 2026-07-13 00:54 CST | `pnpm release:check` | post background evaluator authority cutover; typecheck, lint, build, preflight, deterministic tests, diff hygiene | exit 0 |
| 2026-07-13 01:15 CST | `pnpm release:check` | post exact job-attempt lease fencing; typecheck, lint, build, preflight, deterministic tests, diff hygiene | exit 0 |
| 2026-07-13 01:23 CST | `pnpm release:check` | post lifecycle mutation authority separation and immutable create-evidence retry; full deterministic release gate | exit 0 |
| 2026-07-13 02:01 CST | `pnpm release:check` | schema-v3 evaluator invocation linkage; typecheck, lint, build, preflight, deterministic tests, diff hygiene | exit 0; 93 passed / 1 skipped files, 1844 passed / 10 skipped tests |
| 2026-07-13 02:03 CST | opt-in real Provider evaluator suite | authorized local credential; content-free invocation/decision evidence | exit 0; 10/10 tests passed; one completed evaluator invocation linked to a rejected governed-tool decision; integrity/FKs clean |
| 2026-07-13 02:07 CST | final v3 managed release bundle | built current release with 001/002/003, exact 3/1..3 contract, lockfile, dependencies | managed digest `bfdca3e068a11b12dc59074e2214de35ef15d141676e21d5daff6b450636a01f`; private tar SHA256 `02638284b196081fd2f236903ccb61dd2295ef0e2a4ee08c6e2c42cfe8e655d7` |
| 2026-07-13 02:10 CST | real frozen-v2/final-v3 rehearsal | disposable roots using distinct immutable managed releases | exit 0; readiness rollback, crash recovery, restart denial, wrong/exact confirmation, marker-free restart, v2/v3 ledger/columns, sentinel preservation, integrity/FKs, and cleanup all true |
| 2026-07-13 03:23 CST | opt-in real Provider suite | authorized local credential after memory/evaluator fixes | exit 0; 10/10 tests passed; completed evaluator invocation linked to an approved successful governed tool; integrity/FKs clean |
| 2026-07-13 03:55 CST | `pnpm release:check` | final acceptance chronology, runtime verifier dependency boundary, build/preflight, deterministic tests, diff hygiene | exit 0; 93 passed / 1 skipped files, 1876 passed / 10 skipped tests |
| 2026-07-13 03:57 CST | final Framework image/recreation | only `lethebot`; inherited reviewed runtime configuration; credential injected from authorized local file | image `sha256:02473a27ce9313ee8d5de692e073fc2808eb3228f144c5555f1589a8b21c3b0a`; post-prune verifier import passed; SnowLuma container/session identity preserved |
| 2026-07-13 04:00 CST | post-deploy runtime verification | real Framework/OneBot WS, SQLite, metrics, permissions | health `ok`; readiness `ready`; standalone pruned-image verifier passed; schema 3, integrity `ok`, FK violations 0; JSON/Prometheus metrics 200; containers healthy |
| 2026-07-13 22:58 JST | fresh read-only usability audit | online backup, last-hour aggregate runtime/DB evidence, no new QQ sends | both containers healthy; schema 3; integrity `ok`; FK violations 0; transport/storage/delivery healthy; group reliability not accepted |
| 2026-07-13 23:25 JST | `pnpm release:check` | post reliability evidence/documentation control-plane update | exit 0; typecheck, lint, build, preflight, and diff hygiene passed; 93 passed / 1 skipped files, 1876 passed / 10 skipped tests |
| 2026-07-14 03:57 CST | `pnpm release:check` | completed R5 delayed Attention plus fresh decision-clock and CLI failure-stage review fixes | exit 0; typecheck, lint, build, preflight, diff hygiene, and 97 passed / 1 skipped files with 2002 passed / 10 skipped tests |
| 2026-07-14 05:22 CST | `pnpm release:check` | integrated R6 policy/job/worker/retrieval/action core plus explicit-policy fixture recovery | exit 0; typecheck, lint, build, preflight, diff hygiene, and 101 passed / 1 skipped files with 2048 passed / 10 skipped tests |
| 2026-07-14 05:58 CST | `pnpm release:check` | final R7A reply-independent high-precision extraction admission and interrogative hardening | exit 0; typecheck, lint, build, preflight, diff hygiene, and 101 passed / 1 skipped files with 2104 passed / 10 skipped tests |
| 2026-07-14 07:00 CST | `pnpm release:check` | final R7B frozen post-budget group-summary windows, route convergence, retention pins, and terminal-window hardening | exit 0; typecheck, lint, build, preflight, diff hygiene, and 101 passed / 1 skipped files with 2119 passed / 10 skipped tests |
| 2026-07-14 07:12 CST | `pnpm release:check` | final R7C fresh-application restart recall and exact-group isolation regression | exit 0; typecheck, lint, build, preflight, diff hygiene, and 101 passed / 1 skipped files with 2120 passed / 10 skipped tests |
| 2026-07-14 08:05 CST | `pnpm release:check` | final R8 query/FTS/scope ranking, trace evidence, cross-owner pre-limit filtering, and deterministic tie ordering | exit 0; typecheck, lint, build, preflight, diff hygiene, and 103 passed / 1 skipped files with 2127 passed / 10 skipped tests |
| 2026-07-14 12:54 CST | `pnpm release:check` | final credential-free R0-R8 completion-audit repairs, acceptance validator, process restart, memory truthfulness, delayed Attention evidence, build/preflight, and diff hygiene | exit 0; 106 passed / 1 skipped files and 2272 passed / 10 skipped opt-in live tests |

The v1 artifact is
`/tmp/lethebot-v1-baseline-20260712-1806/lethebot-v1-image.tar`. It is the
rollback baseline for the current dirty-but-green worktree, not a claim that
HEAD alone contains the protected WIP.
The managed-release v1 baseline is
`/tmp/lethebot-v1-managed-20260712-232832/release`; its private archive is
`/tmp/lethebot-v1-managed-20260712-232832/lethebot-v1-managed.tar`. Unlike the
container export, this bundle includes the lockfile and release-local runtime
dependencies required by the managed release digest and startup gate.
The final schema-v2 candidate is
`/tmp/lethebot-v2-final-managed-20260713-002328/release`; its private archive is
`/tmp/lethebot-v2-final-managed-20260713-002328/lethebot-v2-final-managed.tar`.
The final schema-v3 candidate is
`/tmp/lethebot-v3-final-managed-20260713-020731/release`; its private archive is
`/tmp/lethebot-v3-final-managed-20260713-020731/lethebot-v3-final-managed.tar`
with mode `0600`.

## Current Slice

- `requirement`: authorized R4/TARGET_COMPLETE live behavior matrix and restart
  canary after the credential-free R0-R8 completion audit
- `status`: all locally actionable completion-audit findings are closed. The
  complete validator now requires bounded successful evidence for every named
  R0/`REL-*` scenario, health/readiness/metrics privacy, canonical group scope,
  exact provenance joins, real dates/timestamps, and safe typed fields. OS-process
  restart recall, source-bound memory claims, delayed Attention retry/source/job
  evidence, and the named R0-R8 deterministic matrix pass. The final
  credential-free release gate is green; neither `BASIC_USABLE` nor
  `TARGET_COMPLETE` is claimed without the controlled live matrix. A fresh
  hardened evidence template now exists at a neutral private `/tmp` path: its
  default validator passes and complete mode correctly rejects the unfilled
  live evidence. Three consecutive goal turns reached the same external-only
  boundary without new authority, so the umbrella goal is `BLOCKED_EXTERNAL`;
  scoped reliability remains `ACTIVE` and unproved.
- `track`: blocked pending fresh explicit authority to deploy only the reviewed
  LetheBot candidate, run the bounded private/group/governance/memory/restart
  canary, collect aggregate-only evidence, and pass both validators.
- `why_now`: a 2026-07-14 13:00 CST aggregate-only preflight found the current
  LetheBot and SnowLuma containers healthy, readiness ready, WS connected, and
  zero pending event processing. The running LetheBot container predates the
  reviewed candidate and retains nonzero historical group social-decision
  failures, so it cannot provide acceptance evidence for the repaired code.
  The next evidence requires Provider, SnowLuma/QQ session, LetheBot container,
  and send authority that prior operations do not grant.
- `remaining_external_condition`: fresh explicit authorization to use the local
  Provider credential, build/recreate/restart only the LetheBot container while
  preserving the SnowLuma container/session, and send the bounded private/group
  QQ canary sequence. Earlier authorization does not carry forward.
- `completed_scope`: exact `/memory` and `/why` grammar; canonical
  `qq-group-[1-9][0-9]{4,11}` scope; bot-owner/exact-group authority; group-safe
  listing and exact-group owner/admin forget, with broad bot-owner known-ID and
  local CLI forget; immediate source-linked deletion; default-off summary
  lifecycle; no-backfill across persisted/pending-normalization ingress;
  rollback/max-clock safe disable; redacted purpose-bound audit correlation;
  zero-token local turns; duplicate and send-failure behavior; and bounded
  spawned CLI errors.
- `acceptance_assertions`: the authorized live matrix must show zero
  speaker/quote misattribution, cross-group leakage, unsupported memory claims,
  and ordinary direct replies lost to evaluator failure; exact governance
  authority/effects must match durable rows; integrity/FKs must be clean; and
  both acceptance validators must pass with aggregate-only evidence.
- `verification`: the focused reliability gate passed 12 files / 555 tests;
  standalone typecheck and lint passed; `pnpm release:check` at 2026-07-14
  12:54 CST exited 0 after typecheck, lint, build, preflight, 2272 deterministic
  tests, and diff hygiene. No Provider call, QQ send, deployment, container
  recreation, credential read, or live-row inspection occurred. The fresh
  evidence template is mode `0600`, passes default validation with zero
  findings, and fails complete validation on 96 expected unfilled fields. The
  read-only runtime preflight used only redacted health/readiness/metrics and
  container status; it inspected no environment, credential, chat, or DB row.
- `rollback_boundary`: no live deployment, Provider call, QQ send, container
  recreation, schema change, commit, or staging occurred in the completion
  audit. A future canary uses the reviewed deployment rollback procedure and
  restores the prior image on acceptance failure.
- `allowed_paths`: the private fresh `/tmp` evidence template, aggregate-only
  read-only runtime inspection, this evidence-only checkpoint update, and final
  diff/whitespace checks. Further Provider, QQ, deployment, container,
  credential, or live-row operations require fresh explicit authority.
- `protected_paths`: every unrelated existing or unknown path, local Provider
  credentials, SnowLuma data/config contents, real chat text, and live DB rows.

## Current Usability Verdict

| Surface | Verdict | Evidence boundary |
|---|---|---|
| OneBot transport, raw/chat persistence, delivery | `OPERATIONAL` | Last-hour ingress was fully claimed/persisted; 58 successful replies had platform IDs and matching bot rows; no send failure. |
| Private direct chat and governed recall | `LIMITED_USABLE` | Earlier controlled private reply/proposal/approval/recall succeeded with correct private scope, and fresh-app restart recall is deterministic. The fresh audit window had no private messages; live restart/next-day recall remains unproved. |
| Group direct mention | `UNRELIABLE` | All 65 mentions created turns, but only 57 delivered; seven failed at evaluator parsing and one was policy-rejected silent. |
| Native reply to bot | `UNRELIABLE` | Gateway quote normalization worked, but only 8 of 12 reply-to-bot turns delivered; four failed evaluator parsing and quote relation was absent from Pi context. |
| Multi-person conversational attribution | `DETERMINISTIC_READY_LIVE_UNPROVED` | Opaque speakers, selected participants, explicit current input, and bounded same-conversation quotes pass deterministic gates; the last live runtime audit predates those fixes. |
| Group/cross-session memory | `NOT_AVAILABLE` live | The live runtime had no active group/conversation/global memory, summary jobs, or selected group memory. Exact-group opt-in, source-complete windows, fresh-app recall, and query-aware selection are deterministic only; live continuity remains open. |
| Worker/runtime health | `OPERATIONAL_LIMITED` | Extraction is live-proved; delayed Attention, reply-independent extraction, exact-group summary fencing, and frozen source windows are deterministic but not live-deployed. |
| Governance | `DETERMINISTIC_READY_LIVE_UNPROVED` | QQ `/memory`/`/why` and CLI delete/summary operations share governance with exact authority/scope, atomic effects, and bounded audit/output; no fresh QQ command canary is authorized. |
| Overall target product | `EXPERIMENTAL_NOT_NORMAL` | The stack can receive, reason, and send, but multi-person/quote correctness and direct-trigger reliability fail the basic usability gate. |

## Requirement Matrix

| ID | Status | Current evidence and exact gap |
|---|---|---|
| `GW` | `PROVED` live | Last-hour receipts were accepted; every successful reply had a platform message ID and matching same-conversation bot row; no delivery failure was observed. |
| `ING` | `IN_PROGRESS` | Raw/chat/admission persistence and deduplication are healthy; delayed candidates, extraction intents, frozen summary windows, and fresh-app recall are source-bound, durable, and FK-clean. Live deployment remains open. |
| `TURN` | `IN_PROGRESS` | Deterministic terminal evaluator failure now completes social processing with governed suppression evidence; the fixed path still needs the R4 live canary, and broader turn-runtime evidence remains open. |
| `ACT` | `IN_PROGRESS` | R2A-R3 and R5 deterministically prove addressing/risk separation, bounded evaluator failure, revision/source-bound memory wording, delayed source revalidation, suppressor attempts, and indeterminate-delivery failure. The corrected paths are not live-canary proved. |
| `MEM` | `IN_PROGRESS` | Private governed recall, privacy rejection, effect-bound outbound claims, exact creation-source binding, exact-group summary policy, reply-independent same-group proposals, source-complete summaries, two-process recall, query-aware selection, and QQ governance are deterministic. Live continuity/recall remains open. |
| `CTX` | `IN_PROGRESS` | R1 and R8 deterministically prove opaque distinct speakers, explicit current input, bounded same-conversation quotes, selected participants, budgeting, query-aware ranking, and trace evidence; the corrected pack still needs the R4 live canary. |
| `PI` | `IN_PROGRESS` | Real Provider replies are fast and deliverable, but completed turns record zero token usage and Pi-purpose provider invocations are not durably ledgered. |
| `TOOL` | `IN_PROGRESS` | Registry/policy/effect controls are deterministically strong; R2B now records bounded rejected tool/audit evidence when evaluator correction fails, but the corrected path is not yet live-canary proved. |
| `WORK` | `IN_PROGRESS` | Extraction jobs are live-healthy; delayed rechecks, summary policy fencing, reply-independent admission, frozen source-complete windows, and restart reopen behavior are durable and deterministic. Live deployment remains open. |
| `GOV` | `IN_PROGRESS` | `REL-GOV-01` deterministically proves shared QQ `/memory`/`/why` and CLI delete/summary governance, exact authority/scope, group-safe lifecycle, atomic command effects, summary cancellation/no-backfill, prior-turn explanation, and bounded audit/output. Fresh live QQ governance proof remains open. |
| `OPS` | `IN_PROGRESS` | Current containers, schema, integrity/FKs, worker heartbeat, delivery, and latency are healthy; long soak, retention consistency, and off-host publication remain broader production work. |
| `LIVE` | `IN_PROGRESS` | Real private recall, group mentions, quotes, provider turns, delivery, and isolation have evidence, but recent direct-trigger failure rate and semantic attribution fail the usability gate; deterministic restart proof does not establish live restart/next-day recall. |
| `DOC` | `IN_PROGRESS` | Entry navigation, scoped constraints, R1-R8 contracts, QQ governance, policy clock/audit boundaries, and the strict structured acceptance validator are current. The authorized live evidence audit remains open. |

## Product Decision References

The stable thresholds and behavior decisions previously stored in this mutable
checkpoint now live in `docs/design-decisions.md`:

- D9: group addressing and delayed Attention;
- D10: group context identity and quote semantics;
- D11: memory thresholds, per-group opt-in, QQ governance, and retention;
- D12: evaluator failure and memory-claim truthfulness.

## Ordered Repair Route

| Slice | Outcome | Verification and rollback boundary |
|---|---|---|
| `R0` | Add synthetic structural replay fixtures for multi-speaker history, duplicate display names, quote targets inside/outside the rolling window, narrative admin text, invalid evaluator output, and unsupported memory claims. Prove current failures before source edits. | Tests/docs only; no runtime or schema change. |
| `R1` | Add opaque speaker/message refs, selected-participant display metadata, explicit current message, and bounded same-conversation quote relations to ContextPack, Pi rendering, budgeting, and trace. | Limit edits to context/identity/types/Pi/main wiring and tests; prefer no migration; rollback image restores behavior. |
| `R2A` | Separate respond/defer/silent relevance from action risk; use deterministic admin commands and correct `isProactive`. | Attention/social-decision slice only; no evaluator transport or dependency change. |
| `R2B` | Use provider structured output when supported; otherwise one separately ledgered correction attempt; terminal true-risk failure becomes durable governed suppression, never fail-open. | Evaluator core and its tests; do not combine with R2A deployment or dependency upgrades. |
| `R3` | Bind each memory claim to the exact same proposition, subject, scope, source/effect, and lifecycle state in selected active memory or a fully committed same-turn proposal effect; correct unsupported text before send and persist the delivered version. Same-turn activation is not applicable because activation is a later governance transition. | Independent response/action guard; memory lifecycle remains unchanged; unrelated selected memory never authorizes a claim. |
| `R4` | Run deterministic gates and the authorized multi-participant/quote/admin/rapid-trigger QQ canary. Record `BASIC_USABLE` only with zero attribution, isolation, unsupported-claim, and ordinary-direct evaluator-loss failures. | Deploy the reviewed current R1-R8 candidate; canary failure restores the prior image. |
| `R5` | Add durable delayed Attention with the locked 15-second/120-second/human-answer/traffic/budget policy and auditable terminal suppressors. | New job type is isolated; stop enqueue and drain/cancel it before worker rollback. |
| `R6` | Reuse one governance service for deterministic QQ `/memory`/`/why` plus CLI delete/summary operations; CLI `/why` parity is not required. Add per-group summary opt-in defaulting off. Only the bot owner or a normalized owner/admin of that exact group may change it. Disable immediately stops enqueue/retrieval and cancels pending summary jobs; retained summaries stay governed and separately deletable. | Any preference schema is a separate migration with upgrade, FK, restore, and cross-version rollback evidence. Re-enable does not backfill missed windows. |
| `R7` | Run high-precision source-backed candidate detection after persistence, independent of replies; process summaries only for opted-in groups; prove approved recall after restart. | Scheduler paths remain opt-in and idempotent; stopping them does not rewrite existing memory state. |
| `R8` | Run `REL-RET-01`: at least 12 synthetic queries, each with one expected same-scope source, at least eight newer/higher-importance same-scope distractors, and incompatible-scope records. Skip ranking code only if the expected source is selected in 12/12 under production count/token limits, incompatible selections are zero, and trace reasons are complete; otherwise add current-query/FTS/quote/thread ranking. | Retrieval ranking is independently reversible to importance/recency; embeddings remain excluded without separate evidence. |

## Blockers And Exact Next Action

- The final scoped audit found no remaining safe local implementation or
  deterministic evidence gap. The fresh read-only preflight confirms the
  current healthy runtime predates the reviewed candidate. Fresh explicit
  authority is required for the local Provider credential, LetheBot-only
  build/recreation/restart, and controlled SnowLuma/QQ sends. No live call,
  send, or deployment is authorized by prior evidence or by this checkpoint.
- The fresh audit backup is
  `/tmp/lethebot-usability-audit-20260713-215812.db`, mode `0600`; it is private
  local evidence and must not be committed or shared.
- Exact next action: after fresh live authorization, deploy the reviewed
  LetheBot candidate while preserving SnowLuma, then fill the fresh hardened
  evidence template through the controlled private/group multi-participant,
  quote, rapid-trigger,
  governance, memory-continuity, and restart sequence in
  `docs/local-container-acceptance.md`; write only redacted aggregate evidence
  under `/tmp`; then run both evidence validators.
- Active execution instructions are in
  `docs/prompts/group-chat-reliability-goal.md`; scoped invariants are in
  `docs/group-chat-reliability-constraints.md`.
