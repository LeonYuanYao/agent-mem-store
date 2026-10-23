---
status: accepted
---

# Merge refinements instead of replacing the refined Memory

Apply mode (ADR-0148) revised a dreaming Memory by replacing its statement with
the refining item's text. Whatever only the earlier statement said was lost. Of
seven Memories revised within the batch that wrote them (2026-10-16 to 10-23),
four lost facts: a health check's failure counting and rebuild conditions, PTC's
`interact()` behaviour (a different fact the model had called a refinement), a
troubleshooting step, and a parameter detail.

Decision:

- Reconciliation returns `merged_statement` for `refines`: the target's still-true
  facts, conditions, values and exceptions together with what the new item adds or
  corrects, in the target's language and with nothing beyond the two. The prompt
  states that different facts on one topic (two modes, a step and a cause, a rule
  and another of its conditions) are `new`.
- Apply writes the merged statement. A `refines` without one is written as its own
  Memory instead of replacing the target; a duplicate costs less than a lost fact.
  `conflicts` still replaces the target with the verified new statement.
- A second revision of the same Memory in one batch is written as its own Memory:
  each merge was made against the target as it was before the batch.

Replayed through the production reconciliation (Codex), the seven historical cases
gave one `new` (the PTC case) and six refinements whose merged statements kept the
earlier details. The four damaged Memories were repaired by re-applying the
overwritten items with this code: one merged revision (M:8529) and three Memories
of their own (M:8670, M:8671, M:8672).

Rejected: concatenating the two texts (repeats shared parts and keeps contradicted
ones); never revising (stale statements would stay next to their corrections).
