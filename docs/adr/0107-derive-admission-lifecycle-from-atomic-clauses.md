---
status: accepted
---

# Derive Admission lifecycle from atomic clauses

Luna must split mixed evidence into atomic clauses before retention
classification. It cannot preserve a transient observation by attaching it to
a reusable rule.

Luna owns semantic classification; MemStore code owns deterministic enforcement.
The distillation adapter returns full Candidate objects only for `long_term` and
`project_phase` clauses. It summarizes clauses that the model explicitly
considered and rejected in a bounded `rejectionSummary`; that summary is
diagnostic data and cannot enter Candidate creation. Pure tool noise and input
that the model did not recognize as memory-shaped may be omitted without a
count. The summary therefore measures the model's considered rejection
distribution, not recall or complete input coverage.

Consolidation receives only admitted durable Candidates. It may deduplicate,
identify a source echo, or downgrade a clause, but it cannot upgrade
`project_phase` to `long_term` or reconstruct a rejected clause. These actions
are recorded in a bounded `consolidationSummary`. Exact Candidate fingerprints
map deterministically to the executable novelty operations: a new identity is
`insert`; an existing exact identity is `update(alias)`. Broader semantic merge
or revision remains governed by reviewed duplicate evidence.

Consolidation also cannot silently erase a durable Candidate supported by an
explicit user statement. If no output Candidate represents any of that input's
evidence, the Worker restores the original Candidate before the existing
admission limit and Promotion Gate. The restored content remains Agent-derived;
this protects coverage without granting Human-authored authority or bypassing
semantic validation.

Raw distillation and consolidation output permits at most 128 durable Candidate
objects. No more than 64 admitted clauses may enter Candidate creation;
overflow is a visible retryable retention-validation failure rather than silent
truncation. Rejected-clause counts do not consume this Candidate allowance, and
each rejection or consolidation action retains at most two bounded samples.

Exact run identifiers, timestamps, backup paths, current branch state,
completed-action inventories, operational probes, and exact-response checks are
`no_memory` by default unless a separate atomic clause establishes a durable
recovery contract.

See [ADR-0109](./0109-separate-considered-rejection-telemetry-from-source-first-recall.md)
for the separation between production diagnostics and independent recall
verification.
