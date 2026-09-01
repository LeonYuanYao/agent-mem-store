---
status: accepted
extends: ADR-0040, ADR-0120, and ADR-0123
---

# Use bounded recent user prompts for contextual recall

Automatic `UserPromptSubmit` retrieval may use the current prompt plus at most the three most
recent meaningful user prompts from the same Project and Session. This resolves contextual
follow-ups such as “what about now?” without lowering the per-item Relevance Band thresholds or
adding a foreground model call.

The history window excludes empty prompts and short confirmations such as `OK`, `continue`,
`同意`, and `继续`. Its total representation is at most 256 `o200k_base` tokens. The newest,
second-newest, and third-newest prompts receive token allowances in a 4:2:1 ratio; an oversized
prompt preserves its beginning and ending around an ellipsis. The current prompt remains
unbounded by this history allowance and appears first in the history-enhanced query text.

Recent prompts affect semantic candidate recall only. They do not become direct Memory identity
references, exact metadata anchors, structured Session signals, or independent relevance points.
For a current prompt of at most 160 Unicode code points that contains an explicit contextual
reference such as `这个`, `现在`, `刚才`, `this`, or `previous`, history-enhanced semantics may
corroborate an item only when the semantic score is at least 0.82 and the current prompt itself
matches at least two indexed terms in that item. This receives only the existing two-point
very-strong-semantic score, so it can produce a `probable` item but cannot independently produce a
`high` item. A non-contextual prompt, history-only lexical match, or weaker semantic score receives
no such admission.

For a context-dependent prompt, one batched local adapter call produces both the
history-enhanced semantic vector and a current-prompt-only ranking vector. The enhanced vector
owns semantic candidate recall and relevance eligibility; the current-only vector orders items
within the same Relevance Band and score so an older topic cannot dominate the final Top-N. A
non-contextual prompt uses only the current prompt and produces one vector.

Deterministic safety, Project scope, applicability, Relevance Band, repetition, item, and token
gates otherwise remain unchanged. If the local embedding path is unavailable, foreground
retrieval remains conservatively `lexical_only` rather than promoting history-only matches.

The resident foreground Worker owns a bounded in-memory ring keyed by Project and Session. A
`SessionStart` clears that key, different Sessions never share history, identical adjacent prompts
are deduplicated, and at most 128 Session rings are retained by recent use. Worker restart safely
degrades to current-prompt-only retrieval until new prompts rebuild the ring; the foreground path
does not rescan a potentially large transcript.

Recent prompt bodies are retrieval input only. They are not rendered in Memory Injection, copied
into Canonical Memory, or duplicated into the current Retrieval Receipt query. The design performs
one local adapter call with at most two query texts, adds no Luna or Terra call, and preserves the
300-millisecond warm-path SLO and one-second fail-open boundary.
