# Governance evidence policy experiment

> Publication note: Project names, sample identifiers and private repository references are anonymized. Examples are generalized; aggregate measurements and experimental conclusions are unchanged. This is not a new experiment, and private inputs are not distributed with the repository. Sample aliases are report-only labels, not live Memory IDs.

Date: 2026-09-11

## Decision

Apply the same evidence requirements to weekly and monthly governance. Preserve conditional architecture, configuration and workflow knowledge unless supplied evidence establishes a concrete change, retirement or reviewed replacement. Keep the existing schedules and repository-read restrictions.

New model responses must include structured decision evidence: target, action, basis, remaining durable value and literal quotations with memory/revision identifiers. The adapter filters unsupported proposals; the worker checks evidence again before applying a saved response, including freshness of other cited memories. Invalid proposals are withheld individually rather than causing page-wide retries. Existing checkpoints remain readable and retain the legacy application path when no evidence field exists.

Archive is permitted for pure transient progress with no remaining durable value, or explicitly evidenced retirement. A report of checks completed/not yet executed for one run is transient when it provides no reusable method, constraint or confirmed incompatibility. Conditional architecture is not transient simply because it may change later.

Review-due flags and Human review suggestions require concrete change evidence from another supplied memory in the same scope. Monthly backlog, health and anomaly counts do not establish that an individual memory is obsolete. Supersession additionally requires the supplied duplicate-review evidence to support the replacement direction. Human reminders are deduplicated across runs by target revision and cited memory revisions, including previously handled suggestions; wording changes alone do not create another reminder.

Literal quotation checks verify provenance, scope and revision consistency. Semantic relevance and entailment still depend on model judgment; the policy cannot establish current repository truth from historical memory alone.

## Real-model experiment

Used the actual Codex Luna adapter with gpt-5.6-luna, Medium reasoning and default service tier (no fast mode). No experiment mutated the Vault or runtime database, and no business repository was read.

The core sample contained six frozen real memories from the completed weekly run: two wrongly archived component architecture/metadata statements, three conditional configuration/API statements, and one model verification-progress report. Four explicitly synthetic controls supplied a port change and an explicit retirement. The monthly replay also received synthetic aggregate health/backlog signals to test whether those signals incorrectly triggered memory changes.

| Version / run | Outcome |
| --- | --- |
| Initial rules: weekly, monthly, weekly repeat | All three preserved the five durable real memories and handled the synthetic change/retirement; all missed the transient progress report. |
| Refined rules: weekly, monthly, weekly repeat | All three preserved the five durable real memories, archived the progress report and synthetic retired rule, and marked the synthetic changed configuration for review. |
| Refined rules: monthly with one additional saved Human MR preference | Preserved the Human preference without a reminder and preserved the conditional knowledge; handled the synthetic controls, but missed the progress report again. |

The additional Human example came from an earlier saved experiment sample; the original six-memory sample contained no Human-authored entries. Synthetic control outcomes are not evidence of production knowledge yield.

Seven real calls consumed 101,409 input tokens and 6,254 output tokens in about 161 seconds, including 7,936 cached input tokens. The four final-version calls consumed 58,250 input and 3,899 output tokens. This small experiment does not establish production token overhead or broad accuracy.

## Validation and limits

The full repository test suite passed: 100 files, 443 tests. Added coverage checks unsupported/fabricated/stale evidence, durable-value preservation, concrete-change requirements, and cross-run Human-reminder deduplication.

The result supports deploying the shared evidence policy to reduce unsupported destructive decisions. Conservative missed cleanup remains observable: the final Human-control run retained a progress-only entry. Further production observation is needed; this was a bounded monthly replay, not a full live monthly governance run.

The two previously misarchived memories are sample-28 and sample-29. Their restoration is a separate corrective operation. Other historical review-due flags should be inspected individually rather than cleared in bulk.

Local experiment inputs, raw responses, filtered decisions and usage records use the ignored workspace tmp prefixes `memstore-governance-policy-20260911`, `memstore-governance-policy-20260911-v2`, and `memstore-governance-policy-20260911-v2-human`. These machine-local evidence files are not required to install or run MemStore.
