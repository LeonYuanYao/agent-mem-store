# ADR-0120: Precompute foreground search data and bound per-prompt scoring

## Status

Accepted.

## Context

Production `UserPromptSubmit` requests exposed a scaling problem in the automatic retrieval path. The implementation repeatedly normalized and scanned every eligible Memory for every query term and applicability condition. A Project with about 2,700 Memories and a long Prompt could spend 1.5 to 2.1 seconds in synchronous ranking, even though embedding and vector lookup were comparatively small.

The synchronous loop also prevented the foreground lane from observing its deadline until ranking finished. The client could fail open after one second while the Worker continued using CPU for the abandoned request.

## Decision

Each immutable Retrieval Snapshot now prepares an in-memory search projection when the snapshot is loaded. It contains normalized searchable and applicability text, token sets, term postings, and portable Memory-reference lookup. This projection is derived Runtime Data and is not serialized as Canonical Memory Data or duplicated when the snapshot is sent to the foreground worker thread.

`UserPromptSubmit` uses the projection to prepare candidates before applying the existing relevance score and safety rules:

- lexical recall considers at most 64 query terms and keeps up to 128 candidates;
- semantic recall keeps up to 64 candidates from the exact local vector scan;
- structured files, symbols, errors, and commands consider at most 16 signal terms and keep up to 64 candidates;
- direct Memory references and exact token matches remain independently eligible and are not dropped by the lexical or semantic candidate limits;
- final coverage and applicability scoring considers at most 64 terms, including unmatched terms needed to preserve the meaning of coverage thresholds.

Vector scoring reads the resident `Float32Array` directly instead of allocating one array per Memory. Vector scanning, postings traversal, and candidate scoring yield at bounded intervals so the foreground lane can observe a deadline or client disconnect before Receipt work begins.

This decision does not change Project, lifecycle, authority, validity, repetition, Relevance Band, item, token, or Context Epoch gates. The 300-millisecond warm-path SLO and one-second fail-open deadline remain unchanged. Candidate and term limits are reviewed implementation defaults; models and runtime metrics cannot change them automatically.

## Consequences

- Prompt cost no longer grows as a nested scan over every query term, Memory, and applicability condition.
- The resident snapshot uses additional memory for normalized text, token sets, and postings. The search projection is non-enumerable so worker-thread snapshot publication does not transfer a redundant copy.
- Exact and direct references retain a path into scoring even when bounded lexical or semantic recall would omit them.
- A future scale increase may require a different postings or vector backend, but it does not require changing Canonical Memory Data.

Production-scale read-only replay with a 53,113-character Prompt and 2,722 Project Memories completed in about 180 to 191 milliseconds with the configured warm E5 adapter. The result stays below the accepted SLO without changing the one-second safety boundary.
