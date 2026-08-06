---
status: accepted
---

# Use a MemStore-native notifier and an Obsidian review surface

The first version delivers governance reminders through a minimal MemStore-owned macOS Notifier using macOS Notification Center. Obsidian does not send the notification. The notifier remains functional while Obsidian is closed, does not invoke Luna, and does not read or display Candidate, Memory, evidence, prompt, tool-output, or Secret bodies.

The weekly non-empty digest aggregates Human Memory review work and Verification Requests. For Verification Requests it may show counts, reason categories, oldest age, and approaching-expiration counts, but it does not create one notification per request. Its primary actions open the Review Inbox or snooze the digest for the configured interval, which defaults to seven days. Delivery and snooze outcomes are recorded in the Governance Ledger.

The detailed review surface remains `_MemStore/Review Inbox.md` in the Memory Vault. Clicking the notification opens it through a correctly encoded `obsidian://open` URI. Verification Requests occupy a distinct section containing bounded descriptions, request and candidate identities, Project, status, evidence gap, relevant timestamps, suggested action, and links to source records without copying authoritative knowledge bodies.

The first version does not develop or install an Obsidian notification Plugin and does not modify `.obsidian/` for reminder delivery. This keeps notification reliability independent of whether Obsidian is running and preserves the reviewed non-invasive Obsidian boundary.

When a manual core command or Memory Skill operation directly creates a Verification Request, the operation immediately returns `waiting_for_verification`, the request identity, the bounded evidence gap, and candidate state. Background requests remain non-interrupting and use the weekly digest.

A Reminder Obligation is not marked delivered until the notification adapter confirms delivery. Sleep or shutdown is covered by Catch-up Run. If notifications are denied or the adapter persistently fails, Review Inbox generation continues and one bounded operational notice is surfaced at a supported Agent SessionStart for that delivery incident. The notice contains no Memory body and is operational status rather than Memory Injection; it is not repeated on every prompt.
