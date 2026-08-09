CREATE TABLE official_shadow_windows (
  window_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  candidate_sha256 TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  probe_event_id TEXT NOT NULL REFERENCES shadow_event_evaluations(event_id),
  state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'invalidated')),
  started_at TEXT NOT NULL,
  minimum_end_at TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  baseline_sha256 TEXT NOT NULL,
  ended_at TEXT,
  invalidation_reason TEXT
) STRICT;

CREATE UNIQUE INDEX one_active_official_shadow_window
  ON official_shadow_windows(state) WHERE state = 'active';
