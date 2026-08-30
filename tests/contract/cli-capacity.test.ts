import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { activateConfigurationDocument } from "../../src/configuration/index.js";
import { initializeMemStore } from "../../src/operations/initialize.js";
import { openRuntimeDatabase } from "../../src/runtime/database.js";
import { writeCanonicalMemory } from "../../src/vault/index.js";
import { makeCanonicalMemory } from "../helpers/canonical-memory.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("capacity rebalance preview is dry and apply creates only reversible exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-cli-capacity-"));
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const vaultRoot = join(root, "vault");
  const projectId = "msproj_123e4567-e89b-42d3-a456-426614174103";
  await initializeMemStore({ runtimeRoot, vaultRoot, preview: false });
  const policyPath = join(vaultRoot, "_MemStore", "policy.toml");
  const source = (await readFile(policyPath, "utf8"))
    .replace("target = 2500", "target = 3")
    .replace("hard_limit = 3500", "hard_limit = 5")
    .replace("low_water = 2200", "low_water = 2");
  await activateConfigurationDocument({
    runtimeRoot,
    vaultRoot,
    document: "policy",
    source,
    preview: false
  });
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const suffix = String(ordinal + 120).padStart(12, "0");
    await writeCanonicalMemory({
      runtimeRoot,
      vaultRoot,
      actor: "agent",
      memory: {
        ...makeCanonicalMemory({
          memoryId: `msmem_623e4567-e89b-42d3-a456-${suffix}`,
          revisionId: `msrev_723e4567-e89b-42d3-a456-${suffix}`,
          authority: "agent_derived",
          scope: { kind: "project", projectId },
          body: `CLI capacity rule ${String(ordinal)}.`
        }),
        createdAt: "2026-08-01T00:00:00.000Z",
        revisedAt: "2026-08-01T00:00:00.000Z"
      }
    });
  }
  const common = [
    "--vault", vaultRoot,
    "--runtime", runtimeRoot,
    "--project-id", projectId,
    "--json"
  ];
  const preview = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "src/cli/main.ts", "capacity", "rebalance", "--preview", ...common],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  expect(JSON.parse(preview.stdout)).toMatchObject({
    ok: true,
    command: "capacity.rebalance",
    result: { durableActiveAgentCount: 4, rankedActiveAgentCount: 2, excludedCount: 2 }
  });
  let database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_ranking_exclusions").get()?.count)
      .toBe(0);
  } finally {
    database.close();
  }
  const applied = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "src/cli/main.ts", "capacity", "rebalance", "--apply", ...common],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  expect(JSON.parse(applied.stdout)).toMatchObject({
    ok: true,
    result: { changed: true, excludedCount: 2 }
  });
  database = await openRuntimeDatabase(runtimeRoot);
  try {
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_ranking_exclusions").get()?.count)
      .toBe(2);
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_catalog WHERE lifecycle = 'active'").get()?.count)
      .toBe(4);
  } finally {
    database.close();
  }
}, 15_000);
