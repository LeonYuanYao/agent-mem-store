CREATE TABLE distillation_batches (
  batch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT,
  batch_ordinal INTEGER NOT NULL CHECK (batch_ordinal >= 0),
  state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'retrying', 'blocked', 'completed')),
  operation_id TEXT NOT NULL UNIQUE REFERENCES luna_operations(operation_id),
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(session_id, batch_ordinal)
) STRICT;

CREATE TABLE distillation_batch_events (
  batch_id TEXT NOT NULL REFERENCES distillation_batches(batch_id),
  event_id TEXT NOT NULL UNIQUE REFERENCES capture_events(event_id),
  event_ordinal INTEGER NOT NULL CHECK (event_ordinal >= 0),
  PRIMARY KEY(batch_id, event_ordinal)
) STRICT;

CREATE TABLE session_consolidations (
  session_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES luna_operations(operation_id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'retrying', 'blocked', 'completed')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
