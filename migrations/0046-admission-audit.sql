CREATE TABLE admission_audit (
  admission_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES luna_operations(operation_id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('distillation', 'consolidation')),
  source_id TEXT NOT NULL,
  candidate_ordinal INTEGER NOT NULL CHECK (candidate_ordinal >= 0),
  retention_decision TEXT NOT NULL CHECK (retention_decision IN (
    'long_term', 'project_phase', 'session_only', 'no_memory', 'uncertain'
  )),
  abstraction_level TEXT NOT NULL CHECK (abstraction_level IN (
    'reusable_rule', 'project_fact', 'task_observation'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('admitted', 'rejected', 'isolated')),
  reason TEXT NOT NULL CHECK (reason IN (
    'long_term', 'project_phase', 'session_only', 'no_memory',
    'uncertain', 'task_observation'
  )),
  statement_text TEXT,
  statement_sha256 TEXT NOT NULL,
  statement_redacted INTEGER NOT NULL CHECK (statement_redacted IN (0, 1)),
  evidence_ids_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(operation_id, candidate_ordinal)
) STRICT;

CREATE INDEX admission_audit_expiration
  ON admission_audit(expires_at, admission_id);

CREATE INDEX admission_audit_shadow_summary
  ON admission_audit(created_at, outcome, retention_decision, reason);

CREATE TABLE admission_audit_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_prune_at TEXT NOT NULL,
  last_pruned_at TEXT
) STRICT;

INSERT INTO admission_audit_maintenance(singleton, next_prune_at)
VALUES (1, '1970-01-01T00:00:00.000Z');
