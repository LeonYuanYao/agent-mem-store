---
status: accepted
supersedes: ADR-0009
---

# Cut over directly from Shadow Mode to MemStore only

MemStore remains the intended sole long-term system of record, distillation pipeline, retrieval engine, and injection path. Shadow Mode keeps Codex native generation and injection active while MemStore captures, indexes, and evaluates retrieval without foreground injection.

After reviewed Shadow evidence passes the acceptance gate, one Full Cutover disables both native memory generation and native `use_memories` and enables MemStore foreground injection. There is no intermediate Controlled Cutover or production period in which native generation remains active beside MemStore injection.

The cutover requires explicit user approval and fresh evidence for capture completeness, retrieval relevance, injection latency, fail-open behavior, worker and Vault recovery, duplicate suppression, and rollback readiness. MemStore does not change live Codex configuration merely because an engineering milestone is reached.

Existing native-memory data is preserved by default and is neither automatically deleted nor imported as Durable Memory. Any one-time migration remains separately reviewed and provenance-preserving. Rollback restores the previously verified native configuration without discarding MemStore data.

This decision supersedes only ADR-0009's intermediate Controlled Cutover stage. It retains the target single-system ownership, explicit approval, existing-data preservation, separate migration, and rollback requirements.
