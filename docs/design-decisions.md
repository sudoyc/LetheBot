# Design Decisions

This is the concise decision index for confirmed LetheBot product and
architecture decisions. The original D1-D8 reasoning is archived in
`archive/discussions/answer-review-discussion-log.md`; implementation-facing
guidance is split into the formal design documents linked below.

## D1. Evaluator Boundary

Decision:

- The agent review layer is a LetheBot Orchestrator evaluator, not unchecked Pi self-review.
- The evaluator may use the same model API as Pi in MVP, but it has a separate invocation stage, prompt, input trimming, structured output, and execution authority.
- High-risk actions are proposed by Pi/evaluator and executed only through policy gate/action executor.

Primary docs:

- `agent-governance.md`
- `architecture.md`
- `pi-integration.md`

## D2. Hard Policy and Evaluator Toggles

Decision:

- L0 hard policy stays outside LLM discretion.
- `evaluatorPolicy: required | bypass` controls LLM evaluator review only.
- It does not enable/disable capabilities.
- Bypass never bypasses L0 policy, permissions, sandboxing, audit, or action executor.
- Policy groups are `tools`, `memory`, and `social`.

Primary docs:

- `agent-governance.md`
- `tool-registry.md`
- `security-privacy.md`

## D3. Memory Boundary Fields

Decision:

- Memory records separate `scope`, `visibility`, `sensitivity`, `authority`, and `source_context`.
- P0 visibility values are `private_only`, `same_user_any_context`, `same_group_only`, `owner_admin_only`, `public`.
- P0 sensitivity values are `normal`, `personal`, `sensitive`, `secret`, `prohibited`.
- `secret` is distinct from `prohibited` and should not become ordinary durable memory content.

Primary docs:

- `memory-system.md`
- `context-orchestration.md`
- `data-model.md`
- `security-privacy.md`

## D4. Auto-Active Memory

Decision:

- LetheBot can auto-active memory through an agent-mediated flow.
- Low-risk memory may auto-active.
- Medium-risk memory may auto-active with conservative visibility.
- High-risk memory becomes proposal/admin digest.
- Secret/prohibited content is rejected or redacted.
- Group-chat-derived user memory requires explicit intent or repeated evidence.
- Auto-active memory requires source links, revisions, rollback/supersede, and explanation.

Primary docs:

- `memory-system.md`
- `agent-governance.md`

## D5. Social Action Model

Decision:

- Group participation outputs structured actions, not a boolean reply decision.
- There is no mandatory group reply trigger.
- Trigger scores and suppressors decide whether to reply, downgrade, DM, digest, or stay silent.
- `dm_user` is not a separate subsystem, but it is a special action in action/policy/audit.
- Cooldown is budget + suppressor, not event dropping.
- Reaction and folded-forward delivery are capability-gated by the gateway.

Primary docs:

- `social-action-model.md`
- `architecture.md`
- `pi-integration.md`

## D6. Tool Registry Metadata

Decision:

- Tool registry metadata has six categories: `capabilities`, `permissions`, `evaluatorPolicy`, `auditLevel`, `sandboxPolicy`, and `outputSensitivity`.
- P0 capabilities include read/write/context/network/shell/message/memory/credential/platform-admin risk categories.
- Permissions combine actor class, invocation context, and allowlist/denylist.
- Audit defaults to at least `summary`; `full` is owner/debug only and still secret-scanned.
- Sandbox policy is object-shaped over filesystem, network, execution backend, and limits.

Primary docs:

- `tool-registry.md`
- `security-privacy.md`
- `pi-integration.md`
- `architecture.md`

## D7. Identity, Nickname, and Account Mapping

Decision:

- Identity registry, display profile, and user memory are separate layers.
- Raw QQ IDs/account IDs are operational identity data, not ordinary memory and not API secrets.
- `canonical_user_id` owns user memory; raw platform IDs stay in identity mapping/gateway/policy data.
- Current nickname/group card is conversation participant context.
- Nickname history is bounded display metadata and does not enter ordinary prompts by default.
- Platform IDs can enter prompts when needed for identity disambiguation, platform operations, user-requested ID handling, permissions, or debug; injection must be minimal, structured, and purpose-bound.
- Users should be able to request memory/display deletion, proactive DM opt-out, memory-association opt-out, and account unlink. P0 UI can start with owner/admin CLI.

Primary docs:

- `identity-model.md`
- `context-orchestration.md`
- `data-model.md`
- `security-privacy.md`

## D8. Documentation Landing

Decision:

- Keep `archive/discussions/answer-review-discussion-log.md` as the historical discussion/audit trail.
- Split confirmed decisions into formal design docs.
- Maintain this file as the compact decision index for future sessions.

Primary docs:

- `design-decisions.md`
- `README.md`
- all linked formal design docs above

## D9. Group Addressing And Delayed Attention

Decision:

- Addressing/relevance and execution risk are separate dimensions. `@bot`, a
  reply to the bot, a question, or a combination of those signals does not by
  itself make an action risky.
- Strong `@bot` and reply-to-bot candidates bypass the local base cooldown, but
  still pass L0 policy and do not force delivery. Recognized QQ governance
  families are intercepted before Attention and never enter cooldown handling.
- An unmentioned group question waits 15 seconds, expires outside a 120-second
  thread, is limited to two interventions per group per ten minutes, and is
  suppressed above five messages per ten seconds or after a human answer.
- An unmentioned intervention is proactive and must be represented that way in
  policy/evaluator evidence.
