# Security and Privacy

LetheBot is local-first and memory-heavy, so privacy rules must be part of the architecture rather than a later feature.

## Principles

- Users must be able to inspect long-term memory.
- Users must be able to delete memory.
- Durable memory must include source metadata.
- Platform identifiers should not be exposed outside the local deployment unless explicitly configured.
- Secrets must never be committed.

## Sensitive Data

Treat the following as sensitive:

- QQ user IDs and group IDs.
- Raw chat logs.
- User profiles.
- Group summaries.
- API keys and model credentials.
- Tool outputs containing local paths or private files.

## Retention

Retention should be configurable by storage class:

- Raw events.
- Chat messages.
- Summaries.
- Active memories.
- Disabled memories.
- Tool logs.

## Memory Deletion

Deletion requirements:

- Exclude deleted records from retrieval immediately.
- Preserve minimal tombstones only if needed for audit.
- Allow full purge mode later.
- Rebuild derived indexes after deletion.

## Tool Safety

Tools should declare:

- Required permissions.
- Whether they can mutate state.
- Whether they can access network.
- Whether results are persisted.
- Whether they can run long-lived processes.

Dangerous tools should require explicit policy checks before execution.

