# Tool Registry

Tools must be registered with metadata that lets LetheBot evaluate permissions, evaluator policy, audit requirements, and sandbox boundaries before execution.

Tool metadata is not a feature-enable switch. A tool may be installed and available while still requiring evaluator review or stricter runtime policy.

## Metadata Categories

Each registered tool should declare:

1. `capabilities`
2. `permissions`
3. `evaluatorPolicy`
4. `auditLevel`
5. `sandboxPolicy`
6. `outputSensitivity`

P0 must enforce at least:

- `capabilities`
- `evaluatorPolicy`
- `auditLevel`
- `sandboxPolicy`

`permissions` and `outputSensitivity` can begin with safe defaults, but the schema should support them.

## Capabilities

P0 capability values:

- `read_context` — reads LetheBot memory, raw logs, audit trace, context.
- `read_local` — reads local files, databases, or config.
- `write_local` — writes local files, databases, or config.
- `network` — accesses external network.
- `shell_exec` — executes shell or code.
- `long_running` — creates background jobs, watchers, cron, or long tasks.
- `sends_message` — sends chat, DM, email, or notifications.
- `modifies_memory` — creates, edits, disables, deletes, or supersedes durable memory.
- `external_side_effect` — writes to external systems such as issues, docs, APIs, orders.
- `credential_access` — reads or uses credentials/secret manager references.
- `platform_admin` — performs platform moderation/admin actions such as kick, mute, rename, invite handling.

A tool can have multiple capabilities.

`read_context` is separate from `read_local` because memory/raw logs have different privacy boundaries from the filesystem.

`sends_message` is separate from `network` because social side effects need their own controls.

`platform_admin` is separate from `sends_message` because group management actions have higher social/governance risk.

## Permissions

P0 permissions use three layers:

1. actor class;
2. invocation context;
3. allowlist/denylist.

Actor classes:

- `owner`
- `admin`
- `trusted_user`
- `user`
- `group_admin`
- `system_worker`
- `evaluator`
- `tool`

Invocation contexts:

- `private_chat`
- `group_chat`
- `admin_cli`
- `background_worker`
- `internal`

Schema sketch:

```ts
interface ToolPermissionPolicy {
  allowedActors: ActorClass[];
  allowedContexts: InvocationContext[];
  allowedUserIds?: string[];
  allowedGroupIds?: string[];
  deniedUserIds?: string[];
  deniedGroupIds?: string[];
}
```

Raw QQ IDs and group IDs are operational identity data. They may be used for policy checks, identity disambiguation, platform operations, or owner/admin debug, but they should not be dumped into ordinary prompt context as entire allowlist/denylist tables.

The registry enforces all declared L0 permission dimensions before a tool is
exposed or executed: actor class, invocation context, `deniedUserIds`,
`allowedUserIds`, `deniedGroupIds`, and `allowedGroupIds`. Deny lists take
precedence, and non-empty allow lists are conservative: if the relevant
canonical user or group identifier is absent from the invocation context, the
tool is not allowed.

Pi integration threads the current group identifier into registry checks before
tool exposure, Pi `beforeToolCall` policy checks, and wrapped handler execution.
For group chat turns, the adapter uses the explicit actor group context when
present and otherwise falls back to `ContextPack.conversation.groupId`, so
`allowedGroupIds` / `deniedGroupIds` tools are visible and executable only in
matching group contexts.

`ToolRegistryEntry.name` is the canonical identity used by permissions,
evaluator binding, handlers, and durable evidence. PiAdapter builds an atomic,
collision-checked Provider-name map from only the entries allowed in the current
turn. Provider-safe canonical names remain unchanged; dotted, non-ASCII, or
overlong names receive deterministic opaque aliases matching
`[A-Za-z0-9_-]{1,64}`. Provider calls and transcript messages keep those aliases,
while LetheBot hooks resolve them locally without rewriting the Pi tool call.
Unknown or previous-turn aliases are rejected before registry/policy access, and
old converted tool objects cannot execute after the turn directory changes.

Default permissions:

