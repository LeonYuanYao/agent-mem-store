---
status: accepted
supersedes: ADR-0112 after the reviewed activation
---

# Isolate automatic retrieval in a deadline-owned foreground lane

Post-Cutover evidence showed that a foreground client can fail open after one second while the resident Worker continues the abandoned request for tens of seconds, delaying later requests and increasing SQLite contention. Automatic retrieval will therefore run in one dedicated worker thread inside the existing MemStore process and LaunchAgent. The owner-only Unix socket remains the external seam, while one deep Foreground Retrieval Lane owns admission, the absolute deadline, client-disconnect cancellation, the current immutable Retrieval Snapshot, deterministic packing, and the final bounded Receipt transaction.

The lane admits at most one request and has no ordinary waiting queue. A request that cannot start with enough remaining budget returns `busy`; a disconnected or expired request stops before another stage, does not commit a successful Receipt, and cannot consume Context Epoch tokens. Background E5 index work uses the same thread only through low-priority bounded batches that yield between batches to foreground work. The warm-path p95 target remains 300 milliseconds and the client-visible fail-open deadline remains one second.

Keeping retrieval on the Distillation Worker's event loop was rejected because synchronous SQLite and ONNX work cannot observe cancellation while that loop is blocked. A second retrieval daemon was rejected because it would add another process, model owner, installation target, and health lifecycle. A worker thread preserves one managed process while isolating foreground progress. Until the Activation Review switches the installed runtime, ADR-0112 remains the live implementation.
