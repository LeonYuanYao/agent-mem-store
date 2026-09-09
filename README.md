# MemStore

[English](README.md) | [简体中文](README.zh-CN.md)

MemStore is a program/data-separated long-term memory system for coding agents.
The program lives in this repository; Canonical Memory lives in a user-selected
Obsidian Vault; machine execution state lives under an explicit runtime root.

The repository includes a preview-first macOS installer for Codex. It builds the
program and notifier, discovers an Obsidian Vault, prepares the local E5 model,
managed-merges Hooks/MCP/Skills, starts the Worker, and verifies foreground
retrieval. Canonical Memory, machine Runtime data, and the program checkout stay
separate. Use `memstore status` and `memstore doctor --deep` for live inspection.

## Install on macOS

### Prerequisites

- macOS 13 or newer.
- Node.js `>=22.17.0 <23` and pnpm `>=10.25.0 <11`.
- Xcode Command Line Tools with Swift 6 and `codesign`.
- Codex CLI installed, authenticated, and entitled to the configured Luna and
  Terra models.
- Obsidian with the intended Vault opened at least once.
- `~/.codex/config.toml` created by Codex. Active setup also requires explicit
  boolean `generate_memories` and `use_memories` values in its `[memories]`
  section so rollback can restore the exact previous state.

Clone MemStore into a path that will remain stable, then ask it for a preview:

```sh
git clone https://github.com/LeonYuanYao/AMemStore.git ~/Applications/MemStore
cd ~/Applications/MemStore
./install.sh
```

The default command builds repository-local artifacts and prints a zero-write
preview of all user configuration, Vault, and Runtime effects. It automatically
selects the single open Obsidian Vault, or the only registered Vault. If several
Vaults are equally eligible, pass the intended one explicitly:

```sh
./install.sh --vault /path/to/Obsidian/Vault
```

After reviewing the preview, apply it:

```sh
./install.sh --apply
```

The first apply downloads and verifies approximately 295 MB for E5-base q8.
Active mode is the default: it creates a reversible cutover backup, disables
Codex native memory flags, and activates MemStore injection without reading,
moving, importing, or deleting native memory data. To observe capture and
retrieval without injection or native-memory replacement, choose Shadow:

```sh
./install.sh --mode shadow --apply
```

Setup requests macOS notification permission after the Worker is ready. Denying
it does not disable capture, governance, retrieval, or the Obsidian Review Inbox;
the final result reports the notification state explicitly.

Verify the installation from any directory:

```sh
~/.local/bin/memstore doctor --deep
~/.local/bin/memstore status
```

`setup` waits up to 30 seconds for the foreground Worker socket. If setup reports
that files were installed but the Worker is unavailable, run the deep doctor and
retry the same setup command after correcting the reported prerequisite. The
partial installation stays in Shadow and leaves Codex native memory unchanged;
the retry resumes it. Re-running setup after a successful Active installation is
also safe: it verifies and preserves the recorded cutover instead of applying a
second one. A legacy MemStore installation whose current Active MCP and Hook
contracts are still exact is offered as `adopt_legacy_active_installation`:
apply records a fresh ownership and rollback baseline without rewriting current
Codex configuration, Hook content, or knowledge data. Any unknown managed Hook
change or unrelated target drift is rejected. Do not move or delete the Git
checkout after installation: the managed CLI, Hooks, MCP server, Skills, and
LaunchAgent intentionally reference this reviewed program location.

For automation, add `--json`. Build progress goes to stderr and stdout contains
only the final JSON envelope:

```sh
./install.sh --vault /path/to/vault --apply --json
```

## Development

### Hook visibility

Set `hook_display` in the `[adapters]` section of the machine-local
`<runtime>/config.toml` to `"off"`, `"summary"` (default), or `"full"`.
`summary` shows the event, Memory count, ordered references, and injected token
count. `full` adds the exact model-facing injection text, not the full Vault notes.
`off` hides successful injection notices but preserves capture failure warnings.
Empty retrievals stay silent. Both SessionStart and UserPromptSubmit use the same
setting, which is read on each successful retrieval without a Worker restart.
This changes only `systemMessage` presentation; retrieval, model context, and
token budgets are unchanged. Missing or unreadable display configuration falls
back to summary so presentation cannot block memory delivery; normal configuration
validation rejects invalid values. This preference stays outside the portable Vault.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark:retrieval
pnpm evidence:gate4
pnpm evidence:purge
pnpm evidence:gate5
```

The default test suite is self-contained in a clean clone. Historical Gate and
purge evidence contracts are separate because their JSON artifacts intentionally
remain machine-local; after generating those artifacts, run `pnpm test:evidence`.

Preview isolated initialization without writing anything:

```sh
pnpm exec tsx src/cli/main.ts init \
  --vault /path/to/test-vault \
  --runtime /path/to/test-runtime \
  --preview --json
```

Development-only explicit-memory examples:

```sh
pnpm exec tsx src/cli/main.ts remember assert \
  --scope project --text "Use pnpm for this project." \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --preview --json

pnpm exec tsx src/cli/main.ts recall search "package manager" \
  --scope current \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --json
