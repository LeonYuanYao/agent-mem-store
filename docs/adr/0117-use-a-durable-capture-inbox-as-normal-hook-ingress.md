---
status: accepted
supersedes: the normal-ingress rules in ADR-0070 and ADR-0103 after the reviewed activation
---

# Use a durable Capture Inbox as normal Hook ingress

Direct Hook writes to the main SQLite Outbox have continued to contend with background writers and have produced acknowledged warnings and unrecoverable `lost` dispositions. Every supported Hook will instead prepare one schema-validated, sensitivity-classified, size-bounded Capture disposition and atomically place it in an owner-only machine-local Capture Inbox before reporting success. The Worker imports Inbox files idempotently into the SQLite Durable Outbox and removes a file only after the Outbox records the same event identity or an equivalent body-free rejection.

Normal content uses the existing bounded sanitized event envelope. Confirmed Secret content writes only a body-free `blocked_secret` disposition, and uncertain sensitivity writes only a body-free `quarantined` disposition; neither path persists the suspect body. The first reviewed defaults allow 2,048 pending files or 512 MiB total, whichever is reached first, with warnings at 75 percent and a host-visible fail-open error at capacity. Existing valid files under `spool/capture/` are consumed through the same importer, so activation does not discard or rewrite pending events.

The Capture Inbox is a durable ingress, not a second processing queue or Canonical Memory store. SQLite remains the lifecycle, retry, batching, and governance ledger, but the background Worker becomes its normal Capture writer. This adds bounded file churn in exchange for removing Hook dependence on the SQLite writer lock and making every accepted Hook outcome independently recoverable.
