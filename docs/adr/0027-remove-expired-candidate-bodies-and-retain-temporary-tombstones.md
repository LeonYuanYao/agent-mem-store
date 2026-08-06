---
status: accepted
---

# Remove expired candidate bodies and retain temporary tombstones

Once a successful governance evaluation commits a Memory Candidate to `expired`, MemStore removes its body rather than creating another body-bearing archive. The candidate has already remained available for its applicable 90- or 180-day waiting period, and it never participated in normal recall. Keeping another full copy would add storage, privacy, and governance cost without creating a new source of authority.

The state transition and cleanup are recoverable: the Governance Ledger records the successful expiration decision before body removal is considered complete, and retrying the cleanup is idempotent. Secret Content remains prohibited and is never admitted into a candidate body or tombstone.

Expiration creates a body-free Candidate Tombstone containing only the candidate fingerprint, Project and scope identifiers, source identities, expiration reason, and relevant timestamps. It does not retain the claim text, evidence text, prompt, tool output, or other recoverable body content. The tombstone defaults to a configurable 180-calendar-day retention period.

During that period, an exact repeat supported only by the same or echoed evidence is deduplicated against the tombstone. Materially new, independent, provenance-bound evidence may create a new candidate linked to the tombstone, so expiration does not become a permanent deny rule. After 180 days, the tombstone is deleted unless the user explicitly pinned it or an active governance object still references it. Retries, duplicate extraction, and Memory Echoes cannot create artificial references solely to extend retention.

Candidate Tombstones are distinct from Memory Tombstones for purged Durable Memory: the former are temporary duplicate-suppression records for knowledge that never became normally recallable, while the latter preserve minimal lifecycle continuity for previously active knowledge.
