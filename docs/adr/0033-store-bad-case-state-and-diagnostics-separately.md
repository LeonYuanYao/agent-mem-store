---
status: accepted
---

# Store Bad Case state and diagnostics separately

Bad Cases are machine-local operational diagnostics rather than Canonical Memory Data. They remain under `~/Library/Application Support/MemStore` and do not enter the Obsidian-managed Memory Vault.

The main `state/memstore.sqlite` database owns Bad Case lifecycle and indexing: identity, kind, Project, severity, `open`/`repairing`/`resolved`/`dismissed` state, timestamps, reminder state, linked object identities, diagnostic-bundle path, and checksum. A separate readable `badcases/bc_<id>.json` bundle owns the bounded diagnostic payload required by a later repair Agent.

The JSON bundle may include Agent, Session, Turn, and Project identities; relevant Injection Receipt, Candidate, Memory, and revision identities; selected and omitted item identities and score components; filter and threshold decisions; relevant index, ranking, Prompt, Luna, configuration, and code versions; an explicit observed label such as `irrelevant`; aggregate anomaly measurements; representative Candidate identities; bounded sanitized excerpts where safe; and whether referenced source data remains available.

The bundle does not contain a complete Session, full tool inputs or outputs, unscreened user prompts, Secret Content, a full Memory Vault body, or a model-invented expected answer. Secret screening and restrictive runtime-file permissions apply before durable diagnostic payload is written. SQLite paths and checksums bind lifecycle to payload without making either a second knowledge authority.

`repair-bundles/repair_<id>/` is generated only when the user explicitly starts the MemStore repair Skill. It can contain `diagnosis.md`, `proposed-changes.md`, `reproduction.json`, and `verification-plan.md` for a foreground Codex + GPT-5.6 repair workflow. Detection, aggregation, and reporting may run automatically; changes to Prompt, thresholds, ranking, code, configuration, or knowledge data require the existing human Review and verification gates and are never silently applied in the background.

Retention and repeated-occurrence aggregation for Bad Cases and Repair Bundles remain a separate reviewed decision.
