---
name: memstore-remember
description: Save an exact Human-authored assertion, store a whole document (Markdown file or Feishu/Lark doc) for recall, or have MemStore distill durable knowledge (nightly dreaming when enabled, otherwise Luna) from the current turn, session, a recorded turn, or a file. Use when the user asks to remember, preserve, learn, or promote a decision, preference, constraint, repair, or other reusable knowledge, or to store a document in MemStore, at Project or Global scope.
---

# MemStore Remember

Route explicit memory intent through the MemStore CLI. Do not edit the Obsidian Vault, SQLite Runtime, Candidate state, or Project marker directly.

## Choose the authority

- Use `remember assert` only when the user supplies the exact durable statement and intends it to be Human-authored. MemStore preserves that text without a Luna meaning rewrite.
- Use `remember extract` when knowledge must be selected, summarized, generalized, or inferred from a turn, session, recorded turn, or file. It becomes Agent-derived knowledge: with dreaming enabled, a dreaming run extracts, verifies against the repositories and writes it within minutes; otherwise it enters the Luna pipeline.
- When the user states the knowledge itself (“记住：…”, “以后都…”), prefer `assert` with their words; use `extract` when the knowledge must come out of material. When intent is otherwise ambiguous, use `extract`.

Default to `--scope project` and `--startup auto`. Use `--scope global` only when the user explicitly requests Global knowledge. Pass `--startup always` or `never` only when explicitly requested or clearly established.

## Store a document

When the user hands over a document to keep (a Markdown file, or a Feishu/Lark doc link) rather than a statement, store it whole with `remember doc`. Its full text becomes the Memory body in the Obsidian Vault; MemStore writes a short index card for matching and injection, and agents read the full text with `memstore recall show M:<id> --detail full`.

```text
memstore remember doc --file <path.md> --scope project --json
memstore remember doc --lark <feishu-doc-url> --scope project --json
memstore remember doc --stdin --source <url-or-path> --title <title> --json
```

- `--lark` fetches the document as Markdown with the user's `lark-cli` login. For other sources, export to Markdown first and pass `--file` (or `--stdin` with `--source`).
- The title defaults to the first heading; pass `--title` when that is not the document's name.
- Importing the same source again updates the same Memory (`updated`, same M:id) or reports `unchanged`. Use this to refresh a document after it changes.
- `needs_sensitivity_review`: show the user `matched_value` and ask whether it is a credential. Only if they confirm it is not, run again with `--confirm-sensitive '<matched_value>'`. `blocked_secret`: the document contains a secret; ask the user to remove it. Never confirm on the user's behalf.
- A document is retrieved by its card, title and headings. Default to `--scope project`; use `--scope global` for documents that apply across projects.

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
- `queued` with `pipeline: "dreaming"`: report the `run_id`; dreaming verifies the material and, when `applies` is true, writes what survives within minutes. Point to `memstore dream status --json` and the run's report under `_MemStore/Dreams/`; do not claim memories were written yet.
- `waiting_verification`, `conflict`, or `quarantined`: explain that Human review is required.
- `blocked_secret`: do not repeat suspected secret content.
- `dead_letter` or `failed`: report the visible failure and operation ID.

Never upgrade Agent-derived knowledge to Human-authored authority, broaden Project to Global, or bypass Candidate, Luna or dreaming processing.
