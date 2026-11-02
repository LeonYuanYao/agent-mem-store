---
status: accepted
---

# Retired systems and subagents stay out of dreaming

The 11-02 digest showed Memories about TTEH Ask AI's Classic mode, which the user no
longer uses. 16 active Memories concerned Classic tools; 5 drew their evidence only
from Classic code (`src/ask-ai/src/mcp-server/`). They came from a 10-29 Session
that surveyed all of Effect House AI with five Claude Code subagents, one of them
reading the Classic MCP layer. Three things let them through:

- Classic's code and documents remain in the repository (kept for partial
  compatibility and CloudEH; its retirement is planned, not done), so verification
  against the baseline confirmed every claim. Verification tells whether code says
  so, not whether a system is still used, and nothing told MemStore Classic retired.
- PTC has commands of the same names (`get_scene`, `edit_by_dsl`,
  `interact_by_dsl`, `capture_preview`). Statements from Classic's implementation
  ("TTEH 的 `edit_by_dsl` …") read as if they held for PTC.
- Claude Code subagents fire the Session's hooks (with `agent_id`), and their reports
  return as `<task-notification>` prompts, which the dreaming stream labelled USER.
  Codex subagent Sessions were already skipped (`[adapters] subagents_enabled`,
  default false).

Decision:

- `[[dreaming.retired]]` entries give a `note` and `paths`. Extraction is told that
  these systems are retired: skip what only they hold, and name the system when a
  live one has a tool, command or interface of the same name, preferring the live
  one. Verification marks claims that only hold for a retired system `stale` (review
  tier, never injected). An item whose evidence lies only under a retired path is
  dropped (`retired_subject`) without a model call, unless the user stated it.
- `subagents_enabled = false` now also covers Claude Code: hook events carrying
  `agent_id` and task-notification prompts are neither captured nor retrieved for.
  The user turns subagents on explicitly.
- The dreaming stream labels a task-notification turn `NOTIFICATION`; its text is
  material, never the user's words.
- Classic was declared retired with path `src/ask-ai/src/`. `src/ask-ai/scripts/` was
  listed at first and removed the same day: its `knowledge-gen` tooling generates
  the shared knowledge PTC reads and is used almost daily.
  Nine Memories were archived: the five backed only by Classic code (M:8863, M:8855,
  M:8845, M:8543, M:8850) and four framed on Classic (M:8795, M:8695, M:8807,
  M:8708). Memories that hold for PTC or both stay (M:8798, M:8839, M:8533, M:8564,
  M:8630, M:8572, M:8691).
- Older Memories were rechecked the same day. 24 active dreaming Memories drew their
  evidence only from Classic paths; Codex (gpt-6.1-sol, read-only in the TTEH repo)
  judged each against PTC: 9 hold in PTC, 6 behave differently there, 8 exist only
  in Classic, 1 is unclear. Archived: the 8 whose evidence lies only under
  `src/ask-ai/src/` and that differ or exist only in Classic (M:8841, M:8843, M:8844,
  M:8869, M:8828, M:8831, M:8832, M:8835). Kept: those holding in PTC, the unclear
  one, the `knowledge-gen` Memories, and M:8756, a preference the user stated.
