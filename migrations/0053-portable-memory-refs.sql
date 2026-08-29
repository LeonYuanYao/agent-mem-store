ALTER TABLE memory_catalog
  ADD COLUMN memory_ref INTEGER CHECK (memory_ref > 0);

WITH ordered AS (
  SELECT memory_id, ROW_NUMBER() OVER (ORDER BY memory_id) AS assigned_ref
  FROM memory_catalog
)
UPDATE memory_catalog
SET memory_ref = (
  SELECT assigned_ref FROM ordered WHERE ordered.memory_id = memory_catalog.memory_id
);

CREATE UNIQUE INDEX memory_catalog_memory_ref
  ON memory_catalog(memory_ref);

CREATE TABLE memory_ref_reservations (
  memory_id TEXT PRIMARY KEY,
  memory_ref INTEGER NOT NULL UNIQUE CHECK (memory_ref > 0),
  reserved_at TEXT NOT NULL
) STRICT;

INSERT INTO memory_ref_reservations(memory_id, memory_ref, reserved_at)
SELECT memory_id, memory_ref, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM memory_catalog;

CREATE TABLE memory_ref_allocator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_ref INTEGER NOT NULL CHECK (next_ref > 0)
) STRICT;

INSERT INTO memory_ref_allocator(singleton, next_ref)
SELECT 1, COALESCE(MAX(memory_ref), 0) + 1 FROM memory_ref_reservations;

ALTER TABLE retrieval_documents
  ADD COLUMN memory_ref INTEGER CHECK (memory_ref > 0);

UPDATE retrieval_documents
SET memory_ref = (
  SELECT catalog.memory_ref
  FROM memory_catalog AS catalog
  WHERE catalog.memory_id = retrieval_documents.memory_id
);

CREATE INDEX retrieval_documents_memory_ref
  ON retrieval_documents(index_revision_id, memory_ref);
