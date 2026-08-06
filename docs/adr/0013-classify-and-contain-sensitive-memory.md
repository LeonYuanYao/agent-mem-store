---
status: accepted
---

# Classify and contain sensitive memory

MemStore classifies content as Secret, Private, or Normal and applies the highest detected sensitivity throughout capture, distillation, storage, retrieval, and governance. Luna may identify Private or Normal content after local sanitization, but it cannot downgrade a local Secret classification. A user may always raise sensitivity; lowering Secret classification requires the explicit False-positive Secret Override constrained by ADR-0020.

Secret content includes credentials and equivalent authentication material such as passwords, API tokens, private keys, session cookies, and authorization headers. High-confidence Secret patterns are detected locally before durable event capture where possible; their bodies are redacted from Durable Outbox payloads and must never be sent to Luna, written to Memory Vault, indexed, injected, logged, archived, or retained in tombstones. MemStore may keep only non-reversible keyed fingerprints, category, and timestamps needed to prevent repeated extraction and diagnose rejection.

Private content may be stored as Project Memory and follows ordinary retention and governance within that project, but it cannot be promoted automatically to Global Memory. A Global Private memory requires an explicit human directive and remains clearly classified so retrieval can enforce its scope. Normal content follows the standard Project and Global policies.

The same containment boundary applies when indexing manually edited Obsidian notes. Automation must not rewrite or delete Human-authored content that appears to contain a Secret; instead it excludes the affected content from indexes and Memory Injection and surfaces a bounded warning. Human authority over content does not authorize accidental model or context disclosure.

Deterministic redaction and logs are fail-closed for high-confidence Secret matches, while uncertain classifications may enter a quarantined local state without normal recall or Luna processing. ADR-0020 permits only exact false-positive overrides and prohibits force-storing actual credentials. Exact detector rules and thresholds, override-record format, Private-to-Global confirmation UX, warning channels, and emergency purge behavior require later review. ADR-0014 separately defers application-level encryption from the first version.
