CREATE TABLE sensitivity_findings (
  finding_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('blocked_secret', 'quarantined')),
  category TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  body_retained INTEGER NOT NULL DEFAULT 0 CHECK (body_retained = 0)
) STRICT;

CREATE TABLE sensitivity_observations (
  fingerprint TEXT NOT NULL REFERENCES sensitivity_findings(fingerprint),
  source_identity TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (fingerprint, source_identity)
) STRICT;
