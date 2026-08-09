CREATE TABLE human_global_authorizations (
  authorization_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  source_identity TEXT NOT NULL,
  statement_identity TEXT NOT NULL,
  maximum_sensitivity TEXT NOT NULL CHECK (maximum_sensitivity IN ('normal', 'private')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE memory_candidates (
  candidate_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'global')),
  project_id TEXT,
  statement TEXT,
  candidate_json TEXT,
  category TEXT NOT NULL,
  certainty TEXT NOT NULL CHECK (certainty IN ('asserted', 'inferred', 'speculative')),
  state TEXT NOT NULL CHECK (state IN ('waiting', 'promoted', 'merged', 'conflict', 'rejected', 'expired')),
  high_value INTEGER NOT NULL CHECK (high_value IN (0, 1)),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'private')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  global_authorization_id TEXT REFERENCES human_global_authorizations(authorization_id),
  global_authorization_operation_id TEXT,
  global_authorization_source_identity TEXT,
  source_session_id TEXT,
  created_at TEXT NOT NULL,
  last_evidence_at TEXT NOT NULL,
  evidence_generation INTEGER NOT NULL DEFAULT 1 CHECK (evidence_generation >= 1),
  updated_at TEXT NOT NULL,
  promoted_memory_id TEXT,
  promotion_revision_id TEXT,
  promotion_generation INTEGER,
  successful_evaluation_at TEXT,
  predecessor_tombstone_candidate_id TEXT,
  CHECK ((scope_kind = 'project' AND project_id IS NOT NULL) OR
         (scope_kind = 'global' AND project_id IS NULL))
) STRICT;

CREATE TABLE candidate_evidence (
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id),
  evidence_id TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  project_id TEXT,
  occurred_at TEXT NOT NULL,
  integrity TEXT NOT NULL CHECK (integrity IN ('intact', 'ambiguous', 'truncated')),
  source_truncated INTEGER NOT NULL CHECK (source_truncated IN (0, 1)),
  memory_echo INTEGER NOT NULL CHECK (memory_echo IN (0, 1)),
  repo_revision TEXT,
  evidence_content_identity TEXT,
  file_content_identity TEXT,
  file_path TEXT,
  repository_root TEXT,
  command_text TEXT,
  command_cwd TEXT,
  command_result_identity TEXT,
  command_exit_code INTEGER,
  human_memory_id TEXT,
  human_revision_id TEXT,
  human_content_identity TEXT,
  PRIMARY KEY(candidate_id, evidence_id)
) STRICT;

CREATE TABLE semantic_assessments (
  assessment_id TEXT PRIMARY KEY,
  operation_id TEXT UNIQUE,
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id),
  state TEXT NOT NULL CHECK (state IN ('supported', 'partially_supported', 'contradicted', 'insufficient_evidence')),
  evidence_ids_json TEXT NOT NULL,
  evidence_generation INTEGER NOT NULL CHECK (evidence_generation >= 1),
  assessed_by TEXT NOT NULL,
  assessed_at TEXT NOT NULL
) STRICT;

CREATE TABLE verification_requests (
  verification_request_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id),
  description TEXT NOT NULL,
  proposed_action TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE governance_decisions (
  decision_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES memory_candidates(candidate_id),
  decision TEXT NOT NULL CHECK (decision IN ('promote', 'merge', 'wait', 'conflict', 'reject', 'expire')),
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL
) STRICT;

CREATE TABLE candidate_tombstones (
  candidate_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  project_id TEXT,
  source_identities_json TEXT NOT NULL,
  expiration_reason TEXT NOT NULL,
  expired_at TEXT NOT NULL,
  delete_after TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
) STRICT;

CREATE TABLE candidate_expiration_obligations (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  due_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  evaluated_at TEXT
) STRICT;

CREATE TABLE high_value_anomalies (
  anomaly_id TEXT PRIMARY KEY,
  anomaly_key TEXT NOT NULL UNIQUE,
  anomaly_kind TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  measurements_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisional', 'persistent', 'resolved')),
  detected_at TEXT NOT NULL,
  last_evaluated_at TEXT NOT NULL,
  last_evaluation_kind TEXT NOT NULL CHECK (last_evaluation_kind IN ('weekly', 'window')),
  last_window_start TEXT NOT NULL,
  last_window_end TEXT NOT NULL,
  consecutive_count INTEGER NOT NULL CHECK (consecutive_count >= 1)
) STRICT;

CREATE TABLE human_memory_conflicts (
  conflict_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  proposed_memory_id TEXT NOT NULL,
  conflicting_memory_ids_json TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'global')),
  project_id TEXT,
  assertion_body TEXT NOT NULL,
  category TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'private')),
  state TEXT NOT NULL CHECK (state IN ('open', 'kept_existing', 'adopted_new', 'distinguished')),
  detected_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE human_memory_operations (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('assert', 'resolve')),
  source_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'conflict', 'failed')),
  memory_id TEXT,
  conflict_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE human_conflict_assessments (
  operation_id TEXT PRIMARY KEY REFERENCES luna_operations(operation_id),
  conflict_id TEXT NOT NULL REFERENCES human_memory_conflicts(conflict_id),
  state TEXT NOT NULL CHECK (state IN ('material_conflict', 'no_material_conflict', 'uncertain')),
  conflicting_memory_ids_json TEXT NOT NULL,
  assessed_at TEXT NOT NULL
) STRICT;

CREATE INDEX candidate_state_age ON memory_candidates(state, last_evidence_at);
CREATE UNIQUE INDEX active_candidate_fingerprint
  ON memory_candidates(fingerprint) WHERE state != 'expired';
CREATE INDEX candidate_evidence_project ON candidate_evidence(candidate_id, project_id);
CREATE INDEX verification_request_candidate ON verification_requests(candidate_id, state);
