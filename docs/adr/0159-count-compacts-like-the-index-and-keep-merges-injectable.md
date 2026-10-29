---
status: accepted
---

# Count compacts like the index; keep merged dreaming statements injectable

On 2026-10-29 two of 249 dreaming Memories could not be injected:

- M:8786 was 94 o200k tokens, within the limit, but was written unvalidated: the
  write-time check (`assessExactCompact`) estimated tokens as UTF-8 bytes / 4 (99),
  while the retrieval index counts o200k. ADR-0155 fixed the same mismatch for
  compact quality eligibility only.
- M:8699 was refined at apply into a 97-token statement. Reconciliation keeps every
  fact of the target and adds the new knowledge, with no length bound, so a
  statement that is merged a few times leaves injection; the compact the quality
  pipeline generated for it was rejected as lossy.

Decision:

- `assessExactCompact` counts o200k tokens, as the index does.
- The reconcile prompt asks for a merged statement of one sentence, at most 120
  Chinese characters (about 70 English words), and for `new` when the merge does
  not fit, instead of dropping facts of the target.
- Apply writes the new knowledge as its own Memory, leaving the target unchanged,
  when a merged statement still does not fit.
- Repairs: `memstore quality repair-representations` validated M:8786 and M:3491
  (a Human-authored Memory the estimate had also rejected); M:8699 now injects its
  pre-merge statement, which the merge only extended, with the merged statement
  and detail as body (marked `R:C+`). Dreaming Memories injectable: 249 of 249.

Rejected: keeping the target's old statement as compact for every over-long merge
(a refinement that corrects the target would keep injecting the corrected claim).
