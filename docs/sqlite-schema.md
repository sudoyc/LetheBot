# SQLite Schema Reference

This document explains the LetheBot SQLite schema and migration strategy.

**Status:** Design reference. The checked-in migration and additive startup
compatibility code are authoritative for exact implemented fields, indexes, and
foreign keys.

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
  source_group_id TEXT NOT NULL DEFAULT '',  -- empty = private/global nickname

  current_display_name TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  trust TEXT NOT NULL CHECK(trust IN ('platform_provided', 'user_set', 'inferred')),

  PRIMARY KEY (canonical_user_id, source_group_id),
  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)
);
```

### nickname_history

Bounded history of display names in the current v1 schema.
History rows follow the same redaction rule as `display_profiles`: raw
credential-shaped or platform-ID-shaped substrings from nicknames/group cards
are not written to `display_name`.

```sql
CREATE TABLE nickname_history (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  source_group_id TEXT NOT NULL DEFAULT '',

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

Append-only normalized event audit trail while rows are retained. Gateway chat
payloads contain the normalized internal event rather than the original OneBot
wire object.

```sql
CREATE TABLE raw_events (
  id TEXT PRIMARY KEY,  -- ULID
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('gateway', 'agent', 'tool', 'worker', 'system')),

  platform TEXT,
  conversation_id TEXT,
  correlation_id TEXT,
  platform_event_id TEXT,

  payload TEXT NOT NULL,  -- JSON

  created_at INTEGER NOT NULL
);

CREATE INDEX idx_raw_events_type ON raw_events(type);
CREATE INDEX idx_raw_events_timestamp ON raw_events(timestamp DESC);
CREATE INDEX idx_raw_events_conversation ON raw_events(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_raw_events_correlation ON raw_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_raw_events_platform_event
  ON raw_events(platform, type, conversation_id, platform_event_id)
  WHERE source = 'gateway' AND platform_event_id IS NOT NULL AND conversation_id IS NOT NULL;
```

For valid OneBot message IDs, the partial unique index makes the first retained
row for `(platform, type, conversation_id, platform_event_id)` canonical.
Rows without a stable platform event ID are intentionally outside this index.

### event_ingress_receipts

Append-only delivery observations for accepted and duplicate gateway claims.
Receipts point to the canonical raw event; they are not separately retained
dedupe tombstones.

```sql
CREATE TABLE event_ingress_receipts (
  id TEXT PRIMARY KEY,
  raw_event_id TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport IN ('http', 'ws')),
  disposition TEXT NOT NULL CHECK(disposition IN ('accepted', 'duplicate')),
  received_at INTEGER NOT NULL,

  FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE CASCADE
);

CREATE INDEX idx_event_ingress_receipts_raw_event
  ON event_ingress_receipts(raw_event_id, received_at);
CREATE INDEX idx_event_ingress_receipts_disposition
  ON event_ingress_receipts(disposition, received_at);
```

Deleting a canonical raw event cascades its receipts and releases the partial
unique key. A later delivery of the same platform event can then be accepted as
a new canonical event.

### event_processing_admissions

One durable downstream admission per accepted raw event. State and timestamp
checks make the pre-handler replay boundary explicit; `reason_code` is a bounded
enum and never copies message text, platform identifiers, or raw errors.

```sql
CREATE TABLE event_processing_admissions (
  raw_event_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'accepted', 'processing', 'completed', 'failed', 'interrupted_review'
  )),
  accepted_at INTEGER NOT NULL,
  processing_started_at INTEGER,
  finished_at INTEGER,
  reason_code TEXT CHECK(reason_code IS NULL OR reason_code IN (
    'handler_failed', 'stale_processing', 'started_evidence', 'invalid_stored_event'
  )),

  FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE CASCADE,

  CHECK(processing_started_at IS NULL OR processing_started_at >= accepted_at),
  CHECK(finished_at IS NULL OR finished_at >= accepted_at),
  CHECK(
    finished_at IS NULL
    OR processing_started_at IS NULL
    OR finished_at >= processing_started_at
  ),
  CHECK(
    (state = 'accepted'
      AND processing_started_at IS NULL
      AND finished_at IS NULL
      AND reason_code IS NULL)
    OR (state = 'processing'
      AND processing_started_at IS NOT NULL
      AND finished_at IS NULL
      AND reason_code IS NULL)
    OR (state = 'completed'
      AND processing_started_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND reason_code IS NULL)
    OR (state = 'failed'
      AND processing_started_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND reason_code IS NOT NULL
      AND reason_code = 'handler_failed')
    OR (state = 'interrupted_review'
      AND finished_at IS NOT NULL
      AND reason_code IS NOT NULL
      AND (
        (processing_started_at IS NOT NULL AND reason_code = 'stale_processing')
        OR (processing_started_at IS NULL AND reason_code IN (
          'started_evidence', 'invalid_stored_event'
        ))
      ))
  )
);

CREATE INDEX idx_event_processing_admissions_state
  ON event_processing_admissions(state, accepted_at);
```

The raw claim, accepted receipt, and `accepted` admission commit in one
transaction. Duplicate ingress creates only another duplicate receipt. Startup
may replay a valid `accepted` row without derived evidence. Under the singleton
startup invariant, it may also re-read a `processing` row in an immediate
transaction and reset it to `accepted` only when the stored event parses
strictly, exactly one accepted receipt matches its transport and `accepted_at`,
no chat/trigger-turn/failure evidence exists, and the guarded compare-and-set
wins. The reset clears `processing_started_at`, `finished_at`, and `reason_code`;
the ordinary claim records the new processing start. Ineligible processing rows
that still remain `processing`, malformed accepted rows, and accepted rows with
derived evidence become `interrupted_review`; a reset that lost to another state
transition is not enqueued and leaves that state untouched. Quarantine
atomically aborts linked nonterminal turns without changing terminal/downstream
evidence. Terminal and legacy rows are not replayed. Deleting the raw event
cascades the admission.

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
CREATE INDEX idx_chat_messages_raw_event ON chat_messages(raw_event_id);
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

## Delayed Attention Tables

Schema v5 stores delayed group-question policy as normalized, source-bound
evidence. Worker payloads contain only a candidate ID; message text stays in the
canonical raw/chat source.

### attention_candidates

```sql
CREATE TABLE attention_candidates (
  id TEXT PRIMARY KEY,
  source_raw_event_id TEXT NOT NULL,
  source_chat_message_id TEXT NOT NULL,
  job_id TEXT NOT NULL,

  conversation_id TEXT NOT NULL,
  conversation_type TEXT NOT NULL CHECK(conversation_type = 'group'),
  group_id TEXT NOT NULL,

  candidate_kind TEXT NOT NULL CHECK(candidate_kind = 'unmentioned_question'),
  policy_version TEXT NOT NULL CHECK(policy_version = 'delayed-attention-v1'),

  observed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= observed_at),
  not_before_at INTEGER NOT NULL CHECK(not_before_at = observed_at + 15000),
  expires_at INTEGER NOT NULL CHECK(expires_at = observed_at + 120000),

  FOREIGN KEY (source_raw_event_id, observed_at, conversation_id)
    REFERENCES raw_events(id, created_at, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (
    source_chat_message_id, source_raw_event_id, conversation_id,
    conversation_type, group_id
  ) REFERENCES chat_messages(
    id, raw_event_id, conversation_id, conversation_type, group_id
  ) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_attention_candidates_source_raw
  ON attention_candidates(source_raw_event_id);
CREATE UNIQUE INDEX idx_attention_candidates_source_chat
  ON attention_candidates(source_chat_message_id);
CREATE UNIQUE INDEX idx_attention_candidates_job
  ON attention_candidates(job_id);
```

The composite source foreign keys bind the candidate to one exact raw/chat
event, local ingress time, conversation, and group. Runtime eligibility also
requires one accepted QQ gateway receipt and a processing admission whose
`received_at` / `accepted_at` equal `raw_events.created_at`. Therefore
`observed_at`, `not_before_at`, and `expires_at` are based on the local ingress
clock rather than `raw_events.timestamp` or `chat_messages.timestamp`, which may
carry a skewed platform clock. The chat row, candidate, and scheduled job commit
atomically after the raw ingress claim.

### attention_decisions

```sql
CREATE TABLE attention_decisions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_attempt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('respond', 'suppress')),
  decided_at INTEGER NOT NULL,

  FOREIGN KEY (candidate_id, job_id)
    REFERENCES attention_candidates(id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (job_attempt_id, job_id)
    REFERENCES job_attempts(id, job_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_attention_decisions_candidate
  ON attention_decisions(candidate_id);
```

There is one terminal decision per candidate. The service inserts it under an
immediate transaction only after `not_before_at` and only when the referenced
attempt owns the job's current, unexpired lease. Existing decisions are replayed
idempotently. A `respond` row is also the serialized reservation counted toward
the per-group limit of two responses in a rolling 10-minute window.

### attention_suppressors

```sql
CREATE TABLE attention_suppressors (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  decision_outcome TEXT NOT NULL DEFAULT 'suppress'
    CHECK(decision_outcome = 'suppress'),
  code TEXT NOT NULL CHECK(code IN (
    'thread_expired', 'human_answer', 'high_traffic',
    'group_budget_exhausted'
  )),
  evidence_chat_message_id TEXT,
  observed_count INTEGER,
  window_ms INTEGER,
  created_at INTEGER NOT NULL,

  FOREIGN KEY (decision_id, candidate_id, decision_outcome)
    REFERENCES attention_decisions(id, candidate_id, outcome) ON DELETE CASCADE,
  FOREIGN KEY (evidence_chat_message_id)
    REFERENCES chat_messages(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_attention_suppressors_decision_code
  ON attention_suppressors(decision_id, code);
```

The table-level CHECK in migration 005 requires evidence shapes by code:
`thread_expired` has no auxiliary evidence; `human_answer` has the explicit
reply chat ID; `high_traffic` records a count of at least six and a 10,000 ms
window; and `group_budget_exhausted` records a count of at least two and a
600,000 ms window. Runtime policy evaluates those suppressors in that order and
uses only later, non-bot QQ ingress from the exact conversation/group.

Retention excludes candidate raw/chat sources while the linked job is
`pending` or `running`. Once it is terminal, deleting the source chat/raw row can
cascade the candidate, its decision, and its suppressors. The `jobs` and
`job_attempts` rows remain because they are referenced from Attention evidence,
not owned by it; deleting a separately retained human-answer chat row may remove
that normalized suppressor evidence without deleting the terminal decision.

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
  -- Repository lifecycle updates cannot transition an existing record back to
  -- proposed; proposed records are created through the governed create path.
  -- Repository approve/reject helpers require current state='proposed'.
  -- Repository updates also enforce the lifecycle state machine before writing
  -- state/revision/audit rows.
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

Repository retrieval/search predicates on `state`, non-secret sensitivity, and
private/group visibility before applying `LIMIT` or FTS rank limiting. This
prevents inaccessible high-rank rows from consuming the bounded result window
ahead of visible memories.

ContextBuilder reuses this FTS table through the same context-filtered repository
routes for bounded current-message, resolved-quote, and recent-thread queries.
It merges those rows in memory with scoped fallback results; it does not persist
query text, FTS syntax, matched terms, or BM25 scores. Content-free selection
enums and a 1-based retrieval rank are stored only as optional fields on each
selected-memory object in the existing `context_traces.memories` JSON array, so
query-aware retrieval requires no schema migration.

### memory_sources

Links memory to typed source evidence.

```sql
CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('raw_event', 'chat_message', 'tool_output', 'worker_extraction', 'user_command')),
  source_id TEXT NOT NULL,
  source_timestamp INTEGER NOT NULL,
  extracted_by TEXT,
  resolution_state TEXT NOT NULL DEFAULT 'legacy_unresolved'
    CHECK(resolution_state IN ('internal', 'external', 'legacy_unresolved')),
  raw_event_id TEXT,
  chat_message_id TEXT,
  tool_call_id TEXT,
  job_id TEXT,
  job_attempt_id TEXT,

  PRIMARY KEY (memory_id, source_id),
  FOREIGN KEY (memory_id) REFERENCES memory_records(id),
  FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (chat_message_id) REFERENCES chat_messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT,
  FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE RESTRICT,

  CHECK(
    (
      resolution_state = 'legacy_unresolved'
      AND raw_event_id IS NULL AND chat_message_id IS NULL
      AND tool_call_id IS NULL AND job_id IS NULL AND job_attempt_id IS NULL
    )
    OR (
      resolution_state = 'external' AND source_type = 'user_command'
      AND raw_event_id IS NULL AND chat_message_id IS NULL
      AND tool_call_id IS NULL AND job_id IS NULL AND job_attempt_id IS NULL
    )
    OR (
      resolution_state = 'internal'
      AND (
        (source_type = 'raw_event' AND raw_event_id IS NOT NULL
          AND chat_message_id IS NULL AND tool_call_id IS NULL
          AND job_id IS NULL AND job_attempt_id IS NULL)
        OR (source_type = 'chat_message' AND raw_event_id IS NULL
          AND chat_message_id IS NOT NULL AND tool_call_id IS NULL
          AND job_id IS NULL AND job_attempt_id IS NULL)
        OR (source_type = 'tool_output' AND raw_event_id IS NULL
          AND chat_message_id IS NULL AND tool_call_id IS NOT NULL
          AND job_id IS NULL AND job_attempt_id IS NULL)
        OR (source_type = 'worker_extraction' AND raw_event_id IS NULL
          AND chat_message_id IS NULL AND tool_call_id IS NULL
          AND ((job_id IS NOT NULL AND job_attempt_id IS NULL)
            OR (job_id IS NULL AND job_attempt_id IS NOT NULL)))
      )
    )
  )
);

CREATE INDEX idx_memory_sources_memory ON memory_sources(memory_id);
CREATE INDEX idx_memory_sources_source ON memory_sources(source_type, source_id);
CREATE INDEX idx_memory_sources_resolution
  ON memory_sources(resolution_state, source_type, source_id, memory_id);
CREATE INDEX idx_memory_sources_raw_event
  ON memory_sources(raw_event_id) WHERE raw_event_id IS NOT NULL;
CREATE INDEX idx_memory_sources_chat_message
  ON memory_sources(chat_message_id) WHERE chat_message_id IS NOT NULL;
CREATE INDEX idx_memory_sources_tool_call
  ON memory_sources(tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX idx_memory_sources_job
  ON memory_sources(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_memory_sources_job_attempt
  ON memory_sources(job_attempt_id) WHERE job_attempt_id IS NOT NULL;
```

For new writes, `internal` means the matching canonical FK column is the source
identity: raw event, chat message, successful tool call, or exactly one completed
extraction job/attempt. A worker source additionally requires a separate
canonical raw/chat source on the same memory, referenced in structured job
evidence. `external` is valid only for an explicitly external `user_command`
created in `admin_cli` context. `legacy_unresolved` is compatibility state only
and carries no canonical FK.

The repository resolves all sources inside the create transaction. Missing,
orphaned, wrong-table, unsuccessful-tool, uncompleted/unlinked-worker, invalid
external, duplicate, blank, or non-finite source metadata leaves no memory,
source, revision, audit, or FTS row. `source_context` does not supply identity
and no fabricated fallback is used. Retention uses the canonical FK columns for
internal rows and consults `source_type` / `source_id` aliases only for
`legacy_unresolved` rows.

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

For current repository writes, `memory_records.evaluator_decision_id` is the
latest mutation's policy/evaluator identity. Each revision and matching audit
carry that mutation's same ID. A lifecycle writer without an explicit evaluator
decision uses `policy:l0:<target-state>:<memory-id>` and never copies the prior
record value. Revision 1's decision column and `new_state` snapshot plus the
`memory.create` audit remain the immutable creation-authority evidence used for
deterministic extraction retry. These memory/audit columns also hold local
policy IDs and therefore are not foreign keys to `evaluator_decisions` in schema
v2.

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
CREATE INDEX idx_agent_turns_trigger_event ON agent_turns(trigger_event_id);
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
  group_id TEXT,  -- gateway-normalized qq-group-<digits>, not stripped numeric suffix

  candidate_memory_ids TEXT NOT NULL,  -- JSON array
  selected_memory_ids TEXT NOT NULL,  -- JSON array
  rejected_memories TEXT NOT NULL,  -- JSON array of { memoryId, reason }
  filters_applied TEXT NOT NULL,  -- JSON array
  injected_identity_fields TEXT NOT NULL,  -- JSON array
  recent_message_ids TEXT NOT NULL,  -- JSON array
  token_budget TEXT NOT NULL,  -- JSON object; includes content-free referenceTrace when present
  memories TEXT NOT NULL,  -- JSON redacted selected-memory metadata + optional selection evidence

  created_at INTEGER NOT NULL,

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);

