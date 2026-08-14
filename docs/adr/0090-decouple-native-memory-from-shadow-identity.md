---
status: accepted
---

# Decouple native Memory from Shadow identity

Codex native `generate_memories` and `use_memories` are observed in official
Shadow status but do not participate in the MemStore Shadow configuration
identity. Changing either flag does not invalidate or restart an official
Shadow window. MemStore MCP configuration, managed Hook state, executable
program identity, installed candidate, and approved retrieval profile remain
gating identities.

An active version-one window may move to the native-memory-independent identity
only through the explicit `shadow migrate-identity` dry-run and apply flow. The
migration proves that candidate, installation, MCP, managed Hook state, and
retrieval profile remain compatible. It preserves the window identity, start
time, minimum end time, and frozen coverage counts while recording the previous
baseline digest, program digests, native Memory observations, reason, and time.

This migration corrects the experiment boundary; it does not manufacture
coverage, restart elapsed time, enable MemStore injection, or perform Full
Cutover.
