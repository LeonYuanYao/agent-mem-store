---
status: accepted
---

# Preserve explicit-user coverage and checkpoint paused Sessions

Session consolidation is an optimization boundary, not authority to silently
discard a durable Candidate backed by an explicit user statement. If no
consolidated output Candidate represents any evidence from such an input,
MemStore restores the original Candidate locally before the existing 64-item
admission limit and Promotion Gate. This may retain a semantic duplicate, but
exact Candidate identity, duplicate governance, and later review are safer than
an unobservable false negative; exceeding the admitted limit remains a visible
retryable failure rather than silent truncation.

A missing `SessionEnd` must also have a bounded effect on availability. After
two hours without new Session activity, the Worker emits the existing
body-free, idempotent synthetic `SessionEnd`, matching the abandoned-Turn
inactivity window. Active long tasks remain open, while paused or resumable
Sessions finalize their closed Batch range without waiting the previous 24
hours. Later activity creates the next incremental consolidation generation and
does not invalidate the earlier checkpoint.
