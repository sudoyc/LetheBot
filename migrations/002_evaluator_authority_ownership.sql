-- Migration 002: Evaluator Authority Ownership
-- Allows evaluator decisions to be owned by either a conversation turn or a
-- durable background job attempt, while preserving existing turn-owned rows.

CREATE TABLE evaluator_decisions_v2 (
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

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id) ON DELETE RESTRICT,
  FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE RESTRICT,

  CHECK(
    (turn_id IS NOT NULL AND job_attempt_id IS NULL)
    OR (turn_id IS NULL AND job_attempt_id IS NOT NULL)
  )
);

INSERT INTO evaluator_decisions_v2 (
  rowid, id, request_id, domain, turn_id, job_attempt_id,
  decision, reason, confidence, risk_level,
  evaluator_version, tool_name, actor_user_id, actor_class,
  invocation_context, source_event_ids, request_created_at, decided_at
)
SELECT
  rowid, id, request_id, domain, turn_id, NULL,
  decision, reason, confidence, risk_level,
  evaluator_version, tool_name, actor_user_id, actor_class,
  invocation_context, source_event_ids, request_created_at, decided_at
FROM evaluator_decisions;

DROP TABLE evaluator_decisions;
ALTER TABLE evaluator_decisions_v2 RENAME TO evaluator_decisions;

CREATE INDEX idx_evaluator_decisions_turn ON evaluator_decisions(turn_id);
CREATE INDEX idx_evaluator_decisions_job_attempt ON evaluator_decisions(job_attempt_id);
CREATE UNIQUE INDEX idx_evaluator_decisions_request ON evaluator_decisions(request_id);
