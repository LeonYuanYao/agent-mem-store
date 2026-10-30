---
status: accepted
---

# Recent work: a short-lived note for the next Session

Dreaming keeps only knowledge that stays true and runs nightly, so a new Session
could not tell where the last one stopped, and today's work was unknown until the
next day. A bare "继续" skips retrieval (ADR-0154). claude-mem writes a progress
summary every turn and shows the latest at Session start, at one model call per
tool call.

Decision:

- When a Session has been idle `recent_work_idle_minutes` (20), the worker, between
  dreaming steps, writes a note of where its work stands with one low-effort call
  of the dreaming model (`model`, Luna): goal, done and in progress, blockers,
  next step, at most 200 characters, from the last 20,000 characters of the
  Session (private text excluded, ADR-0161). A Session with nothing to carry over
  (a question, a scheduled task) gets an empty note. New activity refreshes the
  note at most hourly, from the previous note; a failed call waits 30 minutes
  (connection) or 6 hours. Only the latest notes of a Project are injected, so a
  Session with two newer notes in its Project is not summarized (no backlog of old
  Sessions when the feature starts).
- Notes live in `recent_work_notes` (migration 77), not in the Vault, and are
  deleted after `recent_work_days` (7). A note that fails the sensitivity check is
  dropped.
- The first prompt of a Session gets the two latest non-empty notes of other
  Sessions of its Project, after retrieved Memory, in `<memstore-recent-work>`,
  marked unverified and expiring. Claude Code's SessionStart hook is asynchronous,
  so the first prompt, whose hook already injects, carries it; this also covers a
  first "继续". The hook display adds one line.
- `[dreaming] recent_work = false` turns it off.

Cost: about 35 Sessions a day at roughly 20,000 tokens a call, about 1 million Luna
tokens (2.5 Codex credits) a day.

Rejected: a note per turn (claude-mem's cost problem); writing notes as canonical
Memory (progress is not lasting knowledge and would need verification and
retirement); a synchronous SessionStart hook (slower start, settings change).
