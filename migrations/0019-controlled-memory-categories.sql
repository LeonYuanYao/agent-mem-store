CREATE TRIGGER memory_candidates_controlled_category_insert
BEFORE INSERT ON memory_candidates
WHEN NEW.candidate_json IS NOT NULL AND json_extract(NEW.candidate_json, '$.category') IS NULL AND (
  NEW.category NOT IN (
    'safety_data_integrity',
    'applicability_limitation',
    'preference_constraint',
    'architecture_contract',
    'failure_recovery_hazard',
    'workflow_environment_toolchain',
    'durable_reference'
  ) OR
  json_extract(NEW.candidate_json, '$.primaryCategory') != NEW.category OR
  json_type(NEW.candidate_json, '$.categoryTags') != 'array' OR
  NOT EXISTS (
    SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags')
    WHERE value = NEW.category
  )
)
BEGIN
  SELECT RAISE(ABORT, 'memory_candidates requires controlled categories');
END;

CREATE TRIGGER memory_candidates_controlled_category_update
BEFORE UPDATE OF category, candidate_json ON memory_candidates
WHEN NEW.candidate_json IS NOT NULL AND json_extract(NEW.candidate_json, '$.category') IS NULL AND (
  NEW.category NOT IN (
    'safety_data_integrity',
    'applicability_limitation',
    'preference_constraint',
    'architecture_contract',
    'failure_recovery_hazard',
    'workflow_environment_toolchain',
    'durable_reference'
  ) OR
  json_extract(NEW.candidate_json, '$.primaryCategory') != NEW.category OR
  json_type(NEW.candidate_json, '$.categoryTags') != 'array' OR
  NOT EXISTS (
    SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags')
    WHERE value = NEW.category
  )
)
BEGIN
  SELECT RAISE(ABORT, 'memory_candidates requires controlled categories');
END;
