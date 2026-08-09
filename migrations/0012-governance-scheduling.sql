CREATE TABLE governance_schedule (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  time_zone TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  startup_delay_seconds INTEGER NOT NULL CHECK (startup_delay_seconds >= 0),
  page_size INTEGER NOT NULL CHECK (page_size > 0 AND page_size <= 500)
) STRICT;

CREATE TABLE governance_cursors (
  cadence TEXT PRIMARY KEY CHECK (cadence IN ('weekly', 'monthly')),
  successful_through TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE governance_runs (
  run_id TEXT PRIMARY KEY,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('weekly', 'monthly')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'retrying', 'blocked', 'completed')),
  includes_weekly INTEGER NOT NULL CHECK (includes_weekly IN (0, 1)),
  weekly_from TEXT,
  monthly_from TEXT,
  coverage_through TEXT NOT NULL,
  recovered_occurrence_count INTEGER NOT NULL CHECK (recovered_occurrence_count > 0),
  current_phase TEXT NOT NULL CHECK (current_phase IN ('weekly', 'monthly', 'finalize')),
  next_retry_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_category TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE UNIQUE INDEX one_active_governance_run
  ON governance_runs((1)) WHERE state IN ('pending', 'processing', 'retrying', 'blocked');

CREATE TABLE governance_obligations (
  obligation_id TEXT PRIMARY KEY,
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
  due_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'linked', 'satisfied')),
  run_id TEXT REFERENCES governance_runs(run_id),
  satisfied_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(cadence, due_at)
) STRICT;

CREATE INDEX governance_obligations_ready
  ON governance_obligations(state, due_at, cadence);

CREATE TABLE governance_run_members (
  run_id TEXT NOT NULL REFERENCES governance_runs(run_id),
  phase TEXT NOT NULL CHECK (phase IN ('weekly', 'monthly')),
  memory_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  member_ordinal INTEGER NOT NULL CHECK (member_ordinal >= 0),
  PRIMARY KEY (run_id, phase, memory_id),
  UNIQUE (run_id, phase, member_ordinal)
) STRICT;

CREATE TABLE governance_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES governance_runs(run_id),
  phase TEXT NOT NULL CHECK (phase IN ('weekly', 'monthly')),
  page_ordinal INTEGER NOT NULL CHECK (page_ordinal >= 0),
  page_last_memory_id TEXT,
  input_json TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  output_json TEXT,
  output_sha256 TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'model_processing', 'reviewed', 'applied')),
  lease_token TEXT,
  leased_by TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE(run_id, phase, page_ordinal)
) STRICT;

CREATE TABLE governance_actions (
  action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES governance_runs(run_id),
  checkpoint_id TEXT NOT NULL REFERENCES governance_checkpoints(checkpoint_id),
  action_key TEXT NOT NULL UNIQUE,
  action_kind TEXT NOT NULL CHECK (
    action_kind IN ('archive', 'supersede', 'relationship', 'review_suggestion', 'future_purge')
  ),
  target_memory_id TEXT,
  result_json TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE governance_review_suggestions (
  suggestion_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES governance_runs(run_id),
  target_memory_id TEXT NOT NULL,
  suggestion_kind TEXT NOT NULL CHECK (suggestion_kind IN ('conflict', 'outdated', 'relationship', 'other')),
  reason TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'accepted', 'dismissed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(run_id, target_memory_id, suggestion_kind, reason)
) STRICT;

CREATE TABLE future_purge_obligations (
  purge_obligation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES governance_runs(run_id),
  memory_id TEXT NOT NULL,
  not_before TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'cancelled', 'completed')),
  created_at TEXT NOT NULL,
  UNIQUE(run_id, memory_id, not_before)
) STRICT;

CREATE TABLE retrieval_index_build_activity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  build_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building', 'complete', 'failed')),
  started_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  completed_at TEXT
) STRICT;
