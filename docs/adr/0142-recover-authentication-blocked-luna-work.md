# ADR-0142: Recover authentication-blocked Luna work after successful calls

Status: accepted.

## Problem

Authentication failures stop after one attempt. ADR-0138 only permits recovery
for exhausted transient failures, so an authentication-blocked operation remains
stuck even after the configured Luna adapter successfully processes new work.

## Decision

- Keep authentication failures out of immediate fast retries.
- Let ordinary Worker claims recover them after six hours, healthy Luna state,
  and independent successful Luna work later than the operation's last failure.
  Authentication failures do not need to exhaust seven initial attempts.
- Reuse the existing persisted limit of two recovery attempts per manual retry
  epoch. A failed recovery returns directly to blocked. If its error changes to
  timeout, unavailability or rate limiting, it keeps the same remaining allowance
  and must obtain fresh success evidence before another attempt.
- Keep schema, model/configuration, input-size and local-processing failures out
  of automatic recovery. Manual retry remains available and resets the allowance
  while preserving lifetime attempts.
- Keep unresolved authentication visible as a Doctor warning. After model recovery,
  show the queued recovery as informational until completion. Exhausting the
  allowance restores the actionable warning even when the model is healthy.
- Store fixed, body-free invocation diagnostic codes. Recognize explicit HTTP
  401/403 and credential/login failures; distinguish known transport failures during
  token refresh. Match authentication terms as words, not incidental substrings.

The queue and Doctor share recovery predicates. This extends ADR-0138 without a
database migration, timer, additional model probe, or model configuration change.
Recovery evidence belongs to the configured Luna runtime; calls to unrelated
retrieval providers are not evidence of Luna authentication recovery.

## Verification

Public queue tests cover first-attempt blocking, healthy-model evidence, the exact
cooldown boundary, shared recovery budget across error categories, exhausted
recovery, manual retry and exclusion of non-recoverable failures. Worker and Doctor
tests cover a blocked captured batch through recovery and completion. Adapter
tests cover safe diagnostic codes, credential redaction and classification false
positives. All fixtures use isolated Runtime and Vault directories.

## Limits

Without subsequent successful Luna work, authentication recovery still needs user
intervention. A successful call does not guarantee every failed request can finish;
the bounded attempts expose persistent task-specific failures. Historical failures
without diagnostic codes cannot be retrospectively classified more precisely.
