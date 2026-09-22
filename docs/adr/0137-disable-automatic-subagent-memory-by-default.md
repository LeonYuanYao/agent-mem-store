---
status: accepted
---

# Disable automatic subagent memory by default

## Decision

Machine-local `[adapters].subagents_enabled` defaults false and is read on each
Hook event. The shared CLI entry skips both capture and retrieval for subagents
before Project discovery, sensitivity processing, Inbox writes or Worker IPC.
Explicit true restores existing behavior. No other Hook source is disabled.

Session identity comes from an exact ID lookup of the host's source metadata in
the newest `state_N.sqlite` under `CODEX_HOME` (default `~/.codex`). The database
is opened read-only with zero lock wait. A missing row, schema incompatibility
or unavailable database falls back to at most 1 MiB of the first transcript
record, which must be `session_meta` with a matching ID. Unknown identity skips
automatic memory with a body-free `session_kind_unknown` notice; it never
silently becomes a primary session. No retry loop or persisted classification
cache is introduced. The next event reads current configuration and metadata.

Both host storage formats are implementation details. Keep this dependency in
the Codex adapter and verify it when upgrading Codex. Subagent lifecycle events
that identify a child through a parent session ID are not registered MemStore
events; do not use those parent IDs to classify a child's ordinary tool events.

## Boundaries

Primary sessions and standalone exec keep normal capture and retrieval. Existing
queued work continues. Explicit MCP/Skill operations remain available. A parent
can pass prior memories to a child through inherited context and can capture a
child's returned results. This switch is an automatic-memory preference, not a
sandbox or a guarantee against explicit file access.

Codex native memory has separate `memories.use_memories` and
`memories.generate_memories` controls. This change does not rewrite them.

## Verification

Isolated real-entrypoint tests cover all five registered events, explicit opt-in,
subsequent opt-out, nested children, primary sessions, unavailable or mismatched
metadata, invalid configuration, capture absence and foreground IPC absence.
Existing primary injection and Stop deadline tests use synthetic host metadata.
Real-child validation checks the installed host identity and default-off behavior
without using the installed Vault or Runtime as fixtures.
