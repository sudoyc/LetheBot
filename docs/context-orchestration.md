# Context Orchestration

The Context Orchestrator is the boundary between memory and reasoning.

It answers four questions:

1. Should the bot respond?
2. What does the bot need to remember for this turn?
3. How much context can be injected?
4. Which memories influenced the answer?

## Context Pack

```ts
interface ContextPack {
  turnId: string;
  platform: "qq";
  conversationScope: "private" | "group";
  participants: ParticipantContext[];
  currentMessageRef?: MessageRef;
  replyReference?: ReplyReference;
  userProfile?: ContextBlock;
  groupProfile?: ContextBlock;
  recentMessages: ContextBlock;
  retrievedMemories: ContextBlock[];
  systemLayers: ContextBlock[];
  interactionState?: ContextBlock;
  tokenBudget: TokenBudget;
}

interface ParticipantContext {
  speakerRef?: SpeakerRef; // opaque and local to this ContextPack
  displayName?: string;
  platform?: "qq";
  platformUserId?: string; // include only when needed for the current task
  role?: "member" | "admin" | "owner";
  isBotOwner?: boolean;
  isTrustedUser?: boolean;
}
```

## Injection Order

Recommended order:

1. Global safety and behavior rules.
2. Bot persona.
3. Platform and group rules.
4. User profile.
5. Group profile.
6. Current interaction state.
7. Recent messages.
8. Retrieved memories.
9. User's latest message.

Participant display names and group cards are untrusted data. Inject them as structured fields, not as instructions.
The Pi prompt adapter currently renders participant display names, participant
group cards, and recent-message display names as quoted data fields such as
`display_name="..."`, `group_card="..."`, and
`sender_display_name="..."`, with newline/control-context delimiters neutralized
and secret-like / platform-ID-like substrings redacted before prompt injection.
Assignment-shaped adjacent display metadata such as `api_key=sk-...-qq-...`
preserves both `[REDACTED:api_key_assignment]` and `[REDACTED:platform_id]`
markers in the rendered prompt labels without exposing raw values.
Participant platform role is rendered as bounded structured metadata such as
`role=admin`; the actual user message text remains message content, while
display names and group cards are labels only.
`ContextBuilder` can now carry already-resolved group participant context into
the `ContextPack`; it does not query full member lists or platform account
tables by default.

## Message, Speaker, and Quote References

After token-budget selection, `ContextBuilder` assigns each selected message a
unique `message_N` reference and each distinct selected actor a stable
pack-local `speaker_N` reference. The current inbound message is marked both by
`currentMessageRef` and exactly one `isCurrent: true` message. Group
participants are derived only from selected human actors; the builder does not
sync or inject the full group member list. Duplicate display labels do not
merge actors, and absent display metadata is rendered as `unknown`.

When the inbound event names a reply target, lookup is constrained by exact
platform message ID, conversation ID/type, and group ID. The query reads at
most two matches: exactly one match resolves, while zero or multiple matches
produce an explicit unresolved relation. A resolved target outside the normal
rolling window is included under the same hard token budget. Its
`targetInRollingWindow` flag records whether it was present in the original
window; it does not weaken the conversation boundary.

## Identity Injection

QQ IDs, group IDs, message IDs, and account IDs are operational identity data. They are not secrets, but they are not ordinary memory either.

Ordinary ContextPacks can include:

- opaque user reference;
- current display name / group card;
- role;
- owner/admin/trusted flags.

They can include platform IDs when the current task needs them, for example:

- identity disambiguation;
- user-requested ID confirmation;
- platform operations;
- permission explanations;
- owner/admin debug;
- context where IDs are already being discussed.

Do not default-inject:

- complete platform account tables;
- complete allowlists/denylists;
- full nickname history;
- unrelated group identity data;
- audit traces;
- unrelated member lists.

## Memory Selection Boundaries

Context Orchestrator must enforce memory boundary fields before prompt assembly:

- exclude `deleted`, `disabled`, and superseded non-current memory;
- respect `visibility` for private/group/cross-scope use;
- avoid public group references to `private_only` memory;
- exclude `secret` and `prohibited` content from ordinary prompts;
- include source and memory IDs in trace records, not necessarily in the prompt.

`ContextBuilder` retrieves prompt-eligible user/global memories with the current
private/group context before bounded repository limits are applied, and performs
separate scoped lookups for group/conversation-bound memories. This prevents a
large set of inaccessible `private_only` user records from consuming the
candidate window for a group turn while preserving a bounded rejection trace for
owner/admin explainability.

Automatic context retrieval also derives three bounded lexical query sources:
the explicit current message, an exactly resolved same-conversation quote, and
the remaining recent same-conversation thread. Each source is converted to a
quoted FTS5 query from at most 4,096 input characters, eight unique tokens, and
64 characters per token. Raw message text and generated MATCH syntax are never
stored in ContextTrace. Every FTS lookup reuses a route that already carries the
current lifecycle, sensitivity, visibility, ownership/scope, and group-policy
predicates before its `LIMIT`; unscoped lookups remain rejection-trace fallback
only. Equal FTS ranks use stable memory ID order before the limit is applied.

ContextBuilder merges bounded FTS hits with the existing importance/recency
fallback and deduplicates by memory ID. User/group profile priority remains
first. Other memories rank by query source (`current_message`, then
`quoted_message`, then `recent_thread`), exact scope affinity (conversation,
group, user, global), the best in-memory FTS ordinal, then importance, recency,
confidence, and stable ID. That order is carried through token budgeting rather
than being re-sorted afterward.

