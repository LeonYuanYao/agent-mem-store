-- Dreaming reads a Session in segments. A Session that continues after it was
-- dreamed about becomes eligible again, and only its newer events are read:
-- `segment_after` is the exclusive lower bound of the latest segment (NULL for
-- a Session's first segment) and `last_event_at` its inclusive upper bound.
ALTER TABLE dream_sessions ADD COLUMN segment_after TEXT;
