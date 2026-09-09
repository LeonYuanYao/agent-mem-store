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
- Codex CLI installed, authenticated, and entitled to `gpt-5.6-luna` and
  `gpt-5.6-terra`. The current adapters use Luna with `medium` reasoning and
  Terra with `low` reasoning, both with `service_tier="default"` (not Fast mode).
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

## Everyday use

### Memory capture and retrieval

The Codex integration captures session events for background extraction. Luna
produces Agent-derived candidates; only admitted Durable Memory participates in
normal recall. Human-authored assertions retain their authority, and Project
knowledge does not automatically become Global knowledge.

SessionStart background injection is **off by default**. To opt in, set
`session_start_injection = true` in `[adapters]` in `<runtime>/config.toml`.
Missing or unreadable settings keep it off. The Hook reads the switch on every
SessionStart; capture remains enabled and UserPromptSubmit retrieval is unchanged.
The first non-empty prompt injection includes the memory legend when needed.
Disabling the switch cannot remove memory text already present in a conversation.

When enabled, SessionStart selects project/global background, with a maximum of 12 items and
1,200 tokens. It does not rank against the first user prompt. UserPromptSubmit
performs task-related retrieval, with a target of 600 tokens, a maximum of 1,024
tokens, and at most six items. These are ceilings, not quotas. Retrieved items
can be irrelevant or overlap; the agent must apply the current task and explicit
instructions before using them. `<memstore-candidates>` labels possible retrieval
matches, not unapproved lifecycle Candidates.

Automatic injection and explicit retrieval have different budgets. Use the
managed `memstore-recall` Skill to search and read full memories when the injected
context is insufficient; the automatic limits above are not explicit-search limits.

### Skills and MCP tools

Setup manages three Skills:

- `memstore-recall`: search memories, read by ID, and inspect provenance or related knowledge.
- `memstore-remember`: save an exact Human-authored assertion or queue Luna extraction
  from a turn, session, or file. Project is the default scope; Global requires an
  explicit request. Extraction is asynchronous and still passes admission checks.
- `memstore-repair`: guide a user-initiated investigation of irrelevant-retrieval
  Bad Cases; it does not authorize silent background code repair.

The MCP server exposes `memstore_search`, `memstore_get`, `memstore_provenance`,
`memstore_related`, `memstore_report_irrelevant`, `memstore_archive`, and
`memstore_restore`. Remembering uses the Skill/CLI path; physical deletion is CLI-only.

### Storage, governance, and retention

| Location | Purpose |
| --- | --- |
| `<vault>/Memories/` | Current canonical memory files, including retained archived memories |
| `<vault>/_MemStore/Revisions/` | Historical memory revisions |
| `<vault>/_MemStore/policy.toml` | Portable governance, retention, and capacity policy |
| `<vault>/_MemStore/Review Inbox.md` | Generated review and operational notices |
| `<runtime>/config.toml` | Machine-local paths and adapter settings |
| `<runtime>/state/memstore.sqlite` | Queues, candidates, receipts, and other execution state |

The default Runtime is `~/Library/Application Support/MemStore`. Embedding models
and rebuildable indexes also live under Runtime, outside the Vault. Do not sync
the live SQLite database or its WAL files through Obsidian.

New installations schedule weekly governance for Monday at 19:00 and monthly
governance for the first Monday at 19:00, using the fixed `Asia/Shanghai` timezone.
The schedule does not follow travel-related changes to the machine timezone.

Default retention settings in `policy.toml` are:

- `retention.archive_months = 3`: eligible archived memories are automatically
  physically purged after their retention deadline. Protected memories and explicit
  per-memory deadlines are handled by the lifecycle rules. The Worker prepares and
  verifies its managed backup before scheduled purge; manual purge commands below
  require a separately supplied verified backup.
- `retention.sensitivity_metadata_days = 15`: old sensitivity diagnostics are cleaned up.
- `retention.injection_receipt_days = 30`: eligible old injection receipts are cleaned
  up, with protected evidence retained and daily summaries recorded.
- `retention.candidate_tombstone_days = 180`: candidate tombstone retention; this does
  not set the retention of canonical Memory tombstones.

Deletion frees space for SQLite reuse; it does not necessarily shrink the database
file immediately. Retention maintenance is distinct from database compaction.

Capacity governance limits the active recall Working Set. Project defaults are a
2,500-item target, 3,500 hard limit, and 2,200 low-water target; Global defaults are
300, 500, and 270. Exclusion from the Working Set preserves the memory and is
distinct from archive or physical deletion, so the total retained knowledge count
can exceed the Working Set limit.

### Support and safety boundaries

The managed host integration currently targets Codex on macOS. A Claude Code
adapter is not included. Model calls use Codex authentication and require network
access; local embedding does not make background extraction fully offline.

The Vault stores plaintext knowledge; MemStore provides no application-level
encryption. Do not store passwords, tokens, or credentials as memories. The current
design does not support two MemStore writers sharing one synchronized Vault.
Moving a Vault preserves portable knowledge, not pending jobs, session routes, or
machine execution state; inspect `portability readiness` before migration.

See [SPEC.md](SPEC.md) for detailed contracts and [the ADRs](docs/adr/) for decisions.
Historical Gate evidence is engineering evidence, not a live health or memory-quality
report. Inspect the running installation and review actual retrievals separately.

## Development and operations

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
applying it. The current upgrade can add a missing managed `memstore` CLI or update
an unchanged owned CLI wrapper. It reports other target drift without rewriting
those targets, and refuses a CLI wrapper that differs from its recorded identity:

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
