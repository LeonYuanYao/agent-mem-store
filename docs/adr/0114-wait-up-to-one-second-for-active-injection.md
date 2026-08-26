---
status: accepted
supersedes: ADR-0056 and the timeout clauses in ADR-0058, ADR-0059, ADR-0078, and ADR-0106
---

# Wait up to one second for active injection

Post-Cutover production receipts showed useful UserPromptSubmit packs occasionally completing after the former 500-millisecond boundary, including one 807.7-millisecond result. The foreground client now waits up to 1,000 milliseconds before failing open; the Codex SessionStart and UserPromptSubmit command Hooks use a two-second host timeout so capture, response serialization, and fail-open handling are not killed at the same instant as the retrieval deadline. The p95 300-millisecond SLO remains an optimization target, and automatic retrieval remains local, deterministic, and free of Luna or network calls.
