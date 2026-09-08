---
status: accepted
---

# Separate current health from historical failures

The old Doctor kept three recovered deadlines in `degraded` for six hours, while
twenty `failed`/`unavailable` requests could pass the same check. It also treated
the index scheduler's deliberate five-minute backlog wait as a two-minute SLA
violation. These are inconsistent health rules, not evidence that retry counters
or diagnostic history need to be reset.

Doctor and Status now reuse current foreground and index assessments. Historical
counts remain available. Foreground failures use a fifteen-minute detection window;
recovery requires ten quiet minutes and five completed logical requests after the
last failure. Empty responses and cancellation are not recovery evidence. Duplicate
observations of one event cannot inflate counts or manufacture successful recovery.
Without enough new traffic, the result is awaiting verification; no model probe is
added. Assessment is derived from retained evidence and creates no new incident table.

Doctor adds `observing` for informational recovery and synchronization states.
It retains `degraded` for active warnings and `error` for integrity failures. This
is an additive status vocabulary change: clients must not interpret `observing` as
either a verified healthy state or an outage.

The worker and health checks share the existing bounded index wait calculation.
Background recovery has a thirty-minute bound and a sixty-second scheduling grace,
so normal coalescing is visible without suppressing a genuinely stalled index.
Publishing the outstanding generation clears its warning. Existing Luna retry,
connectivity, notification, and evidence-integrity policies are unchanged.

Tests exercise the actual Doctor path for failures and recovery, sparse traffic,
historical faults, overflow and duplicate observations, plus the shared scheduling
decision for normal backlog waits, retries, stalled generations, and publication.
