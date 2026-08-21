CREATE VIRTUAL TABLE active_fts_memories USING fts5(
  index_revision_id UNINDEXED,
  memory_id UNINDEXED,
  searchable_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO active_fts_memories(index_revision_id, memory_id, searchable_text)
SELECT document.index_revision_id, document.memory_id, document.searchable_text
FROM retrieval_documents AS document
JOIN active_retrieval_index AS active
  ON active.index_revision_id = document.index_revision_id;
