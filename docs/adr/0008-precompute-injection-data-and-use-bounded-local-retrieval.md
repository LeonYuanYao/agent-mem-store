---
status: accepted
---

# Precompute injection data and use bounded local retrieval

MemStore prepares Memory Injection data when Durable Memory changes, not when a foreground prompt arrives. A background indexer derives searchable text, a concise Injection Snippet, lexical and semantic indexes, relationship edges, scope and authority filters, and an immutable index revision from the human-readable Canonical Memory Data. These artifacts are machine-local, rebuildable state and never become a second authoritative Memory Vault.

Manual Obsidian edits invalidate the affected derived records through content identity or equivalent change detection. A new index revision becomes visible atomically only after its required records are ready; a failed rebuild leaves the last complete revision readable.

For each `UserPromptSubmit`, the Retrieval Query contains the current prompt plus bounded structured session signals: resolved project identity, recent files or symbols, explicit errors or commands, and Memory identities already injected in the session. It does not include the complete conversation and does not call Luna to generate a live session summary. Detailed source sessions remain available only through explicit deeper retrieval.

Foreground retrieval reads only local completed indexes. It filters to active Durable Memory, applies Project and Global scope rules, combines lexical and semantic recall, expands only bounded relationships, ranks deterministically, removes redundant or unnecessarily repeated memories, and assembles a token-bounded Relevant Memory Pack. Project Memory takes precedence in its project; Memory Candidates and unresolved conflicts never enter normal injection.

The injected pack is labeled as historical reference data rather than current user instruction. Retrieval timeout, unavailable indexes, or an in-progress rebuild must fail open without delaying the active Agent turn. Each attempt records a lightweight Injection Receipt containing the query identity, index revision, selected Memory identities, and latency. Later background analysis may use these receipts to improve ranking or propose governance work, but usage signals cannot silently alter Human-authored Memory authority or delete knowledge.

Exact index technology, embedding provider, retrieval weights, latency deadline, item count, token budget, and repetition policy require measurement and later review rather than being fixed by this decision.
