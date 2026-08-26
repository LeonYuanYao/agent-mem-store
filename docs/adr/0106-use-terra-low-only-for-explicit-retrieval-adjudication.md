---
status: accepted
---

# Use Terra low only for explicit retrieval adjudication

Explicit `recall search` and `memstore_search` may send the bounded local result
page to `gpt-5.6-terra` at low reasoning effort. Terra returns only retained
short aliases. MemStore validates those aliases, restores stable Memory
identities, and preserves the deterministic local order and pagination boundary.

The adjudication rule is current-query necessity: retain a Memory only when
removing it would change the current answer or next safe action. Topical
similarity, Project membership, and possible future usefulness are insufficient.
An unavailable or invalid judge fails the explicit request visibly rather than
silently claiming a judged result.

Automatic SessionStart and UserPromptSubmit injection never invokes Terra. It
remains deterministic, local, and governed by the one-second deadline in ADR-0114.
Every Terra process explicitly selects `service_tier="default"`,
`model_reasoning_effort="low"`, an isolated read-only working directory, and
disabled tools, skills, plugins, and memories.
