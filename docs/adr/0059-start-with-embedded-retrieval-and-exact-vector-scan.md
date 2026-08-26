---
status: accepted
---

# Start with embedded retrieval and exact vector scan

The retrieval implementation favors the smallest embedded architecture that satisfies measured requirements. Exact metadata uses normalized local index tables, lexical retrieval uses SQLite FTS5/BM25, and semantic retrieval uses a replaceable local vector-index sidecar under Runtime Data. The first version does not require Qdrant, Chroma, Elasticsearch, PostgreSQL/pgvector, or another separately operated retrieval service.

The MVP begins with exact vector scan in a resident MemStore-controlled local worker and defers ANN implementation. If representative benchmarks or production evidence show that exact scan cannot meet the accepted automatic deadline, currently one second under ADR-0114, or practical memory limits at the user's real scale, an ANN backend may be proposed at an explicit implementation Review. No speculative size threshold silently changes technology.

Exact metadata, lexical, and semantic artifacts bind to one immutable index revision and publish atomically only after every required component succeeds. Each is rebuildable from Canonical Memory Data. A completed subset may support an explicitly recorded degraded retrieval mode if another channel is unavailable, but it cannot be described as full hybrid retrieval.

Foreground Hooks use only in-process components or a MemStore-controlled local worker and never connect opportunistically to an external retrieval service.
