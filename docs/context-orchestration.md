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
  userProfile?: ContextBlock;
  groupProfile?: ContextBlock;
  recentMessages: ContextBlock;
  retrievedMemories: ContextBlock[];
  systemLayers: ContextBlock[];
  interactionState?: ContextBlock;
  tokenBudget: TokenBudget;
}

interface ParticipantContext {
  ref: string; // opaque internal reference, not a raw platform ID
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

Current `ContextBuilder` token-budget evidence estimates the prompt-rendered
recent-message shape (`sender_display_name=...`, optional `message_text`),
selected-memory context preamble shape (profile/relevant-fact headings, memory
titles, and memory content), and the actual structured identity fields injected
for the turn (`conversation_id`, `conversation_type`, optional `group_id`,
optional `target_user_ref`, and optional `participant_context`). For group
participant context, budgeting follows the current Pi prompt adapter's
participant line shape (`display_name=...`, optional `group_card=...`, optional
`role=...`, plus owner/admin/trusted flags) rather than leaving these as
placeholder constants. `tokenBudget.promptLayers` now records per-layer
renderer/estimate evidence:

- `recent_messages@pi-prompt-recent-message-v2`
- `memory_context@pi-prompt-memory-context-v2`
- `identity_fields@context-builder-identity-fields-v2`
- `participant_context@pi-prompt-participant-context-v2`
- `system_prompt_estimate@bounded-system-estimate-v1`

The layer token counts sum to `tokenBudget.used`; `identity_fields` and
`participant_context` sum to the identity breakdown. `/why` prints this prompt
layer summary for rebuilt traces, and durable `context_traces.token_budget`
keeps the layer evidence with final-guard redaction for layer names and
versions, including marker-preserving adjacent secret/platform and
assignment-shaped adjacent redaction. The system layer remains a bounded
estimate, but it is now explicitly versioned instead of being an undocumented
constant.

The orchestrator should prefer high-confidence profile facts over low-confidence semantic matches.

It should also prefer precise visible memory over broad global memory. `global` scope should be rare.

## Observability

Each turn should record:

- Candidate memories.
- Selected memories.
- Rejected memories and reason.
- Token estimate.
- Prompt layer versions.
- Agent model and settings.
- Identity fields included and why.
- Visibility/sensitivity filters applied.
- Suppressors that caused no reply or action downgrade.
