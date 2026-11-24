---
status: accepted
---

# Let the user decide on the rules dreaming finds

In the user's sessions of 2026-10-25 to 11-23, judged turn by turn by isolated Codex Terra, a
Human-authored Memory helped on 25% of its injections and a dreaming Memory on 11%; of the
injections that decided the outcome, all but two or three were Human-authored. What makes the
user's Memory useful is not where it comes from: dreaming already writes rules from the user's
own words, and those do worse than the rest of dreaming. Of the 520 dreaming Memories in use,
107 rest on the user's words or are rules the appraisal read from the user's corrections; in four
weeks they were injected 169 times and helped 16 times (9.5%), against 17.2% for the usage and
pitfalls dreaming writes. The most injected of them (M:8882, M:9081, M:8967: 40 injections, one
help) restate the user-wide instruction file or a scheduled task's prompt. The difference is that
the user chose what to keep. Neither a content review nor where a Session learned an item
tells useful dreaming Memory apart (11-24 replay, AgentScratchpad
`docs/memstore/history/2026-11-24-dreaming-origin-replay.md`).

Decision:

- Admission is unchanged. An item admitted for injection that rests on the user's own words
  (`explicit_user`, unless the verifier found them a pasted task text or not the user's), or that
  the appraisal judged `keep_rule`, goes to a new tier `suggest` instead of `inject`. Dreaming
  never writes it. A run the user asked for (`remember extract`) is not asked again.
- `keep_rule` now means the user's own preferences, requirements and decisions: how agents
  should work, reply or what not to do for this user. Constraints a project or system must follow
  move to `keep_usage` and are written as before. An item the appraisal omits counts as
  `keep_usage`, so an omission never becomes a suggestion.
- `memstore dream digest` lists the suggestions of runs completed in its window, once, with
  their handle (the item id's first eight hex digits). `memstore rules [all]` lists them;
  `memstore rules accept <id> [--text TEXT]` writes the text, or the user's rewrite, through
  `remember assert` as Human-authored Memory in the item's scope (a Project scope files it
  under a live root of the run's Project) and records `accepted` and the Memory;
  `memstore rules dismiss <id>` records `dismissed`. A suggestion the user never answers stays
  open and is not written. An accepted Global rule then reaches the instruction-file judgment
  of ADR-0181 like any other Global Memory.
- Migration 0079 rebuilds `dream_items` so its tier may be `suggest`; a suggestion's outcome is
  its `apply_state` (open while NULL). Existing Memory is not changed.

Evaluation of the appraisal change, on the 424 dreaming Memories in use not stated by the user,
as items grouped by source Session and judged through the production `appraise` call (Terra,
medium). "Helped" is the turn-by-turn judgment above (32 of the 424).

| Prompt | Kept | Helped kept | `keep_rule` |
| --- | ---: | ---: | ---: |
| Before | 251 | 23 | 41 |
| Adopted | 240 | 22 | 11 |

The difference in what is kept is within run-to-run variation (ADR-0177 measured about 90%
agreement between runs). Of the 41 earlier `keep_rule` items, 23 became `keep_usage`: module
locks, health-check requirements, layout conventions. The 11 left are the user's: what a weekly
summary keeps, which NAS to buy, when personal-copilot should suggest a new session.

At the rates of 11-17 to 11-23 (about 25 admitted items from the user's words and 3 `keep_rule`
items a week), the digest asks about four rules a day.

Rejected: no longer keeping orientation (what a system is, its parts, where things live), with a
new value `reference` that was not kept. It removed 19 more items than it added back (7.6% of
those kept, against a 15% bar), and the 35 it removed had helped as often as those still kept
(8.6% each); the 12 it called `reference` had helped twice. As in ADR-0179, a higher bar, not a
better judge.

Labels and judgments are one model family's; the usefulness signal covers four weeks of
injections. Whether accepted rules help as often as the user's own Memory is to be checked once
there are some.
