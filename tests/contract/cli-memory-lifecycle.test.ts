import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { writeCanonicalMemory } from "../../src/vault/index.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runCli(arguments_: readonly string[]): Promise<Record<string, unknown>> {
  const execution = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    "src/cli/main.ts",
    ...arguments_,
    "--json"
  ], { cwd: process.cwd() });
  return JSON.parse(execution.stdout) as Record<string, unknown>;
}

test("CLI exposes preview-first archive, restore, and approval-bound purge-memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-lifecycle-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const backupRoot = join(root, "backup");
  await writeCanonicalMemory({
    runtimeRoot,
    vaultRoot,
    actor: "agent",
    memory: makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614179201",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614179202",
      body: "Remove this obsolete temporary note.",
      authority: "agent_derived"
    })
  });
  const rootsArguments = ["--runtime", runtimeRoot, "--vault", vaultRoot];

  await expect(runCli(["archive", "M:1", "--reason", "obsolete", ...rootsArguments]))
    .resolves.toMatchObject({
      ok: true,
      command: "memory.archive",
      result: { dryRun: true, state: "preview" }
    });
  await expect(runCli(["archive", "M:1", "--reason", "obsolete", "--apply", ...rootsArguments]))
    .resolves.toMatchObject({ result: { dryRun: false, state: "archived" } });
  await expect(runCli(["restore", "M:1", "--apply", ...rootsArguments]))
    .resolves.toMatchObject({ command: "memory.restore", result: { state: "restored" } });
  await runCli(["archive", "M:1", "--reason", "obsolete", "--apply", ...rootsArguments]);
  await cp(vaultRoot, backupRoot, { recursive: true });

  const purgePreview = await runCli([
    "purge-memory",
    "M:1",
    "--backup",
    backupRoot,
    ...rootsArguments
  ]);
  expect(purgePreview).toMatchObject({
    command: "memory.purge",
    result: {
      dryRun: true,
      state: "preview"
    }
  });
  const approvalDigest = (purgePreview.result as { readonly approvalDigest: string }).approvalDigest;
  expect(approvalDigest).toMatch(/^[0-9a-f]{64}$/u);
  await expect(runCli([
    "purge-memory",
    "M:1",
    "--backup",
    backupRoot,
    "--gate",
    approvalDigest,
    "--apply",
    ...rootsArguments
  ])).resolves.toMatchObject({ result: { dryRun: false, state: "purged" } });
}, 20_000);
