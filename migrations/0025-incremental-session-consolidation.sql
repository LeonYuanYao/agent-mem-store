ALTER TABLE session_consolidations
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1);

ALTER TABLE session_consolidations
  ADD COLUMN from_batch_ordinal INTEGER NOT NULL DEFAULT -1 CHECK (from_batch_ordinal >= -1);

ALTER TABLE session_consolidations
  ADD COLUMN through_batch_ordinal INTEGER NOT NULL DEFAULT -1 CHECK (through_batch_ordinal >= -1);

UPDATE session_consolidations
SET through_batch_ordinal = COALESCE((
  SELECT MAX(batch.batch_ordinal)
  FROM distillation_batches AS batch
  WHERE batch.session_id = session_consolidations.session_id
    AND batch.split_at IS NULL
    AND batch.created_at <= session_consolidations.created_at
), -1);

UPDATE session_consolidations
SET from_batch_ordinal = 0
WHERE through_batch_ordinal >= 0;

CREATE TABLE session_distillation_cursors (
  session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  through_batch_ordinal INTEGER NOT NULL CHECK (through_batch_ordinal >= 0),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO session_distillation_cursors(
  session_id, generation, through_batch_ordinal, updated_at
)
SELECT session_id, generation, through_batch_ordinal, completed_at
FROM session_consolidations
WHERE state = 'completed'
  AND completed_at IS NOT NULL
  AND through_batch_ordinal >= 0;

INSERT OR IGNORE INTO session_distillation_cursors(
  session_id, generation, through_batch_ordinal, updated_at
)
SELECT batch.session_id, 1, MAX(batch.batch_ordinal), MAX(batch.completed_at)
FROM distillation_batches AS batch
WHERE batch.state = 'completed'
  AND batch.split_at IS NULL
  AND (
    batch.source_selector IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM distillation_batch_events AS assigned
      JOIN capture_events AS capture ON capture.event_id = assigned.event_id
      WHERE assigned.batch_id = batch.batch_id
        AND capture.event_kind = 'SessionEnd'
    )
  )
  AND EXISTS (
    SELECT 1 FROM memory_candidates AS candidate
    WHERE candidate.source_session_id = batch.session_id
  )
  AND 1 = (
    SELECT COUNT(*)
    FROM distillation_batches AS session_batch
    WHERE session_batch.session_id = batch.session_id
      AND session_batch.state = 'completed'
      AND session_batch.split_at IS NULL
  )
GROUP BY batch.session_id
HAVING COUNT(*) = 1;
