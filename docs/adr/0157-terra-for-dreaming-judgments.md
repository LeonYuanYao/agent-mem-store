---
status: accepted
---

# Terra for dreaming's judgments; Luna for extraction and verification

GPT-6.1 Terra (released 2026-10-26, available in Codex) costs ten times GPT-6 Luna
per input and output token ($1/$5 against $0.10/$0.50 per million; 25/125 against
2.5/12.5 Codex credits) and five times per cached input token. Dreaming used Luna
for every call. From 10-14 to 10-27 it spent 2.53 million tokens a day, about 98%
input: extraction 1.0 million, verification 1.34 million, merge 0.14 million,
defense and apply-time reconciliation 0.06 million.

Comparison on 2026-10-28, with gpt-6.1-sol as reference and blind judge (the same
model family as Terra, so it may favour Terra):

- Judgment: 384 prompt–Memory relevance pairs from the ADR-0152 sample. Agreement
  with Sol on useful against not useful: Terra κ 0.81, Luna κ 0.60. Luna let in 51
  pairs Sol judged irrelevant, Terra 15; both missed 11 useful pairs. With 80-character
  pair ids Luna dropped or miscopied ids in 13 of 23 calls and Terra in none.
  Production uses short aliases and had no schema failure in 456 chunks.
- Extraction: 10 recent chunks (18,000-150,000 characters) through the production
  extraction prompt. Terra won 6 of 10. All 74 Terra candidates were rated good;
  of 79 Luna candidates 71 were good, 5 weak and 3 wrong (two rules the user never
  stated, one fact attributed to the wrong system). Terra covered 43 of the 60 key
  facts and Luna 39. Token use and time were about equal, so the cost ratio is the
  price ratio.

Decision:

- `[dreaming] model` (default `gpt-6-luna`) runs extraction and verification, which
  carry about 93% of the tokens; Terra's extraction gain is not established on 10
  chunks and verification has not been compared.
- `[dreaming] judge_model` (default `gpt-6.1-terra`) runs merge, apply-time
  reconciliation and defense. They decide what joins, refines or replaces Memory,
  where the judgment gap matters most, and add about 5 Codex credits a day (about
  6 a day for all of dreaming on Luna).
- Reasoning efforts are unchanged: merge and reconciliation use `extract_effort`,
  defense uses `verify_effort`.

Rejected: Terra for every call (about 60 credits a day, 165 on the busiest day,
against a Codex limit dreaming already hit on 4 chunks in two weeks); Terra for
verification before a verification comparison on real claims with `msverify`.
