CREATE TABLE candidate_maintenance_runs (
  governance_run_id TEXT PRIMARY KEY REFERENCES governance_runs(run_id),
  completed_at TEXT NOT NULL,
  result_json TEXT NOT NULL
) STRICT;
