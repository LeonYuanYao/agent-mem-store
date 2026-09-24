# ADR-0141: Bound governance targets and report blocked work

Status: accepted.

## Problem

Governance added optional retention assessments to pages containing many Memories.
The prompt limited those assessments to a small target list, while the output
schema allowed arbitrary identity strings. Invalid target binding could exhaust
the page retry budget. The run stored only `schema_invalid`, losing the adapter's
safe diagnostic. Doctor checked ordinary Luna operations but omitted the separate
governance queue, allowing it to report healthy while governance was blocked.

## Decision

- Use a fixed object field for each frozen retention target in the model output
  schema. Each field holds one assessment or null, eliminating repeated array
  entries. Share the value schema through a reference to keep input overhead
  bounded. Restore the existing array-based review contract inside the adapter;
  preserve authority and membership validation. Null remains unknown. No
  approximate ID mapping or lower evidence threshold is introduced.
- Persist bounded stage, code and field-path diagnostics in migration 0065. Do
  not persist raw exception text or model output. Separate output/evidence
  failures from local processing failures; the latter do not affect model health.
  Unknown local failures stop for explicit handling; SQLite contention retains
  bounded automatic retries.
- Include governance in Doctor independently of model health. Blocked runs are
  actionable warnings; scheduled retries are informational.
- Reuse `operation retry` for explicit recovery of blocked/retrying runs. Preview
  performs no writes. Resume resets consecutive failures while retaining frozen
  checkpoints, completed pages, successful coverage and lifetime attempts.

The initial call plus six automatic retries remains unchanged. A successful
unrelated model call does not reopen a schema-blocked run. Recovery requires fixing
its cause and explicit retry. This complements ADR-0138 and ADR-0139.

## Verification

Public adapter, governance Worker, Doctor/status and operation-retry tests cover
generation constraints, diagnostic persistence, error classification, preview,
resumption of the same frozen page, preservation of applied pages and removal of
the warning after recovery. Real-model probes use read-only review without
applying proposals; they do not prove that every future model response will pass.
