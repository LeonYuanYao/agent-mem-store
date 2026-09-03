CREATE TABLE sensitivity_retention_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_check_at TEXT,
  last_checked_at TEXT,
  last_completed_at TEXT,
  last_error_code TEXT,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failure_count >= 0),
  last_deleted_finding_count INTEGER NOT NULL DEFAULT 0
    CHECK (last_deleted_finding_count >= 0),
  last_deleted_observation_count INTEGER NOT NULL DEFAULT 0
    CHECK (last_deleted_observation_count >= 0),
  total_deleted_finding_count INTEGER NOT NULL DEFAULT 0
    CHECK (total_deleted_finding_count >= 0),
  total_deleted_observation_count INTEGER NOT NULL DEFAULT 0
    CHECK (total_deleted_observation_count >= 0)
) STRICT;

INSERT INTO sensitivity_retention_maintenance(singleton) VALUES (1);

CREATE INDEX sensitivity_findings_retention
  ON sensitivity_findings(last_seen_at, fingerprint);

CREATE INDEX sensitivity_observations_retention
  ON sensitivity_observations(observed_at, fingerprint, source_identity);
