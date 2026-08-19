ALTER TABLE governance_runs
ADD COLUMN consecutive_failure_count INTEGER NOT NULL DEFAULT 0
CHECK (consecutive_failure_count >= 0);
