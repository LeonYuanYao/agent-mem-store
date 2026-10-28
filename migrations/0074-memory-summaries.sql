-- Model-written summaries of Human-authored Memory (ADR-0155). An Agent never
-- revises Human-authored Memory, so a summary for one whose body is too long to
-- inject lives here, keyed by the revision it summarizes, and serves only as the
-- compact representation in the retrieval index. A new revision needs a new one.
CREATE TABLE memory_summaries (
  memory_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  rendered_token_count INTEGER NOT NULL CHECK (rendered_token_count > 0),
  generator_identity TEXT NOT NULL,
  validation_reason_code TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, revision_id)
) STRICT;
