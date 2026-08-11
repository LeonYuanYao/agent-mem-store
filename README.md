# MemStore

MemStore is a program/data-separated long-term memory system for coding agents.
The program lives in this repository; Canonical Memory lives in a user-selected
Obsidian Vault; machine execution state lives under an explicit runtime root.

Current milestone: Gate 5 Shadow hardening after the approved Engineering MVP
and managed installation reviews. Repository code supports an installed Shadow,
but this document does not assert the state of any particular machine; use
`memstore status`, `memstore doctor --deep`, and `memstore shadow status` for
live read-only inspection.
Its synthetic Shadow loop covers capture, Luna boundaries, Candidate lifecycle,
Canonical data, retrieval, explicit CLI/MCP surfaces, complete Weekly/Monthly
governance, Review UX, failure recovery, and Vault-only portability. Gate 4
evidence includes latency and embedding benchmarks plus an exact machine-effect
preview. The managed integration can register the CLI, stdio MCP server, Skills,
Hooks, notifier, and Worker while keeping E5-base q8 in non-injecting Shadow.
The purge executor now provides verified-backup gating, zero-write preview,
calendar-month retention, authority and pin protection, bounded checkpointed
deletion, foreground-pressure yielding, crash recovery, six-month body-free
Tombstones, and Vault/SQLite/index agreement. Outcome 13 adds the reviewed
`$memstore-repair` loop, owned reversible Hook/MCP/Skill/Notifier/LaunchAgent
merges, exact cutover/rollback rehearsal, and the frozen `gate5-shadow-v1`
candidate. Automatic injection and native-memory replacement remain separately
reviewed operations; source changes do not authorize a live upgrade or restart.

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

The built binaries are `memstore` and `memstore-mcp`. The MCP server reads
`MEMSTORE_VAULT_ROOT` and `MEMSTORE_RUNTIME_ROOT`; protocol output is reserved
for stdout and diagnostics go to stderr.

Do not point development tests at a real Memory Vault. Tests create their own
operating-system temporary directories.
