---
status: accepted
---

# A daily digest of what dreaming changed

Dreaming writes and revises Memory every night without anyone seeing it unless they
open the Vault reports. claude-mem lets the user approve learned rules; MemStore had
rollback but no prompt to use it.

Decision:

- `memstore dream digest [--since ISO]` (default: the last 24 hours) renders a
  chat-sized Markdown message from the runtime tables and the Vault, without a
  model call: counts of written, revised, already-known and review-due items, up to
  20 written, revised and review-due Memories with their M:id and compact (80
  characters, project shown when there are several), and the commands that undo one
  (`memstore archive M:<id> --apply`) or a run (`memstore dream rollback RUN_ID
  --apply`). A day without changes is one line.
- A botmux task (`0 9 * * *`, Claude bot, model haiku, a new topic per run in the
  user's private chat) runs the command and sends its output unchanged; on a day
  without changes it sends nothing.
