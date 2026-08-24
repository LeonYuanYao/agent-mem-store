---
status: accepted
---

# Audit rejected Admission decisions with bounded retention

Shadow validation must measure both over-retention and mistaken rejection.
Filtering `no_memory`, `session_only`, `uncertain`, or task-observation clauses
before any auditable persistence makes false negatives invisible even when the
Candidate and promotion paths correctly expose over-retention.

The Worker therefore records every bounded atomic Admission decision in
Machine-local Runtime Data before applying the deterministic Candidate gate.
The record includes the operation and source identity, ordinal, exact
`retentionDecision`, abstraction level, admitted/rejected/isolated outcome,
bounded model-derived statement, evidence identities, policy version, and the
actual distillation or consolidation prompt version. It is never written to the
Memory Vault, indexed, injected, or exposed through normal recall. A local
sensitivity check removes both the statement and its content hash when it is not
Normal.

Admission Audit rows expire after 14 calendar days. The Worker performs at most
one scheduled pruning write per day and catches up after downtime. Ordinary
Batch and consolidation results persist only admitted clauses, so rejected
statements do not survive by being copied into long-lived `result_json`.

The Shadow Readiness Report aggregates decision and reason counts, redaction
counts, and bounded rejected/isolated samples. The audit is diagnostic evidence,
not a Candidate queue, second memory store, or automatic repair input.
