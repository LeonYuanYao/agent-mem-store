-- A dream run started by `memstore remember extract` while dreaming is enabled
-- (ADR-0150): request_json holds the selected capture events, the selector, the
-- requested scope and whether to apply. NULL for scheduled and manual runs.
ALTER TABLE dream_runs ADD COLUMN request_json TEXT;
