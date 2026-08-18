ALTER TABLE semantic_assessments
ADD COLUMN durability_disposition TEXT NOT NULL DEFAULT 'legacy_unclassified'
CHECK (durability_disposition IN (
  'durable',
  'task_local',
  'transient',
  'no_retention',
  'uncertain',
  'legacy_unclassified'
));
