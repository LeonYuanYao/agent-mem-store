---
status: accepted
---

# Store versioned segmented events in a SQLite-only Outbox

The first-version Durable Outbox lives only in `state/memstore.sqlite`, uses SQLite WAL, and commits an event atomically before reporting `captured`. It does not maintain a second ordinary JSONL or file-spool queue. A database commit failure remains fail-open for the Agent turn but creates an observable Capture Health Incident and cannot be represented as persisted or recoverable work.

Each record combines indexed structured columns with a schema-versioned validated JSON payload. Its envelope includes stable event and deduplication identities, Agent, Project, Session and Turn identities where available, event kind and time, sensitivity state, Injection Receipt reference, lifecycle, attempt, lease, retry and error metadata, and a sanitized bounded payload.

One payload segment has a configurable initial 64 KiB limit. Larger eligible Prompt or assistant content is stored as ordered rows under one event-group identity with a declared segment count, per-segment checksum, and whole-content identity. Retained sanitized text has a configurable first-version ceiling of 1 MiB per Turn. Exceeding it records `source_truncated` and byte counts and blocks lightweight promotion.

A worker treats a segmented source as complete only when every segment and checksum is present. Incomplete content takes the full path or waits and is never presented as intact evidence. The Turn ceiling does not authorize full Tool input or output capture; accepted generic structured Tool-event rules remain independently bounded.

An emergency spool may be proposed later only if measured SQLite commit failure materially causes capture loss. It is not speculative MVP machinery.
