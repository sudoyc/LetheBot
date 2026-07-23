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

The production `PiAdapter.runTurn()` path has a finite cooperative deadline.
`PI_TURN_TIMEOUT_MS` defaults to `120000` and accepts integer milliseconds from
`1` through the host timer maximum `2147483647`. At the deadline, the adapter
calls Pi `abort()` once and continues awaiting prompt/idle settlement before it
returns a stable failed result (`Pi turn timed out after <N> ms`). The underlying
provider rejection is not returned or logged on that timeout path, and the
deadline timer is cleared on success and failure so the adapter can be reused.

`PiAdapter` owns one stateful Pi SDK `Agent`, so `runTurn()` and `streamTurn()`
enter the same FIFO turn lease before changing any adapter or Agent state. Under
that lease the adapter resets the SDK transcript and queues, installs the current
turn/actor/tool context, and supplies only the history selected in the current
`ContextPack`. It releases the lease only after prompt and idle settlement plus
output capture or stream cleanup. A queued `runTurn()` starts its deadline after
lease acquisition, preventing an earlier turn's timer from aborting later work.
Early stream-consumer cancellation aborts an active SDK run and awaits both the
prompt and idle settlement before another turn may start.

This is cooperative cancellation, not forced termination: a provider or
in-process tool that ignores Pi's abort signal can still delay settlement and
requires a different execution/isolation policy. The configured deadline
currently governs the production `runTurn()` path. The unused `streamTurn()`
surface has no automatic deadline and retains explicit/manual abort semantics;
closing its async generator still performs the abort-and-settle cleanup above.

## Evaluator Integration

LetheBot uses a separate evaluator boundary for risky social, memory, and tool decisions. The evaluator may use the same underlying model API as Pi in the MVP, but it is invoked separately with different prompts, trimmed inputs, structured output, and no direct execution authority.

The current non-test runtime implements that boundary for social decisions and
evaluator-required Pi tools with a stateless structured model client. Each call
uses one isolated message, no tools, no retained session history, a finite
deadline, and a strict domain-specific JSON schema. LetheBot assigns decision
identity, request binding, timestamp, and evaluator version locally. Prompt data
omits durable turn/source/owner and social delivery-target identifiers and is
redacted/bounded before the provider call. Invalid or oversized output, timeout,
provider failure, and model-supplied metadata fail closed without falling back to
the rule-driven stub.

Provider/model/base/key inherit the complete Pi identity only when evaluator
provider/model overrides are both absent. A separate evaluator identity requires
both fields and its own key. `LETHEBOT_TEST=true` or an explicit evaluator
identity of `mock` / `mock` selects the stub and makes no evaluator provider
call.

Background memory extraction uses the configured evaluator through a durable
job-attempt owner. The request carries the canonical raw event while the memory
effect retains the canonical chat-message source. After the Provider await, the
evaluator row and memory/source/create-revision/audit effect commit together;
effect failure rolls all of them back. A committed effect survives a later job
completion failure and is reused by the next attempt without another evaluator
call. Directly constructed extraction workers without an evaluator use local L0
policy evidence instead of manufacturing evaluator IDs.

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
Display names and group cards are untrusted UI metadata when converted for Pi.
They must be rendered as quoted structured data fields, not natural-language
instructions, and must be redacted/neutralized if they contain secret-like,
platform-ID-like, newline, or context-delimiter text. The current Pi prompt
adapter renders explicit group participants as `display_name="..."`, optional
`group_card="..."`, optional bounded `role=...`, and owner/admin/trusted flags;
each selected participant also carries its validated pack-local `speaker_ref`.
It does not render raw platform account IDs in ordinary participant context.
Assignment-shaped adjacent display metadata such as `api_key=sk-...-qq-...`
keeps both assignment-secret and platform redaction markers in rendered prompt
labels while omitting raw fragments.
Pi receives a content-free `## Message References` block that maps every
selected `message_N` to a `speaker_N`, human/bot role, and current marker. A
resolved reply adds source/target refs, target role, and whether the target was
already in the rolling window; an unresolved lookup is rendered explicitly
without target fields. The block contains neither message text nor durable
platform/canonical IDs. Prompt-visible `target_user_ref` is replaced with the
current message's validated `speaker_N`; the internal canonical target remains
available to policy/context orchestration but is not rendered.
`ContextBuilder` token accounting records the corresponding prompt renderer
versions in `tokenBudget.promptLayers` (`pi-prompt-recent-message-v2`,
`pi-prompt-memory-context-v2`, `pi-prompt-participant-context-v3`, and
`pi-prompt-message-reference-v1`) so `/why`
can show which prompt-layer estimates were used for a rebuilt or stored turn.

