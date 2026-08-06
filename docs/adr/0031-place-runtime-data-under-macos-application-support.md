---
status: accepted
---

# Place Runtime Data under macOS Application Support

MemStore's default machine-local Runtime Data root is:

```text
~/Library/Application Support/MemStore
```

This root is separate from the MemStore Project, the Obsidian-managed Memory Vault, `~/.codex`, other Agent-specific homes, individual Project directories, temporary directories, and `~/Library/Caches`. Pending Outbox and governance work must not be treated as disposable cache data.

The runtime root may contain state databases, WAL files, rebuildable indexes, logs, bad-case diagnostics, and repair bundles. The exact first-version database split remains an implementation-design decision; the accepted boundary is the root and its ownership. The directory defaults to mode `0700`, sensitive state files default to `0600`, and all runtime components follow Secret containment rules.

The root can be overridden by explicit configuration for persistent local storage. Hooks, Luna, scheduled governance, metrics, and recovery logic cannot relocate it automatically. A relocation is a reviewed management operation with integrity and available-space checks.

An ordinary Memory Vault migration does not require Runtime Data once all pending work is complete because Canonical Memory Data remains in the Vault. Pending Capture Events, Verification Requests, or governance obligations do not migrate automatically if Runtime Data is omitted. A live SQLite database must be backed up through a consistent SQLite backup API or with the relevant Worker quiesced; copying only the main database while WAL state exists is not a valid backup.
