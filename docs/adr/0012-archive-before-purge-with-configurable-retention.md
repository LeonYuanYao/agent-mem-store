---
status: accepted
---

# Archive before purge with configurable retention

MemStore removes obsolete Durable Memory in two stages. Archiving records an immutable archive event, immediately excludes the content from normal recall and relationship expansion, and preserves enough data for recovery. Purging later removes the archived body from Memory Vault after its effective retention period. Repeated governance, retries, file moves, and no-op updates do not reset `archived_at`; an explicit restore followed by a later archive begins a new cycle.

Retention is policy-driven rather than hard-coded. Resolution precedence is an explicit per-memory `purge_after` or `retain_forever` directive, then an authority- or scope-specific policy, then the system default. Agent-derived archived memory defaults to six calendar months. Human-authored Memory defaults to no automatic physical deletion; a finite policy for it requires an explicit high-authority configuration or per-memory directive. User-pinned content also remains protected unless an explicit purge directive overrides that protection.

When retention expires, the recoverable Governance Ledger creates an idempotent purge obligation. Offline time, missed wake-ups, or failures do not cancel the purge; Catch-up Runs process it later under bounded deletion batches. Before committing, the worker rechecks that the memory is still archived, has not been restored or protected, and still matches the expected content identity.

Purging may retain a minimal tombstone without the memory body: identity or fingerprint, archive and purge timestamps, reason, and successor identity where applicable. This prevents rejected or superseded knowledge from being recreated blindly while removing the archived content. Prohibited sensitive content may bypass ordinary retention under a separately reviewed safety policy. External backups and Obsidian Sync history are outside MemStore's deletion guarantee.

Exact configuration syntax, timezone and calendar arithmetic, tombstone placement and retention, purge batch limits, archive layout, and sensitive-content exceptions require later review.
