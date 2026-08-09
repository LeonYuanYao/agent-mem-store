---
name: memstore-remember
description: Save an exact Human-authored assertion or ask Luna to distill durable knowledge from the current Codex turn, session, a recorded turn, or a file. Use when the user asks to remember, preserve, learn, or promote a decision, preference, constraint, repair, or other reusable knowledge at Project or Global scope.
---

# MemStore Remember

Route explicit memory intent through the MemStore CLI. Do not edit the Obsidian Vault, SQLite Runtime, Candidate state, or Project marker directly.

## Choose the authority

- Use `remember assert` only when the user supplies the exact durable statement and intends it to be Human-authored. MemStore preserves that text without a Luna meaning rewrite.
- Use `remember extract` when knowledge must be selected, summarized, generalized, or inferred from a turn, session, recorded turn, or file. This enters the durable Luna pipeline as Agent-derived Candidate knowledge.
- When intent is ambiguous, use `extract`.

Default to `--scope project` and `--startup auto`. Use `--scope global` only when the user explicitly requests Global knowledge. Pass `--startup always` or `never` only when explicitly requested or clearly established.

## Run the command

Prefer `--stdin` or `--file` for long or shell-sensitive assertion text.

```text
memstore remember assert --scope project --stdin --json
memstore remember extract --scope project --from current-turn --json
memstore remember extract --scope global --from file:<path> --json
```

Supported extraction selectors are `current-turn`, `current-session`, `turn:<id>`, and `file:<path>`. Codex does not provide a stable `selection:<id>` in this version; report that limitation instead of inventing an identity or silently changing the source.

Map “本轮”“刚才这一轮” or an equivalent exact-turn request to `current-turn`. Map “当前讨论”“这次对话”“整个 session” or any request whose evidence spans earlier turns to `current-session`. Prefer the smallest source that still contains all required evidence.

Use `--preview` when the user asks to inspect effects first. Preview is a strict zero-mutation dry run, cannot be combined with `--wait`, and returns no durable operation ID. A wait timeout never cancels queued background work.

Extraction is asynchronous by default: omit `--wait`, report the queued operation ID, and let background processing continue. Add `--wait` only when the user explicitly wants this call to observe completion before returning; do not add it merely because the scope is Global.

## Interpret the result

- `created` or `completed`: report the Memory and operation identities.
- `queued` or `retrying`: report the operation ID and the next inspection command; do not claim extraction completed.
- `waiting_verification`, `conflict`, or `quarantined`: explain that Human review is required.
- `blocked_secret`: do not repeat suspected secret content.
- `dead_letter` or `failed`: report the visible failure and operation ID.

Never upgrade Agent-derived knowledge to Human-authored authority, broaden Project to Global, or bypass Candidate and Luna processing.
