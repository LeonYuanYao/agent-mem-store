CREATE TABLE memory_ranking_exclusions (
  memory_id TEXT PRIMARY KEY REFERENCES memory_catalog(memory_id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  space_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'capacity_cold'),
  excluded_at TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
) STRICT;

CREATE INDEX memory_ranking_exclusions_space
  ON memory_ranking_exclusions(space_key, excluded_at, memory_id);

CREATE TABLE memory_working_set_generations (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  dirty_generation INTEGER NOT NULL DEFAULT 0 CHECK (dirty_generation >= 0),
  published_generation INTEGER NOT NULL DEFAULT 0 CHECK (published_generation >= 0),
  dirty_at TEXT,
  last_rebalanced_at TEXT,
  last_published_at TEXT,
  last_error TEXT,
  publication_next_retry_at TEXT,
  publication_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (publication_failure_count >= 0)
) STRICT;

INSERT INTO memory_working_set_generations(singleton) VALUES (1);

CREATE TRIGGER memory_candidate_pin_reactivates_working_set
AFTER UPDATE OF pinned, promoted_memory_id ON memory_candidates
WHEN NEW.pinned = 1 AND NEW.promoted_memory_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM memory_ranking_exclusions WHERE memory_id = NEW.promoted_memory_id)
BEGIN
  DELETE FROM memory_ranking_exclusions WHERE memory_id = NEW.promoted_memory_id;
  UPDATE memory_working_set_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = NEW.updated_at,
      last_error = NULL
  WHERE singleton = 1;
END;

CREATE TRIGGER memory_review_reactivates_working_set_insert
AFTER INSERT ON governance_review_suggestions
WHEN NEW.state = 'open'
  AND EXISTS(SELECT 1 FROM memory_ranking_exclusions WHERE memory_id = NEW.target_memory_id)
BEGIN
  DELETE FROM memory_ranking_exclusions WHERE memory_id = NEW.target_memory_id;
  UPDATE memory_working_set_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = NEW.created_at,
      last_error = NULL
  WHERE singleton = 1;
END;

CREATE TRIGGER memory_review_reactivates_working_set_update
AFTER UPDATE OF state ON governance_review_suggestions
WHEN NEW.state = 'open'
  AND EXISTS(SELECT 1 FROM memory_ranking_exclusions WHERE memory_id = NEW.target_memory_id)
BEGIN
  DELETE FROM memory_ranking_exclusions WHERE memory_id = NEW.target_memory_id;
  UPDATE memory_working_set_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = COALESCE(NEW.resolved_at, NEW.created_at),
      last_error = NULL
  WHERE singleton = 1;
END;

CREATE TRIGGER memory_verification_reactivates_working_set_insert
AFTER INSERT ON verification_requests
WHEN NEW.state = 'open' AND EXISTS(
  SELECT 1 FROM memory_ranking_exclusions
  WHERE memory_id = (
    SELECT promoted_memory_id FROM memory_candidates WHERE candidate_id = NEW.candidate_id
  )
)
BEGIN
  DELETE FROM memory_ranking_exclusions
  WHERE memory_id = (
    SELECT promoted_memory_id FROM memory_candidates WHERE candidate_id = NEW.candidate_id
  );
  UPDATE memory_working_set_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = NEW.created_at,
      last_error = NULL
  WHERE singleton = 1;
END;

CREATE TRIGGER memory_verification_reactivates_working_set_update
AFTER UPDATE OF state ON verification_requests
WHEN NEW.state = 'open' AND EXISTS(
  SELECT 1 FROM memory_ranking_exclusions
  WHERE memory_id = (
    SELECT promoted_memory_id FROM memory_candidates WHERE candidate_id = NEW.candidate_id
  )
)
BEGIN
  DELETE FROM memory_ranking_exclusions
  WHERE memory_id = (
    SELECT promoted_memory_id FROM memory_candidates WHERE candidate_id = NEW.candidate_id
  );
  UPDATE memory_working_set_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = COALESCE(NEW.completed_at, NEW.created_at),
      last_error = NULL
  WHERE singleton = 1;
