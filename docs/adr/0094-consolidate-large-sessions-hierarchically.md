---
status: accepted
---

# Consolidate large Sessions hierarchically

Codex rejects one prompt above 1,048,576 characters. A long-lived real Session produced 1,323 completed distillation Batches whose combined consolidation input exceeded that limit. Retrying the same flat request could never succeed.

The Codex Luna adapter uses 900,000 characters as its initial request budget. When a Session exceeds that budget, it partitions the ordered Batch results, consolidates each partition, and then consolidates the partial results. It repeats this process when another level is still too large. Each level uses Luna's existing bounded consolidation schema and restores original evidence identities before the next level, so the final result remains traceable to the source Capture Events.

This behavior is local to Session consolidation. Individual distillation Batches retain their existing event and byte limits and their schema-invalid split behavior.

Process failure classification examines the terminal Codex error instead of the echoed prompt body. An explicit `input_too_large` rejection is recorded as a non-retryable operation capacity error. Knowledge text that happens to contain words such as `config`, `authentication`, or `invalid schema` cannot change the failure category.

The 900,000-character budget leaves room below the observed Codex hard limit. It may be lowered through reviewed configuration later. Raising it requires evidence that the host limit also changed.
