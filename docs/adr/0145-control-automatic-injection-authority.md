---
status: accepted
---

# Control automatic injection authority

The user wants to suspend automatic injection of Agent-derived knowledge while
retaining Human-authored candidates and a reversible switch. The user also wants
to stop new automatic capture while continuing to digest existing evidence.
Existing settings
control startup injection, subagents and presentation, not candidate authority.

Add machine-local `[adapters].human_authored_only_injection`. It defaults false
in a valid configuration. True admits only existing `human_authored` authority;
model extraction does not become Human-authored merely because a user requested
it. Invalid, unreadable or missing configuration documents use true so a read
failure cannot broaden authority.

Read the flag during each automatic pack request. Apply it before candidate
ranking and item limits in both SQLite and resident-snapshot paths, including
SessionStart's always/auto buckets. UserPromptSubmit sends only eligible local
candidates to Jev, so timeout fallback also respects the authority restriction.
Direct identity references and relationship expansion do not bypass eligibility.

False restores the original authority range without index rebuilding, schema
migration or changes to canonical knowledge, and resumes new automatic capture.
While true, every Codex Hook skips creating a capture event. Eligible foreground
requests resolve scope without capture and omit the capture event ID. Sensitive
prompts are checked locally before retrieval without persisting findings. Hook
failures in this path do not create capture-health records.

Existing Inbox evidence, queued extraction/consolidation and Candidate work keep
running under their existing retry and capacity policies. No backlog is paused,
reset or deleted. Produced Agent-derived knowledge remains excluded from
injection. Explicit saves/searches and existing SessionStart enablement remain
independent. Retrieval receipts still support accounting/deduplication and are
not distillation input. The setting cannot retract existing conversation context.

Isolated tests cover both retrieval paths, both scopes, switching on and off
against the same index/snapshot, direct-reference exclusion, Jev fallback,
receipt selections, explicit recall and restrictive configuration failures.
Real Hook entrypoint tests cover all five events, injection without capture,
sensitive prompts and switching capture back on. Worker tests verify that
previously queued evidence still completes while the flag is true.
