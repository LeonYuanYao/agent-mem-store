ALTER TABLE luna_operations
ADD COLUMN last_error_diagnostic_json TEXT;

ALTER TABLE distillation_batches
ADD COLUMN split_at TEXT;

ALTER TABLE distillation_batches
ADD COLUMN split_reason TEXT;

ALTER TABLE distillation_batches
ADD COLUMN split_parent_batch_id TEXT REFERENCES distillation_batches(batch_id);
