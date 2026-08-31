---
status: accepted
extends: ADR-0082, ADR-0116, and ADR-0118
---

# Throttle offline recovery without degrading local recall

Network loss pauses Luna-dependent distillation but does not disable local Capture, the
published Retrieval Snapshot, the local E5 query model, or automatic recall. Doctor therefore
reports timeout-, unavailable-, and rate-limit-blocked Luna work as paused background work
instead of treating otherwise healthy local recall as globally degraded. Foreground health uses
a rolling six-hour window; retained lifetime deadline counts remain visible as historical
diagnostics but do not permanently determine current health.

When Luna health is not healthy, at least 32 Luna operations are pending, processing, or retrying,
or at least 128 Capture Events await processing, the Worker enters recovery mode. Compatible
index changes are coalesced until the dirty generation advances by 32 or the published index is
30 minutes old. Foreground pressure always delays a recovery build, and one foreground request
holds a five-second background-write cooldown. When the backlog drops below the recovery
threshold, the existing 30-second quiet period and two-minute maximum staleness resume and
publish the final caught-up generation.

A foreground SessionStart creates its Context Epoch only inside the final Receipt transaction.
The same transaction completes the foreground event reservation. Deadline checks reserve final
commit and response time before the transaction; a failed delivery is not replayed later by the
Shadow evaluator and cannot replace a newer Session epoch. Historical inconsistencies remain
auditable and are repaired separately against a Runtime backup.
