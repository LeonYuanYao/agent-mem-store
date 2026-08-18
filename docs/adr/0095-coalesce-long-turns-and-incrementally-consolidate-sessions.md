# Coalesce long Turns and incrementally consolidate Sessions

Long-running coding Turns can emit hundreds of `PostToolUse` events before a
`Stop`. Time-only batching turned those events into many tiny Luna requests and
later attempted to reconsolidate the complete Session after every resume.

The Worker now keeps an active Turn together until `Stop`, while retaining two
bounded checkpoints: 64 Capture Events or 512 KiB of retained evidence. A
captured `SessionEnd` still flushes the closed Session. The byte limit is
configurable at the application seam and remains bounded below 900,000 bytes.

Session consolidation records a durable generation and the inclusive Batch
ordinal range it consumed. A resumed Session consolidates only newly closed
Batch ranges after the stored cursor. Existing completed ranges are discovered
by the background Worker. A one-Batch episode that was already ingested
directly advances the same cursor so it is not sent to Luna again.

Session consolidations have priority over ordinary distillation operations in
their shared Worker lane. This priority is bounded because a consolidation can
exist only after its source Batches complete; it prevents a closed long Session
from sitting behind an older distillation backlog.
