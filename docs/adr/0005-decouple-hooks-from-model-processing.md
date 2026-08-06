---
status: accepted
---

# Decouple lifecycle hooks from model processing

Coding Agent lifecycle hooks capture bounded events and hand them off durably; they do not wait for Luna or any other distillation model. Before a capture is acknowledged, the host adapter atomically appends a normalized event to a machine-local durable outbox. Waking the background worker is best-effort, while the persisted event remains available for retry if the worker, network, model, or Memory Vault is temporarily unavailable.

An independent worker consumes events idempotently, coalesces related turn or session data, invokes Luna, and advances the Memory Candidate lifecycle. The outbox is recoverable operational state, not Canonical Memory Data or a second authoritative Memory Vault. Its concrete storage format, retention period, payload limits, and sensitive-data policy require later review.

`Stop` is the primary per-turn capture signal. `SessionEnd` performs only bounded flush, recovery, or worker-wakeup work and never waits for model inference. Host-specific timing and asynchronous capabilities remain inside Codex and Claude Code adapters; all adapters emit the same canonical event envelope.

Memory Injection reads only completed Durable Memories and derived local indexes. `SessionStart` may inject a small Core Memory Pack, `UserPromptSubmit` may inject a relevance-ranked Memory Pack under strict latency and token budgets, and MCP or Skills may provide deeper retrieval. None of these foreground paths invokes Luna. Capture and injection failures remain fail-open for the active Agent session, but must be observable and must not be falsely reported as successful capture.
