---
status: accepted
---

# Aggregate and bound Bad Case diagnostics

Repeated occurrences of the same normalized Bad Case Signature aggregate into one Bad Case instead of producing one JSON file per occurrence. The signature is derived from failure kind, affected component, Project or scope, and relevant version dimensions without embedding a raw Prompt, diagnostic body, or Secret.

Each aggregate records `first_seen_at`, `last_seen_at`, occurrence count, affected versions, lightweight measurements, and at most 20 body-bearing representative samples. The bounded sample set preserves the earliest examples, recent examples, and deterministically selected diverse examples. Additional occurrences update counts and aggregate measurements without appending unbounded diagnostic bodies.

Only a newly observed real failure occurrence advances `last_seen_at`. Detection scans, retries, reminders, reprocessing, and duplicate imports cannot keep a case alive artificially.

An `open` Bad Case retains its diagnostic body for a configurable 180 calendar days from `last_seen_at`. If it has neither recurred nor received human repair activity by then, its state becomes `stale` and the body is removed. A body-free summary remains for another configurable 180 calendar days. `stale` means that the failure has not recently reproduced; it is not evidence that a fix was applied or successful.

After a case becomes `resolved` or `dismissed`, its diagnostic bodies and completed or abandoned Repair Bundle bodies remain for 30 calendar days before removal. A body-free repair and regression Ledger remains for 180 calendar days from closure. A matching occurrence during that Ledger period opens a linked regression case and captures fresh diagnostics instead of resurrecting purged bodies or assuming the earlier resolution still applies.

An active repair retains the Repair Bundle it requires. Explicitly pinned cases and bundles do not expire automatically. Every cleanup obligation is idempotent and rechecks active references; model, Worker, or governance downtime cannot cause early deletion.
