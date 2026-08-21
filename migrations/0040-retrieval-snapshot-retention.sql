ALTER TABLE retrieval_index_revisions
ADD COLUMN snapshot_pruned_at TEXT;

ALTER TABLE retrieval_index_revisions
ADD COLUMN snapshot_fts_pruned_rows INTEGER NOT NULL DEFAULT 0
CHECK (snapshot_fts_pruned_rows >= 0);

CREATE INDEX retrieval_index_revisions_pruning
ON retrieval_index_revisions(snapshot_pruned_at, built_at, index_revision_id);
