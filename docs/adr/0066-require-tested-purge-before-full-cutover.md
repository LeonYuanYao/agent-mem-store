---
status: accepted
---

# Require tested purge before Full Cutover

Archive-body purge remains outside the Shadow-only Engineering MVP, which records purge obligations without executing physical deletion. The purge implementation is nevertheless a hard prerequisite for Full Cutover. A sole long-term memory system cannot assume production ownership while knowingly accumulating archive lifecycle debt it cannot complete.

Before cutover, an isolated test Vault with short test-only retention must prove ordinary purge, restore protection, `retain_forever` and pin protection, idempotent repeated execution, crash recovery, missed-run catch-up, content-identity recheck, body-free tombstone retention, index removal, and agreement among Vault, SQLite, and derived state.

Short test retention cannot alter production policy. Real Agent-derived Archived Memory retains the configurable six-calendar-month default, while Human-authored Memory retains its default of no automatic physical deletion unless an explicit high-authority policy or per-Memory directive says otherwise.

Recording obligations in the Engineering MVP is not evidence that destructive lifecycle completion works. Full Cutover requires fresh successful destructive-path evidence and explicit human approval.
