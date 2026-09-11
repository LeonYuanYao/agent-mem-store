# Host adapters

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Contains host-specific translations at the edge of MemStore; domain rules remain in shared modules.

## Start here

- [codex/hook.ts](codex/hook.ts)
- [macos/notifier.ts](macos/notifier.ts)

## Flow and collaborators

Codex converts host lifecycle events into capture requests; macOS converts reminder delivery into a notifier subprocess call.

- [../capture/README.md](../capture/README.md)
- [../review/README.md](../review/README.md)

## State and side effects

See the nested Codex and macOS module guides for event persistence and notification side effects.

## Invariants and change risks

Keep host payload quirks here rather than copying Candidate or Vault policy into adapters. New hosts need explicit event and failure-mode tests; do not assume Codex payloads apply elsewhere.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/codex-hook.test.ts tests/integration/review/reminder-delivery.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
