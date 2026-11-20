---
status: proposed
---

# Count guidance as documented only for the agents that load it

Dreaming drops a claim the verifier finds in guidance agents already load (`documented_at`,
ADR-0147, ADR-0185). Memory is injected into Claude Code and Codex alike, but their guidance
differs: Claude Code loads CLAUDE.md files and what they import, Codex loads AGENTS.md files, and
each has its own skills. A claim stated only in one agent's guidance was dropped, so the other
agent never saw it. In AgentScratchpad, `AGENT.md` (imported by CLAUDE.md) and `AGENTS.md` differ;
the MemStore handoff rule is only in the first, the Git rules of `codex-config/AGENTS.md` only in
Codex's.

Decision: at tiering, the files `documented_at` cites are mapped to the agents that load them:
CLAUDE.md and CLAUDE.local.md, the files they import and `~/.claude/` to Claude Code; AGENTS.md and
`~/.codex/` to Codex; a skill to the agents it is installed for by name on this machine (or by its
`.claude/skills` or `.agents/skills` directory). A file whose agents cannot be told (`.ai/` guidance,
a repository's own skills directory) counts for every agent, as before. When a cited file reaches
only some agents, the cited lines are searched in all guidance, and a file with the same lines adds
its agents; AGENT.md and AGENTS.md share most of their text. The claim is dropped as documented only
when every agent working in the Project has it, where an agent works in a Project with at least
three Sessions there in the last 60 days and a tenth of them, and a Project without such Sessions
counts every agent. Otherwise it is tiered as if not documented (a `documented` verdict counts as
confirmed), and the item and report name the agents that lack the guidance.

Evaluation, on the 528 items dropped as documented: 104 (20%) reach only some of the agents working
in their Project, 72 missing Claude Code (50 in Codex-only skills, 22 in AGENTS.md) and 32 missing
Codex (21 in tteh's nested CLAUDE.md files); re-tiered, 97 would be injected. For each, passages of
the lacking agent's guidance that mention the item's identifiers were retrieved and Codex judged
whether they state it: 7 do, in other words (six in a differently named skill, one global rule
worded differently), 68 do not and 29 had no such passage. So about 7% of the items this keeps are
repeats for one agent; the rest are knowledge that agent did not have. No extra model call is made.

Not changed: apply's comparison with the user-wide instruction files (ADR-0148) still treats a rule
in either file as known to both agents (10 items so far).