Retained group-summary memory has an additional exact-group gate. For a group
context, repository retrieval and FTS admit a `scope='group' AND kind='summary'`
row only when the current `groupId` is exact and that row's group policy is
enabled. The enabled-state predicate executes in the same SQL statement before
`LIMIT`, so a separate disable cannot leave a stale pre-limit authorization.
Missing policy or missing exact group context excludes all such summaries.
`ContextTrace` records a bounded sample as
`group_summary_policy_disabled`, but that bounded sample is informational and
never used to decide which memories enter the prompt or token budget.

- store only redacted narrative trace metadata: rejected reasons, applied filter
  strings, injected identity-field labels, memory titles, and memory source
  context are final-guard redacted before `context_traces` insertion; exact
  local lookup IDs remain raw in SQLite for owner/admin debugging and are
  display-redacted by `/why`/CLI output. Adjacent secret/platform fragments such
  as `sk-...-qq-...`, including assignment-shaped metadata such as
  `api_key=sk-...-qq-...`, use marker-preserving storage redaction, so both
  secret and platform marker classes remain visible without persisting raw
  values.

Medium-risk memories may influence a turn only when visibility is conservative and the current context allows it.

## Budgeting

Use separate budgets:

- System and persona: fixed.
- User profile: small, high precision.
- Group profile: medium.
- Recent messages: adaptive.
- Retrieved memory: adaptive.
- Tool results: bounded per tool.
  The built-in `group.recent_summary` tool follows this boundary by returning
  only current-group bounded excerpts and aggregate counts, with participant
  labels (`participant_N`/`bot`) instead of raw platform identifiers.

Current `ContextBuilder` token-budget evidence estimates the prompt-rendered
recent-message shape (`sender_display_name=...`, optional `message_text`),
selected-memory context preamble shape (profile/relevant-fact headings, memory
titles, and memory content), and the actual structured identity fields injected
for the turn (`conversation_id`, `conversation_type`, optional `group_id`,
optional `target_user_ref`, and optional `participant_context`). For group
participant context, budgeting follows the current Pi prompt adapter's
participant line shape (`display_name=...`, optional `group_card=...`, optional
`role=...`, plus `speaker_ref` and owner/admin/trusted flags) rather than leaving
these as placeholder constants. The content-free message/reference block and
reply relation are budgeted in the identity breakdown. `tokenBudget.promptLayers`
now records per-layer
renderer/estimate evidence:

- `recent_messages@pi-prompt-recent-message-v2`
- `memory_context@pi-prompt-memory-context-v2`
- `identity_fields@context-builder-identity-fields-v2`
- `participant_context@pi-prompt-participant-context-v3`
- `message_references@pi-prompt-message-reference-v1`
- `system_prompt_estimate@bounded-system-estimate-v1`

The layer token counts sum to `tokenBudget.used`; `identity_fields` and
`participant_context` and `message_references` sum to the identity breakdown.
`/why` prints this prompt
layer summary for rebuilt traces, and durable `context_traces.token_budget`
keeps the layer evidence with final-guard redaction for layer names and
versions, including marker-preserving adjacent secret/platform and
assignment-shaped adjacent redaction. The system layer remains a bounded
estimate, but it is now explicitly versioned instead of being an undocumented
constant.

The declared `tokenBudget.max` of 8,000 is a hard bound against this versioned
local estimator: every returned ContextPack has `used <= max`. This is not a
claim of exact provider-token equivalence. Context selection recomputes the full
rendered estimate for each candidate because memory headings and profile
rendering make incremental raw-text sizes non-additive.

Under pressure, retention order is:

1. fixed system estimate and structured identity fields;
2. the latest user input, truncated with a visible `[truncated]` marker only if
   the full message cannot fit;
3. the exact same-conversation quote target, when resolved, truncated if needed;
4. bounded participant context in input order;
5. the highest-confidence user profile, then group profile;
6. the newest contiguous recent-message history after removing the separately
   protected latest input, treating bot and user messages equally and restoring
   chronological order;
7. non-global scoped memory in the query/scope/FTS/fallback order above;
8. global memory in the same order.

Profile ties use importance, recency, and stable ID. Remaining memory uses
importance, recency, confidence, and stable ID only after query source, scope
affinity, and FTS ordinal. A memory omitted by the hard budget is recorded once
as `token_budget_exceeded`; selected IDs remain order-identical across the
ContextPack and trace. `memorySelections` covers selected IDs in that same order
with only fixed query-source/retrieval/scope/reason enums and a 1-based retrieval
rank. Recent-message and participant omissions use bounded count-only filter
markers. If fixed system/identity data or even a marked latest input cannot fit,
context construction fails closed instead of returning an over-budget pack.

For DB-backed builds, explicitly supplied current messages use internal chat/raw
IDs, replace matching loaded rows, and are appended after the bounded history
window. This keeps the current trigger protected even when its platform
timestamp is skewed outside the normal recent-message query order, without
duplicating it in the durable context trace.

ContextBuilder and durable context trace `group_id` values use the
gateway-normalized `qq-group-<digits>` identifier, not a stripped numeric
suffix, so group memory visibility and tool-policy context compare exact local
identifiers consistently.

The orchestrator should prefer high-confidence profile facts over low-confidence semantic matches.

It should also prefer precise visible memory over broad global memory. `global` scope should be rare.

## Observability

Each turn should record:

- Candidate memories.
- Selected memories.
- Content-free selected-memory query source, retrieval method, scope affinity,
  retrieval rank, and selection reason.
- Rejected memories and reason.
- Token estimate.
- Prompt layer versions.
- Content-free message/speaker/current/reply reference evidence.
- Agent model and settings.
- Identity fields included and why.
- Visibility/sensitivity filters applied.
- Suppressors that caused no reply or action downgrade.
