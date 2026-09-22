# Corpus retention implementation and activation plan

Status: fixed-capacity implementation deployed; initial convergence and live verification completed.

## Current delivery

ADR-0140 supersedes the unfinished admission requirement recorded in the historical
experiment sections below. The managed writer now reserves aggregate Active slots;
capacity-blocked Candidates resume through Worker evaluation without repeating a
matching model assessment. The approved configuration is `mode = "apply"`,
`active_limit = 5000`, `active_headroom = 50`. Fixed mode preserves hard protections
but replaces the earlier per-project thresholds and cold eligibility window.
No full-corpus model backfill or early purge is included. See ADR-0140 for crash
recovery boundaries and external-edit exceptions.

Deployment validation passed 562 tests (3 skipped), type checking, lint and build.
The live stock reached the configured low-water count through fourteen bounded
batches. Each archived entry retained its body, applicability and semantic
contract; Human knowledge and protected-entry counts were unchanged. Runtime
integrity and foreign-key checks passed, all canonical catalog entries validated,
and the restarted Worker published the current retrieval generation. The local
preview, application audit and health evidence contain private identities and are
kept outside the repository. Existing long-lived MCP processes require reconnecting
to adopt the new manual-write admission guard.

## Revised trial scope

The user selected an aggregate Active limit of **5,000**, including Human-authored
entries, for the next fixed-capacity experiment. Do not apply the previously
suggested 2,000 aggregate, 1,000 Project or 200 Global limits as part of this trial.
Existing per-space automatic-ranking policy remains separate and unchanged.
No early archive purge is included in this trial.

The experiments below preceded the admission guard. Their soft-convergence
implementation and read-only results are historical; changing only a soft
high-water setting would not implement the new fixed-capacity contract.

A read-only full-inventory simulation filled the revised budget while preserving
Human and conservatively held Private entries. Its provisional local ordering
used explicit selected reads, existing retrieval tiers, then creation time; it
did not refresh activity from automatic injection or maintenance revisions.
The ordering placed every target from the earlier twenty-item semantic pilot in
the archive set, including useful API and protocol controls. This demonstrates a
recency bias and does not establish appropriate value-based selection. The
simulation is not apply-compatible and performed no canonical changes. Keep the
5,000 experiment target, improve and review selection, then implement and verify
the aggregate write guard before claiming a stable hard limit.

The subsequent read-only comparison tested capped recency, source-session
diversity and same-Project lexical coverage against the same fixed inventory.
On forty newly sampled items reviewed before the revised rankings, capped recency
left selection unchanged. Source diversity gained one preferred-retention item
net while retaining more lower-priority content. Lexical coverage added no net
preferred-retention gain. These are diagnostic primary-agent labels, not an
independent accuracy benchmark; provenance diversity and vocabulary coverage did
not establish semantic utility or successor coverage. No model-derived source
independence was invented where recorded evidence lacked distinct sessions.

A single twenty-target Luna Medium content-priority test completed but failed
target-bound quote validation. It consumed 23,411 reported tokens and produced no
accepted decisions; no retry or live archive followed. The rejected response body
was not retained, so the specific quote defect remains unknown. Future experiments
should retain sensitivity-checked rejected output and prefer target-local evidence
segment identifiers with deterministic quote rendering. This still requires
semantic review. Cache any future accepted content-priority signal by revision
and compute it during existing extraction/governance where practical; do not
activate a full-corpus model backfill based on these results.

The approved same-sample follow-up replaced verbatim model quotations with
target-namespaced source-segment IDs and deterministic rendering. All twenty
targets and fifty-seven references passed validation; all original input field
values were preserved. The single Luna Medium call used 24,453 tokens. It assigned
high priority to sixteen items, normal to one and low to three. Fourteen items
previously judged preferred-retention remained high, and both previously judged
lower-priority items were low. One mixed item was also low and requires caution.
These are primary-agent diagnostic labels, not verified current facts or an
independent quality benchmark.

A predeclared equal-slot local comparison retained ten items under each ordering.
Content-priority-first ordering removed one lower-priority observation but replaced
it with mixed content; preferred-retention items remained eight. This supports
further low-value screening tests, not a claim of improved full-corpus selection.
High-priority saturation still leaves capacity tie-breaking unresolved. Preserve
segment references and revision-bound caching as candidate design improvements;
do not grant model priority immunity from the aggregate cap or activate archival
from this single successful call.

