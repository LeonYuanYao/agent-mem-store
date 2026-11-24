-- Rules of the user's own become suggestions the user accepts or dismisses (ADR-0191): a new
-- `suggest` tier. SQLite cannot change a CHECK constraint in place, so the table is rebuilt.
-- A suggestion's outcome is its apply_state: NULL while open, then 'accepted' (apply_memory_id
-- names the Human-authored Memory written) or 'dismissed'.
CREATE TABLE dream_items_next (
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
  tier TEXT CHECK (tier IN ('inject', 'suggest', 'branch', 'pool', 'review', 'drop')),
  tier_reason TEXT,
  apply_state TEXT,
  apply_memory_id TEXT,
  apply_reason TEXT,
  detail TEXT,
  appraisal_json TEXT
) STRICT;

INSERT INTO dream_items_next(
  item_id, run_id, statement, refined_statement, claim_type, scope, member_ids_json, session_ids_json,
  explicit_user, first_seen_at, check_hints_json, source_paths_json, presearch_json, source_branches_json,
  verdict_json, defense_json, tier, tier_reason, apply_state, apply_memory_id, apply_reason, detail, appraisal_json
)
SELECT item_id, run_id, statement, refined_statement, claim_type, scope, member_ids_json, session_ids_json,
       explicit_user, first_seen_at, check_hints_json, source_paths_json, presearch_json, source_branches_json,
       verdict_json, defense_json, tier, tier_reason, apply_state, apply_memory_id, apply_reason, detail, appraisal_json
FROM dream_items;

DROP TABLE dream_items;
ALTER TABLE dream_items_next RENAME TO dream_items;

CREATE INDEX dream_items_run ON dream_items(run_id);
CREATE INDEX dream_items_open_suggestions ON dream_items(tier, apply_state) WHERE tier = 'suggest';
