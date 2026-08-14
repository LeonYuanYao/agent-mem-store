---
status: accepted
---

# Alias evidence and split failed large Batches

Distillation sends deterministic short aliases such as `e1` and `e2` to Luna
instead of long Evidence identities. MemStore validates the returned aliases
and restores exact original identities before candidate ingestion. This matches
the existing Session Consolidation boundary and reduces structured-copy errors
without weakening evidence binding.

Schema-invalid failures persist only a bounded diagnostic stage, code, and
optional schema path. Raw stdout, stderr, provider content, and validation
messages are not stored in operation state.

When a distillation Batch contains at least two events, retains at least 64 KiB,
and returns schema-invalid output, MemStore stops retrying that exact structure.
It records the parent operation as structurally replaced, bisects events by
retained byte weight, and queues two child Batches. The children retain session,
project, scope, startup, source selector, event order, and provenance. After
their successful completion, normal Session Consolidation still produces one
unified result. Successful large Batches are never split merely because of
size.
