---
status: accepted
---

# Keep text the user marks private out of MemStore

The user wanted a way to tell MemStore to ignore part of a prompt, as claude-mem's
`<private>` tag does. Only automatic sensitivity detection existed.

Decision:

- `<private>…</private>` and `<pv>…</pv>` (any case) hide a span; an unclosed tag
  hides the rest of the message. A message whose own text starts with `p：` or `p:`
  is private as a whole. `<p>` is not a marker: it is HTML's paragraph tag.
- A hidden span is removed from the captured prompt, from what retrieval matches,
  from the receipt, from what Jev receives and from conversation history.
- A whole private message opens a private turn: its prompt, tool calls and reply are
  not captured, no retrieval runs for it, and Codex does not record its reply as
  history. Hooks run as separate processes, so the open turn is a marker file per
  Session (`state/private-turns/`), cleared by the turn's Stop, the next prompt or a
  Session boundary.
- Dreaming removes marked spans again when it reads captured prompts.

Limits: the agent itself reads the prompt as written, and a reply or tool call in an
ordinary turn may repeat what a span hid; MemStore cannot recognise that.
