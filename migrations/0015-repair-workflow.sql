CREATE TABLE repair_cases (
  repair_id TEXT PRIMARY KEY,
  bad_case_id TEXT NOT NULL UNIQUE REFERENCES bad_cases(bad_case_id),
  state TEXT NOT NULL CHECK (
    state IN (
      'diagnosing', 'awaiting_gate1', 'gate1_approved', 'awaiting_replay',
      'awaiting_gate2', 'monitoring', 'monitoring_failed', 'resolved',
      'resolved_with_limited_evidence', 'not_reproduced'
    )
  ),
  root_cause TEXT,
  risk_class TEXT CHECK (risk_class IN ('A', 'B', 'C')),
  active_model TEXT NOT NULL,
  model_requirement_satisfied INTEGER NOT NULL CHECK (model_requirement_satisfied IN (0, 1)),
  program_version TEXT NOT NULL,
  code_revision TEXT NOT NULL,
  repair_bundle_path TEXT NOT NULL,
  before_version TEXT,
  after_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE repair_events (
  event_id TEXT PRIMARY KEY,
  repair_id TEXT NOT NULL REFERENCES repair_cases(repair_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'prepared', 'proposal_recorded', 'gate1_approved', 'application_recorded',
      'replay_recorded', 'gate2_approved', 'safety_observed',
      'monitoring_failed', 'limited_evidence_approved'
    )
  ),
  payload_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(repair_id, ordinal)
) STRICT;

CREATE TABLE repair_safety_observations (
  observation_id TEXT PRIMARY KEY,
  repair_id TEXT NOT NULL REFERENCES repair_cases(repair_id),
  opportunity_count INTEGER NOT NULL CHECK (opportunity_count >= 0),
  violation_count INTEGER NOT NULL CHECK (violation_count >= 0),
  observed_at TEXT NOT NULL
) STRICT;

CREATE INDEX repair_safety_observations_by_repair
  ON repair_safety_observations(repair_id, observed_at);
