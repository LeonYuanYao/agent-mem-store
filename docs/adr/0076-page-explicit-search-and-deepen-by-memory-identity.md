---
status: accepted
---

# Page explicit search and deepen by Memory identity

The canonical explicit search and body-read surface is:

```text
memstore recall search <query>
  [--scope current|global|project:<id>|all-projects]
  [--limit <count>]
  [--cursor <opaque-cursor>]
  [--target-tokens <count>]
  [--json]

memstore recall show <memory-id>
  [--revision <revision-id>]
  [--detail compact|standard|full]
  [--json]
```

Default `current` scope means current Project plus Global Memory. `global` and `project:<id>` are exact scopes, while `all-projects` is the already accepted explicit cross-Project expansion. Project scope does not silently union Global.

One search page defaults to at most 16 items and a 4,096-rendered-token target. The implementation maximum page size is configurable and initially 50. Page pressure favors preserving qualifying identities with shorter bounded descriptions. These are per-page controls, never a total Agent retrieval-chain limit.

Each result includes a compact description, Memory and revision identities, scope, authority, source-Project label, and bounded relevance reason. Pagination uses an opaque keyset cursor bound to normalized query, resolved scope, authorization, ranking configuration, and index revision. A materially changed binding returns `cursor_stale` and requires a fresh search.

`show` defaults to the latest eligible revision in `standard` detail. A `full` read returns the Canonical Memory body and essential labels but does not recursively include provenance or relationships.

The corresponding MCP requests are `memstore_search({ query, scope, project_id?, limit?, cursor?, target_tokens? })` and `memstore_get({ memory_id, revision?, detail? })`. MCP represents scope as `current`, `global`, `project`, or `all_projects`; only `project` requires `project_id`. CLI and MCP normalize into the same core request and versioned envelope and therefore cannot drift in eligibility, authorization, defaults, or pagination semantics.
