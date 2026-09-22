CREATE TABLE active_capacity_admissions (
  memory_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  owner_pid INTEGER NOT NULL,
  canonical_path TEXT NOT NULL,
  reserved_at TEXT NOT NULL
) STRICT;

CREATE TABLE active_capacity_waiters (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id) ON DELETE CASCADE,
  evidence_generation INTEGER NOT NULL,
  assessment_operation_id TEXT,
  waiting_since TEXT NOT NULL
) STRICT;
