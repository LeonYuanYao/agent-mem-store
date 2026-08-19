CREATE TABLE governance_actions_next (
  action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES governance_runs(run_id),
  checkpoint_id TEXT NOT NULL REFERENCES governance_checkpoints(checkpoint_id),
  action_key TEXT NOT NULL UNIQUE,
  action_kind TEXT NOT NULL CHECK (
    action_kind IN (
      'archive', 'supersede', 'relationship', 'mark_review_due',
      'review_suggestion', 'future_purge'
    )
  ),
  target_memory_id TEXT,
  result_json TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

INSERT INTO governance_actions_next
SELECT * FROM governance_actions;

DROP TABLE governance_actions;
ALTER TABLE governance_actions_next RENAME TO governance_actions;
