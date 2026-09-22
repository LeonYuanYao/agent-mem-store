# Economical corpus retention

Status: proposal; read-only model pilot completed. Automatic corpus archival is not enabled.

The first repository-local implementation and its remaining activation gates are
tracked in the [implementation plan](economical-corpus-retention-implementation-plan.md).
The current code conservatively counts automatic selected receipts and all revisions
as recent activity; the more selective activity policy below is a later step.

## Goal and boundaries

Keep useful Agent-derived Active knowledge within a stable budget while admitting
new knowledge. Preserve the existing automatic-recall working set. This proposal
adds a separate retention decision for the complete Active corpus, including
knowledge excluded from automatic ranking.

Human-authored knowledge, explicit pins, retain-forever directives, startup-always
rules and unresolved review/conflict work remain protected. Safety, failure-recovery
and preference categories remain conservatively protected in the first version.
If protection or recent activity prevents convergence, report the excess rather
than silently weakening protection.

Initial configurable high-water/target pairs: 3,000/2,700 per Project and
6,000/5,500 across all Agent-derived Active spaces. Both corpus budgets apply;
migration between projects does not evade the aggregate budget. Archived knowledge
and runtime audit data have separate retention policies.

## Local selection before model review

Every six hours, check inventory locally. Below high water, do no capacity-related
model work. Above high water, select a revision-bound shortlist, prioritizing:

1. Already reviewed replacement/retirement evidence, revalidated against current
   revisions and same-scope applicability.
2. Exact duplicates only when body, conditions, exclusions, applicability,
   sensitivity and scope agree; preserve source references and protected targets.
3. Lower-priority Agent knowledge with at least fourteen days without creation,
   material content change or a selected explicit read. Automatic injection is a
   weak activity signal, not proof of value or an indefinite retention lease.

Use existing deterministic priority signals. Age selects review order; it does
not establish that a claim is false. A capacity archive has the distinct reason
`capacity_retention`, with the deciding policy, revision and comparison evidence.
Its authority is the user's accepted retention policy.

Model-based duplicate/subsumption work uses existing vectors for a small same-scope
neighborhood, not a fresh all-pairs embedding build. The model may veto retention
proposals for rare useful knowledge, identify a condition-preserving successor, or
leave the case unresolved. Uncertainty alone never authorizes archival.

## Bounded model cost

- Keep Luna medium and the standard service tier; no Fast mode or new model service.
- Reuse reviewed decisions with matching revision identities. Cache decisions by
  memory revision, compared revisions and policy version. A scan, receipt or
  relationship-only change does not automatically require re-review.
- Initial extra review budget: up to twenty uncertain entries per day, in one
  batch, with at most 15,000 locally estimated input tokens in total.
  Split oversized batches without truncating material conditions. Defer entries
  that cannot fit. Limit retries within the same budget.
- Allow approximately 25,000–30,000 reported total tokens for a full daily batch,
  including host/schema overhead and output. This is a planning allowance, not a
  hard billing cap. Record actual usage from successful and failed calls, and
  account for cached input separately. Local prompt tokenization alone understates
  the model request. Do not add reasoning tokens again when they are included in
  reported output. Failed coverage validation consumes the same daily allowance;
  defer a retry rather than immediately purchasing another full batch.
- Start processing pressure within six hours and report unresolved excess after
  twelve hours. Protection, uncertainty or model budget may prevent convergence.

This reduces repeated full-library review. Existing scheduled governance remains
unchanged until overlap and real quality/cost are measured.

## Pilot findings and required corrections

The read-only pilot found useful duplicate candidates, but semantic similarity
and a model assertion of complete coverage are insufficient for archival. Some
proposed successors omitted API choices, atomicity, applicability exceptions or
evidence requirements. Most sampled cold entries still described reusable facts.
The protected controls were retained, which does not establish general accuracy.

Before applying a batch, validate exact target coverage and unique IDs. A missing
decision invalidates that batch; retain its usage record and leave knowledge
unchanged. Validate current target and successor revisions, preserve every material
condition and negative claim, and keep successors out of the same retirement set.
Incomplete coverage requires a merge proposal or retention, not a claim that the
original is redundant. Review decisions remain proposals until these checks pass.

Duplicate removal is an optimization, not a guarantee of bounded inventory. A
stable corpus requires an explicitly accepted capacity policy that can retire
correct but lower-priority knowledge. Keep that decision distinct from declaring
knowledge invalid. Use local ranking for capacity selection and reserve the small
model budget for ambiguous comparisons; do not increase daily model review until
it offsets growth. Report unresolved excess when the policy cannot safely converge.

## Archive and recovery

Apply only through the canonical lifecycle executor with exact revision/content
identity checks and a persisted preview. Preserve archive time and the existing
three-calendar-month purge rule. Restore requires an explicit operation or new,
independent evidence passing admission; repeated extraction is not automatic
reactivation. Reuse archive/tombstone identities to prevent churn.

Background changes must not become Human-authored edits. Capacity archives are
retention choices, not declarations of invalidity. Test-looking project names
trigger a source audit, never blanket deletion.

## Validation before activation

Run a read-only preview using current inventory and actual local tokenization.
Inspect a stratified sample, especially old constraints and expensive-to-rediscover
failure knowledge. Report protected counts, proposed retention counts, reasons,
estimated token budget and unresolved excess. Verify a small reversible apply,
restore and no-resurrection cycle before scheduling the policy.

Canonical bodies can remain bounded under this policy and archive expiry. Revision
history, candidate evidence, tombstones and runtime files need separate measured
retention; stable Active counts alone do not establish bounded disk usage.