CREATE INDEX idx_context_traces_turn ON context_traces(turn_id);
CREATE INDEX idx_context_traces_conversation ON context_traces(conversation_id);
```

No schema migration is required for message-reference evidence. The repository
stores it inside `token_budget.referenceTrace` with the pack-local
`currentMessageRef`, per-selected-message `{messageRef, speakerRef, isCurrent}`
tuples, and the optional resolved/unresolved reply relation. It deliberately
omits message text, display labels, sender IDs, and canonical/platform IDs.
Query-aware selected-memory evidence likewise needs no migration: each selected
memory may carry an allowlisted `selection` object inside `memories`. The object
contains only query-source/retrieval/scope/reason enums and a positive 1-based
rank; the repository rejects malformed or reordered evidence before writing.

### evaluator_decisions

Structured evaluator evidence. Every row is owned by exactly one conversation
turn or durable background job attempt. Existing v1 rows migrate as turn-owned;
automatic extraction decisions use the running job-attempt owner and commit with
their memory or rejection-audit effect in one transaction. Repository policy
also requires that owner to be the exact current attempt number and matching
worker/lease owner with `lease_expires_at` strictly later than commit time; the
authority is rechecked after the synchronous effect. Social action persistence stores the evaluator request/result
identity before the linked action decision in the same transaction. Stable
request/decision IDs, evaluator version, actor/context, source-event IDs,
timestamps, and the reviewed tool name for tool-domain rows remain exact lookup
evidence; only the
free-text reason is storage-redacted and limited to 2,048 characters including
the truncation marker. The bounded request context and proposed payload are not
copied into this ledger.

```sql
CREATE TABLE evaluator_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('tool', 'memory', 'social')),
  turn_id TEXT,
  job_attempt_id TEXT,

  decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject', 'downgrade', 'propose')),
  reason TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'prohibited')),

  evaluator_version TEXT NOT NULL,
  model_invocation_id TEXT,
  tool_name TEXT,
  actor_user_id TEXT,
  actor_class TEXT NOT NULL CHECK(actor_class IN (
    'owner', 'admin', 'trusted_user', 'user', 'group_admin',
    'system_worker', 'evaluator', 'tool'
  )),
  invocation_context TEXT NOT NULL CHECK(invocation_context IN (
    'private_chat', 'group_chat', 'admin_cli', 'background_worker', 'internal'
  )),
  source_event_ids TEXT NOT NULL,  -- JSON array of exact internal event IDs

  request_created_at INTEGER NOT NULL,
  decided_at INTEGER NOT NULL,

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id) ON DELETE RESTRICT,
  FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY (model_invocation_id) REFERENCES model_invocations(id) ON DELETE RESTRICT,

  CHECK(
    (turn_id IS NOT NULL AND job_attempt_id IS NULL)
    OR (turn_id IS NULL AND job_attempt_id IS NOT NULL)
  )
);

