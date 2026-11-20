---
status: accepted
---

# Count only guidance an agent loads as documented

ADR-0187 maps the files `documented_at` cites to the agents that load them, but a file whose agents
could not be told counted for every agent, as before. Those were mostly files no agent loads: the
verifier's autoload search (ADR-0147) covers every `skills/**/*.md` of a repository, which in tteh
includes the skills Ask AI ships to its own agent (`src/ask-ai/*/resources/workspace/skills/`), and
the verifier sometimes cites a README or a manual skill. Of the 487 items dropped as documented with
a cited file, 75 cite only product skills and 48 only other files no agent loads; their knowledge
never reached Claude Code or Codex. Skills are mostly installed as links: `~/.claude/skills/*` link
to `~/.agents/skills/*` or to `codex-config/skills/*` and `MemStore/skills/*` in a repository, and
tteh's `.agents/skills/*` link to `.ai/skills/*`.

Decision: a cited skill file belongs to the agents whose skill directories hold it, by real path:
the installed host skills (`~/.claude/skills` for Claude Code; `~/.agents/skills` and
`~/.codex/skills` for Codex) and each repository's own `.claude/skills` (Claude Code),
`.agents/skills` and `.codex/skills` (Codex). Instruction files and what CLAUDE.md imports are mapped
as in ADR-0187, other files under `~/.claude/` and `~/.codex/` to that agent, and `.ai/bootstrap.md`
and `.ai/context.md`, which instruction files point agents to, still count for every agent. Any
other file is loaded by no agent and documents nothing. As in ADR-0187 the cited lines are then
searched in all guidance, so a passage an installed skill also states still counts.

Evaluation, on the 528 items dropped as documented: 226 are no longer documented for every agent
working in their Project, 122 more than under ADR-0187 (81 lacking both agents, 35 only Claude Code,
6 only Codex) and none fewer; re-tiered, 116 of the 122 would be injected. Codex searched (`rg`) the
guidance each lacking agent actually loads, exported at the Project's latest baseline: 7 of the 122
are stated there for every lacking agent (6%, mostly in skills added since), 76 are related but miss
the item's key condition, command or value, and 39 are not stated at all. No model call is added.

Also measured: of 466 active dreaming Memories, Codex found 17 (3.6%) stated in guidance both agents
load, mostly skill bodies. A check before writing was not added for so few.

Not changed: the verifier's autoload search still covers every `skills/**/*.md`, so it still names
product skills in `documented_at`; tiering discounts them.
