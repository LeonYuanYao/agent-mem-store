---
status: accepted
---

# Coalesce index builds behind a dirty catalog watermark

Production activity has rebuilt and published retrieval indexes for successive one- or two-Memory catalog changes, causing avoidable E5 work, memory spikes, and foreground contention. Durable Memory changes will advance a monotonic dirty catalog watermark. The indexer waits for a 30-second quiet period, but starts after at most two minutes of continuous change; one build snapshots one watermark, reuses compatible vectors, and publishes atomically while the previous complete index continues serving.

Only one build may run. Catalog changes during a build schedule one follow-up build rather than invalidating the consistent snapshot already being produced. Embedding remains bounded to 16 documents per call and yields to foreground retrieval between batches. A failed build leaves the last complete index active and retains the reviewed five-minute retry cooldown. Quiet-period and maximum-staleness values are versioned configuration and require human Review to change.
