import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { writeCanonicalMemory } from "../../src/vault/index.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("purge preview has a stable JSON envelope and purge run --preview remains dry", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-purge-"));
  roots.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const backupRoot = join(root, "backup");
  const memory = {
    ...makeCanonicalMemory({
      memoryId: "msmem_123e4567-e89b-42d3-a456-426614174731",
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174732",
      body: "CLI purge preview fixture.",
      authority: "agent_derived",
      lifecycle: "archived"
    }),
    lifecycleDetails: {
      archivedAt: "2020-01-01T00:00:00.000Z",
      reason: "superseded",
      purgeAfter: "2020-01-02T00:00:00.000Z"
    }
  } as const;
  await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "agent", memory });
  await cp(vaultRoot, backupRoot, { recursive: true });
  const common = [
    "--vault", vaultRoot,
    "--runtime", runtimeRoot,
    "--backup", backupRoot,
    "--json"
  ];

  const preview = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "src/cli/main.ts", "purge", "preview", ...common],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  const runPreview = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "src/cli/main.ts", "purge", "run", "--preview", ...common],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  expect(JSON.parse(preview.stdout)).toMatchObject({
    schema_version: 1,
    ok: true,
    command: "purge.preview",
    result: {
      dryRun: true,
      state: "preview",
      eligibleCount: 1,
      items: [{ memoryId: memory.memoryId }]
    }
  });
  expect(JSON.parse(runPreview.stdout)).toMatchObject({
    ok: true,
    command: "purge.preview",
    result: { dryRun: true, eligibleCount: 1 }
  });
}, 15_000);
