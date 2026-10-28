---
status: accepted
---

# Two layers: a summary for matching and injection, the full text on request

Injection shows a Memory's compact representation, at most 96 tokens (about 128
Chinese characters). On 2026-10-28:

- 11 of 31 Human-authored Memories had no usable compact. Their bodies run to
  1,179 characters, and the Luna background step that writes compacts stopped when
  dreaming replaced Luna: the worker only built it with `MEMSTORE_LUNA_CODEX_HOME`.
  Since 10-19 these Memories were judged relevant and dropped for want of a compact
  about 400 times (M:8521 160, M:8649 85, M:8517 67, ...).
- Dreaming wrote one sentence per Memory as compact, standard and body alike. Codex
  (gpt-6.1-sol), reading each of the 213 alone with the verifier's evidence, found
  77% clear, 13% ambiguous (mostly not naming the system: "预览每帧最多处理一个
  输入事件"), 10% incomplete; 14% needed detail one sentence cannot hold, 33% of
  workflow Memories against 10% of code facts. Sentences under 60 characters were
  unclear 39% of the time.
- The pack told agents to "read M:<id>" without the command, and the
  `memstore-recall` skill that documents `memstore recall show` was installed for
  neither Claude Code nor Codex.
- The embedding text began with the body, so a long body pushed the summary out of
  the model's 512-token window.

Decision:

- Every Memory has a summary (compact, at most 96 tokens, naming the system and
  its applicability) for matching and injection, and a full text (body) an agent
  reads on demand.
- With dreaming enabled the worker runs the compact quality pipeline with
  dreaming's Codex home (model gpt-6-luna), without per-turn Luna work; background
  duplicate review stays off, since dreaming reconciles at apply. Compact
  generation names the system and summarizes long procedures; fidelity validation
  still requires the core claim, applicability and every meaning-changing condition,
  exclusion and negation, but leaves steps, commands, paths and values to the body
  as long as the summary does not misstate them.
- An Agent never revises Human-authored Memory, so the validated summary of one too
  long to inject is stored in `memory_summaries`, keyed by the revision it
  summarizes, and used as its compact in the retrieval index only. The Memory file
  is unchanged; a new revision needs a new summary. Storing a summary marks the
  retrieval catalog dirty; compact backfill covers Human-authored Memory without one.
- Eligibility counts compact tokens as the index does (o200k): a write-time byte
  estimate had passed compacts of 103-110 tokens that the index then rejected.
- Reused vectors are keyed by the embedded text as well as the revision, so a new
  summary or text layout re-embeds an unchanged revision.
- Dreaming extraction names the system in the statement and adds `detail` (steps,
  commands, values, criteria; up to 400 characters, from the session only) when one
  sentence cannot hold it. The item keeps the longest member detail; the verifier
  marks detail contradicted by evidence, which apply drops. Apply writes the
  statement as compact and statement plus detail as body and standard; a revision
  without detail keeps the Memory's detail.
- An injected item whose standard text is at least 16 tokens longer than its compact
  is marked `R:C+`; the legend and the probable header name
  `memstore recall show M:<id> --detail full`. The hook display's items mode says
  「有详情」. `memstore-recall` documents C+ and is linked into `~/.claude/skills`
  and `~/.codex/skills`.
- The searchable and embedded text leads with the summary and applicability; body
  and standard follow, each repeated text once.

Rejected: raising the injection limit (one long Memory would take the prompt
budget of six); dropping long Human-authored Memories from automatic recall (they
are the most detailed knowledge); generating detail at apply time from evidence
(the session text is gone by then; evidence lines are references, not steps).

Outcome on 2026-10-28: 8 of the 10 active long Human-authored Memories got a
validated summary (42-70 tokens; two were judged lossy without the details they
exist for and stay uninjectable); injectable Human-authored Memories rose from 20
of 31 to 30 of 32, 9 of them marked C+. On the ADR-0152 labeled prompts, with the
corpus grown from 146 to 253 Memories, Jev candidates went from 27.4% to 29.6%
precision and 46.2% to 41.8% relevant recall, prompts with noise from 104 to 84.