- `shell_exec`, `credential_access`, `platform_admin`: owner/admin only.
- `write_local`, `external_side_effect`: owner/admin or trusted user.
- `sends_message`: user/group-triggerable, but proactive sending still goes through social evaluator/cooldown/audit.
- `read_context`: owner/admin/system worker; ordinary users can only access their own visible memory.
- `modifies_memory`: ordinary users can request changes to their own memory; durable writes go through memory policy/evaluator/executor.
- `network`: allowed based on the specific tool and whether it has external side effects or exports private data.

Built-in `memory.search` uses the conservative ordinary-user `read_context`
shape: allowed actors are `owner`, `admin`, `trusted_user`, and `user`; allowed
contexts are `private_chat` and `group_chat`; evaluator policy is `bypass`;
audit level is `redacted_full`; filesystem and network access are `none`;
execution is in-process and declares runtime/output limit metadata; output
sensitivity is `secret_possible`. The handler is read-only, goes through the same registry /
PolicyGate / PiAdapter audit boundaries as other tools, and does not return
memory IDs or source event IDs.

Built-in `memory.propose` uses the same chat actor/context permission shape but
adds `modifies_memory`, `evaluatorPolicy=required`, `redacted_full` audit, no
filesystem/network access, in-process execution with declared limit metadata,
and `sensitive` output.
PiAdapter now performs source-bound evaluator review for required tools, but
`memory.propose` does not pretend that the not-yet-terminal tool call is the
original source. PiAdapter supplies the evaluator-approved turn's raw source
event and decision ID through trusted handler context. The handler verifies that
the durable decision approves the same tool, turn, actor, context, and source set,
then returns a privately branded prepared effect without mutating durable memory.
Immediately before commit, the effect revalidates the approval/source binding.
One shared-SQLite transaction creates only a `proposed` record with the raw
event's timestamp, `extracted_by=tool`, internal `raw_event` provenance, matching
memory revision/audit evidence, the success `tool_calls` row, and its
`tool.executed` audit. A late terminal insert failure rolls that transaction
back; a linked error tool-call/audit pair is attempted afterward in a separate
transaction. The handler cannot activate memory and its public result does not
return memory, source, evaluator, or tool-call IDs.

