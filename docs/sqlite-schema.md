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
Platform-provided values are untrusted UI data. Runtime ingestion redacts
secret-like substrings and QQ/platform-ID-like substrings before writing
`current_display_name`.

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
History rows follow the same redaction rule as `display_profiles`: raw
credential-shaped or platform-ID-shaped substrings from nicknames/group cards
are not written to `display_name`.

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

### privacy_preferences

Durable user privacy controls. These rows do not enter ordinary prompt
context; they are used by governance/runtime policy.

`reason` stores redacted operator metadata. Secret-like values and
QQ/platform-ID-like values are removed before insertion/update, and matching
audit details use the same redaction. The primary key remains the exact local
`canonical_user_id` so enforcement and owner/admin filtering remain stable.

```sql
CREATE TABLE privacy_preferences (
  canonical_user_id TEXT NOT NULL,
  preference_type TEXT NOT NULL CHECK(preference_type IN ('proactive_dm', 'memory_association')),

  state TEXT NOT NULL CHECK(state IN ('opted_in', 'opted_out')),
  reason TEXT,  -- redacted operator/source narrative

  updated_by_user_id TEXT,
  updated_by_actor_class TEXT NOT NULL,
  updated_by_context TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (canonical_user_id, preference_type),
  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)
);

CREATE INDEX idx_privacy_preferences_state
  ON privacy_preferences(preference_type, state);
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

### event_processing_failures

Durable, redacted observability for async event-processing failures. This table
stores internal IDs and hashes only; it must not store platform IDs, message
text, display names, or raw error strings.

```sql
CREATE TABLE event_processing_failures (
  id TEXT PRIMARY KEY,

  raw_event_id TEXT,
  turn_id TEXT,

  occurred_at INTEGER NOT NULL,
  stage TEXT NOT NULL,
  conversation_type TEXT CHECK(conversation_type IN ('private', 'group')),

  error_name TEXT NOT NULL,
  error_message_hash TEXT NOT NULL,

  message_id_hash TEXT,
  sender_id_hash TEXT,
  conversation_id_hash TEXT,

  details TEXT NOT NULL,

  FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE SET NULL,
  FOREIGN KEY (turn_id) REFERENCES agent_turns(id) ON DELETE SET NULL
);

CREATE INDEX idx_event_processing_failures_occurred
  ON event_processing_failures(occurred_at DESC);
CREATE INDEX idx_event_processing_failures_stage
  ON event_processing_failures(stage);
CREATE INDEX idx_event_processing_failures_raw_event
  ON event_processing_failures(raw_event_id) WHERE raw_event_id IS NOT NULL;
CREATE INDEX idx_event_processing_failures_turn
  ON event_processing_failures(turn_id) WHERE turn_id IS NOT NULL;
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
  state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'rejected', 'superseded', 'disabled', 'deleted')),
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

Tracks changes to memory records. `reason` stores redacted operator/source
narrative; exact memory lookup remains in `memory_id` and linked audit rows.

```sql
CREATE TABLE memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,

  change_type TEXT NOT NULL CHECK(change_type IN ('create', 'update', 'approve', 'reject', 'supersede', 'disable', 'delete', 'restore')),

  previous_state TEXT,  -- JSON snapshot
  new_state TEXT,  -- JSON snapshot

  reason TEXT,  -- redacted operator/source narrative
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

### context_traces

Durable/replayable context explanation for `/why` and governance inspection.

`memories`, rejected reasons, filter strings, and injected identity-field labels
are storage-redacted for secret-like and QQ/platform-ID-like substrings by the
repository final guard. Context pack, turn, conversation/group, memory, and
recent-message IDs remain exact local lookup keys.

```sql
CREATE TABLE context_traces (
  id TEXT PRIMARY KEY,  -- ContextPack id
  turn_id TEXT NOT NULL,

  conversation_id TEXT NOT NULL,
  conversation_type TEXT NOT NULL CHECK(conversation_type IN ('private', 'group')),
  group_id TEXT,

  candidate_memory_ids TEXT NOT NULL,  -- JSON array
  selected_memory_ids TEXT NOT NULL,  -- JSON array
  rejected_memories TEXT NOT NULL,  -- JSON array of { memoryId, reason }
  filters_applied TEXT NOT NULL,  -- JSON array
  injected_identity_fields TEXT NOT NULL,  -- JSON array
  recent_message_ids TEXT NOT NULL,  -- JSON array
  token_budget TEXT NOT NULL,  -- JSON object
  memories TEXT NOT NULL,  -- JSON redacted memory metadata

  created_at INTEGER NOT NULL,

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);

CREATE INDEX idx_context_traces_turn ON context_traces(turn_id);
CREATE INDEX idx_context_traces_conversation ON context_traces(conversation_id);
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
  details TEXT,  -- JSON; repository-backed writes redact secret/platform text,
                 -- object keys, and numeric platform-ID fields before storage
  redacted INTEGER NOT NULL DEFAULT 0,

  risk_level TEXT,
  evaluator_decision_id TEXT
);

CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_log_category ON audit_log(category);
CREATE INDEX idx_audit_log_event_type ON audit_log(event_type);
```

---

## Background Jobs

### jobs

Job queue for background workers.

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,

  payload TEXT NOT NULL,  -- JSON
  idempotency_key TEXT,

  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,

  lease_owner TEXT,
  lease_expires_at INTEGER,
  heartbeat_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,

  error TEXT,
  result TEXT  -- JSON; repository-backed writes redact diagnostic
               -- secret/platform text, object keys, and numeric
               -- platform-ID fields before storage
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_scheduled ON jobs(scheduled_at) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_jobs_idempotency_key ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### job_attempts

Every claimed execution attempt is recorded separately so retries remain
auditable and idempotent workers can prove duplicate handling.

```sql
CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,

  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),

  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  heartbeat_at INTEGER,

  error TEXT,
  result TEXT,  -- JSON; repository-backed writes redact diagnostic
                -- secret/platform text, object keys, and numeric
                -- platform-ID fields before storage

  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX idx_job_attempts_job ON job_attempts(job_id, attempt_number);
CREATE INDEX idx_job_attempts_worker ON job_attempts(worker_id);
```

### worker_heartbeats

Workers update a single heartbeat row so operators can see leases and stalled
jobs without reading process logs.

```sql
CREATE TABLE worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  worker_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle', 'running', 'stopping', 'error')),
  current_job_id TEXT,
  heartbeat_at INTEGER NOT NULL,
  details TEXT,  -- JSON; repository-backed writes redact diagnostic
                 -- secret/platform text, object keys, and numeric
                 -- platform-ID fields before storage

  FOREIGN KEY (current_job_id) REFERENCES jobs(id)
);
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
