# Antigravity hook adapter

[Source map](../../../src/README.md) · [Agent guide](../../../AGENTS.md)

## Responsibility

Captures Antigravity (CLI, App and IDE) conversations for nightly dreaming and, with `MEMSTORE_INJECTION_MODE=active`, injects memory before the first model call of each user turn, through the same foreground retrieval as Codex and Claude Code (ADR-0192).

## Start here

- [../../cli/antigravity-hook.ts](../../cli/antigravity-hook.ts) — hook entry (`hook.js antigravity <Event>`).
- [hook.ts](hook.ts) — maps Antigravity's camelCase payload onto the shared Codex/Claude Code event mapping.
- [transcript.ts](transcript.ts) — reads the step before an execution and the reply that ended it from `transcript_full.jsonl`.

## Flow and collaborators

Antigravity's hook events become captured events with `agent: "antigravity"`:

| Antigravity event | Captured as | Notes |
|---|---|---|
| `SessionStart` | `SessionStart` | Fires once per new conversation, not when one is resumed. |
| `PreInvocation` | `UserPromptSubmit` | Runs before every model call; only the first call (`invocationNum` 0) of an execution whose previous transcript step is `USER_INPUT` counts. The prompt is `lastUserInput`. Injection happens here. |
| `PostToolUse` | `PostToolUse` | Carries the tool call and its `error`, not its output: the transcript records the output only after the hook. `run_command`'s `CommandLine` is captured as `command`. |
| `Stop` | `Stop` | The reply is the last `PLANNER_RESPONSE` with content after the last `USER_INPUT`; it also goes to Jev's conversation context (ADR-0167). |

The conversation id is the Session id. The Project comes from the first entry of `workspacePaths`, so a `cd` during the conversation does not change it; tool payloads keep the agent's real `cwd`. Events then go through the shared project resolution, private-turn and sensitivity checks and durable Inbox in [../codex/hook.ts](../codex/hook.ts).

## Invariants and change risks

- Antigravity runs every hook synchronously and blocks the agent loop. The hook always prints a JSON object (`{}` when it has nothing to add), sends diagnostics to stderr, exits 0 and stops itself after 1.7 s.
- PreInvocation calls that cannot start a user turn return before the capture modules load: this hook runs on every model call.
- Subagent conversations (`invoke_subagent`) have their own conversation id and an empty `lastUserInput`; they stay out unless `[adapters].subagents_enabled` (ADR-0165). An execution started by a subagent's report in the parent conversation has `invocationNum` 0 but no `USER_INPUT` before it, so it is not a prompt.
- If the transcript does not show the step before an execution, the call counts as a prompt (fail open): a prompt is not lost, at the cost of a possible extra capture.
- Injection is one `systemMessage` step in `injectSteps`; the display line set by `[adapters].antigravity_hook_display` (default `summary`) goes to `renderInfo.markdown`, which the user sees and the model does not. Do not put strings in `metadata`: Antigravity 1.5.x then rejects the whole hook output (its own guide still suggests `metadata.user_markdown`). Injected steps persist in the conversation.
- Captures only while `[dreaming].enabled` is true; injects only with `MEMSTORE_INJECTION_MODE=active`.
- Transcript reads are bounded to the last 1 MiB. The transcript format and hook payloads are Antigravity implementation details observed on CLI 1.5.x; Antigravity names its hook stdin fields in camelCase.

## Installation

Hooks live in `~/.gemini/config/hooks.json` (global; workspaces may add `.agents/hooks.json`). Each hook runs through `sh -c` from that file's directory, with the payload on stdin. `SessionStart` and `PreInvocation` run synchronously because they may inject; `PostToolUse` and `Stop` only capture, so the command hands the payload to a background process and answers `{}` at once:

```json
{
  "memstore": {
    "SessionStart": [{ "type": "command", "command": "<env> node <repo>/dist/cli/hook.js antigravity SessionStart", "timeout": 5 }],
    "PreInvocation": [{ "type": "command", "command": "<env> node <repo>/dist/cli/hook.js antigravity PreInvocation", "timeout": 5 }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "timeout": 5,
      "command": "p=$(cat); ( printf '%s' \"$p\" | <env> node <repo>/dist/cli/hook.js antigravity PostToolUse ) >/dev/null 2>&1 & printf '{}\\n'" }] }],
    "Stop": [{ "type": "command", "timeout": 5,
      "command": "p=$(cat); ( printf '%s' \"$p\" | <env> node <repo>/dist/cli/hook.js antigravity Stop ) >/dev/null 2>&1 & printf '{}\\n'" }]
  }
}
```

`<env>` is the same `NODE_NO_WARNINGS=1`, `MEMSTORE_INJECTION_MODE`, `MEMSTORE_RUNTIME_ROOT` and `MEMSTORE_VAULT_ROOT` the Claude Code hooks use. The background process must not hold the hook's stdout, or Antigravity waits for it.

Hook failures show in Antigravity's log (`~/.gemini/antigravity-cli/log/cli-*.log`, `hookcaller.go`), not in the conversation.

## Verification

```sh
pnpm exec vitest run tests/contract/antigravity-hook-entrypoint.test.ts
```
