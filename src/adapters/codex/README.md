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

Stop has a shared monotonic capture budget. Read-only Project discovery has at
most 200 ms and aborts its Git child on expiry; unresolved discovery is deferred
to Inbox import instead of falling back to synchronous registry creation. Import
must pass the exact Session identity so session-specific routes still win.
Capture failures expose only an allowlisted code, stage, elapsed time and
persistence state; never forward arbitrary exception messages or input bodies.

- [../../capture/README.md](../../capture/README.md)
- [../../projects/README.md](../../projects/README.md)
- [../../cli/codex-hook.ts](../../cli/codex-hook.ts)

## State and side effects

Captures events through runtime inbox paths and records bounded diagnostics. Changes can affect every interactive session, so test failure/timeout paths as well as successful capture.

## Invariants and change risks

Preserve event deduplication and fail-open session behavior. Do not perform model extraction inside hooks or save arbitrary full tool payloads. Honor the explicit session route and supported event set.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/codex-hook.test.ts tests/contract/codex-hook-entrypoint.test.ts tests/unit/worker/evidence.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../../SPEC.md) for product contracts and the [ADR directory](../../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
