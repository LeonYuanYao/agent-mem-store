---
status: proposed
---

# Move a Memory to another scope through a successor

MemStore had no way to change the scope of a stored Memory. Agents asked to make a Memory
global looked for such a command and found none. On 2026-11-20 the user asked to make M:9163
("never print files that may hold secrets", Project scope) global. The only route was to
archive it and run `remember extract --scope global` on the material again, which rewrote the
statement: the three tries wrote it as unchanged from the Project Memory, as a rule for Codex
only, and as a rule for the AgentScratchpad project (ADR-0184).

A Canonical revision cannot change scope: the scope decides where the Memory lives in the Vault
(`Memories/Global/` or `Memories/Projects/<id>/`) and which retrieval space holds it. Relocating
a file in place, as session migration does, needs the worker stopped and the retrieval index
rebuilt.

Decision: `memstore rescope M:<n> --scope global|project [--project-id ID] [--apply]`, and the
MCP tool `memstore_rescope`, move one active Memory on the user's request. The Memory is
succeeded the way an explicit Human successor is: a new Memory in the target scope carries the
same body, authority, origin, startup, categories, relationships and provenance, with
`predecessor_memory_id` and a `scope:moved-from:` provenance entry; the old one is archived with
`successor_memory_id` and the reason `rescoped:<reason>`. The new Memory is written first, so an
interruption leaves both active rather than neither. Dreaming's record of the statement moves to
the new Memory, so a later run still recognises it. Like archive, it previews by default.
`--scope project` targets the Project of the working directory unless `--project-id` is given.
Agent-derived knowledge stays agent-derived and Human-authored stays Human-authored; the command
is the explicit global intent ADR-0006 requires. The `memstore-remember` skill tells agents to
use it instead of archiving and extracting again.

The cost is a new M: number; the old number resolves to the archived Memory, which names its
successor.
