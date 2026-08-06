---
status: superseded
superseded_by: ADR-0060
---

# Replace Codex native Memories after staged validation

MemStore is the intended long-term system of record, distillation pipeline, retrieval engine, and injection path for Codex memory. Codex native Memories may coexist temporarily as a development baseline and rollback mechanism, but they are not part of the target steady state. After MemStore passes reviewed acceptance gates, native memory generation and injection are disabled so two independent systems cannot silently duplicate, contradict, or compete for context.

Cutover proceeds in three reviewed stages. In Shadow Mode, Codex native Memories remain active while MemStore captures, indexes, and evaluates retrieval without injecting into foreground turns. In Controlled Cutover, native `use_memories` is disabled and MemStore injection becomes active; native generation may remain temporarily enabled only for comparison and rollback, and its outputs do not enter MemStore governance or normal recall. In Final Cutover, native generation is also disabled and MemStore becomes the sole long-term memory path.

Advancing stages requires explicit user approval and fresh evidence for capture completeness, retrieval relevance, injection latency, fail-open behavior, worker and Vault recovery, duplicate suppression, and rollback readiness. MemStore must not automatically change the user's Codex configuration merely because a software milestone is reached.

Existing native-memory data is preserved by default. It is not automatically deleted, imported into Memory Vault, or treated as Durable Memory. Any one-time migration is a separate, provenance-preserving, explicitly reviewed operation. Rollback re-enables the previously verified native configuration without discarding MemStore data.
