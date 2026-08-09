CREATE TABLE luna_operations (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN (
      'distill_batch',
      'consolidate_session',
      'semantic_assessment',
      'conflict_assessment'
    )
  ),
  idempotency_key TEXT NOT NULL UNIQUE,
  project_id TEXT,
  session_id TEXT,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'processing', 'retrying', 'blocked', 'completed', 'dead_letter')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token TEXT,
  leased_by TEXT,
  lease_until TEXT,
  next_retry_at TEXT,
  last_error_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX luna_operations_ready
  ON luna_operations(state, next_retry_at, created_at);

CREATE TABLE luna_health_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('healthy', 'degraded', 'unavailable')),
  reason_category TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  schema_invalid_failures INTEGER NOT NULL DEFAULT 0,
  first_failure_at TEXT,
  last_failure_at TEXT,
  last_success_at TEXT,
  successful_probe_at TEXT,
  next_retry_at TEXT,
  active_incident_id TEXT
) STRICT;

INSERT INTO luna_health_state(singleton, state)
VALUES (1, 'healthy');

CREATE TABLE model_health_incidents (
  incident_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('degraded', 'unavailable', 'recovered')),
  reason_category TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_failure_at TEXT NOT NULL,
  ended_at TEXT,
  transition_count INTEGER NOT NULL DEFAULT 1,
  notification_pending INTEGER NOT NULL DEFAULT 1 CHECK (notification_pending IN (0, 1))
) STRICT;
