---
status: accepted
---

# Let Jev judge the nearest weak candidates

The first recall audit (ADR-0167; 40 prompts of 10-27 to 11-03, gpt-6.1-terra
labels on the 12 nearest Memories that existed at the time) found 13 relevant pairs
in 11 prompts. One was injected. Eight (62%) never reached Jev: the local gate had
scored them `weak` (below 2 points), and weak candidates were dropped before Jev.
Three were rejected by Jev, one was cut by the item limit. The sample is small, but
the local gate, not Jev, lost most relevant Memory.

Decision:

- When a relevance filter is configured, the weak candidates nearest by embedding
  similarity fill Jev's remaining slots, up to the six-item request (one request, as
  before). They are compact-only, fit the pack budget, and are marked
  `jev_weak_candidate` in receipts.
- A weak candidate is kept only at a Jev score of at least 0.55 (the threshold for
  others is 0.45: a low-prior candidate needs more evidence at the same score), and
  at most two per prompt. Kept ones render with the probable header.
- Without a Jev judgment (disabled, unconfigured, timeout, sensitive input) weak
  candidates are removed again, so a Jev failure adds no noise (ADR-0152).
- Jev-rejected weak candidates record `jev_below_threshold` with their score, so the
  weekly audit and later calibration can tune the 0.55 bar.

Cost: Jev requests carry up to six items more often; the conversation keeps its
768-token reserve (ADR-0167).
