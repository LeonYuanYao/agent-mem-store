import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { previewArchivePurge, runArchivePurgeBatch } from "../../../src/purge/index.js";
import { readCanonicalMemory, writeCanonicalMemory, type CanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function archivedMemory(
  ordinal: number,
  authority: CanonicalMemory["authority"],
  details: CanonicalMemory["lifecycleDetails"]
): CanonicalMemory {
  const suffix = String(ordinal).padStart(3, "0");
  return {
    ...makeCanonicalMemory({
      memoryId: `msmem_123e4567-e89b-42d3-a456-426614174${suffix}`,
      revisionId: `msrev_123e4567-e89b-42d3-a456-426614175${suffix}`,
      body: `Protected archive ${suffix}`,
      authority,
      lifecycle: "archived"
    }),
    lifecycleDetails: details
  };
}

test("all archived authority follows the three-calendar-month default unless explicitly protected", async () => {
  const root = await mkdtemp(join(tmpdir(), "memstore-purge-policy-"));
  roots.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const backupRoot = join(root, "backup");
  const memories = [
    archivedMemory(101, "human_authored", {
      archivedAt: "2026-01-15T00:00:00.000Z",
      reason: "superseded"
    }),
    archivedMemory(102, "agent_derived", {
      archivedAt: "2026-01-15T00:00:00.000Z",
      reason: "superseded",
      retainForever: true
    }),
    archivedMemory(103, "agent_derived", {
      archivedAt: "2026-01-15T00:00:00.000Z",
      reason: "superseded",
      pinned: true
    }),
    archivedMemory(104, "agent_derived", {
      archivedAt: "2026-01-15T00:00:00.000Z",
      reason: "superseded",
      pinned: true,
      purgeAfter: "2026-02-01T00:00:00.000Z"
    }),
    archivedMemory(105, "agent_derived", {
      archivedAt: "2026-01-15T00:00:00.000Z",
      reason: "superseded"
    })
  ];
  for (const memory of memories) {
    await writeCanonicalMemory({
      vaultRoot,
      runtimeRoot,
      actor: memory.authority === "human_authored" ? "human" : "agent",
      memory
    });
  }
  await cp(vaultRoot, backupRoot, { recursive: true });

  const beforeCalendarDeadline = await previewArchivePurge({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-04-14T23:59:59.000Z"
  });
  const atCalendarDeadline = await previewArchivePurge({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-04-15T00:00:00.000Z"
  });
  const completed = await runArchivePurgeBatch({
    vaultRoot,
    runtimeRoot,
    backupRoot,
    now: "2026-04-15T00:00:00.000Z"
  });

  expect(beforeCalendarDeadline.items.map((item) => item.memoryId)).toEqual([
    memories[3]?.memoryId
  ]);
  expect(atCalendarDeadline.items.map((item) => item.memoryId)).toEqual([
    memories[0]?.memoryId,
    memories[3]?.memoryId,
    memories[4]?.memoryId
  ]);
  expect(atCalendarDeadline.protectedItems).toEqual([
    { memoryId: memories[1]?.memoryId, reason: "retain_forever" },
    { memoryId: memories[2]?.memoryId, reason: "pinned" }
  ]);
  expect(completed.purgedMemoryIds).toEqual([
    memories[0]?.memoryId,
    memories[3]?.memoryId,
    memories[4]?.memoryId
  ]);
  for (const memory of memories.slice(1, 3)) {
    expect((await readCanonicalMemory({ vaultRoot, runtimeRoot, memoryId: memory.memoryId }))?.memory)
      .toMatchObject({ lifecycle: "archived", body: memory.body });
  }
});
