CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_roots (
  canonical_root TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  root_kind TEXT NOT NULL CHECK (root_kind IN ('non_git', 'git')),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
) STRICT;

CREATE INDEX project_roots_project_id ON project_roots(project_id);

CREATE TABLE project_git_evidence (
  evidence_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  common_directory TEXT,
  origin_identity TEXT,
  basename_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_collisions (
  collision_id TEXT PRIMARY KEY,
  basename_key TEXT NOT NULL,
  first_project_id TEXT NOT NULL REFERENCES projects(project_id),
  second_evidence_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('unresolved', 'resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;
