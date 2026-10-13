---
status: accepted
---

# Retain pending Outbox work and bound terminal payloads

`captured`, active or lease-expired `processing`, and `retry-wait` payloads are not deleted because of age. Model, network, Worker, or Vault downtime cannot turn recoverable pending work into retention expiry. An expired processing lease returns the same event identity to idempotent claiming.

After `candidate-created`, `completed`, `skipped`, or `duplicate` is terminal and every required downstream Candidate, bounded evidence, and provenance record is durable, the sanitized Outbox payload defaults to 30 calendar days. Removal leaves body-free event metadata or a tombstone for a configurable 180 calendar days.

`dead-letter` is reserved for non-transient work that automation cannot continue. Temporary Luna, network, Worker, or Vault unavailability remains retryable. Dead-letter payload defaults to 90 calendar days and enters the Review Inbox. If unresolved at expiry, its body is removed, state becomes `expired_unresolved`, and body-free metadata follows the 180-day default. Explicit review, retry, or repair activity may restart its configured review window.

Before body removal, maintenance rechecks terminal state, absence of an active lease, downstream evidence and provenance durability, and expected content identity. Cleanup uses bounded batches and incremental space reclamation rather than full VACUUM after each deletion.

The 30-day terminal-payload, 90-day dead-letter-payload, and 180-day metadata values are configurable first-version defaults. User-visible status distinguishes replayable payload from metadata-only history and never claims removed content is recoverable.

## Implementation (2026-10-13)

Payload removal is implemented by `src/capture/retention.ts` (migration 0068),
run by the Worker every six hours and every 30 seconds while a backlog remains.
Completed payloads are removed after `retention.capture_payload_days` (default 30)
and dead-letter payloads after `retention.capture_dead_letter_payload_days`
(default 90); pending, processing and retrying work is never touched, and an
active lease defers removal. While dreaming is enabled, the payload period is at
least its lookback plus one day. Event rows remain with `payload_removed_at`, and
`readCapturedEvent` reports such events as unavailable. Two parts of the original
decision are deferred: a dead letter keeps its `dead_letter` state instead of a
new `expired_unresolved` state (the state CHECK would need a table rebuild), and
body-free metadata is not yet deleted after 180 days. Freed pages are reused; the
file shrinks only through `memstore runtime compact` while the Worker is paused.