A fresh twenty-target boundary experiment kept the same prompt and segment
protocol, with no overlap against the preceding sampled cases. Diagnostic groups
were recorded before the call: five concrete-rule controls, five lower-priority
controls and ten mixed cases. One Luna Medium call used 25,016 tokens and completed
in about sixty-four seconds. All twenty decisions and fifty-four target-local
references validated; 172 original input field values were preserved. The model
assigned fifteen high and five low priorities. All five rule controls were high;
three of five lower-priority controls were low. Two task-specific specification
records were high. Of seven mixed cases flagged beforehand as containing a
specific useful constraint, six were high and one historical diagnosis was low;
the remaining three ambiguous mixed cases received two high and one low.

Review found useful screening of asset descriptions and one-run status, alongside
unresolved preference for narrow task requirements and possible loss of scoped
diagnostic context. These disagreements concern competitive retention, not proven
factual errors or independently measured accuracy. A high label still cannot
establish durable utility, current validity or protection from eviction. This
enriched sample does not estimate the full-corpus useful fraction. The experiment
made no canonical changes and did not test an aggregate hard limit. Further design
should separate content type from retention horizon and keep model labels as
revision-bound soft ranking signals under a deterministic aggregate capacity
contract. At that experiment stage, full-corpus model backfill and automatic
archival had not been approved; the later fixed-capacity approval is recorded above.

## Retention-value implementation

The approved follow-up is implemented repository-locally. Shared Luna prompts
separate content kind from retention horizon, concrete future use and competitive
priority. Extraction and consolidation return the judgment in their existing call;
promotion persists it in a semantic-input-bound Runtime cache. Governance freezes
at most twenty missing targets per existing page and supplements them without a
standalone model request. Cached content/policy matches are skipped, and absent,
malformed or old-version values remain unknown. See ADR-0139.

Capacity previews now order eligible items by effective value, then the existing
priority/activity tie-breaks. Unknown values compete with normal; high values
remain eligible. Task requirements, artifact details, run results and non-durable
horizons cannot gain effective high priority from the raw high label. Model reasons
are not written to canonical knowledge or injected into sessions.

One read-only real governance-adapter call on the preceding twenty boundary cases
used 27,424 tokens and about fifty-eight seconds, with no retry or applied action.
All twenty assessments returned: thirteen effective high, six normal and one low.
All five concrete-rule controls remained high; a report requirement moved from
high to normal and conditional diagnostic context from low to normal. Two narrow
asset descriptions also moved from low to normal. These results do not establish
stronger low-value filtering overall. Changed task/context prevents attributing
the difference solely to the new prompt or measuring incremental token overhead.

The retention-value experiment did not activate migration 0063. The subsequent
approved delivery adds migration 0064 and the aggregate admission guard, while
reusing this value signal as a soft ranking factor.

## Implemented deterministic path

The existing working-set policy remains unchanged. The new corpus module offers
application interfaces in [corpus-retention.ts](../../src/capacity/corpus-retention.ts):

- `previewCorpusRetention`: read-only, deterministic selection over all Active
  Agent-derived knowledge, including entries excluded from automatic ranking.
- `applyCorpusRetention`: explicit authorization of the exact preview, guarded
  canonical archival and a persisted operation result. This is capacity retention;
  it makes no claim that the archived knowledge is false or redundant.
- `runScheduledCorpusRetention`: configurable preview or archive scheduling,
  with one catch-up check after missed intervals and five-minute failure backoff.
- `inspectCorpusRetention`: configuration, remaining excess, pending plan,
  last execution/error and pressure older than twelve hours.

The Worker reads portable `[corpus_retention]` policy. Its `mode` defaults to
`off`; `preview` records proposals without changing knowledge, and `apply`
executes protected capacity archival. Missing or invalid current configuration
cannot authorize archival, including last-known-good fallback. Model calls and
embeddings are not generated. The optional `corpusRetentionPreviewPolicy` test
adapter continues to support preview-only invocation.

The CLI exposes `capacity corpus status`, `capacity corpus preview --json`, and
`capacity corpus apply --file PREVIEW.json --gate DIGEST --apply`. The last command
authorizes only the reviewed batch and does not enable recurring archival.
Regular `status` includes the same corpus inspection. There is no new MCP tool.

Example portable policy, disabled until separately reviewed:

```toml
[corpus_retention]
mode = "off"
project_high_water = 3000
project_target = 2700
aggregate_high_water = 6000
aggregate_target = 5500
cold_days = 14
batch_size = 50
```

The implementation adds migration 0062 for exact execution plans and a singleton
schedule and pressure episodes. The migration is repository-local until deployment. It does not
change the previously deployed connection-recovery migration.

## Selection and execution contract

Defaults are Project high water/target 3,000/2,700 and aggregate 6,000/5,500.
Global knowledge contributes to the aggregate; it does not receive a new separate
corpus threshold in this slice. Human-authored knowledge is excluded from these
counts. Protected Agent-derived knowledge counts toward pressure but cannot be
selected. A default batch proposes at most 50 archives, with a configurable upper
bound of 200, and reports unresolved excess without weakening protections.

