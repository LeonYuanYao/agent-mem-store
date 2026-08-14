---
status: accepted
---

# Use manual Luna retry epochs

A Luna operation receives one initial attempt and at most six automatic retries
within one retry epoch. The exponential schedule remains 30 seconds, one, two,
four, eight, and 15 minutes. Reaching the limit blocks the operation rather than
spinning indefinitely.

An explicit manual retry starts a new epoch and resets only the epoch attempt
count. The lifetime attempt count, previous failure category, and bounded safe
diagnostic remain available for inspection. A successful completion clears the
current failure fields. This lets an operator retry after an external repair
without erasing evidence or receiving only one additional attempt.

Status reports blocked operations separately. Doctor reports a warning whenever
at least one Luna operation is blocked, even when SQLite, capture, and retrieval
are otherwise healthy.
