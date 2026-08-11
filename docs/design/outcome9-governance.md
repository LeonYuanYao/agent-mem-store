# Outcome 9 scheduled governance

Status: review candidate; repository-local and uninstalled.

## Scheduling and catch-up

The Runtime stores the fixed `Asia/Shanghai` IANA time zone and creates
auditable obligations for every due occurrence:

- Weekly is Monday at 19:00 Beijing time.
- Monthly is the first Monday at 19:00 Beijing time.
- A Monthly run performs the complete Weekly duty and satisfies both sets of
  linked obligations without a second Luna invocation.
- Missed occurrences remain individually visible but are coalesced into one
  catch-up run with a bounded recovered-occurrence count.
- Catch-up waits at least ten minutes after Worker startup.
- At most one deep governance run exists. It yields while Capture work or a
  live retrieval-index build is pending.

Temporal arithmetic uses `@js-temporal/polyfill` with the fixed IANA zone, so
the schedule does not change when the host machine changes time zone.

## Fixed coverage and restartability

Run creation freezes both `coverage_through` and the exact Memory revision list
for each phase. Knowledge written after that snapshot belongs to the next run,
even if the current run takes hours or is retried.

Each page has an integrity-bound input and output checkpoint. A Luna result is
persisted before actions are applied. Action keys and state-aware Canonical
writes make replay idempotent; a changed post-snapshot revision is skipped
rather than overwritten. Weekly and Monthly cursors advance atomically only
after every page and action in the logical run completes. A failed or blocked
run retains its linked obligations and does not advance coverage.

## Weekly and Monthly duties

Weekly input includes all revisions changed since the previous successful
Weekly cursor plus their direct relationship neighborhood. Luna may propose:

- consolidation by superseding an Agent-derived Memory with an active
  Agent-derived successor of the same scope and applicability;
- archiving stale Agent-derived Memory;
- adding an evidence-bound relationship between frozen-run identities;
- a Review Suggestion for conflicted or outdated Human-authored Memory.

Monthly runs execute the Weekly phase first, then paginate every Active and
Archived Memory revision. The full graph is covered through each source
Memory's relationship metadata. Every Monthly page also receives bounded
Runtime audit signals for broken relationship targets, exact duplicate groups,
Vault conflicts, high-value anomalies, irrelevant Bad Cases, retrieval
distribution, index selection/build state, Luna health, and Capture/Luna
backlog. Archived Memory may produce only a future purge obligation; Outcome 9
does not delete data.

## Authority and model safety

The Codex Luna adapter has a versioned `review_memory_governance_page` task and
structured output schema. It always invokes `gpt-5.6-luna`; there is no fallback
model. Local validation rejects an Agent action against Human-authored Memory,
an out-of-run relationship, an invalid supersession boundary, or a purge
proposal for non-Archived Memory.

Human-authored content is never rewritten, merged, archived, or deleted by
governance. Its Review Suggestions retain bounded reasons and evidence
references for the Outcome 10 Review Inbox. Summaries are bounded to 16 items
per page, 240 characters per item, and 32 items per completed run.

Retryable Luna failures use bounded exponential backoff and update the shared
model-health state. Invalid model, authentication, or configuration failures
block the run and remain visible through Luna health. A successful real
governance call participates in the same probe-plus-work recovery rule as other
Luna operations.

## Verification map

| Claim | Evidence |
| --- | --- |
| IANA/DST schedule, startup delay, missed-run coalescing, and one active run | `tests/unit/scheduling/governance-schedule.test.ts` |
| Agent supersession/relationship actions and Human Review Suggestion boundary | `tests/integration/governance/governance-run.test.ts` |
| Weekly then Monthly pagination, full Active/Archived coverage, audit signals, and purge obligation only | `tests/integration/governance/monthly-audit.test.ts` |
| Versioned authority-safe Codex Luna governance task | `tests/integration/governance/luna-governance-adapter.test.ts` |
| Fixed revision snapshot, durable reviewed output, restart, and final-only cursor | `tests/fault/governance/governance-checkpoint.test.ts` |
| Capture/index yielding, Luna backoff, model health, and unchanged failure cursor | `tests/fault/governance/governance-retry.test.ts` |

## Deliberately inactive

Outcome 9 does not install or register a scheduler, Worker, Hook, MCP server,
Skill, notification helper, or LaunchAgent. It does not write a real Obsidian
Vault, generate the Review Inbox view, execute purge, inject context, replace
Codex native memory, or enable the E5-base q8 Shadow candidate. Those remain
behind later review gates.
