CREATE TABLE archive_purge_runs (
  run_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('processing', 'yielded', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  next_eligible_at TEXT,
  body_limit INTEGER NOT NULL CHECK (body_limit > 0 AND body_limit <= 200),
  byte_limit INTEGER NOT NULL CHECK (byte_limit > 0 AND byte_limit <= 134217728),
  duration_limit_ms INTEGER NOT NULL CHECK (duration_limit_ms > 0 AND duration_limit_ms <= 60000),
  purged_count INTEGER NOT NULL DEFAULT 0 CHECK (purged_count >= 0),
  removed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (removed_bytes >= 0),
  last_error_code TEXT
) STRICT;

CREATE UNIQUE INDEX one_active_archive_purge_run
  ON archive_purge_runs((1)) WHERE state IN ('processing', 'yielded');

CREATE TABLE archive_purge_items (
  item_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES archive_purge_runs(run_id),
  memory_id TEXT NOT NULL,
  expected_revision_id TEXT NOT NULL,
  expected_content_identity TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  backup_sha256 TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  removable_bytes INTEGER NOT NULL CHECK (removable_bytes >= 0),
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'tombstone_written', 'revision_bodies_removed', 'catalog_committed', 'completed', 'skipped')
  ),
  tombstone_content_identity TEXT,
  purged_at TEXT,
  skip_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(memory_id, expected_content_identity)
) STRICT;

CREATE INDEX archive_purge_items_resume
  ON archive_purge_items(state, run_id, memory_id);
