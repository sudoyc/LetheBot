# SQLite Schema (P0 Draft)

This is the initial SQLite schema for LetheBot MVP. Field names and exact types will be finalized during Phase C implementation.

**Status:** Draft for Phase C. Exact migrations will be written during implementation.

---

## Core Tables

### canonical_users

Internal user IDs, separate from platform accounts.

```sql
CREATE TABLE canonical_users (
  id TEXT PRIMARY KEY,  -- ULID
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
```

### platform_accounts

Maps platform identities to canonical users.

```sql
CREATE TABLE platform_accounts (
  platform TEXT NOT NULL CHECK(platform IN ('qq')),
  platform_account_id TEXT NOT NULL,
  canonical_user_id TEXT NOT NULL,
  
  account_type TEXT NOT NULL CHECK(account_type IN ('private', 'group_member', 'temp_session')),
  verified_level TEXT NOT NULL CHECK(verified_level IN ('observed', 'self_claimed', 'owner_verified')),
  status TEXT NOT NULL CHECK(status IN ('active', 'disabled', 'deleted')),
  
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  
  PRIMARY KEY (platform, platform_account_id),
  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)
);

CREATE INDEX idx_platform_accounts_canonical ON platform_accounts(canonical_user_id);
```

### platform_groups

QQ groups and other group identifiers.

```sql
CREATE TABLE platform_groups (
  id TEXT PRIMARY KEY,  -- e.g., 'qq:123456789'
  platform TEXT NOT NULL,
  platform_group_id TEXT NOT NULL,
  
  group_name TEXT,
  
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  
  UNIQUE(platform, platform_group_id)
);
```

### display_profiles

Current display names and group cards (not history).

```sql
CREATE TABLE display_profiles (
  canonical_user_id TEXT NOT NULL,
  source_group_id TEXT,  -- NULL = private/global nickname
  
  current_display_name TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  trust TEXT NOT NULL CHECK(trust IN ('platform_provided', 'user_set', 'inferred')),
  
  PRIMARY KEY (canonical_user_id, source_group_id),
  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)
);
```

### nickname_history

Bounded history of display names (P1, optional for P0).

```sql
CREATE TABLE nickname_history (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  source_group_id TEXT,
  
  display_name TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  observed_until INTEGER,
  
  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)
);

CREATE INDEX idx_nickname_history_user ON nickname_history(canonical_user_id);
```

---

## Event Tables

### raw_events

Immutable audit trail of all events.

```sql
CREATE TABLE raw_events (
  id TEXT PRIMARY KEY,  -- ULID
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('gateway', 'agent', 'tool', 'worker', 'system')),
  
  platform TEXT,
  conversation_id TEXT,
  correlation_id TEXT,
  
  payload TEXT NOT NULL,  -- JSON
  
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_raw_events_type ON raw_events(type);
CREATE INDEX idx_raw_events_timestamp ON raw_events(timestamp DESC);
CREATE INDEX idx_raw_events_conversation ON raw_events(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_raw_events_correlation ON raw_events(correlation_id) WHERE correlation_id IS NOT NULL;
```

### chat_messages

Parsed chat messages (denormalized from raw_events for fast access).

```sql
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,  -- same as raw_events.id
  raw_event_id TEXT NOT NULL,
  
  message_id TEXT NOT NULL,  -- platform message ID
  conversation_id TEXT NOT NULL,
  conversation_type TEXT NOT NULL CHECK(conversation_type IN ('private', 'group')),
  
  group_id TEXT,
  sender_id TEXT NOT NULL,  -- platform account ID
  sender_role TEXT,
  
  text TEXT,
  has_media INTEGER NOT NULL DEFAULT 0,
  has_quote INTEGER NOT NULL DEFAULT 0,
  
  mentions_bot INTEGER NOT NULL DEFAULT 0,
  reply_to_message_id TEXT,
  
  timestamp INTEGER NOT NULL,
  
  FOREIGN KEY (raw_event_id) REFERENCES raw_events(id)
);

CREATE INDEX idx_chat_messages_conversation ON chat_messages(conversation_id, timestamp DESC);
CREATE INDEX idx_chat_messages_sender ON chat_messages(sender_id);
CREATE INDEX idx_chat_messages_timestamp ON chat_messages(timestamp DESC);
```

