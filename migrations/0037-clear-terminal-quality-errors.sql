UPDATE memory_quality_items
SET last_error_category = NULL,
    last_error_diagnostic_json = NULL
WHERE state IN ('completed', 'rejected', 'stale');
