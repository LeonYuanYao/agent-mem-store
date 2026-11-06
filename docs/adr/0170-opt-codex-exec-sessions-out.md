---
status: accepted
---

# A machine can opt standalone `codex exec` Sessions out of MemStore

Codex records each thread's source: `cli` and `vscode` for interactive sessions,
`exec` for a standalone `codex exec` run, and a structured `subagent` value for
children. ADR-0137 keeps subagents out by default but treats `exec` as a primary
Session, so it is captured, dreamed about and served injections like any other.

On some machines nearly every `exec` run is automation: E2E builders and judges,
self-optimization coaches and executors, reviews another agent delegates to Codex,
and one-line probes. In 2026-11 one E2E batch on such a machine produced 66 `exec`
Sessions. Every judge received injected Project Memory, which biased the evaluation,
and dreaming turned the harness's fixed instructions into Memory labelled as
user-stated. Isolating each harness with its own `CODEX_HOME` prevents this, but only
if every harness remembers to, and the harness is often in a repository MemStore
does not own.

Other users run `codex exec` themselves and expect it to be remembered, so the
default stays as it is.

Decision:

- `session-kind.ts` classifies `exec` as its own kind instead of `primary`.
- `[adapters].exec_sessions_enabled` (machine-local boolean, default `true`) decides
  whether `exec` Sessions are served. With `false`, the Codex Hook skips them before
  Project resolution, capture and retrieval, exactly as it skips subagents: no
  capture, no injection, no recent-work digest, and nothing persisted.
- Missing, invalid or unreadable settings keep the default (`true`), so a broken
  setting never silently stops capture of Sessions the user expects to keep.
- The two switches are independent. Session identity is read whenever either gate is
  active; an unknown identity is then skipped with the existing body-free notice.
- Hooks read the setting on every event; no Worker restart is needed.

Consequences:

- Verifying Codex capture with a `codex exec` probe does nothing on a machine that
  opts out. Use an interactive session, or set the switch back to `true` for the probe.
- Automation launched through the Codex app-server or SDK reports another source and
  is not covered.
- Claude Code's `claude -p` is not covered; its Hooks do not report a comparable source.
- Already captured `exec` work and Memory dreamed from it are left as they are.
