CREATE INDEX capture_events_session_activity
  ON capture_events(
    session_id,
    occurred_at DESC,
    event_kind,
    created_at DESC,
    event_id,
    project_id
  )
  WHERE session_id IS NOT NULL;
