CREATE INDEX capture_events_distillation_pending_group
ON capture_events(
  state,
  COALESCE(session_id, 'event:' || event_id),
  COALESCE(turn_id, 'session'),
  created_at
);

CREATE INDEX capture_events_distillation_stop
ON capture_events(event_kind, session_id, turn_id);

CREATE INDEX capture_events_distillation_session_end
ON capture_events(
  event_kind,
  COALESCE(session_id, 'event:' || event_id),
  created_at
);
