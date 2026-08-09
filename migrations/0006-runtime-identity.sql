CREATE TABLE runtime_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  runtime_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;
