---
status: accepted
---

# Derive Admission lifecycle from atomic clauses

Luna must split mixed evidence into atomic clauses before retention
classification. Each clause receives exactly one `retentionDecision`:
`long_term`, `project_phase`, `session_only`, `no_memory`, or `uncertain`.
It cannot preserve a transient observation by attaching it to a reusable rule.

Luna owns semantic classification; MemStore code owns deterministic enforcement.
The adapter returns every bounded atomic decision so the Worker can audit the
decision before admitting only `long_term` and `project_phase` clauses that are
not task observations. `no_memory`, `session_only`, and task-observation clauses
do not enter Candidate creation. `uncertain` remains explicitly isolated outside
normal recall and cannot become long-term merely because a later model call is
optimistic. Consolidation cannot make a cited input less restrictive than its
strictest supplied retention decision. Exact Candidate
fingerprints map deterministically to the executable novelty operations:
new identity is `insert`; an existing exact identity is `update(alias)`.
Non-memory clauses are omitted and ambiguous clauses remain uncertain. Broader
semantic merge or revision remains governed by reviewed duplicate evidence.

Raw distillation and consolidation output permits at most 128 atomic clauses so
a long Session containing many rejected observations does not lose a smaller set
of durable clauses. No more than 64 admitted clauses may enter Candidate
creation; overflow is a visible retryable retention-validation failure rather
than silent truncation.

Exact run identifiers, timestamps, backup paths, current branch state,
completed-action inventories, operational probes, and exact-response checks are
`no_memory` by default unless a separate atomic clause establishes a durable
recovery contract.

See [ADR-0108](./0108-audit-rejected-admission-decisions-with-bounded-retention.md)
for bounded Shadow observability of accepted, rejected, and uncertain clauses.
