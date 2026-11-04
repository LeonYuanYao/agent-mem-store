---
status: accepted
---

# Doctor checks whether Codex runs the MemStore Hooks

Codex records a Hook's trust and its `enabled` flag in `config.toml` under
`hooks.state`, keyed by position: `<hooks file>:<event>:<group index>:<handler index>`.
Hook content does not enter the key. When another tool reorders `~/.codex/hooks.json`,
a disabled flag stays at its index and now applies to whichever Hook sits there; Codex
also rewrites that key's `trusted_hash` to the new Hook. In 2026-10 another tool
moved a disabled route away, MemStore's PostToolUse took its index, and Codex
stopped running it. For eight days dreaming saw Codex sessions without tool calls,
working directories or file paths. Capture, recall and doctor all looked healthy,
because none of them can see what the host chooses not to call.

Decision:

- `doctor --deep` adds a `codex_hooks` check for managed installations. It reads the
  Hook file and Codex configuration recorded in the ownership manifest, locates
  each owned Hook by its `memstore:gate5-shadow-v1:<event>:` marker, and reads
  `hooks.state` at its current position.
- An owned Hook missing from the file, or disabled at its position, is a warning:
  those events are not captured. An owned Hook with no trust entry is
  informational, because Codex lists it as untrusted until it is reviewed in `/hooks`.
- The check reads files only. It does not start Codex, and it never writes or
  repairs host trust state. Re-enabling or reviewing stays a user action in Codex
  (integration README: never fabricate a host-owned trusted hash).

Limit: Codex's hash formula is host-owned, so a Hook whose command changed after its
last review (`modified`) is not detected. Codex's app-server `hooks/list` reports
`trustStatus` authoritatively. Use it if that case matters.
