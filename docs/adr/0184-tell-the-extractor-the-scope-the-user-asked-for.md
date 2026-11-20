---
status: proposed
---

# Tell the extractor the scope the user asked for

`memstore remember extract --scope global` writes what dreaming keeps as Global Memory
(ADR-0150), but the extractor was only told the project's name and that the user asked to keep
the material. Its prompt asks each statement to name the system, repository or tool it belongs
to, so a general rule from a project's material came out bound to that project or to an agent.
On 2026-11-20 the user asked for "never print files that may hold secrets" globally; two runs
wrote it as "when Codex handles…" and as "the AgentScratchpad project, when handling…", both
injected into every project.

Decision: in a requested run the extractor is told the requested scope. For `--scope global` it
is told the knowledge will be injected into every project and agent: it must not add the
current project or repository because the material came from it, nor make Codex or Claude Code
the subject or condition of a rule the material does not tie to them; conditions the material
does give (a machine, an operating system, a tool or configuration, an environment) stay.
Project requests and nightly runs are unchanged.

Evaluation: the extractor ran on the material of 20 requested file runs (17 auto-memory notes
of AgentScratchpad, two notes of tteh-workspace, one game reference) as global requests, three
times per prompt. Codex labeled each distinct statement against its material, blind to the
prompt, in two passes: whether it restricts the knowledge to a project or agent the material
does not, and whether it states the knowledge more broadly than the material does.

| prompt | statements | restricted | broadened | either |
|---|---|---|---|---|
| before | 242 | 73 (30%), in 15 of 20 materials | 11 (4.5%) | 35% |
| drop project and agent names | 239 | 0 | 44 (18%) | 18% |
| also keep the material's conditions (chosen) | 249 | 5 (2%) | 48 (19%) | 21% |

The broadened statements are mostly facts of the user's own setup stated without "on this
machine" or "in this configuration" (36 of the 48), which matters less in a personal store; the
rest, knowledge stated as holding beyond what the material showed, went from 6 to 12. Asking to
keep the material's conditions did not lower that number; it keeps the material's language as
before (8 statements in English against 20 before and 33 with the first prompt). The prompt's
examples are not taken from the evaluated materials.
