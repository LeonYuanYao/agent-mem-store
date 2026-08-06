---
status: accepted
---

# Keep live SQLite out of Memory Vault

The first-version primary runtime database uses one main SQLite file at:

```text
~/Library/Application Support/MemStore/state/memstore.sqlite
```

Separate tables own Durable Outbox, Governance Ledger, Project Registry, scheduling and catch-up state, Reminder Obligations, Verification Requests, Bad Case lifecycle, Model Health Incidents, Injection Receipts, and other bounded operational records. Rebuildable large embeddings and retrieval indexes remain in the runtime `indexes/` directory rather than inflating the main database.

SQLite WAL and shared-memory files may exist beside the main file as `memstore.sqlite-wal` and `memstore.sqlite-shm`. The live database and its WAL state must not be placed in, synchronized through, or treated as Canonical Memory Data in the Obsidian-managed Memory Vault. File synchronization does not merge SQLite transactions or coordinate writers across machines, and runtime state contains machine paths, leases, Session identities, diagnostic data, and pending work that should not silently follow ordinary knowledge sync.

The Memory Vault remains the portable Markdown authority. Review Inbox and other generated Vault views may expose links and bounded operational summaries, but they do not embed the runtime database or create a second operational state engine.

Future machine migration may add explicit `runtime export` and `runtime import` operations. An export must quiesce the relevant Worker or use SQLite's consistent backup API, carry a schema version and source-machine metadata, and exclude rebuildable indexes by default. Import must revalidate machine-specific paths, Project Registry mappings, leases, and adapter configuration before resuming work. This future compatibility is reserved in the design; the first version is not required to implement the migration commands.