```

### Understand health status

`doctor --deep --json` checks current health; `status --json` includes the same
foreground/index health assessments alongside historical counts.

- `healthy`: current checks pass, including any required recovery evidence.
- `observing`: recovery still needs confirmation, or the index is within a bounded
  synchronization/retry period. This is neither a confirmed outage nor proof that
  all recovery work is finished.
- `degraded`: at least one current warning remains; inspect its recovery condition.
- `error`: an integrity or inspection error needs attention.

Foreground recovery requires ten minutes without a new failure and five completed
logical requests after the last failure. Merely waiting, receiving empty results,
or cancelling requests cannot prove recovery. Sparse usage may therefore leave an
`awaiting_verification` detail until enough actual requests complete. There is no
LLM probe and no need to reset historical counters. Index warnings automatically
clear when the outstanding generation is published; expected waiting is bounded.

### Move one session to another project

A session route applies only to the exact Codex thread ID. Future Hook capture,
automatic recall, and queued/background extraction use that project even when
the working directory stays unchanged. Other threads and forks keep their own
project resolution. Explicit global extraction remains global.

```sh
memstore project route-session --session-id THREAD_ID --project-id TARGET_PROJECT_ID \
  --vault /path/to/vault --runtime /path/to/runtime --preview --json
```

Remove `--preview` to bind future processing. This command does **not** move
existing knowledge. For an existing session, use the maintenance command below:

```sh
memstore project migrate-session --session-id THREAD_ID \
  --from SOURCE_PROJECT_ID --project-id TARGET_PROJECT_ID \
  --vault /path/to/vault --runtime /path/to/runtime --preview --json
```

Before applying, pause and stop the worker, then back up both the runtime database
and Vault. Applying requires `worker_control.worker_paused = 1`. This is an offline
maintenance command, not a concurrent multi-writer migration. It moves current
project memories linked by session candidates and their live candidate records;
rejected/expired candidate history remains historical. Shared-source memories and
target candidate collisions require separate review. Memory IDs, numeric references,
authorship, body, and provenance stay unchanged. Each moved memory gets a new
revision, while capture events, evidence, old revisions, and injection receipts
retain their original history.

The migration also installs the session route. Its replayable plan lives under
`<runtime>/state/session-migrations/`; keep it until migration verification is
complete. An interrupted move can be retried with the same arguments while the
worker remains stopped. Restart and unpause the worker after successful migration;
the old retrieval snapshot is unselected and must rebuild before recall resumes.
Previously injected conversation text cannot be removed retroactively.

Session bindings live under `<runtime>/state/session-projects/` as atomic JSON
files, avoiding an extra SQLite lock on each Hook. They are machine-local runtime
state, not portable knowledge. Explicit CLI recall can pass `--session-id THREAD_ID`;
`memstore_search` accepts `session_id`. Without that identity, explicit tools keep
their normal configured-workspace scope. They do not guess a thread from inherited
process environment variables.

Repository-local operations examples:

```sh
pnpm exec tsx src/cli/main.ts doctor --deep \
  --vault /path/to/test-vault --runtime /path/to/test-runtime --json

pnpm exec tsx src/cli/main.ts review generate \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --preview --json

pnpm exec tsx src/cli/main.ts runtime backup \
  --output /path/to/backup/memstore.sqlite \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --preview --json

pnpm exec tsx src/cli/main.ts portability readiness \
  --vault /path/to/test-vault --runtime /path/to/test-runtime --json

pnpm exec tsx src/cli/main.ts shadow verify \
  --file /path/to/human-reviewed-source-first-verification.json \
  --vault /path/to/test-vault --runtime /path/to/test-runtime \
  --preview --json
```

`shadow verify` validates a source-first review against exact Capture Event and
active Memory identities. Removing `--preview` records the reviewed result in
machine-local Runtime Data; it never creates or changes Durable Memory.

Existing managed installations can preview a narrowly scoped upgrade before
applying it. The current upgrade adds only a missing owned `memstore` CLI and
reports—but does not rewrite—any previously installed target that has drifted:

```sh
pnpm exec tsx src/cli/main.ts integration upgrade \
  --home /path/to/home --repo /path/to/MemStore \
  --vault /path/to/vault --runtime /path/to/runtime \
  --notifier /path/to/MemStore\ Notifier.app \
  --preview --json
```

Destructive archive cleanup always requires a separately verified Vault backup.
Preview is the default review surface:

```sh
pnpm exec tsx src/cli/main.ts purge preview \
  --backup /path/to/verified-vault-backup \
  --vault /path/to/test-vault --runtime /path/to/test-runtime --json

pnpm exec tsx src/cli/main.ts purge run --preview \
  --backup /path/to/verified-vault-backup \
  --vault /path/to/test-vault --runtime /path/to/test-runtime --json
```

`purge run` performs physical deletion and is intentionally not shown as a
copy-paste development example. Outcome 12 evidence executes it only against
operating-system temporary Vaults.

Single-Memory lifecycle controls also preview by default. Archive is reversible
during the configured retention period; restore starts a fresh Active cycle:

```sh
memstore archive M:123 --reason obsolete
memstore archive M:123 --reason obsolete --apply
memstore restore M:123 --apply
```

Permanent single-Memory deletion is CLI-only and accepts Archived Memory only.
It refuses protected content, requires a verified backup, and binds apply to the
exact previewed target and backup:

```sh
memstore purge-memory M:123 --backup /path/to/verified-vault-backup
memstore purge-memory M:123 --backup /path/to/verified-vault-backup \
  --gate <approvalDigest-from-preview> --apply
```

`memstore_archive` and `memstore_restore` provide the same reversible operations
to MCP clients. Omitting `apply` previews the change. Physical purge is not
exposed through MCP.

The built binaries are `memstore` and `memstore-mcp`. The MCP server reads
`MEMSTORE_VAULT_ROOT` and `MEMSTORE_RUNTIME_ROOT`; protocol output is reserved
for stdout and diagnostics go to stderr.

Do not point development tests at a real Memory Vault. Tests create their own
operating-system temporary directories.
