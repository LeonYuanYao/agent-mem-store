---
status: accepted
---

# Rewrite a lossy compact from the assessor's reasons

On 2026-10-29 three active Human-authored Memories had no injectable summary.
Since 10-19 retrieval had judged M:8586 (where Effect House problems are recorded)
and M:8652 (a renamed skill) relevant and dropped them for want of a compact 29
and 25 times. Their summaries had been judged lossy once and the item stopped
there: the generator never learned why. The generation rules also contradicted
the assessor: a summary card left lists to the body, so M:8586's list of the
systems the rule covers became "related problems", which the assessor rejected
as `omits_scope`.

Decision:

- A compact judged lossy goes back to generation with `rejectedDraft`: the first
  rejected draft and every reason given so far. It gets at most two rewrites; a
  further lossy judgment is final. `uncertain` stays final.
- Generation prompt version 5: a list that says which cases or systems a Memory
  applies to is its applicability and is named briefly; a rewrite keeps what the
  draft got right and restores what each reason names.
- Migration 0075 adds `rejected_compact` and `rejected_reason_code` and sends the
  compacts already rejected as lossy for the current revision of an active Memory
  back for one rewrite.

Result on 2026-10-29: M:8586 (39 tokens) and M:8762 (38) passed on the first
rewrite. M:8652's rewrite saw only its draft and latest reason and dropped the
skill names it had kept; rewritten from the first draft with both reasons it
passed (95 tokens), which is why rewrites carry every reason. Injectable: 249 of
249 dreaming and 34 of 34 Human-authored Memories.

Rejected: relaxing the assessor (it was right that the drafts lost the scope);
writing the summaries by hand (memory text is written by the Codex pipeline).
