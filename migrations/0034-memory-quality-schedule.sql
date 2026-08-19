CREATE TABLE memory_quality_schedule (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  cursor_memory_id TEXT,
  next_scan_at TEXT NOT NULL,
  last_completed_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;
