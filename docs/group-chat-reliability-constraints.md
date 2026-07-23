# Group Chat Reliability Repair Constraints

**Status:** scoped normative supplement for the active reliability repair.
**Authority:** this file supplements `AGENTS.md`, `docs/design-decisions.md`,
`docs/long-term-development-constraints.md`, and
`docs/one-shot-full-completion-constraints.md`. It does not replace them and is
not a mutable project-status document.

## 1. Objective And Milestones

The repair has two evidence milestones:

- `BASIC_USABLE`: direct group conversation is dependable. Multi-participant
  history keeps speaker attribution, quote targets are explicit, ordinary
  direct messages do not fail in the risk evaluator, unsupported memory claims
  are not delivered, and the controlled live canary passes.
- `TARGET_COMPLETE`: the documented delayed Attention, QQ governance,
  per-group summary opt-in, source-backed group memory, query-aware retrieval,
  restart recall, and live behavior matrix also pass.

These are product milestones, not replacements for the checkpoint statuses
`ACTIVE`, `NEEDS_DECISION`, `BLOCKED_EXTERNAL`, and `COMPLETE`.
The checkpoint separately tracks `group_reliability_status` as `ACTIVE`,
`BASIC_USABLE`, or `TARGET_COMPLETE`. Reaching the scoped target does not set
the umbrella project `goal_status` to `COMPLETE`.

## 2. Evidence And Data Boundaries

1. Reproduce observed failures with synthetic structural fixtures. Do not copy
   live chat text, display names, platform IDs, database rows, provider output,
   credentials, or hashes that can be correlated outside the local audit.
2. Live SQLite inspection is read-only and uses an online backup at a neutral
   `/tmp` path with mode `0600`. Shared evidence is aggregate-only.
3. A passing unit test proves its contract, not live QQ usability. A delivered
   message proves transport, not semantic relevance or correct attribution.
4. Every behavior claim names the scenario, expected outcome, durable evidence,
   and verification command. Test counts and historical completion claims are
   not stable evidence.
5. Existing tracked and untracked work is protected WIP. Do not clean, revert,
   broadly stage, commit, or overwrite unrelated paths.

## 3. Context And Identity Invariants

1. Every selected human speaker has a distinct opaque `speakerRef` within a
   ContextPack. The same human has the same ref throughout that pack; different
   humans remain distinct even when their display names match.
2. Prompt-visible speaker refs and message refs must not contain or reversibly
   encode QQ IDs, canonical user IDs, group IDs, message IDs, or credential
   material. Assigning `participant_N` / `message_N` by deterministic pack order
   is acceptable.
3. Display names and group cards are untrusted labels. They may enrich a known
   speaker ref, but they never define identity and never become instructions.
4. Participant context is built only from actors present in the selected
   context or explicitly needed by the current quote/thread. Do not fetch or
   inject a full group member list.
5. The current inbound message is marked explicitly. Pi must not infer the
   current target merely because a message happens to be last in a flat list.
6. A reply target is resolved only within the exact current conversation. An
   older same-conversation target may be loaded outside the rolling window with
   a bounded, budgeted targeted lookup. A cross-conversation match is rejected.
7. When a target cannot be resolved, context says that it is unavailable. It
   does not guess a target from nearby text.
8. New context fields are included in token budgeting and durable trace
   evidence. Trace/display boundaries continue to redact identifiers.

## 4. Attention And Evaluator Invariants

1. Addressing/relevance and execution risk are orthogonal. `@bot`, a reply to
   the bot, a question, or several relevance signals together do not by
   themselves make an action risky.
2. Attention remains a deterministic fast classifier. It may output
   `respond`, `defer`, or `silent`; it is not replaced by an LLM relevance
   judge.
3. Risk review is derived from the proposed action, capabilities, scope change,
   sensitivity, and explicit policy signals. Ordinary low-risk replies use the
   reply fast path.
4. An unmentioned message is proactive if the system chooses to intervene.
   Evaluator input must never hardcode it as non-proactive.
5. Admin behavior uses deterministic command syntax and normalized authority.
   Narrative text that merely contains words such as "management" or
   "settings" is not an instruction.
6. Strong `@bot`, reply-to-bot, and command candidates bypass the local base
   cooldown as locked in D9. This does not waive L0 policy or force delivery.
7. An unmentioned question uses the locked delayed policy: wait 15 seconds,
   expire outside a 120-second thread, allow at most two interventions per group
   per ten minutes, and suppress after a human answer or above five messages per
   ten seconds.
8. Provider-native JSON/schema output should be used when the installed client
   supports it. Otherwise, one bounded correction attempt is the maximum. Each
   attempt has separate durable invocation evidence.
