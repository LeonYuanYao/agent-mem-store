# macOS notification adapter

[Source map](../../../src/README.md) · [Agent guide](../../../AGENTS.md)

## Responsibility

Implements the notifier port used by reminder delivery.

## Start here

- [notifier.ts](notifier.ts)

## Flow and collaborators

SwiftNotifierAdapter starts the configured helper and validates its JSON response; RecordingNotifier supports deterministic tests.

- [../../review/reminders.ts](../../review/reminders.ts)
- [../../integration/README.md](../../integration/README.md)

## State and side effects

Spawns a local notification helper. Tests should use RecordingNotifier unless explicitly validating host permissions and real notification delivery.

## Invariants and change risks

Keep delivered, permission-denied and failed outcomes distinct. Successful process launch alone does not prove delivery. Do not expose knowledge bodies in notification titles or payloads.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/review/reminder-delivery.test.ts tests/fault/recovery/reminder-retry.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../../SPEC.md) for product contracts and the [ADR directory](../../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
