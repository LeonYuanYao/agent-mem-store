---
status: accepted
---

# Limit automatic governance by content authority

Luna may automatically merge, supersede, or archive Agent-derived Durable Memory only when newer or stronger traceable evidence supports the change, the original scope and applicability conditions are preserved, and no Human-authored Memory conflict exists. Each semantic action is idempotent, recorded in the Governance Ledger, and recoverable through archived content and successor relationships. Automatic governance does not silently overwrite or immediately delete the previous body.

Luna cannot automatically rewrite, merge, or archive Human-authored Memory merely because the model considers it stale, conflicting, redundant, or less useful. Instead, it creates an Agent-derived Review Suggestion containing a reason and evidence references. The original Human-authored Memory remains active. When retrieval selects it for a relevant task, MemStore includes a bounded warning rather than silently hiding the memory or reducing it to effective invisibility. The suggestion does not alter the user's statement or inherit human authority.

Deterministic automation may execute an explicit human-authored lifecycle directive such as `valid_until`, a targeted replacement, `purge_after`, or `retain_forever`. In that case the authority comes from the user's recorded directive, not Luna's assessment. Resulting archive and purge behavior still follows the recoverability and retention safeguards in ADR-0012.

Safety containment remains independent of content authority. Secret Content is excluded from Luna, indexes, injection, and other prohibited paths under ADR-0013 even when it appears in a Human-authored Obsidian note. MemStore warns the user but does not silently rewrite or delete that source text.
