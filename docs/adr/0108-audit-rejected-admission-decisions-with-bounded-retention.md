---
status: superseded
---

# Audit rejected Admission decisions with bounded retention

This decision was based on an incorrect assumption: a model could expose every
atomic clause it failed to retain and thereby make false negatives observable.
The model cannot count durable information that it never recognized. Recording
only its own emitted decisions creates a model-selected denominator and cannot
measure recall.

Existing `admission_audit` rows remain useful for admitted Candidate tier,
precision, and prompt-version diagnostics. They are not relabeled as recall
evidence. New production output records bounded considered-rejection and
consolidation summaries in existing Batch result JSON.

Admission Audit rows retain their existing 14-day lifecycle. Rejection summaries
store at most two bounded samples per reason and explicitly state that their
coverage is non-exhaustive. They are never written to the Memory Vault, indexed,
injected, or exposed through normal recall.

Independent source-first review is required to measure missed durable knowledge.
See [ADR-0109](./0109-separate-considered-rejection-telemetry-from-source-first-recall.md),
which supersedes this decision.