Protection includes pins, retain-forever, startup-always, open review/verification
and Human conflict work, controlled safety/recovery/preference categories, and
Private knowledge. A test-looking Project name has no effect on selection.

Selection requires at least fourteen days without creation, revision or a selected
receipt. This first slice conservatively includes automatic receipts and all
revisions. It never uses ranking `excluded_at` as an inactivity clock. A receipt
retention policy shorter than the inactivity window blocks preview generation.
Effective retention value orders the eligible pool before priority tier,
importance-tag count, activity time and stable identity. Without a usable value,
an entry competes as normal. These are retention preferences, not a validated
measure of usefulness. A representative live preview remains required.

Project excess is selected first, then remaining aggregate excess. A bounded
preview describes one batch. Persisted pressure episodes continue below high water
until their target is reached. Execution rechecks current counts before every
archive, including changes made by other governance or manual operations.

Idle checks occur every six hours. Batches making progress continue after thirty
seconds; failures retry after five minutes. A five-minute claim lease recovers
interrupted scheduling. Each archive loop yields between items after ten seconds
or when foreground pressure is observed. This is a cooperative limit, not a hard
deadline on one filesystem operation or the read-only inventory scan. The next run
resumes the exact pending plan while it remains valid. Configuration changes are
rechecked between items and stop execution; changing policy starts a fresh plan.
Unsatisfied protection/cold-window constraints remain visible and are revisited
after six hours. Twelve-hour unresolved pressure is reported, not forcibly cleared.

Completed or abandoned plan records expire after 180 days, excluding the current
pending plan. Obsolete policy episodes also expire after 180 days. The schedule
uses one row. No unbounded per-check preview history is retained.

The preview binds the policy, observed inventory, selected identities and revisions
to a digest. It expires after six hours. Before first execution the module rebuilds
and compares the preview, rejecting omissions, additions and stale inputs. It
persists that exact plan before writing canonical revisions. Each write rechecks
the target revision, content identity, scope, protection and recent activity, and
uses the Vault's compare-and-swap operation. Skipped identities remain visible in
the result; a partial write failure is not presented as a completed batch.

Archive provenance uses `capacity_retention:<digest>`, not a manual-action marker.
Existing three-calendar-month retention and explicit restore remain in force.
Canonical operation markers support retry after partial progress; completed replay
returns its recorded result and cannot undo a later restore. This does not provide
an atomic transaction across multiple Markdown files.

## Confirmed verification seams

The user confirmed tests through capacity preview, archive/restore, Worker
scheduling and Candidate re-ingestion interfaces. Current coverage includes:

| Interface | Verified behavior |
| --- | --- |
| Capacity preview | No canonical mutation; Human/startup/pin/retain-forever/safety/Private protection; cold window; local and aggregate pressure; bounded selection and visible unresolved excess |
| Archive/restore | Explicit authorization; exact preview; stale, expired and modified preview rejection; capacity provenance; purge deadline; idempotent replay; restore survives old-plan replay; interrupted execution resumes while respecting Human revisions and independent archives |
| Worker | Default off; six-hour coalescing; short receipt history defers with backoff; preview does not archive; bounded apply continues below high water; disabling stops remaining work; persisted paused plans resume on the next due run; last-known-good configuration cannot authorize archival |
| CLI/status | Reviewed JSON round trip; wrong digest rejection; explicit one-batch apply; read-only preview works on schema 61 without migrating; strict default readers still require current schema |
| Candidate re-ingestion | The same fingerprint and old source evidence reuse the promoted identity without reactivating its archived memory |

Malformed semantic successor fields cannot be smuggled into a deterministic
preview. This is not a test of a model-review pipeline: that pipeline is not
connected. Arbitrarily paraphrased duplicate creation is not covered by the exact
fingerprint regression.

## Activation assessment

The read-only real-corpus preview exposed reusable API, protocol and architectural
rules among the oldest normal-priority entries. All sampled proposals had a known
normal retrieval tier; this finding was not caused by a missing index row. The
current retention order is deterministic, but retrieval priority and elapsed time
do not establish which knowledge is least worth keeping.

Keep recurring application off until the user reviews this trade-off or a revised
selection policy passes content review. Execution tests establish authorization,
protection and recovery behavior; they do not establish retention quality. Local
preview artifacts remain outside the repository and include no live archival.

### Next content-screening experiment

The follow-up read-only audit found no exact duplicate group under the strict
signature of scope, body, applicability, semantic contract, validity, sensitivity
and primary category. This does not exclude semantic duplicates or variants with
different metadata. Existing promoted Candidate classifications also did not
provide a ready-made pool of confirmed task observations; older classifications
may be absent and must not be interpreted as low value.

