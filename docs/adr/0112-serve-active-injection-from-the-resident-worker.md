---
status: accepted
---

# Serve active injection from the resident Worker

Active Codex `SessionStart` and `UserPromptSubmit` Hooks capture first, then ask
the persistent MemStore Worker for a bounded Memory Pack over a versioned local
Unix-domain socket under Machine-local Runtime Data. The socket is owner-only,
length-bounded, one request per connection, and reuses the Worker's resident
E5-base q8 adapter plus the accepted deterministic scope, relevance, packing,
budget, and Receipt implementation. The Hook returns the host's event-specific
`hookSpecificOutput.additionalContext` shape only after a completed response.

The foreground request reserves the captured event in the existing Shadow
evaluation ledger so the background evaluator cannot replay the same event,
restart its Context Epoch, or double-count selected revisions. A missing,
occupied, slow, malformed, or failed endpoint returns no context and never
blocks the Codex turn. We rejected loading E5 in each Hook, a lexical-only
production path, and a second retrieval daemon because they respectively break
the latency boundary, diverge from reviewed relevance behavior, or add an
unnecessary model owner and lifecycle surface. This decision implements the
active path but does not authorize Full Cutover or a live Hook-mode change.