## Tool Registration

Current production-registered tools:

- `memory.search`
- `memory.propose`
- `memory.disable`
- `group.recent_summary`

QQ send/reaction actions are owned by the governed action/gateway path, not Pi
tool registration. A future `sandbox.run` tool requires a supported execution
backend; declaring `subprocess` or `docker` metadata alone does not register or
expose such a backend in the current runtime.

Tool registration goes through `tool-registry.md`. Tool metadata declares capabilities, permissions, evaluator policy, audit level, sandbox policy, and output sensitivity.

Registry names are canonical LetheBot identities and may contain dots. For each
serialized turn, PiAdapter exposes only currently permitted tools and maps any
name outside `[A-Za-z0-9_-]{1,64}` to a deterministic Provider-safe alias. The
alias remains in the assistant tool call, Pi events, and tool-result transcript
so Provider replay stays valid. Hooks resolve it without mutating the Pi call;
policy, evaluator requests, handlers, `tool_calls`, and audit rows use only the
canonical name. Alias collisions, unknown names, stale turns, and unavailable
registry entries fail closed, and a new turn replaces the complete map and tool
directory before prompting.

Tool calls must be audited and linked to agent turn IDs. High-risk tool calls execute through the Tool Orchestrator and policy gate; Pi does not call local shell, credentials, platform admin actions, or durable memory writes directly.

The current built-in `memory.search` tool is the initial read-only product-like
tool. It is registered at app startup through `ToolRegistry`, uses
`MemoryRepository.retrieve/search` rather than direct SQLite access, requires a
canonical actor identity, and returns only memories visible to that actor in the
current private or group context plus public global memory. In group context it
can include the current user's same-group memory, current group memory, and
public global memory while excluding other users' group-derived memory. The tool
returns content plus coarse metadata (`kind`, `scope`, confidence, importance,
and a coarse source-context category) but does not expose durable memory IDs or
source event IDs to Pi. Its output is still treated as `secret_possible` and is
scanned/redacted before prompt-facing tool results, `tool_calls`, and
`audit_log` evidence.

The current built-in `memory.propose` tool is a conservative write proposal
surface. Its metadata declares `modifies_memory` and `evaluatorPolicy=required`,
so PiAdapter performs source-bound durable evaluator review after L0 permission.
After approval, PiAdapter supplies the current trigger raw-event IDs and durable
evaluator decision ID as trusted handler context rather than tool input. The
handler verifies that the decision approves the same tool, turn, actor,
invocation context, and source set, then returns a prepared local effect without
writing memory. PiAdapter formats and redacts the public result first, then a
same-handle SQLite coordinator revalidates the approval and atomically writes the
`state=proposed` memory, timestamped internal raw-event source with
`extracted_by=tool`, create revision, memory audit, success tool call, and
`tool.executed` audit with the same evaluator ID. Late success-terminal failure
rolls all of those writes back before an atomic error terminal pair is attempted.
The public result never activates memory or returns memory/source/evaluator IDs;
the outer adapter still returns its audited tool-call ID. Same-group and
owner/admin global-scope policy checks remain in force. Missing or mismatched
source/evaluator context fails closed.

The current built-in `memory.disable` tool is likewise a conservative lifecycle
mutation surface. It declares `modifies_memory` and `evaluatorPolicy=required`,
so an unchanged valid evaluator approval can execute after a second L0 check.
The evaluator decision is persisted before the handler and linked through the
terminal tool call/audit plus the memory revision/audit. Local permission checks
still limit owner/admin and ordinary-user targets; proposed, rejected,
superseded, or deleted records are not disabled. Active targets produce a
prepared effect; the state change, revision/audit, success tool call, and
`tool.executed` audit commit together. A late terminal failure therefore leaves
the active memory unchanged. The public result returns only a coarse
status/reason, never durable memory or source IDs.