Prepare a bounded content-screening experiment before changing the automatic
selector. First enumerate reusable facts that would be lost. Distinguish reusable
rules, artifact-specific configuration, one-run status, mixed content and unknown
cases. Artifact names, code identifiers, literal values and conditional scope alone
cannot establish disposability. Keep mixed content and reusable protocol/API
constraints. With no workspace evidence, do not infer that a task has ended or that
its details are easy to recover.

The screening output can only retain a target, request context or prioritize it
for further capacity review. It is not an apply-compatible archive plan. Validate
exact target coverage, unique identities and quotes from each target. A syntactically
valid classification still needs content review. Use at most twenty targets and
15,000 locally estimated input tokens; do not retry a failed batch outside its
allowance. Prepared samples are diagnostic, not a representative accuracy benchmark.
Additional experiments beyond the planned daily model allowance require explicit
approval; preparation does not imply a model call occurred.

The separately approved twenty-target Luna Medium screening completed with exact
coverage and valid target-bound quotes. It retained every target, labeling fifteen
as reusable rules and five as mixed content. This diagnostic sample preserved the
known reusable controls but produced no capacity-review candidates. It does not
establish broad accuracy or that every retained entry deserves indefinite storage.

Text review found a selection-policy problem: requiring retention whenever any
reusable component can be described encourages generic lessons to justify keeping
all details of a specific artifact. A button/action mapping can be generalized to
"explicit state transitions" without establishing the incremental value of that
particular mapping. Case-specific exclusions must also retain their original scope.
The next experiment should assess marginal retention value separately from factual
validity, require scope-preserving explanations and distinguish non-obvious API or
failure constraints from generic observations. Do not relax the runtime archive
guards or install this unvalidated screening as an automatic decision rule.

The follow-up marginal-value experiment reused the same twenty revision-bound
targets with revised decision criteria. Its one Luna Medium call reached the
180-second experiment deadline without a validated result or usage receipt. No
retry or live write followed. This establishes neither improvement nor regression
in screening quality, and actual token usage is unknown. A further approved test
should reduce redundant output fields and may extend the experiment-only deadline;
production Worker settings and activation remain unchanged.

The separately approved compact-output follow-up completed the same twenty-target
sample in about 155 seconds, using Luna Medium and standard service. Actual usage
was 26,937 tokens; the output proposed thirteen retentions, five capacity reviews
and two merges before retirement. Exact coverage and target-bound quotes passed.
Text review found an unsupported initialization-state change in one merge and a
condition copied from another target in the other. A capacity-review rationale
also undervalued Project-local knowledge because it lacked cross-project utility.
Only three artifact-specific proposals were reasonable priorities for further
review; none was approved or applied as an archive. This tuned diagnostic sample
does not establish a corpus-wide removal rate or accuracy.

Keep automatic content-based archival and merging disabled. A follow-up should
use held-out targets, recognize utility within the existing Project scope and test
single-target verification for the small proposed retirement set. Such verification
has unmeasured additional cost and is not implemented by this experiment. A daily
model budget alone cannot guarantee stable inventory without comparing validated
retirement throughput with incoming knowledge. Preserve original entries whenever
condition preservation or successor coverage remains uncertain.

## Historical activation checklist

The fixed-capacity approval supersedes the earlier cold-window and per-space
requirements below. The current delivery verifies hard protections and reversible
capacity archival without claiming that all selected knowledge is invalid.

1. Review a bounded live preview and explicitly accept that correct but
   lower-priority knowledge may leave Active. Do not silently reinterpret the
   existing evidence-based governance authorization.
2. Persist material-change and explicit-use timestamps independently of receipt
   cleanup before relaxing the conservative activity rule. Handle unknown history
   conservatively and avoid introducing Hook writes or model calls.
3. After preview approval, explicitly authorize deployment/migration and the
   selected first batch. Automatic activation remains a separate choice. Local
   tests prove execution guards; representative content review determines whether
   the proposed retention preference is appropriate for actual knowledge.
4. If semantic review is introduced, retain the pilot allowance of at most twenty
   entries and one call per day, Luna Medium, standard service. Validate exact
   result coverage, known same-scope successors and revision identities. The entire
   incomplete batch is deferred and still consumes its allowance. Preserve an
   active successor outside the retirement set. Conditions omitted by a model
   require merging or retention; deterministic syntax checks cannot prove semantic
   preservation. Add the agreed missing-output, successor-cycle and model-budget
   regressions at that point. A valid model verdict alone cannot archive knowledge.

The current explicit approval covers implementation, deployment and fixed-capacity
convergence. The model experiments above remain read-only evidence; full-corpus
model backfill and semantic successor retirement are excluded. Git commit and push
still require a separate user instruction.
