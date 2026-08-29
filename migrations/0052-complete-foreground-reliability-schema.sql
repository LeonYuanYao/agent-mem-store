CREATE TABLE foreground_attempt_overflow (
  bucket_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'completed', 'empty', 'busy', 'deadline_exceeded',
    'cancelled', 'unavailable', 'failed'
  )),
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  PRIMARY KEY (bucket_at, outcome)
) STRICT;

CREATE TABLE foreground_attempt_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_prune_at TEXT NOT NULL
) STRICT;

INSERT INTO foreground_attempt_maintenance(singleton, next_prune_at)
VALUES (1, '1970-01-01T00:00:00.000Z');

CREATE TABLE foreground_event_reservations (
  event_id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('SessionStart', 'UserPromptSubmit')),
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'retrying')),
  receipt_id TEXT REFERENCES retrieval_receipts(receipt_id),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  last_error_code TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX foreground_event_reservations_retry
  ON foreground_event_reservations(state, next_retry_at, updated_at);

ALTER TABLE retrieval_catalog_generations
  ADD COLUMN quiet_period_ms INTEGER NOT NULL DEFAULT 30000
  CHECK (quiet_period_ms BETWEEN 1000 AND 300000);

ALTER TABLE retrieval_catalog_generations
  ADD COLUMN maximum_staleness_ms INTEGER NOT NULL DEFAULT 120000
  CHECK (maximum_staleness_ms BETWEEN 30000 AND 3600000);

DROP TRIGGER memory_catalog_retrieval_generation_insert;
DROP TRIGGER memory_catalog_retrieval_generation_update;
DROP TRIGGER memory_catalog_retrieval_generation_delete;

CREATE TRIGGER memory_catalog_retrieval_generation_insert
AFTER INSERT ON memory_catalog
BEGIN
  UPDATE retrieval_catalog_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = NEW.catalog_updated_at,
      force_due_at = COALESCE(
        force_due_at,
        strftime(
          '%Y-%m-%dT%H:%M:%fZ', NEW.catalog_updated_at,
          printf('+%f seconds', maximum_staleness_ms / 1000.0)
        )
      )
  WHERE singleton = 1;
END;

CREATE TRIGGER memory_catalog_retrieval_generation_update
AFTER UPDATE OF current_revision_id, content_identity, lifecycle, sensitivity,
  scope_kind, project_id, authority ON memory_catalog
WHEN OLD.current_revision_id IS NOT NEW.current_revision_id
  OR OLD.content_identity IS NOT NEW.content_identity
  OR OLD.lifecycle IS NOT NEW.lifecycle
  OR OLD.sensitivity IS NOT NEW.sensitivity
  OR OLD.scope_kind IS NOT NEW.scope_kind
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.authority IS NOT NEW.authority
BEGIN
  UPDATE retrieval_catalog_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = NEW.catalog_updated_at,
      force_due_at = COALESCE(
        force_due_at,
        strftime(
          '%Y-%m-%dT%H:%M:%fZ', NEW.catalog_updated_at,
          printf('+%f seconds', maximum_staleness_ms / 1000.0)
        )
      )
  WHERE singleton = 1;
END;

CREATE TRIGGER memory_catalog_retrieval_generation_delete
AFTER DELETE ON memory_catalog
BEGIN
  UPDATE retrieval_catalog_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      force_due_at = COALESCE(
        force_due_at,
        strftime(
          '%Y-%m-%dT%H:%M:%fZ', 'now',
          printf('+%f seconds', maximum_staleness_ms / 1000.0)
        )
      )
  WHERE singleton = 1;
END;
