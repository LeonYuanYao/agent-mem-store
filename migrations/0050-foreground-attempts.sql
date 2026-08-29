CREATE TABLE foreground_attempts (
  attempt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('SessionStart', 'UserPromptSubmit')),
  event_id TEXT,
  project_id TEXT,
  receipt_id TEXT REFERENCES retrieval_receipts(receipt_id) ON DELETE SET NULL,
  index_revision_id TEXT REFERENCES retrieval_index_revisions(index_revision_id),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'completed', 'empty', 'busy', 'deadline_exceeded',
    'cancelled', 'unavailable', 'failed'
  )),
  admission_delay_ms REAL NOT NULL CHECK (admission_delay_ms >= 0),
  compute_ms REAL NOT NULL CHECK (compute_ms >= 0),
  receipt_commit_ms REAL NOT NULL CHECK (receipt_commit_ms >= 0),
  observed_client_elapsed_ms REAL NOT NULL CHECK (observed_client_elapsed_ms >= 0),
  cancellation_observed_ms REAL,
  post_deadline_work_ms REAL NOT NULL DEFAULT 0 CHECK (post_deadline_work_ms >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
) STRICT;

CREATE INDEX foreground_attempts_created
  ON foreground_attempts(created_at);

CREATE INDEX foreground_attempts_outcome_created
  ON foreground_attempts(outcome, created_at);

CREATE INDEX foreground_attempts_project_created
  ON foreground_attempts(project_id, created_at);
