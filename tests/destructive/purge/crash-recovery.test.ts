import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { runArchivePurgeBatch } from "../../../src/purge/index.js";
import {
  readCanonicalMemory,
  readCanonicalRevision,
  writeCanonicalMemory
} from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a purge resumes from its durable checkpoint after a crash following Tombstone write", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-purge-crash-"));
  roots.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const backupRoot = join(root, "backup");
  const memoryId = "msmem_123e4567-e89b-42d3-a456-426614174711";
  const revisionId = "msrev_123e4567-e89b-42d3-a456-426614174712";
  const memory = {
    ...makeCanonicalMemory({
      memoryId,
      revisionId,
      body: "This body must disappear after recovery.",
      authority: "agent_derived",
      lifecycle: "archived"
    }),
    lifecycleDetails: {
      archivedAt: "2026-01-01T00:00:00.000Z",
      reason: "superseded",
      purgeAfter: "2026-01-02T00:00:00.000Z"
    }
  } as const;
  await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "agent", memory });
  await cp(vaultRoot, backupRoot, { recursive: true });

  let crashed = false;
  await expect(runArchivePurgeBatch({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-01-03T00:00:00.000Z",
    onCheckpoint: (checkpoint) => {
      if (!crashed && checkpoint === "tombstone_written") {
        crashed = true;
        throw new Error("simulated process crash");
      }
      return Promise.resolve();
    }
  })).rejects.toThrow("simulated process crash");
  expect((await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId }))?.memory.lifecycle)
    .toBe("tombstone");
  expect(await readCanonicalRevision({ vaultRoot, runtimeRoot, memoryId, revisionId }))
    .toBeDefined();

  const recovered = await runArchivePurgeBatch({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-01-03T00:01:00.000Z"
  });
  const finalMemory = await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId });

  expect(recovered).toMatchObject({
    state: "completed",
    purgedMemoryIds: [memoryId],
    hasMore: false
  });
  expect(finalMemory?.memory).toMatchObject({ lifecycle: "tombstone", body: "" });
  expect(await readCanonicalRevision({ vaultRoot, runtimeRoot, memoryId, revisionId }))
    .toBeUndefined();
});
