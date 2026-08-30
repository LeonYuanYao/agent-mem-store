ALTER TABLE governance_runs
  ADD COLUMN capacity_triggered INTEGER NOT NULL DEFAULT 0
  CHECK (capacity_triggered IN (0, 1));

CREATE TABLE memory_capacity_obligations (
  space_key TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'global')),
  project_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'linked', 'satisfied')),
  active_count INTEGER NOT NULL CHECK (active_count >= 0),
  target_count INTEGER NOT NULL CHECK (target_count > 0),
  hard_limit INTEGER NOT NULL CHECK (hard_limit > target_count),
  low_water INTEGER NOT NULL CHECK (low_water >= 0 AND low_water < target_count),
  cold_days INTEGER NOT NULL CHECK (cold_days > 0),
  governance_batch_size INTEGER NOT NULL CHECK (
    governance_batch_size > 0 AND governance_batch_size <= 50
  ),
  first_exceeded_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  next_review_at TEXT,
  run_id TEXT REFERENCES governance_runs(run_id),
  satisfied_at TEXT,
  CHECK (
    (scope_kind = 'project' AND project_id IS NOT NULL AND space_key = 'project:' || project_id)
    OR (scope_kind = 'global' AND project_id IS NULL AND space_key = 'global')
  )
) STRICT;

CREATE INDEX memory_capacity_obligations_ready
  ON memory_capacity_obligations(state, next_review_at, active_count);
