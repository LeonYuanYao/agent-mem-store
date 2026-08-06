---
status: accepted
---

# Make governance schedules catch up and recover

MemStore governs memory on four cadences. Continuous processing screens new candidates, handles retries, and detects direct conflicts. Daily maintenance performs incremental deduplication, expiration evaluation, relationship completion, and index-health checks. Weekly Luna maintenance deeply consolidates overlapping knowledge, reviews relationships and staleness, and may produce an optional governance summary. Monthly maintenance audits overall knowledge health and recoverability without performing unbounded automatic deletion.

A clock or operating-system scheduler is only a wake-up mechanism. A durable Governance Ledger records each job's schedule, last successful cursor, attempts, lease, checkpoint, next retry, and failure state. Worker startup, machine wake, new capture activity, and explicit maintenance commands all reconcile overdue jobs, so shutdown, sleep, lost wake-ups, network outages, model unavailability, worker crashes, and temporarily unavailable Vault writes cannot silently erase a maintenance obligation.

Execution is at-least-once with idempotent effects. A job is successful only after its required durable results and cursor are committed. Expired leases are reclaimable, partial work resumes from checkpoints, and duplicate execution cannot duplicate promotion, merge, rejection, expiration, or relationship effects. Network-dependent Luna work remains pending and retries with bounded exponential backoff and jitter; local work that is independently valid may proceed without pretending the whole job succeeded.

Missed calendar occurrences are coalesced into one Catch-up Run over all data since the last successful cursor rather than replayed once per missed day or week. After a long outage, continuous and daily obligations recover before weekly consolidation, and weekly obligations recover before monthly audit. Concurrency and catch-up budgets prevent a restart storm from starving foreground capture or injection.

Maintenance remains non-blocking for active Agent sessions. Backlog age, last success, retry state, and aggregated failure reasons are observable through status commands and low-frequency health summaries. Exact run times, retry intervals, lease durations, concurrency limits, backlog warning thresholds, and deletion safeguards require later review.
