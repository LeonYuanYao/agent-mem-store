---
status: accepted
---

# Let Jev judge a fused candidate pool

Jev judged at most six candidates per prompt: the local selection, then weak
candidates by embedding similarity (ADR-0168). The 11-03 and 11-09 recall audits
still lost most relevant Memory before Jev. Re-ranking their labeled pairs showed
that the local order is good for its first six places but stops improving after
them, and that embedding similarity, the order used to fill Jev's remaining slots,
was the weakest single ranking. BM25, and reciprocal rank fusion (RRF) of semantic
and BM25 ranks, put far more relevant Memory within reach. Other knowledge bases
use the same pattern: equal-weight RRF of vector and BM25 ranks feeding a reranker
over 30 to 50 candidates.

Jev's latency barely depends on the number of candidates in a request: 212 ms for
6, 221 ms for 12 and 230 ms for 18 (median of five requests through the proxy). A
second request in parallel costs a proxied TLS handshake, about 300 ms more.

Decision:

- Prompt scoring also computes an Okapi BM25 rank (k1 1.2, b 0.75, the 256 rarest
  prompt terms present in scope, IDF over the Memories in scope; term frequencies are
  kept in the search index) and a fused score: `1/(60 + semantic rank) + 1/(60 + BM25
  rank)`, plus `1/61` for exact metadata, `0.5/61` for applicability and 1 for a
  Memory named by identity. Local scores, bands and the local selection are unchanged.
- With a relevance filter, the local selection is followed by the candidates next by
  fused score, compact-only, up to 18 in total, in one Jev request. They carry
  `jev_pool_candidate` in receipts, including when Jev rejects them.
- A Jev request takes up to 24 items. Its budget of 4,096 tokens and 48 KiB grows by
  512 tokens and 6 KiB per item beyond six. Text sizes are counted once per part and
  the request exactly once, so preparation stays short.
- Kept items are ordered by Jev score, then fill the six-item limit and the token
  budget. A weak candidate needs 0.6 (was 0.55, ADR-0168) and at most two are kept;
  the others need the configured threshold (0.45).
- Without a Jev judgment pool candidates are dropped and the ADR-0152 fallback applies.

Evaluation on 2026-11-15. Prompts: the 80 prompts of the two audits (development) and
60 prompts sampled from 11-09 to 11-15 (test). Each pipeline ran on a copy of the
runtime database against the Memories that existed when the prompt was asked, with
real Jev requests and no conversation cache. Codex gpt-6.1-terra (isolated) labeled
the union of the local top 12, BM25 top 10, embedding top 10, fused top 18 and every
candidate either pipeline sent to Jev: 3,421 pairs, 117 relevant.

| 140 prompts | Relevant recall | Precision | Prompts served | Injected | Prompts with noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before | 18.8% | 52.4% | 17/64 | 42 | 5 |
| After | 29.9% | 53.8% | 20/64 | 65 | 7 |

On the test prompts recall rose from 23.1% to 32.7% (precision 54.5% to 53.1%).
Counting only relevant Memory found by the local, BM25 or embedding rankings, the
previous pool or the audits, so the fused ranking does not define its own target,
recall rose from 23.2% to 29.5%. Prompts over 300 characters gained most (21.3% to
44.7%, precision 58.8% to 70.0%); shorter prompts gained little (17.1% to 20.0%) and
lost precision (48.0% to 40.0%, three more irrelevant items). With 0.55 for weak
candidates recall was 33.3% at 50.0% precision and 11 prompts with noise.

Cost: Jev latency p50 229 to 259 ms, p90 282 to 323 ms; local retrieval plus Jev p50
291 to 324 ms, p90 368 to 405 ms; no timeouts. Request size p50 2,247 to 6,421 tokens.
The same item's Jev score moved by a median of 0.01 between requests of different
composition (p90 0.03).

The weekly audit labels the nearest Memories by both the local score and the fused
score, so a ranking is not graded only on its own pool, and reports weak candidates
outside the pool as "not among Jev's candidates". Labels are one model's judgment;
the sample is 117 relevant pairs.
