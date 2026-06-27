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

Pi is not the memory database, the gateway adapter, the policy engine, or the unchecked executor. It reasons over a prepared ContextPack, proposes tool calls/actions, and streams turn events through LetheBot-owned orchestration boundaries.

## Evaluator Integration

LetheBot uses a separate evaluator boundary for risky social, memory, and tool decisions. The evaluator may use the same underlying model API as Pi in the MVP, but it is invoked separately with different prompts, trimmed inputs, structured output, and no direct execution authority.

Recommended flow:

```text
ContextPack / candidate action
  -> Pi or worker proposes response/tool/memory/social action
  -> Orchestrator invokes evaluator when policy requires it
  -> Policy gate checks hard rules and permissions
  -> Action executor performs the approved action
  -> Audit/revision records link back to turn IDs
```

Evaluator policy is `required | bypass`. It controls whether LLM/agent review is required; it does not enable or disable the underlying capability. Even when evaluator review is bypassed, L0 hard policy, permissions, sandboxing, and audit still apply.

See `agent-governance.md` for the full governance model.

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

Tool registration goes through `tool-registry.md`. Tool metadata declares capabilities, permissions, evaluator policy, audit level, sandbox policy, and output sensitivity.

Tool calls must be audited and linked to agent turn IDs. High-risk tool calls execute through the Tool Orchestrator and policy gate; Pi does not call local shell, credentials, platform admin actions, or durable memory writes directly.

## Social Actions

Pi may propose social actions, but the Attention/Evaluator/Action Executor stack owns final action selection and delivery.

Group chat should use structured actions such as `silent_store`, `reply_short`, `reply_full`, `reply_with_tool`, `dm_user`, `admin_digest`, `react_only`, or `send_folded_forward`, rather than a boolean reply decision.

See `social-action-model.md` for action schemas, triggers, suppressors, cooldown, proactive DM, and gateway capability handling.

