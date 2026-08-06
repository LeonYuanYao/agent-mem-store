---
status: accepted
---

# Version local embedding adapters and review model switches

Foreground automatic retrieval may use only a machine-local resident embedding adapter. It cannot call Luna or a network embedding provider inside SessionStart or UserPromptSubmit. Embedding supplies a retrieval signal; deterministic code retains ownership of Relevance Band assignment and injection selection.

An adapter version binds model and weight identity, vector dimension, pooling, normalization, distance metric, text preprocessing, and chunking version. A completed semantic index revision cannot mix vectors from different adapter versions. Model artifacts, vectors, and indexes are rebuildable machine-local Runtime Data outside Memory Vault.

A model change builds a complete side-by-side index while the last completed compatible index serves. Representative Chinese, English, code, path, and error-information benchmarks, Shadow comparison, and explicit human Review are required before atomic activation of the new adapter and calibrated thresholds. Foreground unavailability may produce the accepted lexical-only path but cannot trigger a silent cloud fallback.

The exact first-version model remains an implementation benchmark decision. At least one lightweight and one quality-oriented candidate must be compared for recall, disk, memory, and compliance with the accepted 500-millisecond automatic Hook deadline.
