---
status: accepted
---

# Separate considered-rejection telemetry from source-first recall verification

Production distillation and independent recall verification answer different
questions and must use different data sources.

Each distillation Batch returns full Candidate objects only for `long_term` and
`project_phase` clauses. It also returns a bounded `rejectionSummary` for
memory-shaped clauses that the model explicitly considered and rejected. The
summary contains counts for `no_memory`, `session_only`, `uncertain`, and
`source_echo`, plus at most two samples per reason. A sample contains a bounded
proposition and no more than four evidence identities. Pure tool noise and input
that the model did not recognize may be omitted without a count. The schema
labels this as `considered_memory_shaped_rejections_only`; reports cannot present
it as recall or complete source coverage.

The model-facing schema limits the total diagnostic sample count. MemStore then
deterministically keeps at most two samples for each rejection reason. A sample
that cites no supplied evidence identity is discarded while its aggregate count
is retained; an admitted Candidate that cites unknown evidence still fails the
operation. Diagnostic formatting therefore cannot discard otherwise valid
knowledge or weaken Candidate provenance.

Session consolidation receives only durable Candidates. It may deduplicate,
identify a source echo, or downgrade retention. It cannot upgrade retention or
restore rejected clauses. A bounded `consolidationSummary` records counts and at
most two evidence-linked samples for each action. Recursive consolidation merges
the counts from every level and retains the same bounded sample cap.

An explicit-user-backed durable input omitted without any represented evidence
is not accepted as a consolidation rejection: the Worker restores that original
Candidate locally. This coverage fallback applies only to Candidates already
admitted by distillation and therefore does not reconstruct `no_memory`,
`session_only`, `uncertain`, or source material that Luna never proposed.

Recall is measured by a separate Knowledge Verification Run. Its sampling frame
starts from Source Sessions, without using emitted Candidates as the source of
the sample. Sessions are selected across declared strata such as Project,
recency, length, and event kind. The reviewer then groups related source evidence
inside each sampled Session and assigns one disposition:

- `matched_durable`: the source contains eligible durable knowledge and an active
  Canonical Memory represents it;
- `missed_durable`: the source contains eligible durable knowledge but no active
  Canonical Memory represents it;
- `correct_omission`: the source does not contain durable knowledge;
- `ambiguous`: the available source evidence is insufficient to decide.

Recall is `matched_durable / (matched_durable + missed_durable)`. Ambiguous and
correctly omitted units do not enter the denominator. The Runtime validates that
every source reference belongs to the declared Session and Turn, and that every
matched Memory identity is active. A model may propose labels, but
`model_proposed_human_confirmed` means a human confirmed the final result.
Eligible durable knowledge is reusable, evidence-supported, in scope, and not a
pure source echo. A Skill, specification, or prior Memory that is merely read or
repeated is therefore a correct omission rather than a recall hit.
`model_proposed` is accepted only by the zero-write preview path; a persisted
run must be `human` or `model_proposed_human_confirmed`.

Verification Runs are Machine-local Runtime Data. They are not Durable Memory,
do not enter retrieval, and do not authorize automatic threshold changes. The
recorded policy identity is `source-first-recall-v1`, and every cited Capture
Event must fall inside the declared source window. Missed and ambiguous units
require a reviewer note. The
Readiness Report shows the latest independently reviewed recall result alongside
admitted tier distribution, considered-rejection counts, consolidation actions,
and live retrieval latency. Full Cutover still requires explicit human Review.

Historical Capture Events may be replayed to validate a revised derived
contract when their complete segments remain available. This does not restart
the seven-day observation window because the capture and live retrieval evidence
remain unchanged. Any missing source coverage must be stated in the Readiness
Report; additional observation is required only when the retained source is too
sparse to support review.