Built-in `memory.disable` also uses chat actor/context permissions with
`modifies_memory`, `evaluatorPolicy=required`, `redacted_full` audit, no
filesystem/network access, in-process execution with declared limit metadata,
and `sensitive` output.
An unchanged valid evaluator `approve` may reach the handler after L0 is checked
again. The durable evaluator decision is written first and its ID is carried by
the terminal tool call, tool audit, memory revision, and memory audit. The
handler can only prepare disablement of active records allowed by local ownership
rules (owner/admin, or the current user's own non-owner-admin user memory). The
disable revision/audit and success terminal pair commit in the same shared-SQLite
transaction, so late terminal failure preserves the original active record and
its evidence exactly. The public result returns only coarse status/reason output.

Built-in `group.recent_summary` is a read-only current-group context tool. It is
available only in `group_chat`, uses `read_context`, bypasses evaluator review,
uses `redacted_full` audit, has no filesystem/network access, and treats output
as `secret_possible`. The handler reads bounded recent `chat_messages` for the
current runtime group only, returns aggregate counts plus sanitized chronological
excerpts, labels speakers as `participant_N` or `bot`, and omits raw message IDs,
raw sender IDs, raw group IDs, source event IDs, and other groups' text. Prompt,
`tool_calls`, and `audit_log` paths preserve redaction markers for secret-like or
platform-like fragments in returned excerpts. PiAdapter exposure preserves this
group boundary: private turns do not expose the tool, and group turns without a
current group identifier receive only a rejected no-data result rather than a
fallback summary from any other group.

## Evaluator Policy

P0 evaluator policy has two values:

```ts
type EvaluatorPolicy = "required" | "bypass";
```

`required` means the tool call must pass LLM/agent evaluator review.

`bypass` means owner policy allows the call to skip LLM evaluator review. It does not bypass:

- L0 hard policy;
- permissions;
- audit;
- sandbox;
- the relevant governed execution boundary.

Registry values are minimum review requirements. Runtime policy can upgrade `bypass -> required` when context is riskier. Runtime policy cannot automatically downgrade `required -> bypass` without explicit owner configuration.

The current required-tool executor checks L0 in Pi's pre-call hook and again at
wrapped execution, creates a bounded evaluator request tied to the current turn
and trigger event, validates and persists the decision, then repeats L0 before
calling the handler. Only an unchanged `approve` with non-prohibited risk runs.
For a model-backed result, persistence additionally requires one completed
turn-owned invocation whose request/domain, ordered sources,
provider/model/prompt identity, and timestamps exactly match the evaluator
evidence. A version string without that link is not Provider review.
Reject/propose/downgrade, malformed or throwing evaluators, missing durable
source/writer state, modified input, and additional constraints fail closed.
Modified-input and evaluator-added runtime constraints remain unsupported until
they can be revalidated and enforced centrally.
When evaluator invocation fails, PiAdapter persists the required tool attempt as
`rejected` with bounded `EVALUATOR_ERROR` plus a matching `tool.rejected` audit,
leaves the evaluator-decision link null, and never invokes the handler. The
separately terminal model-invocation row remains the Provider-call evidence;
invalid output or Provider diagnostics are not copied into tool/audit rows.

Default `required` capabilities:

- `write_local`
- `shell_exec`
- `credential_access`
- `external_side_effect`
- `platform_admin`
- proactive `sends_message`
- `modifies_memory`
- `long_running`
- `read_context` over private/sensitive/raw/audit data
- `network` with user/private data export

## Audit Level

Audit levels:

- `summary`
- `redacted_full`
- `full`
- `none`

P0 tools should record at least `summary`. `none` is reserved for future extremely low-risk tools and should not be the default.

`summary` records:

- tool name;
- actor/context;
- current group identifier when a group-scoped permission check used one;
- capabilities;
- success/failure;
- redacted summary;
- timestamps;
- evaluator/action decision ID.

`redacted_full` records structured input/output with field-level redaction.

Repository-backed `tool_calls` rows use the same defensive posture: before
persistence, structured tool input/output payload keys and values plus
error diagnostics are scanned for secret-like and QQ/platform-ID-like text.
ID-shaped numeric values are redacted when they sit under ID fields such as
`userId`, `senderIds`, `targetUserId`, `recipientGroupIds`, `group_id`, or
`platformMessageId`. The row's `secrets_redacted` flag is set when this final
guard changes stored data. Adjacent secret/platform fragments such as
`sk-...-qq-...` use a marker-preserving platform-before-secret-after-platform
ordering so both marker classes remain visible without storing raw values.
Assignment-shaped fragments such as `api_key=sk-...-qq-...` follow the same
marker-preserving rule for structured keys, values, and error diagnostics.
PiAdapter records the tool-call ID for every adapter-audited attempt that
reaches a terminal policy or execution boundary, including pre-call permission
denials, wrapped evaluator/policy rejections, handler errors, and successes, so
failed turns can be correlated with their durable `tool_calls` / `audit_log`
rows. Valid evaluator decisions are also linked through
`tool_calls.evaluator_decision_id` and the audit evaluator-decision field;
model-backed decisions additionally reference their unique completed invocation.
Owner/admin `/why` explanations use those durable rows for explicit-turn and
default latest-turn tool-call summaries, but display only
identifiers/status/requester/timing/error metadata after redaction and never
dump tool input/output payloads.

`full` is only for owner/admin debug or local experiment mode, should have short retention, must not enter ordinary prompt/retrieval, and still passes secret scanning.

`credential_access` must never use `full` for secret values.

If secret scanning finds credentials, rewrite the audit to redacted summary and set `redactionApplied=true`.

## Sandbox Policy

Sandbox policy is object-shaped because filesystem, network, execution, and limits are orthogonal.

```ts
interface SandboxPolicy {
  filesystem: "none" | "readonly" | "workspace_write" | "allowed_paths";
  network: "none" | "restricted" | "allowed";
  execution: "none" | "in_process" | "subprocess" | "docker";
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  allowedPaths?: string[];
  allowedDomains?: string[];
}
```

P0 can start with:

- `filesystem`
- `network`
- `execution`
- `maxRuntimeMs`
- `maxOutputBytes`

Target defaults for future isolated backends:

- `shell_exec`: docker/subprocess, workspace or allowed paths, no/restricted network, required max runtime.
- `read_local`: readonly or allowed paths.
- `write_local`: workspace write or allowed paths.
- `network`: restricted or allowed; private-data export requires evaluator.
- `long_running`: runtime/lease, cancellation handle, audit heartbeat.
- `credential_access`: pass only minimal secret references; never log secret values.

Docker is an execution backend, not a complete policy. Even Docker tools need network, mount, runtime, output, and audit constraints.

The current function-handler runtime supports only `execution='in_process'`.
Registration rejects missing or unknown execution values. The other declared
values remain representable metadata for future backends, but PolicyGate does
not expose or execute `none`, `subprocess`, or `docker` entries, and the
standalone Pi tool adapter repeats the same check before conversion and again
before handler invocation. Changing the metadata after registration therefore
fails closed; declaring a backend never causes the current process to emulate
or silently downgrade it.

Registry registration rejects optional runtime/output limits unless they are
positive safe integers. `maxRuntimeMs` is additionally capped at the host timer
maximum `2147483647`; `maxOutputBytes` must be large enough to hold the stable
truncation envelope (currently `87` UTF-8 bytes). PiAdapter applies the output
limit centrally after secret and platform-identifier redaction. Prompt-facing
text and JSON-serialized durable output are measured independently in UTF-8;
oversized prompt text ends with `[TRUNCATED:tool_output]`, while oversized
structured output becomes a bounded `{ truncated, originalBytes, preview }`
envelope carrying the same marker. Discarded output is neither returned to Pi
nor written to `tool_calls` / `audit_log`.

Both Pi tool wrappers create a fresh per-call signal and compose Pi cancellation
with `maxRuntimeMs` immediately before handler invocation, after policy and
evaluator checks. A pre-aborted call does not invoke the handler. On cancellation
the wrapper aborts the handler signal, clears its timer/listener, and awaits the
handler's actual settlement. A monotonic elapsed-time check also catches a
synchronous handler that blocked the deadline callback. Upstream cancellation
uses `error / TOOL_EXECUTION_ABORTED`; runtime expiry uses
`timeout / TOOL_RUNTIME_LIMIT_EXCEEDED`; both emit `tool.failed` with fixed,
non-leaking messages. Late prepared effects are identified for atomic failure
terminalization but are never applied. If the required local coordinator is
absent, the attempt fails closed before either terminal row is written rather
than degrading to split persistence.

Output limiting is a terminal egress/persistence boundary, not a reason to
reclassify a resolved handler as failed. Ordinary external-effect handlers stay
`success` / `tool.executed`, and trusted prepared local effects still commit
exactly once with their bounded success evidence. This avoids retry ambiguity
after a side effect may already have happened. Generic hard termination of a
non-cooperative in-process handler remains a separate execution-backend policy.
Such a handler can delay settlement, and an external effect completed before it
observes cancellation cannot be rolled back by the wrapper.

## Output Sensitivity

Initial output sensitivity values:

- `normal`
- `personal`
- `sensitive`
- `secret_possible`

`secret_possible` outputs must be scanned before audit, memory proposal, or prompt injection.
For `network_request`, this includes response bodies, response headers,
response `statusText`, and thrown network error messages before the handler
returns them to Pi/tool-call callers. Adjacent secret/platform fragments such as
`sk-...-qq-...` must preserve both redaction marker classes without exposing the
raw combined value.
For file-operation tools, this includes read-file content, output paths,
directory entry names/paths, audit summaries, validation reasons, and filesystem
error messages before the handler result can feed audit or prompt paths.
Adjacent secret/platform fragments in file contents or filenames must preserve
both marker classes without exposing raw values.