The current built-in `group.recent_summary` tool is the first read-only group
chat context helper. Pi can call it only in a group turn with a current group ID;
it returns bounded aggregate counts and sanitized chronological excerpts from the
current group's `chat_messages` rows. It does not return raw sender IDs, group
IDs, message IDs, raw event IDs, or other groups' text. Secret/platform-like
fragments are redacted before prompt-facing tool results and before persisted
`tool_calls` / `audit_log` details, while existing redaction markers still count
as redacted evidence. PiAdapter tool exposure preserves that boundary: private
turns do not expose `group.recent_summary`, and a group turn without a current
group identifier returns only a rejected no-data summary instead of reading any
other group rows.

PiAdapter applies registry permissions twice: when exposing tools for a turn and
again at execution time through `beforeToolCall` / wrapped handler policy gates.
The actor context includes the current group identifier when the turn is in a
group chat, derived from `actor.groupId` or `ContextPack.conversation.groupId`,
so group allow/deny lists are enforced consistently. Tool audit details include
that runtime group identifier when present, which gives owner/admin review a
durable explanation for group-scoped tool exposure, execution, or rejection
without adding the allowlist table to ordinary prompts.
For `evaluatorPolicy=required`, the wrapped executor builds a bounded request
with the current turn, actor/context, tool metadata/input, and trigger event. It
persists a validated tool-domain decision before side effects and repeats L0
immediately before the handler. Only an unchanged, non-prohibited `approve`
runs. The adapter gives the evaluator a cloned request and rejects any in-place
request mutation before decision persistence or handler execution. All other
decisions, invalid/throwing output, missing source/writer state, modified input,
and additional constraints fail closed. Request input and context summary are
not copied into `evaluator_decisions`; the reviewed tool name is retained as a
non-payload binding field.
The non-mock evaluator starts a source-bound model invocation before the Provider
request and terminalizes it for every outcome. A valid result is persisted only
when that completed invocation exactly matches the turn, request/domain, ordered
sources, configured provider/model/prompt version, and request/start/completion/
decision chronology. The decision's unique invocation foreign key, tool call,
and tool audit then form the reviewed execution chain; a fabricated evaluator
version or an unlinked completed call cannot authorize or prove execution.
Immediately before the approved handler runs, PiAdapter composes Pi's optional
abort signal with the registered `maxRuntimeMs` into a required per-call handler
signal. A pre-aborted signal prevents invocation. Deadline or upstream abort
clears owned timers/listeners immediately but still awaits handler settlement;
the post-settlement monotonic check also detects synchronous event-loop blocking.
Upstream cancellation persists `error / TOOL_EXECUTION_ABORTED`; deadline expiry
persists `timeout / TOOL_RUNTIME_LIMIT_EXCEEDED`; both use fixed messages and
`tool.failed`. An expired result is never formatted as success, and an expired
prepared local effect is never applied. This is cooperative enforcement, not
hard termination or rollback for external effects already performed. Prepared
effect failure evidence also requires the local atomic coordinator; a missing
coordinator fails closed without writing a partial terminal pair.
Trusted local prepared effects are the bounded exception to ordinary handler
terminalization: no SQLite transaction is held across the awaited handler. Once
the handler returns inside its runtime boundary, PiAdapter builds all
prompt/audit redaction output, then a
synchronous coordinator on the shared database applies the effect and success
terminal pair in one transaction. If that transaction fails, it rolls back
before the coordinator writes the error tool-call and `tool.failed` audit as a
second atomic pair. Read-only and external-effect tools keep the ordinary path;
this does not claim transactional rollback for provider, network, shell, or
platform effects.
After a handler resolves, PiAdapter applies the registered `maxOutputBytes`
boundary to the already secret/platform-redacted public result. Prompt text and
JSON-serialized terminal output are UTF-8-byte-bounded independently; truncated
representations carry `[TRUNCATED:tool_output]`, and durable structured output
uses a bounded `{ truncated, originalBytes, preview }` envelope. The adapter
persists and returns only those bounded forms, adds `output truncated` to the
audit summary, and keeps the call `success` / `tool.executed`. Prepared effects
therefore apply once through the same transaction while only their public
terminal evidence is bounded; ordinary external effects are not mislabeled as
failed after execution.
PiAdapter `toolCallIds` now records all audited tool-call attempts that reach the
adapter boundary, including pre-call policy rejections, wrapped evaluator
rejections, handler errors, and successes, not only successful
tool executions. This keeps failed Pi turns linkable to the persisted
`tool_calls` and `audit_log` evidence without giving Pi direct storage or
platform-delivery authority.
Owner/admin `/why` uses the same persisted `tool_calls` linkage for explicit
turns and the default latest-turn resolution path: it can show redacted
tool-call IDs, names, statuses, requester, duration, error code, and bounded
error message, but it must not expose tool input/output payloads or raw
Pi/runtime response text.

