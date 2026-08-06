---
status: accepted
---

# Purge in small checkpointed yielding batches

One machine-local purge executor processes each Memory through checkpointed prepare, body removal, Tombstone commit, derived-index removal, and completion states. Recovery rechecks lifecycle and content identity before continuing. A batch is never an unbounded transaction across the Vault and SQLite.

The first-version configurable batch stops after 25 bodies, 16 MiB of removed body data, or ten seconds of destructive work, whichever occurs first. Before every item it checks foreground Hook, capture, and indexing pressure and yields without losing its checkpoint.

When work remains and foreground queues are clear, another batch may begin after a 30-second floor. A foreground-pressure yield waits at least five minutes. Purge may use bounded incremental SQLite reclamation but never runs full `VACUUM` automatically.

Portable policy may lower the ceilings. Raising them above the initial safety maxima of 200 items, 128 MiB, or 60 seconds requires an explicitly reviewed configuration change. Luna and adaptive governance cannot change them. Strict preview enumerates only the bounded next batch and neither deletes nor reserves it.
