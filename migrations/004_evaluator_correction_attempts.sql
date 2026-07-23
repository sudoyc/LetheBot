-- Migration 004: Evaluator Correction Attempts
-- Allows one separately ledgered correction after invalid structured output
-- while preserving existing summary and evaluator invocation evidence.

DROP TRIGGER trg_abort_running_model_invocations_after_attempt;
DROP TRIGGER trg_abort_running_model_invocations_after_turn;

CREATE TABLE model_invocations_v4 (
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

  FOREIGN KEY (turn_id) REFERENCES agent_turns(id) ON DELETE RESTRICT,
  FOREIGN KEY (job_attempt_id) REFERENCES job_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, job_attempt_id, purpose)
    REFERENCES model_contexts(id, job_attempt_id, purpose) ON DELETE RESTRICT,

  CHECK(
    (turn_id IS NOT NULL AND job_attempt_id IS NULL)
    OR (turn_id IS NULL AND job_attempt_id IS NOT NULL)
  ),
  CHECK(
    (
      purpose = 'summary'
      AND turn_id IS NULL
      AND job_attempt_id IS NOT NULL
      AND context_id IS NOT NULL
      AND evaluator_request_id IS NULL
      AND evaluator_domain IS NULL
      AND prompt_version IS NULL
    )
    OR (
      purpose = 'evaluator'
      AND context_id IS NULL
      AND evaluator_request_id IS NOT NULL
      AND length(evaluator_request_id) BETWEEN 1 AND 512
      AND evaluator_domain IS NOT NULL
      AND (evaluator_domain = 'memory' OR turn_id IS NOT NULL)
      AND prompt_version IS NOT NULL
      AND length(prompt_version) BETWEEN 1 AND 256
      AND call_number IN (1, 2)
    )
  ),
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

INSERT INTO model_invocations_v4 (
  rowid, id, turn_id, job_attempt_id, context_id, purpose,
  evaluator_request_id, evaluator_domain, prompt_version, call_number,
  provider, model, status, started_at, completed_at,
  tokens_input, tokens_output, tokens_total,
  response_sha256, response_bytes, error_code
)
SELECT
  rowid, id, turn_id, job_attempt_id, context_id, purpose,
  evaluator_request_id, evaluator_domain, prompt_version, call_number,
  provider, model, status, started_at, completed_at,
  tokens_input, tokens_output, tokens_total,
  response_sha256, response_bytes, error_code
FROM model_invocations;

DROP TABLE model_invocations;
ALTER TABLE model_invocations_v4 RENAME TO model_invocations;

CREATE UNIQUE INDEX idx_model_invocations_summary_call
  ON model_invocations(job_attempt_id, call_number)
  WHERE purpose = 'summary';
CREATE UNIQUE INDEX idx_model_invocations_evaluator_request_call
  ON model_invocations(evaluator_request_id, call_number)
  WHERE purpose = 'evaluator';
CREATE INDEX idx_model_invocations_turn
  ON model_invocations(turn_id, call_number) WHERE turn_id IS NOT NULL;
CREATE INDEX idx_model_invocations_job_attempt
  ON model_invocations(job_attempt_id, call_number) WHERE job_attempt_id IS NOT NULL;
CREATE INDEX idx_model_invocations_context
  ON model_invocations(context_id) WHERE context_id IS NOT NULL;
CREATE INDEX idx_model_invocations_status
  ON model_invocations(status, started_at);

CREATE TRIGGER trg_abort_running_model_invocations_after_attempt
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

CREATE TRIGGER trg_abort_running_model_invocations_after_turn
AFTER UPDATE OF status ON agent_turns
WHEN OLD.status = 'running' AND NEW.status <> 'running'
BEGIN
  UPDATE model_invocations
     SET status = 'aborted',
         completed_at = MAX(
           started_at,
           COALESCE(NEW.completed_at, OLD.completed_at, started_at)
         ),
         error_code = 'turn_ended'
   WHERE turn_id = NEW.id
     AND status = 'running';
END;
