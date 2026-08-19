CREATE TABLE memory_duplicate_clusters (
  cluster_id TEXT PRIMARY KEY,
  index_revision_id TEXT NOT NULL,
  left_memory_id TEXT NOT NULL,
  left_revision_id TEXT NOT NULL,
  right_memory_id TEXT NOT NULL,
  right_revision_id TEXT NOT NULL,
  similarity REAL NOT NULL CHECK (similarity >= -1 AND similarity <= 1),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'processing', 'retrying', 'blocked', 'completed', 'rejected', 'stale'
  )),
  decision TEXT CHECK (decision IS NULL OR decision IN (
    'equivalent', 'left_subsumes_right', 'right_subsumes_left',
    'conflicts', 'unrelated', 'uncertain'
  )),
  reason_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TEXT,
  last_error_category TEXT,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(left_memory_id, left_revision_id, right_memory_id, right_revision_id),
  CHECK (left_memory_id < right_memory_id)
) STRICT;

CREATE INDEX memory_duplicate_clusters_ready
ON memory_duplicate_clusters(state, next_retry_at, created_at);
