---
status: accepted
---

# Leave Sessions under configured roots out of MemStore, with an in-Session opt-in

ADR-0170 keeps standalone `codex exec` runs out, which covers evaluation harnesses
that start the agent that way. Evaluation Sessions still reach MemStore by two other
routes on one machine:

- An editor's built-in AI panel starts an interactive agent (`codex` or `claude`) in a
  per-instance workspace under its application support directory. The user runs
  evaluation cases there by hand. These are primary Sessions: they were captured,
  served injected Memory and recent-work notes, and dreamed into case-specific
  Memory (ADR-0172).
- An evaluation runner whose default agent is `claude -p` starts it in per-case
  workspaces: sibling directories `/tmp/<prefix>_<run>_<phase>_<case>`, or a directory
  inside the runner's own repository, which resolves to that repository's Project and
  so receives its Memory.

ADR-0172 stops dreaming for such directories but not injection. The Session's
working directory is the only signal common to both routes; neither the editor nor the
runner is a repository MemStore owns, so the exclusion belongs in machine-local
configuration.

The user sometimes wants MemStore inside one of these Sessions, for example to recall
something while debugging, so the exclusion must be reversible from the Session itself.

Decision:

- `[adapters].excluded_roots` (machine-local list, default empty, at most 20) names
  directories. An entry covers the directory and everything below it; an entry whose
  last segment ends with `*` covers every directory beside it whose name starts with
  the rest, and everything below those. `~` expands, and both the entry's directory
  part and the Session's directory are resolved through symlinks before comparison.
- A Session is under an excluded root when its directory is: Codex's `cwd`, or for
  Claude Code the launch directory (`CLAUDE_PROJECT_DIR`), falling back to `cwd`.
- Hooks of such a Session return before Project resolution, capture and retrieval,
  like an excluded subagent or exec Session: nothing is captured, so nothing is
  dreamed, and nothing is injected, including recent-work notes. Nothing is written
  to the runtime.
- A prompt whose own text starts with `ms：` or `ms:` opts the Session in. That prompt
  and every later event of the Session are served normally. Hooks are separate
  processes, so the opt-in is a marker file per Session under
  `state/session-opt-ins/` (named by a hash of the Session ID), and it survives a
  resumed Session. The prompt's hook shows `MemStore：本会话已开启（此目录默认不采集、不注入）`.
- Missing, invalid or unreadable settings exclude nothing, so a broken setting never
  silently stops capture of Sessions the user expects to keep. Hooks read the setting
  on every event; no Worker restart is needed.

Consequences:

- Events before the opt-in are not captured, so `remember extract` over the Session
  sees only what followed it.
- An opted-in Session is dreamed only if its Project is scheduled: a Project under
  `[dreaming].skip_roots` still is not, and the user keeps knowledge from it with
  `remember`.
- The exclusion only stops MemStore. The agent still loads the user's own skills,
  instructions, hooks and MCP servers; an evaluation that must run without them still
  needs an isolated agent home.
- Explicit MCP and Skill operations stay available inside excluded Sessions.
