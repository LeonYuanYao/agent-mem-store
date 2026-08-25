ALTER TABLE sensitivity_observations
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy_unknown';

CREATE INDEX sensitivity_observations_source_kind
  ON sensitivity_observations(source_kind, observed_at);