---

## Memory Tables

### memory_records

Long-term memory with boundaries.

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
  
  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)
);

CREATE INDEX idx_memory_scope ON memory_records(scope);
CREATE INDEX idx_memory_user ON memory_records(canonical_user_id) WHERE canonical_user_id IS NOT NULL;
CREATE INDEX idx_memory_group ON memory_records(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_memory_state ON memory_records(state);
CREATE INDEX idx_memory_visibility ON memory_records(visibility);
CREATE INDEX idx_memory_active_user ON memory_records(state, canonical_user_id) WHERE state = 'active';

-- Full-text search
CREATE VIRTUAL TABLE memory_fts USING fts5(
  title,
  content,
  content=memory_records,
  content_rowid=rowid
);
```

### memory_sources

Links memory to source events.

```sql
CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('raw_event', 'chat_message', 'tool_output', 'worker_extraction', 'user_command')),
  source_id TEXT NOT NULL,
  source_timestamp INTEGER NOT NULL,
  extracted_by TEXT,
  
  PRIMARY KEY (memory_id, source_id),
  FOREIGN KEY (memory_id) REFERENCES memory_records(id)
);

CREATE INDEX idx_memory_sources_memory ON memory_sources(memory_id);
```

### memory_revisions

Tracks changes to memory records.

```sql
CREATE TABLE memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  
  change_type TEXT NOT NULL CHECK(change_type IN ('create', 'update', 'supersede', 'disable', 'delete', 'restore')),
  
  previous_state TEXT,  -- JSON snapshot
  new_state TEXT,  -- JSON snapshot
  
  reason TEXT,
  actor TEXT NOT NULL,
  evaluator_decision_id TEXT,
  
  created_at INTEGER NOT NULL,
  
  FOREIGN KEY (memory_id) REFERENCES memory_records(id)
);

CREATE INDEX idx_memory_revisions_memory ON memory_revisions(memory_id);
```

### memory_embeddings (P1, optional for P0)

Vector embeddings for semantic search.

```sql
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  embedding BLOB NOT NULL,  -- serialized vector
  dimension INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  
  FOREIGN KEY (memory_id) REFERENCES memory_records(id)
);
```

---

## Agent Turn Tables

### agent_turns

Pi runtime invocations.

```sql
CREATE TABLE agent_turns (
  id TEXT PRIMARY KEY,  -- ULID, also serves as turnId
  conversation_id TEXT NOT NULL,
  
  trigger_event_id TEXT NOT NULL,
  context_pack_id TEXT,
  
  pi_model TEXT NOT NULL,
  pi_provider TEXT NOT NULL,
  
  action_decision_id TEXT,
  response_text TEXT,
  
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'aborted')),
  
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_total INTEGER,
  
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  
  FOREIGN KEY (trigger_event_id) REFERENCES raw_events(id)
);

CREATE INDEX idx_agent_turns_conversation ON agent_turns(conversation_id);
CREATE INDEX idx_agent_turns_status ON agent_turns(status);
CREATE INDEX idx_agent_turns_started ON agent_turns(started_at DESC);
```

### action_decisions

Structured action outputs.

```sql
CREATE TABLE action_decisions (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  
  decided_by TEXT NOT NULL CHECK(decided_by IN ('attention', 'pi', 'evaluator')),
  
  risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'prohibited')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  
  evaluator_required INTEGER NOT NULL DEFAULT 0,
  evaluator_passed INTEGER,
  
  actions TEXT NOT NULL,  -- JSON array of ActionPlan
  reasons TEXT,  -- JSON array
  suppressors TEXT,  -- JSON array
  
  created_at INTEGER NOT NULL,
  
  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);

