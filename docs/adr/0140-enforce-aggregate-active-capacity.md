# ADR-0140: Enforce aggregate Active capacity

Status: Accepted for the approved 5,000-entry trial.

## Decision

Pair opt-in corpus archival with atomic admission reservations at the canonical
writer. Count all Active Human and Agent knowledge, including ranking exclusions.
The trial limit is 5,000; archival targets 4,950 to free a small batch of slots.
Fixed mode replaces per-project corpus thresholds and the fourteen-day cold
eligibility window. Hard protections remain unchanged. The portable defaults
remain off, so installation alone cannot authorize capacity archival.

Existing valid content-priority assessments rank eligible entries low, normal,
then high, followed by existing importance/activity ties. Unknown assessments
compete as normal. No full-corpus LLM backfill or additional model job is required.
Importance is computed from canonical metadata using the same function as the
retrieval index; missing or stale index membership cannot lower an entry's tier.
This guarantees bounded managed admission after stock convergence, not an optimal
choice of the most useful 5,000 memories. Archive provenance describes capacity
competition and preserves the normal three-calendar-month recovery period.

## Concurrency and recovery

SQLite reserves a slot before any new Active canonical file is written. Pending
slots already represented by an Active catalog row are not counted twice.
Revisions to existing Active knowledge need no additional slot. All managed
create/restore paths, including Human assertions, use this writer; explicit
requests at capacity report how to free a slot rather than silently exceeding it.

Capacity-blocked Candidates retain their evidence and matching completed semantic
assessment identity. Worker evaluation wakes a bounded number after slots open;
normal validity and promotion checks still apply. Other waiting outcomes leave
the capacity retry queue. This avoids repeated model evaluation merely to wait
for space. Old evidence for an already-promoted archived Candidate does not create
a fresh Active identity.

Slots have no time-only expiry. A dead writer's slot can be released if no file was
published or the catalog already counts it. Unpublished canonical files require
reconciliation and keep their reservation visible in status. Direct external
Vault edits and catalog rebuilding are authoritative operations outside managed
admission; subsequent pressure is visible and blocks further growth.

## Verification

Tests exercise corpus preview/apply/restore, concurrent Candidate promotion,
Worker evaluation wake-up, protections, exact-preview replay, and interrupted
slot ownership. Live activation includes a consistent Runtime backup, canonical
archive preview inspection, bounded archival and post-deployment health checks.