END;

CREATE TRIGGER memory_conflict_reactivates_working_set_insert
AFTER INSERT ON human_memory_conflicts
WHEN NEW.state = 'open' AND EXISTS(
  SELECT 1 FROM memory_ranking_exclusions
  WHERE memory_id = NEW.proposed_memory_id
     OR memory_id IN (SELECT value FROM json_each(NEW.conflicting_memory_ids_json))
)
BEGIN
  DELETE FROM memory_ranking_exclusions
  WHERE memory_id = NEW.proposed_memory_id
     OR memory_id IN (SELECT value FROM json_each(NEW.conflicting_memory_ids_json));
  UPDATE memory_working_set_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = NEW.created_at,
      last_error = NULL
  WHERE singleton = 1;
END;

CREATE TRIGGER memory_conflict_reactivates_working_set_update
AFTER UPDATE OF state ON human_memory_conflicts
WHEN NEW.state = 'open' AND EXISTS(
  SELECT 1 FROM memory_ranking_exclusions
  WHERE memory_id = NEW.proposed_memory_id
     OR memory_id IN (SELECT value FROM json_each(NEW.conflicting_memory_ids_json))
)
BEGIN
  DELETE FROM memory_ranking_exclusions
  WHERE memory_id = NEW.proposed_memory_id
     OR memory_id IN (SELECT value FROM json_each(NEW.conflicting_memory_ids_json));
  UPDATE memory_working_set_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = COALESCE(NEW.resolved_at, NEW.created_at),
      last_error = NULL
  WHERE singleton = 1;
END;

CREATE INDEX retrieval_receipts_capacity_activity
  ON retrieval_receipts(created_at, receipt_id);

ALTER TABLE memory_capacity_obligations
  ADD COLUMN mandatory_count INTEGER NOT NULL DEFAULT 0
  CHECK (mandatory_count >= 0);

ALTER TABLE memory_capacity_obligations
  ADD COLUMN hard_protected_count INTEGER NOT NULL DEFAULT 0
  CHECK (hard_protected_count >= 0);

ALTER TABLE memory_capacity_obligations
  ADD COLUMN ranking_excluded_count INTEGER NOT NULL DEFAULT 0
  CHECK (ranking_excluded_count >= 0);

ALTER TABLE memory_capacity_obligations
  ADD COLUMN low_water_unreachable INTEGER NOT NULL DEFAULT 0
  CHECK (low_water_unreachable IN (0, 1));

ALTER TABLE memory_capacity_obligations
  ADD COLUMN last_rebalanced_at TEXT;

ALTER TABLE memory_capacity_obligations
  ADD COLUMN last_error TEXT;

ALTER TABLE memory_capacity_obligations
  ADD COLUMN consecutive_failure_count INTEGER NOT NULL DEFAULT 0
  CHECK (consecutive_failure_count >= 0);

UPDATE memory_capacity_obligations
SET state = 'pending', run_id = NULL,
    next_review_at = COALESCE(next_review_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    satisfied_at = NULL
WHERE state = 'linked';

UPDATE governance_obligations
SET state = 'pending', run_id = NULL, satisfied_at = NULL
WHERE state = 'linked'
  AND run_id IN (
    SELECT run_id FROM governance_runs
    WHERE capacity_triggered = 1
      AND state IN ('pending', 'processing', 'retrying', 'blocked')
  );

UPDATE governance_runs
SET state = 'completed', capacity_triggered = 0,
    summary_json = '{"summaryItems":["Retired legacy capacity archival work during reversible working-set migration; ordinary governance will be rescheduled from its prior cursor."]}',
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE capacity_triggered = 1
  AND state IN ('pending', 'processing', 'retrying', 'blocked');

UPDATE governance_runs
SET capacity_triggered = 0
WHERE capacity_triggered = 1;
