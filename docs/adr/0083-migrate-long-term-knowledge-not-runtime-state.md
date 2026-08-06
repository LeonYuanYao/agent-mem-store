---
status: accepted
---

# Migrate long-term knowledge, not Runtime state

The first-version portability contract is `complete long-term knowledge, not machine execution state`.

Memory Vault carries Durable Memory bodies and revisions; authority, scope, applicability, validity, category, and user-control metadata; versioned Semantic Contracts and validated compact or standard representations; Project identities and display names without local paths; portable provenance identities; relationship and successor edges; retained Archived bodies; and permanent body-free Tombstones.

An ordinary Vault move does not carry pending Outbox or Luna work, Governance cursors or leases, Injection Receipts, transient Bad Case diagnostics or Repair Bundles, Model Health Incidents, notification state, local Project aliases, Sessions, logs, SQLite, FTS, embeddings, indexes, or caches.

Migration readiness reports unfinished and uncommitted work. The supported flow drains required work, pauses source capture and Workers, copies or synchronizes the Vault, validates Canonical Data, re-registers destination Project roots, rebuilds Runtime Data, verifies retrieval, and then enables destination capture. A migration cannot claim completeness while ignored pending work remains.

Durable Memory remains meaningful without Luna regeneration. Exact metadata and FTS may become usable while local embeddings rebuild, and a complete semantic revision publishes atomically afterward. Review Inbox is regenerated. Local paths never define portable Project identity.

The first version neither merges active Runtime databases nor permits two MemStore writers against one synchronized Vault. Runtime export/import remains future architecture compatibility rather than a first-version feature.
