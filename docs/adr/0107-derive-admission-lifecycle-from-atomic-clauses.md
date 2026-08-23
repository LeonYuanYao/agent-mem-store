---
status: accepted
---

# Derive Admission lifecycle from atomic clauses

Luna must split mixed evidence into atomic clauses before retention
classification. Each clause receives exactly one `retentionDecision`:
`long_term`, `project_phase`, `session_only`, `no_memory`, or `uncertain`.
It cannot preserve a transient observation by attaching it to a reusable rule.

MemStore code, not the model, maps that decision to Candidate durability. It
drops `no_memory`, `session_only`, and task-observation clauses before Candidate
creation. `uncertain` remains isolated outside normal recall and cannot become
long-term merely because a later model call is optimistic. Exact Candidate
fingerprints map deterministically to the executable novelty operations:
new identity is `insert`; an existing exact identity is `update(alias)`.
Non-memory clauses are omitted and ambiguous clauses remain uncertain. Broader
semantic merge or revision remains governed by reviewed duplicate evidence.

Exact run identifiers, timestamps, backup paths, current branch state,
completed-action inventories, operational probes, and exact-response checks are
`no_memory` by default unless a separate atomic clause establishes a durable
recovery contract.
