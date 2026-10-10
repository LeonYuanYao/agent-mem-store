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

Both CLI hook routes share the default-off subagent gate before capture,
Project resolution and foreground IPC. Excluded subagents return `continue: true`;
unknown identity adds a body-free `session_kind_unknown` notice. Neither path
creates capture, sensitivity, receipt or health state.

`human_authored_only_injection` also disables new Hook capture for every event.
Eligible SessionStart/UserPromptSubmit requests still resolve their scope and use
foreground IPC without a capture event ID. Sensitive prompts stay out of retrieval
without persisting a capture finding. Both CLI routes share this behavior. The
switch does not stop the Worker from draining previously captured evidence.

Stop shares a 1,300 ms internal capture budget and a 1,450 ms async-stall watchdog
under its two-second host limit. The watchdog emits one fail-open systemMessage
and stderr diagnostic, then exits; it cannot guarantee output after a host kill,
blocked event loop or OS suspension. Failure output distinguishes `not_saved`,
`unconfirmed`, `saved` and body-free persistence without raw exception text.
All other Hook events have a 1,700 ms asynchronous watchdog, leaving process
startup/output headroom within the two-second host limit. Foreground IPC receives
at most 1,500 ms and only the remaining Hook allowance minus 75 ms for output;
input, policy, project discovery and context updates cannot each restart that
budget. The watchdog reports the current stage without message bodies and emits
one fail-open response. It cannot preempt synchronous event-loop blockage or an
OS scheduling stall. Successful hooks stay silent unless ordinary retrieval display is enabled.

- [operations/README.md](../../src/operations/README.md)
- [adapters/codex/README.md](../../src/adapters/codex/README.md)
- [configuration/README.md](../../src/configuration/README.md)

Active hooks also send bounded, ephemeral Stop context to the Worker's private
socket. A matching Session and turn ID is required; unavailable sockets fail open
within 100 ms. Full replies are screened before clipping. SessionStart/SessionEnd
and sensitive input send a cache-clear update. This applies while durable capture
is disabled and never enables capture, distillation or a transcript scan. Role-aware
selection and tokenization remain in the Worker.

## State and side effects

Can start background services and invoke mutating operations. Hook context injection uses worker IPC; model distillation stays in background work.

`capacity corpus status` and `capacity corpus preview` are read-only. One-batch
archival requires `capacity corpus apply --file PREVIEW.json --gate DIGEST --apply`.
The supplied preview may be raw JSON or the preview command's JSON envelope; both
must pass exact-plan validation. This command does not enable automatic scheduling.

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
