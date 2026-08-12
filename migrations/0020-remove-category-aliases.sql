CREATE TRIGGER memory_candidates_no_legacy_category_insert
BEFORE INSERT ON memory_candidates
WHEN NEW.candidate_json IS NOT NULL AND (
  json_type(NEW.candidate_json, '$.category') IS NOT NULL OR
  json_type(NEW.candidate_json, '$.categoryAliases') IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'memory_candidates forbids legacy category aliases');
END;

CREATE TRIGGER memory_candidates_no_legacy_category_update
BEFORE UPDATE OF candidate_json ON memory_candidates
WHEN NEW.candidate_json IS NOT NULL AND (
  json_type(NEW.candidate_json, '$.category') IS NOT NULL OR
  json_type(NEW.candidate_json, '$.categoryAliases') IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'memory_candidates forbids legacy category aliases');
END;
