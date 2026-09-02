#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: ./install.sh [--apply] [options]

Build and install MemStore for Codex on macOS. Defaults to a zero-write preview
of user configuration, the Memory Vault, and machine Runtime. Re-run with
--apply after reviewing the plan.

Options:
  --apply                         Apply the reviewed setup and start the Worker.
  --preview                       Explicitly request the default preview mode.
  --mode active|shadow            Install active injection (default) or Shadow.
  --vault /path/to/Obsidian/Vault Override automatic Obsidian Vault discovery.
  --runtime /path/to/runtime      Override ~/Library/Application Support/MemStore.
  --codex-executable /path/codex  Override automatic Codex CLI discovery.
  --json                          Print the machine-readable result envelope.
  --help                          Show this help without installing dependencies.

The checkout is part of the installed program. Keep it at a stable path after
setup. Canonical Memory remains in the selected Obsidian Vault and Runtime data
remains separate under the configured Runtime root.

Examples:
  ./install.sh
  ./install.sh --apply
  ./install.sh --mode shadow --vault /path/to/vault --apply
EOF
}

for argument in "$@"; do
  if [ "$argument" = "--help" ] || [ "$argument" = "-h" ]; then
    usage
    exit 0
  fi
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "MemStore friendly setup currently supports macOS only." >&2
  exit 2
fi

for executable in node pnpm swift codesign launchctl; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    echo "Missing prerequisite: $executable. Install it and retry." >&2
    exit 2
  fi
done

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$repository_root"

echo "[1/4] Installing pinned JavaScript dependencies..." >&2
pnpm install --frozen-lockfile 1>&2
echo "[2/4] Building MemStore..." >&2
pnpm build 1>&2
echo "[3/4] Building and signing the macOS notifier..." >&2
pnpm build:notifier 1>&2
echo "[4/4] Running setup (first apply downloads and verifies about 295 MB for E5)..." >&2
exec node dist/cli/main.js setup --repo "$repository_root" "$@"
