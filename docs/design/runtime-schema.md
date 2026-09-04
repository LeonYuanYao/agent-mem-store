# Runtime schema

The Core Foundation uses one SQLite database at
`<runtime>/state/memstore.sqlite`, with WAL, foreign keys, a 250 ms busy timeout,
strict tables, forward-only migrations, and applied-source checksums.

Hook capture uses a shorter 100 ms busy wait and falls back only on writer
contention to bounded checksummed files under `<runtime>/spool/capture/`. The
Worker imports these files into the Outbox before normal work. This directory is
machine-local recovery state, is capped at 256 pending entries, and is not part
of the database schema or Memory Vault.

Gate 3 table families are:

- `schema_migrations`;
- Project Registry, Git evidence, and collisions;
- Capture Events, segments, attempts, leases, and health incidents;
- body-free sensitivity findings and observations;
- bounded sensitivity-retention scheduling and aggregate deletion counters;
- bounded Injection Receipt retention, daily summaries, and aggregate deletion counters;
- Canonical catalog, immutable revisions, relationships, and Vault conflicts.

Outcome 6 adds Luna operations and model-health incidents, distillation Batches,
Session consolidations, Memory Candidates and evidence, semantic assessments,
Verification Requests, governance decisions, body-free Candidate Tombstones,
expiration obligations, statement-bound Human Global authorizations, Human
conflicts, durable conflict assessments, and versioned high-value anomaly state.
These tables remain machine execution state; Canonical Memory continues to live
only in the Vault.

Outcome 7 adds immutable retrieval-index revisions and an atomically selected
active revision; exact metadata, FTS5 rows, and a manifest-bound flat-vector
sidecar; Context Epoch accounting; automatic and explicit Retrieval Receipts;
query-bound explicit retrieval chains; receipt-bound irrelevant observations;
and body-free Bad Case aggregates. SessionStart receipts additionally record
lightweight rows examined, bucket-page count, and the terminal stop reason.
Vector sidecars and Bad Case diagnostic bundles live under the Runtime root,
not in the Vault.

Outcome 9 adds stable-zone governance configuration and successful cursors;
individually auditable Weekly/Monthly obligations; one active fixed-coverage
run; immutable run members; integrity-bound page checkpoints; idempotent action
receipts; Human Review Suggestions; future purge obligations; bounded run
summaries; and a leased retrieval-index build activity marker used for
foreground yielding. These tables record governance execution state and do not
move Canonical Memory out of the Vault.

Outcome 10 adds the generated Review Inbox identity, durable aggregate reminder
obligations and delivery attempts, explicit Worker/capture pause state, and a
ledger of consistent Runtime backups. Review Inbox Markdown is a rebuildable,
body-free Vault view; reminder and Worker records remain machine execution
state. Runtime backups are recovery artifacts only and are never accepted as a
portable knowledge import.

Sensitivity observation and Finding metadata is not permanent audit history.
Migration 0059 adds a singleton maintenance cursor and retention indexes so the
Worker can prune the configured 15-day body-free window in bounded batches,
catch up after downtime, and expose failures without adding model work.

Detailed Injection Receipts are also bounded operational history. Migration
0060 adds a maintenance cursor and body-free daily summaries. The Worker keeps
the configurable 30-day detail window, protects Receipts referenced by explicit
irrelevant observations, deletes at most 1,000 Receipts per transaction, and
catches up after downtime. SQLite reuses the freed pages; full physical
compaction remains an explicit quiesced maintenance operation.

Capture payload segments are at most 64 KiB. Retained sanitized payload is at
most 1 MiB per Turn. Oversized data is stored as a valid explicit truncation
envelope; it is never stored as malformed partial JSON.

The database is machine execution state, not Canonical Memory. It must never be
placed in the Obsidian Vault or copied without a consistent SQLite backup or a
quiesced writer.
