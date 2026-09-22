# ADR-0139: Cache retention value in existing model work

Status: accepted for repository-local implementation; live activation is separate.

## Context

A model can identify a concrete instruction without establishing its long-term
retention value. Earlier read-only experiments retained many task-specific records
as high priority and occasionally classified conditional diagnostic context as
low. Repeating classification whenever capacity is checked would duplicate input
cost and allow routine scans to refresh retention signals.

## Decision

1. Evaluate content kind, retention horizon, competitive priority, concrete future
   use and reason separately. Use configured Luna Medium / standard service in
   existing extraction, consolidation and governance calls.
2. Keep missing or uncertain judgments at normal effective priority. Non-durable
   horizons and task-requirement, artifact-detail or run-result kinds cannot grant
   effective high priority. Preserve the raw model judgment for inspection.
3. Cache one assessment per Memory in Runtime SQLite. Bind it to body, scope,
   applicability and semantic contract plus a code-owned rule version. Maintenance
   revisions and access metadata do not invalidate it. Semantic changes do.
4. Ask governance to supplement at most twenty missing values per existing page.
   Freeze target hashes and policy with the checkpoint, recheck current inputs
   before caching, and reject unavailable model targets. Legacy checkpoints remain
   valid with unknown value. No separate backfill is scheduled.
5. Use effective value only in opt-in corpus-retention ordering, before existing
   tie-breaks. Human/protection/cold-window checks remain unchanged. High values
   remain eligible; values are not evidence of invalidity, admission approval or
   authorization to mutate canonical knowledge.
6. Remove cached explanations on tombstoning, identity deletion or Human authority.
   Keep them out of canonical Markdown and prompt injection.

## Consequences and boundaries

Extra output is added to existing model calls; this is not zero token overhead.
Caching avoids repeated classification and existing page text is reused rather
than duplicated. Unassessed records still participate in deterministic previews
when a model is unavailable. No new model/provider or foreground request is added.

The earlier corpus implementation remains Agent-only soft convergence. This ADR
does not implement or activate the selected 5,000 aggregate Active admission cap.
Migration, live deployment and automatic archival remain separately authorized.

## Validation

Public cache, Candidate promotion, Worker distillation/governance and corpus
preview boundaries cover stale content, rule versions, idempotency, bounded work,
unknown fallback, Human authority and effective-priority limits. Adapter contract
tests verify transport, not semantic usefulness.

A read-only real governance-adapter call on twenty prior boundary cases returned
all assessments. Effective priority was thirteen high, six normal and one low.
The task-report requirement moved from high to normal and a conditional historical
diagnosis from low to normal. Two asset records also moved from low to normal;
the change does not establish stronger low-value filtering overall. All five
concrete-rule controls remained high. Prompt and input context differ from the
preceding standalone experiment, so this is a diagnostic comparison, not a
controlled accuracy or incremental-cost benchmark. No canonical actions were
executed.
