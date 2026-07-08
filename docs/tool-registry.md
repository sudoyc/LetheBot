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

Default permissions:

- `shell_exec`, `credential_access`, `platform_admin`: owner/admin only.
- `write_local`, `external_side_effect`: owner/admin or trusted user.
- `sends_message`: user/group-triggerable, but proactive sending still goes through social evaluator/cooldown/audit.
- `read_context`: owner/admin/system worker; ordinary users can only access their own visible memory.
- `modifies_memory`: ordinary users can request changes to their own memory; durable writes go through memory policy/evaluator/executor.
- `network`: allowed based on the specific tool and whether it has external side effects or exports private data.

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
- action executor.

Registry values are minimum review requirements. Runtime policy can upgrade `bypass -> required` when context is riskier. Runtime policy cannot automatically downgrade `required -> bypass` without explicit owner configuration.

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

Defaults:

- `shell_exec`: docker/subprocess, workspace or allowed paths, no/restricted network, required max runtime.
- `read_local`: readonly or allowed paths.
- `write_local`: workspace write or allowed paths.
- `network`: restricted or allowed; private-data export requires evaluator.
- `long_running`: runtime/lease, cancellation handle, audit heartbeat.
- `credential_access`: pass only minimal secret references; never log secret values.

Docker is an execution backend, not a complete policy. Even Docker tools need network, mount, runtime, output, and audit constraints.

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
