-- Migration 005: Delayed Attention
-- Persists source-bound delayed group-question candidates and their terminal
-- recheck decisions without copying message text into worker payloads/evidence.

CREATE UNIQUE INDEX idx_raw_events_attention_source
  ON raw_events(id, created_at, conversation_id);

CREATE UNIQUE INDEX idx_chat_messages_attention_source
  ON chat_messages(id, raw_event_id, conversation_id, conversation_type, group_id);

CREATE UNIQUE INDEX idx_job_attempts_id_job
  ON job_attempts(id, job_id);

CREATE UNIQUE INDEX idx_job_attempts_job_attempt
  ON job_attempts(job_id, attempt_number);

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

  observed_at INTEGER NOT NULL CHECK(
    typeof(observed_at) = 'integer' AND observed_at >= 0
  ),
  created_at INTEGER NOT NULL CHECK(
    typeof(created_at) = 'integer' AND created_at >= observed_at
  ),
  not_before_at INTEGER NOT NULL CHECK(
    typeof(not_before_at) = 'integer'
    AND not_before_at = observed_at + 15000
  ),
  expires_at INTEGER NOT NULL CHECK(
    typeof(expires_at) = 'integer'
    AND expires_at = observed_at + 120000
  ),

  FOREIGN KEY (source_raw_event_id, observed_at, conversation_id)
    REFERENCES raw_events(id, created_at, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (
    source_chat_message_id,
    source_raw_event_id,
    conversation_id,
    conversation_type,
    group_id
  ) REFERENCES chat_messages(
    id,
    raw_event_id,
    conversation_id,
    conversation_type,
    group_id
  ) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_attention_candidates_source_raw
  ON attention_candidates(source_raw_event_id);
CREATE UNIQUE INDEX idx_attention_candidates_source_chat
  ON attention_candidates(source_chat_message_id);
CREATE UNIQUE INDEX idx_attention_candidates_job
  ON attention_candidates(job_id);
CREATE UNIQUE INDEX idx_attention_candidates_id_job
  ON attention_candidates(id, job_id);
CREATE INDEX idx_attention_candidates_group_observed
  ON attention_candidates(group_id, observed_at, id);

CREATE TABLE attention_decisions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_attempt_id TEXT NOT NULL,

  outcome TEXT NOT NULL CHECK(outcome IN ('respond', 'suppress')),
  decided_at INTEGER NOT NULL CHECK(
    typeof(decided_at) = 'integer' AND decided_at >= 0
  ),

  FOREIGN KEY (candidate_id, job_id)
    REFERENCES attention_candidates(id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (job_attempt_id, job_id)
    REFERENCES job_attempts(id, job_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_attention_decisions_candidate
  ON attention_decisions(candidate_id);
CREATE UNIQUE INDEX idx_attention_decisions_id_candidate_outcome
  ON attention_decisions(id, candidate_id, outcome);
CREATE INDEX idx_attention_decisions_job_attempt
  ON attention_decisions(job_attempt_id, job_id);
CREATE INDEX idx_attention_decisions_respond_window
  ON attention_decisions(decided_at, candidate_id)
  WHERE outcome = 'respond';

CREATE TABLE attention_suppressors (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  decision_outcome TEXT NOT NULL DEFAULT 'suppress'
    CHECK(decision_outcome = 'suppress'),

  code TEXT NOT NULL CHECK(code IN (
    'thread_expired',
    'human_answer',
    'high_traffic',
    'group_budget_exhausted'
  )),
  evidence_chat_message_id TEXT,
  observed_count INTEGER,
  window_ms INTEGER,
  created_at INTEGER NOT NULL CHECK(
    typeof(created_at) = 'integer' AND created_at >= 0
  ),

  FOREIGN KEY (decision_id, candidate_id, decision_outcome)
    REFERENCES attention_decisions(id, candidate_id, outcome) ON DELETE CASCADE,
  FOREIGN KEY (evidence_chat_message_id)
    REFERENCES chat_messages(id) ON DELETE CASCADE,

  CHECK(
    (code = 'thread_expired'
      AND evidence_chat_message_id IS NULL
      AND observed_count IS NULL
      AND window_ms IS NULL)
    OR (code = 'human_answer'
      AND evidence_chat_message_id IS NOT NULL
      AND observed_count IS NULL
      AND window_ms IS NULL)
    OR (code = 'high_traffic'
      AND evidence_chat_message_id IS NULL
      AND typeof(observed_count) = 'integer'
      AND observed_count >= 6
      AND typeof(window_ms) = 'integer'
      AND window_ms = 10000)
    OR (code = 'group_budget_exhausted'
      AND evidence_chat_message_id IS NULL
      AND typeof(observed_count) = 'integer'
      AND observed_count >= 2
      AND typeof(window_ms) = 'integer'
      AND window_ms = 600000)
  )
);

CREATE UNIQUE INDEX idx_attention_suppressors_decision_code
  ON attention_suppressors(decision_id, code);
CREATE INDEX idx_attention_suppressors_decision_candidate
  ON attention_suppressors(decision_id, candidate_id);
CREATE INDEX idx_attention_suppressors_evidence_chat
  ON attention_suppressors(evidence_chat_message_id)
  WHERE evidence_chat_message_id IS NOT NULL;

CREATE INDEX idx_chat_messages_attention_reply
  ON chat_messages(conversation_id, reply_to_message_id, timestamp)
  WHERE reply_to_message_id IS NOT NULL;
