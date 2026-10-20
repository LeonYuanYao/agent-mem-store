---
status: accepted
---

# Route explicit extraction to dreaming while dreaming is enabled

`memstore remember extract` queued a Luna `distill_batch`. With dreaming enabled
Luna distillation no longer runs (ADR-0147), so such requests stayed `queued`
forever: on 2026-10-20 two were waiting, one since 2026-10-14. Selection also
required capture events still `pending`, but dreaming takes events over half a
minute after capture. A file selection was captured as a prompt event whose
body dreaming never read.

Decision: while `[dreaming].enabled` is true, `remember extract` selects the
requested capture events (pending or taken over) and starts a requested dream
run over exactly those events instead of a Luna operation. The Worker runs it on
its next idle iteration: extraction, merge, verification, defense and tiering as
at night. The user asked to keep this material, so an item that survives
verification (not episodic, contradicted, stale, documented or branch-only) is
injected with reason `user_requested`. With `[dreaming].mode = "apply"` the run
writes its inject tier; a `--scope global` request writes globally. The result is
`queued` with `pipeline: "dreaming"` and the run ID. Requested runs use a
pseudo-Session of their own, so nightly claims of the real Sessions are
unchanged; a statement seen again at night counts an observation. File
selections render as FILE material, not as the user's words.

Rejected: running the extraction synchronously in the CLI (verification takes
minutes); keeping Luna for explicit requests only (two pipelines for one store).
