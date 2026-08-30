---
status: accepted
---

# Include MCP, governance, and review surfaces in the MVP

The Engineering MVP proves an end-to-end Shadow data loop from Codex capture through Durable Outbox, idempotent Luna batching, Candidate validation and promotion, Canonical Markdown, local indexes, explicit recall, and non-injected SessionStart and UserPromptSubmit pack computation with Injection Receipts. It includes initialization, status, diagnostics, retry, restart recovery, Project resolution, Secret containment, manual-edit invalidation, core commands, and the thin `$memstore-remember` and `$memstore-recall` Skills.

The MVP also includes the canonical MCP tools `memstore_search`, `memstore_get`, `memstore_provenance`, `memstore_related`, and `memstore_report_irrelevant`. They call the same MemStore core and do not implement a second retrieval or lifecycle engine.

Complete weekly and monthly Luna governance is in scope for consolidation, relationship review, staleness and conflict analysis, and bounded governance summaries. This necessarily includes a durable Governance Ledger, idempotent scheduling, missed-run catch-up, retry, and model-health behavior for sleep, network outage, restart, and Luna unavailability.

The MemStore-owned macOS notification helper and Obsidian `_MemStore/Review Inbox.md` interaction are also in scope for Verification Requests, Human Memory conflicts, model-health incidents, and governance review items. Notifications remain body-free and non-blocking.

The Engineering MVP remains Shadow-only. It does not enable automatic injection or modify Codex native-memory configuration. At this historical milestone, deferred items included the Claude adapter, ANN or separate vector service, active application-level encryption, native-memory import, a future cross-Project migration command, archive-body purge implementation, and the full `$memstore-repair` workflow. Later reviewed milestones implemented purge and changed its default to three calendar months; ADR-0012 and ADR-0079 are authoritative for current retention. MVP completion requires human Review and does not itself authorize Full Cutover.
