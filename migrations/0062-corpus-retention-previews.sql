CREATE TABLE corpus_retention_plans (
  digest TEXT PRIMARY KEY,
  preview_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  result_json TEXT
) STRICT;

CREATE TABLE corpus_retention_preview_schedule (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_check_at TEXT,
  last_preview_json TEXT,
  last_error TEXT,
  configuration_identity TEXT,
  lease_until TEXT,
  pending_digest TEXT,
  last_run_at TEXT,
  last_result_json TEXT
) STRICT;

INSERT INTO corpus_retention_preview_schedule(singleton) VALUES (1);

CREATE TABLE corpus_retention_pressure (
  policy_identity TEXT NOT NULL,
  space_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY (policy_identity, space_key)
) STRICT;
