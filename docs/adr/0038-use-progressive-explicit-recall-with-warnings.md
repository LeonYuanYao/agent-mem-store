---
status: accepted
---

# Use progressive explicit recall with warnings

Explicit Deep Retrieval uses a compact-search then identity-based deep-read flow. The core commands are `memstore recall search`, `show`, `provenance`, `related`, and `report-irrelevant`. Agent integrations expose `memstore_search`, `memstore_get`, `memstore_provenance`, `memstore_related`, and `memstore_report_irrelevant` MCP tools. A repository-managed `$memstore-recall` Skill orchestrates complex natural-language recall requests without implementing a second retrieval engine.

Search returns compact Memory identities, snippets, scope, authority, and bounded relevance reasons. An Agent may autonomously request complete bodies, provenance, relationships, and additional pages when accuracy requires them. No per-page human approval is required. The default explicit scope is the resolved current Project plus Global Memory; Cross-Project access remains separately reviewed.

Explicit recall reads only eligible Durable Memory and local derived indexes. Secret Content, Memory Candidates, unresolved conflicts, expired or rejected content, and unauthorized scopes remain hard-filtered. No token policy weakens these boundaries, and the foreground path does not invoke Luna.

The initial page targets no more than 4,096 rendered tokens. A retrieval chain emits one warning when cumulative output first exceeds 8,192 rendered tokens and another update for each additional 8,192-token band. MemStore imposes no product-level hard token limit on explicit Agent retrieval. No-hard-limit means continued pagination or identity-based reads, not a default full-Vault response.

Explicit output does not consume the 1,200-token SessionStart limit or the automatic context-epoch injection budget. It still consumes host context, tool-response capacity, and account usage, so external platform limits remain effective and are reported honestly.

`report-irrelevant` records the explicit irrelevant observation against its Injection Receipt and Memory identity and creates or aggregates a Bad Case. The first version intentionally omits a broader free-form feedback taxonomy.

This ADR supersedes only the 8,192-token Explicit Deep Retrieval hard limit in ADR-0024. ADR-0024's automatic SessionStart, per-prompt, context-epoch, and quota-pressure policies remain accepted.
