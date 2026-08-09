import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { previewArchivePurge, runArchivePurgeBatch } from "../../../src/purge/index.js";
import { writeCanonicalMemory, type CanonicalMemory } from "../../../src/vault/index.js";
import { makeCanonicalMemory } from "../../helpers/canonical-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function dueMemory(ordinal: number): CanonicalMemory {
  const suffix = String(ordinal).padStart(3, "0");
  return {
    ...makeCanonicalMemory({
      memoryId: `msmem_123e4567-e89b-42d3-a456-426614176${suffix}`,
      revisionId: `msrev_123e4567-e89b-42d3-a456-426614177${suffix}`,
      body: `Due archive ${suffix}`,
      authority: "agent_derived",
      lifecycle: "archived"
    }),
    lifecycleDetails: {
      archivedAt: "2026-01-01T00:00:00.000Z",
      reason: "superseded",
      purgeAfter: "2026-01-02T00:00:00.000Z"
    }
  };
}

async function fixture(count: number): Promise<{
  readonly vaultRoot: string;
  readonly runtimeRoot: string;
  readonly backupRoot: string;
  readonly memories: readonly CanonicalMemory[];
}> {
  const root = await mkdtemp(join(tmpdir(), "memstore-purge-batch-"));
  roots.push(root);
  const vaultRoot = join(root, "vault");
  const runtimeRoot = join(root, "runtime");
  const backupRoot = join(root, "backup");
  const memories = Array.from({ length: count }, (_, index) => dueMemory(101 + index));
  for (const memory of memories) {
    await writeCanonicalMemory({ vaultRoot, runtimeRoot, actor: "agent", memory });
  }
  await cp(vaultRoot, backupRoot, { recursive: true });
  return { vaultRoot, runtimeRoot, backupRoot, memories };
}

test("a bounded batch enforces the 30-second floor before processing remaining bodies", async () => {
  const setup = await fixture(2);
  const limits = { bodies: 1 };

  const first = await runArchivePurgeBatch({
    ...setup,
    limits,
    now: "2026-01-03T00:00:00.000Z"
  });
  const tooEarly = await runArchivePurgeBatch({
    ...setup,
    limits,
    now: "2026-01-03T00:00:10.000Z"
  });
  const next = await runArchivePurgeBatch({
    ...setup,
    limits,
    now: "2026-01-03T00:00:31.000Z"
  });

  expect(first).toMatchObject({
    state: "completed",
    purgedMemoryIds: [setup.memories[0]?.memoryId],
    hasMore: true,
    nextEligibleAt: "2026-01-03T00:00:30Z"
  });
  expect(tooEarly).toMatchObject({
    state: "yielded",
    purgedMemoryIds: [],
    hasMore: true,
    nextEligibleAt: "2026-01-03T00:00:30Z"
  });
  expect(next).toMatchObject({
    state: "completed",
    purgedMemoryIds: [setup.memories[1]?.memoryId],
    hasMore: false
  });
});

test("foreground pressure yields the prepared batch for at least five minutes then resumes it", async () => {
  const setup = await fixture(1);
  const pressured = await runArchivePurgeBatch({
    ...setup,
    now: "2026-01-03T00:00:00.000Z",
    foregroundPressure: () => Promise.resolve(true)
  });
  const tooEarly = await runArchivePurgeBatch({
    ...setup,
    now: "2026-01-03T00:04:59.000Z",
    foregroundPressure: () => Promise.resolve(false)
  });
  const resumed = await runArchivePurgeBatch({
    ...setup,
    now: "2026-01-03T00:05:00.000Z",
    foregroundPressure: () => Promise.resolve(false)
  });

  expect(pressured).toMatchObject({
    state: "yielded",
    purgedMemoryIds: [],
    nextEligibleAt: "2026-01-03T00:05:00Z"
  });
  expect(tooEarly).toMatchObject({ state: "yielded", purgedMemoryIds: [] });
  expect(resumed).toMatchObject({
    state: "completed",
    purgedMemoryIds: [setup.memories[0]?.memoryId],
    hasMore: false
  });
});

test("portable settings may lower but cannot silently exceed destructive safety maxima", async () => {
  const setup = await fixture(1);
  const base = { ...setup, now: "2026-01-03T00:00:00.000Z" };

  await expect(previewArchivePurge({ ...base, limits: { bodies: 201 } }))
    .rejects.toThrow();
  await expect(previewArchivePurge({ ...base, limits: { bytes: 128 * 1024 * 1024 + 1 } }))
    .rejects.toThrow();
  await expect(previewArchivePurge({ ...base, limits: { destructiveMilliseconds: 60_001 } }))
    .rejects.toThrow();
  await expect(previewArchivePurge({
    ...base,
    limits: { bodies: 1, bytes: 1024 * 1024, destructiveMilliseconds: 1000 }
  })).resolves.toMatchObject({ eligibleCount: 1 });
});
