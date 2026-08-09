---
name: memstore-recall
description: Search MemStore and progressively deepen durable coding knowledge by stable Memory identity, including full bodies, provenance, and one-hop relationships. Use when prior decisions, preferences, constraints, repairs, architecture, or project knowledge may improve the current task, or when the user asks to find or inspect stored memory.
---

# MemStore Recall

Use MemStore's MCP tools when available; otherwise use the equivalent CLI commands. Both routes share one Recall core. Do not search the Obsidian Vault files or Runtime SQLite directly.

## Search before deep reads

Start with `memstore_search` or:

```text
memstore recall search <query> --scope current --json
```

Default `current` means current Project plus Global. Use `global`, `project:<id>`, or `all-projects` only when the request needs that boundary. Preserve the returned Memory and revision IDs, receipt, cursor, relevance reasons, and warnings.

When multiple entries qualify under token pressure, prefer keeping more identities with compact descriptions. Deepen only the items needed for the task:

```text
memstore recall show <memory-id> --detail standard --json
memstore recall provenance <memory-id> --json
memstore recall related <memory-id> --direction both --json
```

When MCP is available, map the same steps to `memstore_get`,
`memstore_provenance`, and `memstore_related`. Use
`memstore_report_irrelevant` for the receipt-bound irrelevant operation below.

Use `show --detail full` when exact conditions, exceptions, negations, or full implementation detail matter. Page with the returned opaque cursor instead of recreating it. Relationships are exactly one hop; follow returned identities deliberately if another hop is useful.

Explicit foreground retrieval has no hard total token cutoff. Heed token warnings, but continue when the expected accuracy benefit justifies more context.

## Report irrelevant retrieval

When a returned Memory is genuinely irrelevant, record the receipt-bound case without inventing feedback text:

```text
memstore recall report-irrelevant --receipt <receipt-id> --memory <memory-id> --json
```

Only report the exact Memory revision proven by the receipt for this caller. Do not report merely because useful knowledge was absent; refine or broaden search first.

Treat Human-authored knowledge as highest authority. Keep scope, sensitivity, lifecycle, validity, and conflicts visible; do not quote or inject knowledge that MemStore excludes.
