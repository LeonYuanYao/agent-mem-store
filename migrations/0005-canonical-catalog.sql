CREATE TABLE memory_catalog (
  memory_id TEXT PRIMARY KEY,
  current_revision_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'global')),
  project_id TEXT,
  authority TEXT NOT NULL CHECK (authority IN ('human_authored', 'agent_derived')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'private')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived', 'tombstone')),
  content_identity TEXT NOT NULL,
  revised_at TEXT NOT NULL,
  catalog_updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE memory_revisions (
  revision_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_catalog(memory_id),
  predecessor_revision_id TEXT,
  revision_path TEXT NOT NULL,
  content_identity TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE memory_relationships (
  source_memory_id TEXT NOT NULL REFERENCES memory_catalog(memory_id),
  target_memory_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  PRIMARY KEY (source_memory_id, target_memory_id, relationship_type)
) STRICT;

CREATE TABLE vault_conflicts (
  conflict_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  expected_content_identity TEXT,
  observed_content_identity TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved'))
) STRICT;
