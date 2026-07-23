-- Migration 006: Group summary policy
-- Keeps group summaries default-off and binds every durable summary job to
-- the exact enabled policy generation that authorized it.

CREATE TABLE group_summary_policies (
  group_id TEXT PRIMARY KEY
    CHECK(
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

CREATE TABLE group_summary_job_bindings (
  job_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL
    CHECK(
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
