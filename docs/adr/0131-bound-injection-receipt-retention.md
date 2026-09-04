---
status: accepted
extends: ADR-0008, ADR-0034, ADR-0071, and ADR-0105
---

# Bound detailed Injection Receipts to thirty days

Detailed Injection Receipts and their selected or omitted item rows are
machine-local operational evidence, not Canonical Memory Data or permanent
logs. MemStore retains them for a configurable 30 calendar days from
`created_at`. A Receipt linked to an explicit irrelevant observation remains
protected so an active Bad Case or repair can still explain the original
ranking decision.

Before deleting eligible details, the Worker adds their body-free counts,
rendered-token totals, selected and omitted item counts, and latency totals to
small per-day and caller-kind summaries. Completed foreground reservations and
legacy Shadow evaluations retain their event result but release the expired
Receipt reference. Foreground attempt telemetry uses its existing nullable
reference. Cleanup does not modify Canonical Memory, ranking policy, Context
Epoch accounting, or user feedback.

The Worker checks the obligation every six hours and deletes at most 1,000
Receipts and their item rows in one transaction. If eligible work remains, the
next pass is due after 30 seconds. Missed checks are coalesced on recovery;
failures use bounded exponential retry and remain visible through status. The
path yields while foreground retrieval pressure is recent, is deterministic
and local, and never calls Luna, Terra, or another model.

Deleted SQLite pages are reused by later writes, bounding steady-state growth.
MemStore does not run a full `VACUUM` automatically: physical file compaction
continues to require a quiesced, integrity-checked, explicitly authorized
maintenance operation under ADR-0105.
