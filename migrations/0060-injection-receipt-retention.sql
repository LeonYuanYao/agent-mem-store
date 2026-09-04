CREATE TABLE injection_receipt_retention_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_check_at TEXT,
  last_checked_at TEXT,
  last_completed_at TEXT,
  last_error_code TEXT,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failure_count >= 0),
  last_deleted_receipt_count INTEGER NOT NULL DEFAULT 0
    CHECK (last_deleted_receipt_count >= 0),
  last_deleted_item_count INTEGER NOT NULL DEFAULT 0
    CHECK (last_deleted_item_count >= 0),
  last_protected_receipt_count INTEGER NOT NULL DEFAULT 0
    CHECK (last_protected_receipt_count >= 0),
  total_deleted_receipt_count INTEGER NOT NULL DEFAULT 0
    CHECK (total_deleted_receipt_count >= 0),
  total_deleted_item_count INTEGER NOT NULL DEFAULT 0
    CHECK (total_deleted_item_count >= 0)
) STRICT;

INSERT INTO injection_receipt_retention_maintenance(singleton) VALUES (1);

CREATE TABLE retrieval_receipt_daily_summaries (
  summary_date TEXT NOT NULL,
  caller_kind TEXT NOT NULL CHECK (caller_kind IN ('session_start', 'user_prompt', 'explicit')),
  receipt_count INTEGER NOT NULL CHECK (receipt_count >= 0),
  rendered_token_count INTEGER NOT NULL CHECK (rendered_token_count >= 0),
  selected_item_count INTEGER NOT NULL CHECK (selected_item_count >= 0),
  omitted_item_count INTEGER NOT NULL CHECK (omitted_item_count >= 0),
  latency_ms_total REAL NOT NULL CHECK (latency_ms_total >= 0),
  PRIMARY KEY (summary_date, caller_kind)
) STRICT;
