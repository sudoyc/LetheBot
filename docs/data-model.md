# Data Model

This is a conceptual model for the first implementation. Exact schemas can change, but the ownership boundaries should remain stable.

## Core Entities

### Platform Identity

- `canonical_users`
- `platform_accounts`
- `platform_groups`
- `group_memberships`
- `identity_links`
- `display_profiles`
- `nickname_history`
- `identity_tombstones`

These tables separate QQ identifiers from LetheBot internal user IDs.

Raw QQ IDs, group IDs, and account IDs are operational identity data. They are not ordinary memory and not treated like API secrets, but prompt injection must be purpose-bound, minimal, and structured.

`canonical_user_id` is the owner key for user memory. Platform account IDs are mapping keys for routing, permissions, identity disambiguation, and audit.

### Events

- `raw_events`
- `chat_messages`
- `agent_runs`
- `agent_events`
- `evaluator_decisions`
- `action_decisions`
- `action_executions`
- `tool_calls`
- `audit_log`

Raw events are the audit foundation. Derived tables can be rebuilt from them when possible.

### Memory

- `memory_records`
- `memory_sources`
- `memory_embeddings`
- `memory_tags`
- `memory_revisions`
- `memory_access_log`

## Suggested `memory_records` fields:

```sql
CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,
  
  -- Ownership
  scope TEXT NOT NULL CHECK(scope IN ('global', 'user', 'group', 'conversation', 'tool', 'system')),
  canonical_user_id TEXT,
  group_id TEXT,
  conversation_id TEXT,
  subject_user_id TEXT,
  
  -- Boundaries
  visibility TEXT NOT NULL CHECK(visibility IN ('private_only', 'same_user_any_context', 'same_group_only', 'owner_admin_only', 'public')),
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal', 'personal', 'sensitive', 'secret', 'prohibited')),
  authority TEXT NOT NULL CHECK(authority IN ('user_stated', 'inferred', 'tool_derived', 'system')),
  
  -- Content
  kind TEXT NOT NULL CHECK(kind IN ('preference', 'fact', 'constraint', 'summary', 'reflection', 'procedure')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  
  -- Lifecycle
  state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'superseded', 'disabled', 'deleted')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1),
  
  -- Provenance
  source_context TEXT,
  evaluator_decision_id TEXT,
  
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  
  -- Indexes for retrieval
  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id),
  FOREIGN KEY (group_id) REFERENCES platform_groups(id)
);

CREATE INDEX idx_memory_scope ON memory_records(scope);
CREATE INDEX idx_memory_user ON memory_records(canonical_user_id) WHERE canonical_user_id IS NOT NULL;
CREATE INDEX idx_memory_group ON memory_records(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_memory_state ON memory_records(state);
CREATE INDEX idx_memory_visibility ON memory_records(visibility);
CREATE INDEX idx_memory_active ON memory_records(state, canonical_user_id) WHERE state = 'active';

-- Full-text search
CREATE VIRTUAL TABLE memory_fts USING fts5(
  title,
  content,
  content=memory_records,
  content_rowid=rowid
);
```

See `docs/sqlite-schema.md` for complete P0 schema draft.

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

### Tools

- `tool_registry`
- `tool_permission_policies`
- `tool_sandbox_policies`
- `tool_audit_policies`
- `tool_calls`

Tool metadata is described in `tool-registry.md`.

### Social Actions

- `action_decisions`
- `action_plans`
- `action_executions`
- `cooldown_budgets`
- `gateway_capabilities`

Social action behavior is described in `social-action-model.md`.

## Scope Values

- `global`
- `user`
- `group`
- `conversation`
- `tool`
- `system`

P0 should focus on `user`, `group`, `conversation`, and `system`. `tool` and `global` are reserved but should be used sparingly.

## Visibility Values

- `private_only`
- `same_user_any_context`
- `same_group_only`
- `owner_admin_only`
- `public`

## Sensitivity Values

- `normal`
- `personal`
- `sensitive`
- `secret`
- `prohibited`

## Source Context Values

- `private_chat`
- `group_chat`
- `admin_cli`
- `tool_result`
- `background_worker`
- `imported_document`

## Memory States

- `proposed`
- `active`
- `rejected`
- `disabled`
- `superseded`
- `deleted`

Deletion must exclude the record from retrieval immediately.

## Identity Binding States

- `unlinked`
- `self_claimed`
- `owner_verified`
- `rejected`
- `merged`

Cross-platform or multi-account merge should require owner/admin verification or a stronger verification flow.

Unlinking an account must immediately prevent that account from retrieving the previous canonical user's memory unless another verified binding exists.

## Display Metadata Lifecycle

Display metadata such as nickname/group-card history can use:

- `active`
- `superseded`
- `redacted`
- `deleted`

Display tombstones may be retained to prevent deleted data from being rebuilt, but tombstones do not enter prompt or retrieval.

