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

Rejected: a local cross-encoder (bge-reranker-base, int8, as in other knowledge bases)
in place of or beside Jev. On the 2,488 labeled pairs Jev scored in the final run it
separated relevant from irrelevant Memory with AUC 0.74-0.75 (Jev 0.95); averaging the
two ranks gave 0.78-0.81. Keeping as many items as Jev kept (72) would have injected 9
to 13 relevant Memories instead of 36. It sees no conversation, judges topical overlap
rather than applicability, and took 340 ms median and 0.5-1.1 s at p90 on CPU for 18
pairs. Jev fell back on about 2% of prompts since 11-02, so a fallback role adds little.

Rejected: a second embedding model as a third fused rank (2026-11-16). bge-m3, bge-base-zh-v1.5
and Qwen3-Embedding-0.6B (int8) were each added to the fusion and tried in place of e5. With the
new pool members labeled too (4,630 pairs, 140 relevant), only bge-m3 helped the pool: relevant
Memory among the 18 candidates rose from 69.3% to 77.9% (77.1% in the real run), mostly for
prompts of up to 300 characters; the other two lowered it on long prompts. Run end to end with Jev,
injection did not improve: 33 to 32 relevant Memories injected, precision 50.8% to 49.2%. Jev
scored most added relevant candidates 0.1 to 0.56, nearly all for short follow-ups such as "做吧"
whose task it cannot see, below the 0.6 a weak candidate needs. bge-m3 would add 570 MB on disk,
about 800 MB of worker memory and 30 ms median, 140 ms p90 per prompt on CPU.

Rejected: Codex Luna (gpt-6-luna) as the judge in place of Jev (2026-11-19). Given Jev's own
question and criteria, the prompt, recent user prompts and Memory body, one Codex call per prompt
scored the same 2,488 pooled pairs. Luna separated relevant from irrelevant Memory with AUC 0.889
at medium effort and 0.701 at low (Jev 0.951; Jev minus Luna medium 0.019-0.114, 95% bootstrap
interval). At Jev's live rule and the same injected count (65), Luna medium injected 32 relevant
Memories against Jev's 35 and 3 irrelevant against 8: more conservative, not better at recall.
Low effort gave near-binary scores. Through Codex a call took 13-15 s median with about 17k input
tokens, far beyond the 1.3 s foreground budget. The labels come from Terra, a model of Luna's own
family, so any bias favored Luna.
