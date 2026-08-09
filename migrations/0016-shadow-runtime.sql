CREATE TABLE retrieval_index_sources (
  index_revision_id TEXT PRIMARY KEY REFERENCES retrieval_index_revisions(index_revision_id),
  catalog_sha256 TEXT NOT NULL
) STRICT;

CREATE TABLE shadow_event_evaluations (
  event_id TEXT PRIMARY KEY REFERENCES capture_events(event_id),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('SessionStart', 'UserPromptSubmit')),
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'skipped', 'retrying')),
  receipt_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX shadow_event_evaluations_retry
  ON shadow_event_evaluations(state, next_retry_at, updated_at);