CREATE INDEX idx_action_decisions_turn ON action_decisions(turn_id);
```

### action_executions

Results of executing actions.

```sql
CREATE TABLE action_executions (
  id TEXT PRIMARY KEY,
  action_decision_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  
  status TEXT NOT NULL CHECK(status IN ('success', 'downgraded', 'failed', 'rejected')),
  
  executed_message_id TEXT,
  downgraded_from TEXT,
  downgraded_reason TEXT,
  
  error_code TEXT,
  error_message TEXT,
  
  audit_level TEXT NOT NULL CHECK(audit_level IN ('none', 'summary', 'redacted_full', 'full')),
  audit_entry TEXT,
  
  executed_at INTEGER NOT NULL,
  
  FOREIGN KEY (action_decision_id) REFERENCES action_decisions(id)
);

CREATE INDEX idx_action_executions_decision ON action_executions(action_decision_id);
```

---

## Tool Tables

### tool_calls

Tool invocation records.

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  
  input TEXT NOT NULL,  -- JSON
  output TEXT,  -- JSON
  
  requested_by TEXT NOT NULL CHECK(requested_by IN ('pi', 'evaluator', 'user', 'system')),
  actor_user_id TEXT,
  actor_class TEXT NOT NULL,
  invocation_context TEXT NOT NULL,
  
  status TEXT NOT NULL CHECK(status IN ('success', 'error', 'timeout', 'rejected')),
  error_code TEXT,
  error_message TEXT,
  
  execution_time_ms INTEGER,
  secrets_redacted INTEGER NOT NULL DEFAULT 0,
  
  created_at INTEGER NOT NULL,
  
  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);

CREATE INDEX idx_tool_calls_turn ON tool_calls(turn_id);
CREATE INDEX idx_tool_calls_tool_name ON tool_calls(tool_name);
```

---

## Audit Table

### audit_log

Security and governance audit trail.

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  
  category TEXT NOT NULL CHECK(category IN ('tool', 'memory', 'social', 'evaluator', 'system')),
  level TEXT NOT NULL CHECK(level IN ('summary', 'redacted_full', 'full')),
  
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  
  actor_user_id TEXT,
  actor_class TEXT,
  invocation_context TEXT,
  
  summary TEXT NOT NULL,
  details TEXT,  -- JSON, redacted if level != full
  redacted INTEGER NOT NULL DEFAULT 0,
  
  risk_level TEXT,
  evaluator_decision_id TEXT
);

CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_log_category ON audit_log(category);
CREATE INDEX idx_audit_log_event_type ON audit_log(event_type);
```

---

## Background Jobs (P1, optional for P0)

### jobs

Job queue for background workers.

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  
  payload TEXT NOT NULL,  -- JSON
  
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  
  error TEXT,
  result TEXT  -- JSON
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_scheduled ON jobs(scheduled_at) WHERE status = 'pending';
```

---

## Migrations Strategy

### Phase C Implementation

1. Start with schema v1 (all tables above minus P1-marked tables)
2. Use a migration framework (e.g., `node-pg-migrate` adapted for SQLite, or custom)
3. Each migration file is timestamped: `001_initial_schema.sql`
4. Migrations are idempotent and tested on empty DB

### Future Migrations

- Add new fields with `ALTER TABLE ... ADD COLUMN`
- Never delete columns (mark deprecated, filter in queries)
- Add new tables freely
- Update CHECK constraints carefully (may require table rebuild)

---

## Notes

- **INTEGER for timestamps:** SQLite stores timestamps as Unix epoch integers (milliseconds)
- **TEXT PRIMARY KEY:** ULIDs are text, not integers
- **JSON columns:** Store complex data as TEXT containing JSON (validated at app layer)
- **FTS5:** Full-text search for memory content (SQLite compiled with FTS5 support)
- **Indexes:** Partial indexes (`WHERE` clause) for common queries
- **Foreign keys:** Enabled with `PRAGMA foreign_keys = ON;`
- **WAL mode:** Enable with `PRAGMA journal_mode = WAL;` for concurrency