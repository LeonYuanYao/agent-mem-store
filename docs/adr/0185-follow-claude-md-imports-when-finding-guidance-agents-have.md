---
status: accepted
---

# Follow CLAUDE.md imports when finding guidance agents already have

Dreaming drops a claim when guidance agents already load states it (`documented_at`), and apply
compares new items with the user-wide instruction files (ADR-0148). The verifier's
`grep --autoload` searched instruction files by name (`AGENTS.md`, `CLAUDE.md`,
`.ai/bootstrap.md`, `.ai/context.md` at any depth) and skills. Claude Code also loads the files a
CLAUDE.md imports with `@path`. AgentScratchpad's `CLAUDE.md` is only `@AGENT.md`, so no rule of
`AGENT.md` was ever found: `documented_at` never named it, and three written Memories repeat its
rules (read `docs/memstore-handoff.md` first and update it before finishing; decisions go to
ADRs).

Decision: the files a CLAUDE.md (or CLAUDE.local.md) imports, transitively and at most five hops
deep as Claude Code does, count as guidance. In a repository they are resolved at the baseline
commit relative to the importing file and searched with the instruction files; imports that
leave the repository are not followed. For the user-wide instruction files they are resolved on
the host (`~/` and absolute paths too), searched as host guidance, compared with by apply and
shown to the instruction-file judge (ADR-0181) as part of the importing file. `@` inside code
spans and code blocks does not count; a target that is not an existing file is ignored, which
filters out `@scope/package` and mentions. Codex does not follow imports, so only CLAUDE.md
files are read for them.

Across the 14 repositories of the recent runs, two use imports: AgentScratchpad (`AGENT.md`) and
tteh, whose Ask AI workspace templates import their `AGENTS.md` (already searched) and
`EDIT_DSL_REFERENCE.md`. The user-wide files import nothing.

Evaluation: the verifier was replayed on historical items with each run's kept repository map,
pre-search recomputed by the code under test. Of five written AgentScratchpad Memories that
looked like repeats of `AGENT.md`, three are (two state things `AGENT.md` does not). Over three
replays each, the old code marked them documented 0 times of 9 and the new code 3 times of 9,
once citing `AGENT.md:28` and twice the handoff document `AGENT.md` tells agents to read first.
The search now finds `AGENT.md`; whether the verifier then calls a claim documented is its own
judgment and stays uneven. None of 16 other written items of AgentScratchpad and tteh was marked
documented.

Known limit, unchanged by this decision: guidance counts as known whichever agent loads it. A
rule only in `AGENT.md` (Claude Code) or only in a Codex skill is dropped though the other agent
never sees it; AgentScratchpad's `AGENT.md` and `AGENTS.md` differ, and the MemStore handoff rule
is only in the former.
