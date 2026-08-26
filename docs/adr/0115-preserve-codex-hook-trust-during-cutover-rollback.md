---
status: accepted
---

# Preserve Codex Hook trust during Cutover rollback

Codex legitimately rewrites `hooks.state.*.trusted_hash` values after managed Hook definitions change. Cutover rollback therefore ignores and preserves only those host-owned hash values while comparing the rest of `config.toml` with the reviewed target, restoring the reviewed native-memory flags, and restoring the exact pre-Cutover Hook document. Changes to `enabled`, the set of Hook-state entries, or any other configuration still abort automatic rollback instead of being overwritten.
