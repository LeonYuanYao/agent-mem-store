---
status: accepted
---

# Separate portable policy from machine configuration

MemStore uses two non-overlapping, versioned TOML documents:

```text
<Memory Vault>/_MemStore/policy.toml
~/Library/Application Support/MemStore/config.toml
```

Portable policy contains knowledge lifecycle and retention, Project and Global policy, automatic-injection budgets and reviewed thresholds, governance cadence and stable timezone, review cadence, and configurable Luna-health policy. It migrates with Canonical Memory Data.

Machine configuration contains Vault and Runtime paths, Agent-adapter installation state, local embedding adapter and artifact path, Luna endpoint and credential reference, macOS notification and LaunchAgent state, and local Project-root mappings. Credentials themselves never appear in either TOML; only environment-variable or operating-system credential-store references are allowed.

The schemas do not overlap. Manual or command-driven changes validate the complete candidate before atomic activation. Invalid edits leave the last valid configuration active and emit a bounded diagnostic. Management writes retain one recoverable prior valid version.

Compatible readers preserve and warn on unknown fields. A higher unsupported schema version forces bounded read-only status and prevents write, governance, injection, and destructive work. Full Cutover and other reviewed high-risk actions are explicit operations rather than policy booleans, so file edits cannot trigger them. MemStore does not modify Obsidian `.obsidian/`.
