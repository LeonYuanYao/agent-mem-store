CREATE TABLE admission_audit_next (
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
  statement_sha256 TEXT,
  statement_redacted INTEGER NOT NULL CHECK (statement_redacted IN (0, 1)),
  evidence_ids_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(operation_id, candidate_ordinal)
) STRICT;

INSERT INTO admission_audit_next(
  admission_id, operation_id, source_kind, source_id, candidate_ordinal,
  retention_decision, abstraction_level, outcome, reason,
  statement_text, statement_sha256, statement_redacted,
  evidence_ids_json, policy_version, prompt_version, created_at, expires_at
)
SELECT admission_id, operation_id, source_kind, source_id, candidate_ordinal,
       retention_decision, abstraction_level, outcome, reason,
       statement_text,
       CASE WHEN statement_redacted = 1 THEN NULL ELSE statement_sha256 END,
       statement_redacted, evidence_ids_json, policy_version, prompt_version,
       created_at, expires_at
FROM admission_audit;

DROP TABLE admission_audit;
ALTER TABLE admission_audit_next RENAME TO admission_audit;

CREATE INDEX admission_audit_expiration
  ON admission_audit(expires_at, admission_id);

CREATE INDEX admission_audit_shadow_summary
  ON admission_audit(created_at, outcome, retention_decision, reason);
