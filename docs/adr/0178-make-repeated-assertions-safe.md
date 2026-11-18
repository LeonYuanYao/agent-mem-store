---
status: accepted
---

# Make a repeated assertion safe to retry

On 2026-11-18 an agent ran `remember assert ... --json 2>&1` and parsed the output
as JSON. Node 22 printed its `node:sqlite` experimental warning to stderr first, so
the parse failed although the Memory had been created. The agent saved the same
text again and got a second Human-authored Memory with an identical body, then
archived the first one by hand. Nothing in `assert` noticed the repeat.

Decision:

- `remember assert` returns `unchanged` with the existing Memory's identity, path
  and a `recall show` next command when an active Human-authored Memory in the same
  resolved scope has the same body (ignoring surrounding whitespace) and the same
  startup policy. It creates no operation, Global authorization or file. Preview
  reports the match as `existing_memory_id` with an empty `would_create`.
- A different startup policy still creates a new Memory, as before, so re-asserting
  to change it is not silently ignored. Near-identical wording is not matched: that
  remains a Human decision (archive, or an explicit successor).
- The `memstore` CLI entry drops Node's SQLite experimental warning before loading
  any module that imports `node:sqlite`; other warnings still print. Hook and MCP
  entries import it statically, so the filter would come too late there; their
  stderr is not parsed as a result.
