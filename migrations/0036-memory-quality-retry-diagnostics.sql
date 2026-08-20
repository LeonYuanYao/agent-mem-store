ALTER TABLE memory_quality_items
ADD COLUMN retry_epoch INTEGER NOT NULL DEFAULT 0 CHECK (retry_epoch >= 0);

ALTER TABLE memory_quality_items
ADD COLUMN epoch_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (epoch_attempt_count >= 0);

ALTER TABLE memory_quality_items
ADD COLUMN last_error_diagnostic_json TEXT;

UPDATE memory_quality_items
SET epoch_attempt_count = attempt_count;
