---
status: accepted
---

# Use gpt-6.1-terra for explicit retrieval adjudication

ADR-0106 sends the bounded local page of an explicit `recall search` or `memstore_search` to
`gpt-5.6-terra` at low reasoning effort. Dreaming's judgments already default to `gpt-6.1-terra`
(ADR-0157), so MemStore depended on two Terra generations, and the judge's model was a literal in
its adapter.

Decision: the explicit retrieval judge uses `gpt-6.1-terra`. One constant, `terraModelIdentity` in
`src/luna/model.ts`, names it for the judge and for the default of `[dreaming] judge_model`.
Everything else in ADR-0106 is unchanged: low reasoning effort, the standard service tier, aliases
only, deterministic local order, and no Terra in the automatic SessionStart or UserPromptSubmit
path. No persisted record names the judge's model, so nothing needs migrating.

Evaluation, five real explicit searches on the live store, before and after the change: one needed
no adjudication; of the four judged pages, three kept the same Memories and one kept one more,
which is relevant to the query. Wall time per search was 9.0–10.7 s before and 8.7–12.3 s after,
within the variation of the machine's load.
