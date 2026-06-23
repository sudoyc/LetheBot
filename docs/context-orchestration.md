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
  userProfile?: ContextBlock;
  groupProfile?: ContextBlock;
  recentMessages: ContextBlock;
  retrievedMemories: ContextBlock[];
  systemLayers: ContextBlock[];
  interactionState?: ContextBlock;
  tokenBudget: TokenBudget;
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

## Budgeting

Use separate budgets:

- System and persona: fixed.
- User profile: small, high precision.
- Group profile: medium.
- Recent messages: adaptive.
- Retrieved memory: adaptive.
- Tool results: bounded per tool.

The orchestrator should prefer high-confidence profile facts over low-confidence semantic matches.

## Observability

Each turn should record:

- Candidate memories.
- Selected memories.
- Rejected memories and reason.
- Token estimate.
- Prompt layer versions.
- Agent model and settings.

