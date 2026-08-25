---
status: accepted
---

# Reject unaccounted distillation and protect multi-signal coverage

A non-empty Batch cannot complete when Luna returns neither a durable Candidate
nor a considered disposition; that output is incomplete and retryable, not
evidence that the Batch contains no reusable knowledge. Session Consolidation
must also preserve or explicitly disposition every admitted durable Candidate
backed by an explicit user statement or at least two distinct evidence-linked
importance reasons. We rejected restoring every tagged input: replaying one
real long Session would have expanded 26 consolidated outputs to 123 and crossed
the 64-item admission limit, while the multi-signal boundary produces 44. The
fallback therefore favors observable priority false negatives without turning
ordinary consolidation deduplication into Candidate inflation; restored content
remains Agent-derived and still follows the normal Promotion Gate.

`SessionStart` and `SessionEnd` envelopes are not evidence-bearing clauses by
themselves. A Batch containing only those lifecycle markers completes through a
deterministic empty result, preserves Session-consolidation boundaries, and does
not invoke or retry Luna. This is not an exception for substantive empty model
output; it prevents lifecycle bookkeeping from being misclassified as an
unaccounted knowledge decision.
