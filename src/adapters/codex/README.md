# Codex hook adapter

[Source map](../../../src/README.md) · [Agent guide](../../../AGENTS.md)

## Responsibility

Maps supported Codex events into project-scoped, durable capture and bounded session evidence.

## Start here

- [hook.ts](hook.ts)
- [session-kind.ts](session-kind.ts)

## Flow and collaborators

handleCodexHook validates host input and resolves the project/session route before capture; the CLI hook entry owns output rendering and foreground IPC.

Before capture, the CLI applies the default-off subagent policy. session-kind.ts
reads the exact thread's source from the newest `state_N.sqlite` under
`CODEX_HOME` (or `~/.codex`), read-only with no SQLite lock wait. Its fallback reads
at most 1 MiB of the host-provided transcript's first record and requires a
matching session ID. Both formats are host implementation details; unknown
identity skips automatic memory work with a body-free notice. No transcript or
host metadata is retained.

The CLI passes `captureEnabled: false` in human-only injection mode. The adapter
returns `capture_disabled` without building or persisting an event. Only safe
SessionStart/UserPromptSubmit input resolves a Project for foreground retrieval;
other events and sensitive prompts return immediately. This path creates no
capture findings or capture-health records. Explicit capture APIs stay independent.

Stop allows 200 ms for Project lookup. Other Hooks share at most 500 ms across
read-only discovery and registration fallback; expiration aborts the current Git child and cannot be
reinterpreted as a non-Git project. Stop never attempts registration in the Hook.
With capture enabled, unresolved scope is deferred to Inbox import with the exact
Session identity; with capture disabled, that invocation skips scoped injection.
Stop additionally retains its shared monotonic capture budget.
Capture failures expose only an allowlisted code, stage, elapsed time and
persistence state; never forward arbitrary exception messages or input bodies.

- [../../capture/README.md](../../capture/README.md)
- [../../projects/README.md](../../projects/README.md)
- [../../cli/codex-hook.ts](../../cli/codex-hook.ts)

The CLI separately forwards `last_assistant_message` with `session_id` and `turn_id`
from active Stop hooks into a bounded Worker memory cache for Jev context. This is
not durable capture: human-only mode still creates no new capture events. Missing
turn identity or reply text is ignored, never reconstructed by scanning transcripts.
See [retrieval context ownership](../../retrieval/README.md).

## State and side effects

Captures events through runtime inbox paths and records bounded diagnostics. Changes can affect every interactive session, so test failure/timeout paths as well as successful capture.

## Invariants and change risks

Preserve event deduplication and fail-open session behavior. Do not perform model extraction inside hooks or save arbitrary full tool payloads. Honor the explicit session route and supported event set.

Derive command metadata from the bounded tool input. A truncated input must not
reintroduce its full command through a second field; ordinary intact commands
retain their verification metadata. Existing captured evidence remains unchanged.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/codex-hook.test.ts tests/contract/codex-hook-entrypoint.test.ts tests/unit/worker/evidence.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../../SPEC.md) for product contracts and the [ADR directory](../../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
