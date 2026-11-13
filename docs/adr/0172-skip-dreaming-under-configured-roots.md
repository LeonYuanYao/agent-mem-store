---
status: accepted
---

# Skip dreaming for Projects under configured roots

ADR-0171 gave an editor's per-instance workspaces under its application support
directory their own Project so dreaming could keep Project knowledge from them. On
that machine those workspaces turned out to hold evaluation runs: an agent builds one
test case per Session. Of 27 items dreaming
kept from two such Sessions in two nights, the 11 it wrote as Memory were the
preferences of single test cases (one effect's icon colours, another effect's
lyric placement), stated by the user while reviewing a case and true for that case
only. Every later evaluation Session in those workspaces could be served them, and the
recent-work note of one case went to the first prompt of the next.

Temporary directories (`/tmp`, `/var/folders`) are already never dreamed, but these
workspaces live in a stable, user-owned path, and an application name does not
belong in code.

Decision:

- `[dreaming].skip_roots` (machine-local list of directories, `~` expands, default
  empty) names directories whose Sessions dreaming learns nothing from. A configured
  path is resolved through symlinks before comparison with canonical Project roots.
- A Project whose every root lies at or under a skip root gets no scheduled run, and
  its Sessions get no recent-work note. Recent-work notes it already has are not
  injected. A Project with any root elsewhere is unaffected.
- Capture, retrieval, `memstore remember extract` and `memstore dream run` are
  unchanged: the user can still ask to remember something from such a Session.
- Existing Memory is not touched; archive it with `memstore archive` or roll back the
  runs with `memstore dream rollback`.

Consequences:

- The setting only stops new learning. Project Memory written before stays injected
  until archived.
- A skipped Project still receives global Memory and any Project Memory it has, so
  evaluation Sessions that must run without MemStore still need an isolated agent
  home (ADR-0170).
