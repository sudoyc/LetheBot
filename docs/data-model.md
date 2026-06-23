# Data Model

This is a conceptual model for the first implementation. Exact schemas can change, but the ownership boundaries should remain stable.

## Core Entities

### Platform Identity

- `platform_accounts`
- `platform_users`
- `platform_groups`
- `identity_links`
- `nickname_history`

These tables separate QQ identifiers from LetheBot internal user IDs.

### Events

- `raw_events`
- `chat_messages`
- `agent_runs`
- `agent_events`
- `tool_calls`

Raw events are the audit foundation. Derived tables can be rebuilt from them when possible.

### Memory

- `memory_records`
- `memory_sources`
- `memory_embeddings`
- `memory_tags`
- `memory_revisions`
- `memory_access_log`

Suggested `memory_records` fields:

- `id`
- `scope`
- `owner_user_id`
- `owner_group_id`
- `kind`
- `title`
- `content`
- `state`
- `confidence`
- `importance`
- `created_at`
- `updated_at`
- `expires_at`

### Context

- `context_packs`
- `context_blocks`
- `context_memory_links`

These tables make answers explainable after the fact.

### Background Jobs

- `jobs`
- `job_attempts`
- `worker_heartbeats`

Jobs should be idempotent where possible.

## Scope Values

- `global`
- `user`
- `group`
- `conversation`
- `tool`
- `system`

## Memory States

- `proposed`
- `active`
- `rejected`
- `disabled`
- `superseded`
- `deleted`

Deletion must exclude the record from retrieval immediately.

