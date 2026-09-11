# Seal inactive Turns without starving maintenance

An active coding Turn still waits for `Stop` so long tasks are not split into
small time-based Luna requests. A missing terminal Hook must not leave its
events pending forever, however. This occurred with parallel agent Turns whose
event counts and retained bytes remained below both bounded checkpoints.

A Turn becomes eligible for distillation after two hours without a newly
captured event. The inactivity clock uses the machine-local capture time rather
than the source timestamp. A continuously active long Turn therefore keeps its
coalescing window, while an abandoned Turn is eventually sealed. The existing
64-event and 512-KiB checkpoints continue to apply. Events that arrive after an
inactive Turn was sealed enter a later Batch and are joined by normal Session
consolidation; no Capture Event is discarded or rewritten.

Background quality work yields only to actionable foreground work: a ready
distillation Batch, an active Luna operation, or an active Governance Run.
Recent pending events that are still waiting for `Stop` do not indefinitely
block a due quality or duplicate scan.

Governance startup follows the same actionable-work boundary. Pending events
inside an open Turn do not defer a due run until the existing distillation
eligibility check reports a ready Batch. Processing/retrying Capture Events
and an active index build still defer startup. This does not seal the Turn,
discard events, or change the governance coverage cursor before completion.

The September 2026 manual weekly run exposed the previous inconsistency:
governance startup required every pending event to disappear, even while the
Worker deliberately retained an unfinished Turn. Apparent queue inactivity
therefore did not establish that the Worker was hung. Regression coverage
distinguishes an open Turn from a Stop-sealed or 64-event Batch.

---
status: accepted
---
