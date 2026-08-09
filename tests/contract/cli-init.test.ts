import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

test("the init CLI exposes the same zero-mutation preview contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-init-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");

  const result = await execFileAsync(
    "pnpm",
    [
      "exec",
      "tsx",
      "src/cli/main.ts",
      "init",
      "--vault",
      vaultRoot,
      "--runtime",
      runtimeRoot,
      "--preview",
      "--json"
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  const output = JSON.parse(result.stdout) as unknown;

  expect(output).toEqual({
    schemaVersion: 1,
    dryRun: true,
    state: "preview",
    vaultRoot,
    runtimeRoot,
    wouldCreate: [
      join(vaultRoot, "_MemStore", "policy.toml"),
      join(runtimeRoot, "config.toml"),
      join(runtimeRoot, "state", "memstore.sqlite")
    ]
  });
  await expect(access(vaultRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
