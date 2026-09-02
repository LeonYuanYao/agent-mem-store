---
status: accepted
---

# Use medium reasoning for managed Luna work

Every MemStore-managed `gpt-5.6-luna` process explicitly selects
`service_tier="default"` and `model_reasoning_effort="medium"`. This applies at
the shared Luna adapter seam, so distillation, consolidation, semantic and
conflict assessment, compact generation and validation, duplicate review, and
scheduled governance cannot accidentally inherit a user's global reasoning
configuration.

The first version does not dynamically route Luna work across low, medium, and
high reasoning. Deterministic work that does not need Luna remains local. When a
Luna-dependent decision is inconclusive, the applicable operation stays
retryable, waiting, quarantined, or review-due rather than silently increasing
reasoning depth or treating uncertainty as approval. Any later reasoning router
requires separate quality and cost evidence plus explicit review.