## Failed Turn Diagnostics

Failed Pi turns are persisted as failed `agent_turns`, not silent no-response
success. Runtime/Pi error text stored in `agent_turns.response_text` is
repository-redacted before persistence: secret-like values and QQ/platform-ID-like
values are hidden, including adjacent `sk-...-qq-...` fragments where both the
secret and platform marker classes remain visible without storing the raw input.
Assignment-shaped adjacent diagnostics such as `api_key=sk-...-qq-...` preserve
both the secret-assignment marker and `[REDACTED:platform_id]` in persisted
failed-turn evidence, returned failed-turn adapter output, and PiAdapter
direct-console `runTurn` diagnostics while stack fields remain replaced with
`[REDACTED:stack]`.

## Social Actions

Pi may propose social actions, but the Attention/Evaluator/Action Executor stack owns final action selection and delivery.

Pi response text is a draft, not evidence that a memory effect occurred. Before
an action is bound, the action repository validates high-confidence memory
wording against the exact selected active memory or fully committed same-turn
`memory.propose` effect. Unsupported wording is neutralized, and a proposal may
be described only as pending review. Prompt instructions, a proposed action, or
an incomplete tool call do not authorize a claim.

`agent_turns.response_text` retains the pre-guard Pi draft for turn evidence.
The executable action payload, platform delivery, and persisted `bot.response`
row use the guarded text, so the delivered and persisted response remain equal
without rewriting the reasoning record.

Group chat should use structured actions such as `silent_store`, `reply_short`, `reply_full`, `reply_with_tool`, `dm_user`, `admin_digest`, `react_only`, or `send_folded_forward`, rather than a boolean reply decision.

For `reply_with_tool`, Pi/tool orchestration remains responsible for the actual
tool call, policy check, sandbox/audit, and tool-result persistence. The action
executor currently handles only the already-prepared reply delivery: it requires
a normal reply target and non-empty `payload.text`, applies the same L0
prohibited/evaluator-required guard as other outward replies, sends through the
response router, and records an `action_executions` row.

For `react_only`, Pi/attention may propose a lightweight reaction, but executor
delivery is still capability-gated and audited. The current executor requires
`payload.reaction` plus the target `payload.messageId`, prefers gateway
`sendReaction` when `reactions.emojiLike=true`, downgrades to a face/text message
when `reactions.faceMessage=true`, and otherwise records a downgraded silent
execution. L0 prohibited/evaluator-required guards run before true reaction or
fallback delivery.

For `send_folded_forward`, real folded-forward node delivery remains unwired in
the current executor, and the real `OneBotAdapter` reports all folded-forward
capabilities as unavailable. The safe deterministic behavior is a conservative
downgrade: send one prepared `payload.text` as a normal text fallback when a
target and text are present, or record downgraded silent evidence when no safe
fallback exists. L0 prohibited/evaluator-required guards run before fallback
side effects.

When `reply_with_tool` succeeds or `send_folded_forward` sends its downgraded
text fallback, main turn handling persists the sent message as the same
`bot.response` / `bot-self` evidence used for ordinary replies. A `react_only`
true reaction remains reaction-only evidence, but a face/text fallback that sends
a message and returns an executed message ID also persists `bot.response`
evidence. The persisted bot-response text is the actual delivered action
`payload.text` after evaluator, tool, or fallback modification; for `react_only`
face/text fallback it is the delivered `payload.reaction` rather than the raw Pi
draft. Failed sends, silent downgrades, and true reactions do not create
bot-response chat rows.

See `social-action-model.md` for action schemas, triggers, suppressors, cooldown, proactive DM, and gateway capability handling.
