---
status: accepted
---

# Retain body-free Tombstones without time expiry

Agent-derived Archived Memory defaults to body purge six calendar months from immutable `archived_at`, not after an approximate 180-day duration. Archive resolves the applicable policy and materializes a fixed `purge_after` for that archive cycle. Later global policy changes apply prospectively; accelerating existing records requires a separate governed operation with strict preview.

Purge removes the body and every compact, standard, embedding, source-excerpt, and otherwise recoverable content representation. It retains a minimal Canonical Tombstone containing only Memory and revision identities, Project or Global scope, authority, content identity, archive and purge timestamps, purge reason, successor identity, and body-free provenance identities as applicable.

Tombstones are excluded from ordinary recall, semantic indexing, and relationship expansion. They have no automatic time-based expiry in the first version because they preserve replay suppression, idempotency, old-reference explanation, successor continuity, deduplication, and portable migration history at low storage cost.

A future explicit compaction or prune requires a separately reviewed, provable replay watermark and evidence that no Durable Memory edge, pending Outbox or governance work, Verification Request, Bad Case, Retrieval Receipt, backup-import contract, or migration artifact can depend on the Tombstone. Elapsed time alone cannot establish safe deletion.

Content can be restored normally only before body purge. Afterward, a surviving external source may support a provenance-bound new revision, but the Tombstone is never presented as if it could reconstruct the deleted body.
