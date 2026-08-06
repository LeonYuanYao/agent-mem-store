---
status: accepted
---

# Restrict Secret overrides to false positives

The first MemStore version permits a user to declare that one specific Secret detection is a false positive. The override binds to a non-reversible content fingerprint, the detector rule identity and version, and the current content revision. It cannot disable Secret detection globally or create a broad pattern allowlist. A relevant content change or material detector-rule change invalidates the override and requires local re-evaluation before the content is eligible for Luna, indexing, or injection again.

Override audit data records the fingerprint, detector rule identity and version, content revision, time, and human operation provenance without storing the suspected Secret body. User-facing review and warning surfaces may identify the file or Memory identity and risk category, but they do not display the suspected value. Exact audit-record placement and schema remain a later portability and implementation decision.

An override can correct a false classification; it cannot authorize persistence of a real password, API token, private key, session cookie, authorization header, or equivalent credential. The first version exposes no force-store-secret operation. Confirmed Secret Content remains excluded from Durable Outbox bodies, Luna, Memory Vault writes performed by MemStore, indexes, injection, logs, archives, and tombstone bodies even when the user requests otherwise.

For a manually authored Obsidian note, a valid false-positive override restores eligibility for ordinary sensitivity classification, indexing, and injection without modifying the note body. If the note contains a true Secret, MemStore continues to exclude it from automated processing and presents a bounded warning; it does not silently rewrite or delete the user's source text.
