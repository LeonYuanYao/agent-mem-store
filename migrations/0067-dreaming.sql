-- Nightly dreaming: session-level extraction, repository verification and tiering.
-- Shadow mode records results and a Vault report only; it never writes canonical Memory.

CREATE TABLE dream_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'apply')),
  stage TEXT NOT NULL CHECK (stage IN (
    'select', 'extract', 'merge', 'prepare', 'verify', 'defend', 'tier', 'report', 'completed', 'failed'
  )),
  window_end TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}',
  report_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (project_id, scheduled_for)
) STRICT;

CREATE INDEX dream_runs_open ON dream_runs(stage) WHERE stage NOT IN ('completed', 'failed');

-- One row per captured Session once a run has claimed it; a Session is extracted exactly once.
CREATE TABLE dream_sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES dream_runs(run_id),
  first_event_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  branch_json TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE dream_chunks (
  run_id TEXT NOT NULL REFERENCES dream_runs(run_id),
  session_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  PRIMARY KEY (run_id, session_id, chunk_index)
) STRICT;

CREATE TABLE dream_candidates (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES dream_runs(run_id),
  session_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  statement TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  explicit_user INTEGER NOT NULL CHECK (explicit_user IN (0, 1)),
  quote_found INTEGER NOT NULL CHECK (quote_found IN (0, 1)),
  check_hints_json TEXT NOT NULL,
  source_paths_json TEXT NOT NULL
) STRICT;

CREATE INDEX dream_candidates_run ON dream_candidates(run_id);

CREATE TABLE dream_items (
  item_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES dream_runs(run_id),
  statement TEXT NOT NULL,
  refined_statement TEXT,
  claim_type TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  member_ids_json TEXT NOT NULL,
  session_ids_json TEXT NOT NULL,
  explicit_user INTEGER NOT NULL CHECK (explicit_user IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  check_hints_json TEXT NOT NULL,
  source_paths_json TEXT NOT NULL,
  presearch_json TEXT,
  source_branches_json TEXT,
  verdict_json TEXT,
  defense_json TEXT,
  tier TEXT CHECK (tier IN ('inject', 'branch', 'pool', 'review', 'drop')),
  tier_reason TEXT
) STRICT;

CREATE INDEX dream_items_run ON dream_items(run_id);
