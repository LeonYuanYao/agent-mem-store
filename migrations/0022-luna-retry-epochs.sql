ALTER TABLE luna_operations
ADD COLUMN retry_epoch INTEGER NOT NULL DEFAULT 0 CHECK (retry_epoch >= 0);

ALTER TABLE luna_operations
ADD COLUMN epoch_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (epoch_attempt_count >= 0);
