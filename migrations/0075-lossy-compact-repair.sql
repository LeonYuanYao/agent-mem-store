-- A compact judged lossy gets one rewrite that sees the rejected draft and the
-- assessor's reason (ADR-0160). A second lossy judgment is final.
ALTER TABLE memory_quality_items ADD COLUMN rejected_compact TEXT;
ALTER TABLE memory_quality_items ADD COLUMN rejected_reason_code TEXT;

-- Compacts already rejected as lossy for the current revision of an active Memory get that rewrite now.
UPDATE memory_quality_items
SET state = 'pending_generation',
    rejected_compact = proposed_compact,
    rejected_reason_code = validation_reason_code,
    proposed_compact = NULL,
    rendered_token_count = NULL,
    validation_state = NULL,
    validation_reason_code = NULL,
    epoch_attempt_count = 0,
    completed_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state = 'rejected'
  AND validation_state = 'lossy'
  AND proposed_compact IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM memory_catalog AS catalog
    WHERE catalog.memory_id = memory_quality_items.memory_id
      AND catalog.current_revision_id = memory_quality_items.source_revision_id
      AND catalog.lifecycle = 'active'
  );
