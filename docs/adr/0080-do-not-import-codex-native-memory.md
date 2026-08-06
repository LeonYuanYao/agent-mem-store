---
status: accepted
---

# Do not import Codex native Memory

The first MemStore version neither implements nor executes Codex native-memory import during Shadow, Full Cutover, or ordinary operation. Existing native data is preserved without deletion, movement, rewriting, or treatment as Durable Memory.

Before cutover, a body-free inventory captures resolved native-memory locations, counts, relevant configuration, and integrity metadata sufficient for rollback review. Native bodies are not copied into the Readiness Report, Runtime Data, or Memory Vault.

Knowledge present only in native Memory and not observed again during Shadow is intentionally unavailable to MemStore recall after cutover. This bounded gap is preferable to silent coexistence or direct import of compressed, potentially stale, and weakly provenanced content.

If a future import is separately justified and reviewed, each imported item begins as a provenance-labeled Agent-derived Candidate and passes ordinary sensitivity, scope, deduplication, conflict, applicability, and promotion gates. Import cannot overwrite Durable Memory or confer Human-authored authority.

Rollback restores the verified native configuration without discarding MemStore data or modifying the preserved native-memory store.
