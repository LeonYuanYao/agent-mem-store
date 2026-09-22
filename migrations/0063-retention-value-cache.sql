CREATE TABLE memory_retention_assessments (
  memory_id TEXT PRIMARY KEY REFERENCES memory_catalog(memory_id) ON DELETE CASCADE,
  subject_hash TEXT NOT NULL,
  assessment_json TEXT NOT NULL CHECK(json_valid(assessment_json)),
  assessed_at TEXT NOT NULL
);

CREATE TRIGGER remove_retention_assessment_on_tombstone_or_human
AFTER UPDATE OF lifecycle, authority ON memory_catalog
WHEN NEW.lifecycle = 'tombstone' OR NEW.authority = 'human_authored'
BEGIN
  DELETE FROM memory_retention_assessments WHERE memory_id = NEW.memory_id;
END;
