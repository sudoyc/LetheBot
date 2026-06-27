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

Medium-risk memories may influence a turn only when visibility is conservative and the current context allows it.

## Budgeting

Use separate budgets:

- System and persona: fixed.
- User profile: small, high precision.
- Group profile: medium.
- Recent messages: adaptive.
- Retrieved memory: adaptive.
- Tool results: bounded per tool.

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

