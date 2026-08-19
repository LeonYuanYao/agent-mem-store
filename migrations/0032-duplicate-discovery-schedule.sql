CREATE TABLE duplicate_discovery_schedule (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  index_revision_id TEXT NOT NULL,
  cursor_memory_id TEXT,
  next_scan_at TEXT NOT NULL,
  last_completed_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;