CREATE INDEX idx_evaluator_decisions_turn ON evaluator_decisions(turn_id);
CREATE INDEX idx_evaluator_decisions_job_attempt ON evaluator_decisions(job_attempt_id);
CREATE UNIQUE INDEX idx_evaluator_decisions_request ON evaluator_decisions(request_id);
CREATE UNIQUE INDEX idx_evaluator_decisions_model_invocation
  ON evaluator_decisions(model_invocation_id)
  WHERE model_invocation_id IS NOT NULL;
```

`model_invocation_id` is nullable for stub, local-policy, and migrated legacy
decisions. A model-backed writer accepts it only after verifying a completed
`purpose='evaluator'` invocation with the exact request/domain/owner, ordered
source rows, provider/model/prompt identity, and chronology. The unique FK makes
the relation one invocation to at most one decision and prevents deletion of
Provider evidence still used by a decision. A completed orphan invocation is
valid call evidence after downstream persistence failure, but never decision or
execution authority.

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
  evaluator_decision_id TEXT,
  execution_binding TEXT,

  actions TEXT NOT NULL,  -- JSON array of ActionPlan
  reasons TEXT,  -- JSON array
  suppressors TEXT,  -- JSON array

  created_at INTEGER NOT NULL,

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id),
  FOREIGN KEY (evaluator_decision_id) REFERENCES evaluator_decisions(id)
);

CREATE INDEX idx_action_decisions_turn ON action_decisions(turn_id);
CREATE INDEX idx_action_decisions_evaluator ON action_decisions(evaluator_decision_id);
```

