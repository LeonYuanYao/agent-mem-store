-- Apply mode (ADR-0148): inject-tier dream items become agent-derived canonical
-- Memory with policy_version 'dreaming-v1'. Retrieval documents keep the policy
-- version so automatic injection can admit dreaming Memory without admitting
-- other agent-derived Memory.
ALTER TABLE retrieval_documents ADD COLUMN policy_version TEXT;

-- One row per canonical Memory dreaming wrote. statement_key finds the same
-- statement again; observation_count counts the runs that produced it.
CREATE TABLE dream_memories (
  memory_id TEXT PRIMARY KEY,
  statement_key TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'global')),
  project_id TEXT,
  created_run_id TEXT NOT NULL,
  updated_run_id TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX dream_memories_statement ON dream_memories(statement_key);

-- Per item outcome of applying it: pending, written, revised, observed,
-- duplicate_human, conflict_human, review_due, skipped or failed.
ALTER TABLE dream_items ADD COLUMN apply_state TEXT;
ALTER TABLE dream_items ADD COLUMN apply_memory_id TEXT;
ALTER TABLE dream_items ADD COLUMN apply_reason TEXT;
