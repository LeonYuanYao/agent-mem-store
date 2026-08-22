CREATE TABLE official_shadow_windows_next (
  window_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  candidate_sha256 TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  probe_event_id TEXT NOT NULL REFERENCES shadow_event_evaluations(event_id),
  state TEXT NOT NULL CHECK (state IN ('active', 'completed')),
  started_at TEXT NOT NULL,
  minimum_end_at TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  baseline_sha256 TEXT NOT NULL,
  ended_at TEXT
) STRICT;

INSERT INTO official_shadow_windows_next(
  window_id, candidate_id, candidate_sha256, installation_id,
  probe_event_id, state, started_at, minimum_end_at,
  baseline_json, baseline_sha256, ended_at
)
SELECT window_id, candidate_id, candidate_sha256, installation_id,
       probe_event_id,
       CASE state WHEN 'invalidated' THEN 'completed' ELSE state END,
       started_at, minimum_end_at, baseline_json, baseline_sha256,
       CASE
         WHEN state = 'invalidated' THEN COALESCE(ended_at, minimum_end_at)
         ELSE ended_at
       END
FROM official_shadow_windows;

DROP TABLE official_shadow_windows;
ALTER TABLE official_shadow_windows_next RENAME TO official_shadow_windows;

CREATE UNIQUE INDEX one_active_official_shadow_window
  ON official_shadow_windows(state) WHERE state = 'active';
