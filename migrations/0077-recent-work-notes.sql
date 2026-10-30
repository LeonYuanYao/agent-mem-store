-- A short-lived note of where a Session's work stands, injected when the next
-- Session of the Project starts (ADR-0164). Kept 7 days; not canonical Memory.
CREATE TABLE recent_work_notes (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  -- Empty when the Session holds nothing worth carrying over.
  summary TEXT NOT NULL,
  through_event_at TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX recent_work_notes_project ON recent_work_notes(project_id, through_event_at);
