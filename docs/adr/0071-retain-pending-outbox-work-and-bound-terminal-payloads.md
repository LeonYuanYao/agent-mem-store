---
status: accepted
---

# Retain pending Outbox work and bound terminal payloads

`captured`, active or lease-expired `processing`, and `retry-wait` payloads are not deleted because of age. Model, network, Worker, or Vault downtime cannot turn recoverable pending work into retention expiry. An expired processing lease returns the same event identity to idempotent claiming.

After `candidate-created`, `completed`, `skipped`, or `duplicate` is terminal and every required downstream Candidate, bounded evidence, and provenance record is durable, the sanitized Outbox payload defaults to 30 calendar days. Removal leaves body-free event metadata or a tombstone for a configurable 180 calendar days.

`dead-letter` is reserved for non-transient work that automation cannot continue. Temporary Luna, network, Worker, or Vault unavailability remains retryable. Dead-letter payload defaults to 90 calendar days and enters the Review Inbox. If unresolved at expiry, its body is removed, state becomes `expired_unresolved`, and body-free metadata follows the 180-day default. Explicit review, retry, or repair activity may restart its configured review window.

Before body removal, maintenance rechecks terminal state, absence of an active lease, downstream evidence and provenance durability, and expected content identity. Cleanup uses bounded batches and incremental space reclamation rather than full VACUUM after each deletion.

The 30-day terminal-payload, 90-day dead-letter-payload, and 180-day metadata values are configurable first-version defaults. User-visible status distinguishes replayable payload from metadata-only history and never claims removed content is recoverable.
