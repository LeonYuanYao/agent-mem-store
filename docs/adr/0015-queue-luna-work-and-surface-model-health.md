---
status: accepted
---

# Queue Luna work and surface model health

The first MemStore version uses Luna as its only distillation and deep-governance model and does not silently fall back to another model. Network failure, model unavailability, authentication or configuration errors, rate limits, timeouts, and invalid model responses leave affected operations durably pending or retryable rather than producing memories with an unreviewed provider.

Luna failure does not imply that all memory capabilities are unavailable. Durable capture continues when the local Outbox is healthy; existing Durable Memory remains searchable and injectable; deterministic local indexing and governance may continue. User-facing status must distinguish distillation delay from capture failure, Vault failure, and retrieval failure.

A persistent Model Health Incident records state, reason category, incident start, last successful Luna call, most recent failure, next retry, pending operation count, and oldest backlog age. Confirmed transition from healthy to degraded or unavailable produces one explicit host-visible notification rather than a message on every turn. Manual memory commands, the Memory Skill, and status surfaces always report the current state and whether requested work is completed, queued, or blocked. Recovery to healthy produces one recovery notification.

Notifications include enough information for action without exposing prompts, memory bodies, credentials, authorization headers, or raw provider responses. They are operational UI state, not Durable Memory and not part of a Relevant Memory Pack. Acknowledgment or temporary dismissal may suppress repeated presentation but cannot clear the incident or discard queued work.

Adding a fallback model later requires explicit configuration, separate quality validation, and a reviewed ADR. Exact incident thresholds, reason taxonomy, retry and notification cooldowns, host UI adapters, acknowledgment behavior, and manual recovery commands require later review.
