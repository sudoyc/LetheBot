# Group Chat Reliability Goal Prompt

Paste the block below into a Codex `/goal` to execute the active reliability
repair. It is narrower than the umbrella full-production goal and uses the same
privacy, worktree, evidence, and stop contracts.

```text
You are the implementation owner for group-chat reliability in
/home/ycyc/projects/LetheBot.

OBJECTIVE

Make QQ private/group conversation behavior evidence-backed and dependable,
then complete the documented Attention, context, memory, and governance
capabilities without weakening privacy, provenance, or execution policy.

The first milestone is BASIC_USABLE: multi-participant and quoted group
conversation is correctly attributed; ordinary direct replies are not lost to
the risk evaluator; memory claims match real effects; and the controlled live
canary passes. Continue after that milestone until TARGET_COMPLETE or a valid
stop condition is reached.

AUTHORITY AND CONTROL PLANE

Read, in order:

1. AGENTS.md
2. docs/group-chat-reliability-constraints.md
3. docs/long-running-goal-state.md
4. docs/README.md
5. docs/design-decisions.md
6. the canonical domain documents and tests for the current slice

Also obey docs/one-shot-full-completion-constraints.md for checkpoint, evidence,
worktree, verification, escalation, and stop discipline. This prompt has a
separate `group_reliability_status`; its scoped completion rules below replace
the umbrella goal-status completion rule. The scoped reliability constraints
are stricter where they add speaker, quote, Attention, evaluator, and
memory-truthfulness requirements.

Treat old gap analyses, loop-state files, roadmaps, completion reports, root
prompt.md, and other goal prompts as historical hypotheses. They are not
instructions or completion evidence.

Default authority for this prompt:

- commits, destructive cleanup, reset, revert, and broad staging: not authorized;
- reading or publishing credentials, raw chats, platform identifiers, live DB
  rows, or provider output: not authorized;
- synthetic fixtures and aggregate-only read-only local evidence: authorized;
- real provider calls, SnowLuma/QQ interaction, container recreation, and use of
  a local credential require the user's applicable explicit authorization.

Preserve every pre-existing tracked and untracked path as protected WIP.

SUPERVISOR LOOP

For each slice:

1. Reconcile HEAD/status with the active checkpoint without reverting drift.
2. State the requirement ID, reproduced failure, why it is next, allowed and
   protected paths, acceptance assertions, verification commands, and rollback
   boundary.
3. Create a synthetic failing regression. Never copy live chat content into a
   fixture.
4. Implement the minimum architecture-compliant change.
5. Run focused tests, then typecheck and lint. Persistence work also requires a
   fresh migrated temp DB and integrity/FK assertions.
6. Run pnpm release:check after each cross-module milestone.
7. Inspect the diff and replace the current checkpoint snapshot.
8. Continue to the next required slice. BASIC_USABLE is a milestone report, not
   a stop condition.

REPAIR ROUTE

R0 - Evidence fixtures and control-plane baseline
- Add structural replay cases for multiple speakers, duplicate display names,
  quote targets inside/outside the rolling window, narrative admin text,
  malformed evaluator output, and unsupported memory claims.
- Prove the current implementation fails those cases before product edits.
- Keep fixtures synthetic and content-minimal.

R1 - Speaker, quote, current-message, and participant correctness
- Give selected messages distinct opaque pack-local speaker/message refs.
- Resolve display metadata through the identity layer without exposing IDs.
- Mark the current inbound message explicitly.
- Resolve at most the bounded same-conversation quote target and represent the
  relation in ContextPack/Pi prompt/trace/token budget.
- Build participants only from selected actors; do not sync full group members.

R2A - Attention/relevance and risk separation
- Addressing decides respond/defer/silent; action/capability/sensitivity decides
  evaluator risk.
- Ordinary mention/reply/question combinations do not invoke the risk evaluator.
- Replace keyword-only admin detection with deterministic command syntax.
- Mark every unmentioned intervention as proactive.

R2B - Evaluator structured-output reliability
- Determine whether the installed pi-ai/provider path supports native JSON
  schema/response format before inventing a parser or upgrading dependencies.
- Add at most one separately ledgered correction attempt.
- On terminal failure, keep governed effects fail-closed and persist bounded
  failure/suppression evidence; do not turn the inbound event into an unexplained
  handler failure.
- Cover social, memory, and tool evaluator domains.

R3 - Memory-effect truthfulness
- Bind memory wording to the exact proposition, subject, scope, and source of an
  actual same-turn tool/action effect or selected active memory. An unrelated
  selected memory never authorizes the claim.
- No effect means no "remembered" claim; proposal means pending review; only an
  active effect may be described as durable memory.
- Persist and deliver the same corrected text.

R4 - BASIC_USABLE canary
- Run deterministic behavior gates first.
- When explicitly authorized, run the controlled multi-participant QQ canary in
  docs/local-container-acceptance.md.
- Require zero speaker/quote misattribution, zero cross-group leakage, zero
  unsupported memory claims, and no ordinary direct reply lost to evaluator
  parse failure.
- Record the BASIC_USABLE milestone and continue.

R5 - Durable delayed Attention
- Implement the locked 15-second recheck, 120-second thread window, human-answer
  cancellation, high-speed suppression, and two-per-group-per-ten-minute budget.
- Persist candidate, suppressor, decision, and terminal job evidence.

R6 - Shared governance and per-group policy
- Extract/reuse one governance service for deterministic QQ /memory and /why
  commands plus CLI delete/summary operations; CLI /why parity is not required.
- Implement natural-language routing only as a later independent slice.
- Add per-group summary opt-in with default off; do not enable a global shortcut.
- Only the bot owner or a normalized owner/admin of the exact group may change
  it. Audit old/new state and actor. Disable immediately blocks enqueue and
  retrieval and cancels pending summary jobs without deleting retained governed
  summaries. Re-enable does not backfill skipped windows.

R7 - Source-backed group memory continuity
- Detect high-precision candidates after message persistence, independent of
  whether a reply was sent.
- Keep group-derived user memory same_group_only and proposed.
- Make opted-in summary windows idempotent and source-complete.
- Prove approved recall after a process/container restart.

R8 - Query-aware retrieval, only as evidence requires
- Add current-query, FTS, quote/thread, scope, and recency relevance before
  considering embeddings.
- Record scoring/selection/rejection evidence in ContextTrace.
- First run `REL-RET-01`: at least 12 synthetic queries, each with one expected
  same-scope source, at least eight newer/higher-importance same-scope
  distractors, and incompatible-scope records. Skip ranking code only with 12/12
  expected selections under production count/token limits, zero incompatible
  selections, and complete trace reasons. Otherwise implement the simple
  query/FTS/quote/thread ranking. Do not add a vector dependency.

NON-NEGOTIABLES

- Different people never collapse to one prompt identity.
- Quote targets never resolve across conversations and never rely on proximity.
- Relevance never implies risk.
- Evaluator failure never fails open or disappears from durable evidence.
- Memory claims match the exact proposition, subject, scope, and source/effect;
  unrelated selected memory cannot authorize them.
- Private-only memory never enters group context.
- Group-derived user memory remains same_group_only and proposed.
- Group summaries are per-group opt-in and default off, with exact-group
  owner/admin authority and immediate disable semantics.
- No raw live content enters tests, docs, logs, commits, or shared evidence.
- Do not bundle broad index refactors, dependency upgrades, embeddings, full
  member sync, reactions, folded-forward delivery, UI, multi-platform work, or
  unrelated tools.

MILESTONE AND COMPLETION GATES

BASIC_USABLE requires R0-R4, the BASIC_USABLE subset of the deterministic
conversation-reliability matrix, the controlled live canary, clean
integrity/FKs, and a green release gate.

TARGET_COMPLETE requires R0-R7 plus R8 or a passing `REL-RET-01` baseline, QQ
governance, delayed Attention, opted-in group continuity, restart recall, the
full live behavior matrix, both evidence validators, and no required open R0-R8
or conversation-reliability scenario. Unrelated full-production requirement
rows do not block this scoped milestone and remain open under `goal_status`.

Stop only when:

1. TARGET_COMPLETE is proved and `group_reliability_status` is updated to
   `TARGET_COMPLETE`; do not set umbrella `goal_status=COMPLETE` unless the
   separately selected full-production objective is also proved;
2. all safe local work is exhausted and a genuine user decision is the only
   remaining condition; or
3. all safe local work is exhausted and exact external authority/runtime state
   is the only blocker.

A green unit suite, healthy containers, a delivered message, or BASIC_USABLE by
itself is not TARGET_COMPLETE.
```