Non-evaluated action decisions keep `evaluator_decision_id` null. For evaluated
social actions, the evaluator row, action row, and `agent_turns.action_decision_id`
link are committed or rolled back together.
Repository persistence also verifies that the request/result domains are
`social`, evaluator outcome metadata matches the action row, the source list
contains the linked turn's trigger event, and every claimed source event exists.
Passing evidence cannot be `prohibited`; its non-`silent_store` final plan must
equal the action reconstructed from the reviewed proposal and evaluator result.
Downgrade results require a matching source action type. A valid review may end
as an all-`silent_store` plan only for deterministic local suppression such as a
cooldown.

`execution_binding` is a nullable, versioned HMAC over the detached unredacted
`ActionDecision` envelope plus the exact linked evaluator outcome and durable
request ID, evaluator version, actor/context, source-event JSON, request/decision
timestamps, domain, turn, risk, confidence, redacted reason, and the turn's
conversation/trigger source. The key is random and process-local to the creating
`ActionRepository`; neither the key nor the unredacted payload is persisted.
Immediately before execution, the repository recomputes the binding and
compares the persisted scalars, freshly redacted action/reason/suppressor JSON,
linked evaluator authority, bound turn source, and
`agent_turns.action_decision_id`. The verified turn source is carried through
later awaits rather than reloaded for memory provenance. Durable `actions`
remain inspection evidence, not an executable payload. Superseded decisions,
compatibility rows with null bindings, and rows opened under a new
process/repository key fail closed for execution while remaining inspectable. A
future restart replay design requires a separate delivery policy and protected
payload/key design; this column does not authorize replay.

