CREATE TABLE archive_retention_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_check_at TEXT,
  last_checked_at TEXT,
  last_completed_at TEXT,
  last_error_code TEXT,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failure_count >= 0),
  backfill_completed_at TEXT
) STRICT;

INSERT INTO archive_retention_maintenance(singleton) VALUES (1);
