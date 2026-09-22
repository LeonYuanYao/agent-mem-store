ALTER TABLE luna_operations
  ADD COLUMN connection_recovery_count INTEGER NOT NULL DEFAULT 0
  CHECK (connection_recovery_count >= 0);