These foreign keys are restrictive. An evaluated trace must be deleted in this
order when an explicit purge is added: `action_executions`, `action_decisions`,
`evaluator_decisions`, then `agent_turns`. This prevents approval evidence from
being silently removed while a decision or execution still points to it.

### action_executions

Results of executing actions.
Repository-backed execution creation redacts downgrade reasons, diagnostic
codes/messages, and audit entries before both storage and the returned
`ActionExecutionResult`; exact executed message/memory/job IDs remain local lookup
keys.

```sql
CREATE TABLE action_executions (
  id TEXT PRIMARY KEY,
  action_decision_id TEXT NOT NULL,
  action_type TEXT NOT NULL,

  status TEXT NOT NULL CHECK(status IN ('success', 'downgraded', 'failed', 'rejected')),

  executed_message_id TEXT,
  executed_memory_id TEXT,
  executed_job_id TEXT,
  downgraded_from TEXT,
  downgraded_reason TEXT,

  error_code TEXT,
  error_message TEXT,

  audit_level TEXT NOT NULL CHECK(audit_level IN ('none', 'summary', 'redacted_full', 'full')),
  audit_entry TEXT,

  executed_at INTEGER NOT NULL,

  FOREIGN KEY (action_decision_id) REFERENCES action_decisions(id),
  FOREIGN KEY (executed_memory_id) REFERENCES memory_records(id),
  FOREIGN KEY (executed_job_id) REFERENCES jobs(id)
);

CREATE INDEX idx_action_executions_decision ON action_executions(action_decision_id);
CREATE INDEX idx_action_executions_memory ON action_executions(executed_memory_id);
CREATE INDEX idx_action_executions_job ON action_executions(executed_job_id);
```

---

## Tool Tables

### tool_calls

