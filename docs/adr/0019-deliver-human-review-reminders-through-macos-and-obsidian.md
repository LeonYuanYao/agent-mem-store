---
status: accepted
---

# Deliver human-review reminders through macOS and Obsidian

MemStore aggregates unresolved Human Conflict and Review Suggestion items into a Human Memory Review Digest. The default cadence is weekly and configurable. It sends no notification for an empty review set, applies a cooldown to repeated unresolved items, and allows snoozing without treating the underlying review as resolved. A digest is an optional review surface, not an approval gate for capture, retrieval, or ordinary governance.

The first-version primary reminder is a native macOS Notification Center notification. It contains only aggregate counts and issue categories, never memory bodies, evidence text, credentials, or sensitive values. Its primary actions open the Review Inbox in Obsidian or snooze the reminder. The default Inbox path is `_MemStore/Review Inbox.md` inside Memory Vault, opened through a correctly encoded `obsidian://open` URI supported by [Obsidian](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI). macOS provides local user-facing notification delivery through its [User Notifications framework](https://developer.apple.com/documentation/usernotifications).

Review Inbox is a generated, rebuildable governance view rather than Canonical Memory Data. It links to source memories and presents issue type, Luna's reason, evidence references, last-confirmed time, affected Projects, and available resolution operations without copying authoritative knowledge bodies. Users edit source Memory directly in Obsidian or invoke the canonical command surface or Memory Skill to confirm, adopt, disambiguate, archive, or snooze. The Inbox does not become a second governance engine.

Each scheduled digest creates a recoverable Reminder Obligation in the Governance Ledger. Attempted, delivered, acknowledged, snoozed, failed, and fallback states remain distinguishable. Native delivery failure, denied permission, machine downtime, or configured lack of acknowledgment or review activity can produce one bounded notice at the next eligible Agent SessionStart. That notice is operational status, not Memory Injection, and is not repeated every turn. Catch-up processing preserves reminder obligations across sleep, shutdown, and worker failure.

When a Review Suggestion is relevant to the current task, the bounded retrieval warning accepted in ADR-0018 remains available without waiting for the weekly digest. The first version does not send review reminders through email, Feishu, or another cloud messaging service. The core Reminder Obligation remains platform-neutral so future adapters do not require changes to Canonical Memory Data.

Exact notification-helper implementation, permission onboarding, acknowledgment timeout, default delivery time, cooldown and snooze presets, URI encoding implementation, and non-macOS adapters remain implementation-level or later review decisions.
