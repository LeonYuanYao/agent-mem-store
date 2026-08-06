---
status: accepted
---

# Classify and retry Luna health incidents

One isolated Luna failure remains an operation-level retry without a host notification. Model health becomes `degraded` after three consecutive failures spanning at least two minutes or when the oldest Luna-dependent retryable work reaches 15 minutes. The transition notifies once.

Authentication, invalid-model, and invalid-configuration failures become `unavailable` immediately. Other retryable failures become unavailable after 30 continuous minutes without recovery. Five consecutive schema-invalid or otherwise unusable Luna responses also qualify. A transition from degraded to unavailable produces one additional notice.

Recovery requires a successful health probe and then successful completion of a real queued Luna operation. Recovery notifies once and reports whether backlog catch-up remains.

Retry defaults to exponential backoff with jitter at 30 seconds, one, two, four, eight, and 15 minutes, capped at 30 minutes. A valid provider `Retry-After` takes precedence even when longer. Authentication and configuration failures do not spin; they wait for configuration change, explicit retry, or low-frequency probing.

An unresolved unavailable incident may remind once after 24 hours and at most once in each later 24-hour window. Snooze suppresses reminders until its deadline but does not hide persistent status. Acknowledgment, snooze, retry, or failed notification does not clear the incident or discard work.

These are configurable first-version defaults. Luna, metrics, and governance cannot alter them without explicit authorized configuration. Existing Memory remains locally available, capture continues when Outbox is healthy, and pending Luna work is retained throughout the incident.
