---
status: accepted
extends: ADR-0106 and ADR-0116
---

# Add an optional Jev filter after local automatic retrieval

The user approved integrating Jev with a 0.5 retention threshold and explicitly
required MemStore to work without a Jev connection. This adds an opt-in cloud
filter to UserPromptSubmit in the resident foreground worker. SessionStart,
explicit search and its Terra judge, background Luna processing, canonical
knowledge, local embedding, scope rules and ranking are unchanged.

Local retrieval first forms its normal budgeted pack, with at most six entries.
Jev receives the current prompt, the existing bounded recent-user history only
when the current prompt depends on context, and the exact selected representations
without identity headers. It receives temporary aliases, not project, session,
revision or memory identifiers. The pinned model is `jev-1.13.0`; the Noul question
matches the offline validation. A score at least 0.5 retains the item. Filtering
preserves local order, does not refill vacancies, and never bypasses local gates.

The `[jev]` section in machine-local configuration defaults off. Credentials are
read from `JEV_MODEL_API_KEY` or the owner-only regular file
`<runtime>/secrets/jev-api-key`; code never evaluates a shell startup file.
Credentials are not portable policy or knowledge. Enabling the feature explicitly
opts into sending the bounded textual payload to TypeSafe. Local secret heuristics
skip transmission of known or uncertain credential patterns; they do not promise
complete anonymization or detection of all sensitive information.

The enhancement has a maximum 600 ms budget, reduced by the foreground request's
remaining time while reserving 200 ms for receipts and delivery. Configuration,
credential reading, transport and response-body parsing are inside the budget.
Requests are abortable and never retried within a turn. Missing configuration or
credentials, suspected secrets, oversized input, deadline pressure, connection
errors, HTTP failures and invalid responses preserve the complete local pack.
Network/timeout/protocol failures enter a 15-second in-memory cooldown; rate or
quota limits use 60 seconds; authentication/authorization failures use five
minutes. The next eligible request after cooldown automatically tries again.
Disabling configuration takes effect even during cooldown.

A complete valid response rejecting every candidate produces an empty injection,
not fallback. Validation requires the pinned model, valid usage, finite 0–1
scores, and exactly the expected aliases. One invalid answer rejects the entire
response. Redirects and arbitrary provider endpoints are not supported.

Filtering happens before rendering and the receipt transaction. Only delivered
items consume epoch tokens, receive a legend or enter revision deduplication.
Existing receipt JSON stores bounded Jev state, reason, duration, threshold,
model and available token usage. Item reasons preserve scores and omitted items
use `jev_below_threshold`; no extra request/response-body log or database migration
is added. Expected optional-provider failures do not degrade core local health.

The expanded experiment favors 0.5 over 0.4 but still contains high-scoring
incorrect advice. A relevance score is not a truth check, authority upgrade or
permission to execute. See the [expanded validation](../research/jev-expanded-threshold-validation-2026-09-21.md).
Tests cover default-off behavior, degraded-provider fallback, recovery, privacy
screening, deadlines, exact receipt accounting and successful empty results.