Tool invocation records.

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  evaluator_decision_id TEXT,
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

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id),
  FOREIGN KEY (evaluator_decision_id) REFERENCES evaluator_decisions(id) ON DELETE RESTRICT
);

CREATE INDEX idx_tool_calls_turn ON tool_calls(turn_id);
CREATE INDEX idx_tool_calls_tool_name ON tool_calls(tool_name);
CREATE INDEX idx_tool_calls_evaluator ON tool_calls(evaluator_decision_id);
```

Bypass calls keep `evaluator_decision_id` null. For required calls with a valid
evaluator result, `EvaluatorDecisionRepository` validates the request/result
identity, turn trigger source, referenced raw events, timestamps, confidence,
and finite constraints before inserting the generic `domain='tool'` evaluator
row. It stores only a redacted 2,048-character reason and structural metadata;
tool input, proposed reason, and context summary are not copied into the ledger.
The terminal tool-call row and tool audit carry the decision ID. The restrictive
tool-call foreign key prevents deletion of evaluator authority that remains in
the execution ledger.

For trusted local prepared memory effects, the memory mutation and successful
terminal evidence are one same-handle SQLite transaction: the prepared effect,
success `tool_calls` insert, and `tool.executed` audit either all commit or all
roll back. After rollback, PiAdapter attempts the error `tool_calls` row and
`tool.failed` audit as a second transaction, so SQLite never intentionally keeps
only one half of that failure pair. The evaluator decision is intentionally
outside these transactions and remains durable as evidence of the review. This
contract does not apply transactional rollback to external side effects.

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
                 -- object keys, and numeric platform-ID fields before storage.
                 -- Tool audits include runtime groupId when group policy used it.
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

#### Group summary frozen-window payload

Schema v6 needs no additional source-window table. The application stores this
typed payload in `jobs.payload` for durable group summaries:

```typescript
interface GroupSummaryTaskPayload {
  conversationId: string;
  conversationType: 'group';
  groupId: string;
  windowVersion: 1;
  sourceChatMessageIds: string[]; // ordered, unique, 1..50 post-budget chat IDs
  candidateCount: number;         // eligible pre-budget candidate count
}
```

`candidateCount` is bounded telemetry. Scope, `windowVersion`, and the ordered
source IDs are the immutable window contract. Mutable message/time ranges and
caller-supplied scope/window fields do not authorize group execution.

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

The repository treats an attempt as active authority only while both job and
attempt are `running`, `jobs.attempts` equals the attempt number,
`jobs.lease_owner` equals the attempt worker, and `lease_expires_at` is strictly
in the future. Completion, failure, renewal, and automatic-extraction evaluator
effects use that same predicate inside immediate transactions. An expired lease
cannot be revived by a late heartbeat, and a stale terminal call is a no-op.

### group_summary_policies

Schema v6 stores one explicit policy row per group that has transitioned away
from the default. Absence means disabled. `generation` advances on every actual
enable/disable transition. An enabled row has a non-null `eligible_after`; a
disabled row has none.

```sql
CREATE TABLE group_summary_policies (
  group_id TEXT PRIMARY KEY CHECK(
    typeof(group_id) = 'text'
    AND length(group_id) > 0
    AND group_id = trim(group_id)
  ),
  state TEXT NOT NULL CHECK(state IN ('enabled', 'disabled')),
  generation INTEGER NOT NULL CHECK(
    typeof(generation) = 'integer' AND generation >= 1
  ),
  eligible_after INTEGER CHECK(
    eligible_after IS NULL
    OR (typeof(eligible_after) = 'integer' AND eligible_after >= 0)
  ),
  created_at INTEGER NOT NULL CHECK(
    typeof(created_at) = 'integer' AND created_at >= 0
  ),
  updated_at INTEGER NOT NULL CHECK(
    typeof(updated_at) = 'integer' AND updated_at >= created_at
  ),
  CHECK(
    (state = 'enabled' AND eligible_after IS NOT NULL)
    OR (state = 'disabled' AND eligible_after IS NULL)
  )
);
```

The repository chooses each persisted transition timestamp as an exclusive
logical boundary. Enable/re-enable advances beyond the requested wall clock,
the prior policy timestamp, every persisted exact-group chat ingress, and every
normalized exact-group QQ raw ingress still awaiting a `chat_messages` row.
Disable advances beyond the created/updated timestamps of every bound pending
summary job when representable and saturates at `Number.MAX_SAFE_INTEGER`.
Therefore wall-clock rollback or hostile future timestamps cannot prevent
disable, admit pre-enable/pending-normalization sources, or violate
`canceled_at >= created_at`. Re-enable still fails closed when no exclusive
safe-integer boundary remains. Each actual change and exact pending-job
cancellation commit in the same immediate transaction as the
`group.summary_policy_changed` audit row.

Policy audit details store redacted display projections of group/source values
plus a purpose-bound SHA-256 `groupIdHash` for exact-group correlation. The
canonical QQ group ID is not an audit display key; raw policy-table scope remains
local durable state. Audit ID generation is independent of the logical policy
timestamp, so a valid future cancellation clock is not constrained by ULID's
48-bit time field.

### group_summary_job_bindings

Every durable group summary job is bound to the exact group, conversation,
generation, and eligibility epoch that authorized enqueue. Private summary jobs
have no binding. The binding stores authorization; the exact ordered source set
stays in typed `jobs.payload`, so this contract does not require schema v7.

```sql
CREATE TABLE group_summary_job_bindings (
  job_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL CHECK(
    typeof(conversation_id) = 'text'
    AND length(conversation_id) > 0
    AND conversation_id = trim(conversation_id)
  ),
  generation INTEGER NOT NULL CHECK(
    typeof(generation) = 'integer' AND generation >= 1
  ),
  eligible_after INTEGER NOT NULL CHECK(
    typeof(eligible_after) = 'integer' AND eligible_after >= 0
  ),
  created_at INTEGER NOT NULL CHECK(
    typeof(created_at) = 'integer' AND created_at >= eligible_after
  ),
  canceled_at INTEGER CHECK(
    canceled_at IS NULL
    OR (typeof(canceled_at) = 'integer' AND canceled_at >= created_at)
  ),
  cancellation_code TEXT CHECK(
    cancellation_code IS NULL
    OR cancellation_code = 'group_summary_policy_disabled'
  ),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT,
  FOREIGN KEY (group_id) REFERENCES group_summary_policies(group_id) ON DELETE RESTRICT,
  CHECK(
    (canceled_at IS NULL AND cancellation_code IS NULL)
    OR (canceled_at IS NOT NULL AND cancellation_code IS NOT NULL)
  )
);

