---
status: proposed
---

# Rank a short prompt's pool by the reply it answers

Most prompts are short (median 36 characters; 69% of the calibration prompts are 80 or
fewer) and name little: "做吧", "现在更新一下数据", "工作总结也照这个规则改了". What they
refer to is in the Assistant reply just before them. Jev already reads that reply
(ADR-0167), but it only judges the pool that local ranking hands it (ADR-0175), and local
ranking reads the prompt and, for deictic prompts, earlier User prompts. A Memory that
only the reply points at rarely reaches Jev.

Decision:

- When a prompt of at most 160 characters follows an Assistant reply in the conversation
  cache, an excerpt of that reply (at most 320 tokens, selected as for Jev's context) is
  embedded as a separate query. The ten Memories most similar to it get a third
  reciprocal-rank vote, `1 / (60 + rank)`, in the fusion that fills the Jev pool.
- Only the pool changes. Local scores, bands, the local selection and the fallback without
  Jev are unchanged, so the reply never injects anything on its own.
- The excerpt is embedded after the prompt's own embedding, in the time left before the
  300 ms semantic deadline; a late embedding drops this list and nothing else.

Evaluation (2026-11-19, `tmp/recall-eval`, the 140 calibration prompts): each prompt's last
three turns were rebuilt from captured events and passed to both pipelines, as the
conversation cache does in production, with real Jev calls. Codex Terra relabeled the
pairs of the 115 prompts of at most 160 characters (3,127 pairs, 82 relevant) with the
previous reply in view, since "做吧" cannot be judged without it.

| prompts ≤160 characters | baseline (two runs) | this decision |
| --- | ---: | ---: |
| relevant Memories in the Jev pool | 70.7% | 80.5% |
| relevant Memories injected | 18 / 18 of 82 | 23 of 82 |
| precision of injected items | 62.1% / 60.0% | 67.6% |
| irrelevant items injected | 2 / 3 | 4 |
| prompts served | 15 / 15 of 52 | 18 of 52 |

Against the first baseline run the change injected 5 more relevant Memories and lost none,
and added 2 irrelevant ones. Prompts over 160 characters are unaffected (34 injected in
both runs, 22 against 21 relevant). Jev latency and request size are unchanged; embedding
the excerpt costs about 140 ms (p50, measured alone), and foreground time for short
prompts after a reply rose by 48 ms at p50 and 171 ms at p90 with two pipelines sharing the
machine.

Rejected variants, by relevant Memories in the Jev pool for prompts ≤160 characters
(offline, same labels): every Memory ranked by the reply instead of the top ten 77.8%
(the long tail of reply ranks reorders the whole pool), top five 77.8%, a double weight
80.2%, prompts ≤80 characters only 79.0%. A 160-token excerpt kept the pool at 80.5% but
injected 21 relevant Memories against 23, for about 65 ms less embedding time.

Also rejected: dropping Memories that Jev keeps rejecting from automatic ranking. In the
30 days of receipts, 44 dreaming Memories were judged by Jev at least 20 times and never
selected, taking 1,838 pool slots; 27 more were four weeks old and never used. Excluding
them moved relevant Memories in the pool from 87 to 86 (85 with both sets): the freed slots
go to the next fused candidates, so neither recall nor Jev's request size improves.
