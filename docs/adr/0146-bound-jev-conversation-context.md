---
status: accepted
---

# Bound Jev conversation context

Short confirmations often refer to an Assistant proposal absent from the existing
User-only window. Increasing only that window cannot recover the missing referent.
Small historical and constructed experiments support role-labeled conversation
plus explicit task applicability instructions; they do not establish production
accuracy or eliminate timeout fallback errors.

Keep a bounded in-memory conversation cache in the Worker. UserPromptSubmit binds
a current turn to Project/Session; Stop sends its last Assistant reply through a
separate best-effort private-socket message with Session/turn identity. Ignore
unbound or late replies. Retain at most three prior turns for selection and 128
sessions, with a 16 Ki-character bound per message. Clear on session boundaries,
sensitive input and process restart. Do not scan transcripts, persist history,
create capture events or schedule distillation. Human-only capture policy remains
in force. Context updates have a 100 ms client limit and bypass retrieval work.

For Jev, select verbatim paragraphs using recency, query terms, entities and
constraint signals, prioritizing the latest request and referred-to Assistant
proposal. Preserve roles and chronological order; reuse unused message allowance.
Cap history at 1,024 local tokens and the serialized request at 4,096 local tokens
and 48 KiB. Current prompt and candidate content take precedence. Local tokenizer
counts are estimates, not provider accounting. Omit whole oversized paragraphs;
do not rewrite conditions, negation or numbers into keyword bags. This remains
lossy: omission and initial message clipping can lose relevant information.

The criterion first resolves the current action, target and constraints. Older
topics do not establish the current task, and Assistant text grants no factual
certainty or authority. Missing applicability must not be inferred from candidate
memory. Record only context status, selected message/token counts, truncation,
request token count and policy version in existing telemetry; no history bodies.

Keep local retrieval, Human eligibility, deadlines, retry/cooldown and timeout
fallback unchanged. No new service, summarization call, dependency, configuration
switch, database migration or durable queue is required. After restart, expect
missing context until normal turns warm the cache. Evaluate later real receipts
for quality and latency; mocked transport tests prove contracts, not relevance.
