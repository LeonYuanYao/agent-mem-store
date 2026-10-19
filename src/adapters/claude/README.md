# Claude Code hook adapter

[Source map](../../../src/README.md) · [Agent guide](../../../AGENTS.md)

## Responsibility

Captures Claude Code sessions for nightly dreaming and, with `MEMSTORE_INJECTION_MODE=active`, injects memory through the same foreground retrieval as Codex, so Codex and Claude Code share one memory store (ADR-0149).

## Start here

- [../../cli/claude-hook.ts](../../cli/claude-hook.ts) — hook entry (`hook.js claude <Event>`).
- [transcript.ts](transcript.ts) — reads the final assistant reply from the transcript tail when the Stop hook does not carry it.

## Flow and collaborators

Claude Code's SessionStart, UserPromptSubmit, PostToolUse, Stop and SessionEnd hooks share the Codex event mapping in [adapters/codex/hook.ts](../codex/hook.ts) with `agent: "claude"`, so events go through the same project resolution, sensitivity checks and durable Inbox. Dreaming reads them like Codex events.

## Invariants and change risks

- Captures only while `[dreaming].enabled` is true; injects only with `MEMSTORE_INJECTION_MODE=active`; with neither the hook returns immediately.
- Stdout carries only a completed pack as `hookSpecificOutput.additionalContext`: Claude Code adds SessionStart/UserPromptSubmit stdout to the model context, so diagnostics go to stderr.
- Always exits 0 and stops itself after 1.7 s: exit code 2 would block the prompt or the stop. The UserPromptSubmit hook must be synchronous to inject; the others can stay asynchronous.
- `[adapters].claude_hook_display` (default `summary`) sets the line shown per injection.
- The Project is resolved from `CLAUDE_PROJECT_DIR` (the launch directory) when Claude Code sets it, so a `cd` during the Session does not change it; tool payloads keep the real cwd.
- The transcript read is bounded to the last 1 MiB and to records of the hook's session.

## Verification

```sh
pnpm exec vitest run tests/contract/claude-hook-entrypoint.test.ts
```
