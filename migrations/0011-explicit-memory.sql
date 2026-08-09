ALTER TABLE distillation_batches
  ADD COLUMN requested_scope_kind TEXT NOT NULL DEFAULT 'project'
  CHECK (requested_scope_kind IN ('project', 'global'));

ALTER TABLE distillation_batches
  ADD COLUMN requested_startup TEXT NOT NULL DEFAULT 'auto'
  CHECK (requested_startup IN ('auto', 'always', 'never'));

ALTER TABLE distillation_batches
  ADD COLUMN source_selector TEXT;

ALTER TABLE memory_candidates
  ADD COLUMN startup TEXT NOT NULL DEFAULT 'auto'
  CHECK (startup IN ('auto', 'always', 'never'));
