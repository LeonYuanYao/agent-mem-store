---
status: accepted
---

# Keep only dream items of lasting value

Dreaming wrote every repository-confirmed claim as Memory. Confirmed by code often means
readable from code: one code-reading Session became a dozen one-line facts about a module's
internals. Of the 502 active dreaming Memories on 2026-11-16, 256 came from 15 Sessions (one
Session wrote 45), and an isolated Codex Terra audit classed 182 as implementation detail. On
the 140 prompts of the ADR-0175 evaluation (4,630 labeled pairs), those 182 entered Jev's
candidate pool 1,081 times and were relevant 9 times; 9 of them were ever relevant, against
21 of 103 rules and 20 of 208 pitfalls or how-tos. They take Jev's candidate slots, fill the
daily digest and go stale when the code changes (two did within days of being written).

Decision:

- After merging, the judge model (Terra, the extraction effort) appraises each item's lasting
  value: `keep_rule`, `keep_usage` (how to use or operate a system, including short orientation
  on what a system is and where things live), `keep_pitfall`, or `code_detail` (how a module
  works inside), `redundant` (another kept item of the same Session says it), `narrow` (rarely
  recurring, or too little information) and `one_off`. The bar is deliberately high.
- The model sees the items of one Session together, at most 30 items per call (a Session up to
  50, largest Sessions first), and is told that a Session usually yields a few items worth
  keeping. Items stated in the user's own words are not appraised: verification already tells a
  lasting rule from a one-task request. Runs the user asked for (`remember extract`) are not
  appraised.
- Items not judged `keep_*` skip pre-search, verification and defense. `one_off` is dropped;
  the others go to the pool, which stays in the report and is never written as Memory. An item
  the model leaves out is kept.
- `[dreaming] appraise = false` turns the step off. Migration 0078 adds
  `dream_items.appraisal_json`.

Evaluation on 2026-11-16, the 502 Memories as items, labels and judgments by isolated Codex
Terra. "Useful" means relevant to one of the 140 prompts, or let through by Jev live at least
twice (106 Memories); "anchors" are the 50 relevant to a prompt.

| Appraisal | Kept | Anchors kept | Useful among kept | Useful among removed |
| --- | ---: | ---: | ---: | ---: |
| One item at a time, strict | 29% | 48% | | |
| One item at a time, use vs. internals | 71% | 80% | | |
| By Session (adopted prompt) | 50% | 78% | 30% | 12% |
| Adopted, production path, user-stated not appraised | 58% | 84% (10 of 11 relevant to ≥2 prompts) | 29% | 11% |

Judged one at a time, the verdict moved with the wording (56% agreement between the first two
prompts) and barely separated useful Memory from the rest. Seen by Session it separated them
and was stable: 91% agreement between medium and high effort, 90% between prompt variants.
`code_detail` was useful 7% of the time, `redundant` 8%; `narrow` 17%, below the kept average
of 29% but not far, and it costs five anchors: keeping `narrow` would keep 70% of items and 47
of 50 anchors. The high bar removes it anyway; it stays in the report.

Removing the low-value Memories from the evaluation corpus did not change automatic injection
beyond run-to-run noise (relevant injected 35 before, 31 to 32 after; the differences were Jev
scores moving across thresholds, about ±3 between identical runs). The gain is a smaller,
fresher library, not recall.

Cost: appraisal used about 800 tokens per item (Terra); verification has cost about 11,500 per
item (44% of dreaming's tokens since 11-01), and items it removes are no longer verified.

Existing Memory: the 135 dreaming Memories the production-path appraisal judged low value and
that were never injected, recalled explicitly or relevant in the evaluation were archived
(recoverable with `memstore restore`); 77 low-value ones in use stay.

Labels and judgments are one model family's; the usefulness signal covers two weeks of prompts.
