-- Migration 001: Initial Schema
-- Phase C: Storage Foundation
-- Created: 2026-06-27

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- ============================================================
-- Identity & Platform Mapping
-- ============================================================

CREATE TABLE IF NOT EXISTS canonical_users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_accounts (
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

CREATE INDEX IF NOT EXISTS idx_platform_accounts_canonical ON platform_accounts(canonical_user_id);

CREATE TABLE IF NOT EXISTS platform_groups (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_group_id TEXT NOT NULL,

  group_name TEXT,

  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,

  UNIQUE(platform, platform_group_id)
);

CREATE TABLE IF NOT EXISTS display_profiles (
  canonical_user_id TEXT NOT NULL,
  source_group_id TEXT NOT NULL DEFAULT '',

  current_display_name TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  trust TEXT NOT NULL CHECK(trust IN ('platform_provided', 'user_set', 'inferred')),

  PRIMARY KEY (canonical_user_id, source_group_id),
  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)
);

CREATE TABLE IF NOT EXISTS nickname_history (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  source_group_id TEXT NOT NULL DEFAULT '',

  display_name TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  observed_until INTEGER,

  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)
);

CREATE INDEX IF NOT EXISTS idx_nickname_history_user ON nickname_history(canonical_user_id);

CREATE TABLE IF NOT EXISTS privacy_preferences (
  canonical_user_id TEXT NOT NULL,
  preference_type TEXT NOT NULL CHECK(preference_type IN ('proactive_dm', 'memory_association')),

  state TEXT NOT NULL CHECK(state IN ('opted_in', 'opted_out')),
  reason TEXT,

  updated_by_user_id TEXT,
  updated_by_actor_class TEXT NOT NULL,
  updated_by_context TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (canonical_user_id, preference_type),
  FOREIGN KEY (canonical_user_id) REFERENCES canonical_users(id)
);

CREATE INDEX IF NOT EXISTS idx_privacy_preferences_state
  ON privacy_preferences(preference_type, state);

-- ============================================================
-- Event Store
-- ============================================================

CREATE TABLE IF NOT EXISTS raw_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('gateway', 'agent', 'tool', 'worker', 'system')),

  platform TEXT,
  conversation_id TEXT,
  correlation_id TEXT,
  platform_event_id TEXT,

  payload TEXT NOT NULL,

  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_events_type ON raw_events(type);
