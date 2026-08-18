CREATE TABLE candidate_reevaluation_backfill (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'completed')),
  last_candidate_id TEXT,
  scanned_candidate_count INTEGER NOT NULL DEFAULT 0
    CHECK (scanned_candidate_count >= 0),
  reopened_candidate_count INTEGER NOT NULL DEFAULT 0
    CHECK (reopened_candidate_count >= 0),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO candidate_reevaluation_backfill(
  singleton, state, updated_at
) VALUES (1, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
