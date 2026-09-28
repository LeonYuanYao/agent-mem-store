ALTER TABLE governance_runs ADD COLUMN connection_recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (connection_recovery_count >= 0);
ALTER TABLE memory_quality_items ADD COLUMN connection_recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (connection_recovery_count >= 0);
ALTER TABLE memory_duplicate_clusters ADD COLUMN connection_recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (connection_recovery_count >= 0);
ALTER TABLE memory_duplicate_clusters ADD COLUMN epoch_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (epoch_attempt_count >= 0);
UPDATE memory_duplicate_clusters SET epoch_attempt_count = attempt_count;
-- Legacy duplicate work stopped at six attempts; retain its exhausted budget
-- without changing lifetime attempts or restarting its fast-retry sequence.
UPDATE memory_duplicate_clusters SET epoch_attempt_count = 7
WHERE state = 'blocked' AND epoch_attempt_count = 6;
-- A successfully generated draft starts a separate validation step.
UPDATE memory_quality_items SET epoch_attempt_count = 0
WHERE state = 'pending_validation';