- Admin instructions require the exact deterministic QQ governance grammar plus
  persisted authority. Recognized unauthorized commands receive a fixed denial;
  narrative text and command-prefix collisions remain ordinary input.

Primary docs:

- `social-action-model.md`
- `agent-governance.md`
- `group-chat-reliability-constraints.md`

## D10. Group Context Identity And Reference Semantics

Decision:

- Every selected speaker and message has an opaque prompt-local reference.
  Different people remain distinct even when display names match; raw platform
  and canonical IDs are not encoded in prompt-visible refs.
- Display names and group cards enrich a known ref as untrusted data but never
  define identity.
- The current inbound message and its reply/quote target are explicit ContextPack
  relations. A quote target may be loaded outside the rolling history window
  only from the exact current conversation and within a bounded token budget.
- Participant context is derived from selected actors and required reference
  targets, not from an injected full group-member list.

Primary docs:

- `contracts.md`
- `identity-model.md`
- `context-orchestration.md`
- `group-chat-reliability-constraints.md`

## D11. Memory Usability And User Governance

Decision:

- Private auto-active memory requires evaluator confidence of at least `0.85`.
- Group-derived user memory is always `same_group_only` and `proposed`; it never
  becomes active from one ordinary group statement or a third-party judgment.
- Group summaries require per-group opt-in and default off. A global enable
  switch does not substitute for that policy decision.
- Only the bot owner or a normalized owner/admin of the exact group may change
  summary opt-in. Disable immediately stops new summary jobs and summary
  retrieval and atomically cancels bound pending jobs. It is not deletion:
  retained summaries remain governed and separately deletable. Re-enable starts
  a new generation and does not backfill skipped windows; missing policy means
  disabled and repeated state changes are idempotent.
- Each enable epoch is exclusive and advances beyond the prior policy clock,
  every persisted exact-group chat ingress, and normalized exact-group raw
  ingress still awaiting chat normalization. Disable advances beyond bound
  pending-job clocks when representable and saturates at the safe-integer ceiling,
  so wall-clock rollback or hostile future timestamps cannot prevent opt-out.
- QQ governance implements exactly `/memory`, `/memory forget <memory-id>`,
  `/memory summary status|enable|disable`, and `/why`. The parser is
  case-sensitive and 512-character bounded; prefix collisions remain ordinary
  input. Group command scope is canonical only when both group and conversation
  use the same `qq-group-[1-9][0-9]{4,11}` value. CLI `memory-summary --group`
  accepts the same form. Natural-language routing is not part of the implemented
  contract.
- The configured `LETHEBOT_BOT_OWNER_QQ_ID` or an exact persisted group
  owner/admin role grants QQ authority. The shared service reparses and
  revalidates canonical raw/chat/account evidence before executing. A group
  listing never exposes private/global/other-group memory, even to the bot
  owner; only private bot-owner listing is broad. Group owner/admin forget is
  exact-group safe, while bot-owner known-ID and `local_admin` CLI forget are
  broad.
- `/why` selects the latest prior turn by canonical ingress order in the exact
  conversation. Recognized commands create a zero-token local turn and execute
  one deterministic reply through the action executor without Pi, evaluator, or
  tools. Ingress deduplication prevents duplicate effects. A handled send
  failure preserves failed execution and completes the local turn without a bot
  response; thrown governance/persistence failures use failed turn/admission
  evidence.
- CLI delete and exact-group summary commands use the same service as QQ with
  actor `local_admin` and `admin_cli` invocation context.
- A QQ governance mutation and its reply action decision commit atomically
  before delivery. Decision-persistence failure rolls the mutation and audit
  back while the local turn/admission records the failure.
- Policy audit display fields redact platform/secret-shaped group and source
  identifiers while a purpose-bound SHA-256 `groupIdHash` preserves exact-group
  correlation. Delete display/audit bodies use a bounded memory-ID projection;
  the L0 mutation decision uses a purpose-bound SHA-256 digest instead of the
  raw memory ID.
- `forget` excludes memory immediately and remains restorable for 90 days.
- Default retention is 90 days for raw/chat/failure evidence, 365 days for audit,
  and 90 days for rejected/disabled/deleted memory, subject to the existing
  privacy and tombstone contracts.

Primary docs:

- `memory-system.md`
- `agent-governance.md`
- `security-privacy.md`
- `group-chat-reliability-constraints.md`

## D12. Evaluator Failure And Memory-Claim Truthfulness

Decision:

- A terminal evaluator failure stays fail-closed for governed effects and is
  durably observable. It must not silently fail open or make the inbound event
  appear unprocessed.
- Ordinary low-risk replies do not depend on the risk evaluator merely because
  they are strongly addressed.
- Provider-native structured output is preferred; only strict JSON/schema
  failure may receive one separately ledgered correction call, and it is never
  hidden by permissive parsing or invalid-response replay.
- A bot response may claim durable memory only when the claim matches the exact
  proposition, subject, scope, and source/effect of an actual governed effect or
  selected active memory. Unrelated selected memory never authorizes the claim.
  A created proposal is described as pending review, not as remembered active
  memory.

Primary docs:

- `agent-governance.md`
- `pi-integration.md`
- `memory-system.md`
- `group-chat-reliability-constraints.md`

## Current Formal Design Docs

- `architecture.md`
- `agent-governance.md`
- `memory-system.md`
- `identity-model.md`
- `context-orchestration.md`
- `social-action-model.md`
- `tool-registry.md`
- `pi-integration.md`
- `data-model.md`
- `security-privacy.md`
