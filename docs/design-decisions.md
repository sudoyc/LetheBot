# Design Decisions

This is the concise decision index for the D1-D8 answer-review discussion. The full reasoning is archived in `archive/discussions/answer-review-discussion-log.md`; implementation-facing guidance is split into the formal design documents linked below.

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
- `next-full-implementation-plan.md`

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
- `next-full-implementation-plan.md`

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
- `next-full-implementation-plan.md`
