---
status: accepted
---

# Bound automatic injection to 500 milliseconds

The first-version configurable warm-path latency SLO is p95 at or below 300 milliseconds for SessionStart and UserPromptSubmit. The complete automatic Hook or adapter has a 500-millisecond deadline measured from host-event receipt through project resolution, query embedding where applicable, retrieval, filtering, packing, Injection Receipt persistence, serialization, and response.

Foreground retrieval stops starting new candidate pages, relationship expansion, and other optional work at 450 milliseconds. The remaining time is reserved for completing already-started deterministic safety checks, final packing, Receipt recording, and serialization.

A SessionStart cache is usable only when bound to the resolved Project identity, completed index revision, active configuration version, and current Memory content identities. UserPromptSubmit may return a lexical-only result when exact and lexical retrieval, all hard filters, final packing, and Receipt recording complete before the deadline; the Receipt records the missing semantic stage. An incomplete or partially safety-checked pack never returns.

If no valid final pack can return by the deadline, the adapter returns an empty pack and the Agent turn continues. Individual timeout detail remains in Receipts and aggregate health state instead of being repeated in prompts. Persistent abnormality uses the accepted health-notification path.

Explicit MCP and Skill retrieval is outside this automatic deadline. Shadow Mode records p50, p95, p99, deadline failures, lexical-only fallback, and recall lost to deadline pressure, but active latency values require explicit human Review to change.
