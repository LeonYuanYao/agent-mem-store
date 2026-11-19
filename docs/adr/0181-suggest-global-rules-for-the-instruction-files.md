---
status: proposed
---

# Suggest Global rules for the instruction files

Injection recalls a Memory by its similarity to the prompt (ADR-0175, ADR-0180). A rule
that holds in every session, such as "reply in Chinese", "do not create backups unless
asked" or "write long-term memory to MemStore", is rarely similar to any prompt: the
2026-11-19 recall audit missed such rules on 3 of 12 missed relevant pairs, and Jev gave
"write long-term memory to MemStore" 0.24 against "记到长期记忆里吧". Every session
already loads the user-wide instruction files (`host_instruction_files`, here
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`). Those files are the user's own; which of
them states what differs (the Codex file stated the backup rule in English, the Claude
file did not), and a keyword search cannot tell across languages.

Decision:

- After a dream run has applied its items, and only when the active Global Memories or
  the instruction files changed since the last judgment, the judge model (Terra) reads
  both and decides, per Global rule, whether it holds in every session, and per file
  whether the file already states it. For each file that lacks such a rule it proposes
  the text, in the file's language, and the existing entry to merge it into.
- The suggestions are stored in `<runtime>/state/instruction-suggestions.json`.
  `memstore dream digest` lists those first made in its window, once;
  `memstore instructions [--refresh]` lists all; `memstore instructions dismiss M:<id>`
  stops one for good. MemStore never edits the instruction files: the user, or an agent
  the user asks, writes the rule, and the next judgment sees it covered.
- The judgment is its own step of the report stage. A failure is recorded and retried
  after 20 hours; it never holds up a run. `instruction_suggestions = false` turns it off.

First judgment (2026-11-19, 27 Global Memories, one call of about a minute): three
suggestions. "Reply in Chinese" and "long-term memory goes to MemStore" for both files,
and "no backups unless asked" for the Claude file only, since the Codex file already
states it. The proxy rule, present in both files, and the task-specific Global Memories
(a Lark whiteboard routine, a devbox procedure, machine addresses) were not suggested.
