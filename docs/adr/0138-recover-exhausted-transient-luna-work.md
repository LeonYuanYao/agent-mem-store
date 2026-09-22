# ADR-0138: Recover exhausted transient Luna work after a cooldown

Status: accepted.

## Decision

Keep the initial attempt and six fast retries. An exhausted queue operation whose
last failure is `timeout`, `unavailable`, or `rate_limited` may receive at most two
additional single-attempt recovery probes per manual retry epoch. Each probe
requires six hours since the last failure, healthy model state, and a successful
independent model operation after that failure. This reuses ordinary Worker claims;
it introduces no health-only model calls or idle write transactions.

Migration 0061 records the probe count durably, including for historical blocked
operations. Claiming a probe increments this count in the same lease transaction.
A failed probe goes directly back to blocked without reopening the fast retry
sequence. A manual retry resets the epoch and its recovery allowance while
preserving lifetime attempts. Non-transient, schema, authentication, configuration,
input-size and local-processing failures remain explicit-retry-only after exhaustion.

Doctor distinguishes waiting for recovery evidence/cooldown from stopped automatic
retries requiring intervention. A timeout alone is not evidence of a network
outage. This supersedes ADR-0122's blanket classification of timeout-blocked work as
an offline pause and extends ADR-0091's manual-only exhausted retry behavior.

Process deadline diagnostics retain duration, deadline, input character count and
stdout/stderr byte counts, without prompt, model output, credentials or paths.

## Limits

With no independent successful work there is no automatic recovery probe. Doctor
shows this waiting condition; explicit retry remains available. Persistent task
failures stop after the bounded allowance, so intermittent network recovery cannot
cause unlimited model spend. Model identity, reasoning effort and service tier are
unchanged.
