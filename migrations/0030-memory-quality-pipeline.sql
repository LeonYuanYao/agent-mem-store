CREATE TABLE memory_quality_items (
  item_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  source_content_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending_generation',
    'processing_generation',
    'retrying_generation',
    'pending_validation',
    'processing_validation',
    'retrying_validation',
    'blocked',
    'rejected',
    'stale',
    'completed'
  )),
  proposed_compact TEXT,
  rendered_token_count INTEGER CHECK (rendered_token_count IS NULL OR rendered_token_count >= 0),
  generator_identity TEXT,
  validation_state TEXT CHECK (
    validation_state IS NULL OR validation_state IN ('preserves', 'lossy', 'uncertain')
  ),
  validation_reason_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TEXT,
  last_error_category TEXT,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(memory_id, source_revision_id)
) STRICT;

CREATE INDEX memory_quality_items_ready
ON memory_quality_items(state, next_retry_at, created_at);
