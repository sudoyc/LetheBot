# MVP Roadmap

The MVP should prove one thing: LetheBot can join QQ, remember useful facts, inject them into Pi, and let the user inspect or delete them.

## Phase 0: Repository and Design

- Document architecture.
- Define project rules.
- Choose initial stack.
- Create GitHub repository.
- Treat architecture components as logical modules, not mandatory separate services.
- Define fast path / risk path / background path before implementing full governance.

## Phase 1: QQ Gateway

- Connect to NapCat / OneBot.
- Receive private and group messages.
- Send text replies.
- Normalize messages into internal events.
- Persist raw events.
- Report gateway capabilities for emoji-like reactions, face-message fallback, and folded/merged forward support.

## Phase 2: Pi Runtime

- Embed Pi SDK in a TypeScript service.
- Run one agent turn from a private message.
- Stream and persist agent events.
- Register a minimal tool set through the tool registry.
- Add evaluator/policy-gate plumbing for tool, memory, and social action decisions.

## Phase 3: Memory v0

- Store user profile records.
- Store group profile records.
- Add manual memory create/search/delete.
- Add source metadata, visibility, sensitivity, source context, and lifecycle states.
- Add memory revisions for rollback/supersede.
- Keep identity/display metadata separate from ordinary memory.

## Phase 4: Context Builder v0

- Inject user profile.
- Inject group profile.
- Inject recent messages.
- Inject rolling group summary.
- Inject current participant display/identity context minimally.
- Enforce memory visibility/sensitivity filters.
- Record selected memory IDs and included identity fields per turn.

## Phase 5: Background Summaries

- Summarize group windows.
- Extract memory proposals.
- Promote low-risk or carefully bounded medium-risk records through evaluator/policy; high-risk records become proposal/admin digest.
- Preserve source links from worker-derived summaries back to original events.

## Phase 6: Governance

- CLI or simple web page for memory inspection.
- Delete and disable memory.
- Show why a response used a memory.
- Inspect evaluator decisions and redacted audit summaries.
- Manage display profile/nickname history deletion or redaction.
- Manage proactive DM and memory-association opt-outs.

## Phase 7: Social Action v0

- Replace boolean reply decisions with `ActionDecision` / `ActionPlan`.
- Implement group trigger scores and suppressors.
- Implement per-group, per-user, per-action-type, and proactive-DM cooldown budgets.
- Implement `dm_user` as a special action over the existing ResponseRouter, not a separate DM subsystem.
- Add capability-gated reaction and folded-forward execution paths with safe fallbacks.

## MVP Exit Criteria

- One QQ group and private chat can run for several days.
- User-specific memory affects answers.
- Group memory affects answers.
- Memory can be inspected, disabled, deleted, and superseded.
- Context injection decisions are logged.
- Evaluator decisions for high-risk tool/memory/social actions are auditable.
- Ordinary prompt context excludes deleted/disabled memory and respects visibility/sensitivity.
- Identity/display data is separated from ordinary memory and can be minimally injected when needed.

