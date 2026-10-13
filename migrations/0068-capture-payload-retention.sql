-- Capture payload retention (ADR-0071): terminal payloads are removed after the
-- configured period, dead-letter payloads after their longer review window.
-- Event metadata stays as body-free history; readers must treat a removed body
-- as unavailable rather than as a corrupt event.
ALTER TABLE capture_events ADD COLUMN payload_removed_at TEXT;

CREATE INDEX capture_events_payload_retention
  ON capture_events(state, updated_at) WHERE payload_removed_at IS NULL;

CREATE TABLE capture_payload_retention_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_check_at TEXT,
  last_checked_at TEXT,
  last_completed_at TEXT,
  last_error_code TEXT,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failure_count >= 0),
  last_removed_event_count INTEGER NOT NULL DEFAULT 0 CHECK (last_removed_event_count >= 0),
  total_removed_event_count INTEGER NOT NULL DEFAULT 0 CHECK (total_removed_event_count >= 0),
  total_removed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_removed_bytes >= 0)
) STRICT;

INSERT INTO capture_payload_retention_maintenance(singleton) VALUES (1);
