import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { initializeMemStore } from "../../src/operations/initialize.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cli(arguments_: readonly string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "src/cli/main.ts", ...arguments_],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("doctor and Vault validation expose stable read-only JSON envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-operations-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const common = ["--runtime", runtimeRoot, "--vault", vaultRoot, "--json"];

  await expect(cli(["doctor", "--deep", ...common])).resolves.toMatchObject({
    schema_version: 1,
    ok: true,
    command: "doctor",
    result: { state: "healthy", repaired: false }
  });
  await expect(cli(["vault", "validate", ...common])).resolves.toMatchObject({
    schema_version: 1,
    ok: true,
    command: "vault.validate",
    result: { state: "valid", memoryCount: 0 }
  });
}, 15_000);

test("mutation previews do not create Review Inbox or backup files", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-preview-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const backupPath = join(root, "backup", "runtime.sqlite");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const common = ["--runtime", runtimeRoot, "--vault", vaultRoot, "--preview", "--json"];

  await expect(cli(["review", "generate", ...common])).resolves.toMatchObject({
    result: { state: "preview", dry_run: true, would_change: ["review_inbox"] }
  });
  await expect(cli(["runtime", "backup", "--output", backupPath, ...common])).resolves.toMatchObject({
    result: { state: "preview", dry_run: true, destination_path: backupPath }
  });
  await expect(access(join(vaultRoot, "_MemStore", "Review Inbox.md"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  await expect(access(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
}, 15_000);

test("Shadow status is reachable through the public CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-shadow-status-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });

  await expect(cli([
    "shadow",
    "status",
    "--runtime",
    runtimeRoot,
    "--vault",
    vaultRoot,
    "--json"
  ])).resolves.toMatchObject({
    schema_version: 1,
    ok: true,
    command: "shadow.status"
  });
});

test("quality pipeline preview and status are reachable through the public CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-quality-status-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const common = ["--runtime", runtimeRoot, "--vault", vaultRoot, "--json"];

  await expect(cli(["quality", "compact-backfill", "--preview", ...common])).resolves.toMatchObject({
    command: "quality.compact-backfill",
    result: { state: "preview", eligibleCount: 0, enqueuedCount: 0 }
  });
  await expect(cli(["quality", "status", ...common])).resolves.toMatchObject({
    command: "quality.status",
    result: { totalCount: 0, pendingCount: 0 }
  });
  await expect(cli(["quality", "duplicate-status", ...common])).resolves.toMatchObject({
    command: "quality.duplicate-status",
    result: { totalCount: 0, pendingCount: 0 }
  });
}, 15_000);
