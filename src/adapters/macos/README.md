# macOS notification adapter

[Source map](../../../src/README.md) · [Agent guide](../../../AGENTS.md)

## Responsibility

Implements the notifier port used by reminder delivery.

## Start here

- [notifier.ts](notifier.ts)

## Flow and collaborators

SwiftNotifierAdapter starts the configured helper and validates its JSON response; RecordingNotifier supports deterministic tests.

The native AppKit application registers its UserNotifications delegate before launch completes. Both a notification-body click and `open_inbox` open the encoded Obsidian Review Inbox; `snooze` invokes the existing Review CLI. A cold notification launch accepts no command-line arguments and services the event loop, then exits after a bounded idle window. Notification payloads cannot select executable paths: the helper resolves `memstore_cli` from the owner-controlled runtime installation manifest. No shell command is assembled from notification content.

Opening acknowledges only the reminder, not the underlying review items. An OS-open failure is not acknowledged. Local CLI failures receive three bounded attempts, remain visible, and do not report success. The most recent body-free callback outcome replaces `state/notifier-last-action.json`; macOS unified logging also records bounded error codes. No permanent helper daemon or model call is added.

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
pnpm build
pnpm build:notifier
MEMSTORE_NATIVE_TEST_EXECUTABLE="$PWD/native/memstore-notifier/.build/release/MemStore Notifier.app/Contents/MacOS/memstore-notifier" pnpm exec vitest run tests/integration/review/notifier-actions.test.ts
```

Check these test scenarios before changing behavior.

The opt-in native tests use an isolated runtime and real Swift-to-CLI snooze execution. They do not prove Notification Center click delivery or that Obsidian rendered the requested note. After a managed upgrade, register the installed app with LaunchServices and verify a real notification click, including after the delivery process exits. Do not leave the build-directory app preferred over the installed bundle. Re-run `status` on the installed helper to check authorization without requesting a new permission prompt.

## Design references

Use [CONTEXT.md](../../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../../SPEC.md) for product contracts and the [ADR directory](../../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