CREATE INDEX idx_group_summary_job_bindings_policy
  ON group_summary_job_bindings(group_id, generation, job_id);
CREATE INDEX idx_group_summary_job_bindings_active
  ON group_summary_job_bindings(group_id, job_id)
  WHERE canceled_at IS NULL;
```

The repository binds only pending `summary` jobs under the current enabled
generation. Execution requires the same binding plus the exact active,
unexpired job attempt. Disable marks exact-group pending jobs terminal failed
and pairs each with bounded cancellation evidence; running jobs fail their next
worker fence and are terminalized by the non-retryable background-task boundary.
Binding and policy foreign keys deliberately restrict deletion so job authority
evidence cannot be orphaned.

Group window idempotency is derived from version, exact scope, policy generation,
and ordered source IDs. Every well-formed frozen window in the applicable policy
epoch, including a terminally failed one, is skipped by later planning so
exhausted work cannot block newer eligible sources or be reported as newly
scheduled. Retention uses malformed-safe JSON1 traversal to pin the chat rows
and their raw events only while a frozen summary job is `pending` or `running`;
completed and failed payload-only jobs release that pin, while final internal
`memory_sources` retain completed-memory provenance through canonical foreign
keys.

### model_contexts, model_invocations, model_invocation_sources

`model_contexts` remains the privacy-minimized context trace for summary jobs.
Schema v3 generalized the Provider-call ledger so `model_invocations` could also
record evaluator calls without inventing a summary context. Schema v4 added one
correction call; schemas v5 and v6 leave that ledger shape unchanged:

```sql
CREATE TABLE model_invocations (
  id TEXT PRIMARY KEY,
  turn_id TEXT,
  job_attempt_id TEXT,
  context_id TEXT,
  purpose TEXT NOT NULL CHECK(purpose IN ('summary', 'evaluator')),

  evaluator_request_id TEXT,
  evaluator_domain TEXT CHECK(
    evaluator_domain IS NULL OR evaluator_domain IN ('tool', 'memory', 'social')
  ),
  prompt_version TEXT,
  call_number INTEGER NOT NULL CHECK(call_number >= 1),

  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'aborted')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_total INTEGER,
  response_sha256 TEXT,
  response_bytes INTEGER,
  error_code TEXT,

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id) ON DELETE RESTRICT,
  FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, job_attempt_id, purpose)
    REFERENCES model_contexts(id, job_attempt_id, purpose) ON DELETE RESTRICT
);

