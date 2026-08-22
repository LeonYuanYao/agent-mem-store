---
status: superseded-by-0104
---

# Decouple native Memory from Shadow identity

Codex native `generate_memories` and `use_memories` are observed in official
Shadow status but do not participate in the MemStore Shadow configuration
identity. Changing either flag does not invalidate or restart an official
Shadow window. MemStore MCP configuration, managed Hook state, executable
program identity, installed candidate, and approved retrieval profile remain
gating identities.

ADR-0104 later removed identity invalidation and the `shadow migrate-identity`
operation entirely. Native Memory flags and all other implementation changes
are now observations in Shadow status; none restart the elapsed-time window or
block Gate 6 eligibility.
