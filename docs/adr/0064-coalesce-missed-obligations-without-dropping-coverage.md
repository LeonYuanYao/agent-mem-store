---
status: accepted
---

# Coalesce missed obligations without dropping coverage

Multiple missed obligations of one cadence remain individually auditable in the Governance Ledger but point to one logical Catch-up Run. The run covers everything immediately after the last successful cadence cursor through a fixed `coverage_through` timestamp captured at run creation. Coalescing reduces repeated execution and Luna calls; it never drops data from an earlier missed interval.

A large logical run may use multiple idempotent, checkpointed batches under one stable run identity. Recoverable batch progress may advance, but the cadence's final successful cursor and all linked obligations advance to `coverage_through` only after the complete run succeeds. Failure retries the same run from its checkpoint without treating partial processing as complete.

An occurrence due after the run fixes its upper bound does not extend the active range. It creates or joins the next obligation so a moving endpoint cannot prevent completion.

An overdue Monthly Catch-up that performs all Weekly duties may atomically satisfy covered outstanding Weekly obligations after success. One bounded summary reports the coverage range and recovered occurrence count instead of one notification for every missed date.
