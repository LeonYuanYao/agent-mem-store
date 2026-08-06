---
status: accepted
---

# Use a versioned JSON Project Marker

The `.memstore-project` Project Marker is a small UTF-8 JSON object. Version 1 requires an integer `schema_version` with value `1` and a stable `project_id` consisting of the `msproj_` prefix followed by a lowercase UUID v4. The identifier contains no path, Git remote, username, or machine identity. Copying the same marker to another directory intentionally makes both directories share Project Memory.

An optional string `display_name` improves presentation in Obsidian and status surfaces but never participates in identity equality, collision handling, or memory isolation. Readers ignore unknown fields, and any MemStore operation that rewrites an existing marker preserves those fields so a newer producer's extensions are not silently lost.

For example:

```json
{
  "schema_version": 1,
  "project_id": "msproj_550e8400-e29b-41d4-a716-446655440000",
  "display_name": "AgentScratchpad"
}
```

Invalid JSON, a missing or malformed required field, and an unsupported `schema_version` fail safely. MemStore does not inject Project Memory under the uncertain identity; Project-scoped capture may remain unresolved; independently applicable Global Memory remains available. It does not guess from `display_name` or silently fall back to basename when an explicit but invalid marker is present.

Ordinary capture, injection, Luna processing, indexing, and scheduled governance never create, edit, or delete this file. Only direct user editing or an explicitly confirmed project-link, unlink, or equivalent operation authorizes a write. Exact atomic-write mechanics, permission checks, UUID generation API, and resolver path normalization remain implementation decisions.
