CREATE TABLE retrieval_catalog_generations (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  dirty_generation INTEGER NOT NULL CHECK (dirty_generation >= 0),
  published_generation INTEGER NOT NULL CHECK (published_generation >= 0),
  building_generation INTEGER,
  dirty_at TEXT,
  force_due_at TEXT,
  last_completed_at TEXT,
  last_failed_at TEXT,
  CHECK (published_generation <= dirty_generation),
  CHECK (building_generation IS NULL OR building_generation >= 0)
) STRICT;

INSERT INTO retrieval_catalog_generations(
  singleton, dirty_generation, published_generation, building_generation,
  dirty_at, force_due_at, last_completed_at, last_failed_at
) VALUES (1, 0, 0, NULL, NULL, NULL, NULL, NULL);

CREATE TRIGGER memory_catalog_retrieval_generation_insert
AFTER INSERT ON memory_catalog
BEGIN
  UPDATE retrieval_catalog_generations
  SET dirty_generation = dirty_generation + 1,
      dirty_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      force_due_at = COALESCE(
        force_due_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+2 minutes')
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
      dirty_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      force_due_at = COALESCE(
        force_due_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+2 minutes')
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
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+2 minutes')
      )
  WHERE singleton = 1;
END;