9. A terminal evaluator failure never fails open. For genuinely governed
   actions it produces durable, redacted suppression/failure evidence without
   pretending the inbound event was never processed.
10. Do not weaken the schema, accept arbitrary commentary around JSON, or hide
    retries to improve pass rates.

## 5. Memory And Governance Invariants

1. Outbound claims about memory are effect-bound:
   - no effect: do not claim that anything was remembered;
   - proposal created: say only that it is pending review;
   - active memory selected or activated: describe only the state actually
     supported by durable evidence.
   The evidence must support the same proposition, subject, scope, and source
   or same-turn effect being acknowledged. An unrelated selected memory never
   authorizes a claim about the current message.
2. Prompt instructions alone are not a truthfulness control. Unsupported
   high-confidence memory claims must be blocked or rewritten before delivery,
   and the persisted bot response must match the delivered text.
3. Private auto-active memory keeps the locked evaluator confidence threshold
   of `0.85`. Private-only memory is never exposed in group prompts.
4. Group-derived user memory remains `same_group_only` and `proposed`. A single
   ordinary group statement or third-party judgment never becomes active user
   memory.
5. Group summaries are per-group opt-in and default off. Only the bot owner or
   a normalized owner/admin of the exact group may enable or disable them. Every
   change is audited with actor, group scope, timestamp, and old/new state. Do
   not enable the existing global summary switch as a substitute for this gate.
   Disable takes effect immediately for enqueue and retrieval, cancels pending
   summary jobs, and does not itself delete retained governed summaries.
   Re-enable does not backfill skipped windows; deletion remains a separate
   governance action.
6. Deterministic QQ `/memory` and `/why` commands and CLI delete/summary
   operations must reuse the same governance service. CLI `/why` parity is not
   required; natural-language routing is a later, separate slice.
7. Silent-message candidate detection must stay high precision, source-linked,
   idempotent, privacy-aware, and independent of whether the bot replied.

## 6. Sequencing And Rollback

1. Execute the route recorded in `docs/long-running-goal-state.md` in order.
   Correct speaker/quote context before tuning model style or adding retrieval.
2. Keep Attention-risk separation and evaluator transport/schema reliability in
   separate deployable slices.
3. Prefer existing identity/display tables and ContextTrace JSON before adding a
   schema migration. A migration requires a fresh-database test, upgrade test,
   integrity/FK checks, snapshot restore, and cross-version rollback rehearsal.
4. A new durable job type requires idempotency, lease/retry tests, worker
   compatibility, and an explicit rollback/drain procedure before deployment.
5. Stop enqueuing a new job type before rolling back to a worker that does not
   recognize it.
6. Do not mix dependency upgrades, broad `src/index.ts` refactors, embeddings,
   full member synchronization, reactions, folded-forward messages, a web UI,
   multi-platform work, or unrelated tools into this repair.

## 7. Verification Contract

For every behavior slice:

1. Add a failing regression derived from a named acceptance scenario.
2. Run the narrow affected unit/integration tests.
3. Run `pnpm typecheck` and `pnpm lint` for TypeScript changes.
4. Assert durable rows, lifecycle/rollback behavior, and an empty
   `PRAGMA foreign_key_check` for persistence changes.
5. Run `pnpm release:check` after a cross-module milestone and before a
   completion claim.
6. Run the controlled live canary only with explicit runtime/session/provider
   authorization. Keep its evidence aggregate-only and validate the standard
   acceptance evidence file.
7. Before R8 is skipped, run `REL-RET-01` with at least 12 synthetic cases. Each
   case has one expected same-scope source, at least eight deliberately stronger
   same-scope distractors, and incompatible-scope records. The baseline is
   sufficient only with 12/12 expected selections under production limits, zero
   incompatible selections, and complete selection/rejection trace reasons.

`BASIC_USABLE` and `TARGET_COMPLETE` require the behavior matrix in
`docs/test-strategy.md` and the live canary in
`docs/local-container-acceptance.md`; neither can be inferred from transport
health alone.

## 8. Documentation Control

1. `docs/long-running-goal-state.md` is the only mutable status/checkpoint.
2. This file contains scoped invariants only. It must not accumulate progress
   logs, test counts, runtime IDs, or current-state narratives.
3. Stable product decisions live in `docs/design-decisions.md`; domain contracts
   are updated in their owning canonical documents when implementation lands.
4. `docs/prompts/group-chat-reliability-goal.md` is the scoped execution prompt.
   Older prompts are historical/reference material unless the user explicitly
   selects a different objective.
5. Update status by replacing the checkpoint snapshot, not by appending a
   chronological command transcript.
