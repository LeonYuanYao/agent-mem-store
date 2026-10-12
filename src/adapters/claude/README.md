# Claude Code capture adapter

[Source map](../../../src/README.md) · [Agent guide](../../../AGENTS.md)

## Responsibility

Captures Claude Code sessions for nightly dreaming so Codex and Claude Code feed one memory store. Capture only: it injects nothing.

## Start here

- [../../cli/claude-hook.ts](../../cli/claude-hook.ts) — hook entry (`hook.js claude <Event>`).
- [transcript.ts](transcript.ts) — reads the final assistant reply from the transcript tail when the Stop hook does not carry it.

## Flow and collaborators

Claude Code's SessionStart, UserPromptSubmit, PostToolUse, Stop and SessionEnd hooks share the Codex event mapping in [adapters/codex/hook.ts](../codex/hook.ts) with `agent: "claude"`, so events go through the same project resolution, sensitivity checks and durable Inbox. Dreaming reads them like Codex events.

## Invariants and change risks

- Captures only while `[dreaming].enabled` is true; otherwise the hook returns immediately.
- Never writes stdout: Claude Code adds SessionStart/UserPromptSubmit stdout to the model context.
- Always exits 0 and stops itself after 1.5 s: exit code 2 would block the prompt or the stop.
- The transcript read is bounded to the last 1 MiB and to records of the hook's session.

## Verification

```sh
pnpm exec vitest run tests/contract/claude-hook-entrypoint.test.ts
```
