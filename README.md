# MemStore

MemStore is a program/data-separated long-term memory system for coding agents.
The program lives in this repository; Canonical Memory lives in a user-selected
Obsidian Vault; machine execution state lives under an explicit runtime root.

Current milestone: Outcome 13 Full-Cutover-prerequisite review candidate after
the approved Gate 4 Engineering MVP. Everything remains repository-local and
uninstalled.
Its synthetic Shadow loop covers capture, Luna boundaries, Candidate lifecycle,
Canonical data, retrieval, explicit CLI/MCP surfaces, complete Weekly/Monthly
governance, Review UX, failure recovery, and Vault-only portability. Gate 4
evidence includes latency and embedding benchmarks plus an exact machine-effect
preview. The CLI, stdio MCP server, and repository-local Skills remain
unregistered. E5-base q8 is frozen only as an inactive Shadow candidate.
The purge executor now provides verified-backup gating, zero-write preview,
calendar-month retention, authority and pin protection, bounded checkpointed
deletion, foreground-pressure yielding, crash recovery, permanent body-free
Tombstones, and Vault/SQLite/index agreement. Outcome 13 adds the reviewed
`$memstore-repair` loop, owned reversible Hook/MCP/Skill/Notifier/LaunchAgent
merges, exact cutover/rollback rehearsal, and the frozen `gate5-shadow-v1`
candidate. Nothing is installed; automatic injection, real scheduling, real
notification delivery, and native-memory replacement remain disabled pending
explicit human approval.

## Development

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

The built binaries are `memstore` and `memstore-mcp`. The MCP server reads
`MEMSTORE_VAULT_ROOT` and `MEMSTORE_RUNTIME_ROOT`; protocol output is reserved
for stdout and diagnostics go to stderr.

Do not point development tests at a real Memory Vault. Tests create their own
operating-system temporary directories.
