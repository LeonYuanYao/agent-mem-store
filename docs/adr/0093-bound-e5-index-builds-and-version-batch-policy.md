---
status: accepted
---

# Bound E5 index builds and version the batch policy

The first E5-base q8 implementation embeds at most 16 documents in one model call. Its adapter version includes that batch policy: `transformers-4.2.0:q8:mean-l2:batch16:v2`.

The previous implementation passed the complete catalog to one ONNX call. A live rebuild of several hundred memories took minutes and raised process memory into the tens of gigabytes. Measurements with real Canonical Memory text showed that batches of 4, 8, and 16 all kept peak memory below two gigabytes on the observed machine. Batch 16 had the best throughput and the closest overall ranking to the previous active index in that sample. These measurements support the selected default but are not portable performance guarantees.

Batch shape changes the generated vectors and can change the order of close retrieval results. A different batch policy therefore requires a new adapter version and a complete replacement index. MemStore does not mix vectors produced by the previous unbounded implementation with Batch 16 vectors. The active official Shadow window reports the replacement as an observed change without restarting its elapsed-time window.

Later revisions reuse vectors only when Memory revision, content identity, and adapter identity all match the active index. New or changed memories alone are embedded. A failed rebuild leaves the last complete index selected, records the failed build, pauses further index attempts for five minutes, and does not stop Luna or other Worker queues.

Automatic cleanup of historical index revisions is outside this decision.
