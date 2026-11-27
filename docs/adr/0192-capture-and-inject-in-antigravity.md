---
status: accepted
---

# Capture and inject memory in Antigravity

The user started working in Antigravity (CLI, App and IDE) beside Claude Code and Codex: from
2026-11-18 to 11-27 it held 28 conversations against 103 for Claude Code and 58 for Codex, most
of them in the last three days. Antigravity already had the MemStore skills and the rule to
remember through MemStore, but its conversations were neither captured for dreaming nor given
memory. Its lifecycle hooks (`~/.gemini/config/hooks.json`) can do both, with differences from
Claude Code that this decision settles. The payloads below were observed on CLI 1.5.x with a probe
hook, not taken from its guide alone.

Decision: a third Hook adapter, `hook.js antigravity <Event>`, maps Antigravity events onto the
shared Codex/Claude Code capture mapping with `agent: "antigravity"`, and injects through the same
foreground retrieval, authority gate, Jev filter, receipts and per-Session deduplication.

- `SessionStart`, `PostToolUse` and `Stop` keep their names. `PreInvocation`, which runs before
  every model call, stands in for `UserPromptSubmit`: only the first call (`invocationNum` 0) of an
  execution whose previous transcript step is `USER_INPUT` is a prompt, with `lastUserInput` as its
  text. Antigravity also starts executions without a user message, for example when a subagent's
  report reaches the parent, so `invocationNum` 0 alone would capture and inject twice. When the
  transcript does not show the step, the call counts as a prompt. Other calls return before the
  capture modules load (about 50 ms).
- The conversation id is the Session id. The Project comes from the first of `workspacePaths`,
  so a `cd` does not change it, as with `CLAUDE_PROJECT_DIR` (ADR-0149); tool payloads keep `cwd`.
- `PostToolUse` carries the tool call and its `error` but not its output, which the transcript
  records only after the hook; capture keeps what the hook has. `run_command`'s `CommandLine` is
  captured as `command`. `Stop` carries no reply: it is the last `PLANNER_RESPONSE` with content
  after the last `USER_INPUT` in `transcript_full.jsonl`, and it also feeds Jev's conversation
  context (ADR-0167). `SessionStart` does not fire when a conversation is resumed.
- Subagent conversations (`invoke_subagent`) have their own id and an empty `lastUserInput`; they
  stay out unless `[adapters].subagents_enabled` (ADR-0165).
- The injection is one `injectSteps` system message. `[adapters].antigravity_hook_display`
  (default `summary`, same values as `hook_display`) goes to `renderInfo.markdown`. Antigravity's
  own guide suggests `metadata.user_markdown`, but 1.5.x panics on a string in `metadata` and drops
  the whole output, so nothing is put there.
- Antigravity runs every hook synchronously and expects a JSON object on stdout. The hook always
  prints one, reports on stderr, exits 0 and stops itself after 1.7 s. Capture costs about
  120–150 ms per call, so the installation runs `PostToolUse` and `Stop` in the background from the
  hook command, as Claude Code's `async` hooks do; `SessionStart` and `PreInvocation` stay
  synchronous because they may inject.
- Guidance coverage (ADR-0187) counts Antigravity Sessions as Codex's: both load the AGENTS.md
  files of a Project. Counting them apart, or not at all, would let Antigravity's Sessions push
  Codex below its share and treat a claim only CLAUDE.md states as documented for every agent.
  Antigravity also reads GEMINI.md and `~/.gemini/config/skills`, which this does not model.
- The hook entry now imports each host's adapter on demand.

Consequences: Antigravity conversations reach dreaming, recent work and injection like the other
hosts. Tool outputs are missing from Antigravity's captured tool events, so dreaming learns less
from its commands than from Claude Code's. If Antigravity hands a message the user queued while the agent
worked to a later model call, that message is not captured as a prompt (not observed yet). The hook payload and transcript format are
Antigravity implementation details; a change there degrades capture and injection without
blocking the agent.
