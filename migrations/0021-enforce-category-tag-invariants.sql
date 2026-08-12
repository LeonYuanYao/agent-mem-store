DROP TRIGGER memory_candidates_controlled_category_insert;
DROP TRIGGER memory_candidates_controlled_category_update;

CREATE TRIGGER memory_candidates_controlled_category_insert
BEFORE INSERT ON memory_candidates
WHEN NEW.candidate_json IS NOT NULL AND (
  NEW.category NOT IN (
    'safety_data_integrity',
    'applicability_limitation',
    'preference_constraint',
    'architecture_contract',
    'failure_recovery_hazard',
    'workflow_environment_toolchain',
    'durable_reference'
  ) OR
  json_type(NEW.candidate_json, '$.primaryCategory') IS NOT 'text' OR
  json_extract(NEW.candidate_json, '$.primaryCategory') IS NOT NEW.category OR
  json_type(NEW.candidate_json, '$.categoryTags') IS NOT 'array' OR
  json_array_length(NEW.candidate_json, '$.categoryTags') NOT BETWEEN 1 AND 7 OR
  EXISTS (
    SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags')
    WHERE type IS NOT 'text' OR value NOT IN (
      'safety_data_integrity',
      'applicability_limitation',
      'preference_constraint',
      'architecture_contract',
      'failure_recovery_hazard',
      'workflow_environment_toolchain',
      'durable_reference'
    )
  ) OR
  (SELECT COUNT(*) FROM json_each(NEW.candidate_json, '$.categoryTags')) IS NOT
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.candidate_json, '$.categoryTags')) OR
  json_extract(NEW.candidate_json, '$.primaryCategory') IS NOT CASE
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'safety_data_integrity') THEN 'safety_data_integrity'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'applicability_limitation') THEN 'applicability_limitation'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'preference_constraint') THEN 'preference_constraint'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'architecture_contract') THEN 'architecture_contract'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'failure_recovery_hazard') THEN 'failure_recovery_hazard'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'workflow_environment_toolchain') THEN 'workflow_environment_toolchain'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'durable_reference') THEN 'durable_reference'
    ELSE NULL
  END
)
BEGIN
  SELECT RAISE(ABORT, 'memory_candidates requires controlled category invariants');
END;

CREATE TRIGGER memory_candidates_controlled_category_update
BEFORE UPDATE OF category, candidate_json ON memory_candidates
WHEN NEW.candidate_json IS NOT NULL AND (
  NEW.category NOT IN (
    'safety_data_integrity',
    'applicability_limitation',
    'preference_constraint',
    'architecture_contract',
    'failure_recovery_hazard',
    'workflow_environment_toolchain',
    'durable_reference'
  ) OR
  json_type(NEW.candidate_json, '$.primaryCategory') IS NOT 'text' OR
  json_extract(NEW.candidate_json, '$.primaryCategory') IS NOT NEW.category OR
  json_type(NEW.candidate_json, '$.categoryTags') IS NOT 'array' OR
  json_array_length(NEW.candidate_json, '$.categoryTags') NOT BETWEEN 1 AND 7 OR
  EXISTS (
    SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags')
    WHERE type IS NOT 'text' OR value NOT IN (
      'safety_data_integrity',
      'applicability_limitation',
      'preference_constraint',
      'architecture_contract',
      'failure_recovery_hazard',
      'workflow_environment_toolchain',
      'durable_reference'
    )
  ) OR
  (SELECT COUNT(*) FROM json_each(NEW.candidate_json, '$.categoryTags')) IS NOT
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.candidate_json, '$.categoryTags')) OR
  json_extract(NEW.candidate_json, '$.primaryCategory') IS NOT CASE
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'safety_data_integrity') THEN 'safety_data_integrity'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'applicability_limitation') THEN 'applicability_limitation'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'preference_constraint') THEN 'preference_constraint'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'architecture_contract') THEN 'architecture_contract'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'failure_recovery_hazard') THEN 'failure_recovery_hazard'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'workflow_environment_toolchain') THEN 'workflow_environment_toolchain'
    WHEN EXISTS (SELECT 1 FROM json_each(NEW.candidate_json, '$.categoryTags') WHERE value = 'durable_reference') THEN 'durable_reference'
    ELSE NULL
  END
)
BEGIN
  SELECT RAISE(ABORT, 'memory_candidates requires controlled category invariants');
END;
