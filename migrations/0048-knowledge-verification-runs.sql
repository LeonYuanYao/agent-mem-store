CREATE TABLE knowledge_verification_runs (
  run_id TEXT PRIMARY KEY,
  policy_version TEXT NOT NULL,
  reviewer_kind TEXT NOT NULL CHECK (
    reviewer_kind IN ('human', 'model_proposed_human_confirmed')
  ),
  source_window_start TEXT NOT NULL,
  source_window_end TEXT NOT NULL,
  sample_frame_json TEXT NOT NULL,
  units_json TEXT NOT NULL,
  matched_durable_count INTEGER NOT NULL CHECK (matched_durable_count >= 0),
  missed_durable_count INTEGER NOT NULL CHECK (missed_durable_count >= 0),
  correct_omission_count INTEGER NOT NULL CHECK (correct_omission_count >= 0),
  ambiguous_count INTEGER NOT NULL CHECK (ambiguous_count >= 0),
  recall REAL CHECK (recall IS NULL OR (recall >= 0 AND recall <= 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX knowledge_verification_runs_created
  ON knowledge_verification_runs(created_at, run_id);
