---
status: accepted
---

# Calibrate the local prompt gate against the prompt's median similarity

The local gate admitted a Memory for a prompt when its similarity was at least
0.82 (0.58 for a weaker point) and some lexical coverage corroborated it. The
values came from a ten-document benchmark. With multilingual-e5-base, real prompts
and the live Memories, similarities lie between 0.80 and 0.87 (median 0.827), so
66% of all pairs passed 0.82; one shared word covered enough of a short prompt to
corroborate. When Jev did not answer, the local selection was injected as it was:
of 38 such injections from 2026-10-20 to 10-22, about six were relevant.

Calibration: 700 real prompts since 2026-10-12 (Claude Code task notifications
excluded, botmux prompts reduced to the user's message), scored by the production
code; 320 prompts sampled across time with their 5 Memories nearest the decision,
1,537 pairs labeled relevant / partial / irrelevant by Codex (gpt-6.1-sol, isolated
from the user's configuration and hooks); fitted on the earlier 60% of prompts,
checked on the later 40%. Labels are one model's judgment, not human review.

Decision:

- Semantic evidence is the lift over the prompt's median similarity to the
  Memories in scope: strong at 0.02, weak at 0.01, and a top-1 Memory stands on its
  own at 0.03 (no margin over rank 2; the margin cost a quarter of the recall).
  Scopes with fewer than 8 Memories use the typical median of real prompts, 0.83.
  Similarity separates relevant pairs about as well as lift (AUC 0.74 each) but no
  single absolute threshold fits every prompt; lift does.
- Lexical corroboration needs two matched terms besides 30% coverage, and so do
  the lexical rank points.
- When Jev is enabled but gives no judgment (timeout, network, cooldown, sensitive
  input), only near-certain items are injected: high band with a lift of at least
  0.05 or applicability terms, or a Memory named by identity. With Jev disabled or
  unconfigured the local selection stands. The pack is otherwise empty with
  `unfiltered_low_confidence`.

Results on the later 40% (128 prompts), current rule vs calibrated:

| | Precision | Relevant recall | Prompts with noise |
| --- | ---: | ---: | ---: |
| Candidates for Jev | 22.8% -> 29.1% | 37.8% -> 45.1% | 52 -> 43 |
| Injected without Jev | 22.8% -> 78.6% | 37.8% -> 13.4% | 52 -> 1 |

Without Jev, 13 of 128 prompts receive memory instead of 77; with Jev the candidates
it sees are both more often relevant and more complete.

The approved embedding profile keeps `semanticOnlyMinimumScore` and its margin for
the installation manifest; the prompt gate no longer reads them. `inspectUserPromptScoring`
returns the raw features without receipts for later recalibration.

Rejected: raising the absolute threshold (relevant and noisy pairs overlap at every
value: a relevant pair at 0.841, a noisy one at 0.856); a z-score over the prompt's
distribution (AUC 0.70, below lift); injecting nothing without Jev (loses the 13
near-certain cases, three in four of them relevant); a larger embedding model
(re-indexing and latency for an unmeasured gain; reconsider with this data set).
