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

---
status: accepted
---
