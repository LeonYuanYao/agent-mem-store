# ADR-0133: Page Session admission and checkpoint model output

## Status

Accepted.

## Context

Session consolidation combines many distilled Batches. Local protection restores priority Candidates omitted by the model. Applying the Batch's 64-admitted-clause guard to this combined result can reject valid long Sessions repeatedly. Repeating the model call cannot reliably reduce the result while preserving those clauses.

## Decision

- Retain existing model input partitioning and the 128-clause model response schema.
- Retain the 64-admitted-clause guard for individual distillation Batches.
- Apply unchanged admission classification to Session consolidation in pages of at most 64. Do not truncate or impose a Session-wide ceiling.
- Save the schema-validated model result and structured input hash in the existing consolidation result field before audit and ingestion. Verify the input hash and schema before reusing it on an incomplete-operation retry.
- Replay ingestion through existing Candidate fingerprints. Complete the consolidation and advance its cursor only after all pages persist.
- Keep authority, project routing, evidence linkage, promotion policy and foreground retrieval unchanged.

## Consequences and verification

No new scheduler or database migration is required. A retry after a saved model result avoids a repeated model invocation. Failure before that checkpoint is persisted can still require a new invocation. Old blocked operations without a checkpoint must rerun once through the supported retry operation.

The end-to-end regression consolidates 66 protected clauses, then repeats the scenario with an injected write failure after 64 Candidate inserts. Recovery must yield all 66 Candidates without duplicates, leave the cursor unchanged until success, and call the model only once.
