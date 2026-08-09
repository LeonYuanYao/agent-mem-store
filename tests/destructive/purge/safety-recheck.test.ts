import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { previewArchivePurge, runArchivePurgeBatch } from "../../../src/purge/index.js";
import { readCanonicalMemory, writeCanonicalMemory, type CanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];
const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174721";
const revisionId = "msrev_123e4567-e89b-42d3-a456-426614174722";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly backupRoot: string;
  readonly memory: CanonicalMemory;
  readonly contentIdentity: string;
  readonly path: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "memstore-purge-recheck-"));
  roots.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const backupRoot = join(root, "backup");
  const memory: CanonicalMemory = {
    ...makeCanonicalMemory({
      memoryId,
      revisionId,
      body: "Do not delete this changed archive.",
      authority: "agent_derived",
      lifecycle: "archived"
    }),
    lifecycleDetails: {
      archivedAt: "2026-01-01T00:00:00.000Z",
      reason: "superseded",
      purgeAfter: "2026-01-02T00:00:00.000Z"
    }
  };
  const created = await writeCanonicalMemory({
    vaultRoot,
    runtimeRoot,
    actor: "agent",
    memory
  });
  await cp(vaultRoot, backupRoot, { recursive: true });
  return {
    vaultRoot,
    runtimeRoot,
    backupRoot,
    memory,
    contentIdentity: created.contentIdentity,
    path: created.path
  };
}

test("a mismatched backup aborts preview without changing the archived body", async () => {
  const setup = await fixture();
  const backupPath = join(
    setup.backupRoot,
    "Memories",
    "Projects",
    setup.memory.scope.kind === "project" ? setup.memory.scope.projectId : "",
    `${memoryId}.md`
  );
  await writeFile(
    backupPath,
    (await readFile(backupPath, "utf8")).replace("Do not delete", "Backup mismatch"),
    "utf8"
  );

  await expect(previewArchivePurge({
    ...setup,
    now: "2026-01-03T00:00:00.000Z"
  })).rejects.toThrow("backup content identity");
  expect((await readCanonicalMemory({
    vaultRoot: setup.vaultRoot,
    runtimeRoot: setup.runtimeRoot,
    memoryId
  }))?.memory).toMatchObject({ lifecycle: "archived", body: setup.memory.body });
});

test("a manual content change after preview aborts execution before deletion", async () => {
  const setup = await fixture();
  await previewArchivePurge({ ...setup, now: "2026-01-03T00:00:00.000Z" });
  await writeFile(
    setup.path,
    (await readFile(setup.path, "utf8")).replace(
      "Do not delete this changed archive.",
      "This archive changed after preview."
    ),
    "utf8"
  );

  await expect(runArchivePurgeBatch({
    ...setup,
    now: "2026-01-03T00:00:01.000Z"
  })).rejects.toThrow("reconciliation");
  expect(await readFile(setup.path, "utf8")).toContain("changed after preview");
});

test("a restored archive is no longer eligible and remains active", async () => {
  const setup = await fixture();
  await previewArchivePurge({ ...setup, now: "2026-01-03T00:00:00.000Z" });
  const restored: CanonicalMemory = {
    ...makeCanonicalMemory({
      memoryId,
      revisionId: "msrev_123e4567-e89b-42d3-a456-426614174723",
      body: "The restored knowledge is still needed.",
      authority: "agent_derived"
    }),
    predecessorRevisionId: revisionId,
    revisedAt: "2026-01-03T00:00:01.000Z"
  };
  await writeCanonicalMemory({
    vaultRoot: setup.vaultRoot,
    runtimeRoot: setup.runtimeRoot,
    actor: "agent",
    memory: restored,
    expectedContentIdentity: setup.contentIdentity
  });

  const result = await runArchivePurgeBatch({
    ...setup,
    now: "2026-01-03T00:00:02.000Z"
  });
  expect(result).toMatchObject({ state: "completed", purgedMemoryIds: [] });
  expect((await readCanonicalMemory({
    vaultRoot: setup.vaultRoot,
    runtimeRoot: setup.runtimeRoot,
    memoryId
  }))?.memory).toMatchObject({ lifecycle: "active", body: restored.body });
});
