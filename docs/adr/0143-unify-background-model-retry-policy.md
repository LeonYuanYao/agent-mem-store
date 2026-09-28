# ADR-0143: Unify background model retry policy

Status: Accepted

## Context

Ordinary Luna operations could recover after connectivity or authentication
returned, while governance, Compact quality and duplicate assessment could remain
blocked indefinitely. Their independent limits also made a batch's oldest item
consume newer items' budgets. The user approved applying the ordinary policy to
appropriate background model work while preserving bounded cost.

## Decision

Share retry timing and eligibility in `luna/recovery-policy.ts`. Keep queue storage,
leases, checkpoints and completion semantics in their existing modules.

- Retryable failure allows the initial call plus six retries: 30, 60, 120, 240,
  480 and 900 seconds, multiplied by deterministic 0.9–1.0 jitter. Worker scheduling
  and health throttling can delay actual execution beyond these earliest times.
- Exhausted timeout, unavailable and rate-limit failures can receive at most two
  additional recovery attempts. Authentication failures stop immediately and can
  use the same allowance without consuming seven initial calls.
- Each recovery requires six hours since the last failure, a later independent
  model success, and current healthy model state. A failed recovery does not
  restart fast retries. Changing failure category does not replenish the budget.
- Blocked schema, configuration, input and local failures require explicit
  handling. A valid semantic rejection or uncertain judgment is not a failed call.
- Budgets belong to individual jobs or processing steps. Compact generation
  success starts a fresh validation budget, preserving the draft and lifetime
  attempts. Governance success resets the page budget; recovery retains frozen
  inputs, already applied pages and successful coverage. Duplicate jobs have an
  independent attempt counter. Mixed batches do not share their oldest budget.
- Doctor uses the same eligibility rules for ordinary work, governance, Compact
  quality and duplicates. Authentication remains a warning until recovery evidence
  exists. Exhausted recovery remains actionable even when the model is healthy.

Migration 0066 adds the missing counters. Duplicate jobs blocked under the old
six-attempt limit are marked budget-exhausted without increasing their lifetime
count. Pending validation drafts start a separate validation budget. Existing
explicit retry entry points reset the relevant recovery allowance as well.

## Consequences and verification

No health-only model calls, new queue, scheduler or dependency is introduced.
Hooks, frontend Jev fallback and local maintenance retries remain unchanged.
If no subsequent real model work succeeds, automatic recovery waits; this policy
does not infer restored authentication from elapsed time or a Worker restart.

Worker/Doctor integration tests cover authentication recovery, frozen governance
pages, duplicate retry exhaustion and the two-probe bound, separate Compact stage
budgets, and schema failures remaining blocked after unrelated successful work.
Existing ordinary queue, health, lifecycle and governance tests remain required.
Mock adapters establish retry/state behavior, not model knowledge quality.
