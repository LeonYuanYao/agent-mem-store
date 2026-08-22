---
status: accepted
---

# Add a bounded emergency Capture spool

Measured production Shadow operation showed that transient SQLite writer
contention could outlive the Codex Hook deadline and discard otherwise valid
Capture Events. The machine-local Runtime therefore owns a narrow emergency
spool at `spool/capture/`. It is a recovery path for a validated event only
after the normal SQLite Outbox write reports `SQLITE_BUSY`; it is not another
ordinary queue, a Canonical Memory store, or Vault data.

The Hook applies the normal sensitivity and one-MiB retained-payload rules,
writes one checksummed JSON file atomically with mode `0600`, and acknowledges
the event as `spooled` only after that write succeeds. The Worker imports the
oldest pending file idempotently into the SQLite Outbox and removes the file
only after the Outbox reports `captured` or `duplicate`. SQLite contention
leaves the file pending. Invalid or checksum-mismatched files move to a
quarantine directory and remain visible to status and doctor without exposing
their bodies.

Pending capacity is 256 files. At capacity the Hook fails open with its normal
host-visible capture warning instead of overwriting or silently deleting an
older event. Doctor warns for stale pending files, quarantine entries, or at
least 80 percent capacity. Hook SQLite waiting is reduced to 100 milliseconds
because the atomic file recovery path provides durability while preserving
substantial headroom under the one-second host deadline.

The Worker must not acquire the SQLite write lock merely to discover that an
idle queue is empty. Work claimers and periodic scheduling paths perform a
read-only preflight and recheck inside the write transaction only when eligible
work exists. This retains transactional correctness while removing routine
idle writer contention.

This decision supersedes the no-spool restriction in ADR 0070 based on observed
capture loss. The SQLite Outbox remains the sole normal processing queue and
the emergency spool remains machine-local recoverable operational state.
