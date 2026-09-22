# CLI and lightweight hook entry points

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Parses user commands, resolves configuration and dispatches operations; provides separate lightweight Codex hook startup.

## Start here

- [main.ts](main.ts)
- [command.ts](command.ts)
- [hook.ts](hook.ts)
- [codex-hook.ts](codex-hook.ts)

## Flow and collaborators

command.ts composes normal CLI operations and worker adapters. codex-hook.ts reads host JSON, captures the event and requests eligible foreground injection.

Stop shares a 1,300 ms internal capture budget and a 1,450 ms async-stall watchdog
under its two-second host limit. The watchdog emits one fail-open systemMessage
and stderr diagnostic, then exits; it cannot guarantee output after a host kill,
blocked event loop or OS suspension. Failure output distinguishes `not_saved`,
`unconfirmed`, `saved` and body-free persistence without raw exception text.
Successful hooks stay silent unless ordinary retrieval display is enabled.

- [operations/README.md](../../src/operations/README.md)
- [adapters/codex/README.md](../../src/adapters/codex/README.md)
- [configuration/README.md](../../src/configuration/README.md)

## State and side effects

Can start background services and invoke mutating operations. Hook context injection uses worker IPC; model distillation stays in background work.

## Invariants and change risks

Keep stdout machine-readable for JSON and hook output. Do not pull expensive model/index initialization into lightweight hooks. Preserve preview/apply semantics, exit codes and documented command parity.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/cli-operations.test.ts tests/contract/codex-hook-entrypoint.test.ts tests/contract/cli-memory-lifecycle.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
