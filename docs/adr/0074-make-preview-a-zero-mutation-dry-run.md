---
status: accepted
---

# Make preview a zero-mutation dry run

`--preview` is a strict dry run. It may read and resolve Project, scope, source, configuration, existing Memory, and current content and perform in-memory schema, sensitivity, deduplication, conflict, and sanitized-size analysis. It cannot write Outbox, SQLite lifecycle or audit state, Vault, indexes, embeddings, Review Inbox, notification state, governance cursor, usage statistics, or a Project Marker and cannot call Luna.

Preview returns `dry_run: true`, no durable operation identity, planned authority and scope, affected objects, `would_accept`, `would_create` or `would_change`, and bounded redacted warnings. It neither persists a suspected Secret fingerprint nor echoes the suspected value. Preview and `--wait` are mutually exclusive.

Preview does not lock inputs or guarantee a later result. A command rerun without preview re-resolves and revalidates current state before commit. MemStore does not persist a preview audit event. Shell-history behavior is outside MemStore, so long content should prefer `--stdin` or `--file`.
