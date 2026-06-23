# Pi Integration

Pi should be the reasoning core, not the memory database and not the platform adapter.

## Recommended Path

Use the Pi SDK from TypeScript as the primary integration. The relevant Pi capabilities are:

- Agent session lifecycle.
- Event streaming.
- Custom tools.
- Context transformation.
- Tool call hooks.
- Session and compaction primitives.

## Integration Modes

| Mode | Description | Use When |
|---|---|---|
| SDK embedded | LetheBot creates Pi agent sessions directly in Node.js. | Default path. Best control and cleanest architecture. |
| RPC subprocess | LetheBot spawns `pi --mode rpc` and communicates with JSONL. | Useful for process isolation or non-TypeScript runtimes. |
| Pi extension | LetheBot memory/tools are packaged as Pi extensions. | Useful for enhancing Pi itself, not for the main bot runtime. |

## SDK Boundary

LetheBot should wrap Pi behind a local interface:

```ts
interface ReasoningCore {
  runTurn(input: AgentInput): Promise<AgentTurnResult>;
  streamTurn(input: AgentInput): AsyncIterable<AgentEvent>;
  abort(runId: string): Promise<void>;
}
```

The implementation can use Pi SDK internally, but the rest of LetheBot should not depend on Pi-specific objects everywhere.

## Context Injection

The Context Orchestrator prepares a structured context pack before each Pi turn:

- System policy.
- Bot persona.
- Platform rules.
- Current user profile.
- Current group profile.
- Recent messages.
- Retrieved memories.
- Active interaction state.
- Tool availability.

Pi should receive the final context as model-readable messages or custom agent messages converted before the LLM call.

## Tool Registration

Initial tools:

- `memory.search`
- `memory.propose`
- `memory.disable`
- `group.recent_summary`
- `qq.send_message`
- `qq.react`
- `sandbox.run`

Tool calls must be audited and linked to agent turn IDs.

