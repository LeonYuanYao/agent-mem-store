---
status: accepted
---

# Keep model-call sessions in a dedicated Codex home

MemStore's `codex exec` calls (dreaming, the Luna adapter, the Terra retrieval judge, and the
relevance labeling of the recall audit) ran with `--ephemeral`, so Codex wrote no session file for
them. Those files are the only record of a call's token usage that usage reporters read, so the
calls were never counted. Ephemeral was chosen because the calls ran in the user's own Codex home
(`codex_home` and `MEMSTORE_LUNA_CODEX_HOME` default to `~/.codex`), where session files would fill
the user's session list and reach every tool that reads it. With `--ignore-user-config` the Codex
home of these calls supplies only the login and Codex's own state; it does not configure them.

Decision: a call stays ephemeral only when its Codex home is the user's own `~/.codex` (compared by
real path). Any other home keeps the session files. A user who wants the calls counted points
`[dreaming] codex_home` and `MEMSTORE_LUNA_CODEX_HOME` (or `MEMSTORE_TERRA_CODEX_HOME`) at a home
kept for such calls, holding only a link to the login, for example `~/.codex-eval`. Installs that
keep the default `~/.codex` behave as before. The labeling script uses `~/.codex-eval` (or
`MEMSTORE_LABEL_CODEX_HOME`) when it holds a login, and otherwise keeps its temporary, ephemeral
home. The gate-5 candidate's Luna block still records `ephemeral: true`: it describes the default
`~/.codex` home and is frozen evidence, so it is unchanged.

Consequences: the dedicated home grows by one session file per call, and Codex's state databases in
it grow with them; it needs periodic cleanup of session files the usage reporter has already read.
The calls stay out of the user's session list, and out of MemStore's own capture, whose hooks
`--ignore-user-config` does not load. Isolation is unchanged: every call still passes
`--ignore-user-config`, `--ignore-rules`, its own `HOME` and working directory, and disables memories,
plugins and apps; Luna and the judge also disable the skills they find in the Codex home.