CREATE INDEX IF NOT EXISTS idx_raw_events_timestamp ON raw_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_events_conversation ON raw_events(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_events_correlation ON raw_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_platform_event
  ON raw_events(platform, type, conversation_id, platform_event_id)
  WHERE source = 'gateway' AND platform_event_id IS NOT NULL AND conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_ingress_receipts (
  id TEXT PRIMARY KEY,
  raw_event_id TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport IN ('http', 'ws')),
  disposition TEXT NOT NULL CHECK(disposition IN ('accepted', 'duplicate')),
  received_at INTEGER NOT NULL,

  FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_ingress_receipts_raw_event
  ON event_ingress_receipts(raw_event_id, received_at);
CREATE INDEX IF NOT EXISTS idx_event_ingress_receipts_disposition
  ON event_ingress_receipts(disposition, received_at);

CREATE TABLE IF NOT EXISTS event_processing_admissions (
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

CREATE INDEX IF NOT EXISTS idx_event_processing_admissions_state
  ON event_processing_admissions(state, accepted_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  raw_event_id TEXT NOT NULL,

  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  conversation_type TEXT NOT NULL CHECK(conversation_type IN ('private', 'group')),

  group_id TEXT,
  sender_id TEXT NOT NULL,
  sender_role TEXT,

  text TEXT,
  has_media INTEGER NOT NULL DEFAULT 0,
  has_quote INTEGER NOT NULL DEFAULT 0,

  mentions_bot INTEGER NOT NULL DEFAULT 0,
  reply_to_message_id TEXT,

  timestamp INTEGER NOT NULL,

  FOREIGN KEY (raw_event_id) REFERENCES raw_events(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_raw_event ON chat_messages(raw_event_id);

CREATE TABLE IF NOT EXISTS event_processing_failures (
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

CREATE INDEX IF NOT EXISTS idx_event_processing_failures_occurred
  ON event_processing_failures(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_processing_failures_stage
  ON event_processing_failures(stage);
CREATE INDEX IF NOT EXISTS idx_event_processing_failures_raw_event
  ON event_processing_failures(raw_event_id) WHERE raw_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_processing_failures_turn
  ON event_processing_failures(turn_id) WHERE turn_id IS NOT NULL;

-- ============================================================
-- Memory System
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_records (
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

CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(scope);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_records(canonical_user_id) WHERE canonical_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_group ON memory_records(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_state ON memory_records(state);
CREATE INDEX IF NOT EXISTS idx_memory_visibility ON memory_records(visibility);
CREATE INDEX IF NOT EXISTS idx_memory_active_user ON memory_records(state, canonical_user_id) WHERE state = 'active';

-- Full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title,
  content,
  content=memory_records,
  content_rowid=rowid
);

CREATE TABLE IF NOT EXISTS memory_sources (
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
      AND raw_event_id IS NULL
      AND chat_message_id IS NULL
      AND tool_call_id IS NULL
      AND job_id IS NULL
      AND job_attempt_id IS NULL
    )
    OR (
      resolution_state = 'external'
      AND source_type = 'user_command'
      AND raw_event_id IS NULL
      AND chat_message_id IS NULL
      AND tool_call_id IS NULL
      AND job_id IS NULL
      AND job_attempt_id IS NULL
    )
    OR (
      resolution_state = 'internal'
      AND (
        (
          source_type = 'raw_event'
          AND raw_event_id IS NOT NULL
          AND chat_message_id IS NULL
          AND tool_call_id IS NULL
          AND job_id IS NULL
          AND job_attempt_id IS NULL
        )
        OR (
          source_type = 'chat_message'
          AND raw_event_id IS NULL
          AND chat_message_id IS NOT NULL
          AND tool_call_id IS NULL
          AND job_id IS NULL
          AND job_attempt_id IS NULL
        )
        OR (
          source_type = 'tool_output'
          AND raw_event_id IS NULL
          AND chat_message_id IS NULL
          AND tool_call_id IS NOT NULL
          AND job_id IS NULL
          AND job_attempt_id IS NULL
        )
        OR (
          source_type = 'worker_extraction'
          AND raw_event_id IS NULL
          AND chat_message_id IS NULL
          AND tool_call_id IS NULL
          AND (
            (job_id IS NOT NULL AND job_attempt_id IS NULL)
            OR (job_id IS NULL AND job_attempt_id IS NOT NULL)
          )
        )
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_memory_sources_memory ON memory_sources(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_sources_source ON memory_sources(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_sources_resolution
  ON memory_sources(resolution_state, source_type, source_id, memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_sources_raw_event
  ON memory_sources(raw_event_id) WHERE raw_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_sources_chat_message
  ON memory_sources(chat_message_id) WHERE chat_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_sources_tool_call
  ON memory_sources(tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_sources_job
  ON memory_sources(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_sources_job_attempt
  ON memory_sources(job_attempt_id) WHERE job_attempt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,

  change_type TEXT NOT NULL CHECK(change_type IN ('create', 'update', 'approve', 'reject', 'supersede', 'disable', 'delete', 'restore')),

  previous_state TEXT,
  new_state TEXT,

  reason TEXT,
  actor TEXT NOT NULL,
  evaluator_decision_id TEXT,

  created_at INTEGER NOT NULL,

  FOREIGN KEY (memory_id) REFERENCES memory_records(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id);

-- ============================================================
-- Agent Turns
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_turns (
  id TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_agent_turns_conversation ON agent_turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_turns_status ON agent_turns(status);
CREATE INDEX IF NOT EXISTS idx_agent_turns_started ON agent_turns(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_turns_trigger_event ON agent_turns(trigger_event_id);

CREATE TABLE IF NOT EXISTS context_traces (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,

  conversation_id TEXT NOT NULL,
  conversation_type TEXT NOT NULL CHECK(conversation_type IN ('private', 'group')),
  group_id TEXT,

  candidate_memory_ids TEXT NOT NULL,
  selected_memory_ids TEXT NOT NULL,
  rejected_memories TEXT NOT NULL,
  filters_applied TEXT NOT NULL,
  injected_identity_fields TEXT NOT NULL,
  recent_message_ids TEXT NOT NULL,
  token_budget TEXT NOT NULL,
  memories TEXT NOT NULL,

  created_at INTEGER NOT NULL,

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);

CREATE INDEX IF NOT EXISTS idx_context_traces_turn ON context_traces(turn_id);
CREATE INDEX IF NOT EXISTS idx_context_traces_conversation ON context_traces(conversation_id);

CREATE TABLE IF NOT EXISTS evaluator_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('tool', 'memory', 'social')),
  turn_id TEXT NOT NULL,

  decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject', 'downgrade', 'propose')),
  reason TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'prohibited')),

  evaluator_version TEXT NOT NULL,
  tool_name TEXT,
  actor_user_id TEXT,
  actor_class TEXT NOT NULL CHECK(actor_class IN (
    'owner', 'admin', 'trusted_user', 'user', 'group_admin',
    'system_worker', 'evaluator', 'tool'
  )),
  invocation_context TEXT NOT NULL CHECK(invocation_context IN (
    'private_chat', 'group_chat', 'admin_cli', 'background_worker', 'internal'
  )),
  source_event_ids TEXT NOT NULL,

  request_created_at INTEGER NOT NULL,
  decided_at INTEGER NOT NULL,

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id)
);

CREATE INDEX IF NOT EXISTS idx_evaluator_decisions_turn ON evaluator_decisions(turn_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluator_decisions_request ON evaluator_decisions(request_id);

CREATE TABLE IF NOT EXISTS action_decisions (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,

  decided_by TEXT NOT NULL CHECK(decided_by IN ('attention', 'pi', 'evaluator')),

  risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'prohibited')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),

  evaluator_required INTEGER NOT NULL DEFAULT 0,
  evaluator_passed INTEGER,
  evaluator_decision_id TEXT,
  execution_binding TEXT,

  actions TEXT NOT NULL,
  reasons TEXT,
  suppressors TEXT,

  created_at INTEGER NOT NULL,

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id),
  FOREIGN KEY (evaluator_decision_id) REFERENCES evaluator_decisions(id)
);

CREATE INDEX IF NOT EXISTS idx_action_decisions_turn ON action_decisions(turn_id);
CREATE INDEX IF NOT EXISTS idx_action_decisions_evaluator ON action_decisions(evaluator_decision_id);

CREATE TABLE IF NOT EXISTS action_executions (
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

CREATE INDEX IF NOT EXISTS idx_action_executions_decision ON action_executions(action_decision_id);

-- ============================================================
-- Tool System
-- ============================================================

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  evaluator_decision_id TEXT,
  tool_name TEXT NOT NULL,

  input TEXT NOT NULL,
  output TEXT,

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

CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_evaluator ON tool_calls(evaluator_decision_id);

-- ============================================================
-- Audit Log
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
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
  details TEXT,
  redacted INTEGER NOT NULL DEFAULT 0,

  risk_level TEXT,
  evaluator_decision_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_category ON audit_log(category);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);

-- ============================================================
-- Background Jobs
-- ============================================================

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,

  payload TEXT NOT NULL,
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
  result TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(scheduled_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,

  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),

  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  heartbeat_at INTEGER,

  error TEXT,
  result TEXT,

  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_job_attempts_worker ON job_attempts(worker_id);

CREATE TABLE IF NOT EXISTS model_contexts (
  id TEXT PRIMARY KEY,
  job_attempt_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('summary')),

  conversation_ref TEXT NOT NULL
    CHECK(
      length(conversation_ref) = 78
      AND conversation_ref GLOB 'ctxref-sha256:*'
      AND substr(conversation_ref, 15) NOT GLOB '*[^0-9a-f]*'
    ),
  conversation_type TEXT NOT NULL CHECK(conversation_type IN ('private', 'group')),
  group_ref TEXT
    CHECK(
      group_ref IS NULL
      OR (
        length(group_ref) = 80
        AND group_ref GLOB 'groupref-sha256:*'
        AND substr(group_ref, 17) NOT GLOB '*[^0-9a-f]*'
      )
    ),

  candidate_memory_ids TEXT NOT NULL CHECK(json_valid(candidate_memory_ids)),
  selected_memory_ids TEXT NOT NULL CHECK(json_valid(selected_memory_ids)),
  rejected_memories TEXT NOT NULL CHECK(json_valid(rejected_memories)),
  filters_applied TEXT NOT NULL CHECK(json_valid(filters_applied)),
  injected_identity_fields TEXT NOT NULL CHECK(json_valid(injected_identity_fields)),
  recent_message_ids TEXT NOT NULL CHECK(json_valid(recent_message_ids)),
  token_budget TEXT NOT NULL CHECK(json_valid(token_budget)),
  memories TEXT NOT NULL CHECK(json_valid(memories)),

  created_at INTEGER NOT NULL,

  UNIQUE(job_attempt_id, purpose),
  UNIQUE(id, job_attempt_id, purpose),
  FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_model_contexts_job_attempt
  ON model_contexts(job_attempt_id, purpose);

CREATE TABLE IF NOT EXISTS model_invocations (
  id TEXT PRIMARY KEY,
  job_attempt_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('summary')),
  call_number INTEGER NOT NULL CHECK(typeof(call_number) = 'integer' AND call_number >= 1),

  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 128),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'aborted')),

  started_at INTEGER NOT NULL CHECK(typeof(started_at) = 'integer' AND started_at >= 0),
  completed_at INTEGER CHECK(
    completed_at IS NULL
    OR (typeof(completed_at) = 'integer' AND completed_at >= started_at)
  ),

  tokens_input INTEGER CHECK(
    tokens_input IS NULL
    OR (typeof(tokens_input) = 'integer' AND tokens_input >= 0)
  ),
  tokens_output INTEGER CHECK(
    tokens_output IS NULL
    OR (typeof(tokens_output) = 'integer' AND tokens_output >= 0)
  ),
  tokens_total INTEGER CHECK(
    tokens_total IS NULL
    OR (typeof(tokens_total) = 'integer' AND tokens_total >= 0)
  ),

  response_sha256 TEXT CHECK(
    response_sha256 IS NULL
    OR (
      length(response_sha256) = 64
      AND response_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  response_bytes INTEGER CHECK(
    response_bytes IS NULL
    OR (typeof(response_bytes) = 'integer' AND response_bytes >= 0)
  ),
  error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 256),

  UNIQUE(job_attempt_id, call_number),
  FOREIGN KEY (context_id, job_attempt_id, purpose)
    REFERENCES model_contexts(id, job_attempt_id, purpose) ON DELETE RESTRICT,

  CHECK(
    (status = 'running'
      AND completed_at IS NULL
      AND tokens_input IS NULL
      AND tokens_output IS NULL
      AND tokens_total IS NULL
      AND response_sha256 IS NULL
      AND response_bytes IS NULL
      AND error_code IS NULL)
    OR (status = 'completed'
      AND completed_at IS NOT NULL
      AND tokens_input IS NOT NULL
      AND tokens_output IS NOT NULL
      AND tokens_total IS NOT NULL
      AND response_sha256 IS NOT NULL
      AND response_bytes IS NOT NULL
      AND error_code IS NULL)
    OR (status IN ('failed', 'aborted')
      AND completed_at IS NOT NULL
      AND tokens_input IS NULL
      AND tokens_output IS NULL
      AND tokens_total IS NULL
      AND response_sha256 IS NULL
      AND response_bytes IS NULL
      AND error_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_model_invocations_job_attempt
  ON model_invocations(job_attempt_id, call_number);
CREATE INDEX IF NOT EXISTS idx_model_invocations_context
  ON model_invocations(context_id);
CREATE INDEX IF NOT EXISTS idx_model_invocations_status
  ON model_invocations(status, started_at);

CREATE TABLE IF NOT EXISTS model_invocation_sources (
  model_invocation_id TEXT NOT NULL,
  raw_event_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL
    CHECK(typeof(source_ordinal) = 'integer' AND source_ordinal >= 0),

  PRIMARY KEY (model_invocation_id, raw_event_id),
  UNIQUE(model_invocation_id, source_ordinal),
  FOREIGN KEY (model_invocation_id) REFERENCES model_invocations(id) ON DELETE CASCADE,
  FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_model_invocation_sources_raw_event
  ON model_invocation_sources(raw_event_id, model_invocation_id);

CREATE TRIGGER IF NOT EXISTS trg_abort_running_model_invocations_after_attempt
AFTER UPDATE OF status ON job_attempts
WHEN OLD.status = 'running' AND NEW.status <> 'running'
BEGIN
  UPDATE model_invocations
     SET status = 'aborted',
         completed_at = MAX(
           started_at,
           COALESCE(
             NEW.completed_at,
             NEW.heartbeat_at,
             OLD.heartbeat_at,
             started_at
           )
         ),
         error_code = 'job_attempt_ended'
   WHERE job_attempt_id = NEW.id
     AND status = 'running';
END;

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  worker_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle', 'running', 'stopping', 'error')),
  current_job_id TEXT,
  heartbeat_at INTEGER NOT NULL,
  details TEXT,

  FOREIGN KEY (current_job_id) REFERENCES jobs(id)
);
