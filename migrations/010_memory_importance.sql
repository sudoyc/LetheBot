-- Migration 010: Memory Importance
-- Rebuild CHECK-constrained maintenance tables without changing existing rows.
-- The migration runner disables foreign keys only around its checked transaction.

DROP TRIGGER trg_validate_memory_maintenance_proposal_revision;

CREATE TABLE memory_maintenance_proposals_v10 (
  id TEXT PRIMARY KEY CHECK(
    typeof(id) = 'text'
    AND length(id) BETWEEN 1 AND 256
    AND id = trim(id)
  ),
  kind TEXT NOT NULL CHECK(kind IN ('conflict', 'consolidation', 'decay', 'importance')),
  effect_type TEXT NOT NULL CHECK(
    effect_type IN ('resolve_conflict', 'consolidate', 'disable', 'adjust_importance')
  ),
  lifecycle_state TEXT NOT NULL CHECK(
    lifecycle_state IN (
      'pending_review', 'approved', 'rejected', 'expired', 'applied',
      'rolled_back'
    )
  ),

  scope TEXT NOT NULL CHECK(
    scope IN ('global', 'user', 'group', 'conversation', 'tool', 'system')
  ),
  canonical_user_id TEXT CHECK(
    canonical_user_id IS NULL
    OR (
      typeof(canonical_user_id) = 'text'
      AND length(canonical_user_id) > 0
      AND canonical_user_id = trim(canonical_user_id)
    )
  ),
  group_id TEXT CHECK(
    group_id IS NULL
    OR (
      typeof(group_id) = 'text'
      AND length(group_id) > 0
      AND group_id = trim(group_id)
    )
  ),
  conversation_id TEXT CHECK(
    conversation_id IS NULL
    OR (
      typeof(conversation_id) = 'text'
      AND length(conversation_id) > 0
      AND conversation_id = trim(conversation_id)
    )
  ),
  subject_user_id TEXT CHECK(
    subject_user_id IS NULL
    OR (
      typeof(subject_user_id) = 'text'
      AND length(subject_user_id) > 0
      AND subject_user_id = trim(subject_user_id)
    )
  ),

  candidate_fingerprint TEXT NOT NULL CHECK(
    length(candidate_fingerprint) = 64
    AND candidate_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  confidence REAL NOT NULL CHECK(
    typeof(confidence) IN ('integer', 'real')
    AND confidence >= 0
    AND confidence <= 1
  ),

  effect_memory_id TEXT,
  effect_memory_role TEXT CHECK(
    effect_memory_role IS NULL
    OR effect_memory_role IN ('retained', 'disable_target', 'importance_target')
  ),
  current_revision_number INTEGER NOT NULL CHECK(
    typeof(current_revision_number) = 'integer'
    AND current_revision_number >= 1
  ),
  created_at INTEGER NOT NULL CHECK(
    typeof(created_at) = 'integer' AND created_at >= 0
  ),
  updated_at INTEGER NOT NULL CHECK(
    typeof(updated_at) = 'integer' AND updated_at >= created_at
  ),
  expires_at INTEGER CHECK(
    expires_at IS NULL
    OR (typeof(expires_at) = 'integer' AND expires_at >= created_at)
  ),
  created_audit_id TEXT NOT NULL UNIQUE,

  UNIQUE (id, kind),
  FOREIGN KEY (effect_memory_id) REFERENCES memory_records(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_audit_id) REFERENCES audit_log(id) ON DELETE RESTRICT,
  FOREIGN KEY (id, kind, effect_memory_id, effect_memory_role)
    REFERENCES memory_maintenance_proposal_candidates(
      proposal_id, proposal_kind, memory_id, effect_role
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,

  CHECK(
    (scope = 'user' AND canonical_user_id IS NOT NULL)
    OR (
      scope = 'group'
      AND canonical_user_id IS NULL
      AND group_id IS NOT NULL
    )
    OR (
      scope = 'conversation'
      AND canonical_user_id IS NULL
      AND conversation_id IS NOT NULL
    )
    OR (
      scope IN ('global', 'tool', 'system')
      AND canonical_user_id IS NULL
      AND group_id IS NULL
      AND conversation_id IS NULL
    )
  ),
  CHECK(
    (
      kind = 'conflict'
      AND effect_type = 'resolve_conflict'
      AND effect_memory_id IS NULL
      AND effect_memory_role IS NULL
    )
    OR (
      kind = 'consolidation'
      AND effect_type = 'consolidate'
      AND effect_memory_id IS NOT NULL
      AND effect_memory_role = 'retained'
    )
    OR (
      kind = 'importance'
      AND effect_type = 'adjust_importance'
      AND effect_memory_id IS NOT NULL
      AND effect_memory_role = 'importance_target'
    )
    OR (
      kind = 'decay'
      AND effect_type = 'disable'
      AND effect_memory_id IS NOT NULL
      AND effect_memory_role = 'disable_target'
    )
  )
);

INSERT INTO memory_maintenance_proposals_v10 (rowid, id, kind, effect_type, lifecycle_state, scope, canonical_user_id, group_id, conversation_id, subject_user_id, candidate_fingerprint, confidence, effect_memory_id, effect_memory_role, current_revision_number, created_at, updated_at, expires_at, created_audit_id)
SELECT rowid, * FROM memory_maintenance_proposals;
DROP TABLE memory_maintenance_proposals;
ALTER TABLE memory_maintenance_proposals_v10 RENAME TO memory_maintenance_proposals;

CREATE TABLE memory_maintenance_proposal_candidates_v10 (
  proposal_id TEXT NOT NULL,
  proposal_kind TEXT NOT NULL CHECK(
    proposal_kind IN ('conflict', 'consolidation', 'decay', 'importance')
  ),
  candidate_ordinal INTEGER NOT NULL CHECK(
    typeof(candidate_ordinal) = 'integer' AND candidate_ordinal >= 0
  ),
  memory_id TEXT NOT NULL,
  effect_role TEXT NOT NULL CHECK(
    effect_role IN (
      'conflict_candidate', 'retained', 'supersede', 'disable_target', 'importance_target'
    )
  ),
  expected_state TEXT NOT NULL CHECK(expected_state = 'active'),
  record_fingerprint TEXT NOT NULL CHECK(
    length(record_fingerprint) = 64
    AND record_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  source_count INTEGER NOT NULL CHECK(
    typeof(source_count) = 'integer' AND source_count >= 0
  ),
  source_fingerprint TEXT NOT NULL CHECK(
    length(source_fingerprint) = 64
    AND source_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),

  PRIMARY KEY (proposal_id, candidate_ordinal),
  UNIQUE (proposal_id, memory_id),
  UNIQUE (proposal_id, proposal_kind, memory_id),
  UNIQUE (proposal_id, proposal_kind, memory_id, effect_role),
  FOREIGN KEY (proposal_id, proposal_kind)
    REFERENCES memory_maintenance_proposals(id, kind)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE RESTRICT,

  CHECK(
    (proposal_kind = 'conflict' AND effect_role = 'conflict_candidate')
    OR (
      proposal_kind = 'consolidation'
      AND effect_role IN ('retained', 'supersede')
    )
    OR (proposal_kind = 'importance' AND effect_role = 'importance_target')
    OR (proposal_kind = 'decay' AND effect_role = 'disable_target')
  )
);

INSERT INTO memory_maintenance_proposal_candidates_v10 (rowid, proposal_id, proposal_kind, candidate_ordinal, memory_id, effect_role, expected_state, record_fingerprint, source_count, source_fingerprint)
SELECT rowid, * FROM memory_maintenance_proposal_candidates;
DROP TABLE memory_maintenance_proposal_candidates;
ALTER TABLE memory_maintenance_proposal_candidates_v10 RENAME TO memory_maintenance_proposal_candidates;

CREATE TABLE memory_maintenance_proposal_reasons_v10 (
  proposal_id TEXT NOT NULL,
  proposal_kind TEXT NOT NULL CHECK(
    proposal_kind IN ('conflict', 'consolidation', 'decay', 'importance')
  ),
  reason_ordinal INTEGER NOT NULL CHECK(
    typeof(reason_ordinal) = 'integer' AND reason_ordinal >= 0
  ),
  reason_code TEXT NOT NULL CHECK(reason_code IN (
    'same_boundary_title_different_content',
    'same_boundary_title_and_content',
    'stale',
    'low_confidence',
    'low_importance',
    'repeated_first_party_evidence'
  )),

  PRIMARY KEY (proposal_id, reason_ordinal),
  UNIQUE (proposal_id, reason_code),
  FOREIGN KEY (proposal_id, proposal_kind)
    REFERENCES memory_maintenance_proposals(id, kind)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,

  CHECK(
    (
      proposal_kind = 'conflict'
      AND reason_code = 'same_boundary_title_different_content'
    )
    OR (
      proposal_kind = 'consolidation'
      AND reason_code = 'same_boundary_title_and_content'
    )
    OR (proposal_kind = 'importance' AND reason_code = 'repeated_first_party_evidence')
    OR (
      proposal_kind = 'decay'
      AND reason_code IN ('stale', 'low_confidence', 'low_importance')
    )
  )
);

INSERT INTO memory_maintenance_proposal_reasons_v10 (rowid, proposal_id, proposal_kind, reason_ordinal, reason_code)
SELECT rowid, * FROM memory_maintenance_proposal_reasons;
DROP TABLE memory_maintenance_proposal_reasons;
ALTER TABLE memory_maintenance_proposal_reasons_v10 RENAME TO memory_maintenance_proposal_reasons;

CREATE TABLE memory_maintenance_proposal_revisions_v10 (
  id TEXT PRIMARY KEY CHECK(
    typeof(id) = 'text'
    AND length(id) BETWEEN 1 AND 256
    AND id = trim(id)
  ),
  proposal_id TEXT NOT NULL,
  proposal_kind TEXT NOT NULL CHECK(
    proposal_kind IN ('conflict', 'consolidation', 'decay', 'importance')
  ),
  revision_number INTEGER NOT NULL CHECK(
    typeof(revision_number) = 'integer' AND revision_number >= 1
  ),
  transition TEXT NOT NULL CHECK(
    transition IN ('propose', 'approve', 'reject', 'expire', 'apply', 'rollback')
  ),
  previous_state TEXT CHECK(
    previous_state IS NULL
    OR previous_state IN (
      'pending_review', 'approved', 'rejected', 'expired', 'applied',
      'rolled_back'
    )
  ),
  new_state TEXT NOT NULL CHECK(new_state IN (
    'pending_review', 'approved', 'rejected', 'expired', 'applied',
    'rolled_back'
  )),
  actor_user_id TEXT,
  actor_class TEXT NOT NULL CHECK(actor_class IN (
    'owner', 'admin', 'trusted_user', 'user', 'group_admin',
    'system_worker', 'evaluator', 'tool'
  )),
  invocation_context TEXT NOT NULL CHECK(invocation_context IN (
    'private_chat', 'group_chat', 'admin_cli', 'background_worker', 'internal'
  )),
  reason_code TEXT NOT NULL CHECK(
    typeof(reason_code) = 'text'
    AND length(reason_code) BETWEEN 1 AND 128
    AND reason_code = trim(reason_code)
  ),
  audit_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK(
    typeof(created_at) = 'integer' AND created_at >= 0
  ),

  UNIQUE (proposal_id, revision_number),
  UNIQUE (id, proposal_id, proposal_kind, transition),
  FOREIGN KEY (proposal_id, proposal_kind)
    REFERENCES memory_maintenance_proposals(id, kind) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id) REFERENCES canonical_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_id) REFERENCES audit_log(id) ON DELETE RESTRICT,

  CHECK(
    (
      transition = 'propose'
      AND revision_number = 1
      AND previous_state IS NULL
      AND new_state = 'pending_review'
      AND actor_user_id IS NULL
      AND actor_class = 'system_worker'
      AND invocation_context = 'background_worker'
    )
    OR (
      transition = 'approve'
      AND revision_number >= 2
      AND previous_state = 'pending_review'
      AND new_state = 'approved'
    )
    OR (
      transition = 'reject'
      AND revision_number >= 2
      AND previous_state = 'pending_review'
      AND new_state = 'rejected'
    )
    OR (
      transition = 'expire'
      AND revision_number >= 2
      AND previous_state IN ('pending_review', 'approved')
      AND new_state = 'expired'
    )
    OR (
      transition = 'apply'
      AND revision_number >= 2
      AND previous_state = 'approved'
      AND new_state = 'applied'
    )
    OR (
      transition = 'rollback'
      AND revision_number >= 2
      AND previous_state = 'applied'
      AND new_state = 'rolled_back'
    )
  )
);

INSERT INTO memory_maintenance_proposal_revisions_v10 (rowid, id, proposal_id, proposal_kind, revision_number, transition, previous_state, new_state, actor_user_id, actor_class, invocation_context, reason_code, audit_id, created_at)
SELECT rowid, * FROM memory_maintenance_proposal_revisions;
DROP TABLE memory_maintenance_proposal_revisions;
ALTER TABLE memory_maintenance_proposal_revisions_v10 RENAME TO memory_maintenance_proposal_revisions;

CREATE TABLE memory_maintenance_proposal_revision_effects_v10 (
  proposal_revision_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  proposal_kind TEXT NOT NULL CHECK(
    proposal_kind IN ('conflict', 'consolidation', 'decay', 'importance')
  ),
  transition TEXT NOT NULL CHECK(transition IN ('apply', 'rollback')),
  memory_id TEXT NOT NULL,
  effect_role TEXT NOT NULL CHECK(
    effect_role IN ('retained', 'superseded', 'disabled', 'restored', 'importance_adjusted')
  ),
  memory_revision_id TEXT NOT NULL UNIQUE,

  PRIMARY KEY (proposal_revision_id, memory_id),
  FOREIGN KEY (
    proposal_revision_id, proposal_id, proposal_kind, transition
  ) REFERENCES memory_maintenance_proposal_revisions(
    id, proposal_id, proposal_kind, transition
  ) ON DELETE RESTRICT,
  FOREIGN KEY (proposal_id, proposal_kind, memory_id)
    REFERENCES memory_maintenance_proposal_candidates(
      proposal_id, proposal_kind, memory_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (memory_revision_id, memory_id)
    REFERENCES memory_revisions(id, memory_id) ON DELETE RESTRICT,

  CHECK(
    (
      transition = 'apply'
      AND proposal_kind IN ('conflict', 'consolidation')
      AND effect_role IN ('retained', 'superseded')
    )
    OR (
      transition = 'apply'
      AND proposal_kind = 'decay'
      AND effect_role = 'disabled'
    )
    OR (
      transition = 'apply'
      AND proposal_kind = 'importance'
      AND effect_role = 'importance_adjusted'
    )
    OR (transition = 'rollback' AND effect_role = 'restored')
  )
);

INSERT INTO memory_maintenance_proposal_revision_effects_v10 (rowid, proposal_revision_id, proposal_id, proposal_kind, transition, memory_id, effect_role, memory_revision_id)
SELECT rowid, * FROM memory_maintenance_proposal_revision_effects;
DROP TABLE memory_maintenance_proposal_revision_effects;
ALTER TABLE memory_maintenance_proposal_revision_effects_v10 RENAME TO memory_maintenance_proposal_revision_effects;

CREATE UNIQUE INDEX idx_memory_maintenance_candidates_retained
  ON memory_maintenance_proposal_candidates(proposal_id)
  WHERE effect_role = 'retained';
CREATE UNIQUE INDEX idx_memory_maintenance_candidates_disable_target
  ON memory_maintenance_proposal_candidates(proposal_id)
  WHERE effect_role = 'disable_target';
CREATE INDEX idx_memory_maintenance_candidates_memory
  ON memory_maintenance_proposal_candidates(memory_id, proposal_id);

CREATE INDEX idx_memory_maintenance_proposal_revisions_proposal
  ON memory_maintenance_proposal_revisions(proposal_id, revision_number);

CREATE TRIGGER trg_validate_memory_maintenance_proposal_revision
BEFORE INSERT ON memory_maintenance_proposal_revisions
WHEN NOT EXISTS (
  SELECT 1
    FROM memory_maintenance_proposals
   WHERE id = NEW.proposal_id
     AND kind = NEW.proposal_kind
     AND lifecycle_state = NEW.new_state
     AND current_revision_number = NEW.revision_number
)
OR (
  NEW.revision_number > 1
  AND NOT EXISTS (
    SELECT 1
      FROM memory_maintenance_proposal_revisions
     WHERE proposal_id = NEW.proposal_id
       AND revision_number = NEW.revision_number - 1
       AND new_state = NEW.previous_state
  )
)
BEGIN
  SELECT RAISE(ABORT, 'memory maintenance proposal revision is not current');
END;

CREATE INDEX idx_memory_maintenance_revision_effects_memory
  ON memory_maintenance_proposal_revision_effects(memory_id, memory_revision_id);
CREATE INDEX idx_memory_maintenance_proposals_review_queue
  ON memory_maintenance_proposals(lifecycle_state, created_at, id);
CREATE INDEX idx_memory_maintenance_proposals_scope
  ON memory_maintenance_proposals(
    scope, canonical_user_id, group_id, conversation_id, lifecycle_state
  );

CREATE TABLE memory_importance_scores (
  proposal_id TEXT PRIMARY KEY,
  proposal_kind TEXT NOT NULL DEFAULT 'importance' CHECK(proposal_kind = 'importance'),
  memory_id TEXT NOT NULL,
  memory_revision_id TEXT NOT NULL,
  scorer_version INTEGER NOT NULL CHECK(scorer_version = 1),
  window_start_at INTEGER NOT NULL CHECK(typeof(window_start_at) = 'integer' AND window_start_at >= 0),
  window_end_at INTEGER NOT NULL CHECK(typeof(window_end_at) = 'integer' AND window_end_at >= window_start_at),
  window_end_order INTEGER NOT NULL CHECK(typeof(window_end_order) = 'integer' AND window_end_order > 0),
  observation_count INTEGER NOT NULL CHECK(typeof(observation_count) = 'integer' AND observation_count BETWEEN 3 AND 200),
  distinct_day_count INTEGER NOT NULL CHECK(typeof(distinct_day_count) = 'integer' AND distinct_day_count BETWEEN 3 AND observation_count),
  span_days REAL NOT NULL CHECK(span_days >= 2 AND span_days <= 30),
  previous_importance REAL NOT NULL CHECK(previous_importance >= 0 AND previous_importance <= 1),
  proposed_importance REAL NOT NULL CHECK(proposed_importance > previous_importance AND proposed_importance <= 0.95),
  evidence_fingerprint TEXT NOT NULL CHECK(length(evidence_fingerprint) = 64 AND evidence_fingerprint NOT GLOB '*[^0-9a-f]*'),
  job_attempt_id TEXT,
  FOREIGN KEY (proposal_id, proposal_kind, memory_id)
    REFERENCES memory_maintenance_proposal_candidates(proposal_id, proposal_kind, memory_id) ON DELETE RESTRICT,
  FOREIGN KEY (memory_revision_id, memory_id) REFERENCES memory_revisions(id, memory_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
);

CREATE TABLE memory_importance_sources (
  proposal_id TEXT NOT NULL REFERENCES memory_importance_scores(proposal_id) ON DELETE RESTRICT,
  source_ordinal INTEGER NOT NULL CHECK(typeof(source_ordinal) = 'integer' AND source_ordinal BETWEEN 0 AND 199),
  source_raw_event_id TEXT NOT NULL CHECK(length(source_raw_event_id) BETWEEN 1 AND 512),
  source_chat_message_id TEXT NOT NULL CHECK(length(source_chat_message_id) BETWEEN 1 AND 512),
  raw_event_id TEXT REFERENCES raw_events(id) ON DELETE SET NULL,
  chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  source_timestamp INTEGER NOT NULL CHECK(typeof(source_timestamp) = 'integer' AND source_timestamp >= 0),
  ingress_at INTEGER NOT NULL CHECK(typeof(ingress_at) = 'integer' AND ingress_at >= 0),
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('support', 'context')),
  PRIMARY KEY (proposal_id, source_ordinal),
  UNIQUE (proposal_id, source_raw_event_id),
  UNIQUE (proposal_id, source_chat_message_id),
  CHECK(raw_event_id IS NULL OR raw_event_id = source_raw_event_id),
  CHECK(chat_message_id IS NULL OR chat_message_id = source_chat_message_id)
);
CREATE INDEX idx_memory_importance_sources_raw ON memory_importance_sources(raw_event_id);
CREATE INDEX idx_memory_importance_sources_chat ON memory_importance_sources(chat_message_id);
