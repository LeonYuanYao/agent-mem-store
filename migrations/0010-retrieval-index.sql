CREATE TABLE retrieval_index_revisions (
  index_revision_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('complete', 'failed')),
  built_at TEXT NOT NULL,
  selected_at TEXT,
  directory_path TEXT NOT NULL UNIQUE,
  manifest_sha256 TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  model_identity TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  normalization TEXT NOT NULL CHECK (normalization IN ('l2')),
  document_count INTEGER NOT NULL CHECK (document_count >= 0)
) STRICT;

CREATE TABLE active_retrieval_index (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  index_revision_id TEXT NOT NULL REFERENCES retrieval_index_revisions(index_revision_id)
) STRICT;

CREATE TABLE retrieval_documents (
  index_revision_id TEXT NOT NULL REFERENCES retrieval_index_revisions(index_revision_id),
  vector_ordinal INTEGER NOT NULL CHECK (vector_ordinal >= 0),
  memory_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_identity TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'global')),
  project_id TEXT,
  authority TEXT NOT NULL CHECK (authority IN ('human_authored', 'agent_derived')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'private')),
  lifecycle TEXT NOT NULL CHECK (lifecycle = 'active'),
  category TEXT NOT NULL,
  base_priority_tier TEXT NOT NULL CHECK (base_priority_tier IN ('critical', 'strong', 'normal')),
  session_order_key TEXT NOT NULL,
  importance_tags_json TEXT NOT NULL,
  startup TEXT NOT NULL CHECK (startup IN ('auto', 'always', 'never')),
  applicability_summary TEXT NOT NULL,
  applicability_conditions_json TEXT NOT NULL,
  validity_state TEXT NOT NULL CHECK (validity_state IN ('valid', 'review_due')),
  valid_from TEXT,
  valid_until TEXT,
  identity_label TEXT,
  identity_validated INTEGER NOT NULL CHECK (identity_validated IN (0, 1)),
  identity_token_count INTEGER NOT NULL CHECK (identity_token_count >= 0),
  compact_text TEXT NOT NULL,
  compact_validated INTEGER NOT NULL CHECK (compact_validated IN (0, 1)),
  compact_token_count INTEGER NOT NULL CHECK (compact_token_count >= 0),
  standard_text TEXT NOT NULL,
  standard_validated INTEGER NOT NULL CHECK (standard_validated IN (0, 1)),
  standard_token_count INTEGER NOT NULL CHECK (standard_token_count >= 0),
  searchable_text TEXT NOT NULL,
  revised_at TEXT NOT NULL,
  PRIMARY KEY (index_revision_id, memory_id),
  UNIQUE (index_revision_id, vector_ordinal)
) STRICT;

CREATE INDEX retrieval_documents_scope
  ON retrieval_documents(index_revision_id, scope_kind, project_id, memory_id);

CREATE VIRTUAL TABLE fts_memories USING fts5(
  index_revision_id UNINDEXED,
  memory_id UNINDEXED,
  searchable_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE context_epochs (
  epoch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'closed')),
  automatic_token_total INTEGER NOT NULL DEFAULT 0 CHECK (automatic_token_total >= 0),
  started_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;

CREATE UNIQUE INDEX active_context_epoch
  ON context_epochs(session_id) WHERE state = 'active';

CREATE TABLE retrieval_receipts (
  receipt_id TEXT PRIMARY KEY,
  caller_kind TEXT NOT NULL CHECK (caller_kind IN ('session_start', 'user_prompt', 'explicit')),
  caller_identity TEXT NOT NULL,
  query_identity TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  scope_binding TEXT NOT NULL,
  project_id TEXT,
  index_revision_id TEXT REFERENCES retrieval_index_revisions(index_revision_id),
  epoch_id TEXT REFERENCES context_epochs(epoch_id),
  rendered_token_count INTEGER NOT NULL CHECK (rendered_token_count >= 0),
  automatic_epoch_total INTEGER,
  budget_tier TEXT NOT NULL,
  semantic_stage TEXT NOT NULL CHECK (semantic_stage IN ('complete', 'lexical_only', 'not_applicable')),
  empty_reason TEXT,
  soft_target_restricted INTEGER NOT NULL DEFAULT 0 CHECK (soft_target_restricted IN (0, 1)),
  hard_limit_blocked INTEGER NOT NULL DEFAULT 0 CHECK (hard_limit_blocked IN (0, 1)),
  rows_examined INTEGER NOT NULL DEFAULT 0 CHECK (rows_examined >= 0),
  bucket_page_count INTEGER NOT NULL DEFAULT 0 CHECK (bucket_page_count >= 0),
  terminal_stop_reason TEXT,
  omitted_item_count INTEGER NOT NULL DEFAULT 0 CHECK (omitted_item_count >= 0),
  omission_details_truncated INTEGER NOT NULL DEFAULT 0 CHECK (omission_details_truncated IN (0, 1)),
  latency_ms REAL NOT NULL CHECK (latency_ms >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE retrieval_receipt_items (
  receipt_id TEXT NOT NULL REFERENCES retrieval_receipts(receipt_id),
  memory_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  rank_ordinal INTEGER NOT NULL CHECK (rank_ordinal >= 0),
  relevance_band TEXT NOT NULL CHECK (relevance_band IN ('high', 'probable', 'weak', 'startup')),
  representation_kind TEXT NOT NULL CHECK (representation_kind IN ('compact', 'standard', 'identity', 'full')),
  rendered_token_count INTEGER NOT NULL CHECK (rendered_token_count >= 0),
  score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('selected', 'omitted')),
  omission_reason TEXT,
  PRIMARY KEY (receipt_id, memory_id, revision_id)
) STRICT;

CREATE TABLE explicit_retrieval_chains (
  chain_id TEXT PRIMARY KEY,
  caller_identity TEXT NOT NULL,
  cumulative_token_count INTEGER NOT NULL DEFAULT 0 CHECK (cumulative_token_count >= 0),
  warning_band INTEGER NOT NULL DEFAULT 0 CHECK (warning_band >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE irrelevant_observations (
  observation_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES retrieval_receipts(receipt_id),
  memory_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  caller_identity TEXT NOT NULL,
  bad_case_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(receipt_id, memory_id, revision_id, caller_identity)
) STRICT;

CREATE TABLE bad_cases (
  bad_case_id TEXT PRIMARY KEY,
  signature TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind = 'irrelevant_retrieval'),
  component TEXT NOT NULL,
  project_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('normal', 'high')),
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'repairing', 'resolved', 'dismissed', 'stale')),
  reminder_state TEXT NOT NULL CHECK (reminder_state IN ('pending', 'acknowledged', 'snoozed')),
  diagnostic_bundle_path TEXT NOT NULL,
  diagnostic_bundle_sha256 TEXT NOT NULL
) STRICT;
