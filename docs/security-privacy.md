# Security and Privacy

LetheBot is local-first and memory-heavy, so privacy rules must be part of the architecture rather than a later feature.

## Principles

- Users must be able to inspect long-term memory.
- Users must be able to delete memory.
- Durable memory must include source metadata.
- Platform identifiers are operational identity data. They may be used in local prompts when needed for identity disambiguation, platform operations, user-requested ID handling, permissions, or debug, but should be purpose-bound, minimal, and structured.
- Secrets must never be committed or stored as ordinary memory/audit content.
- Deletion and disable operations must affect retrieval immediately.

## Sensitive Data

Treat the following as sensitive or governed:

- Raw chat logs.
- User profiles and user memory.
- Group summaries and group memory.
- API keys, model credentials, cookies, private keys, and tokens.
- Tool outputs containing local paths, private files, personal data, or secrets.
- Audit logs and raw tool inputs/outputs.
- Nickname/group-card history when it contains personal names, contact info, sensitive status, or other personal data.

QQ user IDs and group IDs are governed operational identity data. They are not equivalent to API secrets, but they should not be dumped into ordinary prompt context or public output unless the current task needs them.

## Retention

Retention should be configurable by storage class:

- Raw events.
- Chat messages.
- Summaries.
- Active memories.
- Disabled memories.
- Tool logs and audit logs.
- Display metadata / nickname history.
- Identity tombstones.

## Memory Deletion

Deletion requirements:

- Exclude deleted records from retrieval immediately.
- Preserve minimal tombstones only if needed for audit, opt-out, or preventing accidental re-linking/re-creation.
- Allow full purge mode later.
- Rebuild derived indexes after deletion.
- Ensure disabled/deleted/superseded memory cannot be injected into ordinary prompts.

## Identity and Display Data Governance

Users should be able to request:

- user memory list/disable/delete/correct/export;
- display profile and nickname history deletion/redaction;
- proactive DM opt-out;
- memory association opt-out;
- account unlink.

P0 may expose these controls through owner/admin CLI first. Ordinary user requests can become admin digests or evaluator-mediated actions until self-service commands exist.

Identity registry deletion may retain minimal tombstones. Tombstones do not enter prompt or retrieval.

## Prompt and Context Boundaries

Ordinary prompts must not receive:

- `secret` / `prohibited` content;
- disabled/deleted memory;
- full allowlists/denylists;
- full account mapping tables;
- full nickname history;
- raw audit traces unless in owner/admin debug mode.

Platform IDs may be included when the current task needs them, but they should be structured fields rather than natural-language background.

## Audit Safety

All tools should record at least summary audit in P0.

Audit levels:

- `summary`
- `redacted_full`
- `full`
- `none` reserved for future very low-risk cases

`full` is owner/debug only, short-retention, and still passes secret scanning.

Credential access must never log secret values. If secret scanning detects a credential in input/output, rewrite audit to redacted summary and mark `redactionApplied=true`.

## Tool Safety

Tools should declare:

- capabilities;
- required permissions;
- evaluator policy: `required | bypass`;
- audit level;
- sandbox policy;
- output sensitivity;
- whether they can mutate state;
- whether they can access network;
- whether results are persisted;
- whether they can run long-lived processes.

Dangerous tools should require explicit policy checks before execution. Bypassing LLM evaluator review does not bypass permissions, sandboxing, deterministic hard policy, or audit.

See `tool-registry.md`.

