---
status: accepted
---

# Inject three recent-work notes

ADR-0164 gives the first prompt of a Session the two latest non-empty recent-work
notes of other Sessions in its Project. The user asked for three.

Decision:

- The first prompt gets the three latest notes. A note is at most 400 characters, so
  the injection grows by at most one such line.
- Notes are written only for Sessions whose note could still be injected, so a Session
  with three newer notes in its Project is not summarized.

Everything else in ADR-0164 is unchanged.
