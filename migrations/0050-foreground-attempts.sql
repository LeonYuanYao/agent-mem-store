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

CREATE TABLE foreground_attempt_overflow (
  bucket_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'completed', 'empty', 'busy', 'deadline_exceeded',
    'cancelled', 'unavailable', 'failed'
  )),
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  PRIMARY KEY (bucket_at, outcome)
) STRICT;

CREATE TABLE foreground_attempt_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_prune_at TEXT NOT NULL
) STRICT;

INSERT INTO foreground_attempt_maintenance(singleton, next_prune_at)
VALUES (1, '1970-01-01T00:00:00.000Z');

CREATE TABLE foreground_event_reservations (
  event_id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('SessionStart', 'UserPromptSubmit')),
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'retrying')),
  receipt_id TEXT REFERENCES retrieval_receipts(receipt_id),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  last_error_code TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX foreground_event_reservations_retry
  ON foreground_event_reservations(state, next_retry_at, updated_at);
