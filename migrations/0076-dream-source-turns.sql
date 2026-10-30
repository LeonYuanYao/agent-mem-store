-- The prompt events of the turns a candidate was extracted from, so a Memory can
-- show the conversation it came from (ADR-0162).
ALTER TABLE dream_candidates ADD COLUMN source_event_ids_json TEXT;
