CREATE TABLE capture_events (
  event_id TEXT PRIMARY KEY,
  deduplication_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  agent TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  turn_id TEXT,
  whole_content_sha256 TEXT NOT NULL,
  segment_count INTEGER NOT NULL CHECK (segment_count > 0),
  source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
  retained_bytes INTEGER NOT NULL CHECK (retained_bytes >= 0),
  source_truncated INTEGER NOT NULL CHECK (source_truncated IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'completed', 'retrying', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  next_retry_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE capture_segments (
  event_id TEXT NOT NULL REFERENCES capture_events(event_id),
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  payload BLOB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  PRIMARY KEY (event_id, segment_index)
) STRICT;

CREATE TABLE capture_attempts (
  attempt_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES capture_events(event_id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT,
  error_code TEXT
) STRICT;

CREATE TABLE capture_health_incidents (
  incident_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  occurrence_count INTEGER NOT NULL,
  last_error_code TEXT
) STRICT;
