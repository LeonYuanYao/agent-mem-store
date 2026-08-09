CREATE TABLE review_inbox_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generated_at TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  item_counts_json TEXT NOT NULL,
  path TEXT NOT NULL
) STRICT;

CREATE TABLE reminder_obligations (
  reminder_id TEXT PRIMARY KEY,
  digest_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'delivering', 'delivered', 'acknowledged', 'snoozed', 'failed', 'fallback')
  ),
  counts_json TEXT NOT NULL,
  issue_categories_json TEXT NOT NULL,
  inbox_path TEXT NOT NULL,
  due_at TEXT NOT NULL,
  snoozed_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT
) STRICT;

CREATE INDEX reminder_obligations_ready
  ON reminder_obligations(state, due_at, snoozed_until, next_retry_at);

CREATE TABLE reminder_attempts (
  attempt_id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL REFERENCES reminder_obligations(reminder_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed', 'permission_denied')),
  attempted_at TEXT NOT NULL,
  adapter_receipt TEXT,
  error_code TEXT
) STRICT;

CREATE TABLE worker_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  capture_paused INTEGER NOT NULL DEFAULT 0 CHECK (capture_paused IN (0, 1)),
  worker_paused INTEGER NOT NULL DEFAULT 0 CHECK (worker_paused IN (0, 1)),
  updated_at TEXT NOT NULL,
  reason TEXT
) STRICT;

CREATE TABLE runtime_backups (
  backup_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  source_runtime_id TEXT NOT NULL,
  source_schema_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('complete', 'failed')),
  sha256 TEXT,
  created_at TEXT NOT NULL
) STRICT;

