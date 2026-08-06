---
status: accepted
---

# Page provenance and one-hop relationships

The remaining explicit-recall commands are:

```text
memstore recall provenance <memory-id>
  [--revision <revision-id>]
  [--limit <count>] [--cursor <opaque-cursor>]
  [--target-tokens <count>] [--json]

memstore recall related <memory-id>
  [--revision <revision-id>]
  [--direction incoming|outgoing|both]
  [--limit <count>] [--cursor <opaque-cursor>]
  [--target-tokens <count>] [--json]

memstore recall report-irrelevant
  --receipt <receipt-id> --memory <memory-id>
  [--json]
```

Provenance pages identity-bearing source and derivation records instead of dumping a source session. Related returns exactly one graph hop, typed directed edge metadata, and compact adjacent-Memory identities. Its direction defaults to `both`; the first version does not add a relationship-expression language. Agents may continue by returned identity and page freely, so one-hop calls are a progressive-read boundary rather than a total-depth restriction.

Provenance and related default to 16 items and a 4,096-token target per page. They share search's opaque keyset-cursor semantics and configurable initial maximum page size of 50.

Report-irrelevant accepts no free-form reason. Its Retrieval Receipt must prove the exact returned Memory revision and caller. Recording is idempotent by receipt and revision and returns the Bad Case identity, unique observation count, and current repair state.

The corresponding MCP requests are `memstore_provenance({ memory_id, revision?, limit?, cursor?, target_tokens? })`, `memstore_related({ memory_id, revision?, direction?, limit?, cursor?, target_tokens? })`, and `memstore_report_irrelevant({ receipt_id, memory_id })`. CLI and MCP share the same core contracts.
