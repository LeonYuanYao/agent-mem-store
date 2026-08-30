CREATE INDEX memory_catalog_active_agent_space
  ON memory_catalog(scope_kind, project_id, revised_at, memory_id)
  WHERE lifecycle = 'active' AND authority = 'agent_derived';

CREATE INDEX memory_candidates_promoted_memory
  ON memory_candidates(promoted_memory_id)
  WHERE promoted_memory_id IS NOT NULL;

CREATE INDEX retrieval_receipt_items_selected_memory
  ON retrieval_receipt_items(memory_id, receipt_id)
  WHERE outcome = 'selected';

CREATE INDEX memory_relationships_target
  ON memory_relationships(target_memory_id, source_memory_id);

CREATE INDEX governance_review_suggestions_open_target
  ON governance_review_suggestions(target_memory_id)
  WHERE state = 'open';