CREATE TABLE model_invocation_sources (
  model_invocation_id TEXT NOT NULL,
  raw_event_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL,
  PRIMARY KEY (model_invocation_id, raw_event_id),
  UNIQUE (model_invocation_id, source_ordinal),
  FOREIGN KEY (model_invocation_id) REFERENCES model_invocations(id) ON DELETE CASCADE,
  FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_model_invocations_summary_call
  ON model_invocations(job_attempt_id, call_number)
  WHERE purpose = 'summary';
CREATE UNIQUE INDEX idx_model_invocations_evaluator_request_call
  ON model_invocations(evaluator_request_id, call_number)
  WHERE purpose = 'evaluator';
```

The migration's CHECK constraints require exactly one owner. Summary rows are
job-attempt-owned, retain their context, have no evaluator metadata, and keep a
unique call number per attempt. Evaluator rows have no context, use call number
1 or 2, require request/domain/prompt metadata, and are unique by evaluator
request plus call number;
tool/social rows must be turn-owned, while memory may be turn- or extraction-
attempt-owned. Running rows have no terminal payload. Completed rows require
token counts and a SHA-256/byte-count response digest but no error code. Failed
or aborted rows require only a bounded error code and terminal timestamp. Ordered
source rows must exactly equal the evaluator request's raw-event sources before a
decision can link the invocation. Turn and job-attempt terminal triggers abort
any still-running owned invocation.
Repository start/binding checks allow call 2 only when the same request's call 1
has already failed with `invalid_structured_output`, completed no later than call
2 starts, and has the same domain, owner, provider, model, prompt version, and
ordered sources. No call number above 2 is valid for evaluator rows.

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

### Current Migration Set

1. `001_initial_schema.sql` establishes the v1 application tables and migration
   ledger; `002_evaluator_authority_ownership.sql` upgrades evaluator ownership
   to the turn/job-attempt XOR contract; `003_evaluator_model_invocations.sql`
   adds source-bound evaluator Provider calls and the decision link;
   `004_evaluator_correction_attempts.sql` adds the separately ledgered second
   call without rewriting v3 history; `005_delayed_attention.sql` adds the
   source-bound candidate, decision, and suppressor tables for delayed group
   Attention; and `006_group_summary_policy.sql` adds exact-group summary policy
   epochs and durable job bindings.
2. Startup validates the complete contiguous migration set before DB writes.
   Fresh/legacy and v1-v5 upgrades apply atomically and finish with ledger
   `[1,2,3,4,5,6]`; an already-current v6 database receives a validation-only,
   zero-write pass.
3. Current startup migration also applies additive compatibility patches for
   existing local v1 DBs, including `action_executions.executed_memory_id` and
   `action_executions.executed_job_id`.
4. The same compatibility path adds memory-source resolution/FK columns and
   indexes, then backfills only unambiguous usable internal evidence. Exact raw
   and chat IDs, unique historical chat-message aliases, successful tool calls,
   and semantically valid completed extraction job/attempt links may be
   resolved. Missing, ambiguous, unsuccessful, incomplete, unrelated, opaque,
   or otherwise unsafe rows remain `legacy_unresolved`; historical
   `user_command` rows are never silently relabeled `external`.
5. The TypeScript migration runner, not the SQL files, owns both ledger writes.
   It distinguishes absent, valid-empty, and versioned metadata; validates the
   exact ledger shape and row types; and rejects malformed or future metadata
   before compatibility writes.
6. Pre-patches, `001`, post-patches, and each missing ordered migration plus
   ledger insertion run in one `IMMEDIATE` transaction. Existing ledger rows
   keep their original `applied_at`; any failure rolls the entire migration back
   to the exact input.
7. Before commit, the runner builds clean in-memory schemas from the applicable
   migration prefix through final v6 and compares the database's complete required table
   columns, types, nullability, compatible defaults, primary keys, foreign keys,
   indexes, supported CHECK shapes, virtual table, and migration-owned trigger.
   It also requires
   `PRAGMA foreign_key_check` to be empty. Incompatible same-name legacy objects
   fail with `incompatible-schema` and the transaction rolls back; unrelated
   application-external tables are preserved.
8. Exact early-v1 CHECK shapes that predate rejected memory state and
   approve/reject revision types, plus the early `memory_sources` shape without
   its canonical source-link CHECK, are rebuilt from the current table
   definitions inside the migration transaction. The rebuild preserves rowids,
   rows, indexes, triggers, and external-content FTS linkage. Foreign keys are
   disabled only for that connection while the tables are replaced, restored
   afterward, and explicitly checked before commit. Eligibility requires the
   complete normalized legacy `CREATE TABLE` definition to match, so extra
   UNIQUE/STRICT/COLLATE/conflict/deferrable semantics and unknown CHECK drift
   are not treated as legacy compatibility. When `memory_fts` itself was
   absent, the migration creates it and runs the FTS5 external-content rebuild
   before v1 is accepted, so existing memory rows remain searchable.

### Future Migrations

- Add new fields with `ALTER TABLE ... ADD COLUMN`
- Never delete columns (mark deprecated, filter in queries)
- Add new tables freely
- Update CHECK constraints carefully (may require table rebuild)
- This release targets schema v6 and accepts v1-v5 for migration. An older v5
  runtime intentionally rejects v6, so application activation must retain and
  restore its pre-upgrade SQLite snapshot before restarting that prior release.

---

## Notes

- **INTEGER for timestamps:** SQLite stores timestamps as Unix epoch integers (milliseconds)
- **TEXT PRIMARY KEY:** ULIDs are text, not integers
- **JSON columns:** Store complex data as TEXT containing JSON (validated at app layer)
- **FTS5:** Full-text search for memory content (SQLite compiled with FTS5 support)
- **Indexes:** Partial indexes (`WHERE` clause) for common queries
- **Foreign keys:** Enabled with `PRAGMA foreign_keys = ON;`
- **WAL mode:** Enable with `PRAGMA journal_mode = WAL;` for concurrency
