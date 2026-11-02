---
status: accepted
---

# Raise the Jev threshold to 0.45

ADR-0154 set Jev's threshold to 0.4 on 21 prompts with relevant Memory. The
re-evaluation on 2026-11-02 (`scripts/evaluate-injection.ts --since
2026-10-26T09:04:27Z`, Codex gpt-6.1-sol labels) had 418 Jev-scored pairs from 267
prompts: 73 relevant, 70 partial, 275 irrelevant; AUC 0.920.

| Threshold | Kept | Precision | Relevant recall | Prompts served | Prompts with noise |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.40 | 61 | 68.9% | 57.5% | 36/59 | 10 |
| 0.45 | 56 | 75.0% | 57.5% | 36/59 | 6 |
| 0.46 | 54 | 77.8% | 57.5% | 36/59 | 6 |
| 0.48 | 49 | 79.6% | 53.4% | 34/59 | 4 |

The five pairs scored 0.40-0.45 held no relevant Memory (one partial, four
irrelevant). Recall holds up to 0.46 and falls from 0.48.

Decision:

- The machine-local threshold is 0.45: the same recall as 0.4 with four fewer
  prompts carrying noise, below the 0.48 drop with a margin. The code default
  (0.5) is unchanged.
- The evaluation's local-miss set compares a prompt only with Memories that existed
  when it was asked (frontmatter `created_at`). It had used today's corpus, so
  Memories written later, mostly by that night's dreaming, counted as misses: 22.5%
  reported, 5.0% once they are excluded (baseline 5.8%).

The sample of pairs between 0.40 and 0.45 is small (5); the next re-evaluation
should check the band again.
