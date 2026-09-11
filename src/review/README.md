# Review Inbox and reminders

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Builds the Obsidian review surface, applies explicit review actions and delivers bounded reminders.

## Start here

- [inbox.ts](inbox.ts)
- [actions.ts](actions.ts)
- [reminders.ts](reminders.ts)

## Flow and collaborators

generateReviewInbox renders outstanding obligations; applyReviewAction handles supported decisions; dispatchNextReminder delegates delivery to a notifier.

- [adapters/macos/notifier.ts](../../src/adapters/macos/notifier.ts)
- [candidates/human.ts](../../src/candidates/human.ts)
- [operations/maintenance.ts](../../src/operations/maintenance.ts)

## State and side effects

Writes the generated Review Inbox and reminder/action state. Host notification permission and delivery receipts are external effects.

## Invariants and change risks

Keep notification content body-free and preserve snooze/acknowledgement semantics. Delivery failure must remain observable and retryable. A reminder is not permission to rewrite Human knowledge.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/review tests/fault/recovery/reminder-retry.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
