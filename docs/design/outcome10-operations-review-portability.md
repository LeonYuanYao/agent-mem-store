# Outcome 10 operations, Review UX, and portability

Status: review candidate; repository-local and uninstalled.

## Review Inbox and typed actions

`_MemStore/Review Inbox.md` is a generated, rebuildable operational view. It
contains opaque identities, bounded reasons, categories, counts, and links, but
never copies Human-authored Memory bodies, Candidate statements, raw evidence,
or suspected sensitive values. The final rendered file passes the local
sensitivity classifier before its atomic write. Its content hash and category
counts are recorded in Runtime Data so tampering is observable.

The first version aggregates Human Review Suggestions, Human conflicts,
Verification Requests, active Luna incidents, quarantined sensitivity findings,
and Capture dead letters. Review mutations accept only typed actions: dismiss a
Suggestion, complete or cancel a Verification Request, explicitly resolve a
Human conflict, snooze a reminder, or acknowledge it. There is no free-form
state mutation or generic cancellation.

## Reminders and native notification boundary

Non-empty Review Inbox snapshots can create one idempotent weekly reminder per
configured local-time week. Reminder state distinguishes pending, delivering,
delivered, snoozed, acknowledged, failed, and permission fallback. A reminder
is marked delivered only after the Notifier adapter returns a delivery receipt;
transient failure retries after five minutes and permission denial remains
visible for the later SessionStart fallback.

The notification contains only an aggregate count and an encoded Obsidian URI
for `_MemStore/Review Inbox.md`. The Swift package validates bounded requests and
typed, body-free open/snooze callbacks and defines the native notification
category. Tests use a recording adapter. No test or build command requests
Notification Center permission or delivers a real notification.

The uninstalled command-line helper does not by itself prove that a packaged
macOS host receives click callbacks after process exit. Bundle identity,
permission UX, live delivery, action callback routing, and Obsidian opening are
explicit Gate 4 pre-install manual evidence, not claims of this outcome.

## Worker and operator surfaces

Initialization registers the accepted Weekly and Monthly schedule in the
configured IANA time zone. `worker once` and `worker run` coordinate durable
Capture distillation, Session consolidation, Human conflict assessment,
Candidate semantic assessment, governance pages, Review Inbox refresh, reminder
creation, and optional native dispatch. Luna is enabled only when an explicit
`MEMSTORE_LUNA_CODEX_HOME` is supplied; the Worker never silently falls back to
another model. A paused Worker performs no work.

A retryable Luna operation receives at most six automatic retries after its
initial attempt, using the six bounded backoff slots. If the seventh total
attempt still fails, the durable operation becomes `blocked`; an exact manual
retry may attempt the preserved operation again but does not reset its automatic
retry history.

`status` exposes Luna health, the active retrieval index, Worker pause state,
Review Inbox/reminder backlog, the active governance run, and separate Capture,
distillation, Session consolidation, semantic assessment, conflict assessment,
and historical Candidate-reevaluation lanes. `doctor`
is read-only and never repairs: it checks configuration, SQLite integrity, and,
in deep mode, each catalogued Canonical file identity. `operation retry` targets
exactly one blocked or retrying Luna operation, retains its payload and gates,
and supports strict preview.

Every meaningful operator mutation has a zero-write `--preview` route and every
new command can emit the stable JSON envelope. The bounded families are:

- `doctor [--deep]`, `status`;
- `shadow status|start|report|verify|verification`;
- `operation status|retry <id>`;
- `worker once|run`;
- `review generate`, typed Review actions, and `review reminder prepare|dispatch`;
- `runtime backup --output <path>`;
- `portability readiness|pause|resume` and `vault validate`.

Destination semantic rebuild and retrieval verification remain application-core
operations until an embedding artifact is explicitly configured. The CLI
returns `embedding_adapter_required` instead of choosing or downloading a model
implicitly.

## Complete-knowledge handoff

Migration readiness blocks while Capture, Luna, governance, reminders,
Verification Requests, or Human conflicts are unfinished. The source is then
paused, and SQLite's online backup API creates a consistent recovery copy even
when committed data remains in WAL. That backup is never merged into the
destination.

Portable validation checks every catalogued Canonical Memory path and current
identity plus revision counts and relationship targets. The destination creates
a fresh Runtime catalog from the copied Vault, rebuilds an atomic retrieval
index with the configured adapter, regenerates Review Inbox, and proves a real
Recall result. It does not import leases, queues, reminders, receipts, sessions,
health incidents, governance cursors, aliases, indexes, or caches from the
source Runtime.

## Verification map

| Claim | Evidence |
| --- | --- |
| Body-free rebuildable Inbox and typed resolution | `tests/integration/review/review-inbox.test.ts` |
| Aggregate delivery, snooze, acknowledge, and empty suppression | `tests/integration/review/reminder-delivery.test.ts` |
| Durable reminder retry after transient failure | `tests/fault/recovery/reminder-retry.test.ts` |
| Diagnostic-only doctor, exact retry, and adapter-gated Worker | `tests/integration/operations/doctor-retry-worker.test.ts` |
| Stable CLI JSON and zero-write previews | `tests/contract/cli-operations.test.ts` |
| WAL-consistent Runtime backup | `tests/fault/recovery/runtime-backup.test.ts` |
| Drained Vault validation, clean destination rebuild, and Recall proof | `tests/e2e/portability/vault-handoff.test.ts` |
| Body-free native request/action contracts | `native/memstore-notifier/Tests/MemStoreNotifierCoreTests/ContractsTests.swift` |

## Deliberately inactive

Outcome 10 does not install or register a Hook, MCP server, Skill, Worker,
LaunchAgent, notification helper, or embedding artifact. It does not point at a
real Obsidian Vault, request macOS notification permission, run Luna, enable E5,
inject Memory, replace Codex native memory, import a Runtime database, or allow
two writers against one Vault. Those actions remain behind the next explicit
review gate.
