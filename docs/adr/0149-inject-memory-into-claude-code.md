---
status: accepted
---

# Inject memory into Claude Code through the Codex retrieval path

Claude Code sessions were captured for dreaming but received no memory, while
Codex received Human-authored and dreaming Memory (ADR-0148). The user works in
both agents and wants one store for both.

Decision: with `MEMSTORE_INJECTION_MODE=active`, the Claude Code Hook adapter
requests the Worker's foreground retrieval exactly like the Codex adapter and
returns the pack as `hookSpecificOutput.additionalContext`. The same authority
gate, ranking, Jev filter, receipts and per-Session deduplication apply; Claude
Code Session identifiers are UUIDs, so they share the Codex keys.

- UserPromptSubmit injects; SessionStart injects only with
  `session_start_injection`, as for Codex. The UserPromptSubmit Hook must run
  synchronously in `~/.claude/settings.json`; the others stay asynchronous.
- Claude Code adds Hook stdout to the model context and blocks on exit code 2, so
  stdout carries only a completed pack. Timeouts (1.7 s), an unavailable Worker
  and errors write nothing to stdout, report on stderr and exit 0.
- `[adapters].claude_hook_display` (default `summary`) controls what Claude Code
  shows per injected prompt, separately from Codex's `hook_display`; `items` adds
  one readable line per Memory (packs average about 1.2 items and 140 tokens).
- The Project comes from `CLAUDE_PROJECT_DIR`, the directory Claude Code was
  started in, not from the event's cwd: Claude Code reports the shell's current
  directory, so a `cd` into a nested repository would otherwise switch the
  Session's Project for injection and capture. Tool payloads keep the real cwd.
- Injection does not need dreaming; without `[dreaming].enabled` the Hook
  resolves the Project but captures nothing.
- SessionStart, SessionEnd and sensitive prompts clear the conversation context
  Jev uses. Claude Code provides no turn identifier, so assistant replies are not
  sent to Jev; relevance uses the user's prompts only.

Rejected: an MCP-only recall integration (the agent must decide to search, so
known pitfalls are missed); injecting through SessionStart only (too early for the
task, and disabled for Codex too).
